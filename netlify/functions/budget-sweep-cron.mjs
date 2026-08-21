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
import { connectBlobs } from "./_blobs.mjs";
import { sweep } from "./budget-sweep.mjs";


// ═══ 🚨🚨 DETECTION MUST NOT LIVE IN THE STORE IT IS REPORTING ON ═════════════════════════════
//
// The first live ticks (19:00:54 and 19:30:35, 2026-08-21) failed because Blobs was unreachable —
// and the ONE signal that would have shown it, the heartbeat, is written INTO Blobs and swallows
// its own failure. So the monitor went quiet at exactly the moment its subject broke, and quiet is
// indistinguishable from healthy. A heartbeat cannot report the outage that prevents it.
//
// ⭐ THE FIX PATTERN ALREADY EXISTS HERE: strong-read-watch pushes to a WEBHOOK precisely because
// "the record is the audit trail, the push is the detection". This is that, for the sweeper: an
// alert path with NO dependency on the store being reported on.
//
// ⚠️ CHANNEL: DD_WATCH_WEBHOOK — the service-integrity channel, following shoutLedgerFailure's
// precedent for "the budget module's plumbing broke". NOT the money siren (WATCH_ALERT_WEBHOOK): a
// degraded sweep is a monitoring failure, not a fund movement, and the two channels are kept
// separate deliberately (gate:watch asserts the separation).
//
// 🚨 NO FALLBACK — DO NOT ADD ONE. strong-read-watch records what happened when a webhook "fell
// back so it works without a new secret": prod silently started pushing money-path alerts into the
// in-app feedback channel with nobody deciding that. An unset variable here means nothing is
// pushed, which is why the absence is LOGGED LOUDLY rather than passed over — absence must not read
// as safe, including the absence of the channel that reports absences.
//
// ⚠️ Awaited, unlike shoutLedgerFailure's fire-and-forget: a scheduled function can be frozen at
// return, and an un-awaited fetch is exactly the drop this codebase has already paid for.
async function alertDegraded(line) {
  const url = process.env.DD_WATCH_WEBHOOK;
  if (!url) {
    console.error("[budget-sweep-cron][NO-ALERT-CHANNEL] " + JSON.stringify({
      note: "the sweep is DEGRADED and DD_WATCH_WEBHOOK is unset — this failure reached NOBODY. " +
            "A monitor that cannot alert is not a monitor; treat this as the outage plus a second one.",
    }));
    return;
  }
  try {
    await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content:
        `🚨 **[budget-sweep]** DEGRADED — the sweep did not complete\n` +
        `errors \`${line.errors}\` · open \`${line.open}\` · resolved \`${line.resolved}\` · ` +
        `cumulative \`${line.wouldReverseTotal === null ? "UNREADABLE" : line.wouldReverseTotal}\`\n` +
        `⚠️ The heartbeat may be STALE rather than quiet — it is written into the same store that is ` +
        `failing, so a silent sweeper here is NOT evidence of health.` }),
    });
  } catch (err) {
    console.error("[budget-sweep-cron][ALERT-FAILED] " + String(err?.message ?? err).slice(0, 160));
  }
}

export async function handler(event) {
  // ── 🚨 CONNECT BLOBS. THIS LINE'S ABSENCE COST THE FIRST TWO LIVE TICKS ────────────────────
  // budget-sweep.mjs connects Blobs inside its HTTP handler; calling `sweep()` directly bypasses
  // that, so the very first deploy ran with NO Blobs context and every store call threw. The ticks
  // at 19:00:54 and 19:30:35 on 2026-08-21 both fired and both did nothing.
  //
  // ⚠️ AND NO IN-PROCESS SUITE COULD HAVE CAUGHT IT: the tests mock @netlify/blobs wholesale, so
  // the context is trivially present on both sides of the boundary. A binding can only be tested
  // ACROSS what it binds ([[binding-tested-across-what-it-binds]]) — this one is only observable
  // on a real deploy, which is why the guard below is a source assertion and the real proof is the
  // live log.
  if (event?.blobs) connectBlobs(event);

  const beat = await sweep();

  // ⚠️ null means COULD NOT COUNT, never "none observed" — the flip condition depends on the
  // difference, and a 0 here would read as a healthy "nothing to see".
  const line = {
    tickAt: beat.tickAt, armed: beat.reversalsArmed, open: beat.open,
    resolved: beat.resolved, wouldReverse: beat.wouldReverse,
    wouldReverseTotal: beat.wouldReverseTotal,
    leftPending: beat.leftPending, leftUnreadable: beat.leftUnreadable, errors: beat.errors,
  };

  // ── 🚨🚨 A SWEEP THAT FAILED MUST NOT REPORT SUCCESS ───────────────────────────────────────
  // The first version logged at INFO and returned 200 "swept" REGARDLESS of beat.errors. So a tick
  // that threw on every store call printed `errors:1` in an INFO line and answered 200 — a failure
  // wearing a success's clothes, which is the family this whole session has been chasing. The
  // heartbeat could not correct it either: writeHeartbeat swallows its own failure by design, so
  // when Blobs is the thing that is broken, the ONE signal that would show it is the one that
  // cannot be written. The log line is the only instrument that survives that, so it must carry
  // the verdict.
  if (beat.errors > 0 || beat.wouldReverseTotal === null) {
    console.error("[budget-sweep-cron][DEGRADED] " + JSON.stringify({
      ...line,
      note: "the sweep did NOT complete cleanly — errors>0 or the cumulative count was unreadable. " +
            "Do NOT read a quiet heartbeat as health: it may simply not have been writable.",
    }));
    await alertDegraded(line);
    return { statusCode: 500, body: "sweep degraded" };
  }

  console.log("[budget-sweep-cron] " + JSON.stringify(line));
  return { statusCode: 200, body: "swept" };
}
