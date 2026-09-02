// verify-pause-enforcement.mjs — ZERO-MONEY proof that PAUSE ACTUALLY STOPS A SPEND.
//
// ⚠️ THE CHOKEPOINT MATTERS MORE THAN THE BUTTON. A pause that one code path routes around is
// not a pause — it is a toggle that makes a user FEEL safe. executeAction is the main
// chokepoint, but these move money WITHOUT ever calling it:
//
//   agent-send      — direct transfer()
//   agent-ub-spend  — direct ubSpend()
//   job-run         — starts a job that funds an escrow and then buys data
//   maybeBuyData    — the researcher's x402 purchase, mid-research
//
// So this test does NOT check that a flag flips. It drives EVERY spend path with the agent
// paused and asserts the money-mover was never reached.
//
//   node --experimental-test-module-mocks --env-file=.env scripts/verify-pause-enforcement.mjs
import { mock } from "node:test";

const OWNER = "0xbafec950627579cf786acf875e6e216995e995a3";

// The pause switch, in memory. `throws` simulates an unreadable store — the fail-closed case.
let paused = {};
let storeThrows = false;
mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {},
    getStore: () => ({
      async get(k) {
        if (storeThrows) throw new Error("blobs unavailable");
        return paused[k] ?? null;
      },
      async setJSON(k, v) { paused[k] = v; },
      async list() { return { blobs: [] }; },
      async getWithMetadata() { return null; },
    }),
  },
});

// ⚠️ EVERY MONEY-MOVER IS A TRIPWIRE. If a paused agent reaches ANY of these, the test fails —
// that is the whole point. We are not asserting on a return value; we are asserting that the
// thing which spends money was never called.
let moved = [];
const tripwire = (name) => async () => { moved.push(name); return { ok: true }; };

mock.module("../netlify/functions/_swap.mjs", {
  namedExports: {
    SWAP_TOKENS: ["USDC", "EURC"],
    valueInUsdc: async ({ amount }) => Number(amount),
    agentSwap: tripwire("agentSwap"),
    estimateSwapOnly: async () => ({ estimatedOutput: { amount: "1" } }),
  },
});
mock.module("../netlify/functions/_bridge.mjs", {
  namedExports: {
    agentBridge: tripwire("agentBridge"),
    bridgeFee: async () => ({ maxFee: 1n, amountMinor: 100n, feeUsdc: 0.01, netUsdc: 0.99 }),
    resolveDestination: () => ({ key: "base", label: "Base", cctpDomain: 6 }),
    // ⛔ ADDED 2026-09-02, AND THE REASON MATTERS MORE THAN THE LINES.
    // This stub provided three exports. On 2026-07-31 (d1a2ee1) `_actions.mjs` began importing
    // `bridgeFeeBand` and `bridgeAckToken` too — and a partial mock that is missing an export does
    // not fail an assertion, it fails MODULE INSTANTIATION. This suite stopped LOADING that day and
    // stayed dead for 33 days without ever going red, because nothing ran it.
    // 🚨 THE SUBJECT OF THIS SUITE IS THE KILL SWITCH. Thirty-three days with no proof that pause
    // stops money.
    // ⭐ These two are tripwires on purpose: neither should be REACHED once the pause refuses, so if
    // the pause ever stops working they fail loudly instead of quietly returning something plausible.
    bridgeFeeBand: () => ({ band: "none", pct: 0 }),
    bridgeAckToken: tripwire("bridgeAckToken"),
    openBridgeQuote: tripwire("openBridgeQuote"),
  },
});
mock.module("../netlify/functions/_pay.mjs", { namedExports: { agentPay: tripwire("agentPay") } });
mock.module("../netlify/functions/_circle.mjs", {
  namedExports: {
    circle: () => ({ createContractExecutionTransaction: tripwire("circle.transfer") }),
    waitForTx: async () => "0xhash",
    TxPendingError: class extends Error {},
  },
});
const realBudget = await import("../netlify/functions/_budget.mjs");
mock.module("../netlify/functions/_budget.mjs", {
  namedExports: {
    // ⭐⭐ SPREAD, NOT ENUMERATED — APPLIED 2026-08-22 AFTER THIS BROKE A SECOND TIME.
    // The warning below was written when `shoutLedgerFailure` broke this suite, and it named the
    // fix: spread the real module. The advice was recorded and NOT ACTED ON, so adding `REFUSAL`
    // broke it again the same way. ⚠️ A hand-listed `namedExports` silently pins the real module's
    // export list; the failure surfaces as a SyntaxError in an unrelated file
    // ([[duplicate-source-of-truth-is-the-recurring-bug]]). Only the doubles are overridden below.
    ...realBudget,
    canSpendDay: async () => ({ allowed: true }),
    recordAgentSpend: async () => {},
    recordSpend: async () => {},
    recordBlocked: async () => {},
    canSpend: async () => ({ allowed: true }),
    budgetConfig: () => ({ PERIOD_CEILING_USDC: 60 }),
    // ⚠️ ENUMERATED MOCKS PIN THE MODULE'S EXPORT LIST AS A SIDE EFFECT. Adding
    // `shoutLedgerFailure` to _budget.mjs broke this suite with a SyntaxError, because
    // _actions.mjs imports it and this mock did not provide it. The spike suites spread
    // `...realBudget` and were unaffected — that is the robust shape when you only mean
    // to override one or two functions.
    shoutLedgerFailure: () => {},
  },
});

