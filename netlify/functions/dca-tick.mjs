import { connectLambda, getStore } from "@netlify/blobs";
import { executeAction } from "./_actions.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { AGENT } from "./_agents.mjs";
import { swapCapUsdc } from "./_arc.mjs";
import { valueInUsdc } from "./_swap.mjs";
import { publicClient } from "./_predict.mjs";
import { confirmSwapLanded } from "./_swap-confirm.mjs";
import { recordDcaSpend } from "./_budget.mjs";
import {
  MANDATE_STORE,
  FILLS_STORE,
  HEARTBEAT_STORE,
  fillClaimKey,
  evaluate,
  yieldsToUser,
  readTokenBalance,
  classifyFillError,
  STATUS,
  OUTCOME,
  MAX_CONSECUTIVE_FAILURES,
  FAILURE_WINDOW_MS,
  CONFIRM_GRACE_MS,
  MAX_CONSECUTIVE_UNCONFIRMED,
} from "./_dca.mjs";

// dca-tick.mjs — THE DCA SCHEDULER. Runs every minute; fills due mandates autonomously.
//
// This is the one place in Tikpema that moves money with NO user present. The ordering is
// load-bearing; do not reorder:
//
//   heartbeat(always) · per mandate:
//     RECONCILE any in-flight fill · else if due:
//       PAUSE(fail-closed) → value → CAP → YIELD-to-user → FUNDS → idempotency-claim → SUBMIT
//
// ⚠️ SUBMIT ≠ SPENT. A swap SUBMITTED this tick has not necessarily LANDED — the Circle SCA
// submits its userOp asynchronously and App Kit can return txHash:null even as the swap lands
// (the 1098 quirk). So a submit records PENDING_CONFIRM and does NOT touch spentAmount. The
// mandate's budget advances ONLY in RECONCILE, when the on-chain witness (confirmSwapLanded)
// confirms the fill landed — by hash, or by the two-legged log-scan. A tick that cannot confirm
// leaves the budget EXACTLY intact and records failed-unconfirmed: a phantom fill (swapped +
// budget spent + nothing on-chain) is therefore structurally impossible, because the one place
// spentAmount moves is gated on the chain saying yes.
//
// Every skip/outcome is a durable OUTCOME so "is my DCA working?" is answerable and a failure
// never reads as success. The SUBMIT routes through executeAction (never agentSwap directly), so
// it inherits the SAME swapCapUsdc + pause + day-ceiling + ledger a manual swap obeys.
//
// ⚠️ Schedule registered in netlify.toml ([functions."dca-tick"]); the in-code config is
// documentation (the CLI deploy did not pick up job-sweep's, so netlify.toml is authoritative).
export const config = { schedule: "* * * * *" };

// Bound the EXPENSIVE work (new submits, each an on-chain swap) per invocation so the tick stays
// well under the synchronous function timeout. RECONCILES of already-submitted fills are cheap
// (read-only chain lookups) and are NOT capped — they must never be starved, or a fill could sit
// pending forever. Lowered from 8 now that each submit also carries a snapshot + confirm handoff.
const MAX_SUBMITS_PER_TICK = 3;

