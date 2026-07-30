// _budget-test.mjs — ISOLATED proof of the budget/policy spine.
//
// Runs the caps against an in-memory store (injected), so nothing touches the
// Netlify runtime, x402, the research engine, or the network. Run from the
// project root:  node netlify/functions/_budget-test.mjs
//
// NOTE: hyphenated, not dotted (_budget.test.mjs) — Netlify derives a function
// name from every .mjs in this dir, and a dotted name (_budget.test) is invalid
// ("alphanumeric, hyphen & underscores only") and 422s the deploy. Underscore-
// prefixed files still ship as inert, never-invoked functions (no handler).

import {
  jobAllowance,
  canSpend,
  recordSpend,
  recordBlocked,
  jobSpend,
  daySpend,
  auditLog,
  budgetConfig,
} from "./_budget.mjs";

// Fresh in-memory store per test → full isolation. JSON round-trip mimics the
// Blobs store's serialization.
// ⚠️ THIS MOCK IMPLEMENTS THE FULL ADAPTER, INCLUDING REAL COMPARE-AND-SET.
// A store that is laxer than the real one proves nothing: _budget.mjs falls back to naive
// read-modify-write when getWithEtag/setIfMatch are missing, so a get/set-only mock would
// exercise the very code path the CAS rewrite exists to eliminate — and the concurrency test
// would pass against the broken implementation. The etag is a monotonic version counter,
// which is all CAS actually needs.
function memStore() {
  const m = new Map();
  const etags = new Map();
  let version = 0;
  const bump = (k) => { etags.set(k, `v${++version}`); };
  return {
    async getJSON(k) {
      return m.has(k) ? JSON.parse(m.get(k)) : null;
    },
    async setJSON(k, v) {
      m.set(k, JSON.stringify(v));
      bump(k);
    },
    async getWithEtag(k) {
      return { value: m.has(k) ? JSON.parse(m.get(k)) : null, etag: etags.get(k), readable: true };
    },
    // Writes ONLY if the key's version is still the one the caller read. This is what makes a
    // lost update detectable instead of silent.
    async setIfMatch(k, v, etag) {
      const cur = etags.get(k);
      if (etag === undefined ? m.has(k) : cur !== etag) return false;
      m.set(k, JSON.stringify(v));
      bump(k);
      return true;
    },
    async setIfNew(k, v) {
      if (m.has(k)) return false;
      m.set(k, JSON.stringify(v));
      bump(k);
      return true;
    },
    async list(prefix) {
      return [...m.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

// 6-dp rounding, mirroring _budget.mjs's internal atomic math (not exported from there —
// duplicated here rather than widening the module's public API just for a test).
const round6 = (usdc) => Math.round(usdc * 1e6) / 1e6;

const AT = "2026-07-01T12:00:00.000Z"; // fixed timestamp → deterministic UTC day
const JOB_PRICE = 0.35; // → allowance 0.105, per-purchase cap 0.0525

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
};

async function main() {
  const cfg = budgetConfig();
  console.log("Effective caps:", cfg);
  console.log(`Derived for a ${JOB_PRICE} USDC job: allowance=${jobAllowance(JOB_PRICE)} ` +
    `per-purchase=${jobAllowance(JOB_PRICE) * cfg.PER_PURCHASE_PCT}\n`);

  check("jobAllowance(0.35) == 0.105", jobAllowance(0.35) === 0.105, `got ${jobAllowance(0.35)}`);

  // ── 1. Allows a purchase within all caps ────────────────────────────────────
  console.log("\n[1] allow within all caps");
  {
    const store = memStore();
    const r = await canSpend({ jobId: "job-1", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.05, store, at: AT });
    check("0.05 on a 0.35 job is allowed", r.allowed === true, JSON.stringify(r));
  }

  // ── 2. Blocks a purchase exceeding the per-purchase sub-cap ─────────────────
  console.log("\n[2] block per-purchase sub-cap");
  {
    const store = memStore();
    const r = await canSpend({ jobId: "job-2", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.06, store, at: AT });
    check("0.06 (> 0.0525 cap) is blocked", r.allowed === false, JSON.stringify(r));
    check("reason cites per-purchase cap", /per-purchase/.test(r.reason || ""), r.reason);
  }

  // ── 3. Blocks a purchase that would exceed the per-job allowance ────────────
  //     Successive buys each pass (a) but accumulate against the job allowance;
  //     the buy that crosses 0.105 is blocked by (b), not (a).
  console.log("\n[3] block per-job allowance (cumulative)");
  {
    const store = memStore();
    const a = await canSpend({ jobId: "job-3", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.05, store, at: AT });
    check("buy #1 0.05 allowed", a.allowed === true, JSON.stringify(a));
    await recordSpend({ jobId: "job-3", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.05, source: "test", justification: "buy1", store, at: AT });

    const b = await canSpend({ jobId: "job-3", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.05, store, at: AT });
    check("buy #2 0.05 allowed (total 0.10 ≤ 0.105)", b.allowed === true, JSON.stringify(b));
    await recordSpend({ jobId: "job-3", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.05, source: "test", justification: "buy2", store, at: AT });

    const c = await canSpend({ jobId: "job-3", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.03, store, at: AT });
    check("buy #3 0.03 blocked (0.10+0.03=0.13 > 0.105)", c.allowed === false, JSON.stringify(c));
    check("reason cites job allowance (not per-purchase)", /job allowance/.test(c.reason || ""), c.reason);
    check("job-3 total is 0.10 after the two allowed buys", (await jobSpend("job-3", { store })) === 0.1);
  }

  // ── 4. Blocks a purchase that would exceed the per-period ceiling ───────────
  //     Big job so per-purchase/allowance are generous; the DAY ceiling (across all
  //     jobs) is the binding constraint. Two different jobs share it.
  //
  //     Amounts are DERIVED from the live PERIOD_CEILING_USDC, never hardcoded. This
  //     test used to assume the 2.00 code default and silently went stale the moment the
  //     deployed ceiling moved to 60 — two buys of 1.5 no longer exceeded it, so the
  //     "blocked" assertions failed against perfectly correct code. Deriving the amounts
  //     means the test tracks whatever the ceiling is, now and after the next change.
  console.log("\n[4] block per-period ceiling (across jobs)");
  {
    const store = memStore();
    const CEIL = budgetConfig().PERIOD_CEILING_USDC;

    // Each buy is 60% of the ceiling: one fits, two cannot (120% > 100%).
    const buy = round6(CEIL * 0.6);
    // Pick a job price large enough that the per-purchase sub-cap (price × 0.30 × 0.50 =
    // price × 0.15) and the job allowance never bind — so the DAY ceiling is the only
    // constraint under test. price × 0.15 ≥ buy  ⇒  price ≥ buy / 0.15. Use 10×CEIL, which
    // clears that with margin for any sane pct config.
    const price = round6(CEIL * 10);

    const a = await canSpend({ jobId: "jobA", jobPriceUsdc: price, amountUsdc: buy, store, at: AT });
    check(`jobA ${buy} allowed (ceiling ${CEIL})`, a.allowed === true, JSON.stringify(a));
    await recordSpend({ jobId: "jobA", jobPriceUsdc: price, amountUsdc: buy, source: "test", justification: "big1", store, at: AT });

    // jobB: same amount passes the per-job caps, but day total 2×buy = 120% of the
    // ceiling → blocked by the period ceiling.
    const b = await canSpend({ jobId: "jobB", jobPriceUsdc: price, amountUsdc: buy, store, at: AT });
    check(`jobB ${buy} blocked by daily ceiling (${buy}+${buy} > ${CEIL})`, b.allowed === false, JSON.stringify(b));
    check("reason cites period ceiling", /period ceiling/.test(b.reason || ""), b.reason);
    check(`day total is ${buy} (blocked buy not recorded)`, (await daySpend({ date: AT.slice(0, 10), store })) === buy);
  }

  // ── 5. Audit log records both allowed and blocked attempts ──────────────────
  console.log("\n[5] audit trail: allowed + blocked");
  {
    const store = memStore();
    await recordSpend({ jobId: "job-5", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.04, source: "exa", justification: "search", store, at: AT });
    const blocked = await canSpend({ jobId: "job-5", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.09, store, at: AT });
    await recordBlocked({ jobId: "job-5", amountUsdc: 0.09, source: "exa", reason: blocked.reason, store, at: AT });

    // auditLog is now OWNER-SCOPED (there is no read-everyone's-audit path).
    const all = await auditLog({ store });
    check("2 audit entries total", all.length === 2, `got ${all.length}`);
    check("one allowed=true entry", all.filter((e) => e.allowed === true).length === 1);
    check("one allowed=false entry", all.filter((e) => e.allowed === false).length === 1);
    const allowedEntry = all.find((e) => e.allowed);
    check("allowed entry carries justification", allowedEntry?.justification === "search", JSON.stringify(allowedEntry));
    const blockedEntry = all.find((e) => !e.allowed);
    check("blocked entry carries reason", /per-purchase|job allowance|period/.test(blockedEntry?.reason || ""), JSON.stringify(blockedEntry));
    check("entries carry source + timestamp", all.every((e) => e.source === "exa" && !!e.timestamp));
    check("auditLog(jobId) filters by job", (await auditLog({ jobId: "job-5", store })).length === 2);
    check("auditLog('other') returns none", (await auditLog({ jobId: "nope", store })).length === 0);

    // AGENT ATTRIBUTION — who spent, not just what. This is what the Agents page renders.
    check("entries carry an agent", all.every((e) => e.agent === "researcher"), JSON.stringify(all.map((e) => e.agent)));
    check("entries carry the owner", all.every((e) => e.owner === "_global"));
  }

  // ── 6. Totals read back correctly after recorded spends ─────────────────────
  console.log("\n[6] totals read back");
  {
    const store = memStore();
    const r1 = await recordSpend({ jobId: "job-6", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.02, source: "test", justification: "a", store, at: AT });
    const r2 = await recordSpend({ jobId: "job-6", jobPriceUsdc: JOB_PRICE, amountUsdc: 0.03, source: "test", justification: "b", store, at: AT });
    check("recordSpend returns running job total 0.05", r2.jobSpentUsdc === 0.05, JSON.stringify(r2));
    check("recordSpend returns allowance 0.105", r2.allowanceUsdc === 0.105, JSON.stringify(r2));
    check("jobSpend reads back 0.05", (await jobSpend("job-6", { store })) === 0.05);
    check("daySpend reads back 0.05", (await daySpend({ date: AT.slice(0, 10), store })) === 0.05);
    check("first recordSpend saw running total 0.02", r1.jobSpentUsdc === 0.02, JSON.stringify(r1));
  }

  console.log(`\n──────────\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("TEST HARNESS ERROR:", e);
  process.exit(1);
});
