import { internalToken } from "./_auth.mjs";
import { writeReceiptNeverThrows } from "./_bridge-receipts.mjs";

// RECORD A BRIDGE — the write-and-trigger pair, in ONE place, called from the HTTP
// boundaries that own it.
//
// ══ WHY THIS IS AT THE BOUNDARY AND NOT IN executeAction ═══════════════════════════
// The obvious move is to put this inside the shared executor so every bridge is covered
// automatically. That is WRONG here, and the reason is worth keeping:
//
// 🚨 `job-bridge-approve` ALREADY HAS A COMPLETE RECEIPT SYSTEM — its own record in the
// `job-deliverables` store, its own verifier (job-bridge-receipt-background.mjs), its own
// four states, and an `approving` lock, all adversarially proven. It also calls
// executeAction. So a write inside the executor would give every plan-path bridge a
// SECOND receipt in a SECOND store, drifting independently — the duplicate-source-of-truth
// failure introduced one layer down, where it is harder to see.
//
// The exclusion is deliberate, which is exactly why the boundary is the right home: only
// the callers that DON'T already record a bridge call this.
//
//   agent-bridge.mjs        → calls this (Bridge page + agent single-action)
//   agent-execute-plan.mjs  → calls this (multi-step plans)
//   job-bridge-approve.mjs  → does NOT, and must not: it has its own
//
// ⚠️ It also cannot live in executeAction mechanically: the settle trigger needs a base
// URL from the request, and `ctx` carries {walletAddress, session} with no `event`.
// Threading `event` into a shared money-path executor for one branch's benefit is the
// wrong direction.
//
// ══ WHAT THIS GUARANTEES ══════════════════════════════════════════════════════════
// · The write CANNOT fail the caller. It runs after the burn has landed, so an error
//   surfacing here would report a failure for a bridge that succeeded — and the user
//   would retry and burn twice. Everything is swallowed; callers must NOT branch on the
//   return except for logging.
// · Every field is SERVER-SOURCED: amounts and fee from executeAction's own return
//   (priced live inside it), owner from the verified session, recipient from the
//   server-resolved agent wallet. Nothing a client sent lands in a receipt.
// · `delivery: "predicted"` is the honest state at this instant — netPredicted is
//   arithmetic (amount − maxFee), not an observation. ONLY the settler's
//   destination-chain read may promote it to "measured".

/** Kick the settler and wait only for its 202 ack. See the block comment in
 *  agent-bridge.mjs history: an UN-AWAITED fetch is often never sent, because a Netlify
 *  function can freeze the moment the handler returns. That bug stranded a receipt for
 *  7h58m. Awaiting costs one in-region round trip; the 4-minute poll still runs off the
 *  request, inside the background function. */
async function triggerSettle({ event, owner, burnHash }) {
  try {
    const base =
      process.env.DEPLOY_URL ||
      `${event?.headers?.["x-forwarded-proto"] || "https"}://${event?.headers?.host}`;
    const res = await fetch(`${base}/.netlify/functions/bridge-mint-settle-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ owner, burnHash }),
    });
    console.log(`[bridge-receipt] settle trigger sent burnHash=${burnHash} status=${res.status}`);
    return true;
  } catch (e) {
    // Swallowed: the settler is an optimisation over the client's own polling, never a
    // precondition for the bridge having worked. A trigger failure must not fail a bridge
    // whose money already moved — and the sweeper will pick it up within 10 minutes.
    console.warn(`[bridge-receipt] settle trigger FAILED (swallowed) burnHash=${burnHash}: ${e?.message}`);
    return false;
  }
}

/**
 * Write the receipt for a completed bridge and ask the settler to verify it.
 *
 * @param r        executeAction's bridge return ({ burnHash, tx, destination, feeUsdc,
 *                 netUsdc, recipient, feeBand, feeRatio, ackRequired, acknowledged,
 *                 ackToken })
 * @param session  the verified session — `session.address` is the receipt's owner
 * @param event    the request, for the settle trigger's base URL
 * @param amountRequested  the amount the caller asked to bridge
 * @param quoteId  OPTIONAL join key to the priced plan in the `agent-quotes` store, or null
 *                 on a path that had no quote (the direct Bridge page). See below.
 * @param stepIndex which step of that plan this was, or null outside a plan.
 *
 * No-ops without a burnHash: the 202 TxPendingError path has no hash to key on, so there
 * is nothing to record and today's behaviour is preserved.
 */
export async function recordBridge({ r, session, event, amountRequested, quoteId = null, stepIndex = null }) {
  if (!r?.burnHash) return { recorded: false, reason: "no_burn_hash" };

  const burnedAt = new Date().toISOString();
  const write = await writeReceiptNeverThrows({
    schema: "bridge-receipt/1",
    owner: session.address,
    burnHash: r.burnHash,
    burnTx: r.tx,
    burnedAt,
    state: "burn_confirmed",
    destinationKey: r.destination?.key,
    destinationLabel: r.destination?.label,
    recipient: r.recipient,
    amountRequested: Number(amountRequested),
    feeUsdc: r.feeUsdc,
    netPredicted: r.netUsdc,
    delivery: "predicted",
    amountDelivered: null,
    // ⭐ THE GATE LEAVES EVIDENCE. Without these the receipt cannot answer "was the user
    // warned, and did they accept?" — for a disclosure whose whole purpose is consent to
    // lose most of the amount, that belongs in the record, not in someone's memory of
    // what the screen said. `acknowledged` is true only because the server recomputed the
    // token and it matched.
    feeRatio: r.feeRatio ?? null,
    ackBand: r.feeBand ?? null,
    ackRequired: r.ackRequired ?? false,
    ackAcceptedAt: r.acknowledged ? burnedAt : null,
    ackToken: r.ackToken ?? null,
    // ⭐ THE JOIN TO WHAT WAS PROPOSED. Every other field here says what the bridge DID; these
    // two say which priced plan it came from, so `agent-quotes` and this receipt can be read
    // together. Without a shared identifier they are two records nobody can correlate, which
    // is the state that left the 2026-08-01 ack anomaly unanswerable.
    //
    // 🚨 NULL IS NORMAL AND MEANS NOTHING BAD. The direct Bridge page and the agent
    // single-action panel produce no plan quote, so their receipts carry null here. An
    // absent join must never be read as a defect — and, like the rest of this pair, it is
    // DIAGNOSTIC: no gate anywhere reads `quoteId`.
    quoteId: quoteId ?? null,
    quoteStepIndex: Number.isInteger(stepIndex) ? stepIndex : null,
  });

  await triggerSettle({ event, owner: session.address, burnHash: r.burnHash });
  return { recorded: write.written === true, burnedAt };
}
