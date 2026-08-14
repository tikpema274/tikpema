import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody, ARC } from "./_arc.mjs";
import { requireInternal, internalToken } from "./_auth.mjs";
import { circle } from "./_circle.mjs";
import {
  readPendingReceipt,
  writePendingReceiptNeverThrows,
  retirePendingReceipt,
  readReceipt,
  saveReceipt,
  provisionalStatus,
  SUBMITTED_STATE,
  SUBMIT_FAILED_STATE,
  PENDING_STAGES,
  CIRCLE_LANDED_STATE,
  CIRCLE_DEAD_STATES,
} from "./_bridge-receipts.mjs";

// POST /.netlify/functions/bridge-reconcile-background { owner, txId }   (INTERNAL ONLY)
//
// ⭐⭐ THE JOB THE PROVISIONAL RECORD WAS BUILT AS A HOOK FOR. `412e8d0` wrote a `tx-<txId>`
// record on the 202 path and said, explicitly, that the reconcile job was NOT built: "this
// record is the hook that makes it possible, not the recovery itself." The cap that followed
// made its absence LOUD instead of silent — an aged-out row telling the user to reconcile by
// hand. That was honest, and it was still asking a person to do something the system can do.
// This is the system doing it.
//
// ══ WHAT IT ACTUALLY DOES ══════════════════════════════════════════════════════════════
// A provisional record carries the Circle transaction id whose settlement we stopped waiting
// for. Circle still knows what became of it. So: ask, and act on the answer.
//   COMPLETE + stage "burn"     -> we now have the burn hash. Write the DURABLE receipt under
//                                  its real key, hand it to the settler, retire the provisional.
//   COMPLETE + stage "approve"  -> the ALLOWANCE landed; the bridge call was never made. No burn
//                                  exists and none is coming. Terminal, and no money moved.
//   FAILED/CANCELLED/DENIED     -> the submission died. Terminal, and no money moved.
//   anything else               -> still pending. Record the attempt and leave it alone.
//
// ══ 🚨 THE DEFECT THIS JOB WOULD HAVE SHIPPED, FOUND WHILE BUILDING IT ══════════════════
// `agentBridge` calls `waitForTx` TWICE — once for the USDC approve (_bridge.mjs), once for the
// bridge call. BOTH raise TxPendingError, and the error carries only the id of whichever one
// timed out. So `txId` on a provisional record is NOT necessarily the burn transaction.
//
// ⭐⭐ A NAIVE RECONCILE WOULD HAVE READ THE APPROVE'S `txHash` AND WRITTEN IT AS A `burnHash`.
// That is a fabricated money-movement record: the panel would say "in flight — estimated N USDC
// to arrive" for a bridge whose burn was never submitted, and the settler would spend its life
// asking IRIS about a hash that is not a CCTP burn at all. The record would look MORE trustworthy
// than the provisional one it replaced, which is the worst possible direction for a mistake in a
// receipt system.
//
// The fix is upstream — `_bridge.mjs` now tags the error with the stage — and the guard is here:
// ⚠️ AN ABSENT OR UNRECOGNISED STAGE IS REFUSED, NEVER ASSUMED TO BE "burn". Records written by
// the deploy that shipped `412e8d0` have NO stage field, and they must not be reconciled by
// guessing; guessing is precisely how the fabricated hash gets written. They are left for a
// human, loudly. Absence must not read as safe — including the absence of a stage.
//
// ══ WHY A BACKGROUND FUNCTION AND NOT PART OF THE SWEEP ═════════════════════════════════
// `bridge-mint-sweep` OWNS NO WRITES, asserted by substring in verify-bridge-receipts.mjs. That
// invariant is worth more than the convenience of doing the work inline, so the sweep triggers
// this and this owns every write — exactly the shape the settler already uses.
//
// ══ INTERNAL ONLY ══════════════════════════════════════════════════════════════════════
// Every file here is a public URL whether or not netlify.toml routes it, and this one MUTATES
// receipt state and can CREATE a durable receipt. `requireInternal` runs before anything else,
// and there is deliberately no /api/* route.
//
// ⚠️ IT NEVER TRUSTS ITS CALLER. `owner` and `txId` are KEYS used to look up a record we already
// wrote; every amount, destination and consent field is copied from that record. Nothing about
// the money enters this system from the request body.

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!requireInternal(event)) {
    console.warn("[bridge-reconcile] REFUSED — no valid x-internal-token; nothing was read or written");
    return json(401, { error: "internal only" });
  }
  connectBlobs(event);

  const { owner, txId } = parseBody(event) || {};
  if (!owner || !txId) return json(400, { error: "owner and txId required" });

  const rec = await readPendingReceipt(owner, txId);
  if (!rec) {
    // Not an error: the sweep may have triggered this twice, or a previous run already
    // retired it. Idempotent by construction.
    console.log(`[bridge-reconcile] no provisional record owner=${owner} txId=${txId} — nothing to do`);
    return json(200, { ok: true, outcome: "absent" });
  }
  if (rec.state !== SUBMITTED_STATE) {
    console.log(`[bridge-reconcile] already terminal state=${rec.state} txId=${txId}`);
    return json(200, { ok: true, outcome: "already_terminal", state: rec.state });
  }

  // ⭐ BOUNDED EFFORT, AND IT IS THE SAME BOUND AS THE CLAIM. Past the 24h cap the panel tells
  // the user this needs a human — so the machine stops asking. Continuing to poll Circle forever
  // behind a row that says "a human must look" would be the 12-day Polygon record's unbounded
  // re-check wearing a different name, and would make that row's text false.
  const status = provisionalStatus(rec);
  if (status.terminal) {
    console.warn(
      `[bridge-reconcile] PAST THE CAP txId=${txId} attempts=${rec.reconcileAttempts ?? 0} — ` +
        `no longer asking Circle. This one needs a human. (${status.detail})`
    );
    return json(200, { ok: true, outcome: "past_cap", attempts: rec.reconcileAttempts ?? 0 });
  }

  // 🚨 THE STAGE GUARD. See the block comment — this is what stops an approve's txHash from
  // being written as a burn hash.
  const stage = rec.pendingStage;
  if (!PENDING_STAGES.includes(stage)) {
    console.error(
      `[bridge-reconcile] 🚨 REFUSING txId=${txId} — pendingStage is ${JSON.stringify(stage)}, not one of ` +
        `${PENDING_STAGES.join("/")}. Without it we cannot tell an APPROVE timeout from a BURN timeout, and ` +
        `guessing "burn" would write a fabricated burnHash. Records from before the stage was recorded land ` +
        `here BY DESIGN and need a human.`
    );
    await bumpAttempt(rec, "refused_unknown_stage");
    return json(200, { ok: false, outcome: "unknown_stage", stage: stage ?? null });
  }

  // ── ASK CIRCLE ────────────────────────────────────────────────────────────────────────
  let tx;
  try {
    const { data } = await circle().getTransaction({ id: txId });
    tx = data?.transaction;
  } catch (e) {
    // ⚠️ AN UNREACHABLE CIRCLE IS NOT AN ANSWER. Record the attempt and leave the record exactly
    // as it was — never downgrade "we could not ask" into a terminal state.
    console.warn(`[bridge-reconcile] Circle unreachable txId=${txId} — ${e?.message}`);
    await bumpAttempt(rec, `circle_error: ${e?.message}`);
    return json(200, { ok: false, outcome: "circle_unreachable" });
  }
  const cState = tx?.state ?? null;

  // ── LANDED ────────────────────────────────────────────────────────────────────────────
  if (cState === CIRCLE_LANDED_STATE) {
    if (stage === "approve") {
      // The allowance transaction completed. The bridge call that follows it was never made —
      // the request had already returned 202 by then. Nothing was burned, nothing is coming.
      return await terminate(rec, "approve_completed_bridge_never_submitted",
        "the USDC approval landed, but the bridge call itself was never submitted — no burn exists");
    }
    const burnHash = tx?.txHash;
    if (!/^0x[0-9a-fA-F]{64}$/.test(burnHash || "")) {
      // COMPLETE with no usable hash is a shape we do not understand. Say so; do not invent one.
      console.error(`[bridge-reconcile] 🚨 COMPLETE but txHash is ${JSON.stringify(burnHash)} txId=${txId} — not writing a receipt`);
      await bumpAttempt(rec, "complete_without_hash");
      return json(200, { ok: false, outcome: "complete_without_hash" });
    }

    // ⚠️ NEVER CLOBBER A RECEIPT THE SETTLER HAS ALREADY ADVANCED. A second reconcile tick would
    // otherwise overwrite `minted` + a measured amount with a fresh `burn_confirmed`, un-proving a
    // bridge that had been proven. Read first; if it exists, this tick's only job is to retire the
    // provisional key.
    const existing = await readReceipt(owner, burnHash);
    if (existing) {
      console.log(`[bridge-reconcile] durable receipt already exists burnHash=${burnHash} — retiring the provisional key only`);
      await retirePendingReceipt(owner, txId);
      return json(200, { ok: true, outcome: "already_recorded", burnHash });
    }

    // ⭐ THE DURABLE RECEIPT, BUILT ENTIRELY FROM THE PROVISIONAL RECORD. Every consent field is
    // CARRIED, not recomputed — `ackAcceptedAt` in particular was the whole reason the provisional
    // record exists, and re-deriving it here would invent evidence rather than preserve it.
    const burnedAt = tx?.updateDate && Number.isFinite(Date.parse(tx.updateDate))
      ? new Date(tx.updateDate).toISOString()
      : new Date().toISOString();
    await saveReceipt({
      schema: "bridge-receipt/1",
      owner: rec.owner,
      burnHash,
      burnTx: `${ARC.explorer}/tx/${burnHash}`,
      burnedAt,
      state: "burn_confirmed",
      destinationKey: rec.destinationKey ?? null,
      destinationLabel: rec.destinationLabel ?? null,
      // ⚠️ LOAD-BEARING, NOT COSMETIC. `verifyMintOnChain` refuses with `bad_recipient` when this
      // is absent, and the settler would then park the receipt at `mint_unconfirmed` and re-check
      // it every 10 minutes forever — the exact unbounded shape of the 12-day Polygon record. It
      // is recorded on the provisional receipt for this reason alone.
      recipient: rec.recipient ?? null,
      amountRequested: rec.amountRequested ?? null,
      feeUsdc: rec.feeUsdc ?? null,
      netPredicted: rec.netPredicted ?? null,
      delivery: "predicted",
      amountDelivered: null,
      feeRatio: rec.feeRatio ?? null,
      ackBand: rec.ackBand ?? null,
      ackRequired: rec.ackRequired ?? false,
      ackAcceptedAt: rec.ackAcceptedAt ?? null,
      ackToken: rec.ackToken ?? null,
      quoteId: rec.quoteId ?? null,
      quoteStepIndex: rec.quoteStepIndex ?? null,
      // ⭐ PROVENANCE: this receipt was RECOVERED, never observed live. A reader that cannot tell
      // the difference cannot weigh it, and `burnedAt` here is Circle's clock, not ours.
      reconciledFromTxId: txId,
      reconciledAt: new Date().toISOString(),
      submittedAt: rec.submittedAt ?? null,
    });
    console.log(`[bridge-reconcile] ⭐ RECOVERED burnHash=${burnHash} from txId=${txId} owner=${owner}`);

    // NOW there is a burn hash, so the settler finally has something to settle. Awaited for the
    // same reason every other trigger in this repo is: an un-awaited fetch may never be sent.
    await triggerSettle(event, owner, burnHash);

    // ⚠️ RETIRE LAST. Write-then-delete: a failure after the durable write leaves a visible
    // duplicate the next tick cleans up, while delete-first would risk losing the record entirely.
    await retirePendingReceipt(owner, txId);
    return json(200, { ok: true, outcome: "recovered", burnHash });
  }

  // ── DEAD ──────────────────────────────────────────────────────────────────────────────
  if (CIRCLE_DEAD_STATES.includes(cState)) {
    return await terminate(rec, `circle_${String(cState).toLowerCase()}`,
      `Circle reports this transaction as ${cState} — it never landed, and no funds moved`);
  }

  // ── STILL PENDING ─────────────────────────────────────────────────────────────────────
  // ⚠️ A state we do not recognise is treated as PENDING and NAMED. Silently bucketing an unknown
  // into a known outcome is how an unexpected Circle state would become a wrong receipt.
  await bumpAttempt(rec, `pending: ${cState ?? "unknown"}`);
  console.log(`[bridge-reconcile] still pending txId=${txId} circleState=${cState}`);
  return json(200, { ok: true, outcome: "pending", circleState: cState });

  // ── helpers, closed over the request ──────────────────────────────────────────────────
  async function bumpAttempt(r, outcome) {
    await writePendingReceiptNeverThrows({
      ...r,
      reconcileAttempts: Number.isInteger(r.reconcileAttempts) ? r.reconcileAttempts + 1 : 1,
      lastReconciledAt: new Date().toISOString(),
      lastReconcileOutcome: outcome,
    });
  }

  async function terminate(r, reason, detail) {
    // ⚠️ TERMINAL ON ITS OWN KEY, NOT PROMOTED TO A CONFIRMED ONE. It keeps the `tx-` key and
    // gains a terminal state; it never acquires a burnHash, so it can never masquerade as a
    // confirmed receipt — the property the key layout exists to guarantee.
    await writePendingReceiptNeverThrows({
      ...r,
      state: SUBMIT_FAILED_STATE,
      submitFailureReason: reason,
      submitFailureDetail: detail,
      reconcileAttempts: Number.isInteger(r.reconcileAttempts) ? r.reconcileAttempts + 1 : 1,
      lastReconciledAt: new Date().toISOString(),
      lastReconcileOutcome: reason,
      resolvedAt: new Date().toISOString(),
    });
    console.log(`[bridge-reconcile] TERMINAL txId=${txId} reason=${reason} — ${detail}`);
    return json(200, { ok: true, outcome: "submit_failed", reason });
  }

  async function triggerSettle(ev, ownerAddr, hash) {
    try {
      const base = process.env.DEPLOY_URL || process.env.URL ||
        `${ev.headers?.["x-forwarded-proto"] || "https"}://${ev.headers?.host}`;
      const res = await fetch(`${base}/.netlify/functions/bridge-mint-settle-background`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken() },
        body: JSON.stringify({ owner: ownerAddr, burnHash: hash }),
      });
      console.log(`[bridge-reconcile] settle triggered burnHash=${hash} status=${res.status}`);
    } catch (e) {
      // Swallowed: the receipt is written and the sweeper will find it stranded and re-trigger.
      // A failed trigger must not undo a successful recovery.
      console.warn(`[bridge-reconcile] settle trigger failed (swallowed) burnHash=${hash}: ${e?.message}`);
    }
  }
};
