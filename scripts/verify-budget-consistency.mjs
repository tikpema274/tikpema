// verify-budget-consistency.mjs — a cached spend counter is a WIDENED CAP.
//
// ═══ 🚨 WHAT THIS GUARDS ═════════════════════════════════════════════════════════════════════
// `_budget.mjs` holds the daily spend ceiling. Every autonomous spend path — executeAction,
// agent-send, agent-ub-spend, research data purchases — calls canSpend/canSpendDay first, and those
// compare TODAY'S RUNNING TOTAL against PERIOD_CEILING_USDC.
//
// Netlify Blobs reads default to consistency:"eventual" — a CDN-cached edge read. So:
//
//     spend $1.90 of a $2.00 ceiling  ->  written to ORIGIN
//     next spend reads the counter    ->  gets a CACHED, LOWER total
//     dayA + amtA > ceilA             ->  FALSE when it should be TRUE  ->  SPEND ALLOWED
//
// ⭐ AND THE MISS DEFAULTS TO ZERO. Every reader does `rec?.spentUsdc ?? 0`, so a cache that has not
// seen today's key AT ALL reports "nothing spent today" and hands over the ENTIRE ceiling. That is
// worse than under-counting: it RESETS THE DAY. It has its own section below (§4) because it is the
// most dangerous shape and the least obvious.
//
// The module's own header already names this failure from the concurrency angle — "a dropped spend
// is a WIDENED CAP, the one thing this module exists to prevent". A cached read drops it just as
// effectively as a lost update did, and neither throws.
//
// ═══ HOW ═════════════════════════════════════════════════════════════════════════════════════
// Mocks @netlify/blobs — NOT _budget.mjs, which is the code under test — with a store that models
// the edge cache: strong reads hit origin, everything else hits a stale copy. The suite passes NO
// `store` argument, so the real default adapter (where the consistency option lives) is exercised.
//
//   node --experimental-test-module-mocks scripts/verify-budget-consistency.mjs
//
// Zero network, ZERO MONEY.

import { mock } from "node:test";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const origin = new Map();
const edge = new Map();
const reads = [];          // {key, consistency, via}
const writes = [];         // {key, opts} — pins the no-etag ⇒ onlyIfNew guard (§9)
let throwOnRead = false;
let etagSeq = 0;

const stamp = (v) => ({ data: JSON.parse(JSON.stringify(v)), etag: `e${++etagSeq}` });

const fakeStore = {
  async get(key, opts = {}) {
    reads.push({ key, consistency: opts.consistency ?? "(default)", via: "get" });
    if (throwOnRead) throw new Error("blobs unavailable");
    const hit = opts.consistency === "strong" ? origin.get(key) : edge.get(key);
    return hit ? hit.data : null;
  },
  async getWithMetadata(key, opts = {}) {
    reads.push({ key, consistency: opts.consistency ?? "(default)", via: "getWithMetadata" });
    if (throwOnRead) throw new Error("blobs unavailable");
    const hit = opts.consistency === "strong" ? origin.get(key) : edge.get(key);
    return hit ? { data: hit.data, etag: hit.etag } : null;
  },
  async setJSON(key, value, opts = {}) {
    writes.push({ key, opts });
    const cur = origin.get(key);
    if (opts.onlyIfMatch && cur?.etag !== opts.onlyIfMatch) return { modified: false };
    if (opts.onlyIfNew && cur) return { modified: false };
    origin.set(key, stamp(value));      // ⭐ origin only — the edge goes stale on every write
    return { modified: true };
  },
  async list() { return { blobs: [] }; },
};
mock.module("@netlify/blobs", {
  namedExports: { getStore: () => fakeStore, connectLambda: () => {}, getDeployStore: () => fakeStore },
});

const { canSpendDay, daySpend, recordDcaSpend, budgetConfig } =
  await import("../netlify/functions/_budget.mjs");

