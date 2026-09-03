import { amountFloorViolation } from "./_amount-floor.mjs";
import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { formatUnits } from "viem";
import crypto from "node:crypto";
import { json, parseBody, ubDepositMaxPerTxUsdc, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { publicClient } from "./_predict.mjs";
import { makeRefuser, REFUSAL } from "./_budget.mjs";

// POST /api/agent-ub-deposit { amountUsdc }  (auth)  →  202 { depositId }
//
// The SYNC FRONT DOOR for funding your unified balance. It does only FAST work — auth,
// cap, resolve your wallet, check the balance — then hands the slow on-chain half to
// agent-ub-deposit-background and returns 202 immediately. Poll /api/agent-ub-deposit-status.
//
// WHY THE SPLIT. The deposit runs two sequential txs (approve → deposit), each confirming
// in 2–3s, plus the one-time addDelegate grant on a first deposit. Even with waitForTx
// tightened (measured 8938ms → 6442ms on prod) it used ~64% of Netlify's 10s sync ceiling
// with an irreducible ~6s floor — one slow Circle call from a 502 that writes no result.
// Background functions get 15 minutes, so the chain has room to be the chain.
//
// WHAT STAYS SYNC (and must): every REJECTION. Auth, the per-deposit cap, and insufficient
// funds all answer immediately with a real status code — a user who typed too large a number
// should not have to poll to find that out. Nothing signs on any of those paths.
//
// PER-USER: the depositor is the VERIFIED SESSION's own agent SCA (ensureOwnerWallet) —
// never env, never the request body. You can only deposit into the wallet your session owns.
//
// ⚠️ THE PER-TX MAX IS ENFORCED HERE, BEFORE the background worker is even invoked, and
// _ubdeposit.mjs itself enforces nothing — so every path to it must carry the bound.
// Reject-not-clamp: an over-max request 400s and NOTHING is kicked off.
// It is a FOOTGUN GUARD, not an agent guardrail — see ubDepositMaxPerTxUsdc in _arc.mjs and
// the pause note below.
//
// NOTE: a deposit is NOT ledgered against the day-ceiling — it moves your own USDC into your
// own Gateway balance (self-custody), not a spend. The SPEND side draws the ceiling down.
//
// ── WHY THIS DOES NOT CALL assertNotPaused — DELIBERATE, NOT AN OMISSION ─────────────
// This is the USER moving their own float into their own Gateway balance. It is NOT an agent
// action, and the pause/halt switches must not touch it. The twin of agent-withdraw: that is
// the user RECLAIMING their float, this is the user COMMITTING it. Both are the user's own
// money moving between the user's own pockets, and neither is the agent deciding anything.
//
// Pause and halt bind what the AGENT MAY SPEND. They must never bind what the USER MAY
// COMMIT OR RECLAIM. A paused agent must not be able to trap the user's money (agent-withdraw's
// argument) — and, symmetrically, it must not be able to freeze the user out of funding the
// float they chose to give it. Pausing the agent stops the agent; it does not lock the door,
// in either direction.
//
// NO AGENT PATH CAN REACH THIS ENDPOINT. `ub_deposit` is not in the executor's action
// vocabulary at all — _actions.mjs knows exactly four step types (transfer_usdc,
// pay_for_service, swap_tokens, bridge_usdc) and throws `unknown step type` on anything else.
// The proposal loop cannot propose it, the plan executor cannot execute it, agent-act cannot
// decide it, the researcher never touches it. A model could not emit it if it tried. Verified
// by grep across _actions / _proposal / agent-act / agent-execute-plan / _research / _analystb:
// zero references.
//
// THE SOLE CALLER is UnifiedBalancePanel.tsx, on a user clicking "Fund" with an amount they
// typed themselves. One caller, one click, one human.
//
// Consistent with that: this path also records NO recordSpend and NO AGENT.* attribution —
// it is not an agent action in the ledger either, so pausing an agent has nothing to pause.
//
// THE ONE BOUND THAT STAYS — and it is not an agent bound. ubDepositMaxPerTxUsdc is a FOOTGUN
// GUARD on the one irreversible move in the app. "Irreversible" is literal: a Gateway deposit
// CANNOT BE UNDONE BY ANYONE. No implemented path returns unified-balance funds to the user —
// no initiateWithdrawal, no gatewayWithdraw, no delay constant anywhere. The only Gateway write
// path (_ubspend.mjs) SPENDS the balance cross-chain, and agent-withdraw.mjs says outright that
// Gateway funds are "NOT retrievable by this endpoint". So a mistyped DEPOSIT is unrecoverable,
// where a mistyped WITHDRAWAL is simply redone. This bounds the blast radius of an extra zero.
// Nothing more. It is NOT a Circle/Gateway protocol limit; no such limit exists. Full reasoning,
// including why the value is 100, in _arc.mjs.

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  // ⭐ ONE REFUSER PER HANDLER, bound once. `resolveOwner` is LAZY: the audit trail is keyed by the
  // AGENT WALLET, but the cap is checked BEFORE that wallet is resolved (deliberately — an over-cap
  // request should get the cap message, not a wallet error). So the owner is resolved only if a
  // refusal actually fires, and enforcement ORDER is unchanged.
  const refuse = makeRefuser({
    source: "agent-ub-deposit",
    resolveOwner: () => ensureOwnerWallet(session).then((w) => w?.walletAddress ?? null).catch(() => null),
  });


  const { amountUsdc } = parseBody(event);
  const amount = Number(amountUsdc);
  const floor = amountFloorViolation(amount, { field: "amountUsdc" });
  if (floor) return json(400, { error: floor });

  // ── THE CAP — before anything is provisioned or kicked off. Reject, never clamp. ──
  const cap = ubDepositMaxPerTxUsdc();
  if (amount > cap) {
    return json(400, { error: await refuse(REFUSAL.PER_TX_CAP, `exceeds per-deposit limit of ${cap} USDC`, amount), cap });
  }

  // The depositor: THIS session's own agent SCA. Provisioned on first touch.
  let wallet;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { wallet = await ensureOwnerWallet(session); }
  // ⚠️ ONLY the tagged external failure earns this diagnosis. Anything else — a TypeError from
  // a bad refactor, say — RE-THROWS and surfaces unclaimed, rather than borrowing a
  // "temporary, please retry" it cannot honour.
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }
  if (wallet.pending) {
    return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  }
  const owner = wallet.walletAddress;

  // Insufficient funds answers SYNCHRONOUSLY (402), like job-run's front door. ubDeposit
  // re-checks this before it signs — this copy exists so the common, obvious failure is an
  // immediate honest answer instead of a poll that ends in "failed".
  const balance = await publicClient().readContract({
    address: CONTRACTS.USDC,
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
  const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS));
  if (balance < units) {
    return json(402, {
      error: `Insufficient funds. Your agent wallet has ${formatUnits(balance, USDC_DECIMALS)} USDC, need ${amount}.`,
      have: formatUnits(balance, USDC_DECIMALS),
      need: amount,
      walletAddress: owner,
    });
  }

  // Record the intent BEFORE firing, so a poll that arrives before the worker starts finds
  // a real record rather than a 404 it has to interpret.
  const depositId = crypto.randomUUID();
  const store = getStore("ub-deposits");
  await store.setJSON(`dep:${depositId}`, {
    depositId,
    owner: session.address, // the session identity — what agent-ub-deposit-status authorizes on
    walletAddress: owner,
    amountUsdc: amount,
    status: "starting",
    createdAt: new Date().toISOString(),
  });

  const base =
    process.env.DEPLOY_URL ||
    `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
  try {
    await fetch(`${base}/.netlify/functions/agent-ub-deposit-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ depositId, amountUsdc: amount, owner }),
    });
  } catch (e) {
    await store.setJSON(`dep:${depositId}`, {
      depositId,
      owner: session.address,
      walletAddress: owner,
      amountUsdc: amount,
      status: "failed",
      error: `could not start the deposit worker: ${e.message}`,
      fundsMoved: false,
      createdAt: new Date().toISOString(),
    });
    return json(502, { error: `could not start the deposit worker: ${e.message}` });
  }

  return json(202, { depositId, walletAddress: owner, amountUsdc: amount });
}
