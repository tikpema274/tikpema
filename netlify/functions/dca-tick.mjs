import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { executeAction } from "./_actions.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { AGENT } from "./_agents.mjs";
import { swapCapUsdc } from "./_arc.mjs";
import { valueInUsdc } from "./_swap.mjs";
import { circle } from "./_circle.mjs";
// NOTE: confirmSwapLanded (_swap-confirm log-scan / PATH 2) is NO LONGER imported here — the DCA reconcile
// now confirms by authoritative Circle tx id (getTransaction). _swap-confirm.mjs stays for its OTHER
// consumer, job-swap-receipt-background (the research→swap verifier). See reconcilePending below.
import { recordDcaSpend, recordAgentSpend, reverseChargeById } from "./_budget.mjs";
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
  CONFIRM_RPC_TIMEOUT_MS,
  MAX_RECONCILES_PER_TICK,
  MAX_PENDING_AGE_MS,
} from "./_dca.mjs";
import { isBlobsTransient } from "./_retry.mjs";

// dca-tick.mjs — THE DCA SCHEDULER. Runs every minute; fills due mandates autonomously.
//
// This is the one place in Tikpema that moves money with NO user present. The ordering is
// load-bearing; do not reorder:
//
//   heartbeat(always) · per mandate:
//     RECONCILE any in-flight fill · else if due:
//       PAUSE(fail-closed) → value → CAP → YIELD-to-user → FUNDS → idempotency-claim → SUBMIT
//
// ⚠️ SUBMIT NOW MEANS LANDED (Drill #1, inline-confirm). agentSwap runs the B1 execute path and
// waits for the Circle tx to reach COMPLETE (waitForTx) BEFORE executeAction returns ok — so a
// swap that "submitted" this tick has already been witnessed on-chain by the authoritative Circle
// tx id, not App Kit's async 1098-quirk hash. spentAmount therefore advances in the SAME ok-branch
// as the confirm (below), gated on the chain saying yes. A phantom fill (spentAmount up + nothing
// on-chain) stays structurally impossible: a swap that does not confirm THROWS, and the throw
// short-circuits before any ledger runs. (PATH 2 — the old two-legged confirmSwapLanded log-scan
// reconcile — is now vestigial for DCA; it survives only to drain legacy in-flight fills and for
// the SHARED job-swap-receipt-background verifier. See the ok-branch note below.)
//
// Every skip/outcome is a durable OUTCOME so "is my DCA working?" is answerable and a failure
// never reads as success. The SUBMIT routes through executeAction (never agentSwap directly), so
// it inherits the SAME swapCapUsdc + pause + day-ceiling + ledger a manual swap obeys.
//
// ⚠️ Schedule registered in netlify.toml ([functions."dca-tick"]); the in-code config is
// documentation (the CLI deploy did not pick up job-sweep's, so netlify.toml is authoritative).
export const config = { schedule: "* * * * *" };

// Bound the EXPENSIVE work per invocation so the tick stays within budget. A new submit is now the
// heaviest item — it INLINE-CONFIRMS (approve-wait + swap-wait to COMPLETE), so keep MAX_SUBMITS_PER_TICK
// small. Reconciles are now cheap id lookups (getTransaction, a fast Circle API call — no throttled RPC
// log-scan), but stay bounded (MAX_RECONCILES_PER_TICK, each timed out at CONFIRM_RPC_TIMEOUT_MS) so a
// burst can't age the request-scoped Blobs token out mid-tick; a capped-out reconcile DEFERS (pointer
// stays → next tick), so a fill is delayed, never starved forever.
// ⚠️ RE-PROVE: with inline-confirm, a tick of 3 submits can block on up to 6 waitForTx (3 approve + 3 swap).
// Confirm the scheduled-function budget absorbs that under Arc latency, or lower MAX_SUBMITS_PER_TICK.
const MAX_SUBMITS_PER_TICK = 3;

// ═══ 🚨 A LEDGER WRITE THAT FAILS AFTER A CONFIRMED FILL ═══════════════════════════════════════
//
// These writes used to be `.catch(() => {})`. The fill is already on-chain by the time they run, so
// a swallowed failure meant: MONEY MOVED AND NOTHING COUNTED IT. `recordAgentSpend` is the DAY
// CEILING, so every later spend — not just DCA's — would be measured against an understated total.
// A widened cap, arriving silently, in the path whose own comment says all three ledgers must
// advance here.
//
// ⚠️ BUT SIMPLY REMOVING THE CATCH WOULD BE WORSE. Neither write is idempotent (`recordAgentSpend`
// does a CAS increment AND appends an audit entry). Throwing would skip the mandate patch below, so
// `pendingPeriod` stays set, the next tick re-reconciles, `getTransaction` returns COMPLETE again —
// and whichever write SUCCEEDED gets applied a second time. Under-count traded for double-count.
//
// ⭐ SO: ALWAYS COMPLETE THE PATCH (no re-reconcile, no double-count), and make the failure
// FAIL-CLOSED ON THE FUTURE instead. The past fill cannot be un-spent; the NEXT one can be
// prevented. A mandate whose ledger write failed goes STOPPED_FAILED, which `evaluate()` enforces
// via `status !== ACTIVE`.
//
// ⚠️ `needsAttention` ALONE WOULD NOT DO IT — nothing gates on that flag; it is for humans and the
// UI. Set it too, but the STATUS is what actually stops the next fill.
//
// This bounds the damage; it does NOT repair the counter. One fill stays uncounted and a human must
// reconcile it — which is why the reason string carries the amount and the ids.
export async function runLedgerWrites(writes) {
  const failed = [];
  for (const [name, run] of writes) {
    try {
      await run();
    } catch (err) {
      failed.push(`${name} (${String(err?.message || err?.name || "error").slice(0, 120)})`);
    }
  }
  return { ok: failed.length === 0, failed };
}