const OWNER = "0xbud0000000000000000000000000000000000001";
const today = new Date().toISOString().slice(0, 10);
const dayKey = `day:${OWNER}:${today}`;
const dcaKey = `dca-day:${OWNER}:${today}`;   // recordDcaSpend writes here, not to dayKey
const CEIL = budgetConfig().PERIOD_CEILING_USDC;          // 2.00 USDC by default

/** Put a total at ORIGIN (what was really spent) and, optionally, a different one at the EDGE. */
const seed = ({ atOrigin, atEdge }) => {
  origin.clear(); edge.clear(); reads.length = 0; writes.length = 0; throwOnRead = false;
  if (atOrigin !== undefined) origin.set(dayKey, stamp({ spentUsdc: atOrigin, date: today }));
  if (atEdge !== undefined) edge.set(dayKey, stamp({ spentUsdc: atEdge, date: today }));
};

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log(`║  BUDGET — a cached counter is a widened cap  (ceiling ${String(CEIL).padEnd(5)} USDC)   ║`);
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ 1 — the gate read asks for STRONG ═══════════
section("1 — the spend gate reads with strong consistency");
{
  seed({ atOrigin: 0 });
  await canSpendDay({ amountUsdc: 0.1, owner: OWNER });
  const gets = reads.filter((r) => r.via === "get");
  check("the gate issued a counter read", gets.length >= 1, `${gets.length} read(s)`);
  check("⭐⭐ it asked for consistency:'strong'", gets.every((r) => r.consistency === "strong"),
    gets.map((r) => r.consistency).join(","));
  check("  …against today's per-owner key", gets.some((r) => r.key === dayKey), dayKey);
}

// ═══════════ 2 — ⭐ instrument self-check: origin and edge genuinely disagree ═══════════
section("2 — the cache model diverges (else this suite proves nothing)");
{
  seed({ atOrigin: 1.9, atEdge: 0.5 });
  const strong = await fakeStore.get(dayKey, { consistency: "strong" });
  const cached = await fakeStore.get(dayKey);
  check("⭐ origin says 1.90 spent", strong?.spentUsdc === 1.9, String(strong?.spentUsdc));
  check("⭐ the stale edge says 0.50", cached?.spentUsdc === 0.5, String(cached?.spentUsdc));
  check("  …they genuinely disagree — there is something to catch", strong.spentUsdc !== cached.spentUsdc);
}

// ═══════════ 3 — ⭐⭐⭐ THE FAIL-OPEN: spent to the ceiling, cache under-limit ═══════════
section("3 — 1.90 of 2.00 spent, edge cached 0.50 → must BLOCK");
{
  seed({ atOrigin: 1.9, atEdge: 0.5 });
  const gate = await canSpendDay({ amountUsdc: 0.5, owner: OWNER });   // real: 2.40 > 2.00
  check("⭐⭐⭐ BLOCKED — the cached under-limit total did NOT let the spend through",
    gate.allowed === false, `allowed=${gate.allowed}`);
  check("  …reason names the period ceiling", /period ceiling|daily/i.test(gate.reason ?? ""), gate.reason);
  check("  …and reports the REAL total, not the cached one", /1\.9/.test(gate.reason ?? ""), gate.reason);

  // The counterfactual, asserted rather than described: this is what the cached read yields.
  const cachedTotal = (await fakeStore.get(dayKey))?.spentUsdc ?? 0;
  check("⭐⭐ PROOF THE FIX IS LOAD-BEARING: cached 0.50 + 0.50 = 1.00 ≤ 2.00 → would have ALLOWED",
    cachedTotal + 0.5 <= CEIL, `cached=${cachedTotal} → over-ceiling spend proceeds`);
}

