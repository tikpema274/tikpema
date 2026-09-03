import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { requireInternal } from "./_auth.mjs";
import { circle } from "./_circle.mjs";
import { withRetry } from "./_retry.mjs";
import { listUnresolvedCharges, reverseAgentSpend, markChargeResolved, wasAlreadyReversed } from "./_budget.mjs";

// budget-sweep.mjs — resolve SUBMIT-TIME day-ceiling charges that never confirmed, and reverse the
// ones that terminally failed (step 8).
//
// ═══ 🚨 THE ONLY SCHEDULED FUNCTION THAT CAN WIDEN A CAP ═══
// Every other guard in this codebase over-restricts when it goes wrong. This one CREDITS BUDGET
// BACK, so its failure mode is fail-OPEN: reverse a swap that actually landed and the user gets
// headroom they never paid for. THE REFLEX IS INVERTED HERE — WHEN IN DOUBT, DON'T REVERSE.
// Exactly ONE observed state reverses (terminal FAILED/CANCELLED/DENIED). EVERY other outcome —
// pending, unmodelled, unreadable, not-found — LEAVES THE CHARGE STANDING. A missed reversal costs a
// user some headroom until UTC midnight; a wrong reversal widens a money cap. Not symmetric.
//
// ⚠️ NOT SCHEDULED YET. There is deliberately no netlify.toml entry: this must be mock-proven and
// then run against a manufactured real failure BEFORE it is allowed to touch prod on a timer.
//
// WHY THERE IS NO CLAIM STORE: the audit log indexes itself. Charges live in it; so do the
// deterministic `reversal-<id>` / `resolution-<id>` markers that retire them. A separate claim store
// would be a SECOND SOURCE OF TRUTH that can desync from the log — exactly the phantom class this
// work exists to remove.
//
// CRASH-SAFETY (why reverse-then-mark needs no transaction): reverseAgentSpend is idempotent via
// `reversedIds` INSIDE its CAS. Crash after reversing but before marking ⇒ next tick re-resolves,
// still FAILED, the reversal no-ops ("already reversed"), and the marker is written then.
// ⚠️ ORDER IS LOAD-BEARING: reverse FIRST, mark SECOND. Marking first and crashing would retire a
// charge that was never reversed — a silent permanent phantom.

// ⚠️ NO `export const config = { schedule }` HERE — DELIBERATELY, AND DO NOT ADD ONE CASUALLY.
// Netlify's documented behaviour is to honour an in-code `config.schedule`. dca-tick carries one AND
// a netlify.toml entry, and this project's note that "the CLI did not pick up job-sweep's in-code
// config" is an observation from ONE function on ONE deploy — not a guarantee. Leaving a schedule
// declared here would mean the only thing keeping this function switched off is a vendor quirk.
//
// This function is INERT BY CONSTRUCTION: no schedule exists anywhere for it, and the HTTP `handler`
// now REQUIRES internal auth, so it is inert on-demand too (not just off-schedule). Turning it on is a
// deliberate, reviewable act.
// ⚠️ HOW TO SCHEDULE IT — NOT by adding a [functions."budget-sweep"] entry to netlify.toml. A Netlify
// cron invocation does NOT carry x-internal-token, so it would hit the guard and 401 on every tick —
// the sweep would silently never run (and never even write a heartbeat, so it would look dead). The
// correct path uses the pure `sweep()` export, which is UNGUARDED and untouched: a scheduled trigger
// calls sweep() through an authenticated/internal path (mirror how job-swap-approve triggers
// job-swap-receipt-background WITH the internal token). Decide that mechanism when scheduling.
// ⚠️ Do not enable it on a design argument. Path B: the shipped `confirmation:"submitted"` field makes
// the real phantom rate MEASURABLE — schedule this once an observed rate says it is needed.

