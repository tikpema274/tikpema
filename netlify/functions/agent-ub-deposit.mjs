import { connectLambda, getStore } from "@netlify/blobs";
import { formatUnits } from "viem";
import crypto from "node:crypto";
import { json, parseBody, ubDepositCapUsdc, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { publicClient } from "./_predict.mjs";

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
// ⚠️ THE CAP IS ENFORCED HERE, BEFORE the background worker is even invoked. _ubdeposit.mjs
// is UNCAPPED; reaching it from an unguarded path would bypass the cap (the swap-cap trap).
// Reject-not-clamp: an over-cap request 400s and NOTHING is kicked off.
//
// NOTE: a deposit is NOT ledgered against the day-ceiling — it moves your own USDC into your
// own Gateway balance (self-custody), not a spend. The SPEND side draws the ceiling down.

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
  if (event.blobs) connectLambda(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { amountUsdc } = parseBody(event);
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });

  // ── THE CAP — before anything is provisioned or kicked off. Reject, never clamp. ──
  const cap = ubDepositCapUsdc();
  if (amount > cap) {
    return json(400, { error: `exceeds per-deposit limit of ${cap} USDC`, cap });
  }

  // The depositor: THIS session's own agent SCA. Provisioned on first touch.
  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) {
    return json(202, { status: "provisioning", message: "Your wallet is being set up — retry shortly." });
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