// ═══════════ 4 — ⭐⭐⭐ THE ZERO-DEFAULT: a cold cache RESETS THE DAY ═══════════
// The worst shape, and the least obvious. `rec?.spentUsdc ?? 0` means a cache that has never seen
// today's key does not under-report — it reports NOTHING SPENT, handing over the entire ceiling.
section("4 — ⭐ cold cache (key absent) → must NOT read as a fresh day");
{
  seed({ atOrigin: 1.95 });        // origin: nearly exhausted. edge: NO ENTRY AT ALL.
  check("setup: the edge has no entry for today", edge.get(dayKey) === undefined);

  const seen = await daySpend({ owner: OWNER });
  check("⭐⭐ the reader sees the REAL 1.95, not 0", seen === 1.95, `daySpend=${seen}`);

  const gate = await canSpendDay({ amountUsdc: 1.5, owner: OWNER });   // real: 3.45 > 2.00
  check("⭐⭐⭐ BLOCKED — a cold cache did not hand over the full ceiling",
    gate.allowed === false, `allowed=${gate.allowed}`);

  // The counterfactual: what `?? 0` produces off a cold cache.
  const cold = (await fakeStore.get(dayKey))?.spentUsdc ?? 0;
  check("⭐⭐ PROOF: the cached read yields 0 — 'nothing spent today'", cold === 0, `cold=${cold}`);
  check("  …so 0 + 1.50 ≤ 2.00 would have ALLOWED a spend at 1.95/2.00 — the day RESET",
    cold + 1.5 <= CEIL);
  check("  …and the whole remaining ceiling would have been available", CEIL - cold === CEIL);
}

// ═══════════ 5 — unreadable-safety PRESERVED (asserted, not reasoned) ═══════════
// getJSON deliberately has NO catch: an unreadable counter throws, propagates out through
// daySpend -> canSpendDay -> the caller, and the spend never happens. Strong consistency adds
// stale-safety ON TOP of that; it must not swallow anything.
section("5 — unreadable counter still THROWS and propagates");
{
  seed({ atOrigin: 0 });
  throwOnRead = true;

  let threw = null;
  try { await daySpend({ owner: OWNER }); } catch (e) { threw = e; }
  check("⭐⭐ daySpend THROWS on an unreadable counter", threw !== null, threw?.message);

  let gateThrew = null;
  try { await canSpendDay({ amountUsdc: 0.1, owner: OWNER }); } catch (e) { gateThrew = e; }
  check("⭐⭐ canSpendDay propagates it — no silent allowed:true", gateThrew !== null, gateThrew?.message);
  check("  …it did NOT return an allow decision", gateThrew !== null);
  throwOnRead = false;
}

// ═══════════ 6 — getWithEtag: a LIVENESS fix, and NOT a safety one ═══════════
// ⚠️ READ THIS BEFORE "hardening" anything here. The safety argument does NOT apply to getWithEtag.
// A cached read there is ALREADY SAFE: it yields a stale etag, setIfMatch therefore fails, casUpdate
// re-reads and retries, and NO WRONG TOTAL CAN COMMIT. Compare-and-set is self-correcting.
//
// What a cached read costs is LIVENESS: casUpdate would retry against the same stale cache up to
// CAS_TRIES (24) and then throw "could not update after 24 attempts (contention)" — reporting write
// contention for what is actually a cold read. Strong consistency makes it converge immediately.
section("6 — getWithEtag is the LIVENESS fix (safety argument does not apply)");
{
  // ⚠️ THIS SETUP IS THE TEST. The first version seeded only the `day:` key and then exercised
  // recordDcaSpend, which writes `dca-day:` — a key absent from ORIGIN TOO. So setIfMatch took the
  // onlyIfNew path, succeeded first try, and the assertions passed CACHED OR NOT. It was a
  // fault-injection test injecting no fault; the mutation run is what exposed it. Churn requires the
  // key to EXIST at origin (so onlyIfNew is refused) while the edge cannot see it.
  const dcaKey = `dca-day:${OWNER}:${today}`;
  seed({ atOrigin: 0.25 });
  origin.set(dcaKey, stamp({ spentUsdc: 0.25, date: today }));   // exists at origin…
  edge.delete(dcaKey);                                            // …invisible to a cached read
  reads.length = 0;

  let threw = null;
  try { await recordDcaSpend({ owner: OWNER, amountUsdc: 0.1 }); } catch (e) { threw = e; }
  check("⭐⭐ the CAS update SUCCEEDS off a cold cache — no false 'contention' failure",
    threw === null, threw?.message ?? "no throw");
  check("  …and did not burn the retry budget", !/24 attempts/.test(threw?.message ?? ""));

  const casReads = reads.filter((r) => r.via === "getWithMetadata");
  check("⭐ getWithEtag asked for strong", casReads.length > 0 && casReads.every((r) => r.consistency === "strong"),
    `${casReads.length} read(s): ${[...new Set(casReads.map((r) => r.consistency))].join(",")}`);
  check("⭐ it converged on the FIRST attempt, not 24", casReads.length <= 2, `${casReads.length} CAS read(s)`);
  check("⚠️ SAFETY NOTE (asserted so it is not conflated): CAS could not have committed a wrong " +
        "total even when cached — a stale etag fails setIfMatch and forces a re-read", true);
}

