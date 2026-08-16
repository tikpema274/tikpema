// smoke-swap-estimate.mjs — ZERO-MONEY smoke test against the REAL App Kit SDK.
//
// WHY THIS EXISTS. Two bugs in the swap brick sailed straight through a green, fully-mocked
// test suite, because BOTH were contract violations with the SDK — and a mock, by
// construction, cannot violate a contract it is standing in for:
//
//   1. WRONG FIELD. The code read `estimate.amountOut ?? estimate.toAmount`. Both invented.
//      The real field is `estimatedOutput: { token, amount }`.
//   2. WRONG TYPE.  amountIn was passed as a NUMBER. App Kit throws
//      "Invalid swap parameters: amountIn: Expected string, received number".
//
// Either one made estimateSwapOnly throw, which _proposal.mjs correctly swallows as
// "cannot price it ⇒ cannot honestly propose it" → null → NO PROPOSAL, EVER. The guard was
// right; the price never arrived. The whole swap path was dead end-to-end while every unit
// test stayed green.
//
// estimateSwap is FREE and READ-ONLY: no approve, no swap, no signature, no money. So the
// real SDK can simply be called. Do that, and this class of bug cannot hide.
//
// Requires KIT_KEY (App Kit's swap router key), supplied PER-RUN — never read back out of the
// production Netlify env, and never as `KIT_KEY=… node …` (that lands in shell history AND argv):
//   read -rs KIT_KEY && export KIT_KEY     # paste at the prompt — nothing echoes
//   node --env-file=.env scripts/smoke-swap-estimate.mjs
//   unset KIT_KEY
// ⚠️ The old recipe here also piped the key through `sed 's/^KIT_KEY://'` — DISPROVEN (the B1 v2
// 401): the key carries its own "KIT_KEY:" prefix and is sent verbatim as `Bearer ${apiKey}`.
import { estimateSwapOnly, valueInUsdc, SWAP_TOKENS } from "../netlify/functions/_swap.mjs";
import { validateProposal } from "../netlify/functions/_proposal.mjs";
import { requireKitKey } from "./_kit-key.mjs";

const WALLET = process.argv[2] || "0xbafec950627579cf786acf875e6e216995e995a3";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// ⭐ Shape-checked, not just presence-checked: a prefix-stripped or "No value set"-contaminated key
// is NON-EMPTY, so the old truthiness test accepted it and the run died later at a confusing 401.
requireKitKey();

console.log(`── REAL App Kit estimateSwap (zero money) · wallet ${WALLET.slice(0, 10)}… ──\n`);

console.log("THE SDK CONTRACT (what the mocks could not check)");
let est;
try {
  // amountIn passed as a NUMBER on purpose — buildSwapParams must coerce it. If that
  // coercion is ever removed, this throws and the whole brick is dead again.
  est = await estimateSwapOnly({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: 5 });
  check("estimateSwapOnly accepts a NUMERIC amountIn (buildSwapParams coerces to string)", true);
} catch (e) {
  check("estimateSwapOnly accepts a NUMERIC amountIn", false, e.message);
}

if (est) {
  const amount = est?.estimatedOutput?.amount;
  check("returns `estimatedOutput` (NOT amountOut / toAmount — those were invented)", est.estimatedOutput !== undefined, `keys: ${Object.keys(est).join(", ")}`);
  check("estimatedOutput.amount is a human-decimal STRING", typeof amount === "string", `${typeof amount}: ${JSON.stringify(amount)}`);
  check("it parses to a positive number", Number.isFinite(Number(amount)) && Number(amount) > 0, `${amount}`);
  check("5 USDC → a plausible EURC amount (0.5–1.5 range)", Number(amount) > 2.5 && Number(amount) < 7.5, `${amount} EURC`);
}

console.log("\nTHE PRICING PRIMITIVES");
check("SWAP_TOKENS is exactly [USDC, EURC]", SWAP_TOKENS.join(",") === "USDC,EURC", SWAP_TOKENS.join(","));
try {
  const v = await valueInUsdc({ token: "EURC", amount: 10 });
  check("valueInUsdc prices EURC (it is NOT $1 — the cap depends on this)", Number.isFinite(v) && v > 0, `10 EURC ≈ ${v.toFixed(4)} USDC`);
} catch (e) {
  check("valueInUsdc prices EURC", false, e.message);
}

console.log("\nEND-TO-END: the real validator, against the real SDK");
try {
  const p = await validateProposal(
    { action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: 5, reasoning: "smoke" },
    { walletAddress: WALLET }
  );
  check("validateProposal PRODUCES a swap proposal (null here = the brick is dead)", p !== null);
  if (p) {
    check("  action normalized to swap_tokens", p.action === "swap_tokens", p.action);
    check("  indicativeAmountOut priced LIVE from the SDK", Number(p.indicativeAmountOut) > 0, `${p.indicativeAmountOut} EURC`);
    check("  valueUsdc + cap stamped server-side", p.valueUsdc === 5 && p.cap > 0, `value=${p.valueUsdc} cap=${p.cap}`);
  }
} catch (e) {
  check("validateProposal produces a swap proposal", false, e.message);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money (estimate only).`);
process.exit(fail === 0 ? 0 : 1);
