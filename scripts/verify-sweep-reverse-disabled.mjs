// verify-sweep-reverse-disabled.mjs — FINDING B: the sweeper RUNS, and it cannot widen a cap.
//
//   node --experimental-test-module-mocks scripts/verify-sweep-reverse-disabled.mjs   (npm run test:sweepobserve)
//
// ═══ ZERO MONEY, ZERO NETWORK ═══ Blobs in-memory, circle().getTransaction scripted.
//
// ═══ 🚨 WHAT THIS PINS ════════════════════════════════════════════════════════════════════════
// budget-sweep.mjs calls itself "THE PRIMARY HANDLER, NOT A BACKSTOP" and was INERT BY
// CONSTRUCTION — no schedule anywhere. Measured 2026-08-21: 119 audit entries since 2026-07-12,
// 21 unresolved submit-time charges, ZERO reversals ever performed. A read-only Circle probe then
// showed all 21 resolve COMPLETE: 21/21 real spends, ZERO phantoms. So it is scheduled now in
// REVERSE-DISABLED mode — it resolves what it can prove landed, records what it WOULD have reversed,
// and reverses nothing.
//
// ⭐⭐ THE ASSERTION THAT MATTERS MOST is section 2: a would-reverse charge must NOT be marked
// resolved. Marking retires it from the queue permanently, so arming reversal later would find an
// EMPTY queue — the observation window would have silently discarded exactly the cases it exists
// to catch. That is a bug you would not notice until the day you needed the data.
import { mock } from "node:test";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const maps = [];
let etagSeq = 0;
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  let m = maps.find((x) => x._n === nm);
  if (!m) { m = new Map(); m._n = nm; maps.push(m); }
  return {
    async get(k, opts) { const e = m.get(k); if (e == null) return null; return opts?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { return m.get(k)?.value ?? null; },
    async setJSON(k, v, opts) {
      const cur = m.get(k);
      if (opts?.onlyIfNew && cur) return { modified: false };
      if (opts?.onlyIfMatch && cur?.etag !== opts.onlyIfMatch) return { modified: false };
      m.set(k, { value: v, etag: `e${++etagSeq}` }); return { modified: true };
    },
    async setIfNew(k, v) { if (m.has(k)) return false; m.set(k, { value: v, etag: `e${++etagSeq}` }); return true; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(pfx) {
      const p = typeof pfx === "string" ? pfx : pfx?.prefix ?? "";
      const keys = [...m.keys()].filter((x) => x.startsWith(p));
      return typeof pfx === "string" ? keys : { blobs: keys.map((key) => ({ key })) };
    },
  };
};
const reset = () => { for (const m of maps) m.clear(); };
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });

let txState = "FAILED";
mock.module("../netlify/functions/_circle.mjs", { namedExports: {
  circle: () => ({ getTransaction: async () => ({ data: { transaction: { state: txState } } }) }),
  waitForTx: async () => "0x0", TxPendingError: class extends Error {},
}});

const budget = await import("../netlify/functions/_budget.mjs");
const { sweep } = await import("../netlify/functions/budget-sweep.mjs");
const fs = await import("node:fs");

const OWNER = "0x058957deff333c47c15c208a4425420af6947f9e";
const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const OLD = NOW - 60 * 60 * 1000;              // 1h old — past RESOLVE_AFTER_MS (30m)

const seed = async (circleId, amountUsdc) =>
  budget.recordAgentSpend({
    owner: OWNER, amountUsdc, source: "swap_tokens", justification: "seeded",
    at: OLD, confirmation: "submitted", circleId,
  });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  FINDING B — the sweeper runs, observes, and CANNOT widen a cap      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 A FAILED CHARGE IS *NOT* REVERSED WHILE DISARMED");
