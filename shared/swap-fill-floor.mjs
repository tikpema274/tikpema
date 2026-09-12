// swap-fill-floor.mjs — ⛔ ONE SOURCE FOR WHOSE MINIMUM BINDS A SWAP FILL, DERIVED FROM THE PRODUCER.
//
// ═══ 🚨 THE FACT THIS ENCODES ══════════════════════════════════════════════════════════════════
//
// The executing swap (agent + DCA + user-signed) runs the B1 path in _swap.mjs: it POSTs to Circle's
// `createSwap` and signs the `minTokenOut` that comes BACK in the response. That request sends NO
// slippage parameter, so the floor below which a fill reverts is CIRCLE'S — not a number Tikpema
// chose. (Our `slippageBps: 100` reaches only `estimateSwapOnly`, the free estimate, and never a
// real swap.) See docs/swap-slippage-copy-overclaim.md and _swap.mjs `buildSwapCallData`.
//
// ⛔ THIS IS WHY THE SENTENCE IS DERIVED, NOT WRITTEN. The DCA consent authorizes N future fills the
// user will never see priced. Stating "≤1% worse" (the old agent-card bug) or "~3%" (one
// measurement) would present a figure as a property. The honest, durable statement is the MECHANIC:
// a per-fill minimum exists, it is set at execution, and it is Circle's. And it must go RED — not
// silently false — the day _swap starts sending a slippage param. So the source is derived from the
// ACTUAL request body the execute path builds (`swapExecuteRequestBody`, used verbatim by _swap.mjs):
// add a slippage key there and `SWAP_FILL_FLOOR_SOURCE` flips to `caller`, reddening the guard.
// Same shape as [[bridge-mechanic]]: the producer decides, the surface renders that value's copy.

/**
 * ⭐ THE EXACT BODY THE EXECUTE PATH POSTS TO createSwap. _swap.mjs imports this and spreads it into
 * its fetch, so there is ONE object and no second copy to drift. A guard derives the floor source
 * from what this returns; if a slippage field is ever added here, the source and the copy both move.
 *
 * ⚠️ Pure and dependency-free (safe in the browser bundle): it constructs a plain object, no I/O.
 */
export function swapExecuteRequestBody({ tokenInAddress, tokenOutAddress, fromAddress, toAddress, amount }) {
  return {
    tokenInAddress,
    tokenOutAddress,
    tokenInChain: "Arc_Testnet",
    fromAddress,
    toAddress,
    amount,
  };
}

/** ⛔ Any key by which a caller would constrain the fill floor itself. If the execute body carries
 *  one of these, the binding minimum is OURS, not Circle's, and the copy must change. Kept as a set
 *  so a NEW slippage-shaped key is caught by name rather than silently ignored. */
export const SLIPPAGE_KEYS = Object.freeze([
  "slippage", "slippageBps", "slippageTolerance", "maxSlippage", "minTokenOut", "minAmountOut", "stopLimit",
]);

/**
 * ⭐⭐ THREE VALUES, AND THE THIRD IS NOT A PLACEHOLDER.
 *   circle   the execute body sends no slippage param → Circle's returned minTokenOut binds.
 *   caller   the body carries a slippage/min-out key → the floor is one WE set in advance.
 *   unknown  the body could not be read → claim neither (a body we cannot inspect must not assert).
 */
export const SWAP_FILL_FLOOR_SOURCES = Object.freeze(["circle", "caller", "unknown"]);

/** Derive whose minimum binds FROM the actual execute-path request body. ⛔ Not a stored label —
 *  read off the producer, so it cannot disagree with what the swap actually sends. */
export function swapFillFloorSource(requestBody) {
  if (!requestBody || typeof requestBody !== "object") return "unknown";
  const keys = Object.keys(requestBody);
  return SLIPPAGE_KEYS.some((k) => keys.includes(k)) ? "caller" : "circle";
}

/**
 * ⭐⭐ THE SENTENCES, KEYED BY SOURCE. The surface renders the source's copy and is structurally
 * unable to state another. ⛔ No percentage in any of them: a rate stated as a property is exactly
 * the "≤1% worse" / "~3%" error this exists to prevent.
 */
// ⭐ TWO PHRASINGS OF THE SAME FACT, ONE PRODUCER. `summary` is for a recurring mandate ("each
// fill"); `single` is for one swap now (the agent path, which executes directly). Both are bound to
// the same derived source, so a slippage param flips BOTH — there is no second producer to drift.
export const SWAP_FILL_FLOOR_COPY = Object.freeze({
  circle: Object.freeze({
    summary:
      "Each fill has an on-chain minimum below which it will not swap. That minimum is set by " +
      "Circle at the moment each fill runs — it is not a rate Tikpema picks in advance — so it " +
      "moves with the market from one fill to the next.",
    single:
      "This swap will not go through below an on-chain minimum set by Circle at the moment it " +
      "runs — not a rate Tikpema picks in advance.",
  }),
  caller: Object.freeze({
    // Only reachable once _swap sends a slippage param. Named so the guard reddens BEFORE this ships.
    summary: "Each fill will not swap below a minimum Tikpema sets in advance for every fill.",
    single: "This swap will not go below a minimum Tikpema sets in advance.",
  }),
  unknown: Object.freeze({
    // ⛔ Claims neither. A body we could not inspect cannot say whose minimum binds.
    summary: "How each fill's on-chain minimum is set could not be determined.",
    single: "How this swap's on-chain minimum is set could not be determined.",
  }),
});

/** One accessor, so no surface indexes the map directly or reaches a key that does not exist. */
export function swapFillFloorCopy(v) {
  return SWAP_FILL_FLOOR_COPY[SWAP_FILL_FLOOR_SOURCES.includes(v) ? v : "unknown"];
}

/**
 * ⭐ THE LIVE SOURCE, computed at load from the REAL producer with a representative body. This is
 * what the DCA surface renders copy for. When _swap's execute body gains a slippage key,
 * `swapExecuteRequestBody` returns it, this flips to `caller`, and the guard's `=== "circle"`
 * assertion goes red — the copy fails rather than quietly becoming false.
 */
export const SWAP_FILL_FLOOR_SOURCE = swapFillFloorSource(
  swapExecuteRequestBody({
    tokenInAddress: "0x0", tokenOutAddress: "0x0", fromAddress: "0x0", toAddress: "0x0", amount: "0",
  }),
);
