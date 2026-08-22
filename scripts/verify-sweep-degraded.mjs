// verify-sweep-degraded.mjs — THE DEGRADED ALARM, TESTED BEHAVIOURALLY.
//
//   node --experimental-test-module-mocks scripts/verify-sweep-degraded.mjs   (npm run test:sweepdegraded)
//
// ═══ ZERO MONEY, ZERO NETWORK ═══ Blobs in-memory, circle() scripted, fetch stubbed.
//
// ═══ ⭐⭐ WHY THIS SUITE EXISTS — A DISTINCTION THAT WAS ABOUT TO BE COLLAPSED ════════════════
// After the 2026-08-21 fix, `budget-sweep-cron`'s DEGRADED path was covered by SOURCE REGEXES only
// (verify-sweep-reverse-disabled.mjs §7b/§8) and had never fired. The 11h of clean live ticks that
// followed were an honestly clean run, NOT a proven alarm — an alarm that has only ever stayed
// silent is uncalibrated, the same argument blobs-probe makes about a probe that has only ever
// returned ok.
//
// ⚠️ THE TRAP THIS SUITE REFUSES: "no in-process suite could have caught last night's bug, so the
// cron is untestable in-process." That conflates TWO DIFFERENT THINGS:
//
//   · THE BLOBS CONTEXT BEING ABSENT — genuinely untestable here. The suites mock @netlify/blobs
//     wholesale, so the context is trivially present on both sides of the boundary. A binding can
//     only be tested ACROSS what it binds ([[binding-tested-across-what-it-binds]]). That half
//     stays a source check, and the live log stays its real proof.
//
//   · THE STORE THROWING — the TRIGGER the DEGRADED path actually watches for. A mock can throw.
//     Nothing about it needs a real deploy.
//
// ⭐ Leaving a testable alarm untested because a different, genuinely untestable thing sits next to
// it is how a whole defence goes unexercised. The cause was unreachable; the RESPONSE TO IT is not.
// This suite drives the response.
//
// ⭐ THE SHAPE ASSERTED IS THE ONE PROD ACTUALLY EMITTED. Five dead ticks on 2026-08-21 (19:00:54,
// 19:30:35, 20:00:48, 20:30:31, 21:00:45 UTC) each logged:
//     open:0 resolved:0 wouldReverse:0 wouldReverseTotal:null errors:1
// …at INFO, returning 200. §2 reproduces exactly that beat and asserts it now answers 500.
import { mock } from "node:test";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