// ── AGE THRESHOLD — only charges older than this are resolved. Re-tuned 1h → 6h → 30m as the ROLE
// was corrected; the risk analysis never changed. ──────────────────────────────────────────────
//
// ⚠️ THIS SCANNER IS THE PRIMARY HANDLER, NOT A BACKSTOP. The 6h value assumed the verifier handled
// the real cases and this only caught orphans. That was WRONG: job-swap-receipt-background reverses
// only on `reason:"reverted"`, which needs a BROADCAST tx whose receipt reads reverted
// (_swap-confirm.mjs:136). An ESTIMATION-REJECTED swap is never broadcast — no hash, no receipt — so
// the verifier settles it `unconfirmed` and never reaches its reversal branch. Estimation-reject is
// the failure shape actually observed under production conditions (step 4b), so it lands HERE.
// A 6h threshold would have delayed every real reversal by up to 6h.
//
// ⚠️ THE THRESHOLD IS NOT THE SAFETY MECHANISM — the matrix is. A swap still settling reads
// NON-TERMINAL and is LEFT, so no value here can cause a wrong reversal; the only way to reverse a
// real swap is Circle reporting terminal FAILED for one that succeeded (a model error, not a timing
// one — step 5B checked the model against real responses). The threshold's only job is to avoid
// querying swaps still in flight.
//
// 30m clears every latency bound this codebase knows — observed confirms 2-3s, waitForTx's 60s
// "still plausible", dca-tick's 120s grace, the verifier's own 90s deadline — by 20x-600x. Tighter
// would cost only extra getTransaction calls; it would not cost safety.
// Deliberately NOT reused from _dca.mjs's MAX_PENDING_AGE_MS: DIFFERENT policy, and coupling them
// would let a change to DCA's escalation silently move this money guard.
// ═══ 🔭 REVERSE-DISABLED — REVERSAL IS DISARMED (decision 2026-08-21) ═════════════════════════
//
// ⚠️ THIS MODE WAS CALLED "OBSERVE-ONLY" FOR ONE COMMIT, AND THAT NAME WAS A LIE ABOUT WHAT IT
// DOES. It writes: a `resolution-<circleId>` audit marker for every charge it proves landed (21 of
// them on the first real run), an `observed:<circleId>` key for anything it would have reversed,
// and the heartbeat. A reader seeing "observe-only" would assume no mutation and be wrong three
// ways. What is disarmed is the REVERSAL, not the writing — so the name says that and nothing more.
// ⭐ The mislabelled-mode shape is the same one this session kept finding elsewhere; it is easier
// to write than to notice, which is why the suite now pins the name against the behaviour.
//
// The sweeper now RUNS on a schedule, but it will not reverse. It resolves the charges it can prove
// landed, and for any charge it WOULD have reversed it writes durable evidence and leaves the charge
// standing. Nothing here can widen a cap while this is false.
//
// ⭐ WHY RUN IT AT ALL, THEN. Because the measurement that justified scheduling also showed there is
// nothing yet to reverse: on 2026-08-21 every one of the 21 unresolved submit-time charges in
// production resolved COMPLETE — 21/21 real spends, ZERO phantoms, across 2026-07-23..2026-08-09.
// So the first runs are a predictable no-op, which makes this the safest possible moment to switch
// the machine on: we know exactly what it should do, and anything else is a bug we see immediately.
//
// 🚨 THE TRAP THIS MODE MUST AVOID, and the reason the disarmed branch does NOT mark-resolved:
// marking retires a charge from the queue permanently. If reverse-disabled marked the would-reverse
// ones, arming later would find an EMPTY queue — the observation period would have silently
// discarded exactly the cases it existed to catch. Disarmed, a would-reverse charge is LEFT.
//
// ── ⭐⭐ THE FLIP CONDITION. BOTH HALVES. A MODE WITHOUT ONE BECOMES PERMANENT BY INERTIA ──────
// Without this we would simply have acquired a SECOND switched-off safety net, which is the exact
// finding that led here.
//
//   (1) ARM IT when the observed rate on the POST-FINDING-A population is NON-ZERO — i.e. the
//       durable `observed:<circleId>` evidence below is not empty. Finding A (agent-send +
//       transfer_usdc pending branches) created the first charges whose outcome is genuinely
//       unknown at ledger time; before it, every submit-time charge came from a path that happened
//       to succeed. A non-zero count means phantoms are real here, and reversal earns its risk.
//
//   (2) RETIRE IT — do not leave it running in a mode — if the count is STILL ZERO on
//       **2026-11-19** (90 days of post-A observation). Retiring means deleting the schedule AND
//       this function, and recording that the phantom class does not occur on this system.
//       ⭐ This half matters more than it looks: a sweeper that observes nothing for three months
//       and stays scheduled is INDISTINGUISHABLE FROM A BROKEN ONE — which is precisely the state
//       budget-sweep was already in when it was found. "Still running" is not evidence of working.
//
// ⚠️ BOTH HALVES ARE DECIDABLE FROM DATA, NOT FROM MEMORY. The heartbeat reports
// `wouldReverseTotal` from durable per-charge keys, so on 2026-11-19 the question "has it observed
// anything?" is answered by reading one blob — never by someone's recollection. The per-tick
// heartbeat alone could not answer it: it is overwritten every tick, and an observation that does
// not survive is not a record ([[observation-that-does-not-survive]]).
const REVERSALS_ARMED = false;

// Durable evidence of a would-have-reversed charge. Deterministic key ⇒ one per charge, ever.
// ⚠️ Kept in the HEARTBEAT store, not the audit log: this is an observation about a charge, not a
// bookkeeping event on it, and the audit log's own reader treats every non-`kind` entry as a charge.
const OBSERVED_PREFIX = "observed:";

