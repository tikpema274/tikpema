// spike-step8b-sweeper.mjs — STEP 8, part 3: mock-prove the budget sweeper.
//
// ═══ ZERO MONEY, ZERO NETWORK ═══
// @netlify/blobs is in-memory; `circle()` is a SCRIPTED getTransaction. Nothing is submitted,
// nothing is read from a chain, no Circle API is contacted.
//
// ═══ 🚨 WHY EVERY NEGATIVE CASE RE-READS THE LEDGER ═══
// The sweeper is the only scheduled function that can WIDEN a cap. Almost every assertion here is an
// ABSENCE assertion ("it did NOT reverse"), and a bug could report `left` while having mutated. So
// each non-reversal case asserts against a **daySpend RE-READ**, never the sweeper's own tally.
// ⚠️ And the instrumentation self-check runs FIRST: absence assertions are worthless if the store
// under test isn't the one being written, or the scripted resolver isn't attached.
//
// RUN:  node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-step8b-sweeper.mjs

import { mock } from "node:test";

const OWNER = "0x6fb28d6366e755e0e27307692282490c6682fc58";
const HOUR = 60 * 60 * 1000;

// ── in-memory @netlify/blobs. Maps are tracked so cases can be ISOLATED by CLEARING them —
//    _budget caches its store adapter, so replacing the container object would not reset anything. ──
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
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(opts) { const p = opts?.prefix ?? ""; return { blobs: [...m.keys()].filter((x) => x.startsWith(p)).map((key) => ({ key })) }; },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });

// ── SCRIPTED Circle: id -> { state } | { throw }. Every call is counted per id. ──
const SCRIPT = new Map();
const calls = new Map();
const realCircleMod = await import("../../netlify/functions/_circle.mjs");
mock.module("../../netlify/functions/_circle.mjs", {
  namedExports: {
    ...realCircleMod,
    circle: () => ({
      getTransaction: async ({ id }) => {
        calls.set(id, (calls.get(id) ?? 0) + 1);
        const s = SCRIPT.get(id);
        if (!s) throw new Error(`no script for ${id}`);
        if (s.throw) throw new Error(s.throw);
        return { data: { transaction: { state: s.state, txHash: s.txHash ?? null } } };
      },
    }),
  },
});

const { sweep: sweepFn } = await import("../../netlify/functions/budget-sweep.mjs"); // pure internal fn — NOT the auth-guarded HTTP handler
const { recordAgentSpend, daySpend, reverseAgentSpend } = await import("../../netlify/functions/_budget.mjs");

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const reset = () => { maps.forEach((m) => m.clear()); SCRIPT.clear(); calls.clear(); };
const budget = () => maps.find((m) => m._n && m._n !== "budget-sweep-heartbeat");
const keys = () => [...(budget()?.keys() ?? [])];
const marked = (id) => keys().some((k) => k.endsWith(`resolution-${id}`));
const reversedKey = (id) => keys().some((k) => k.endsWith(`reversal-${id}`));
const dayRecOf = (at) => budget().get(`day:${OWNER.toLowerCase()}:${new Date(at).toISOString().slice(0, 10)}`)?.value;

async function seedCharge({ id, amount = 1, ageMs }) {
  const at = new Date(Date.now() - ageMs).toISOString();
  await recordAgentSpend({ owner: OWNER, amountUsdc: amount, source: "swap_tokens", justification: "t", at, confirmation: "submitted", circleId: id });
  return at;
}
const sweep = async () => sweepFn(); // sweep() returns the beat object directly

console.log(`\n════ STEP 8 · PART 3 · budget sweeper — ZERO MONEY, ZERO NETWORK ════`);