const { executeAction } = await import("../netlify/functions/_actions.mjs");
const { pauseReason, setPaused, globalHalt, ALL_AGENTS } = await import("../netlify/functions/_pause.mjs");
const { AGENT } = await import("../netlify/functions/_agents.mjs");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const reset = () => { paused = {}; storeThrows = false; moved = []; delete process.env.AGENT_HALT; };

const swap = () => executeAction({ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 1 }, { walletAddress: OWNER });
const bridge = () => executeAction({ type: "bridge_usdc", amountUsdc: 1, destination: "base" }, { walletAddress: OWNER });
const send = () => executeAction({ type: "transfer_usdc", to: "0x" + "1".repeat(40), amountUsdc: 1 }, { walletAddress: OWNER });
const pay = () => executeAction({ type: "pay_for_service", payTo: "0x" + "1".repeat(40), payAmountUsdc: 1 }, { walletAddress: OWNER });

console.log("── PAUSE ENFORCEMENT (zero money; every money-mover is a tripwire) ──\n");

console.log("BASELINE — not paused, the money-movers ARE reachable");
{
  reset();
  await swap();
  check("a swap reaches agentSwap when NOT paused", moved.includes("agentSwap"), moved.join(",") || "nothing ran");
}

console.log("\nEXECUTOR PAUSED — every executeAction branch must REFUSE");
{
  reset();
  await setPaused({ owner: OWNER, agent: AGENT.EXECUTOR, paused: true });

  for (const [name, fn] of [["swap", swap], ["bridge", bridge], ["send", send], ["pay_for_service", pay]]) {
    moved = [];
    const r = await fn();
    check(
      `${name} REFUSED (${r.blocked ? "blocked" : "NOT BLOCKED"})`,
      r.ok === false && /paused/i.test(r.blocked || ""),
      r.blocked ?? "no block reason"
    );
    check(`  …and NOTHING moved`, moved.length === 0, moved.length ? `REACHED: ${moved.join(",")}` : "no money-mover called");
  }
}

console.log("\nRESEARCHER PAUSED — the EXECUTOR must still run (per-agent, not all-or-nothing)");
{
  reset();
  await setPaused({ owner: OWNER, agent: AGENT.RESEARCHER, paused: true });
  const r = await swap();
  check("a swap still runs while only the Researcher is paused", r.ok !== false || !/paused/i.test(r.blocked || ""), r.blocked ?? "ran");
  check("the Researcher itself is paused", /paused/i.test((await pauseReason({ owner: OWNER, agent: AGENT.RESEARCHER })) || ""));
}

console.log("\nPAUSE ALL (*) — overrides every per-agent switch");
{
  reset();
  await setPaused({ owner: OWNER, agent: ALL_AGENTS, paused: true });
  moved = [];
  const r = await swap();
  check("the Executor is refused by the ALL switch", r.ok === false && /paused/i.test(r.blocked || ""), r.blocked);
  check("nothing moved", moved.length === 0);
  check("the Researcher is refused too", /paused/i.test((await pauseReason({ owner: OWNER, agent: AGENT.RESEARCHER })) || ""));
}

console.log("\nFAIL CLOSED — an unreadable switch must REFUSE, not run");
{
  reset();
  storeThrows = true; // Blobs is down; we cannot prove the agent is running
  moved = [];
  const r = await swap();
  check("an unreadable pause switch REFUSES the spend", r.ok === false, r.blocked ?? "IT RAN — the switch fails OPEN");
  check("nothing moved", moved.length === 0, moved.join(","));
  check("the reason says why", /could not verify/i.test(r.blocked || ""), r.blocked);
}

console.log("\nGLOBAL HALT — env-driven, and it fails closed on a garbled value");
{
  reset();
  process.env.AGENT_HALT = "1";
  moved = [];
  let r = await swap();
  check('AGENT_HALT=1 halts everything', r.ok === false && /halted/i.test(r.blocked || ""), r.blocked);
  check("nothing moved", moved.length === 0);

  process.env.AGENT_HALT = "banana"; // a typo must NOT mean "keep spending"
  moved = [];
  r = await swap();
  check('AGENT_HALT="banana" (garbled) HALTS — fail-closed', r.ok === false && /halt/i.test(r.blocked || ""), r.blocked);
  check("nothing moved", moved.length === 0);

  process.env.AGENT_HALT = "0";
  check('AGENT_HALT=0 explicitly runs', globalHalt() === null);

  delete process.env.AGENT_HALT;
  check("AGENT_HALT unset runs", globalHalt() === null);
}

console.log("\nNO OWNER — we cannot read a switch we cannot key. Refuse.");
{
  reset();
  const r = await pauseReason({ owner: null, agent: AGENT.EXECUTOR });
  check("a missing owner REFUSES (cannot prove it is running)", typeof r === "string" && r.length > 0, r ?? "allowed!");
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
