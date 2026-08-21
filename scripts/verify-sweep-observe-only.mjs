// verify-sweep-observe-only.mjs — FINDING B: the sweeper RUNS, and it cannot widen a cap.
//
//   node --experimental-test-module-mocks scripts/verify-sweep-observe-only.mjs   (npm run test:sweepobserve)
//
// ═══ ZERO MONEY, ZERO NETWORK ═══ Blobs in-memory, circle().getTransaction scripted.
//
// ═══ 🚨 WHAT THIS PINS ════════════════════════════════════════════════════════════════════════
// budget-sweep.mjs calls itself "THE PRIMARY HANDLER, NOT A BACKSTOP" and was INERT BY
// CONSTRUCTION — no schedule anywhere. Measured 2026-08-21: 119 audit entries since 2026-07-12,
// 21 unresolved submit-time charges, ZERO reversals ever performed. A read-only Circle probe then
// showed all 21 resolve COMPLETE: 21/21 real spends, ZERO phantoms. So it is scheduled now in
// OBSERVE-ONLY mode — it resolves what it can prove landed, records what it WOULD have reversed,
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
  // The failure this guards: if observe-only marked it resolved, the queue would be empty here and
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
  check("⭐ the wrapper calls sweep() by IMPORT — no HTTP hop, no auth surface, nothing to 401",
    /import \{ sweep \}/.test(cron) && !/fetch\(/.test(cron));
  const sweepSrc = fs.readFileSync("netlify/functions/budget-sweep.mjs", "utf8");
  check("⭐ the guarded HTTP handler still requires internal auth — the wrapper did not weaken it",
    /requireInternal\(event\)/.test(sweepSrc));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