reset(); txState = "FAILED";
{
  await seed("cid-failed-1", 1.5);
  const before = await budget.daySpend({ owner: OWNER, at: OLD });
  const beat = await sweep({ at: NOW });
  const after = await budget.daySpend({ owner: OWNER, at: OLD });

  check("the sweep reports itself DISARMED", beat.reversalsArmed === false);
  check("⭐ it saw the charge", beat.open === 1, `open=${beat.open}`);
  check("🚨🚨 the day ledger is UNTOUCHED — nothing reachable from the schedule widened a cap",
    after === before && after === 1.5, `${before} → ${after}`);
  check("⭐ zero reversals performed", beat.reversed === 0);
  check("⭐⭐ …and it COUNTED what it would have reversed", beat.wouldReverse === 1, `wouldReverse=${beat.wouldReverse}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ AND IT IS *NOT* RETIRED FROM THE QUEUE — the trap this mode must avoid");
{
  const open = await budget.listUnresolvedCharges({ olderThanMs: 0, at: NOW });
  check("🚨🚨 the would-reverse charge is STILL UNRESOLVED — arming later will find it",
    open.length === 1 && open[0].circleId === "cid-failed-1", `${open.length} open`);
  // The failure this guards: if reverse-disabled marked it resolved, the queue would be empty here and
  // the whole observation window would have thrown away the cases it existed to collect.
  const hb = memStore("budget-sweep-heartbeat");
  const observed = await hb.list("observed:");
  check("⭐⭐ durable evidence was written, so the observation OUTLIVES the tick",
    observed.length === 1 && observed[0] === "observed:cid-failed-1", JSON.stringify(observed));
  const ev = await hb.getJSON("observed:cid-failed-1");
  check("  …carrying the state, the amount and the charge's own timestamp",
    ev?.state === "FAILED" && ev?.amountUsdc === 1.5 && !!ev?.chargedAt);
  check("  …and saying plainly that the charge STANDS", /charge STANDS/i.test(ev?.note || ""));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ A CHARGE THAT LANDED IS STILL RESOLVED — the safe half still works");
reset(); txState = "COMPLETE";
{
  await seed("cid-complete-1", 2);
  const beat = await sweep({ at: NOW });
  check("it resolved the COMPLETE charge", beat.resolved === 1, `resolved=${beat.resolved}`);
  check("⭐ …and did not count it as a would-reverse", beat.wouldReverse === 0);
  const open = await budget.listUnresolvedCharges({ olderThanMs: 0, at: NOW });
  check("⭐⭐ …so it leaves the queue — record accuracy, which is the job it CAN do today",
    open.length === 0, `${open.length} open`);
  const after = await budget.daySpend({ owner: OWNER, at: OLD });
  check("🚨 a real spend is left standing, never credited back", after === 2, `daySpend=${after}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ THE CUMULATIVE COUNT SURVIVES TICKS (an observation that doesn't is not a record)");
reset(); txState = "FAILED";
{
  await seed("cid-a", 1); await seed("cid-b", 1);
  const t1 = await sweep({ at: NOW });
  const t2 = await sweep({ at: NOW });          // a second tick must not double-count
  check("tick 1 observed both", t1.wouldReverse === 2, `${t1.wouldReverse}`);
  check("⭐ the CUMULATIVE total is read from durable keys, not from the tick",
    t2.wouldReverseTotal === 2, `total=${t2.wouldReverseTotal}`);
  check("⭐⭐ …and a re-observation does not inflate it — the key is deterministic",
    t2.wouldReverseTotal === t1.wouldReverseTotal, `${t1.wouldReverseTotal} → ${t2.wouldReverseTotal}`);
  check("⚠️ the per-tick heartbeat alone could NOT answer 'has it ever observed anything' — " +
    "it is overwritten every tick, which is why the durable keys exist",
    typeof t2.wouldReverseTotal === "number");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⚠️ THE FLIP CONDITION IS STATED, IN BOTH HALVES, BESIDE THE FLAG");
{
  const src = fs.readFileSync("netlify/functions/budget-sweep.mjs", "utf8");
  check("🔭 reversal is disarmed by an explicit constant", /const REVERSALS_ARMED = false/.test(src));
  check("⭐ HALF 1 — when to ARM is stated, and tied to the post-A population",
    /ARM IT when/.test(src) && /POST-FINDING-A/.test(src));
  check("⭐⭐ HALF 2 — when to RETIRE is stated, so the mode cannot become permanent by inertia",
    /RETIRE IT/.test(src));
  check("🚨🚨 …and the retire half names a REAL DATE, not 'later'", /2026-11-19/.test(src),
    (src.match(/20\d\d-\d\d-\d\d/g) || []).join(" "));
  check("⭐ …and says why a silent sweeper is indistinguishable from a broken one",
    /INDISTINGUISHABLE FROM A BROKEN ONE/.test(src));
  check("⭐ both halves are decidable from DATA — the count is durable, not remembered",
    /decidable from data/i.test(src.replace(/\s+/g, " ")));
  check("⚠️ an uncountable total is null, never 0 — absence must not read as 'none observed'",
    /null = COULD NOT COUNT/.test(src));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — 🚨 THE SCHEDULE POINTS AT THE CRON WRAPPER, NEVER AT THE GUARDED HANDLER");
{
  const toml = fs.readFileSync("netlify.toml", "utf8");
  check("⭐ budget-sweep-cron IS scheduled", /\[functions\."budget-sweep-cron"\]/.test(toml));
  check("🚨🚨 budget-sweep itself is NOT — a cron carries no x-internal-token, so it would 401 " +
    "every tick while LOOKING DEAD", !/\[functions\."budget-sweep"\]/.test(toml));
  const cron = fs.readFileSync("netlify/functions/budget-sweep-cron.mjs", "utf8");
  // ⚠️ NARROWED. This was `!/fetch\(/` over the whole file — fine until the wrapper legitimately
  // gained a fetch for the DEGRADED webhook alert, at which point a correct change turned it red.
  // ⭐ The property is "it does not INVOKE THE SWEEP over HTTP", not "it never makes a request".
  // A proxy that forbids a whole capability will eventually forbid a right answer.
  // ⚠️ SIMPLIFIED after two failed attempts, both my own regex being cleverer than the property:
  //   1. `!/fetch\(/` — forbade a whole capability, and went red when the DEGRADED webhook alert
  //      was legitimately added.
  //   2. `!/fetch\([^)]*budget-sweep/` — matched the ALERT BODY TEXT, which names the function.
  // ⭐ The property is simply: it imports sweep, and no HTTP endpoint path appears in its code.
  const cronCode2 = cron.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("⭐ the wrapper calls sweep() by IMPORT — no HTTP hop to invoke it, nothing to 401",
    /import \{ sweep \}/.test(cron) && !/\.netlify\/functions|["'\`]\/api\//.test(cronCode2));
  const sweepSrc = fs.readFileSync("netlify/functions/budget-sweep.mjs", "utf8");
  check("⭐ the guarded HTTP handler still requires internal auth — the wrapper did not weaken it",
    /requireInternal\(event\)/.test(sweepSrc));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — 🚨 THE TWO DEFECTS THE FIRST LIVE DEPLOY FOUND (and no in-process suite could)");
{
  const cron = fs.readFileSync("netlify/functions/budget-sweep-cron.mjs", "utf8");

  // ── (a) BLOBS CONTEXT ──────────────────────────────────────────────────────────────────────
  // budget-sweep.mjs connects Blobs inside its HTTP handler. Calling sweep() directly bypasses it,
  // so the first deploy's ticks — FIVE of them on 2026-08-21 (19:00:54, 19:30:35, 20:00:48,
  // 20:30:31, 21:00:45 UTC), not the two recorded here originally — fired and did NOTHING:
  // open:0, errors:1, every store call throwing.
  // ⚠️ THIS SUITE MOCKS @netlify/blobs WHOLESALE, so the context is trivially present here and the
  // BEHAVIOURAL half of this is untestable in-process. That is not a gap to paper over: it is
  // [[binding-tested-across-what-it-binds]], and it is why the real proof is the live log line.
  // The assertion below is therefore a SOURCE check, and labelled as one.
  check("⭐⭐ (source) the cron connects Blobs before sweeping — its absence cost two live ticks",
    /connectBlobs\(event\)/.test(cron) && /import \{ connectBlobs \}/.test(cron));
  check("⭐ …and the handler actually takes an event to connect FROM",
    /export async function handler\(event\)/.test(cron));

  // ── (b) A FAILED SWEEP MUST NOT REPORT SUCCESS ─────────────────────────────────────────────
  // The first version logged errors:1 at INFO and returned 200 "swept". A failure wearing a
  // success's clothes — and the heartbeat could not correct it, because writeHeartbeat swallows
  // its own failure, so when BLOBS is what is broken the one signal that would show it is the one
  // that cannot be written.
  // ⭐⭐ THESE FOUR ARE SOURCE CHECKS **ONLY BECAUSE THEY SIT NEXT TO (a)**, AND THAT WAS WRONG.
  // The absent-Blobs-CONTEXT bug above is genuinely untestable in-process. The DEGRADED path is
  // NOT: its trigger is A STORE THROWING, which a mock can do. Conflating the two left a testable
  // alarm unexercised on the grounds that a different, untestable thing was nearby — so it had
  // never fired, in prod or in a suite, and 11h of clean live ticks proved only that it stayed
  // quiet. ⭐ THE BEHAVIOUR IS NOW DRIVEN IN scripts/verify-sweep-degraded.mjs (test:sweepdegraded,
  // 35/0), which throws the store and asserts 500 + console.error + the awaited webhook, and is
  // negative-tested against three mutations of the cron. These stay as cheap structural pins.
  check("🚨🚨 a sweep with errors does NOT return 200 — a failure must not wear a success's clothes",
    /beat\.errors > 0/.test(cron) && /statusCode: 500/.test(cron));
  check("⭐⭐ …and an UNREADABLE cumulative count counts as degraded too, not as 'none observed'",
    /wouldReverseTotal === null/.test(cron));
  check("⭐ …and the degraded line is console.ERROR, not INFO, so it is greppable as a failure",
    /console\.error\("\[budget-sweep-cron\]\[DEGRADED\]/.test(cron));
  check("⚠️ …and it warns explicitly against reading a quiet heartbeat as health",
    /Do NOT read a quiet heartbeat as health/.test(cron));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — 🚨🚨 DETECTION DOES NOT LIVE IN THE STORE IT REPORTS ON");
{
  const cron = fs.readFileSync("netlify/functions/budget-sweep-cron.mjs", "utf8");
  // ⭐ Behaviourally driven in verify-sweep-degraded.mjs §3/§4/§6 — including that the alert is
  // AWAITED (proven by un-awaiting it and watching the assertion go red), that an unset channel
  // invents no fallback, and that a dead webhook does not mask the outage it was reporting.
  check("⭐⭐ a degraded sweep pushes to a WEBHOOK — an alert path with no Blobs dependency",
    /alertDegraded\(/.test(cron) && /DD_WATCH_WEBHOOK/.test(cron) && /await fetch\(url/.test(cron));
  check("⭐ …and the alert is AWAITED — a scheduled function can be frozen at return",
    /await alertDegraded\(/.test(cron));
  // ⚠️ COMMENTS STRIPPED — third time this trap has bitten in one session. The comment explaining
  // WHY not to use those channels names them, so a whole-file regex went red on its own warning.
  // The property is about CODE. (Recorded rather than quietly fixed: it is clearly a habit.)
  const cronCode = cron.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("🚨🚨 NO FALLBACK CHANNEL in code — the strong-read-watch lesson: a convenience default " +
    "silently re-pointed money alerts at the feedback channel",
    !/WATCH_ALERT_WEBHOOK|DISCORD_FEEDBACK_WEBHOOK/.test(cronCode));
  check("⭐⭐ an UNSET channel is logged loudly, not passed over — absence must not read as safe, " +
    "including the absence of the channel that reports absences",
    /NO-ALERT-CHANNEL/.test(cron) && /reached NOBODY/.test(cron));
  check("⚠️ …and the alert text warns the heartbeat may be STALE rather than quiet",
    /NOT evidence of health/.test(cron));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("9 — ⚠️ THE MODE'S NAME MATCHES WHAT IT ACTUALLY DOES");
{
  const src = fs.readFileSync("netlify/functions/budget-sweep.mjs", "utf8");
  // It WRITES: resolution markers, observed: keys, the heartbeat. "observe-only" implied none of
  // that. The name is pinned because a mislabelled mode is easier to write than to notice.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("⭐⭐ the mode does WRITE — markChargeResolved is reachable while disarmed",
    /markChargeResolved/.test(code));
  check("🚨 …so no CODE calls it observe-only", !/observe-only|OBSERVE-ONLY/.test(code));
  check("⭐ …and the rename's reason is recorded where the flag is, not only in a commit message",
    /THAT NAME WAS A LIE ABOUT WHAT IT/.test(src));
  const toml = fs.readFileSync("netlify.toml", "utf8");
  check("⭐ …and netlify.toml does not carry the old name either",
    !/observe-only|OBSERVE-ONLY/.test(toml));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