// ═══ 0 · INSTRUMENTATION SELF-CHECK — before ANY absence assertion ═══
console.log(`\n── 0 · instrumentation self-check ──`);
{
  reset();
  const at = await seedCharge({ id: "probe", ageMs: 7 * HOUR });
  SCRIPT.set("probe", { state: "COMPLETE" });
  const storeLive = (await daySpend({ owner: OWNER, at })) === 1;
  const beat = await sweep();
  const resolverLive = (calls.get("probe") ?? 0) > 0;
  check("blobs store is LIVE (a charge lands and reads back)", storeLive, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("scripted resolver is ATTACHED (the sweeper actually queried it)", resolverLive, `getTransaction calls=${calls.get("probe") ?? 0}`);
  check("the sweeper saw the open charge", beat.open === 1, `open=${beat.open}`);
  if (!storeLive || !resolverLive) { console.error("\n✖ ABORT — instrumentation not attached; every \"did NOT reverse\" assertion below would pass VACUOUSLY."); process.exit(2); }
}

// ═══ 1 · ⭐ THE SLOW-BUT-REAL CASE — the primary fail-open vector ═══
console.log(`\n── 1 · ⭐ slow-but-real: pending first, COMPLETE later — must NEVER be reversed ──`);
{
  reset();
  const at = await seedCharge({ id: "slow", ageMs: 7 * HOUR });
  SCRIPT.set("slow", { state: "SENT" });
  const b1 = await sweep();
  check("tick 1 (SENT): LEFT — daySpend UNCHANGED (re-read)", (await daySpend({ owner: OWNER, at })) === 1, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("tick 1: not marked resolved (will be re-swept)", !marked("slow") && b1.leftPending === 1, `marked=${marked("slow")} leftPending=${b1.leftPending}`);
  check("tick 1: no reversal record exists", !reversedKey("slow"), "no reversal- key");

  SCRIPT.set("slow", { state: "COMPLETE", txHash: "0xabc" });
  const b2 = await sweep();
  check("⭐ tick 2 (COMPLETE): still NOT reversed — daySpend STILL 1 (re-read)", (await daySpend({ owner: OWNER, at })) === 1, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("tick 2: retired (marked resolved), reversed counter never fired", marked("slow") && b2.reversed === 0 && b2.resolved === 1, `marked=${marked("slow")} reversed=${b2.reversed}`);
  check("no reversal record was ever written for a swap that landed", !reversedKey("slow"), "no reversal- key");
}

// ═══ 2 · AGE FILTER ═══
console.log(`\n── 2 · age filter: younger than RESOLVE_AFTER_MS (30m) is not even queried ──`);
{
  reset();
  const at = await seedCharge({ id: "young", ageMs: 10 * 60 * 1000 }); // 10 min — inside the 30m threshold
  SCRIPT.set("young", { state: "FAILED" }); // would reverse IF it were resolved
  const b = await sweep();
  check("not selected (open=0)", b.open === 0, `open=${b.open}`);
  check("getTransaction NOT called for it", (calls.get("young") ?? 0) === 0, `calls=${calls.get("young") ?? 0}`);
  check("daySpend UNCHANGED (re-read) — even though its scripted state is FAILED", (await daySpend({ owner: OWNER, at })) === 1, `daySpend=${await daySpend({ owner: OWNER, at })}`);
}

// ═══ 3 · TERMINAL-FAILED → the ONLY reversal branch ═══
console.log(`\n── 3 · terminal FAILED → reverse (the only branch that reverses) ──`);
for (const state of ["FAILED", "CANCELLED", "DENIED"]) {
  reset();
  const at = await seedCharge({ id: `t-${state}`, ageMs: 7 * HOUR });
  SCRIPT.set(`t-${state}`, { state });
  const b = await sweep();
  const rec = dayRecOf(at);
  check(`${state}: daySpend decremented by exactly the charge (1 → 0)`, (await daySpend({ owner: OWNER, at })) === 0, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check(`${state}: reversal record + resolution marker both written, reversed=1`, reversedKey(`t-${state}`) && marked(`t-${state}`) && b.reversed === 1, `rev=${reversedKey(`t-${state}`)} marked=${marked(`t-${state}`)}`);
  check(`${state}: id recorded once in reversedIds`, JSON.stringify(rec.reversedIds) === JSON.stringify([`t-${state}`]), JSON.stringify(rec.reversedIds));
}

// ═══ 4 · UNREADABLE → LEAVE (instance-5 family, in the fail-open direction) ═══
console.log(`\n── 4 · unreadable → LEAVE, never reverse (and retried first) ──`);
{
  reset();
  const at = await seedCharge({ id: "unread", ageMs: 7 * HOUR });
  SCRIPT.set("unread", { throw: "request limit reached" }); // transient ⇒ withRetry should retry
  const b = await sweep();
  check("daySpend UNCHANGED (re-read) — never reverse on a failed read", (await daySpend({ owner: OWNER, at })) === 1, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("NOT reversed and NOT marked (stays queued for the next tick)", !reversedKey("unread") && !marked("unread"), `rev=${reversedKey("unread")} marked=${marked("unread")}`);
  check("counted as leftUnreadable (distinct from pending)", b.leftUnreadable === 1 && b.leftPending === 0, `unreadable=${b.leftUnreadable} pending=${b.leftPending}`);
  check("THROTTLE-HARDENED: the transient error was RETRIED, not taken at face value", (calls.get("unread") ?? 0) > 1, `getTransaction calls=${calls.get("unread")}`);

  // and once it becomes readable, it resolves normally — a throttle does not consume the charge
  SCRIPT.set("unread", { state: "COMPLETE" });
  await sweep();
  check("…and once readable it retires cleanly, still never reversed", marked("unread") && !reversedKey("unread") && (await daySpend({ owner: OWNER, at })) === 1, `daySpend=${await daySpend({ owner: OWNER, at })}`);
}

// ═══ 5 · UNMODELLED STATE → LEAVE + counted separately ═══
console.log(`\n── 5 · unmodelled state → LEAVE, counted apart from pending ──`);
{
  reset();
  const at = await seedCharge({ id: "weird", ageMs: 7 * HOUR });
  SCRIPT.set("weird", { state: "SOMETHING_NEW" });
  const b = await sweep();
  check("daySpend UNCHANGED (re-read)", (await daySpend({ owner: OWNER, at })) === 1, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("not reversed, not marked", !reversedKey("weird") && !marked("weird"), "left in queue");
  check("counted as leftUnmodelled, NOT leftPending (a surprise stays visible)", b.leftUnmodelled === 1 && b.leftPending === 0, `unmodelled=${b.leftUnmodelled} pending=${b.leftPending}`);
}

// ═══ 6 · EXACTLY-ONCE ACROSS THREE SWEEPS ═══
console.log(`\n── 6 · exactly-once across three sweeps ──`);
{
  reset();
  const at = await seedCharge({ id: "once", ageMs: 7 * HOUR });
  SCRIPT.set("once", { state: "FAILED" });
  const b1 = await sweep(); const b2 = await sweep(); const b3 = await sweep();
  const rec = dayRecOf(at);
  check("daySpend moved exactly ONCE by VALUE (0, not −1 or −2)", (await daySpend({ owner: OWNER, at })) === 0, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("reversedIds contains the id exactly once", rec.reversedIds.filter((x) => x === "once").length === 1, JSON.stringify(rec.reversedIds));
  check("only tick 1 reversed; ticks 2-3 saw nothing open", b1.reversed === 1 && b2.open === 0 && b3.open === 0, `t1=${b1.reversed} t2.open=${b2.open} t3.open=${b3.open}`);
  check("ticks 2-3 did not re-query Circle (retired by the key scan)", calls.get("once") === 1, `calls=${calls.get("once")}`);
}

// ═══ 7 · CRASH SIM — reversed, crashed before marking ═══
console.log(`\n── 7 · crash sim: CAS applied but the marker never written ──`);
{
  reset();
  const at = await seedCharge({ id: "crash", ageMs: 7 * HOUR });
  SCRIPT.set("crash", { state: "FAILED" });
  // Simulate the exact mid-primitive crash: day record already decremented and the id in
  // reversedIds, but NO reversal- audit key (the append never happened).
  const dayK = `day:${OWNER.toLowerCase()}:${new Date(at).toISOString().slice(0, 10)}`;
  const cur = budget().get(dayK).value;
  budget().set(dayK, { value: { ...cur, spentUsdc: 0, reversedIds: ["crash"] }, etag: "eX" });
  check("precondition: decremented, in reversedIds, but NOT marked", (await daySpend({ owner: OWNER, at })) === 0 && !marked("crash") && !reversedKey("crash"), "mid-primitive state staged");

  const b = await sweep();
  check("recovery: the reversal NO-OPS (already reversed) — daySpend still 0, never −1", (await daySpend({ owner: OWNER, at })) === 0, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("counted as alreadyReversed, and the charge is now RETIRED", b.alreadyReversed === 1 && marked("crash"), `alreadyReversed=${b.alreadyReversed} marked=${marked("crash")}`);
  const b2 = await sweep();
  check("…and it is not re-swept forever", b2.open === 0, `open=${b2.open}`);
}

// ═══ 8 · ESCALATION — unreadable past 24h ═══
console.log(`\n── 8 · escalation: unreadable past ESCALATE_AFTER_MS (24h) ──`);
{
  reset();
  const at = await seedCharge({ id: "old", ageMs: 25 * HOUR });
  SCRIPT.set("old", { throw: "request limit reached" });
  const b = await sweep();
  check("daySpend UNCHANGED — escalation NEVER reverses", (await daySpend({ owner: OWNER, at })) === 1, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("escalated + retired with an explicit UNRESOLVED outcome (it does not vanish)", b.escalated === 1 && marked("old"), `escalated=${b.escalated} marked=${marked("old")}`);
  check("no reversal record", !reversedKey("old"), "none");
  const detail = (b.details || []).find((d) => d.id === "old");
  check("the reason is preserved for a human", !!detail?.why && detail.action === "escalated", JSON.stringify(detail));
}

// ═══ 9 · COMPLETE RETIREMENT — not re-queried forever ═══
console.log(`\n── 9 · COMPLETE is retired, not re-queried every tick ──`);
{
  reset();
  const at = await seedCharge({ id: "done", ageMs: 7 * HOUR });
  SCRIPT.set("done", { state: "COMPLETE" });
  await sweep();
  const b2 = await sweep();
  check("daySpend UNCHANGED (re-read) — COMPLETE never reverses", (await daySpend({ owner: OWNER, at })) === 1, `daySpend=${await daySpend({ owner: OWNER, at })}`);
  check("tick 2 sees nothing open and does not re-query", b2.open === 0 && calls.get("done") === 1, `open=${b2.open} calls=${calls.get("done")}`);
}

console.log(`\n════ VERDICT — STEP 8 PART 3 ════`);
console.log(fails === 0
  ? `✅ PASS — exactly ONE branch reverses (terminal FAILED/CANCELLED/DENIED). Pending, unmodelled,\n   unreadable, too-young and escalated ALL leave the charge standing, each verified by a daySpend\n   RE-READ rather than the sweeper's own tally. The slow-but-real swap — pending then COMPLETE — is\n   never reversed. Exactly-once holds across three sweeps and across a mid-primitive crash.\n   NOT proven here: behaviour against REAL Circle responses — that is the forced-failure run.`
  : `❌ FAIL — ${fails} assertion(s) above.`);
console.log(`\n  (zero money, zero network: in-memory blobs + a scripted resolver.)`);
process.exit(fails === 0 ? 0 : 1);