export async function handler(event) {
  if (event?.blobs) connectLambda(event);
  const startedAt = new Date().toISOString();
  const now = Date.now();

  // ── UNCONDITIONAL HEARTBEAT — written every invocation regardless of work (the job-sweep
  // blind-spot fix: a quiet cron must be distinguishable from a dead one by reading ONE blob).
  const beat = { tickAt: startedAt, scanned: 0, submitted: 0, fired: 0, skipped: 0, failed: 0, stopped: 0, terminal: 0, errors: 0, details: [] };
  const writeHeartbeat = async () => {
    try { await getStore(HEARTBEAT_STORE).setJSON("last", beat); } catch { /* observability only */ }
  };

  let mandates, fills;
  try {
    mandates = getStore(MANDATE_STORE);
    fills = getStore(FILLS_STORE);
  } catch (e) {
    beat.errors++; beat.note = `stores unavailable: ${e.message}`;
    await writeHeartbeat();
    return { statusCode: 200, body: "stores-unavailable" };
  }

  // Tally one outcome into the heartbeat. FAILED_UNCONFIRMED counts with the failures; a submit
  // (PENDING_CONFIRM) counts as `submitted` — it becomes `fired` only when it later confirms.
  const tally = (outcome, tx, reason, id) => {
    if (outcome === OUTCOME.SWAPPED) beat.fired++;
    else if (outcome === OUTCOME.PENDING_CONFIRM) beat.submitted++;
    else if (outcome === OUTCOME.STOPPED_FAILED) beat.stopped++;
    else if (outcome === OUTCOME.FAILED_TRANSIENT || outcome === OUTCOME.FAILED_UNCONFIRMED) beat.failed++;
    else beat.skipped++;
    beat.details.push({ id, outcome, ...(tx ? { tx } : {}), ...(reason ? { reason: String(reason).slice(0, 80) } : {}) });
  };

  // Update the mandate blob: prepend to recentOutcomes (capped), set lastOutcome/at/reason, apply
  // patch. Does NOT write the fill claim (submit vs resolve write different claim shapes).
  const patchMandate = async (m, key, outcome, { reason = null, tx = null, patch = {}, period = null } = {}) => {
    const entry = { period, outcome, reason, tx, at: startedAt };
    const recentOutcomes = [entry, ...(m.recentOutcomes || [])].slice(0, 5);
    const next = { ...m, ...patch, recentOutcomes, lastOutcome: outcome, lastOutcomeAt: startedAt, lastReason: reason };
    await mandates.setJSON(key, next);
    tally(outcome, tx, reason, m.id);
  };

  // A RESOLVED fill claim — terminal for (mandate, period). `status` ABSENT ⇒ resolved ⇒ the
  // submit-guard treats the period as done (no re-fill this period; retry is a future period).
  const resolveClaim = async (id, period, outcome, { reason = null, tx = null } = {}) => {
    await fills.setJSON(fillClaimKey(id, period), { mandateId: id, period, outcome, reason, tx, at: startedAt });
  };

  // The immediate-resolve path (all the pre-submit SKIPs): patch the mandate AND resolve the claim.
  const record = async (m, key, period, outcome, { reason = null, tx = null, patch = {} } = {}) => {
    await patchMandate(m, key, outcome, { reason, tx, patch, period });
    await resolveClaim(m.id, period, outcome, { reason, tx });
  };

  // ── RECONCILE an in-flight fill (submitted a prior tick, awaiting the witness). THE ONLY PLACE
  // spentAmount advances. Confirm → decrement + record swapped + recover the real hash. Can't
  // confirm within grace → failed-unconfirmed, budget intact. Reverted → stop. RPC hiccup → leave
  // pending (never fail a fill because we couldn't look). ──
  const reconcilePending = async (m, key) => {
    const period = m.pendingPeriod;
    const claim = await fills.get(fillClaimKey(m.id, period), { type: "json" }).catch(() => null);
    // Defensive: the pending claim vanished or is no longer 'submitted' — drop the pointer.
    if (!claim || claim.status !== "submitted") {
      await mandates.setJSON(key, { ...m, pendingPeriod: null });
      return;
    }

    const res = await confirmSwapLanded({
      walletAddress: m.walletAddress,
      tokenIn: m.tokenIn,
      tokenOut: m.tokenOut,
      amountIn: m.perTickAmount,
      fromBlock: BigInt(claim.snapshotBlock),
      eventTxHash: claim.eventTxHash || null,
    });

    if (res.confirmed) {
      // ── THE WITNESS CONFIRMED — advance the budget now, and ONLY now. Recover the real hash
      // (log-scan or receipt) into lastFillTx; reset every failure streak. Patch mandate FIRST so
      // a crash before the claim write cannot lose the decrement (it under-counts at worst). ──
      const spentAmount = Number((m.spentAmount + m.perTickAmount).toFixed(6));
      const reason = `confirmed by ${res.verifiedBy}${res.amountOut != null ? ` (+${res.amountOut} ${m.tokenOut})` : ""}`;
      await patchMandate(m, key, OUTCOME.SWAPPED, {
        reason, tx: res.tx || res.txHash || null, period,
        patch: {
          spentAmount,
          lastFilledPeriod: period,
          lastFillAt: claim.submittedAt,
          lastFillTx: res.tx || res.txHash || null,
          pendingPeriod: null,
          consecutiveFailures: 0,
          firstFailureAt: null,
          consecutiveUnconfirmed: 0,
          needsAttention: false,
        },
      });
      await resolveClaim(m.id, period, OUTCOME.SWAPPED, { reason, tx: res.tx || res.txHash || null });
      return;
    }

    // A REVERTED tx is a genuine failure — the revert reverts state, so no funds moved. Stop the
    // mandate on the first occurrence, exactly like a slippage/genuine failure.
    if (res.reason === "reverted") {
      const reason = `swap reverted on-chain (${res.txHash})`;
      await patchMandate(m, key, OUTCOME.STOPPED_FAILED, {
        reason, period,
        patch: { status: STATUS.STOPPED_FAILED, stoppedAt: startedAt, pendingPeriod: null, needsAttention: true },
      });
      await resolveClaim(m.id, period, OUTCOME.STOPPED_FAILED, { reason });
      return;
    }

    // Couldn't READ the chain this tick (rpc-error) — NOT a "did not land". Leave pending, consume
    // no grace; next tick re-checks. We never fail a fill because we couldn't look.
    if (String(res.reason).startsWith("rpc-error")) return;

    // not-found or ambiguous: still no witness. Inside the grace window, keep it pending (a
    // healthy-but-slow tx just hasn't settled). Past grace, declare it unconfirmed — BUDGET INTACT
    // — and count it toward the consecutive-unconfirmed stop.
    const ageMs = now - Date.parse(claim.submittedAt);
    if (ageMs < CONFIRM_GRACE_MS) return;

    const consecutiveUnconfirmed = (m.consecutiveUnconfirmed || 0) + 1;
    const ambiguous = String(res.reason).startsWith("ambiguous");
    const detail = ambiguous
      ? `${res.reason} — refusing to attribute one to this fill (fail-closed)`
      : `no on-chain witness within ${Math.round(CONFIRM_GRACE_MS / 1000)}s of submit`;

    if (consecutiveUnconfirmed >= MAX_CONSECUTIVE_UNCONFIRMED) {
      const reason = `stopped after ${consecutiveUnconfirmed} unconfirmed fills — last: ${detail}`;
      await patchMandate(m, key, OUTCOME.STOPPED_FAILED, {
        reason, period,
        patch: { status: STATUS.STOPPED_FAILED, stoppedAt: startedAt, pendingPeriod: null, consecutiveUnconfirmed, needsAttention: true },
      });
      await resolveClaim(m.id, period, OUTCOME.STOPPED_FAILED, { reason });
    } else {
      await patchMandate(m, key, OUTCOME.FAILED_UNCONFIRMED, {
        reason: detail, period,
        patch: { pendingPeriod: null, consecutiveUnconfirmed, needsAttention: true },
      });
      await resolveClaim(m.id, period, OUTCOME.FAILED_UNCONFIRMED, { reason: detail });
    }
  };

  try {
    const { blobs } = await mandates.list({ prefix: "mandate:" });
    for (const { key } of blobs) {
      const m = await mandates.get(key, { type: "json" }).catch(() => null);
      if (!m || m.status !== STATUS.ACTIVE) continue;
      beat.scanned++;

      // ── RECONCILE FIRST — an in-flight fill is settled (or left pending) before anything else,
      // and uncapped, so it can never be starved by the submit budget. One action per mandate per
      // tick: a mandate with a fill in flight neither evaluates nor submits a new one. ──
      if (m.pendingPeriod != null) {
        await reconcilePending(m, key);
        continue;
      }

      const decision = evaluate(m, now);

      // Terminal (budget spent / past end date) — persist and stop. Not a fill event: no claim.
      if (decision.terminal) {
        await mandates.setJSON(key, { ...m, status: decision.terminal, closedAt: startedAt, lastReason: decision.reason });
        beat.terminal++;
        continue;
      }
      if (!decision.due) continue; // not this period
      const period = decision.period;

      // Cap NEW submits (the expensive on-chain path). `continue`, not `break`: later mandates may
      // still need RECONCILING above, which must not be blocked by the submit budget.
      if (beat.submitted >= MAX_SUBMITS_PER_TICK) continue;

      // ── 1. PAUSE — fail-closed, BEFORE anything else. A truthy reason (paused / halted /
      // UNREADABLE) means DO NOT SWAP. Enforced HERE in the scheduler, not just the UI. ──
      const paused = await assertNotPaused({ owner: m.walletAddress, agent: AGENT.EXECUTOR });
      if (paused) { await record(m, key, period, OUTCOME.SKIPPED_PAUSED, { reason: paused }); continue; }

      // ── 2. VALUE the fill in USDC (for the cap + yield checks). USDC→ needs no pricing;
      // otherwise price via the same valueInUsdc executeAction uses. A throw = cannot price =
      // fail-closed skip (never fill on an unknown value). ──
      let fillValueUsdc;
      try {
        fillValueUsdc = m.tokenIn === "USDC" ? m.perTickAmount : await valueInUsdc({ token: m.tokenIn, amount: m.perTickAmount });
      } catch (e) {
        await record(m, key, period, OUTCOME.SKIPPED_BLOCKED, { reason: `cannot value fill: ${e.message}` });
        continue;
      }

      // ── 3. PER-SWAP CAP — categorize a too-large tick as skipped-capped (needs attention),
      // distinct from a failure. swapCapUsdc() throws on a garbled env → fail-closed skip. The
      // hard enforcement still happens inside executeAction; this is only for a precise outcome. ──
      let cap;
      try { cap = swapCapUsdc(); } catch (e) {
        await record(m, key, period, OUTCOME.SKIPPED_BLOCKED, { reason: `cap unreadable: ${e.message}` });
        continue;
      }
      if (fillValueUsdc > cap) {
        await record(m, key, period, OUTCOME.SKIPPED_CAPPED, {
          reason: `per-swap ≈ ${fillValueUsdc.toFixed(2)} USDC exceeds the ${cap} USDC cap`,
          patch: { needsAttention: true },
        });
        continue;
      }

      // ── 4. YIELD TO THE USER — fire only if it leaves the user room to act (reserves
      // ceiling×reserve for them). Reads the same per-user day total the hard ceiling uses. ──
      const yield_ = await yieldsToUser({ owner: m.walletAddress, fillValueUsdc, at: now });
      if (!yield_.ok) { await record(m, key, period, OUTCOME.SKIPPED_CEILING, { reason: yield_.reason }); continue; }

      // ── 5. FUNDS — an underfunded wallet is a retryable SKIP (may get funded), never a
      // mandate-killing failure. Balance read is withRetry-wrapped; a throttle on it → skip. ──
      let inBal;
      try { inBal = await readTokenBalance(m.tokenIn, m.walletAddress); } catch (e) {
        await record(m, key, period, OUTCOME.SKIPPED_BLOCKED, { reason: `balance unreadable: ${e.message}` });
        continue;
      }
      if (inBal < m.perTickAmount) {
        await record(m, key, period, OUTCOME.SKIPPED_FUNDS, {
          reason: `have ${inBal.toFixed(2)} ${m.tokenIn}, need ${m.perTickAmount}`,
          patch: { needsAttention: true },
        });
        continue;
      }

      // ── 6. IDEMPOTENCY — claim (mandate, period) BEFORE the swap. If a claim already exists and
      // is NOT still "claimed" (i.e. it's "submitted" or resolved), another invocation already
      // acted on this period → skip (no double-spend, no double-submit). A "claimed" claim is a
      // prior attempt that died before submit → retry. This same guard closes the submit→reconcile
      // gap: a fill in flight persists as status:"submitted", so a concurrent tick cannot re-submit
      // it. (Netlify Blobs supports CAS via getWithEtag/setIfMatch if the race ever proves real;
      // read-before-write is adequate for one cron invoker per minute.) ──
      const claimKey = fillClaimKey(m.id, period);
      const existingClaim = await fills.get(claimKey, { type: "json" }).catch(() => null);
      if (existingClaim && existingClaim.status !== "claimed") {
        beat.skipped++; beat.details.push({ id: m.id, outcome: "already-recorded-this-period" });
        continue;
      }
      await fills.setJSON(claimKey, { mandateId: m.id, period, status: "claimed", claimedAt: startedAt });

      // ── 7. SNAPSHOT the block height immediately BEFORE submit — the tight lower bound of the
      // log-scan window the reconcile uses to witness THIS fill unambiguously. A read failure here
      // is a fail-closed skip (we won't submit a swap we then can't witness). ──
      let snapshotBlock;
      try { snapshotBlock = Number(await publicClient().getBlockNumber()); } catch (e) {
        await record(m, key, period, OUTCOME.SKIPPED_BLOCKED, { reason: `cannot read block height: ${e.message}` });
        continue;
      }

      // ── 8. SUBMIT — via executeAction, NEVER agentSwap directly. Inherits pause + cap +
      // day-ceiling + ledger. Its ok:true means SUBMITTED, not confirmed. ──
      let result, threw = null;
      try {
        result = await executeAction(
          { type: "swap_tokens", tokenIn: m.tokenIn, tokenOut: m.tokenOut, amountIn: m.perTickAmount, reasoning: `DCA mandate ${m.id}` },
          { walletAddress: m.walletAddress } // no session — executeAction keys guards on walletAddress
        );
      } catch (e) { threw = e; }

      if (result?.ok) {
        // ── SUBMITTED — not yet confirmed. Record DCA's daily share now (mirrors executeAction's
        // own hard-ceiling ledger, which also records at submit), but DO NOT touch spentAmount:
        // the mandate budget advances only when reconcile witnesses the fill on-chain. Persist the
        // pending claim with everything reconcile needs (block window + any event hash), and mark
        // the mandate PENDING_CONFIRM with a pointer to the period awaiting confirmation. ──
        await recordDcaSpend({ owner: m.walletAddress, amountUsdc: fillValueUsdc, at: now }).catch(() => {});
        await fills.setJSON(claimKey, {
          mandateId: m.id,
          period,
          status: "submitted",
          snapshotBlock,
          eventTxHash: result.swap?.txHash || null,
          submittedAt: startedAt,
        });
        await patchMandate(m, key, OUTCOME.PENDING_CONFIRM, {
          reason: "swap submitted — awaiting on-chain confirmation",
          patch: { pendingPeriod: period },
          period,
        });
        continue;
      }

      if (!threw) {
        // executeAction refused (its own guard — hard ceiling, shape, a pause that flipped
        // mid-tick). A policy refusal, NOT a broken swap: record verbatim, retry next period, do
        // NOT count it toward the failure limit and do NOT advance the period.
        await record(m, key, period, OUTCOME.SKIPPED_BLOCKED, { reason: result?.blocked || "blocked" });
        continue;
      }

      // The swap THREW — classify with the shared isTransient (reused, not new).
      if (classifyFillError(threw) === "transient") {
        const consecutiveFailures = (m.consecutiveFailures || 0) + 1;
        // Stamp the START of the streak on the first failure; the window is measured from there.
        const firstFailureAt = m.firstFailureAt || startedAt;
        const spanMs = now - Date.parse(firstFailureAt);
        // Stop on EITHER trigger, whichever comes first: N-in-a-row (a fast burst of throttles) OR
        // a streak that has now spanned more than 24h (a slow-cadence mandate that's been failing
        // for a day). A single throttle trips neither; a healthy mandate that fills resets both.
        const hitCount = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        const hitWindow = spanMs > FAILURE_WINDOW_MS;
        if (hitCount || hitWindow) {
          const why = hitCount
            ? `${consecutiveFailures} consecutive transient failures`
            : `transient failures spanning >${Math.round(spanMs / 3600000)}h`;
          await record(m, key, period, OUTCOME.STOPPED_FAILED, {
            reason: `stopped after ${why} — last: ${threw.message}`,
            patch: { status: STATUS.STOPPED_FAILED, stoppedAt: startedAt, consecutiveFailures, firstFailureAt, needsAttention: true },
          });
        } else {
          // Within both thresholds — skip, retry next period. A single Arc throttle must not kill
          // a healthy mandate. Do NOT advance lastFilledPeriod; carry the streak + its start time.
          await record(m, key, period, OUTCOME.FAILED_TRANSIENT, {
            reason: `transient (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}, ${Math.round(spanMs / 3600000)}h): ${threw.message}`,
            patch: { consecutiveFailures, firstFailureAt },
          });
        }
      } else {
        // Genuine failure (slippage, revert, anything isTransient doesn't recognise) — STOP on
        // the first occurrence. A persistently-broken DCA must not pretend to run forever.
        await record(m, key, period, OUTCOME.STOPPED_FAILED, {
          reason: `stopped on genuine failure: ${threw.message}`,
          patch: { status: STATUS.STOPPED_FAILED, stoppedAt: startedAt, needsAttention: true },
        });
      }
    }
  } catch (e) {
    beat.errors++;
    beat.note = `tick error (partial): ${e.message}`;
  }

  await writeHeartbeat();
  return { statusCode: 200, body: JSON.stringify({ scanned: beat.scanned, submitted: beat.submitted, fired: beat.fired, skipped: beat.skipped, failed: beat.failed, stopped: beat.stopped }) };
}
