import { bridgeCapUsdc, swapCapUsdc } from "./_arc.mjs";
import { resolveDestination, bridgeFee } from "./_bridge.mjs";
import { SWAP_TOKENS, valueInUsdc, estimateSwapOnly } from "./_swap.mjs";

// PROPOSAL VALIDATION PLANE — the model PROPOSES, the server VALIDATES and RE-DERIVES.
//
// ── THE DISCIPLINE THIS COPIES ──────────────────────────────────────────────────
// _research.mjs:419-422 already OVERWRITES the model's `sources` array with the sources
// actually fetched, discarding whatever the model wrote. The model's word is never the
// record. A bridge proposal is the same problem with money attached, so it gets the same
// treatment — only more so, because a wrong number here becomes a real transfer.
//
// What the model is ALLOWED to contribute:
//   • that a bridge is warranted at all (the decision)
//   • a destination NAME (free text — we resolve it, we don't trust it)
//   • an amount (a number — we bound it, we don't trust it)
//   • prose reasoning (display-only, never parsed, never acted on)
//
// What the model may NOT contribute:
//   • the FEE. The model's `expectedFee` is DISCARDED outright. The forwarder fee is
//     volatile (~0.2 USDC to an L2, ~1.5–14 to Ethereum L1 — _bridge.mjs:16-17) and a
//     stale or hallucinated fee is exactly how a user approves terms that no longer
//     exist. We re-price it LIVE from IRIS here, store it as INDICATIVE only, and
//     executeAction re-prices it AGAIN at execution and re-applies the fee-floor
//     (_actions.mjs:177-190). The number shown at approve time is a courtesy, never a
//     commitment.
//   • the destination KEY, the cap, or anything that gates money.
//
// REJECT, NEVER CLAMP. An out-of-range amount does not become the cap; an unknown
// destination does not become a default. Any failure → null → the brief renders with NO
// proposal, exactly as a brief does today. A missing proposal is a fine outcome; a wrong
// one is not.
//
// ── WHERE THE VETTING GATE ATTACHES (not built) ────────────────────────────────
// A future "is this destination/asset safe to move funds to" check belongs at the marked
// point below — after the destination resolves and the amount is bounded, before the
// proposal is returned. It is the single chokepoint where an unvetted target can be
// refused before a user is ever shown an approve button. Nothing downstream of here can
// re-introduce a rejected destination, because the approve endpoint reads the destination
// from THIS validated object, never from the client.

const MAX_REASONING = 600;

// Normalize the model's action name into an executor step type (_actions.mjs). The model
// writes prose-ish names ("bridge", "swap"); the executor speaks "bridge_usdc" /
// "swap_tokens". Anything we don't recognise → null → no proposal. The model can never
// widen this set: an unknown action is simply not proposable.
function normalizeAction(a) {
  const s = String(a || "").trim().toLowerCase();
  if (s === "bridge" || s === "bridge_usdc") return "bridge_usdc";
  if (s === "swap" || s === "swap_tokens") return "swap_tokens";
  return null;
}

// Resolve a model-written token NAME to a symbol from OUR allowlist — same discipline as
// resolveDestination for chains. "eur", "EURC", "euro coin" → "EURC", or null.
function resolveToken(t) {
  const s = String(t || "").trim().toUpperCase();
  return SWAP_TOKENS.find((tok) => tok.toUpperCase() === s) ?? null;
}

// Validate a model-emitted proposal into a server-authored one, or return null.
//
// `ctx.walletAddress` is the CALLER'S OWN agent SCA (server-resolved from the session by
// the job spine — never client-supplied). A swap proposal is priced against THAT wallet, so
// the quote is the one that wallet would actually get. Per-user by construction.
export async function validateProposal(raw, ctx = {}) {
  if (!raw || typeof raw !== "object") return null;

  const action = normalizeAction(raw.action);
  if (!action) return null;

  if (action === "swap_tokens") return validateSwapProposal(raw, ctx);

  // ── Destination: a NAME from the model → a KEY from our own registry. If it does not
  //    resolve to one of the 8 supported chains, there is no proposal. ──
  const dest = resolveDestination(raw.destination);
  if (!dest) return null;

  // ── Amount: must be a finite positive number within the deployed per-bridge cap.
  //    Note bridgeCapUsdc() throws on a misconfigured env (fail-closed) — we let that
  //    propagate rather than silently proposing under an unknown cap. ──
  const amountUsdc = Number(raw.amountUsdc ?? raw.amount);
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) return null;
  const cap = bridgeCapUsdc();
  if (amountUsdc > cap) return null; // reject, never clamp to the cap

  // ── Fee: the model's number is IGNORED. Price it ourselves, live. ──
  let fee;
  try {
    fee = await bridgeFee({ amountUsdc, cctpDomain: dest.cctpDomain });
  } catch {
    return null; // cannot price it → cannot honestly propose it
  }
  // Fee-floor: if the fee meets or exceeds the amount, nothing would arrive. Refuse to
  // propose an un-settleable bridge rather than let a user approve one.
  if (fee.maxFee >= fee.amountMinor) return null;

  // ┌──────────────────────────────────────────────────────────────────────────┐
  // │ VETTING GATE ATTACHES HERE (future).                                     │
  // │ Destination is resolved, amount is bounded, fee is real. A vetting check  │
  // │ would run now and `return null` to suppress the proposal. Deliberately    │
  // │ not built — with only 8 first-party CCTP destinations there is nothing    │
  // │ unvetted to refuse yet.                                                   │
  // └──────────────────────────────────────────────────────────────────────────┘

  return {
    action,                              // "bridge_usdc" — normalized, not the model's string
    destination: dest.key,               // OUR key, from OUR registry
    destinationLabel: dest.label,
    amountUsdc,                          // bounded by the deployed cap
    cap,
    // INDICATIVE ONLY. Re-priced at execution; the user is told this is not a quote.
    indicativeFeeUsdc: Number(fee.feeUsdc.toFixed(6)),
    indicativeNetUsdc: Number(fee.netUsdc.toFixed(6)),
    pricedAt: new Date().toISOString(),
    // Display-only prose. Never parsed, never acted on. Truncated so a runaway model
    // cannot bloat the deliverable.
    reasoning: String(raw.reasoning || "").slice(0, MAX_REASONING),
    validatedAt: new Date().toISOString(),
  };
}

