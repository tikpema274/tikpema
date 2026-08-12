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
  check("⭐ a never-delivered alert is NOT suppressed (lastNotifiedAt null → retry)",
    decideNotify({ prevAlert: true, alert: true, lastNotifiedAt: null, now: NOW }).notify === true);
}

section("8 — the refusal window is MEASURED, which two prod deploys failed to do by hand");
{
  const open = windowFrom({ prev: null, judgement: { refusingSince: new Date(NOW).toISOString(), refusingMs: 0 }, nowIso: new Date(NOW).toISOString() });
  check("opening is recorded", open.event === "window-opened");
  const closed = windowFrom({ prev: { refusingSince: new Date(NOW - 7 * 60000).toISOString() }, judgement: { refusingSince: null, refusingMs: 0 }, nowIso: new Date(NOW).toISOString() });
  check("⭐⭐ closing records a DURATION", closed.event === "window-closed" && closed.ms === 7 * 60000, `${closed.ms}ms`);
  check("steady healthy is neither", windowFrom({ prev: null, judgement: { refusingSince: null, refusingMs: 0 }, nowIso: new Date(NOW).toISOString() }).event === "steady");
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
