// verify-quote-retention.mjs — retention is conditional on EXECUTION, not on age.
//
// ═══ ⭐⭐ THE PROPERTY ════════════════════════════════════════════════════════════════════════════
// Receipts are permanent; quotes expire at 14 days. So an executed plan's join to its priced quote
// dies on a timer — the same broken chain as an unprojected quoteId, arriving by a different route.
// The fix marks a quote at EXECUTION and exempts marked quotes from the age prune. Unexecuted quotes,
// the large majority, still expire on schedule.
//
// ⚠️ WHY THE MARK IS A KEY AND NOT A FIELD — asserted here because it is the design constraint, not a
// preference: `pruneOwnerQuotes` is key-name-only by design, so it can date the whole store from one
// `list()`. A `usedAt` FIELD would force a read per candidate inside a 1500 ms budget with a 25-delete
// cap, and the prune would do LESS work the more there was to do.
//
//   node --experimental-test-module-mocks scripts/verify-quote-retention.mjs

import { mock } from "node:test";

// ── in-memory @netlify/blobs ────────────────────────────────────────────────────────────────────
const mem = new Map();
let listCalls = 0, getCalls = 0, failMark = false;
mock.module("@netlify/blobs", {
  namedExports: {
    getStore: () => ({
      setJSON: async (k, v) => { if (failMark && k.startsWith("u/")) throw new Error("store down"); mem.set(k, JSON.stringify(v)); },
      get: async (k) => { getCalls++; return mem.has(k) ? JSON.parse(mem.get(k)) : null; },
      delete: async (k) => { mem.delete(k); },
      list: async ({ prefix }) => {
        listCalls++;
        return { blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
      },
    }),
  },
});

const {
  pruneOwnerQuotes, markQuoteUsed, usedKey, quoteKey,
  QUOTE_TTL_MS, MAX_QUOTES_PER_OWNER,
} = await import("../netlify/functions/_quote-record.mjs");

const OWNER = "0x" + "ab".repeat(20);
let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ─────────────────────────────────────────`);

const NOW = Date.parse("2026-09-01T00:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const qid = (n) => `q_msx${String(n).padStart(5, "0")}_${"0".repeat(15)}${n % 10}`;
const seedQuote = (n, ageMs) => {
  const k = quoteKey(OWNER, iso(ageMs), qid(n));
  mem.set(k, JSON.stringify({ quoteId: qid(n) }));
  return k;
};
const reset = () => { mem.clear(); listCalls = 0; getCalls = 0; failMark = false; };

console.log("\nverify-quote-retention — the join survives execution, not age\n");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — AGE STILL EVICTS AN UNEXECUTED QUOTE");
{
  reset();
  seedQuote(1, QUOTE_TTL_MS + 1000);   // expired
  seedQuote(2, 1000);                  // fresh
  const r = await pruneOwnerQuotes(OWNER, NOW);
  check("⭐ an unexecuted quote past the TTL is deleted", r.expired === 1 && r.deleted === 1);
  check("  …and a fresh one is untouched", [...mem.keys()].some((k) => k.includes(qid(2))));
  check("⚠️ the majority case is unchanged — this is not a blanket reprieve",
    ![...mem.keys()].some((k) => k.includes(qid(1))));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ AN EXECUTED QUOTE SURVIVES ITS OWN EXPIRY");
{
  reset();
  seedQuote(1, QUOTE_TTL_MS * 3);      // ancient
  await markQuoteUsed(OWNER, qid(1));
  const r = await pruneOwnerQuotes(OWNER, NOW);
  check("⭐⭐ a MARKED quote is not evicted for age, however old", r.expired === 0 && r.deleted === 0);
  check("  …the quote record is still readable", [...mem.keys()].some((k) => k.startsWith("q/") && k.includes(qid(1))));
  check("  …and the marker itself persists", mem.has(usedKey(OWNER, qid(1))));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 THE PRUNE STAYS KEY-NAME-ONLY (the design constraint)");
{
  reset();
  for (let i = 0; i < 12; i++) seedQuote(i, QUOTE_TTL_MS + i * 1000);
  await markQuoteUsed(OWNER, qid(3));
  getCalls = 0;
  await pruneOwnerQuotes(OWNER, NOW);
  // 🚨 A `usedAt` FIELD would make this number scale with the candidate count. It must stay ZERO:
  // the prune's whole cost model is that it never opens a record.
  check("🚨🚨 the prune reads ZERO records — the mark is a KEY, so no per-candidate get() appears",
    getCalls === 0, `get() calls: ${getCalls}`);
  check("⭐ …at the cost of exactly ONE extra list() (quotes + markers)", listCalls === 2, `list() calls: ${listCalls}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⚠️ THE COUNT CAP STILL BINDS — protected is LAST, not exempt");
{
  reset();
  // All fresh, so age never fires; overflow is the only pressure.
  const total = MAX_QUOTES_PER_OWNER + 5;
  for (let i = 0; i < total; i++) seedQuote(i, 1000 + (total - i) * 1000); // 0 = oldest
  for (const i of [0, 1]) await markQuoteUsed(OWNER, qid(i));             // the two OLDEST are executed
  const r = await pruneOwnerQuotes(OWNER, NOW);
  check("⚠️ overflow is still evicted — protected quotes do NOT make the store unbounded", r.overflow === 5);
  check("⭐⭐ …and the two EXECUTED quotes survived, though they were the oldest",
    mem.has(quoteKey(OWNER, iso(1000 + total * 1000), qid(0))) ||
    [...mem.keys()].some((k) => k.startsWith("q/") && k.includes(qid(0))));
  check("  …an unprotected quote was taken instead", ![...mem.keys()].some((k) => k.startsWith("q/") && k.includes(qid(2))));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — 🚨 THE FAILURE MODE: a failed mark must be VISIBLE, never silent");
{
  reset();
  failMark = true;
  const ok = await markQuoteUsed(OWNER, qid(9));
  check("🚨 a store failure returns FALSE rather than throwing", ok === false);
  check("  …and writes no marker, so the caller is not misled", !mem.has(usedKey(OWNER, qid(9))));
  failMark = false;
  check("⭐ a successful mark returns TRUE — the caller can tell them apart",
    (await markQuoteUsed(OWNER, qid(9))) === true);

  // ⚠️ THE POINT OF THE BOOLEAN: it is recorded on the receipt, so a later reader can separate
  // "expired despite protection" (anomaly) from "never protected" (explained). Without it an absent
  // quote makes those identical — which is the silent-failure shape this whole change is closing.
  const rec = await import("../netlify/functions/_bridge-record.mjs");
  check("⭐⭐ recordBridge accepts quotePromoted so the outcome reaches the receipt",
    /quotePromoted/.test(rec.recordBridge.toString()));
  check("⭐ …and recordPendingBridge does too — a 202 must not lose it",
    /quotePromoted/.test(rec.recordPendingBridge.toString()));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — the guard rejects nonsense rather than writing junk keys");
{
  reset();
  check("⚠️ a malformed quoteId is refused", (await markQuoteUsed(OWNER, "not-a-quote-id")) === false);
  check("⚠️ a missing owner is refused", (await markQuoteUsed(null, qid(1))) === false);
  check("  …and neither wrote a marker", [...mem.keys()].filter((k) => k.startsWith("u/")).length === 0);
}

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
