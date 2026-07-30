// verify-ledger-concurrency.mjs — ZERO-MONEY proof that the ledger survives concurrency.
//
// TWO read-modify-write races existed in _budget.mjs, and only one of them was bookkeeping:
//
//   1. appendAudit  — read the WHOLE audit array, push, write it back. Two concurrent appends
//      both read the same array and both write their own copy: one entry is silently LOST.
//      The record of what your agent spent was unreliable exactly when it was busiest.
//
//   2. recordSpend / recordAgentSpend — read `spentUsdc`, add, write back. Two concurrent
//      spends both read X and both write X+amount. **A spend vanishes from the running
//      total**, so PERIOD_CEILING_USDC under-counts and the daily cap DOES NOT HOLD. That is
//      a money-safety hole, not a reporting one.
//
// Brick 2 (two analysts, both buying data, both ledgering) is precisely that concurrency.
//
// The fixes: per-entry immutable audit keys (create-only writes — an append cannot clobber
// another append), and compare-and-set on the counters (a lost update is DETECTED and
// retried, never silently dropped).
//
// This test fires N writers at the same key simultaneously and asserts BOTH invariants. It is
// written to FAIL against the old naive implementation — see the `naiveStore` case, which
// simulates a store with no CAS and shows the money actually going missing.
//
//   node --env-file=.env scripts/verify-ledger-concurrency.mjs
import { recordAgentSpend, recordSpend, auditLog, daySpend, agentBreakdown } from "../netlify/functions/_budget.mjs";
import { AGENT } from "../netlify/functions/_agents.mjs";

const OWNER = "0xbafec950627579cf786acf875e6e216995e995a3";
const N = 25;
const AMT = 0.1;

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// A FAITHFUL store: real compare-and-set, real create-only writes, real prefix list.
// The etag is a monotonic version counter — all CAS needs.
function casStore({ latencyMs = 0 } = {}) {
  const m = new Map();
  const etags = new Map();
  let version = 0;
  const bump = (k) => etags.set(k, `v${++version}`);
  // A real store round-trips over a network. Interleaving the await points is what MAKES the
  // race — without it, single-threaded JS would serialize every read-modify-write by accident
  // and the bug would be invisible.
  const tick = () => new Promise((r) => setTimeout(r, latencyMs));
  return {
    async getJSON(k) { await tick(); return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { await tick(); m.set(k, JSON.stringify(v)); bump(k); },
    async getWithEtag(k) { await tick(); return { value: m.has(k) ? JSON.parse(m.get(k)) : null, etag: etags.get(k), readable: true }; },
    async setIfMatch(k, v, etag) {
      await tick();
      const cur = etags.get(k);
      if (etag === undefined ? m.has(k) : cur !== etag) return false; // someone wrote first
      m.set(k, JSON.stringify(v)); bump(k); return true;
    },
    async setIfNew(k, v) { await tick(); if (m.has(k)) return false; m.set(k, JSON.stringify(v)); bump(k); return true; },
    async list(prefix) { await tick(); return [...m.keys()].filter((k) => k.startsWith(prefix)); },
  };
}

// The OLD store: get/set only. _budget.mjs falls back to naive read-modify-write against it,
// which is exactly the pre-fix behaviour. Used to DEMONSTRATE the bug rather than assert it away.
function naiveStore({ latencyMs = 0 } = {}) {
  const m = new Map();
  const tick = () => new Promise((r) => setTimeout(r, latencyMs));
  return {
    async getJSON(k) { await tick(); return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { await tick(); m.set(k, JSON.stringify(v)); },
  };
}

console.log(`── ${N} concurrent spends of ${AMT} USDC (expected total ${round(N * AMT)}) ──\n`);
function round(x) { return Math.round(x * 1e6) / 1e6; }

console.log("THE BUG — naive read-modify-write (the pre-fix implementation)");
{
  const store = naiveStore({ latencyMs: 1 });
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      recordAgentSpend({ owner: OWNER, amountUsdc: AMT, source: "test", justification: `#${i}`, store })
    )
  );
  const total = await daySpend({ owner: OWNER, store });
  const lost = round(N * AMT - total);
  check(
    `day total UNDER-COUNTS: ${total} instead of ${round(N * AMT)} (${lost} USDC of spend vanished)`,
    total < N * AMT,
    lost > 0 ? `the ceiling would have allowed ${lost} USDC more than it should` : "no loss observed"
  );
}

