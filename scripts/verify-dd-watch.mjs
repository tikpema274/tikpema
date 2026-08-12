#!/usr/bin/env node
// verify-dd-watch.mjs — the DD availability monitor's judgement, by injection.
//
// ═══ 🚨 THE ONE IT MUST GET RIGHT: NOT FIRING ON ROUTINE WORK ════════════════════════════════════
// The health key is a content hash of the DD surface, so a DD-code deploy legitimately rotates it
// and `no-record` is CORRECT until the next canary tick. A monitor that paged on that would fire on
// EVERY DD deploy — and an alert that fires predictably on routine work is one nobody reads. This
// repo already recorded that failure for the ack gate ("a gate that fires spuriously TRAINS
// CLICK-THROUGH AND DESTROYS ITS OWN VALUE"). The discriminator is REASON + DURATION.
//
// ⚠️ SUITE-PROVEN IS NOT PROVEN. The alert and recovered branches never fire while DD is healthy —
// the same first-success-branch problem that left a probe assertion unexecuted for the whole life of
// the service. Both directions must ALSO be calibrated live against the real channel.

import { readFileSync } from "node:fs";
import {
  judge, judgePath, alertHeadline, decideNotify, windowFrom,
  OUTCOME, GRACE_MS, CANARY_PERIOD_MS, CRON_MS, MIN_RERUN_MS, TTL_MS,
  PROBE_SUBJECT, DEFAULT_PATHS, DEFAULT_STORE_NAME, WEBHOOK_VAR,
} from "../shared/dd-watch/watch.mjs";

