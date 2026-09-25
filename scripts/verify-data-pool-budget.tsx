// verify-data-pool-budget.tsx — AN OPERATOR-PAID DATA BUY IS BOUNDED BY THE OPERATOR POOL, NOT BY
// THE USER'S DAILY LIMIT.
//
// ═══ 🚨 WHAT THIS GUARDS ═════════════════════════════════════════════════════════════════════
// The Researcher's data buys are paid from the shared delegate EOA's Gateway balance — Tikpema's
// money, funded once by the operator (PROGRESS.md "depositFor funding technique"). The user is never
// debited. But canSpend/recordSpend charged each buy against the USER's daily counter (`day:<owner>`)
// — the same counter that caps send/swap/bridge/DCA — so a user's spending limit shrank for money
// they did not spend.
//
// That charge was ALSO the only per-user bound on draining the pool (the per-job allowance derives
// from a job price that round-trips to the user's own wallet). So it is REPLACED, not dropped:
//   §1 two new caps, FAIL-CLOSED: unset, blank, garbled or negative → the buy is REFUSED
//   §2 a per-user daily cap on POOL draws — one user cannot burn the pool, another is unaffected
//   §3 a global daily cap on the pool
//   §4 the user's own daily limit is NOT consulted for a data buy
//   §5 recordSpend writes the pool counters, never `day:<owner>`; the per-owner audit row stays
//   §6 per-buy and per-job checks still hold
//   §7 a PENDING buy charges and reverses the POOL counters
//   §8 the copy no longer says the user pays
//
// HOW: canSpend/recordSpend run for real against an injected in-memory store. Zero network, ZERO MONEY.
//
//   npx tsx scripts/verify-data-pool-budget.tsx

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0, fail = 0;
const check = (label: string, cond: unknown, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const attempt = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try { return await fn(); } catch (e: any) { fail++; console.log(`  ❌ ${label} THREW — ${e?.message ?? e}`); return undefined; }
};

const budget: any = await import("../netlify/functions/_budget.mjs");
const arc: any = await import("../netlify/functions/_arc.mjs");
const { AGENTS, AGENT }: any = await import("../netlify/functions/_agents.mjs");
const NanopaymentPanel: any = (await import("../src/components/NanopaymentPanel")).default;

// ── an in-memory budget store (the adapter shape _budget.mjs takes) ─────────────────────────────
const mem = () => {
  const m = new Map<string, any>();
  const c = (v: any) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    m,
    async getJSON(k: string) { return c(m.get(k)) ?? null; },
    async setJSON(k: string, v: any) { m.set(k, c(v)); },
    async setIfNew(k: string, v: any) { if (m.has(k)) return false; m.set(k, c(v)); return true; },
    async list(p: string) { return [...m.keys()].filter((k) => k.startsWith(p)); },
  };
};
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const C = "0x00000000000000000000000000000000000000cc";
const today = new Date().toISOString().slice(0, 10);
const USER_VAR = "DATA_POOL_USER_DAILY_CAP_USDC";
const POOL_VAR = "DATA_POOL_DAILY_CAP_USDC";
const setCaps = (user?: string, pool?: string) => {
  if (user === undefined) delete process.env[USER_VAR]; else process.env[USER_VAR] = user;
  if (pool === undefined) delete process.env[POOL_VAR]; else process.env[POOL_VAR] = pool;
};
// A job price large enough that the per-job allowance never binds in §2–§5.
const JOB = 100;
const gate = (store: any, owner: string, amountUsdc = 0.0001, jobId = `job-${owner.slice(-2)}`) =>
  budget.canSpend({ jobId, jobPriceUsdc: JOB, amountUsdc, owner, store });