// ── THE SWITCHABLE STORE ─────────────────────────────────────────────────────────────────────
// `throwFor` names the stores whose EVERY call throws. Per-store rather than global because §5
// needs the budget store readable while ONLY the heartbeat store fails — that is the branch where
// errors stays 0 and the cumulative count alone is unreadable.
//
// ⚠️ The methods consult `throwFor` at CALL time, never at construction: _budget.mjs memoises its
// adapter (`_defaultAdapter`), so a store captured on the first sweep is reused by every later one.
// A flag read at construction would silently pin section 1's mode for the whole run.
const throwFor = new Set();
const maps = [];
let etagSeq = 0;
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  let m = maps.find((x) => x._n === nm);
  if (!m) { m = new Map(); m._n = nm; maps.push(m); }
  const guard = () => {
    if (throwFor.has(nm)) throw new Error(`store unavailable: ${nm}`);
  };
  return {
    async get(k, opts) { guard(); const e = m.get(k); if (e == null) return null; return opts?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { guard(); return m.get(k)?.value ?? null; },
    async setJSON(k, v, opts) {
      guard();
      const cur = m.get(k);
      if (opts?.onlyIfNew && cur) return { modified: false };
      if (opts?.onlyIfMatch && cur?.etag !== opts.onlyIfMatch) return { modified: false };
      m.set(k, { value: v, etag: `e${++etagSeq}` }); return { modified: true };
    },
    async setIfNew(k, v) { guard(); if (m.has(k)) return false; m.set(k, { value: v, etag: `e${++etagSeq}` }); return true; },
    async getWithMetadata(k) { guard(); const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(pfx) {
      guard();
      const p = typeof pfx === "string" ? pfx : pfx?.prefix ?? "";
      const keys = [...m.keys()].filter((x) => x.startsWith(p));
      return typeof pfx === "string" ? keys : { blobs: keys.map((key) => ({ key })) };
    },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });
mock.module("../netlify/functions/_circle.mjs", { namedExports: {
  circle: () => ({ getTransaction: async () => ({ data: { transaction: { state: "COMPLETE" } } }) }),
  waitForTx: async () => "0x0", TxPendingError: class extends Error {},
}});

const { handler } = await import("../netlify/functions/budget-sweep-cron.mjs");

// ── CONSOLE + FETCH CAPTURE ──────────────────────────────────────────────────────────────────
// ⭐ The log line IS the instrument under test — when Blobs is what is broken, the heartbeat cannot
// be written, so console output is the only signal that survives. So it is captured, not silenced.
const realLog = console.log, realErr = console.error, realFetch = globalThis.fetch;
let logs = [], errs = [], posts = [], order = [];
let fetchMode = "ok"; // "ok" | "throw"

const capture = () => {
  logs = []; errs = []; posts = []; order = [];
  console.log = (...a) => { logs.push(a.join(" ")); };
  console.error = (...a) => { errs.push(a.join(" ")); };
  globalThis.fetch = async (url, init) => {
    if (fetchMode === "throw") throw new Error("webhook unreachable");
    // A REAL delay, not a resolved promise: an un-awaited fetch would let the handler return first,
    // and §3's ordering assertion is the only thing that can tell the two apart.
    await new Promise((r) => setTimeout(r, 20));
    posts.push({ url, init });
    order.push("alert-sent");
    return { ok: true, status: 204 };
  };
};
const restore = () => { console.log = realLog; console.error = realErr; globalThis.fetch = realFetch; };
// ⚠️ TOLERATES A MISSING LINE ON PURPOSE. When an assertion fails, the line it wanted is often
// absent — and a `JSON.parse(undefined)` here would CRASH the suite mid-section, so every later
// section would go unreported. run-suites.mjs makes exactly this point about `&&` chains: the
// failure mode is the reporting, not the stopping. A red suite must still say everything it knows.
const beatOf = (line) => { try { return JSON.parse(String(line).slice(String(line).indexOf("{"))); } catch { return {}; } };
const hasDegraded = () => errs.some((e) => e.startsWith("[budget-sweep-cron][DEGRADED] "));

realLog("╔══════════════════════════════════════════════════════════════════════╗");
realLog("║  THE DEGRADED ALARM — driven, not grepped                            ║");
realLog("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — THE HEALTHY TICK: 200, at INFO, and NOTHING is alerted");
{
  throwFor.clear(); fetchMode = "ok";
  process.env.DD_WATCH_WEBHOOK = "https://example.invalid/hook";
  capture();
  const res = await handler({});
  restore();

  check("returns 200", res.statusCode === 200, `${res.statusCode} ${res.body}`);
  check("⭐ logs at INFO with the tick line", logs.some((l) => l.startsWith("[budget-sweep-cron] {")));
  check("🚨 NO degraded line on a clean tick — the alarm does not cry wolf", !hasDegraded());
  check("🚨 …and NOTHING is pushed to the webhook", posts.length === 0, `posts=${posts.length}`);

  const beat = beatOf(logs.find((l) => l.startsWith("[budget-sweep-cron] {")));
  check("⭐⭐ a readable-but-empty count reports 0, NOT null — the distinction the flip condition rides on",
    beat.wouldReverseTotal === 0, `wouldReverseTotal=${JSON.stringify(beat.wouldReverseTotal)}`);
  check("errors 0 on the healthy path", beat.errors === 0);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨🚨 THE STORE THROWS: the live failure shape now answers 500");
{
  throwFor.add("data-budget"); throwFor.add("budget-sweep-heartbeat");
  fetchMode = "ok";
  capture();
  const res = await handler({});
  restore();

  check("🚨🚨 returns 500 — a failed sweep no longer wears a success's clothes",
    res.statusCode === 500, `${res.statusCode} ${res.body}`);
  check("⭐⭐ the verdict is on console.ERROR, so it is greppable as a failure", hasDegraded());
  check("🚨 …and NOT on the INFO channel — a DEGRADED tick must not also print a clean line",
    !logs.some((l) => l.startsWith("[budget-sweep-cron] {")));

  const beat = beatOf(errs.find((e) => e.startsWith("[budget-sweep-cron][DEGRADED] ")));
  check("⭐ errors > 0 is what tripped it", beat.errors > 0, `errors=${beat.errors}`);
  check("⭐⭐ the cumulative count is null — COULD NOT COUNT, never 0 = 'none observed'",
    beat.wouldReverseTotal === null, `wouldReverseTotal=${JSON.stringify(beat.wouldReverseTotal)}`);
  check("⭐ this reproduces the five dead prod ticks exactly (open 0, resolved 0, errors 1)",
    beat.open === 0 && beat.resolved === 0 && beat.errors === 1);
  check("⚠️ …and the line warns against reading a quiet heartbeat as health",
    /Do NOT read a quiet heartbeat as health/.test(errs.find(hasDegradedLine) ?? ""));
}
function hasDegradedLine(e) { return e.startsWith("[budget-sweep-cron][DEGRADED] "); }

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE ALERT LEAVES THE PROCESS — and is AWAITED");
{
  throwFor.add("data-budget"); throwFor.add("budget-sweep-heartbeat");
  fetchMode = "ok";
  process.env.DD_WATCH_WEBHOOK = "https://example.invalid/hook";
  capture();
  const res = await handler({});
  const sentBeforeReturn = order.includes("alert-sent");
  restore();

  check("exactly ONE webhook POST", posts.length === 1, `posts=${posts.length}`);
  check("⭐⭐ …and it completed BEFORE the handler returned — a scheduled function can be frozen at return",
    sentBeforeReturn);
  check("it POSTs JSON", posts[0]?.init?.method === "POST" &&
    posts[0]?.init?.headers?.["Content-Type"] === "application/json");
  check("⭐ to DD_WATCH_WEBHOOK, the service-integrity channel", posts[0]?.url === "https://example.invalid/hook");

  const body = JSON.parse(posts[0]?.init?.body ?? "{}").content ?? "";
  check("⭐ the alert names the sweep and says it did not complete", /budget-sweep/.test(body) && /DEGRADED/.test(body));
  check("⭐⭐ …and reports the cumulative count as UNREADABLE, not as a number",
    /UNREADABLE/.test(body), body.slice(0, 120));
  check("⚠️ …and tells the reader a silent sweeper is NOT evidence of health",
    /NOT evidence of health/.test(body));
  check("still 500 after alerting", res.statusCode === 500);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — 🚨 NO CHANNEL CONFIGURED: the absence is LOUD, and there is no fallback");
{
  throwFor.add("data-budget"); throwFor.add("budget-sweep-heartbeat");
  fetchMode = "ok";
  delete process.env.DD_WATCH_WEBHOOK;
  capture();
  const res = await handler({});
  restore();

  check("🚨 an unset channel is announced on its own line — absence must not read as safe",
    errs.some((e) => e.startsWith("[budget-sweep-cron][NO-ALERT-CHANNEL] ")));
  check("🚨🚨 …and NOTHING is posted anywhere — no fallback channel is invented",
    posts.length === 0, `posts=${posts.length}`);
  check("the DEGRADED verdict still stands", hasDegraded());
  check("still 500", res.statusCode === 500);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐⭐ AN UNREADABLE COUNT ALONE IS DEGRADED — errors 0 is not enough");
{
  // The budget store answers; ONLY the heartbeat store fails. So the sweep completes with errors 0
  // and the cumulative count is null. If the gate read errors alone, this tick would report 200 and
  // a `wouldReverseTotal:null` would slide past as a healthy sweep.
  throwFor.clear(); throwFor.add("budget-sweep-heartbeat");
  fetchMode = "ok";
  process.env.DD_WATCH_WEBHOOK = "https://example.invalid/hook";
  capture();
  const res = await handler({});
  restore();

  const beat = beatOf(errs.find(hasDegradedLine) ?? logs.find((l) => l.startsWith("[budget-sweep-cron] {")) ?? "{}");
  check("the sweep itself reported NO errors — only the count was unreadable",
    beat.errors === 0, `errors=${beat.errors}`);
  check("⭐⭐ …and it is STILL degraded: 500, not 200", res.statusCode === 500, `${res.statusCode}`);
  check("⭐ …on the error channel", hasDegraded());
  check("⭐ …and it alerted", posts.length === 1, `posts=${posts.length}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⚠️ THE ALERT PATH ITSELF FAILS: report it, never mask the outage behind it");
{
  throwFor.add("data-budget"); throwFor.add("budget-sweep-heartbeat");
  fetchMode = "throw";
  process.env.DD_WATCH_WEBHOOK = "https://example.invalid/hook";
  capture();
  let threw = null;
  let res = null;
  try { res = await handler({}); } catch (e) { threw = e; }
  restore();

  check("🚨 a dead webhook does NOT take the tick down with it", threw === null,
    threw ? String(threw.message) : "");
  check("⭐ the alert failure gets its own line", errs.some((e) => e.startsWith("[budget-sweep-cron][ALERT-FAILED] ")));
  check("⭐⭐ …and the ORIGINAL degraded verdict survives it — the outage is not masked by the alarm's outage",
    hasDegraded());
  check("still 500", res?.statusCode === 500, `${res?.statusCode}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — ⚠️ WHAT THIS SUITE DOES *NOT* PROVE");
{
  const fs = await import("node:fs");
  const src = fs.readFileSync("scripts/verify-sweep-degraded.mjs", "utf8");
  // Stated as an assertion so it cannot quietly rot out of the header: the next reader must not
  // come away believing the cron is now fully covered in-process.
  check("⭐⭐ the header records that the absent-Blobs-CONTEXT half stays untestable here",
    /genuinely untestable here/.test(src) && /binding-tested-across-what-it-binds/.test(src));
  check("⭐ …and that the live log remains its proof", /the live log stays its real proof/.test(src));
}

realLog("\n╔══════════════════════════════════════════════════════════════════════");
realLog(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
realLog("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