console.log("\nTHE FIX — compare-and-set counters + per-entry audit keys");
{
  const store = casStore({ latencyMs: 1 });
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      recordAgentSpend({
        agent: AGENT.EXECUTOR,
        owner: OWNER, amountUsdc: AMT, source: "swap_tokens", justification: `#${i}`, store,
      })
    )
  );

  const total = await daySpend({ owner: OWNER, store });
  check(`day total is EXACT: ${total}`, total === round(N * AMT), `expected ${round(N * AMT)}, got ${total}`);

  const entries = await auditLog({ owner: OWNER, store });
  check(`ALL ${N} audit entries survived (no append clobbered another)`, entries.length === N, `got ${entries.length}`);

  const sum = round(entries.reduce((a, e) => a + Number(e.amountUsdc), 0));
  check("the audit sums to the counter (the record and the total agree)", sum === total, `audit ${sum} vs counter ${total}`);

  const justifications = new Set(entries.map((e) => e.justification));
  check("every writer's entry is distinct (none overwrote another)", justifications.size === N, `${justifications.size} unique`);
}

console.log("\nAGENT ATTRIBUTION — the Agents page's data shape");
{
  const store = casStore();
  // Two agents spending concurrently, as Brick 2 will.
  await Promise.all([
    ...Array.from({ length: 3 }, () =>
      recordSpend({ agent: AGENT.RESEARCHER, owner: OWNER, jobId: "j1", jobPriceUsdc: 10, amountUsdc: 0.2, source: "exa", justification: "search", store })
    ),
    ...Array.from({ length: 2 }, () =>
      recordAgentSpend({ agent: AGENT.EXECUTOR, owner: OWNER, amountUsdc: 1, source: "swap_tokens", justification: "swap", store })
    ),
  ]);

  const rows = await agentBreakdown({ owner: OWNER, store });
  const researcher = rows.find((r) => r.agent === "researcher");
  const executor = rows.find((r) => r.agent === "executor");

  check("breakdown splits spend BY AGENT, not just by owner", rows.length === 2, JSON.stringify(rows));
  check("researcher: 3 actions, 0.6 USDC", researcher?.actions === 3 && researcher?.spentUsdc === 0.6, JSON.stringify(researcher));
  check("executor: 2 actions, 2 USDC", executor?.actions === 2 && executor?.spentUsdc === 2, JSON.stringify(executor));

  const day = await daySpend({ owner: OWNER, store });
  check("the day CEILING stays OWNER-keyed (one budget across all agents)", day === 2.6, `${day}`);
}

console.log("\nOWNER SCOPING — one user's audit is not another's");
{
  const store = casStore();
  const OTHER = "0x1111111111111111111111111111111111111111";
  await recordAgentSpend({ agent: AGENT.EXECUTOR, owner: OWNER, amountUsdc: 1, source: "s", store });
  await recordAgentSpend({ agent: AGENT.EXECUTOR, owner: OTHER, amountUsdc: 5, source: "s", store });

  const mine = await auditLog({ owner: OWNER, store });
  check("auditLog(owner) returns ONLY that owner's entries", mine.length === 1 && Number(mine[0].amountUsdc) === 1, JSON.stringify(mine.map((e) => e.amountUsdc)));
  check("the other owner's day total is separate", (await daySpend({ owner: OTHER, store })) === 5);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