const RESOLVE_AFTER_MS = 30 * 60 * 1000; // 30m

// ── ESCALATION — a separate, longer horizon, and it NEVER reverses. ────────────────────────────
// By 24h the cap impact has self-healed at UTC rollover, so what is left is record accuracy; and a
// full day of persistent unreadability means something is genuinely wrong (API outage, malformed id)
// that a human should see. So: retire it from the queue with an explicit UNRESOLVED outcome and flag
// it. Flag, never act.
const ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

// Bounded per invocation, like dca-tick: the request-scoped Blobs token is short-lived, and a burst
// of slow Circle reads must not age it out mid-write.
const MAX_RESOLVES_PER_TICK = 10;
const GET_TX_TIMEOUT_MS = 6000;
const HEARTBEAT_STORE = "budget-sweep-heartbeat";

// Circle's terminal-failure set — the ONLY reversal trigger. Anything not in here leaves the charge.
const TERMINAL_FAILED = new Set(["FAILED", "CANCELLED", "DENIED"]);
// States that mean "not yet" — recorded explicitly so an UNMODELLED string is distinguishable from a
// known-pending one and can be reported rather than silently lumped in.
const KNOWN_PENDING = new Set(["INITIATED", "QUEUED", "SENT", "CONFIRMED", "ACCELERATED", "PENDING_RISK_SCREENING"]);

export async function handler(event) {
  // 🔒 SECURITY — FIRST, before ANY sweep logic. This is the only cap-WIDENING entry point in the
  // codebase, so an unauthenticated caller must never reach the sweep. Same mechanism as
  // job-swap-receipt-background (requireInternal / x-internal-token) — one auth path, not a variant.
  // (Found the hard way: a public POST to this endpoint during deploy verification RAN the sweeper.
  // It was matrix-safe and found nothing, but "inert on schedule" is not "inert on demand".)
  if (!requireInternal(event)) {
    console.error("[budget-sweep] rejected: bad or missing x-internal-token");
    return { statusCode: 401, body: "unauthorized" };
  }
  if (event?.blobs) connectBlobs(event);
  const beat = await sweep();
  return { statusCode: 200, body: JSON.stringify(beat) };
}