const spend = (store: any, owner: string, amountUsdc = 0.0001, jobId = `job-${owner.slice(-2)}`, extra: any = {}) =>
  budget.recordSpend({ jobId, jobPriceUsdc: JOB, amountUsdc, source: "seller.test", justification: "t", owner, store, ...extra });

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────
section("§1 THE TWO POOL CAPS FAIL CLOSED");
for (const [label, user, pool] of [
  ["both unset", undefined, undefined],
  ["per-user cap unset", undefined, "5"],
  ["global cap unset", "1", undefined],
  ["per-user cap blank", "  ", "5"],
  ["global cap garbled", "1", "abc"],
  ["per-user cap negative", "-1", "5"],
  ["global cap NaN-ish", "1", "1e"],
] as const) {
  setCaps(user, pool);
  const r = await attempt(`§1 ${label}`, () => gate(mem(), A));
  check(`${label} → REFUSED`, r && r.allowed === false, r?.reason);
  check(`${label} → code REFUSED_POOL_UNCONFIGURED`, r?.code === "REFUSED_POOL_UNCONFIGURED", r?.code);
}
setCaps("1", "5");
check("the helpers exist in _arc.mjs", typeof arc.poolUserDailyCapUsdc === "function" && typeof arc.poolDailyCapUsdc === "function");
check("both valid → the helpers return the numbers", arc.poolUserDailyCapUsdc?.() === 1 && arc.poolDailyCapUsdc?.() === 5);
setCaps(undefined, "5");
let threw = false; try { arc.poolUserDailyCapUsdc?.(); } catch { threw = true; }
check("an unset cap THROWS in the helper (no default)", threw);
check("REFUSAL.POOL_UNCONFIGURED is a named refusal", budget.REFUSAL?.POOL_UNCONFIGURED === "REFUSED_POOL_UNCONFIGURED");

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────
section("§2 PER-USER DAILY CAP ON POOL DRAWS");
{
  setCaps("0.0003", "1");
  const s = mem();
  for (let i = 0; i < 3; i++) {
    const g = await attempt(`§2 gate ${i}`, () => gate(s, A));
    check(`A buy ${i + 1} of 3 allowed`, g?.allowed === true, g?.reason);
    await attempt(`§2 spend ${i}`, () => spend(s, A));
  }
  const g4 = await attempt("§2 gate 4", () => gate(s, A));
  check("A's 4th buy REFUSED by the per-user pool cap", g4?.allowed === false && /per-user/i.test(g4?.reason ?? ""), g4?.reason);
  check("…with code REFUSED_DAY_CEILING", g4?.code === "REFUSED_DAY_CEILING", g4?.code);
  const gB = await attempt("§2 gate B", () => gate(s, B));
  check("B is unaffected by A's draws", gB?.allowed === true, gB?.reason);
}

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────
section("§3 GLOBAL DAILY CAP ON THE POOL");
{
  setCaps("1", "0.0002");
  const s = mem();
  await attempt("§3 A", async () => { check("A allowed", (await gate(s, A)).allowed === true); await spend(s, A); });
  await attempt("§3 B", async () => { check("B allowed", (await gate(s, B)).allowed === true); await spend(s, B); });
  const gC = await attempt("§3 gate C", () => gate(s, C));
  check("C REFUSED by the global pool cap though C has drawn nothing", gC?.allowed === false && /pool/i.test(gC?.reason ?? "") && !/per-user/i.test(gC?.reason ?? ""), gC?.reason);
}

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────
section("§4 THE USER'S OWN DAILY LIMIT IS NOT CONSULTED");
{
  setCaps("1", "5");
  const s = mem();
  const ceil = budget.budgetConfig().PERIOD_CEILING_USDC;
  await s.setJSON(`day:${A}:${today}`, { date: today, owner: A, spentUsdc: ceil }); // A has sent their whole day
  const g = await attempt("§4 gate", () => gate(s, A));
  check("a data buy is ALLOWED for a user at their own daily ceiling", g?.allowed === true, g?.reason);
}

