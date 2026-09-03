// POST /api/agent-send { to, amountUsdc }  (auth required)  — Sub-brick A
//
// Transfer USDC FROM the caller's OWN agent wallet (the per-user 2a wallet that
// holds their funds and pays for jobs), resolved from the SESSION — never
// client-supplied. The agent wallet is a Circle dev-controlled SCA, so only the
// server can move it; this is the server-side "send" for the wallet the user
// actually funds. Gasless (Gas Station sponsored).
import { amountFloorViolation } from "./_amount-floor.mjs";
import { formatUnits } from "viem";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody, ARC, CONTRACTS, USDC_DECIMALS, sendCapUsdc } from "./_arc.mjs";
import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { canSpendDay, recordAgentSpend, shoutLedgerFailure, makeRefuser, REFUSAL } from "./_budget.mjs";
import { AGENT } from "./_agents.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { publicClient } from "./_predict.mjs";

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
    source: "agent-send",
    resolveOwner: () => ensureOwnerWallet(session).then((w) => w?.walletAddress ?? null).catch(() => null),
  });


  const { to, amountUsdc } = parseBody(event);
  if (!/^0x[0-9a-fA-F]{40}$/.test(to || "")) {
    return json(400, { error: "valid 'to' address required" });
  }
  const amount = Number(amountUsdc);
  const floor = amountFloorViolation(amount, { field: "amountUsdc" });
  if (floor) return json(400, { error: floor });

  // GUARDRAIL 1 — per-transaction send cap (hard limit; checked first so an
  // over-cap send returns the cap message).
  const cap = sendCapUsdc();
  if (amount > cap) {
    return json(400, { error: await refuse(REFUSAL.PER_TX_CAP, `exceeds per-transaction limit of ${cap} USDC`, amount), cap });
  }

  // Resolve the caller's OWN wallet from the session (never client-supplied).
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
  const walletAddress = wallet.walletAddress;

  // GUARDRAIL 2 — day-ceiling: cumulative agent sends count against the same
  // rolling-UTC-day budget as other autonomous spend, PER USER — keyed to this
  // caller's own wallet (server-resolved), so it can't be blocked by, or block,
  // any other wallet.
  // ── THE KILL SWITCH. agent-send moves funds via a direct transfer() and NEVER calls
  // executeAction, so a pause enforced only there would leave this path wide open.
  // Fail-closed: an unreadable switch refuses. ──
  const paused = await assertNotPaused({ owner: walletAddress, agent: AGENT.EXECUTOR });
  if (paused) return json(409, { error: await refuse(REFUSAL.PAUSED, paused, amount), paused: true });

  const day = await canSpendDay({ amountUsdc: amount, owner: walletAddress });
  if (!day.allowed) {
    return json(429, { error: await refuse(REFUSAL.DAY_CEILING, day.reason, amount), dayCeiling: true });
  }

  // Clean insufficient-funds error before attempting the transfer.
  try {
    const raw = await publicClient().readContract({
      address: CONTRACTS.USDC,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
    const have = Number(formatUnits(raw, USDC_DECIMALS));
    if (have < amount) {
      return json(402, {
        error: `Insufficient funds. Have ${have.toFixed(2)} USDC, need ${amount.toFixed(2)}.`,
        have: Number(have.toFixed(2)),
      });
    }
  } catch {
    /* balance read hiccup — let the transfer attempt surface any real failure */
  }

  // ── THE LEDGER, IN BOTH OUTCOMES. See the pending branch below for why it is not one call. ──
  // `confirmation`/`circleId` are recorded so the audit never asserts more than was observed, and so
  // step 8 can resolve a charge later. A "confirmed" entry is unreversible BY CONSTRUCTION
  // (reverseAgentSpend GUARD 1), which is the point of stating it rather than leaving it absent:
  // ⚠️ an ABSENT confirmation used to mean "this caller does not know", and a reader could not tell
  // that from "this caller never checked". Now it says which.
  //
  // 🚨 DECLARED ABOVE THE `try`, DELIBERATELY. `const` is block-scoped, so declaring it INSIDE the
  // try makes it invisible to the catch — the pending branch would throw ReferenceError instead of
  // ledgering, turning a 202 into a 500 AND still losing the spend: strictly worse than the bug
  // being fixed, and invisible to any source-grep guard. (Written that way first; caught by
  // verify-pending-spend-ledgered.mjs, not by re-reading it.)
  const doLedger = (extra) =>
    recordAgentSpend({
      agent: AGENT.EXECUTOR,
      owner: walletAddress,
      amountUsdc: amount,
      source: "agent-send",
      justification: `user send to ${to}`,
      ...extra,
    }).catch((err) =>
      // ⭐ SWALLOW, BUT SHOUT. This was `.catch(() => {})` — the silent form. The money has already
      // moved by the time this runs, so throwing would report failure for a transfer that happened;
      // the swallow is right and the SILENCE was the defect. Shared helper, never a second copy.
      shoutLedgerFailure({ agent: AGENT.EXECUTOR, owner: walletAddress, amountUsdc: amount, source: "agent-send", err })
    );

  try {
    const client = circle();
    const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
    const tx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "transfer(address,uint256)",
      abiParameters: [to, units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txHash = await waitForTx(client, tx.data?.id);
    await doLedger({ confirmation: "confirmed", circleId: tx.data?.id });
    return json(200, { txHash, tx: `${ARC.explorer}/tx/${txHash}`, from: walletAddress });
  } catch (e) {
    // ── 🚨 A TIMEOUT IS NOT A REFUSAL (finding A, 2026-08-21) ──────────────────────────────────
    // TxPendingError means WE STOPPED WAITING after 60s — the transfer IS submitted to Circle and
    // may confirm seconds later. This branch used to hand `txId` to the CLIENT and ledger NOTHING,
    // and agent-send writes to no store, so the id left the server and the spend was never counted:
    // the day ceiling silently WIDENED by that amount, permanently. Fail-OPEN, on a wired route.
    //
    // ⭐ Ledger at SUBMIT with the authoritative id. `confirmation:"submitted"` + `circleId` is
    // precisely what listUnresolvedCharges selects and reverseAgentSpend resolves, so if the
    // transfer really did fail the charge is REVERSIBLE rather than lost. Over-counting narrows the
    // cap (safe); under-counting widens it (over-spend). This takes the safe side AND keeps the
    // evidence needed to correct it.
    //
    // ⚠️ NO PAIRED SUB-LEDGER here — checked against _budget.mjs's PRECONDITION, not assumed.
    if (e instanceof TxPendingError) {
      await doLedger({ confirmation: "submitted", circleId: e.txId });
      return json(202, { pending: true, txId: e.txId, message: e.message });
    }
    return json(500, { error: e.message });
  }
}