// The sweep itself, with its bounds INJECTABLE. `handler` always calls it with the production
// constants above — the seam exists so a test can sweep immediately instead of waiting out the real
// threshold, WITHOUT an env override on a money-path constant (the objection we upheld for
// DEADLINE_SAFETY_MS). Same shape as _budget.mjs taking an injectable `store`.
export async function sweep({ resolveAfterMs = RESOLVE_AFTER_MS, escalateAfterMs = ESCALATE_AFTER_MS, at } = {}) {
  const startedAt = new Date(at ?? Date.now()).toISOString();
  const now = at ? new Date(at).getTime() : Date.now();

  // UNCONDITIONAL heartbeat (the job-sweep blind-spot lesson): a quiet sweeper must be
  // distinguishable from a dead one by reading ONE blob.
  const beat = {
    tickAt: startedAt, open: 0, resolved: 0, reversed: 0, alreadyReversed: 0,
    leftPending: 0, leftUnreadable: 0, leftUnmodelled: 0, escalated: 0, errors: 0, details: [],
    // 🔭 reverse-disabled bookkeeping. `wouldReverseTotal` is CUMULATIVE, read from durable keys —
    // it is the number the flip condition is decided on, and it survives every tick.
    reversalsArmed: REVERSALS_ARMED, wouldReverse: 0, wouldReverseTotal: 0,
  };
  const writeHeartbeat = async () => {
    try { await getStore(HEARTBEAT_STORE).setJSON("last", beat); } catch { /* observability only */ }
  };

  try {
    const open = await listUnresolvedCharges({ olderThanMs: resolveAfterMs, at: now });
    beat.open = open.length;

    const client = circle();
    for (const entry of open.slice(0, MAX_RESOLVES_PER_TICK)) {
      const id = entry.circleId;
      try {
        // ── RESOLVE. Throttle-hardened so a TRANSIENT failure never even reaches "unreadable";
        //    only a persistent one does, and that LEAVES the charge. Hard-timed so a hanging call
        //    cannot consume the tick.
        let state = null;
        let lookErr = null;
        try {
          const { data } = await withRetry(
            () => Promise.race([
              client.getTransaction({ id }),
              new Promise((_, rej) => setTimeout(() => rej(new Error("getTransaction timeout")), GET_TX_TIMEOUT_MS)),
            ]),
            { retries: 3, label: "sweep getTransaction" }
          );
          state = data?.transaction?.state ?? null;
        } catch (e) { lookErr = e; }

        // ── THE MATRIX. Exactly one branch reverses. ──────────────────────────────────────────
        if (!lookErr && TERMINAL_FAILED.has(state)) {
          // ── 🔭 DISARMED: OBSERVE, RECORD DURABLY, AND LEAVE THE CHARGE ─────────────────────
          // No reversal, and deliberately NO markChargeResolved — marking would retire it from the
          // queue, so arming later would find nothing. The charge stands (over-counted, which
          // narrows the cap: the safe direction) and the evidence outlives this tick.
          if (!REVERSALS_ARMED) {
            const hb = getStore(HEARTBEAT_STORE);
            try {
              await hb.setJSON(`${OBSERVED_PREFIX}${id}`, {
                circleId: id, state, owner: entry.owner, amountUsdc: entry.amountUsdc,
                source: entry.source, chargedAt: entry.timestamp, observedAt: startedAt,
                note: "WOULD HAVE BEEN REVERSED — reversal is disarmed (REVERSALS_ARMED=false). " +
                      "The charge STANDS, which over-counts and narrows the cap. See the flip condition.",
              }, { onlyIfNew: true });
            } catch { /* evidence is best-effort; the charge is left standing either way */ }
            beat.wouldReverse++;
            beat.details.push({ id, outcome: state, action: "would-reverse (disarmed)", amountUsdc: entry.amountUsdc });
            continue;
          }

          // The ONLY reversal path. Reverse FIRST, mark SECOND (see the crash-safety note above).
          const r = await reverseAgentSpend({ entry, reason: `swap ${state} (circleId ${id})`, store: undefined, at: now });
          // ⭐ ONE IMPLEMENTATION, IMPORTED. This was a second, character-identical copy of the
          // predicate in _budget.mjs — and a copy of a predicate is a copy that can drift alone.
          // It reads the TYPED `refusal`, so rewording the primitive's sentence changes nothing here.
          const alreadyDone = wasAlreadyReversed(r);
          if (r.reversed) beat.reversed++;
          else if (alreadyDone) beat.alreadyReversed++;

          if (r.reversed || alreadyDone) {
            // "already reversed" MUST also mark: it means a previous tick reversed but crashed before
            // marking. Without this the charge would be re-resolved forever.
            await markChargeResolved({ entry, outcome: state, reason: `reversed (${state})`, at: now });
            beat.resolved++;
            beat.details.push({ id, outcome: state, action: r.reversed ? "reversed" : "already-reversed" });
          } else {
            // The primitive refused for its own reasons (not "submitted", bad amount). It is the
            // authority on what may be reversed — leave the charge and surface why.
            beat.details.push({ id, outcome: state, action: "primitive-refused", why: r.refused });
          }
          continue;
        }

        if (!lookErr && state === "COMPLETE") {
          await markChargeResolved({ entry, outcome: "COMPLETE", reason: "landed on-chain", at: now });
          beat.resolved++;
          continue;
        }

        // ── EVERYTHING BELOW LEAVES THE CHARGE STANDING. ──────────────────────────────────────
        const aged = entry.ageMs >= escalateAfterMs;
        const why = lookErr
          ? `unreadable: ${lookErr.message}`
          : KNOWN_PENDING.has(state) ? `pending (${state})`
          : `UNMODELLED state ${JSON.stringify(state)}`;

        if (lookErr) beat.leftUnreadable++;
        else if (KNOWN_PENDING.has(state)) beat.leftPending++;
        else beat.leftUnmodelled++;

        if (aged) {
          // Retire it from the queue WITHOUT reversing, and say so. Flag, never act.
          await markChargeResolved({ entry, outcome: "UNRESOLVED_AGED_OUT", reason: why, at: now });
          beat.escalated++;
          beat.details.push({ id, action: "escalated", ageHours: Math.round(entry.ageMs / 3600000), why });
        } else {
          beat.details.push({ id, action: "left", why });
        }
      } catch (e) {
        // Per-entry isolation: one bad charge must not abort the sweep for the rest.
        beat.errors++;
        beat.details.push({ id, action: "error", why: e.message });
      }
    }
  } catch (e) {
    beat.errors++;
    beat.details.push({ action: "sweep-failed", why: e.message });
  }

  // ⭐ CUMULATIVE, from durable keys — the number the flip condition is decided on. Counted every
  // tick so "has it ever observed anything?" is one blob read, not an archaeology exercise.
  try {
    const hb = getStore(HEARTBEAT_STORE);
    const { blobs } = await hb.list({ prefix: OBSERVED_PREFIX });
    beat.wouldReverseTotal = blobs.length;
  } catch { beat.wouldReverseTotal = null; } // ⚠️ null = COULD NOT COUNT, never 0 = "none observed"

  await writeHeartbeat();
  return beat;
}
