// spike-step8a-reversal-primitive.mjs — STEP 8, part 1: mock-prove `reverseAgentSpend`.
//
// ═══ ZERO MONEY, ZERO NETWORK ═══
// Pure bookkeeping. `_budget.mjs` takes an injectable `store` (pickStore(store) ?? defaultStore),
// so this passes its OWN in-memory adapter — no Blobs, no Circle, no chain, nothing to mock.
//
// ═══ 🚨 WHY THE ASSERTIONS ARE SHAPED THIS WAY ═══
// `reverseAgentSpend` is the ONLY function in _budget.mjs that can WIDEN a cap. Every failure mode
// here is fail-OPEN: a wrong reversal credits budget the user never spent. So the refusal cases are
// asserted TWICE — the return value says `refused`, AND the ledger is re-read to prove it did not
// move. A refusal that returned the right string while quietly decrementing would pass a
// return-value-only test.
//
// ⚠️ INSTRUMENTATION SELF-CHECK FIRST (step-5A lesson): every "the ledger did NOT change" assertion
// is VACUOUS if the store under test isn't the one being written. So before any such assertion, we
// prove the injected store IS live (a known-good write lands in it and is readable back). If that
// fails the run ABORTS — an unverified instrument is worse than no instrument.
//
// RUN:  node --env-file=.env scripts/spikes/spike-step8a-reversal-primitive.mjs

import {
  recordAgentSpend, reverseAgentSpend, daySpend, agentBreakdown,
} from "../../netlify/functions/_budget.mjs";

const OWNER = "0x6fb28d6366e755e0e27307692282490c6682fc58";