/** The patch fields that turn a confirmed-but-unledgered fill into a stopped, visible one. */
export const ledgerFailurePatch = (failed) => ({
  status: STATUS.STOPPED_FAILED,
  stoppedAt: Date.now(),
  needsAttention: true,
  ledgerUnrecorded: failed,
});

// ═══ 🚧 WHAT THIS TICK DOES WHILE CREATE IS GATED — A DECISION, NOT A SIDE EFFECT ════════════
// dca-create is gated (CREATE_GATED, _dca.mjs). ⭐ THE TICK IS DELIBERATELY UNCHANGED: it KEEPS
// FILLING any mandate that is already ACTIVE.
//
// The gate blocks NEW authorizations. An existing mandate is money the user already committed to,
// under a consent block they read and acknowledged — refusing to honour it would be the gate
// reaching past its purpose, and would strand a schedule the user can still SEE in the panel but
// would silently no longer have served. The honest way to end a mandate is Cancel, which is theirs
// and is never gated.
//
// ⚠️ RECORDED BECAUSE IT WOULD OTHERWISE BE INVISIBLE: zero ACTIVE mandates existed when the gate
// went in (2026-08-21), so this rule changes nothing observable today. It is written for the case
// where one does exist — and so that "the tick still fills" is never mistaken for an oversight in
// where the gate happened to sit.
export async function handler(event) {
  if (event?.blobs) connectBlobs(event);
  const startedAt = new Date().toISOString();
  const now = Date.now();

  // ── TOKEN-EXP DIAGNOSTIC (observability only; logs NO secret) — decode the injected Blobs token's
  // expiry to learn whether the scheduled-function token arrives NEAR-DEAD (so bounding can never be
  // enough → a long-lived credential is eventually unavoidable) or only dies UNDER LONG WORK (so the
  // code-only bounding below is the permanent fix). Best-effort: a malformed token must never break
  // the tick, and only the derived deltas — never the token itself — are written to the heartbeat.
  const tokenExp = (() => {
    try {
      if (!event?.blobs) return { note: "no event.blobs (local dev / http path)" };
      const ctx = JSON.parse(Buffer.from(event.blobs, "base64").toString("utf8"));
      const seg = String(ctx.token || "").split(".")[1]; // JWT payload segment
      if (!seg) return { note: "token not a decodable JWT" };
      const payload = JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      if (!payload.exp) return { note: "JWT has no exp" };
      return {
        remainingAtStartMs: payload.exp * 1000 - now,
        totalTtlMs: payload.iat ? (payload.exp - payload.iat) * 1000 : null,
      };
    } catch (e) { return { note: `decode failed: ${e.message}` }; }
  })();

  // Slow (chain-witnessing) reconciles run this invocation. Bounded per tick so a burst of throttled
  // confirms can't age the Blobs token out; the rest DEFER (pointer stays → next tick re-checks).
  let slowReconciles = 0;

  // ── UNCONDITIONAL HEARTBEAT — written every invocation regardless of work (the job-sweep
  // blind-spot fix: a quiet cron must be distinguishable from a dead one by reading ONE blob).
  const beat = { tickAt: startedAt, tokenExp, total: 0, inactive: 0, reconciledInactive: 0, unresolvable: 0, unreadable: 0, scanned: 0, submitted: 0, fired: 0, skipped: 0, failed: 0, stopped: 0, terminal: 0, notDue: 0, deferred: 0, errors: 0, details: [] };
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

  // ── RECONCILE an in-flight fill. NOW REACHED ONLY when inline-confirm TIMED OUT at submit (agentSwap
  // threw SwapPendingConfirm, handing us the swap's circleId) — the slow-but-maybe-real fill. THE ONLY
  // PLACE spentAmount advances for such a fill. Confirmation is now ID-BASED: poll the AUTHORITATIVE
  // Circle tx state via getTransaction({id}), NOT an RPC log-scan. This is throttle-free (Circle API, not
  // the rate-limited public RPC) and unambiguous (a tx id is unique — sibling-fill ambiguity is gone), so
  // it REPLACES PATH 2 (confirmSwapLanded) for DCA. _swap-confirm.mjs is untouched — job-swap-receipt-
  // background still uses it. COMPLETE → advance all three ledgers + record swapped. FAILED/CANCELLED/DENIED
  // → stop. Unreachable / still non-terminal within grace → leave pending (never fail a fill we couldn't read). ──
  const RECONCILE_TERMINAL_FAIL = new Set(["FAILED", "CANCELLED", "DENIED"]);
  const reconcilePending = async (m, key) => {
    const period = m.pendingPeriod;
    const claim = await fills.get(fillClaimKey(m.id, period), { type: "json" }).catch(() => null);
    // ── Defensive: the claim vanished, is no longer 'submitted', or carries NO circleId ──────
    // ⚠️ THE circleId CASE IS NOT HYPOTHETICAL AND IT IS NOT AN ERROR. Measured on prod
    // 2026-08-22: FOUR cancelled mandates carry a live pendingPeriod whose claims are the
    // PRE-REFACTOR GENERATION — `snapshotBlock`/`eventTxHash` from 2026-07-18/19, written before
    // claims carried a Circle id. _budget.mjs's generational-boundary rule governs them: an entry
    // with no authoritative id is PERMANENTLY UNRESOLVABLE, and a reconcile must SKIP AND REPORT
    // it — never guess an outcome, because guessing reverses or charges for a swap whose fate
    // nobody observed. Dropping the pointer is the skip: it stops a mandate being re-examined
    // forever with no possible progress. NO ledger write and no Circle call happen here.
    //
    // 🚨 IT USED TO DROP THE POINTER IN COMPLETE SILENCE — no tally, no beat counter, no reason on
    // the mandate. That was tolerable while the branch was unreachable for non-ACTIVE mandates;
    // moving the reconcile above the ACTIVE gate made it the FIRST thing that would happen to
    // those four real records, and a silent mutation of production data is exactly the shape this
    // codebase keeps paying for. An absence must not be resolved invisibly.
    if (!claim || claim.status !== "submitted" || !claim.circleId) {
      const why = !claim ? "claim missing"
        : claim.status !== "submitted" ? `claim already ${claim.status ?? "resolved"}`
        : "claim carries NO circleId (pre-refactor generation) — permanently unresolvable, never guessed";
      beat.unresolvable++;
      await patchMandate(m, key, OUTCOME.PENDING_DROPPED, {
        reason: `pending pointer dropped without ledgering: ${why}`,
        period,
        patch: { pendingPeriod: null },
      });
      return;
    }

    // Bound reconciles per tick so a burst can't age the Blobs token out mid-tick; the rest DEFER.
    if (slowReconciles >= MAX_RECONCILES_PER_TICK) {
      beat.deferred++;
      beat.details.push({ id: m.id, outcome: "deferred-reconcile-cap" });
      return;
    }
    slowReconciles++;

    // AUTHORITATIVE confirm by Circle tx id, hard-timed-out so a slow API call can't hang the tick. A throw
    // here = "couldn't LOOK" (lookErr), NOT "did not land" — governed by the pending-AGE logic below.
    let state = null, txHash = null, lookErr = null;
    try {
      const { data } = await Promise.race([
        circle().getTransaction({ id: claim.circleId }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("getTransaction timeout")), CONFIRM_RPC_TIMEOUT_MS)),
      ]);
      state = data?.transaction?.state ?? null;
      txHash = data?.transaction?.txHash ?? null;
    } catch (e) { lookErr = e; }

    if (state === "COMPLETE") {
      // ── CONFIRMED (slow path) — advance the budget now, and ONLY now. Because executeAction NEVER
      // ledgered this fill (agentSwap threw SwapPendingConfirm on the inline timeout, short-circuiting
      // ledger()), ALL THREE ledgers must advance HERE: spentAmount + recordDcaSpend + the day-ceiling
      // recordAgentSpend that would otherwise have fired inside executeAction. Value = the amount captured
      // at submit (no re-price). Exactly-once: a period confirms EITHER inline OR here, never both. ──
      const fillValueUsdc = Number(claim.fillValueUsdc);
      const spentAmount = Number((m.spentAmount + m.perTickAmount).toFixed(6));
      // confirmation:"confirmed" — this branch runs ONLY after getTransaction({id}) returned COMPLETE,
      // so the chain has witnessed it. Distinct from a manual submit-time entry, which records "submitted".
      // circleId recorded for PROVENANCE, not for reversal: this entry is "confirmed", and the step-8
      // sweeper selects ONLY "submitted" entries. It must never touch a confirmed DCA fill — reversing
      // one would decrement the day counter while recordDcaSpend above stayed put, desyncing the pair
      // in the fail-OPEN direction.
      // Both ledgers, failures CAPTURED not swallowed. Order preserved: the DCA sub-ledger first,
      // then the day ceiling — the one whose loss widens the global cap.
      // ── ⚠️ MEASURED ON A DRAFT 2026-08-22 — THE THREE COUNTERS ARE NOT EQUALLY PROTECTED ──────
      // A re-reconcile of the SAME fill (which happens when a tick crashes between these writes and
      // the patch below, leaving pendingPeriod set) was driven twice against real Netlify Blobs:
      //     day ceiling  0.05 -> 0.05   ⭐ SUPPRESSED by chargeId, and only ONE audit row was written
      //     dca-day      0.05 -> 0.10   doubled
      //     spentAmount  0.05 -> 0.10   doubled
      // 🚨 SO DO NOT READ `chargeId` AS "THE RECONCILE IS IDEMPOTENT". Only the DAY CEILING is.
      // The doubling of the other two PRE-DATES this change — the note below has always said a
      // re-reconcile "re-applies whichever write succeeded" — and its direction is over-count,
      // i.e. narrowing, which is the safe one. It is recorded here because adding idempotency to
      // ONE of three counters makes the other two look protected by association, and the next
      // reader would have no reason to check.
      // ⭐ Closing it means giving recordDcaSpend and the mandate patch the same id-membership
      // treatment — NOT moving them to submit time, which is the pairing the _budget.mjs
      // precondition forbids without triple-semantics reversal first.
      const led = await runLedgerWrites([
        ["recordDcaSpend", () => recordDcaSpend({ owner: m.walletAddress, amountUsdc: fillValueUsdc, at: now })],
        // ⭐⭐ `chargeId` — SINCE 2026-08-22 THIS IS USUALLY A NO-OP, AND THAT IS THE POINT. The
        // submit branch already charged the day ceiling under this same id, so the membership test
        // inside recordAgentSpend's CAS suppresses this one. It is still CALLED rather than
        // skipped, because a fill can reach here WITHOUT a submit-time charge — the inline-confirm
        // path never goes through that branch, and a submit-time charge can have failed. Calling
        // unconditionally with an idempotency key covers both without the caller having to know
        // which happened. ⚠️ `alreadyCharged` is a SUCCESS, not a ledger failure.
        ["recordAgentSpend(day-ceiling)", () => recordAgentSpend({ agent: AGENT.EXECUTOR, owner: m.walletAddress, amountUsdc: fillValueUsdc, source: "swap_tokens", justification: `DCA mandate ${m.id}`, at: now, confirmation: "confirmed", circleId: claim.circleId, chargeId: claim.circleId })],
      ]);
      await patchMandate(m, key, led.ok ? OUTCOME.SWAPPED : OUTCOME.STOPPED_FAILED, {
        reason: led.ok
          ? `confirmed by id-reconcile (circleId ${claim.circleId})`
          : `FILLED BUT NOT LEDGERED — ${fillValueUsdc} USDC moved on-chain (circleId ${claim.circleId}, tx ${txHash ?? "?"}) and these ledger writes FAILED: ${led.failed.join("; ")}. The mandate is STOPPED so no further fill is measured against an understated counter. A human must reconcile the missing amount.`,
        tx: txHash, period,
        patch: {
          spentAmount,
          lastFilledPeriod: period,
          lastFillAt: claim.submittedAt,
          lastFillTx: txHash,
          pendingPeriod: null,
          consecutiveFailures: 0,
          firstFailureAt: null,
          consecutiveUnconfirmed: 0,
          // ⭐ ALWAYS patched, ledger success or not — leaving pendingPeriod set would re-reconcile
          // next tick and re-apply whichever write succeeded.
          // ⚠️ AND THE STATUS HALF IS STRIPPED FOR A NON-ACTIVE MANDATE, for the same reason as the
          // terminal-fail branch below: since the reconcile moved above the ACTIVE gate this can
          // reach a mandate the USER CANCELLED, and ledgerFailurePatch sets status:"stopped-failed"
          // — rewriting their decision as our failure. `needsAttention` and `ledgerUnrecorded` are
          // kept either way: the money problem must stay visible even when the status must not move.
          ...(led.ok
            ? { needsAttention: false }
            : m.status === STATUS.ACTIVE
              ? ledgerFailurePatch(led.failed)
              : (({ status, stoppedAt, ...rest }) => rest)(ledgerFailurePatch(led.failed))),
        },
      });
      await resolveClaim(m.id, period, OUTCOME.SWAPPED, { reason: "confirmed by id-reconcile", tx: txHash });
      return;
    }

    // A FAILED/CANCELLED/DENIED tx is a genuine failure — the revert reverts state, so no funds moved. Stop
    // the mandate on the first occurrence, exactly like a slippage/genuine failure.
    if (state && RECONCILE_TERMINAL_FAIL.has(state)) {
      const reason = `swap ${state.toLowerCase()} (circleId ${claim.circleId})`;

      // ── 🚨🚨 GIVE THE BUDGET BACK — THE OTHER HALF OF CHARGING AT SUBMIT (2026-08-22) ────────
      // The submit branch charged the day ceiling for a swap that has now been WITNESSED to fail.
      // Design §1.4: only a POSITIVE on-chain observation that no funds moved may return budget,
      // and this is one — getTransaction({id}) returned a terminal failure state. "I could not
      // look" never reaches here; that path leaves the charge standing.
      //
      // ⭐ THIS RUNNER IS WHY THE CHARGE IS SAFE TO MAKE. Design §2 warned that decrement-at-submit
      // CREATES a reversal surface that did not exist before, and that a convergence guarantee is
      // only as real as the runner that closes it. This is that runner, at the root. budget-sweep
      // is the defence-in-depth behind it — but its reversals are DISARMED, so it would observe
      // this and leave the charge standing. ⚠️ It must not be mistaken for the primary handler here.
      //
      // ⭐ reverseChargeById distinguishes a BENIGN miss (already reversed or resolved) from an
      // ANOMALOUS one (no charge AND no marker). Anomalous is NOT treated as "nothing to do":
      // it means the entry we expected is missing, and guessing an outcome for it is the
      // absence-reads-as-safe family in the fail-open direction. It raises needsAttention instead.
      const rev = await reverseChargeById({ circleId: claim.circleId, reason, at: now });

      await patchMandate(m, key, OUTCOME.STOPPED_FAILED, {
        reason: rev.anomalous
          ? `${reason} — ⚠️ AND THE SUBMIT-TIME CHARGE COULD NOT BE FOUND to reverse (no charge and no marker for circleId ${claim.circleId}). The day ceiling may still carry an amount for a swap that failed. A human must check.`
          : reason,
        period,
        // ⚠️ status is set ONLY from ACTIVE. Reconcile now runs above the ACTIVE gate, so this can
        // reach a mandate the user already CANCELLED — and overwriting that with stopped-failed
        // would rewrite their decision as our failure. The money still reconciles either way.
        patch: {
          ...(m.status === STATUS.ACTIVE ? { status: STATUS.STOPPED_FAILED, stoppedAt: startedAt } : {}),
          pendingPeriod: null,
          needsAttention: true,
        },
      });
      await resolveClaim(m.id, period, OUTCOME.STOPPED_FAILED, { reason });
      return;
    }

    // Couldn't READ Circle this tick (lookErr) — NOT a "did not land". A YOUNG fill: leave pending, consume
    // no grace; next tick re-checks. A fill UNREADABLE for longer than MAX_PENDING_AGE_MS falls through to
    // unconfirmed handling below (budget intact, needsAttention). A false-unconfirmed only asks a human to
    // look; a false-confirm is the sin this design exists to prevent.
    if (lookErr && now - Date.parse(claim.submittedAt) < MAX_PENDING_AGE_MS) return;

    // Non-terminal (INITIATED/QUEUED/SENT/…) or read-failed-and-old. Inside the grace window, keep it pending
    // (a healthy-but-slow tx just hasn't finalized). Past grace, declare it unconfirmed — BUDGET INTACT — and
    // count it toward the consecutive-unconfirmed stop.
    const ageMs = now - Date.parse(claim.submittedAt);
    if (ageMs < CONFIRM_GRACE_MS) return;

    const consecutiveUnconfirmed = (m.consecutiveUnconfirmed || 0) + 1;
    const detail = lookErr
      ? `Circle tx unreadable for >${Math.round(ageMs / 60000)}m — escalating for review`
      : `tx still ${state ?? "pending"} >${Math.round(CONFIRM_GRACE_MS / 1000)}s after submit — escalating for review`;

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
      // ⭐ COUNT WHAT WE SKIPPED, or `scanned:0` is ambiguous. On 2026-08-13 a heartbeat read
      // `scanned:0` and there was no way to tell "the store is empty" from "seven mandates exist and
      // all are cancelled" — two very different facts behind one number. `total` and `inactive`
      // separate them, and `unreadable` keeps a failed GET from masquerading as either.
      beat.total++;
      if (!m) { beat.unreadable++; continue; }

      // ── ⭐⭐ THE RECONCILE GATE SITS ABOVE THE ACTIVE GATE (design §2(a), 2026-08-22) ─────────
      // 🚨 THIS ORDER IS REQUIRED BY THE SUBMIT-TIME CHARGE, NOT A TIDY-UP. Previously a mandate
      // that went non-ACTIVE while a fill was in flight — the user cancels, or a ledger write
      // stopped it — was skipped here forever, and its pendingPeriod was never reconciled. That
      // cost nothing while nothing was charged at submit. Now a charge EXISTS for that fill, so
      // skipping it would strand a day-ceiling charge PERMANENTLY, with no runner able to reverse
      // it: dca-tick could not reach it, and budget-sweep's reversals are DISARMED. That is a
      // permanent phantom charge — precisely the class step 8 was built to remove.
      // ⭐ So: pendingPeriod is reconciled REGARDLESS of status. The money is settled either way;
      // only the mandate's own lifecycle respects the status (see the patches in reconcilePending,
      // which set `status` only when it is still ACTIVE).
      const hasPending = m.pendingPeriod != null;
      if (m.status !== STATUS.ACTIVE) {
        if (!hasPending) { beat.inactive++; continue; }
        beat.reconciledInactive++;   // counted separately: a fill settling on a mandate that is over
      } else {
        beat.scanned++;
      }

      // ── PER-MANDATE BOUNDARY (see the catch at the end of this block). A Blobs write that expired
      // mid-tick DEFERS and retries next tick with a fresh token; any other error is isolated to this
      // one mandate. Neither aborts the loop — the old outer-catch-only structure let the first throw
      // abort every remaining mandate. (Body left at its original indent to keep this diff reviewable.)
      try {

      // ── RECONCILE FIRST — an in-flight fill is settled (or left pending) before anything else,
      // and uncapped, so it can never be starved by the submit budget. One action per mandate per
      // tick: a mandate with a fill in flight neither evaluates nor submits a new one. ──
      if (hasPending) {
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
      // ⭐⭐ NOT-DUE MUST LEAVE A TRACE. This `continue` used to be silent, so a scanned mandate that
      // simply was not due produced `scanned=1` and NOTHING ELSE — indistinguishable from a tick that
      // examined it and inexplicably declined. That is the exact question we could not answer on
      // 2026-08-13. The reason ("already filled this period") is the whole diagnosis.
      // ⚠️ Detail bounded so a wide fan-out cannot flood the heartbeat; the COUNT is always exact.
      if (!decision.due) {
        beat.notDue++;
        if (beat.details.length < 8) beat.details.push({ id: m.id, outcome: "not-due", reason: decision.reason });
        continue;
      }
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

      // (No block snapshot — id-based confirm needs no log-scan window; the old step 7 is gone.)

      // ── 7. SUBMIT — via executeAction, NEVER agentSwap directly. Inherits pause + cap + day-ceiling +
      // ledger. confirmSwap:true asks agentSwap to INLINE-CONFIRM (DCA-only; the tick is scheduled, so it
      // can wait to COMPLETE). Its ok:true therefore means CONFIRMED, not just submitted. An inline-confirm
      // TIMEOUT throws SwapPendingConfirm (carrying the circleId → id-reconcile net); a real failure throws. ──
      let result, threw = null;
      try {
        result = await executeAction(
          { type: "swap_tokens", tokenIn: m.tokenIn, tokenOut: m.tokenOut, amountIn: m.perTickAmount, reasoning: `DCA mandate ${m.id}` },
          { walletAddress: m.walletAddress, confirmSwap: true } // no session; confirmSwap = DCA inline-confirm
        );
      } catch (e) { threw = e; }

      if (result?.ok) {
        // ── CONFIRMED (Drill #1) — agentSwap now INLINE-CONFIRMS: executeAction returns ok:true only
        // AFTER waitForTx(circleId) reached COMPLETE, so ok:true means LANDED, not merely submitted. The
        // three ledgers are therefore all confirm-gated. Advance the mandate budget (spentAmount) AND
        // DCA's daily share (recordDcaSpend) TOGETHER here — both gated on the SAME on-chain confirm — and
        // resolve SWAPPED. No pendingPeriod, no reconcile round-trip. (The day-ceiling recordAgentSpend
        // already fired inside executeAction's own ledger(), post-confirm.)
        //
        // PATH 2 (confirmSwapLanded log-scan) + sibling-fill ambiguity are now DELETED from the DCA path:
        // a slow fill no longer logs-scans — it enters the ID-reconcile net (SwapPendingConfirm branch below).
        // _swap-confirm.mjs is untouched (still used by job-swap-receipt-background, the research→swap verifier).
        const confirmedTx = result.swap?.txHash || null; // the confirmed Arc tx hash from waitForTx
        const spentAmount = Number((m.spentAmount + m.perTickAmount).toFixed(6));
        // ⚠️ NARROWER THAN THE RECONCILE PATH: the day-ceiling recordAgentSpend already fired inside
        // executeAction's own post-confirm ledger(), so only DCA's sub-ledger is at risk here. Still
        // not swallowed — a lost sub-ledger write understates DCA's daily share, and the same
        // stop-the-next-fill rule applies.
        const ledInline = await runLedgerWrites([
          ["recordDcaSpend", () => recordDcaSpend({ owner: m.walletAddress, amountUsdc: fillValueUsdc, at: now })],
        ]);
        await patchMandate(m, key, ledInline.ok ? OUTCOME.SWAPPED : OUTCOME.STOPPED_FAILED, {
          reason: ledInline.ok
            ? `confirmed inline (circleId ${result.swap?.circleId ?? "?"})`
            : `FILLED BUT NOT LEDGERED — ${fillValueUsdc} USDC moved on-chain (circleId ${result.swap?.circleId ?? "?"}, tx ${confirmedTx ?? "?"}) and these ledger writes FAILED: ${ledInline.failed.join("; ")}. The day ceiling WAS recorded by executeAction; DCA's own share was not. Mandate STOPPED pending reconciliation.`,
          tx: confirmedTx,
          period,
          patch: {
            spentAmount,
            lastFilledPeriod: period,
            lastFillAt: startedAt,
            lastFillTx: confirmedTx,
            pendingPeriod: null,
            consecutiveFailures: 0,
            firstFailureAt: null,
            consecutiveUnconfirmed: 0,
            ...(ledInline.ok ? { needsAttention: false } : ledgerFailurePatch(ledInline.failed)),
          },
        });
        await resolveClaim(m.id, period, OUTCOME.SWAPPED, { reason: "confirmed inline", tx: confirmedTx });
        continue;
      }

      // ── SLOW FILL (Drill #2 net) — inline-confirm timed out but the swap IS submitted: agentSwap threw
      // SwapPendingConfirm carrying the authoritative circleId. This is NOT a failure — a slow-but-real fill
      // must never be abandoned un-ledgered. Persist the claim with the circleId + the fill value (so the
      // reconcile can advance all three ledgers on confirm), mark PENDING_CONFIRM, and let next tick's
      // ID-reconcile poll getTransaction({id}).
      // ⚠️ THIS HEADER USED TO END "NOTHING is ledgered here (nothing confirmed yet)". THAT IS NO
      // LONGER TRUE and it described the exact defect unblock condition (1) closed: the DAY CEILING
      // is now charged HERE, at submit. dca-day and spentAmount are still confirm-gated, so "nothing
      // confirmed yet" remains the right instinct for those two — but not for the ceiling. ──
      if (threw?.name === "SwapPendingConfirm") {
        // ── 1. JOURNAL COMMIT (design §1.2). The claim carrying the authoritative circleId is
        //    written BEFORE the charge, so a crash between the two leaves a record naming exactly
        //    what is owed. The reverse order would charge against an id nothing remembers.
        await fills.setJSON(claimKey, {
          mandateId: m.id,
          period,
          status: "submitted",
          circleId: threw.circleId,
          fillValueUsdc, // captured at submit → the reconcile ledgers exactly this on confirm (no re-price)
          submittedAt: startedAt,
        });

        // ── 2. ⭐⭐ CHARGE THE DAY CEILING AT SUBMIT — UNBLOCK CONDITION (1), 2026-08-22 ────────
        // Until now this branch ledgered NOTHING. The fill was counted only when a later tick's
        // reconcile saw COMPLETE, so between submit and reconcile the day ceiling UNDERSTATED and
        // canSpendDay handed out headroom nobody authorized — to this owner's own manual sends and
        // swaps, not just to DCA. The window was bounded (one tick) rather than absent, and a
        // bounded fail-open is still a fail-open.
        //
        // 🚨 A TIMEOUT IS NOT A REFUSAL. agentSwap threw SwapPendingConfirm because WE STOPPED
        // WAITING; the swap IS submitted and may land seconds later. Counting it now is the same
        // rule finding A installed for agent-send and transfer_usdc — this branch was the one it
        // did not reach.
        //
        // ⭐⭐ ONLY THE DAY CEILING MOVES HERE, AND THAT IS THE WHOLE SAFETY ARGUMENT.
        // `recordDcaSpend` and the mandate's `spentAmount` stay confirm-gated. _budget.mjs's
        // PRECONDITION forbids a submit-time charge PAIRED WITH A SUB-LEDGER, because
        // reverseAgentSpend reverses the day ledger only and a partial reversal desyncs the pair
        // in the fail-open direction. Nothing is paired here, so a day-only reversal is COMPLETE,
        // not partial, and the precondition is satisfied rather than dodged. ⚠️ Moving either of
        // the other two to submit time WOULD trip it — see docs/dca-submit-time-budget-design.md
        // §0.2 (the TRIPLE), which stays parked and unbuilt.
        //
        // ⭐ `chargeId` makes this idempotent with the reconcile's own charge, structurally, inside
        // one CAS — the reconcile passes the SAME id and becomes a no-op. Not a flag check: that
        // would be check-then-write across two stores.
        //
        // ⭐ WHY spentAmount IS SAFE TO LEAVE: the tick takes ONE action per mandate per tick and a
        // mandate carrying a pendingPeriod neither evaluates nor submits, so this mandate cannot
        // fill again before reconcile. `spentAmount` cannot be over-consumed in the window.
        // ⚠️ `dca-day:` is NOT equally protected — it is per-OWNER, so a SECOND active mandate of
        // the same owner can fill while this one is pending and yieldsToUser will read an
        // understated DCA half. Narrower than the day-ceiling gap this closes and in the same
        // direction; recorded as a known residual rather than left for someone to discover.
        const dayLed = await runLedgerWrites([
          ["recordAgentSpend(day-ceiling, at submit)", () => recordAgentSpend({
            agent: AGENT.EXECUTOR, owner: m.walletAddress, amountUsdc: fillValueUsdc,
            source: "swap_tokens", justification: `DCA mandate ${m.id} (submitted)`,
            at: now, confirmation: "submitted", circleId: threw.circleId, chargeId: threw.circleId,
          })],
        ]);

        // ── 3. The mandate. ⚠️ A FAILED SUBMIT-TIME CHARGE STOPS THE MANDATE, exactly as a failed
        //    confirm-time charge does: the money is in flight and the ceiling did not advance, so
        //    every later fill would be measured against an understated counter. It stays PENDING
        //    for reconcile (pendingPeriod is still set) — and reconcile now runs above the ACTIVE
        //    gate, so stopping it here does not strand the in-flight fill.
        await patchMandate(m, key, dayLed.ok ? OUTCOME.PENDING_CONFIRM : OUTCOME.STOPPED_FAILED, {
          reason: dayLed.ok
            ? `swap submitted — inline confirm slow, awaiting id-reconcile (circleId ${threw.circleId})`
            : `SUBMITTED BUT NOT LEDGERED — ${fillValueUsdc} USDC is in flight (circleId ${threw.circleId}) and the day-ceiling write FAILED: ${dayLed.failed.join("; ")}. The mandate is STOPPED so no further fill is measured against an understated ceiling. The fill still reconciles.`,
          patch: { pendingPeriod: period, ...(dayLed.ok ? {} : ledgerFailurePatch(dayLed.failed)) },
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
      } catch (e) {
        // A Blobs write threw MID-INVOCATION (the request-scoped token aged out during this tick's
        // throttled chain I/O). It is TRANSIENT: the write did NOT commit, so this mandate's durable
        // state is unchanged on disk (a pending pointer stays set; a claim keeps its prior shape), and
        // the next tick redoes the identical, idempotent step with a FRESH injected token. So DEFER —
        // never abort the tick, never freeze the mandate. Any OTHER error is recorded against this one
        // mandate and the loop moves on, so one bad mandate can't starve the rest.
        if (isBlobsTransient(e)) {
          beat.deferred++;
          beat.details.push({ id: m.id, outcome: "deferred-blobs-transient", reason: String(e?.message || e).slice(0, 80) });
        } else {
          beat.errors++;
          beat.details.push({ id: m.id, outcome: "error", reason: String(e?.message || e).slice(0, 80) });
        }
      }
    }
  } catch (e) {
    beat.errors++;
    beat.note = `tick error (partial): ${e.message}`;
  }

  beat.tickElapsedMs = Date.now() - now;
  await writeHeartbeat();

  // ═══ ⭐⭐ THE DECISION LINE — because the heartbeat DOES NOT SURVIVE ═══════════════════════
  // `beat` already records everything this tick decided. It goes to dca-heartbeat/"last" — ONE KEY,
  // OVERWRITTEN EVERY 60 SECONDS. So the observation exists and then does not: 2026-08-13, a mandate
  // was created, never filled, and by the time anyone asked why, ~15 ticks had overwritten the only
  // record of the answer. The state was diagnosable for one minute.
  //
  // ⭐ A LOG LINE PERSISTS WHERE A SINGLE-KEY HEARTBEAT CANNOT. `netlify logs --since 40m` can then
  // answer "what did the scheduler decide at 19:27?" — which the heartbeat structurally never could.
  // Same shape as the other three sweepers (ub-withdraw-sweep, bridge-mint-sweep, job-sweep), which
  // all log a summary; this was the only money-moving scheduler that did not.
  //
  // ⚠️ THE `details` ARE THE POINT, NOT THE COUNTS. A count of `skipped:1` says the tick declined to
  // fill; only the reason says WHY (skipped-paused / skipped-ceiling / skipped-capped / cannot
  // value). Bounded to the first few so a wide fan-out cannot flood the log, and the REMAINDER IS
  // REPORTED — a cap that hides its own truncation reads as "that was everything".
  const shown = beat.details.slice(0, 5);
  const more = beat.details.length - shown.length;
  const why = shown.map((d) => `${String(d.id).slice(0, 8)}:${d.outcome}${d.reason ? `(${String(d.reason).slice(0, 60)})` : ""}`).join(" ");
  console.log(
    `[dca-tick] total=${beat.total} inactive=${beat.inactive} unreadable=${beat.unreadable} scanned=${beat.scanned} submitted=${beat.submitted} fired=${beat.fired} ` +
    `skipped=${beat.skipped} failed=${beat.failed} stopped=${beat.stopped} terminal=${beat.terminal} ` +
    `notDue=${beat.notDue} deferred=${beat.deferred} errors=${beat.errors} ms=${beat.tickElapsedMs}` +
    (why ? ` | ${why}` : "") + (more > 0 ? ` (+${more} more)` : "") +
    (beat.note ? ` | note=${beat.note}` : "")
  );
  return { statusCode: 200, body: JSON.stringify({ scanned: beat.scanned, submitted: beat.submitted, fired: beat.fired, skipped: beat.skipped, failed: beat.failed, stopped: beat.stopped, deferred: beat.deferred }) };
}