// ── §5 ─────────────────────────────────────────────────────────────────────────────────────
section("§5 recordSpend WRITES THE POOL, NEVER THE USER'S DAY COUNTER");
{
  setCaps("1", "5");
  const s = mem();
  await attempt("§5 spend", () => spend(s, A, 0.0001, "job-5", { settlement: { id: "uuid-5", kind: "circle-gateway-facilitator" } }));
  check("day:<owner> is NOT written", !s.m.has(`day:${A}:${today}`));
  check("daySpend(owner) stays 0 — send/swap/bridge headroom untouched", (await budget.daySpend({ owner: A, store: s })) === 0);
  check("the per-user pool counter is charged", Math.abs(Number(s.m.get(`pool-day:${A}:${today}`)?.spentUsdc) - 0.0001) < 1e-9);
  check("the global pool counter is charged", Math.abs(Number(s.m.get(`pool-day-total:${today}`)?.spentUsdc) - 0.0001) < 1e-9);
  check("the per-job counter is still charged", Math.abs(Number(s.m.get("job:job-5")?.spentUsdc) - 0.0001) < 1e-9);
  const audits = [...s.m.entries()].filter(([k]) => k.startsWith(`audit:${A}:`)).map(([, v]) => v);
  check("the per-OWNER audit row is kept (attribution)", audits.length === 1 && audits[0].owner === A);
  check("…and says who paid: fundedBy operator-pool", audits[0]?.fundedBy === "operator-pool", audits[0]?.fundedBy);
  check("exported readers report the pool draws", typeof budget.poolUserSpend === "function"
    && (await budget.poolUserSpend?.({ owner: A, store: s })) === 0.0001
    && (await budget.poolTotalSpend?.({ store: s })) === 0.0001);
}

// ── §6 ─────────────────────────────────────────────────────────────────────────────────────
section("§6 PER-BUY AND PER-JOB CHECKS STILL HOLD");
{
  setCaps("100", "100");
  const s = mem();
  // job price 1 → allowance 0.30, per-purchase sub-cap 0.15 (defaults)
  const big = await attempt("§6 per-buy", () => budget.canSpend({ jobId: "j6", jobPriceUsdc: 1, amountUsdc: 0.2, owner: A, store: s }));
  check("over the per-purchase sub-cap → refused", big?.allowed === false && /per-purchase|sub-cap/i.test(big?.reason ?? ""), big?.reason);
  await attempt("§6 fill job", () => budget.recordSpend({ jobId: "j6", jobPriceUsdc: 1, amountUsdc: 0.15, source: "x", justification: "t", owner: A, store: s }));
  await attempt("§6 fill job 2", () => budget.recordSpend({ jobId: "j6", jobPriceUsdc: 1, amountUsdc: 0.15, source: "x", justification: "t", owner: A, store: s }));
  const over = await attempt("§6 job", () => budget.canSpend({ jobId: "j6", jobPriceUsdc: 1, amountUsdc: 0.01, owner: A, store: s }));
  check("over the per-job allowance → refused", over?.allowed === false && /job allowance/i.test(over?.reason ?? ""), over?.reason);
}

// ── §7 ─────────────────────────────────────────────────────────────────────────────────────
section("§7 A PENDING BUY CHARGES AND REVERSES THE POOL COUNTERS");
{
  setCaps("1", "5");
  const s = mem();
  const r = await attempt("§7 pending", () => spend(s, A, 0.0001, "job-7", {
    confirmation: "pending", pending: { reason: "settle-timeout", handle: null },
  }));
  check("pending does not touch day:<owner>", !s.m.has(`day:${A}:${today}`));
  check("pending charges the per-user pool", Math.abs(Number(s.m.get(`pool-day:${A}:${today}`)?.spentUsdc) - 0.0001) < 1e-9);
  const res = await attempt("§7 resolve", () => budget.resolvePendingPurchase({ owner: A, pendingId: r?.pendingId, outcome: "not-charged", store: s }));
  check("not-charged reverses the per-user pool", Number(s.m.get(`pool-day:${A}:${today}`)?.spentUsdc) === 0 && res?.reversed === true);
  check("…and the global pool", Number(s.m.get(`pool-day-total:${today}`)?.spentUsdc) === 0);
  check("…and the job counter", Number(s.m.get("job:job-7")?.spentUsdc) === 0);
}