// ── in-memory store adapter, matching _budget.mjs's documented contract exactly ──
//    getJSON · setJSON · getWithEtag · setIfMatch · setIfNew · list(prefix) -> string[]
function makeStore() {
  const m = new Map();
  let seq = 0;
  const stats = { writes: 0, casAttempts: 0, casLosses: 0 };
  return {
    _m: m, _stats: stats,
    async getJSON(k) { return m.get(k)?.value ?? null; },
    async setJSON(k, v) { stats.writes++; m.set(k, { value: v, etag: `e${++seq}` }); },
    async getWithEtag(k) { const e = m.get(k); return { value: e?.value ?? null, etag: e?.etag }; },
    async setIfMatch(k, v, etag) {
      stats.casAttempts++;
      const cur = m.get(k);
      if ((cur?.etag ?? undefined) !== etag) { stats.casLosses++; return false; }
      stats.writes++; m.set(k, { value: v, etag: `e${++seq}` }); return true;
    },
    async setIfNew(k, v) { if (m.has(k)) return false; stats.writes++; m.set(k, { value: v, etag: `e${++seq}` }); return true; },
    async list(prefix) { return [...m.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const dayRec = async (store, date) => store.getJSON(`day:${OWNER.toLowerCase()}:${date}`);
const audits = async (store) => (await store.list("audit:")).map((k) => store._m.get(k).value);
const iso = (s) => new Date(s).toISOString();

// Record a charge and hand back the audit entry it produced (that IS the primitive's input).
async function charge(store, { amountUsdc, circleId, confirmation = "submitted", at }) {
  const before = (await audits(store)).length;
  await recordAgentSpend({ owner: OWNER, amountUsdc, source: "swap_tokens", justification: "test", store, at, confirmation, circleId });
  const all = await audits(store);
  return all[before]; // the entry just written
}

console.log(`\n════ STEP 8 · PART 1 · reverseAgentSpend — ZERO MONEY, ZERO NETWORK ════`);

// ═══ 0 · INSTRUMENTATION SELF-CHECK — before ANY "did not change" assertion ═══
console.log(`\n── 0 · instrumentation self-check ──`);
{
  const s = makeStore();
  await recordAgentSpend({ owner: OWNER, amountUsdc: 1, source: "probe", justification: "probe", store: s });
  const seen = await daySpend({ owner: OWNER, store: s });
  const ok = s._stats.writes > 0 && seen === 1;
  check("the INJECTED store is live (a known write lands in it and reads back)", ok, `writes=${s._stats.writes} daySpend=${seen}`);
  if (!ok) { console.error("\n✖ ABORT — the store under test is not the one being written. Every \"ledger did not move\" assertion below would pass VACUOUSLY."); process.exit(2); }
}

// ═══ 1 · REFUSALS — "we cannot know" ⇒ DON'T reverse. Each must leave the charge standing. ═══
console.log(`\n── 1 · refusals (safety by construction) ──`);
for (const [label, mutate, why] of [
  ["confirmation:'confirmed' (a chain-witnessed DCA fill)", (e) => ({ ...e, confirmation: "confirmed" }), "confirmation !== 'submitted'"],
  ["missing circleId (unresolvable entry)", (e) => ({ ...e, circleId: undefined }), "no circleId"],
  ["unusable amount (NaN)", (e) => ({ ...e, amountUsdc: NaN }), "unusable amount"],
]) {
  const s = makeStore();
  const entry = await charge(s, { amountUsdc: 1, circleId: "cid-refuse" });
  const before = await daySpend({ owner: OWNER, store: s });
  const r = await reverseAgentSpend({ entry: mutate(entry), reason: "test", store: s });
  const after = await daySpend({ owner: OWNER, store: s });
  check(`REFUSED: ${label}`, r.reversed === false && String(r.refused).includes(why.split(" ")[0]), `refused="${r.refused}"`);
  check(`   …and the ledger did NOT move (re-read, not just the return value)`, before === after && after === 1, `daySpend ${before} → ${after}`);
}

// ═══ 2 · HAPPY PATH ═══
console.log(`\n── 2 · happy path: a submitted charge that never confirmed ──`);
{
  const s = makeStore();
  const entry = await charge(s, { amountUsdc: 1, circleId: "cid-happy" });
  const r = await reverseAgentSpend({ entry, reason: "swap FAILED", store: s });
  const rec = await dayRec(s, entry.date);
  const rev = (await audits(s)).find((e) => e.kind === "reversal");
  check("reversed:true and the amount comes from the ENTRY (not re-derived)", r.reversed === true && r.amountUsdc === 1, JSON.stringify(r));
  check("day-spend decremented to 0", (await daySpend({ owner: OWNER, store: s })) === 0, `spentUsdc=${rec.spentUsdc}`);
  check("reversedIds contains the id exactly once", JSON.stringify(rec.reversedIds) === JSON.stringify(["cid-happy"]), JSON.stringify(rec.reversedIds));
  check("APPEND-not-negate: a kind:'reversal' entry exists, POSITIVE amount, pointing at what it reverses", rev?.kind === "reversal" && rev?.amountUsdc === 1 && rev?.reverses === "cid-happy", JSON.stringify(rev && { kind: rev.kind, amt: rev.amountUsdc, reverses: rev.reverses }));
  check("the ORIGINAL charge entry is untouched (immutable trail)", (await audits(s)).some((e) => e.confirmation === "submitted" && e.amountUsdc === 1 && !e.kind), "original still present, unmodified");
  check("no needsAttention flag on a clean reversal", !rec.needsAttention, `needsAttention=${rec.needsAttention}`);
}

// ═══ 3 · IDEMPOTENCY — sequential and racing ═══
console.log(`\n── 3 · idempotency (structural exactly-once) ──`);
{
  const s = makeStore();
  const entry = await charge(s, { amountUsdc: 1, circleId: "cid-idem" });
  const r1 = await reverseAgentSpend({ entry, reason: "first", store: s });
  const r2 = await reverseAgentSpend({ entry, reason: "second", store: s });
  const rec = await dayRec(s, entry.date);
  check("first call reverses, second NO-OPS", r1.reversed === true && r2.reversed === false, `r1=${r1.reversed} r2=${r2.reversed} (${r2.refused})`);
  check("day-spend moved exactly ONCE by VALUE (0, not −1)", rec.spentUsdc === 0, `spentUsdc=${rec.spentUsdc}`);
  check("…and exactly once by SET (id appears once in reversedIds)", rec.reversedIds.filter((x) => x === "cid-idem").length === 1, JSON.stringify(rec.reversedIds));
  check("only ONE reversal entry in the trail", (await audits(s)).filter((e) => e.kind === "reversal").length === 1, "1 expected");
}
{
  const s = makeStore();
  const entry = await charge(s, { amountUsdc: 1, circleId: "cid-race" });
  const [a, b] = await Promise.all([
    reverseAgentSpend({ entry, reason: "racer A", store: s }),
    reverseAgentSpend({ entry, reason: "racer B", store: s }),
  ]);
  const rec = await dayRec(s, entry.date);
  const winners = [a, b].filter((x) => x.reversed).length;
  check("RACE: two concurrent reversals → exactly ONE wins", winners === 1, `A=${a.reversed} B=${b.reversed}, casLosses=${s._stats.casLosses}`);
  check("RACE: day-spend still moved only once", rec.spentUsdc === 0 && rec.reversedIds.length === 1, `spentUsdc=${rec.spentUsdc} ids=${JSON.stringify(rec.reversedIds)}`);
}

// ═══ 4 · ZERO-CLAMP + FLAG ═══
console.log(`\n── 4 · zero-clamp + needsAttention (a negative counter WIDENS the cap) ──`);
{
  const s = makeStore();
  const entry = await charge(s, { amountUsdc: 1, circleId: "cid-clamp" });
  const r = await reverseAgentSpend({ entry: { ...entry, amountUsdc: 5 }, reason: "over-reverse", store: s });
  const rec = await dayRec(s, entry.date);
  check("clamps at 0 — never negative", rec.spentUsdc === 0, `spentUsdc=${rec.spentUsdc}`);
  check("⭐ needsAttention:true is SET (a silent clamp would hide an upstream bug)", rec.needsAttention === true, `needsAttention=${rec.needsAttention}`);
  check("the call reports it clamped", r.reversed === true && r.clamped === true, JSON.stringify(r));
}

// ═══ 5 · ⭐ THE DAY-BOUNDARY TRAP ═══
console.log(`\n── 5 · ⭐ day boundary: charge 23:58 yesterday, swept 00:03 today ──`);
{
  const s = makeStore();
  const chargeAt = "2026-07-21T23:58:00.000Z";
  const sweepAt = "2026-07-22T00:03:00.000Z";
  const entry = await charge(s, { amountUsdc: 1, circleId: "cid-boundary", at: chargeAt });
  check("charge landed in YESTERDAY's bucket", entry.date === "2026-07-21", `entry.date=${entry.date}`);
  const r = await reverseAgentSpend({ entry, reason: "swept next day", store: s, at: sweepAt });
  const yesterday = await dayRec(s, "2026-07-21");
  const today = await dayRec(s, "2026-07-22");
  check("reversal hit YESTERDAY's counter (the charge's day)", r.reversed === true && yesterday.spentUsdc === 0, `yesterday spentUsdc=${yesterday.spentUsdc}`);
  check("⭐ TODAY's counter is UNTOUCHED — no phantom credit created", today === null, `today record=${today === null ? "absent (correct)" : JSON.stringify(today)}`);
  const rev = (await audits(s)).find((e) => e.kind === "reversal");
  check("the reversal entry is filed in the CHARGE's day bucket (so per-day views net correctly)", rev?.date === "2026-07-21", `rev.date=${rev?.date}`);
  check("…and the real sweep time is preserved as reversedAt (information not lost)", iso(rev?.reversedAt) === iso(sweepAt), `reversedAt=${rev?.reversedAt}`);
}

// ═══ 6 · DEFENSIVE READ — an old day record with no reversedIds ═══
console.log(`\n── 6 · defensive read: legacy day record with NO reversedIds field ──`);
{
  const s = makeStore();
  const entry = await charge(s, { amountUsdc: 1, circleId: "cid-legacy" });
  // Strip the field, simulating a record written before reversedIds existed. NO migration is run.
  const key = `day:${OWNER.toLowerCase()}:${entry.date}`;
  const { spentUsdc, date, owner } = (await s.getJSON(key));
  await s.setJSON(key, { spentUsdc, date, owner }); // legacy shape, no reversedIds
  check("precondition: the record genuinely has no reversedIds", (await s.getJSON(key)).reversedIds === undefined, "field absent");
  const r = await reverseAgentSpend({ entry, reason: "legacy record", store: s });
  const rec = await s.getJSON(key);
  check("reversal works against a legacy record (missing treated as empty, no crash)", r.reversed === true && rec.spentUsdc === 0, `spentUsdc=${rec.spentUsdc}`);
  check("…and the field is created on write", JSON.stringify(rec.reversedIds) === JSON.stringify(["cid-legacy"]), JSON.stringify(rec.reversedIds));
}

// ═══ 7 · agentBreakdown consumer ═══
console.log(`\n── 7 · agentBreakdown nets correctly ──`);
{
  const s = makeStore();
  const e1 = await charge(s, { amountUsdc: 1, circleId: "cid-bd-1" });
  await charge(s, { amountUsdc: 2, circleId: "cid-bd-2" });
  const beforeBd = (await agentBreakdown({ owner: OWNER, date: e1.date, store: s }))[0];
  await reverseAgentSpend({ entry: e1, reason: "failed", store: s });
  const bd = (await agentBreakdown({ owner: OWNER, date: e1.date, store: s }))[0];
  check("spentUsdc nets to the right total (3 − 1 = 2)", bd.spentUsdc === 2, `spentUsdc=${bd.spentUsdc}`);
  check("reversals counted", bd.reversals === 1, `reversals=${bd.reversals}`);
  check("⭐ ACTIONS UNCHANGED — a reversal is not an action", bd.actions === beforeBd.actions && bd.actions === 2, `actions ${beforeBd.actions} → ${bd.actions}`);
  check("blocked untouched", bd.blocked === 0, `blocked=${bd.blocked}`);
}

console.log(`\n════ VERDICT — STEP 8 PART 1 ════`);
console.log(fails === 0
  ? `✅ PASS — the reversal primitive holds: it REFUSES anything it cannot know (confirmed / no id / bad\n   amount) and leaves the charge standing; reverses exactly once under repeat AND under a CAS race;\n   clamps at zero and RAISES needsAttention; files against the CHARGE's day, never the sweep's; works\n   on legacy records with no migration; and agentBreakdown nets without inflating the action count.\n   NOT proven here: any sweeper behaviour — nothing calls this primitive yet.`
  : `❌ FAIL — ${fails} assertion(s) above.`);
console.log(`\n  (zero money, zero network: an injected in-memory store; no Blobs, no Circle, no chain.)`);
process.exit(fails === 0 ? 0 : 1);