let pass = 0, fail = 0;
const check = (l, c, e = "") => { console.log(`  ${c ? "✅" : "❌"} ${l}${e ? ` — ${e}` : ""}`); c ? pass++ : fail++; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const NOW = Date.parse("2026-08-11T20:00:00Z");
const chal = (resource, payTo = "0xb407967319d56218c7e1c369125490e665a16ac4", amt = "60000") =>
  ({ status: 402, body: { accepts: [{ resource, payTo, maxAmountRequired: amt }] } });
const OK_API = chal("https://app.tikpema.xyz/api/dd-analyze");
const OK_FN = chal("https://app.tikpema.xyz/.netlify/functions/dd-analyze");
const refuse = (healthReason) => ({ status: 503, body: { refusal: { reason: "service-unverified", diagnostic: { healthReason } } } });
const HTML = { status: 200, body: "<!doctype html><html>…" };
const p = (a, f) => ({ api: a, functions: f });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DD WATCH — availability, both paths, and not crying wolf           ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — the ordering invariants, and they DIFFER from the other monitors");
check("MIN_RERUN < cron < TTL", MIN_RERUN_MS < CRON_MS && CRON_MS < TTL_MS, `${MIN_RERUN_MS / 60000}/${CRON_MS / 60000}/${TTL_MS / 60000}`);
check("⭐⭐ GRACE is derived from the CANARY period, not this monitor's", GRACE_MS === 2 * CANARY_PERIOD_MS);
check("  …and spans MORE than one monitor cycle, so several polls fall inside it", GRACE_MS > CRON_MS);
check("⭐ numbers are NOT dd-canary's 5/10/30", !(MIN_RERUN_MS === 5 * 60000 && CRON_MS === 10 * 60000 && TTL_MS === 30 * 60000));
check("⭐ numbers are NOT strong-read-watch's 7/15/45", !(MIN_RERUN_MS === 7 * 60000 && CRON_MS === 15 * 60000 && TTL_MS === 45 * 60000));
check("⭐ the probe subject can never gain code (zero address)", PROBE_SUBJECT === "0x" + "0".repeat(40));
check("its own store and its own channel", DEFAULT_STORE_NAME === "dd-watch" && WEBHOOK_VAR === "DD_WATCH_WEBHOOK");

section("2 — judgePath: an unrecognised shape is never HEALTHY");
check("402 + accepts → serving", judgePath(OK_API).outcome === OUTCOME.SERVING);
check("503 → refusing, carrying the health reason", judgePath(refuse("no-record")).healthReason === "no-record");
check("⭐⭐ SPA HTML → not-json (ROUTING missed, not the service)", judgePath(HTML).outcome === OUTCOME.NOT_JSON);
check("  …judged before status — the catch-all has returned BOTH 200 and 404 with HTML",
  judgePath({ status: 404, body: "<html>x</html>" }).outcome === OUTCOME.NOT_JSON);
check("fetch failure → unreachable", judgePath({ status: 0, body: null, error: "TimeoutError" }).outcome === OUTCOME.UNREACHABLE);
check("402 with NO accepts → unexpected, not serving", judgePath({ status: 402, body: {} }).outcome === OUTCOME.UNEXPECTED);
for (const bad of [null, undefined, 42, { status: 200, body: null }])
  check(`⭐ ${JSON.stringify(bad)} → never SERVING`, judgePath(bad).outcome !== OUTCOME.SERVING);

section("3 — 🚨 THE POST-DEPLOY WINDOW MUST NOT ALERT");
{
  let prev = null, firstAlert = null;
  for (let m = 0; m <= 30; m += 5) {
    const j = judge({ paths: p(refuse("no-record"), refuse("no-record")), prev, now: NOW + m * 60000 });
    if (j.alert && firstAlert === null) firstAlert = m;
    prev = { refusingSince: j.refusingSince };
  }
  check("⭐⭐ silent through the whole grace window (t+0…t+20m)", firstAlert !== null && firstAlert > GRACE_MS / 60000, `first alert t+${firstAlert}m`);
  check("⭐⭐ …but DOES alert once it persists", firstAlert === 25, `t+${firstAlert}m`);
  const j0 = judge({ paths: p(refuse("no-record"), refuse("no-record")), prev: null, now: NOW });
  check("first sighting is flagged expectedWindow, not alert", j0.expectedWindow === true && j0.alert === false);
  check("  …and is still recorded as NOT ok (refusing is refusing)", j0.ok === false);
}

section("4 — reasons that are NEVER routine alert IMMEDIATELY");
for (const r of ["version-mismatch", "unreadable", "malformed", "not-passing", "build-unresolved"]) {
  const j = judge({ paths: p(refuse(r), refuse(r)), prev: null, now: NOW });
  check(`⭐ ${r} → alert on FIRST sighting`, j.alert === true, j.alertReason);
}

section("4b — 🚨 THE CLOSED SET IS INVERTED: an UNKNOWN reason must ALERT");
{
  // MEASURED 2026-08-12: reasons:['stale'] gave alert:false. `stale` was not in the alert-worthy
  // allow-list and was not `no-record`, so it fell through every branch into SILENCE — and `stale`
  // is the canary having stopped writing. DD refused for 25 minutes with no correct alert.
  // ⭐ The defect was the DIRECTION of the enumeration, not a missing entry.
  const old = { refusingSince: new Date(NOW - 25 * 60000).toISOString() };
  for (const r of ["stale", "version-mismatch", "unreadable", "malformed", "not-passing",
                   "build-unresolved", "a-reason-invented-in-2027", "", "undefined"]) {
    const j = judge({ paths: p(refuse(r), refuse(r)), prev: null, now: NOW });
    check(`⭐ '${r}' alerts on FIRST sighting`, j.alert === true, j.alertReason);
  }
  check("⭐⭐ no-record is the ONLY suppressed reason, and only inside grace",
    judge({ paths: p(refuse("no-record"), refuse("no-record")), prev: null, now: NOW }).alert === false);
  check("  …and it alerts once persisted",
    judge({ paths: p(refuse("no-record"), refuse("no-record")), prev: old, now: NOW }).alertReason === "no-record-persisting");
  check("⭐ ALWAYS_REAL_REASONS no longer GATES — the inverse rule does",
    /no longer GATES? ANYTHING|no longer gates anything/i.test(
      readFileSync(new URL("../shared/dd-watch/watch.mjs", import.meta.url), "utf8")));
}

section("5b — 🚨 A FALSE ALL-CLEAR IS WORSE THAN A MISSED ALERT");
{
  // MEASURED 2026-08-12: the stand-down fired on `alert` going false and announced "both paths
  // serving again" WHILE BOTH PATHS WERE REFUSING. Nothing had recovered — the reason had merely
  // changed to one the old gate did not recognise. A missed alert leaves you looking; an all-clear
  // tells you to STOP.
  const d = (ok) => decideNotify({ prevAlert: true, alert: false, ok, lastNotifiedAt: null, now: NOW });
  check("⭐⭐ stand-down requires ok:true — the thing it actually claims", d(true).kind === "recovered");
  check("⭐⭐ alert cleared but STILL refusing → de-escalated, NOT recovered", d(false).kind === "de-escalated");
  check("  …and it still notifies (silence would read as recovery too)", d(false).notify === true);
  const h = alertHeadline({ alertReason: "de-escalated" });
  check("⭐ its headline says NOT SERVING in plain words", /STILL NOT SERVING/i.test(h.headline));
  check("  …and explicitly denies being a recovery", /NOT a recovery/i.test(h.why));
  check("⭐ default ok=true keeps old callers honest rather than silently de-escalating",
    decideNotify({ prevAlert: true, alert: false, lastNotifiedAt: null, now: NOW }).kind === "recovered");
}

section("5 — both paths, and what counts as divergence");
{
  const okj = judge({ paths: p(OK_API, OK_FN), prev: null, now: NOW });
  check("both serving → ok, no alert", okj.ok === true && okj.alert === false);
  check("⭐⭐ DIFFERING `resource` is EXPECTED, not divergence (it binds to the URL hit)", okj.resources.length === 2);
  const div = judge({ paths: p(HTML, OK_FN), prev: null, now: NOW });
  check("⭐⭐ one path HTML, other serving → path-divergence", div.alert === true && div.alertReason === "path-divergence");
  const q = judge({ paths: p(OK_API, chal("https://app.tikpema.xyz/.netlify/functions/dd-analyze", "0xdead")), prev: null, now: NOW });
  check("⭐⭐ differing payTo → quote-divergence", q.alert === true && q.alertReason === "quote-divergence");
  const pr = judge({ paths: p(OK_API, chal("https://app.tikpema.xyz/.netlify/functions/dd-analyze", undefined, "99999")), prev: null, now: NOW });
  check("⭐ differing PRICE → quote-divergence too", pr.alertReason === "quote-divergence");
}

section("6 — divergence gets its OWN headline, never shared with 'refusing'");
{
  const h = (reason) => alertHeadline({ alertReason: reason });
  check("⭐⭐ quote-divergence is CRITICAL", h("quote-divergence").severity === "critical");
  check("⭐⭐ path-divergence is CRITICAL", h("path-divergence").severity === "critical");
  check("refusing is a WARNING — different event, different urgency", h("refusing:version-mismatch").severity === "warning");
  check("no-record-persisting is a WARNING", h("no-record-persisting").severity === "warning");
  check("⭐ the divergence headline names the MONEY consequence, not just availability",
    /payment|money/i.test(h("quote-divergence").why));
  check("⭐ the path headline explains SPA HTML means the ROUTE missed",
    /ROUTE missed/i.test(h("path-divergence").why));
  check("  …and warns the canonical listing target may be the broken side",
    /canonical/i.test(h("path-divergence").why));
  check("headlines are all distinct", new Set(["quote-divergence", "path-divergence", "no-record-persisting", "refusing:x"].map((r) => h(r).headline)).size === 4);
}

section("7 — transitions only; silence is the healthy signal");
{
  const at = (m) => new Date(NOW - m * 60000).toISOString();
  check("healthy → silent", decideNotify({ prevAlert: false, alert: false, lastNotifiedAt: null, now: NOW }).notify === false);
  check("⭐ healthy→alert NOTIFIES", decideNotify({ prevAlert: false, alert: true, lastNotifiedAt: null, now: NOW }).kind === "first-alert");
  check("⭐⭐ alert→healthy NOTIFIES (recovery is news; a monitor that never stands down gets ignored)",
    decideNotify({ prevAlert: true, alert: false, lastNotifiedAt: at(5), now: NOW }).kind === "recovered");
  check("sustained alert is SUPPRESSED inside the reminder window",
    decideNotify({ prevAlert: true, alert: true, lastNotifiedAt: at(10), now: NOW }).notify === false);
  check("  …and re-pings once past it", decideNotify({ prevAlert: true, alert: true, lastNotifiedAt: at(90), now: NOW }).kind === "reminder");
  // ⭐⭐ THE MIRROR OF THE PERSIST-BEFORE-BROADCAST BUG. lastNotifiedAt advances only on confirmed
  // delivery, so a successful state write + a FAILED send leaves prevAlert=true with nobody told.
  // Suppressing that would silence an alert nobody has ever seen, on a window it never earned.
  for (const [label, v] of [["null", null], ["undefined", undefined], ["malformed", "not-a-date"], ["empty", ""]]) {
    const d = decideNotify({ prevAlert: true, alert: true, lastNotifiedAt: v, now: NOW });
    check(`⭐⭐ never-delivered (${label}) NOTIFIES, and says so by name`,
      d.notify === true && d.kind === "never-delivered", d.kind);
  }
  check("⭐ it is an EXPLICIT branch, not a fall-through a refactor could invert",
    /kind: "never-delivered"/.test(readFileSync(new URL("../shared/dd-watch/watch.mjs", import.meta.url), "utf8")));
}

section("8 — the refusal window is MEASURED, which two prod deploys failed to do by hand");
{
  const open = windowFrom({ prev: null, judgement: { unhealthySince: new Date(NOW).toISOString(), unhealthyMs: 0 }, nowIso: new Date(NOW).toISOString() });
  check("opening is recorded", open.event === "window-opened");
  const closed = windowFrom({ prev: { unhealthySince: new Date(NOW - 7 * 60000).toISOString() }, judgement: { unhealthySince: null, unhealthyMs: 0 }, nowIso: new Date(NOW).toISOString() });
  check("⭐⭐ closing records a DURATION", closed.event === "window-closed" && closed.ms === 7 * 60000, `${closed.ms}ms`);
  check("steady healthy is neither", windowFrom({ prev: null, judgement: { unhealthySince: null, unhealthyMs: 0 }, nowIso: new Date(NOW).toISOString() }).event === "steady");
}

section("8b — 🚨 INDUCED vs REAL: a calibration window must not pass as a measurement");
{
  const { leverActive, DEFAULT_PATHS: DP } = await import("../shared/dd-watch/watch.mjs");
  check("defaults → no lever", leverActive(DP) === false);
  check("⭐ a redirected api → lever active", leverActive({ ...DP, api: "https://x/nope" }) === true);
  check("  …and a redirected functions path too", leverActive({ ...DP, functions: "https://x/nope" }) === true);
  const opened = windowFrom({ prev: null, judgement: { refusingSince: "2026-08-12T07:35:00Z" }, nowIso: "2026-08-12T07:35:00Z", induced: true });
  check("⭐⭐ a window opened under a lever is labelled INDUCED", opened.induced === true);
  // ⚠️ The lever is typically removed WHILE the window is still open — that is how the calibration
  // ends. Without carry-forward the CLOSING entry would be labelled real and would lie.
  const closed = windowFrom({ prev: { unhealthySince: "2026-08-12T07:35:00Z", window: { induced: true } },
    judgement: { unhealthySince: null, unhealthyMs: 0 }, nowIso: "2026-08-12T07:45:00Z", induced: false });
  check("⭐⭐ …and it CARRIES FORWARD after the lever is removed", closed.induced === true, `ms=${closed.ms}`);
  const real = windowFrom({ prev: { unhealthySince: "2026-08-12T07:35:00Z" },
    judgement: { unhealthySince: null, unhealthyMs: 0 }, nowIso: "2026-08-12T07:45:00Z", induced: false });
  check("⭐ a genuine outage is NOT labelled induced", real.induced === false);

  // 🚨 THE LABEL MUST DIE WITH ITS WINDOW. Found 2026-08-12: a HEALTHY run reported
  // `window: steady, induced: true`, because carry-forward applied unconditionally. Cosmetic alone —
  // a steady window archives nothing — but a future GENUINE outage opening while that stale label
  // sat in prev.window would INHERIT it and be recorded as induced.
  // ⭐ That is the exact INVERSION of the bug this flag exists to prevent: instead of a calibration
  // masquerading as real, a REAL outage masquerades as a calibration and gets discounted by whoever
  // reads the history. The discounting direction is worse — it silences a true signal.
  const iso = (m) => new Date(NOW + m * 60000).toISOString();
  const closedInduced = { event: "window-closed", induced: true };
  const steadyAfter = windowFrom({ prev: { unhealthySince: null, window: closedInduced },
    judgement: { unhealthySince: null, unhealthyMs: 0 }, nowIso: iso(5), induced: false });
  check("⭐⭐ a STEADY run after a calibration is NOT induced — the label dies with the window",
    steadyAfter.event === "steady" && steadyAfter.induced === false, `induced=${steadyAfter.induced}`);
  const genuineAfter = windowFrom({ prev: { unhealthySince: null, window: steadyAfter },
    judgement: { unhealthySince: iso(10) }, nowIso: iso(10), induced: false });
  check("⭐⭐ a GENUINE outage opening afterwards does NOT inherit induced",
    genuineAfter.event === "window-opened" && genuineAfter.induced === false);
  check("  …while a STILL-OPEN window keeps carrying it (check 1 must not regress)",
    windowFrom({ prev: { unhealthySince: iso(0), window: { induced: true } },
      judgement: { unhealthySince: iso(0), unhealthyMs: 60000 }, nowIso: iso(1), induced: false }).induced === true);
  check("⭐ the label is DERIVED from targets, never remembered by an operator",
    /leverActive/.test(readFileSync(new URL("../netlify/functions/dd-watch.mjs", import.meta.url), "utf8")));
}

section("8c — 🚨 THE WINDOW MEASURES UNHEALTHY, NOT MERELY 'REFUSING'");
{
  // MEASURED 2026-08-12 during a live calibration: /api served SPA HTML while /.netlify kept
  // serving. A real outage — the CANONICAL payment target broken while the service looked fine —
  // and it left NO TRACE in windowHistory, because the window was keyed on `refusingSince`, which
  // only the `refusing` outcome sets. ⭐ A history of availability that silently omits a whole class
  // of unavailability is worse than none: it reads as complete.
  const nowIso = new Date(NOW).toISOString();
  const cases = [
    ["not-json (SPA HTML)", p(HTML, OK_FN)],
    ["unreachable", p({ status: 0, body: null, error: "TimeoutError" }, OK_FN)],
    ["unexpected status", p({ status: 500, body: {} }, OK_FN)],
    ["quote-divergence (BOTH serving!)", p(OK_API, chal("https://app.tikpema.xyz/.netlify/functions/dd-analyze", "0xdead"))],
    ["refusing", p(refuse("stale"), refuse("stale"))],
  ];
  for (const [label, paths] of cases) {
    const j = judge({ paths, prev: null, now: NOW });
    const w = windowFrom({ prev: null, judgement: j, nowIso, induced: false });
    check(`⭐ ${label} OPENS a window`, w.event === "window-opened" && !!j.unhealthySince, w.event);
  }
  const healthy = judge({ paths: p(OK_API, OK_FN), prev: null, now: NOW });
  check("⭐⭐ a healthy run opens NOTHING", windowFrom({ prev: null, judgement: healthy, nowIso, induced: false }).event === "steady"
    && healthy.unhealthySince === null);

  // ⚠️ TWO CLOCKS, deliberately separate: widening refusingSince would break the grace decision,
  // which is specifically about no-record after a key rotation.
  const nj = judge({ paths: p(HTML, OK_FN), prev: null, now: NOW });
  check("⭐⭐ refusingSince stays REFUSAL-only (grace logic untouched)", nj.refusingSince === null);
  check("  …while unhealthySince covers it", nj.unhealthySince !== null);

  // ⭐ AND THE CARRY-FORWARD NOW RUNS THROUGH A not-json WINDOW — the path the last calibration
  // could not exercise, because no window ever opened.
  const prevOpen = { unhealthySince: nowIso, window: { induced: true } };
  const closed = windowFrom({ prev: prevOpen, judgement: judge({ paths: p(OK_API, OK_FN), prev: prevOpen, now: NOW + 9 * 60000 }),
    nowIso: new Date(NOW + 9 * 60000).toISOString(), induced: false });
  check("⭐⭐ a not-json window CLOSES with a duration and keeps induced:true",
    closed.event === "window-closed" && closed.ms === 540000 && closed.induced === true);
}

section("9 — 🚨 THE MONITOR MUST NEVER BE ABLE TO REFUSE ITSELF");
{
  // Shipped 2026-08-11 and caught the same night: the handler refused any invocation carrying an
  // httpMethod without an internal token. Netlify delivers SCHEDULED invocations WITH an httpMethod,
  // so the cron itself was refused — five runs, nothing written, no error anywhere. Durations gave it
  // away (22–29ms, when two HTTPS probes cannot finish under ~200ms).
  // ⭐ Asserted on the SOURCE because the failure was structural, not a judgement branch: there is no
  // input to judge() that could have exposed it.
  const src = readFileSync(new URL("../netlify/functions/dd-watch.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  check("⭐⭐ the handler contains NO early-return that refuses an invocation",
    !/return json\(401/.test(code), "a 401 path would refuse the cron itself");
  check("⭐ the token is RECORDED, not enforced", /invokedWithToken/.test(code) && !/!requireInternal\(event\)/.test(code));
  check("  …and the reasoning survives in the comments, so it is not re-introduced",
    /refuse itself/i.test(src) && /403/.test(src));

  // ⭐⭐ PERSIST BEFORE BROADCAST. The first version notified FIRST and wrote LAST: a failed write
  // meant the message went out and `prev` stayed null, so the NEXT run classified a continuing
  // problem as `first-alert` and sent again — every 5 minutes, forever. The reminder window that
  // exists to stop a firehose would never be consulted, because the state proving there was
  // anything to remind about is precisely what failed to persist.
  const firstWrite = code.indexOf("setJSON");
  const sendIdx = code.indexOf("await fetch(hook");
  check("⭐⭐ the alert state is PERSISTED BEFORE any message is sent",
    firstWrite !== -1 && sendIdx !== -1 && firstWrite < sendIdx,
    `write@${firstWrite} send@${sendIdx}`);
  check("⭐ the delivery outcome is written AFTER, and is best-effort",
    /setJSON\(LATEST_KEY, record\)\.catch\(/.test(code));
  check("  …so a failed outcome-write costs ONE repeat, never a loop and never silence",
    /one repeated message, not a loop/i.test(src));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