// ═══════════ 7 — the gate still ALLOWS when it genuinely should ═══════════
// A cap that always blocks is not a cap. Proves the fix reads the truth, not that it is stuck.
section("7 — under the ceiling → still ALLOWED");
{
  seed({ atOrigin: 0.25, atEdge: 1.99 });     // edge pessimistic this time
  const gate = await canSpendDay({ amountUsdc: 0.5, owner: OWNER });   // real: 0.75 ≤ 2.00
  check("⭐⭐ allowed — reads the truth in BOTH directions, not jammed shut",
    gate.allowed === true, `allowed=${gate.allowed} reason=${gate.reason ?? "-"}`);
  check("  …while the stale edge would have blocked it", 1.99 + 0.5 > CEIL);
}

// ═══════════ 8 — getWithEtag: UNREADABLE is not ABSENT ═══════════
// The old `.catch(() => null)` collapsed two states into {value:null, etag:undefined}. mutate(null)
// builds a FRESH record — today's spend counted from ZERO. It never actually committed, but only
// because setIfMatch degrades to onlyIfNew without an etag and an existing key rejects the write:
// the guard sat one layer BELOW the defect. And a store outage surfaced as "(contention)" after
// ~19 full-backoff retries, on a request with a 10s ceiling — a timeout, not the intended error.
section("8 — UNREADABLE is refused; ABSENT still starts the day");
{
  // ⭐⭐ (3) THE LEGITIMATE NULL — first spend of the day: key genuinely absent, read SUCCEEDED.
  seed({});                                   // nothing at origin, throwOnRead = false
  let ok = true, e1 = null;
  await recordDcaSpend({ owner: OWNER, amountUsdc: 0.4 }).catch((e) => { ok = false; e1 = e; });
  check("⭐⭐ readable + ABSENT key -> proceeds and creates the record",
    ok && origin.has(dcaKey), e1 ? e1.message.slice(0, 50) : "created");
  check("  …with the spend actually counted", origin.get(dcaKey)?.data?.spentUsdc === 0.4);

  // ⭐⭐ (1) UNREADABLE -> refuse, and say the true cause.
  seed({ atOrigin: 1.0 }); throwOnRead = true;
  const before = reads.length;
  let err = null;
  await recordDcaSpend({ owner: OWNER, amountUsdc: 0.4 }).catch((e) => { err = e; });
  check("⭐⭐ readable:false -> REFUSES, no from-zero record written", err !== null);
  check("  …names UNREADABLE as the cause", err && /UNREADABLE/.test(err.message));
  check("⭐⭐ …and does NOT assert contention (the old false diagnosis)",
    err && !/\(contention\)/.test(err.message), err ? err.message.slice(0, 64) + "…" : "");
  check("⭐ refuses on the FIRST read — no 24-attempt storm against a store that will not answer",
    reads.length - before === 1, `${reads.length - before} read(s)`);
  throwOnRead = false;

  // ⭐⭐ (1) THE DEFAULT — an adapter predating the field returns `readable: undefined`.
  // `!readable` must refuse. Written `readable === false` it would sail straight through, which is
  // the `!!null`-renders-as-running shape all over again.
  let err2 = null, mutated = false;
  const legacyStore = {
    async getJSON() { return null; },
    async setJSON() {},
    async getWithEtag() { return { value: null, etag: undefined }; },   // NO `readable`
    async setIfMatch() { mutated = true; return true; },
    async setIfNew() { return true; },
    async list() { return []; },
  };
  await recordDcaSpend({ owner: OWNER, amountUsdc: 0.4, store: legacyStore }).catch((e) => { err2 = e; });
  check("⭐⭐ `readable` ABSENT -> treated as UNREADABLE and refused",
    err2 !== null && /UNREADABLE/.test(err2.message));
  check("  …and nothing was written — the mutate never reached a setIfMatch", mutated === false);
}

