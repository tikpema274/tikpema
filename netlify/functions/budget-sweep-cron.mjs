// budget-sweep-cron.mjs — the SCHEDULED entry point for budget-sweep's `sweep()`.
//
// ═══ ⚠️ WHY THIS FILE EXISTS AT ALL, RATHER THAN A SCHEDULE ON budget-sweep ═══════════════════
// budget-sweep.mjs's HTTP `handler` is guarded by requireInternal (x-internal-token). A Netlify
// cron invocation does NOT carry that header, so scheduling budget-sweep directly would 401 on
// every tick — and it would never even write a heartbeat, so it would LOOK DEAD while being
// perfectly alive. That failure is silent, which is the one shape this codebase keeps paying for.
//
// ⭐ So the schedule points HERE, and this calls the pure `sweep()` export by IMPORT: no HTTP hop,
// no token, no auth surface, and nothing that can 401. budget-sweep.mjs's own header specifies
// exactly this ("a scheduled trigger calls sweep() through an authenticated/internal path") and
// explicitly forbids the netlify.toml-entry-on-budget-sweep shortcut.
//
// 🔭 REVERSAL IS DISARMED. `REVERSALS_ARMED = false` in budget-sweep.mjs: this observes, records
// durable evidence of anything it WOULD have reversed, and leaves the charge standing. Nothing
// reachable from this schedule can widen a cap. The two-halved FLIP CONDITION — when to arm, and
// the date by which a zero observation means RETIRE rather than keep running — is stated beside
// that flag, not here, so it cannot drift away from the thing it governs.
//
// ⚠️ NO in-code `export const config = { schedule }`. The registration lives in netlify.toml, which
// is the form this project has actually observed working (job-sweep's in-code config was not picked
// up by the CLI deploy). One declaration, in the place that demonstrably fires.
import { sweep } from "./budget-sweep.mjs";

export async function handler() {
  const beat = await sweep();
  // One line, greppable in `netlify logs`, carrying the numbers the flip condition is decided on.
  console.log("[budget-sweep-cron] " + JSON.stringify({
    tickAt: beat.tickAt, armed: beat.reversalsArmed, open: beat.open,
    resolved: beat.resolved, wouldReverse: beat.wouldReverse,
    wouldReverseTotal: beat.wouldReverseTotal, // ⚠️ null means COULD NOT COUNT, never "none"
    leftPending: beat.leftPending, leftUnreadable: beat.leftUnreadable, errors: beat.errors,
  }));
  return { statusCode: 200, body: "swept" };
}
