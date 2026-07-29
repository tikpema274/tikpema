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
const CEIL = budgetConfig().PERIOD_CEILING_USDC;          // 2.00 USDC by default

/** Put a total at ORIGIN (what was really spent) and, optionally, a different one at the EDGE. */
const seed = ({ atOrigin, atEdge }) => {
  origin.clear(); edge.clear(); reads.length = 0; throwOnRead = false;
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

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