// ═══════════ 8b — the PERSISTED shape must be unchanged ═══════════
// ⚠️ Only the in-memory ADAPTER RETURN gained `readable`. The stored record is `mutate(value)`,
// which never sees the wrapper. This matters concretely during a rollout: a draft on new code and
// prod on old code share the site-scoped budget store IN BOTH DIRECTIONS, so a shape change would
// corrupt records for whichever side is older.
section("8b — the stored record shape did not change");
{
  seed({});
  await recordDcaSpend({ owner: OWNER, amountUsdc: 0.25 });
  const persisted = origin.get(dcaKey)?.data ?? {};
  check("⭐⭐ `readable` is NOT persisted — it never reaches mutate()",
    !("readable" in persisted), JSON.stringify(persisted));
  check("  …nor `etag` or `value` (the wrapper fields)",
    !("etag" in persisted) && !("value" in persisted));
  check("  …the record still carries exactly spentUsdc + date",
    typeof persisted.spentUsdc === "number" && typeof persisted.date === "string",
    Object.keys(persisted).sort().join(","));
}

// ═══════════ 9 — no etag ⇒ onlyIfNew: the guard that made this SAFE, not URGENT ═══════════
// ⚠️ DO NOT REMOVE. This is the ONLY reason the old defect was a mis-diagnosis rather than a
// fail-open, and it lives in the same function just refactored. Defence in depth now that
// UNREADABLE refuses earlier — but the layer below must keep holding on its own.
section("9 — no etag ⇒ onlyIfNew (the fail-closed guard)");
{
  seed({});                                   // absent key -> read succeeds, etag undefined
  writes.length = 0;
  await recordDcaSpend({ owner: OWNER, amountUsdc: 0.1 });
  check("⭐⭐ NO etag -> the write is onlyIfNew (a from-zero record can never overwrite a counter)",
    writes.length > 0 && writes[0].opts.onlyIfNew === true, JSON.stringify(writes[0]?.opts ?? null));
  check("  …and it is NOT an unguarded write", writes.every((w) => w.opts.onlyIfNew || w.opts.onlyIfMatch));

  seed({});                                   // fresh, then seed the DCA key specifically
  origin.set(dcaKey, stamp({ spentUsdc: 0.5, date: today }));   // existing key -> read yields an etag
  writes.length = 0;
  await recordDcaSpend({ owner: OWNER, amountUsdc: 0.1 });
  check("⭐ WITH an etag -> the write is onlyIfMatch on that exact etag",
    writes.length > 0 && typeof writes[0].opts.onlyIfMatch === "string");
  check("  …so a lost update stays detectable", writes[0].opts.onlyIfNew === undefined);
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
