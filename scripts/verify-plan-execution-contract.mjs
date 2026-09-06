#!/usr/bin/env node
// verify-plan-execution-contract.mjs — DOES `executed` MEAN WHAT IT SAYS?
//
//   node --experimental-test-module-mocks scripts/verify-plan-execution-contract.mjs
//   (also: npm run test:plancontract)
//
// ═══ 🚨 THE DEFECT THIS PINS ═════════════════════════════════════════════════════════════════
// `agent-execute-plan` answered a HARDCODED `executed: true`, meaning "the executor phase was
// entered". Measured on production 2026-09-05: a plan refused at the per-bridge cap returned
// `executed:true, stepsRun:0, stoppedAt:0, completed:false` and moved nothing. The name was false
// in exactly the case a reader most needs it true, and `plan-path-watch` had to route around the
// field entirely rather than trust it.
//
// ⭐ A field name is a claim. This suite asserts the claim, in BOTH directions, by driving the REAL
// handler — nothing ran ⇒ false, something ran ⇒ true. One direction alone is satisfied by a
// constant. [[field-name-must-be-true-in-every-case]] [[collapse-needs-pairwise-inequality]]
//
// ⛔ AND THE SECOND HALF WAS USER-FACING: the stopping reason lived only in
// `results[stoppedAt].blocked` while the panel renders a TOP-LEVEL `blocked` the response never
// carried — so a refused plan said "Stopped at step 1" and never said why.

import { mock } from "node:test";
const R = "../netlify/functions/";
// ⛔ EVERY MOCK SPREADS THE REAL MODULE. A partial mock fails at INSTANTIATION — it does not go
// red, it stops loading, and both arms then fail identically, which reads as inconclusive.
const realBridge  = await import(R + "_bridge.mjs");
const realBudget  = await import(R + "_budget.mjs");
const realWallets = await import(R + "_agent-wallets.mjs");
const realAuth    = await import(R + "_auth.mjs");
const realActions = await import(R + "_actions.mjs");

const OWNER = "0xfd801d082479e69f93bf79ccbf5f9dfe3c615767";
let executorImpl = async () => ({ ok: false, blocked: "not reached" });

mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {},
  getStore: () => ({ setJSON: async () => {}, get: async () => null, list: async () => ({ blobs: [] }) }) }});
mock.module(R + "_auth.mjs", { namedExports: { ...realAuth, requireSession: () => ({ address: OWNER }) }});
mock.module(R + "_agent-wallets.mjs", { namedExports: { ...realWallets, ensureOwnerWallet: async () => ({ walletAddress: OWNER }) }});
mock.module(R + "_budget.mjs", { namedExports: { ...realBudget, daySpend: async () => 0, budgetConfig: () => ({ PERIOD_CEILING_USDC: 10000 }) }});
mock.module(R + "_bridge.mjs", { namedExports: { ...realBridge,
  bridgeFee: async ({ amountUsdc }) => ({ feeUsdc: 0.05, netUsdc: amountUsdc, maxFee: 50000, amountMinor: Math.round(amountUsdc * 1e6) }) }});
// ⭐ The executor is the BOUNDARY — swapped per case so the handler's own bookkeeping is what is
// under test, never the executor's. `valueOfStep` stays REAL.
mock.module(R + "_actions.mjs", { namedExports: { ...realActions, executeAction: async (...a) => executorImpl(...a) }});

const { handler } = await import(R + "agent-execute-plan.mjs");

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

/** @param {number[]} amounts one step per amount @param {Function} exec the executor stand-in */
const runPlan = async (amounts, exec) => {
  executorImpl = exec;
  const out = await handler({ httpMethod: "POST", headers: { authorization: "Bearer x" },
    body: JSON.stringify({ plan: amounts.map((amountUsdc) => ({ type: "bridge_usdc", amountUsdc, destination: "base", reasoning: "contract" })) }) });
  return JSON.parse(out.body);
};
const run = (amountUsdc, exec) => runPlan([amountUsdc], async () => exec);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  the plan execution contract — does `executed` mean what it says?    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 ⛔⛔ NOTHING RAN ⇒ executed IS FALSE");
{
  // 200 is over the 25 USDC per-bridge cap, so the loop refuses at step 1, before executeAction.
  const r = await run(200, { ok: false, blocked: "must not be reached" });
  ok("⭐ non-vacuity — the plan really was refused at the first step", r.stoppedAt === 0 && r.stepsRun === 0,
    `stoppedAt=${r.stoppedAt} stepsRun=${r.stepsRun}`);
  ok("⭐⭐ `executed` is FALSE — nothing ran, and the field says so", r.executed === false, `executed=${r.executed}`);
  ok("⛔ …and `completed` is false too", r.completed === false);
  ok("⭐⭐ the STOPPING REASON is on the response, not buried in results[]",
    typeof r.blocked === "string" && /exceeds per-bridge limit/.test(r.blocked), JSON.stringify(r.blocked));
  ok("⭐ …and it matches the per-step reason it was hoisted from — one claim, not a second copy",
    r.blocked === r.results[0].blocked);
}