// ── SWAP proposals (USDC ↔ EURC on Arc) ────────────────────────────────────────────────
//
// Same discipline as the bridge above, and for the same reason: the model may decide THAT a
// swap is warranted, name two tokens, and name an amount. It may not decide the RATE, the
// cap, or the token addresses. Everything that gates money is re-derived here.
//
// WHY SWAP IS A SAFE DOMAIN TO OPEN. USDC and EURC are both first-party Circle stablecoins,
// already in this app, swapped through Circle's own Swap Kit. This is an FX conversion
// between two regulated e-money tokens — not "which coin to buy". There is no unvetted token
// and no scam surface, which is exactly why the vetting gate above can stay legitimately
// empty. The user still approves before anything executes.
//
// ⚠️ THE CAP IS IN USDC-EQUIVALENT. amountIn may be EURC, and EURC != $1. We convert with
// valueInUsdc() before comparing — bounding the raw amountIn would silently mis-bound every
// EURC→USDC swap (22 EURC ≈ 26.40 USDC sails past a raw cap of 25). This mirrors the check
// in _actions.mjs, which re-applies it at execution.
async function validateSwapProposal(raw, ctx) {
  // The wallet the swap would run from — needed to price it, and the thing that makes this
  // per-user. No wallet ⇒ we cannot price it against the right account ⇒ no proposal.
  const walletAddress = ctx?.walletAddress;
  if (!walletAddress) return null;

  // ── Tokens: NAMES from the model → symbols from OUR allowlist. ──
  const tokenIn = resolveToken(raw.tokenIn ?? raw.from);
  const tokenOut = resolveToken(raw.tokenOut ?? raw.to);
  if (!tokenIn || !tokenOut) return null;
  if (tokenIn === tokenOut) return null; // a swap to itself is not a proposal

  // ── Amount: finite, positive. ──
  const amountIn = Number(raw.amountIn ?? raw.amount ?? raw.amountUsdc);
  if (!Number.isFinite(amountIn) || amountIn <= 0) return null;

  // ── Cap, in USDC-equivalent. swapCapUsdc() throws on a garbled env (fail-closed); we let
  //    that propagate rather than silently proposing under an unknown cap. ──
  let valueUsdc;
  try {
    valueUsdc = await valueInUsdc({ token: tokenIn, amount: amountIn });
  } catch {
    return null; // no rate → cannot bound it → cannot honestly propose it
  }
  const cap = swapCapUsdc();
  if (valueUsdc > cap) return null; // reject, never clamp

  // ── Rate: the model's number (if any) is IGNORED. Price it ourselves, live, against the
  //    user's own wallet — the swap analogue of re-pricing the bridge fee from IRIS. ──
  let estimate;
  try {
    estimate = await estimateSwapOnly({ walletAddress, tokenIn, tokenOut, amountIn });
  } catch {
    return null; // cannot price it → cannot honestly propose it
  }

  // Floor: a swap that returns nothing is not worth approving. Mirrors the bridge's
  // fee-floor refusal — refuse to PROPOSE an un-settleable trade rather than let a user
  // approve one.
  //
  // ⚠️ THE FIELD IS `estimatedOutput`, and it is a TokenAmount: { token, amount } with
  // `amount` a human-decimal STRING ("4.31"). This originally read `estimate.amountOut ??
  // estimate.toAmount` — both invented — which yielded NaN, so EVERY swap proposal was
  // refused as "unpriceable". The guard behaved correctly (cannot price it ⇒ cannot honestly
  // propose it); the price simply never arrived. Read the SDK, don't guess it.
  const amountOut = Number(estimate?.estimatedOutput?.amount ?? NaN);
  if (!Number.isFinite(amountOut) || amountOut <= 0) return null;

  return {
    action: "swap_tokens",     // the executor's step type — never the model's string
    tokenIn,                   // OUR symbol, from OUR allowlist
    tokenOut,
    amountIn,                  // bounded (in USDC-equivalent) by the deployed cap
    valueUsdc: Number(valueUsdc.toFixed(6)), // what the cap and the day-ceiling actually bound
    cap,
    // INDICATIVE ONLY, exactly like the bridge's fee. The rate moves; agentSwap re-estimates
    // at execution and the 1% slippage cap (_swap.mjs) makes the swap revert rather than fill
    // at a bad rate. The number shown at approve time is a courtesy, never a commitment.
    indicativeAmountOut: Number(amountOut.toFixed(6)),
    pricedAt: new Date().toISOString(),
    reasoning: String(raw.reasoning || "").slice(0, MAX_REASONING),
    validatedAt: new Date().toISOString(),
  };
}