// ── §8 ─────────────────────────────────────────────────────────────────────────────────────
section("§8 THE COPY NO LONGER SAYS THE USER PAYS");
{
  const R = AGENTS.find((a: any) => a.id === AGENT.RESEARCHER);
  const SPENDS = "Holds each research job's budget in escrow from your agent wallet. Data it buys is paid by Tikpema, not from your USDC — capped per user and per day. It cannot send, swap, or bridge.";
  check("Researcher `spends` is the corrected sentence (pinned)", R?.spends === SPENDS, R?.spends);
  check("Researcher `description` says Tikpema pays for data", /Tikpema pays for that data from its own balance, not your wallet/.test(R?.description ?? ""), R?.description);
  check("no roster copy says the Researcher spends the user's USDC to buy data",
    !/spends your usdc|buys data with your usdc/i.test(`${R?.spends} ${R?.description}`));
  check("movesFunds stays TRUE — the escrow does move the user's USDC", R?.movesFunds === true);

  const html = renderToStaticMarkup(React.createElement(NanopaymentPanel));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check("Nanopayment intro says Tikpema pays, not the wallet", /Tikpema pays for it from its own balance, not your wallet/.test(text));
  check("…the callout says none of it comes out of the wallet", /None of it comes out of your wallet/.test(text));
  for (const bad of [/within your budget/i, /your daily budget/i, /your per-job and daily spending caps/i]) {
    check(`Nanopayment no longer says ${bad}`, !bad.test(text));
  }
}

// ── §9 ─────────────────────────────────────────────────────────────────────────────────────
section("§9 agentBreakdown SPLITS the user's spend from Tikpema-paid data");
{
  setCaps("1", "5");
  const s = mem();
  await attempt("§9 pool buy", () => spend(s, A, 0.0001, "job-9"));
  await attempt("§9 user spend", () => budget.recordAgentSpend({ owner: A, amountUsdc: 1, source: "swap_tokens", justification: "t", store: s, agent: AGENT.EXECUTOR }));
  const rows: any[] = (await attempt("§9 breakdown", () => budget.agentBreakdown({ owner: A, store: s }))) ?? [];
  const R = rows.find((r) => r.agent === "researcher"), E = rows.find((r) => r.agent === "executor");
  check("⭐ the Researcher's USER spend excludes the pool buy", R?.spentUsdc === 0, JSON.stringify(R));
  check("⭐ …and the pool buy is reported separately as poolSpentUsdc", R?.poolSpentUsdc === 0.0001);
  check("…still counted as an action (activity, not money)", R?.actions === 1);
  check("the Executor's own spend is unchanged", E?.spentUsdc === 1 && (E?.poolSpentUsdc ?? 0) === 0, JSON.stringify(E));
  // A pending buy later resolved not-charged must come off the POOL figure, not the user's.
  const r = await attempt("§9 pending", () => spend(s, A, 0.0002, "job-9b", { confirmation: "pending", pending: { reason: "settle-timeout", handle: null } }));
  await attempt("§9 resolve", () => budget.resolvePendingPurchase({ owner: A, pendingId: r?.pendingId, outcome: "not-charged", store: s }));
  const R2 = ((await attempt("§9 breakdown 2", () => budget.agentBreakdown({ owner: A, store: s }))) ?? []).find((x: any) => x.agent === "researcher");
  check("⭐ a not-charged reversal comes off the POOL figure, never the user's", R2?.poolSpentUsdc === 0.0001 && R2?.spentUsdc === 0, JSON.stringify(R2));
}

setCaps(undefined, undefined);
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