section("2 ⭐ SOMETHING RAN ⇒ executed IS TRUE — the other direction");
{
  const r = await run(1, { ok: true, receipt: { burnHash: "0xabc" } });
  ok("⭐ non-vacuity — a step actually ran", r.stepsRun === 1, `stepsRun=${r.stepsRun}`);
  ok("⭐⭐ `executed` is TRUE", r.executed === true);
  ok("⛔ …and `completed` is true when nothing stopped it", r.completed === true && r.stoppedAt === null);
  ok("⭐ `blocked` is NULL when every step ran — its presence means something stopped the plan",
    r.blocked === null, JSON.stringify(r.blocked));
}

section("3 ⭐⭐ PAIRWISE — the field DISCRIMINATES, it is not a constant");
{
  const refused = await run(200, { ok: false, blocked: "must not be reached" });
  const ran = await run(1, { ok: true, receipt: {} });
  ok("⭐⭐ the two runs DIFFER on `executed` — a constant would satisfy either section alone",
    refused.executed !== ran.executed, `${refused.executed} vs ${ran.executed}`);
  ok("⭐ …and `executed` tracks `stepsRun > 0` in both",
    refused.executed === (refused.stepsRun > 0) && ran.executed === (ran.stepsRun > 0));
  // 🚨 THE EXACT PRODUCTION READING THAT EXPOSED THIS.
  ok("🚨 REGRESSION — the measured shape (stepsRun 0, stoppedAt 0, completed false) is NOT `executed`",
    refused.stepsRun === 0 && refused.stoppedAt === 0 && refused.completed === false && refused.executed === false);
}

section("3b 🚨 THE PARTIAL RUN — where `executed` and `completed` MUST diverge");
{
  // ═══ ⛔⛔ THE CASE THE FIRST DRAFT MISSED, AND IT WAS THE DANGEROUS ONE ═══════════════════════
  // Mutating `executed: stepsRun > 0` to `executed: allOk` was NOT CAUGHT: in a one-step plan the
  // two definitions coincide — nothing ran ⇒ neither, everything ran ⇒ both. Only a PARTIAL run
  // separates them, and it is the case that matters most: step 1 bridged real USDC, step 2 was
  // refused. `allOk` would answer `executed: false` for a plan THAT MOVED MONEY — the original bug
  // inverted, and strictly worse than the literal it replaced.
  // ⭐ Two fixtures that agree on both definitions cannot tell them apart. The discriminating case
  // has to be constructed deliberately. [[collapse-needs-pairwise-inequality]]
  const r = await runPlan([1, 200], async () => ({ ok: true, receipt: { burnHash: "0xabc" } }));
  ok("⭐ non-vacuity — step 1 ran and step 2 was refused", r.stepsRun === 1 && r.stoppedAt === 1,
    `stepsRun=${r.stepsRun} stoppedAt=${r.stoppedAt}`);
  ok("⭐⭐ `executed` is TRUE — money moved on step 1, whatever happened after",
    r.executed === true, `executed=${r.executed}`);
  ok("⛔ …while `completed` is FALSE — the two fields are NOT the same claim",
    r.completed === false && r.executed !== r.completed);
  ok("⭐ the stopping reason is still hoisted for a partial run",
    typeof r.blocked === "string" && /exceeds per-bridge limit/.test(r.blocked));
}

section("4 ⛔ THE PANEL NO LONGER GATES ITS OUTCOME ON `executed`");
{
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync(new URL("../src/components/MyAgentPanel.tsx", import.meta.url), "utf8");
  ok("⛔ the plan outcome block is gated on `results`, not on `executed`",
    /\{planRun\?\.results && \(/.test(panel) && !/\{planRun\?\.executed && \(/.test(panel));
  ok("⭐ …and a run where NOTHING happened says so, rather than 'stopped at step 1'",
    /Nothing ran — stopped at step/.test(panel));
  ok("⭐ the top-level reason is still rendered", /planRun\?\.blocked && /.test(panel));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
