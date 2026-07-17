import { connectLambda, getStore } from "@netlify/blobs";
import { executeAction } from "./_actions.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { AGENT } from "./_agents.mjs";
import { swapCapUsdc } from "./_arc.mjs";
import { valueInUsdc } from "./_swap.mjs";
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
} from "./_dca.mjs";

// dca-tick.mjs — THE DCA SCHEDULER. Runs every minute; fills due mandates autonomously.
//
// This is the one place in Tikpema that moves money with NO user present. The ordering is
// load-bearing; do not reorder:
//
//   heartbeat(always) · per due mandate:
//     PAUSE(fail-closed) → value → CAP → YIELD-to-user → FUNDS → idempotency-claim → FILL
//
// Every skip category is recorded as a durable OUTCOME so "is my DCA working?" is answerable and
// a failure never reads as success. The FILL routes through executeAction (never agentSwap
// directly), so it inherits the SAME swapCapUsdc + pause + day-ceiling + ledger a manual swap
// obeys. The pre-checks above categorize skips precisely (so insufficient-funds is a retryable
// SKIP, not a mandate-killing failure); only a THROWN fill error reaches the transient/genuine
// classifier.
//
// ⚠️ Schedule registered in netlify.toml ([functions."dca-tick"]); the in-code config is
// documentation (the CLI deploy did not pick up job-sweep's, so netlify.toml is authoritative).
export const config = { schedule: "* * * * *" };

const MAX_FILLS_PER_TICK = 8; // bound work per invocation; excess pages to the next minute

export async function handler(event) {
  if (event?.blobs) connectLambda(event);
  const startedAt = new Date().toISOString();
  const now = Date.now();

  // ── UNCONDITIONAL HEARTBEAT — written every invocation regardless of work (the job-sweep
  // blind-spot fix: a quiet cron must be distinguishable from a dead one by reading ONE blob).
  const beat = { tickAt: startedAt, scanned: 0, fired: 0, skipped: 0, failed: 0, stopped: 0, terminal: 0, errors: 0, details: [] };
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

  // Record one durable outcome: update the mandate (with any patch), append to its recent
  // outcomes (capped), write the per-(mandate,period) fill record, and tally the heartbeat.
  const record = async (m, key, period, outcome, { reason = null, tx = null, patch = {} } = {}) => {
    const entry = { period, outcome, reason, tx, at: startedAt };
    const recentOutcomes = [entry, ...(m.recentOutcomes || [])].slice(0, 5);
    const next = { ...m, ...patch, recentOutcomes, lastOutcome: outcome, lastOutcomeAt: startedAt, lastReason: reason };
    await mandates.setJSON(key, next);
    await fills.setJSON(fillClaimKey(m.id, period), { mandateId: m.id, period, outcome, reason, tx, at: startedAt });
    if (outcome === OUTCOME.SWAPPED) beat.fired++;
    else if (outcome === OUTCOME.STOPPED_FAILED) beat.stopped++;
    else if (outcome === OUTCOME.FAILED_TRANSIENT) beat.failed++;
    else beat.skipped++;
    beat.details.push({ id: m.id, outcome, ...(tx ? { tx } : {}), ...(reason ? { reason: String(reason).slice(0, 80) } : {}) });
  };

  try {
    const { blobs } = await mandates.list({ prefix: "mandate:" });
    for (const { key } of blobs) {
      if (beat.fired >= MAX_FILLS_PER_TICK) break; // page remaining mandates to next tick
      const m = await mandates.get(key, { type: "json" }).catch(() => null);
      if (!m || m.status !== STATUS.ACTIVE) continue;
      beat.scanned++;

      const decision = evaluate(m, now);

      // Terminal (budget spent / past end date) — persist and stop. Not a fill event: no claim.
      if (decision.terminal) {
        await mandates.setJSON(key, { ...m, status: decision.terminal, closedAt: startedAt, lastReason: decision.reason });
        beat.terminal++;
        continue;
      }
      if (!decision.due) continue; // not this period
      const period = decision.period;

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

      // ── 6. IDEMPOTENCY — claim (mandate, period) BEFORE the swap. If a non-"claimed" record
      // already exists, another invocation already resolved this period → skip (no double-spend).
      // This is a read-before-write claim; `lastFilledPeriod` (checked in evaluate) is the second
      // guard. (Netlify Blobs DOES support CAS via getWithEtag/setIfMatch — see _budget casUpdate —
      // so this could be made strictly atomic if the race ever proves real; the read-before-write
      // is adequate for one cron invoker per minute.) ──
      const claimKey = fillClaimKey(m.id, period);
      const existingClaim = await fills.get(claimKey, { type: "json" }).catch(() => null);
      if (existingClaim && existingClaim.status !== "claimed") {
        beat.skipped++; beat.details.push({ id: m.id, outcome: "already-recorded-this-period" });
        continue;
      }
      await fills.setJSON(claimKey, { mandateId: m.id, period, status: "claimed", claimedAt: startedAt });

      // ── 7. THE FILL — via executeAction, NEVER agentSwap directly. Inherits pause + cap +
      // day-ceiling + ledger. CRASH WINDOW (bounded): die after the swap lands but before the
      // record below → spentAmount undercounts by one tick → at most ONE extra fill over the
      // mandate's life, itself capped and ceiling-bound. Documented, acceptable. ──
      let result, threw = null;
      try {
        result = await executeAction(
          { type: "swap_tokens", tokenIn: m.tokenIn, tokenOut: m.tokenOut, amountIn: m.perTickAmount, reasoning: `DCA mandate ${m.id}` },
          { walletAddress: m.walletAddress } // no session — executeAction keys guards on walletAddress
        );
      } catch (e) { threw = e; }

      if (result?.ok) {
        // Success — advance the period, decrement the mandate budget, increment DCA's daily share
        // (the parallel per-owner counter the yield rule reads), and RESET the failure streak:
        // consecutiveFailures = 0 AND firstFailureAt = null, so a healthy mandate that throttled
        // once and then filled starts its streak fresh. Also clears needsAttention.
        const spentAmount = Number((m.spentAmount + m.perTickAmount).toFixed(6));
        await recordDcaSpend({ owner: m.walletAddress, amountUsdc: fillValueUsdc, at: now }).catch(() => {});
        await record(m, key, period, OUTCOME.SWAPPED, {
          tx: result.tx || result.swap?.txHash || null,
          patch: {
            spentAmount,
            lastFilledPeriod: period,
            lastFillAt: startedAt,
            lastFillTx: result.tx || null,
            consecutiveFailures: 0,
            firstFailureAt: null,
            needsAttention: false,
          },
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
  return { statusCode: 200, body: JSON.stringify({ scanned: beat.scanned, fired: beat.fired, skipped: beat.skipped, failed: beat.failed, stopped: beat.stopped }) };
}
