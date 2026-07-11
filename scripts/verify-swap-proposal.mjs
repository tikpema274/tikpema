// verify-swap-proposal.mjs — ZERO-MONEY proof of validateSwapProposal (_proposal.mjs).
//
// The server VALIDATES and RE-DERIVES; the model only decides THAT a swap is warranted.
// This pins what survives from the model (nothing but prose) and what the server owns
// (tokens, amount, cap, rate).
//
// ⚠️ IT ALSO PINS THE SDK'S RETURN SHAPE. estimateSwap returns
//     { estimatedOutput: { token, amount } }   // amount is a human-decimal STRING
// The first version of this code read `estimate.amountOut ?? estimate.toAmount` — both
// invented — so amountOut was NaN and EVERY swap proposal was refused as "unpriceable".
// The guard was right; the price never arrived. A test that mocks the REAL shape is what
// stops that returning.
//
//   node --experimental-test-module-mocks --env-file=.env scripts/verify-swap-proposal.mjs
import { mock } from "node:test";

const WALLET = "0xbafec950627579cf786acf875e6e216995e995a3";
const EURC_USD = 1.20;

let estimateReturn = { estimatedOutput: { token: "EURC", amount: "4.31" } }; // the REAL shape
let estimateThrows = false;

mock.module("../netlify/functions/_swap.mjs", {
  namedExports: {
    SWAP_TOKENS: ["USDC", "EURC"],
    valueInUsdc: async ({ token, amount }) =>
      String(token).toUpperCase() === "EURC" ? Number(amount) * EURC_USD : Number(amount),
    // This mock stands in for OUR estimateSwapOnly, which coerces amountIn to a string inside
    // buildSwapParams — so a number is fine at THIS boundary.
    //
    // ⚠️ BUT NOTE WHAT A MOCK CANNOT DO. App Kit itself demands a STRING amountIn and returns
    // `{ estimatedOutput: { amount } }`. Both of those were wrong in the first cut, and BOTH
    // bugs sailed through a green mocked test — _proposal.mjs swallowed the SDK's throw as
    // "cannot price it → no proposal", so every swap was silently unproposable. A mock can
    // only prove the logic AROUND the SDK, never the contract WITH it.
    // scripts/smoke-swap-estimate.mjs calls the REAL SDK (zero money) — that is the only
    // thing that catches this class of bug, and it is what actually caught it.
    estimateSwapOnly: async ({ walletAddress, tokenIn, tokenOut, amountIn }) => {
      if (!walletAddress) throw new Error("Invalid swap parameters: from.address required");
      if (!tokenIn || !tokenOut) throw new Error("Invalid swap parameters: tokens required");
      if (!Number.isFinite(Number(amountIn)) || Number(amountIn) <= 0) {
        throw new Error("Invalid swap parameters: amountIn must be a positive amount");
      }
      if (estimateThrows) throw new Error("pricing service down");
      return estimateReturn;
    },
  },
});
mock.module("../netlify/functions/_bridge.mjs", {
  namedExports: { resolveDestination: () => null, bridgeFee: async () => { throw new Error("n/a"); } },
});

const { validateProposal } = await import("../netlify/functions/_proposal.mjs");
const { swapCapUsdc } = await import("../netlify/functions/_arc.mjs");
const CAP = swapCapUsdc();
const ctx = { walletAddress: WALLET };

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log(`── validateSwapProposal (cap ${CAP} USDC) ──\n`);

console.log("HAPPY PATH — the server re-derives everything that gates money");
{
  estimateThrows = false;
  // The model writes loose names and its OWN numbers. None of it should survive.
  const p = await validateProposal(
    { action: "swap", tokenIn: "usdc", tokenOut: "eurc", amountIn: 5, amountOut: 999, rate: 1.5, reasoning: "r".repeat(900) },
    ctx
  );
  check("a proposal is produced", p !== null);
  check("action normalized to the EXECUTOR's step type", p?.action === "swap_tokens", p?.action);
  check("tokens re-derived from the allowlist ('usdc' → 'USDC')", p?.tokenIn === "USDC" && p?.tokenOut === "EURC");
  check("amountIn preserved (5)", p?.amountIn === 5);
  check("valueUsdc re-derived server-side", p?.valueUsdc === 5, `${p?.valueUsdc}`);
  check("cap stamped from the deployed config", p?.cap === CAP);
  check("rate re-priced from the SDK's estimatedOutput (4.31)", p?.indicativeAmountOut === 4.31, `${p?.indicativeAmountOut}`);
  check("the model's invented amountOut (999) does NOT survive", p?.indicativeAmountOut !== 999);
  check("reasoning truncated (a runaway model cannot bloat the deliverable)", p?.reasoning.length === 600);
}

console.log("\nTHE SDK SHAPE — the bug that made every swap unproposable");
{
  estimateReturn = { amountOut: 4.31 }; // the shape I originally GUESSED
  const p = await validateProposal({ action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: 5 }, ctx);
  check("a wrong/absent estimatedOutput → null (cannot price ⇒ cannot propose)", p === null);
  estimateReturn = { estimatedOutput: { token: "EURC", amount: "4.31" } }; // restore the REAL shape
  const q = await validateProposal({ action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: 5 }, ctx);
  check("the REAL shape { estimatedOutput: { amount } } prices correctly", q?.indicativeAmountOut === 4.31);
}

console.log("\nREJECT, NEVER CLAMP");
{
  const over = await validateProposal({ action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: CAP + 1 }, ctx);
  check(`over cap (${CAP + 1} USDC) → null, NOT clamped to the cap`, over === null);

  // The EURC trap: raw 22 < cap 25, but 22 EURC ≈ 26.40 USDC — OVER. The cap bounds VALUE.
  const trap = await validateProposal({ action: "swap", tokenIn: "EURC", tokenOut: "USDC", amountIn: 22 }, ctx);
  check("22 EURC (raw < cap) ≈ 26.40 USDC → null (cap bounds USDC-VALUE)", trap === null);

  const atCap = await validateProposal({ action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: CAP }, ctx);
  check(`at cap (${CAP}) → ACCEPTED (inclusive bound)`, atCap !== null);
}

console.log("\nREFUSALS — anything unresolvable is simply not proposable");
{
  check("unknown token → null", (await validateProposal({ action: "swap", tokenIn: "PEPE", tokenOut: "USDC", amountIn: 1 }, ctx)) === null);
  check("same token in/out → null", (await validateProposal({ action: "swap", tokenIn: "USDC", tokenOut: "USDC", amountIn: 1 }, ctx)) === null);
  check("amount <= 0 → null", (await validateProposal({ action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: 0 }, ctx)) === null);
  check("unknown action → null (the model cannot widen the domain)", (await validateProposal({ action: "yolo", amountIn: 1 }, ctx)) === null);

  estimateThrows = true;
  check("pricing fails → null (cannot price ⇒ cannot honestly propose)", (await validateProposal({ action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: 5 }, ctx)) === null);
  estimateThrows = false;

  // PER-USER: no wallet ⇒ we cannot price against the right account ⇒ no proposal.
  check("no walletAddress in ctx → null (per-user, never a shared fallback)", (await validateProposal({ action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: 5 }, {})) === null);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
