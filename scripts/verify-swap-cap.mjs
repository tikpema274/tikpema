// verify-swap-cap.mjs — ZERO-MONEY proof of the per-SWAP cap.
//
// THE HOLE THIS CLOSES: swap_tokens was the ONLY executable action with no per-transaction
// bound. transfer_usdc has sendCapUsdc, bridge_usdc has bridgeCapUsdc — swap had only the
// day-ceiling, so a single bad instruction could swap the whole wallet in one action. That
// becomes a far worse hole the moment swap is PROPOSABLE, so the cap lands first.
//
// THE SUBTLETY THIS PINS: the cap is in USDC-EQUIVALENT, not in the input token. A swap's
// amountIn may be EURC, and EURC != $1. Bounding the raw amountIn would silently mis-bound
// every EURC→USDC swap — so the check must run AFTER valueOfStep converts, but BEFORE
// canSpendDay, so an over-cap swap returns the CAP message rather than the ceiling one.
//
//   node --experimental-test-module-mocks --env-file=.env scripts/verify-swap-cap.mjs
import { mock } from "node:test";

// A fixed, known EUR/USD rate so the USDC-equivalence assertions are deterministic.
const EURC_USD = 1.20;

mock.module("../netlify/functions/_swap.mjs", {
  namedExports: {
    SWAP_TOKENS: ["USDC", "EURC"],
    // The real one prices via the swap provider; here it is the identity for USDC and a
    // fixed rate for EURC — enough to prove the cap bounds USDC-VALUE, not raw amount.
    valueInUsdc: async ({ token, amount }) =>
      String(token).toUpperCase() === "EURC" ? Number(amount) * EURC_USD : Number(amount),
    // If the cap works, we NEVER reach this. Reaching it is a test failure.
    agentSwap: async () => {
      swapExecuted = true;
      return { txHash: "0xshould-not-happen", state: "submitted" };
    },
  },
});
mock.module("../netlify/functions/_budget.mjs", {
  namedExports: {
    canSpendDay: async () => ({ allowed: true }),
    recordAgentSpend: async () => {},
    // ⚠️ ENUMERATED MOCKS PIN THE MODULE'S EXPORT LIST AS A SIDE EFFECT. Adding
    // `shoutLedgerFailure` to _budget.mjs broke this suite with a SyntaxError, because
    // _actions.mjs imports it and this mock did not provide it. The spike suites spread
    // `...realBudget` and were unaffected — that is the robust shape when you only mean
    // to override one or two functions.
    shoutLedgerFailure: () => {},
  },
});
// ⚠️ NOT a weakening of the pause switch — an ISOLATION of the thing under test.
// executeAction now calls assertNotPaused(), and _pause.mjs FAILS CLOSED: with no Blobs
// configured (which is the case in a zero-money test) it correctly refuses every action with
// "could not verify the pause switch". That refusal is right in production and wrong here — it
// preempted the cap, so every assertion below was passing/failing on the PAUSE message and the
// cap was never actually exercised. Pinning pause to "running" puts the cap back under test.
// Pause enforcement has its own dedicated proof: scripts/verify-pause-enforcement.mjs.
mock.module("../netlify/functions/_pause.mjs", {
  namedExports: { assertNotPaused: async () => null },
});

let swapExecuted = false;
const { executeAction } = await import("../netlify/functions/_actions.mjs");
const { swapCapUsdc } = await import("../netlify/functions/_arc.mjs");

const CAP = swapCapUsdc();
const WALLET = "0xbafec950627579cf786acf875e6e216995e995a3";
const swap = (amountIn, tokenIn = "USDC", tokenOut = tokenIn === "USDC" ? "EURC" : "USDC") =>
  executeAction({ type: "swap_tokens", tokenIn, tokenOut, amountIn }, { walletAddress: WALLET });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

console.log(`── per-swap cap (AGENT_SWAP_CAP_USDC = ${CAP}) ──\n`);

console.log("USDC in (1:1 — raw amount IS the USDC value)");
{
  swapExecuted = false;
  const over = await swap(CAP + 0.01);
  check("OVER cap → blocked", over.ok === false && /per-swap limit/.test(over.blocked || ""), over.blocked);
  check("nothing signed (agentSwap never reached)", swapExecuted === false);
}
{
  // `>` is inclusive: an AT-cap swap must PASS the cap gate (same bound as send/bridge).
  swapExecuted = false;
  const at = await swap(CAP);
  check("AT cap → passes the gate (bound is inclusive)", at.ok === true || !/per-swap limit/.test(at.blocked || ""), at.blocked ?? "reached executor");
}

console.log("\nEURC in (the subtlety: EURC != $1 — the cap bounds USDC-VALUE, not raw amount)");
{
  // Just UNDER the cap in USDC terms. Raw amountIn is BELOW the cap number, and its USDC
  // value is also below → must pass.
  const okAmt = (CAP / EURC_USD) - 0.1; // e.g. 25/1.20 - 0.1 ≈ 20.73 EURC ≈ 24.88 USDC
  swapExecuted = false;
  const under = await swap(okAmt, "EURC");
  check(
    `${okAmt.toFixed(2)} EURC ≈ ${(okAmt * EURC_USD).toFixed(2)} USDC → passes`,
    !/per-swap limit/.test(under.blocked || ""),
    under.blocked ?? "reached executor"
  );
}
{
  // THE TRAP. Raw amountIn (22) is BELOW the cap number (25), so a naive cap comparing the
  // RAW amount would let this through — but 22 EURC ≈ 26.40 USDC, which is OVER. The cap
  // must catch it. This single assertion is why the check runs after valueOfStep.
  const trap = 22;
  const trapUsdc = trap * EURC_USD; // 26.40
  swapExecuted = false;
  const over = await swap(trap, "EURC");
  check(
    `${trap} EURC (raw < cap ${CAP}!) but ≈ ${trapUsdc.toFixed(2)} USDC → BLOCKED`,
    over.ok === false && /per-swap limit/.test(over.blocked || ""),
    over.blocked ?? "NOT BLOCKED — the cap is bounding the RAW amount, not USDC value"
  );
  check("nothing signed on the EURC trap", swapExecuted === false);
}

console.log("\nFail-closed config");
{
  const saved = process.env.AGENT_SWAP_CAP_USDC;
  process.env.AGENT_SWAP_CAP_USDC = "not-a-number";
  try {
    swapCapUsdc();
    check("garbled cap → throws", false, "it did NOT throw — the cap is fail-OPEN");
  } catch (e) {
    check("garbled cap → REFUSES to swap (fail-closed)", /misconfigured/i.test(e.message), e.message.slice(0, 48));
  }
  process.env.AGENT_SWAP_CAP_USDC = saved;
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
