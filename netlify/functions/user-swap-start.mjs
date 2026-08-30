// POST /api/user-swap-start  { tokenIn, tokenOut, amountIn }
//
// The USER-SIGNED swap's only server call: price it, band it, build the calldata for the CALLER'S
// OWN address, and hand it back. Nothing has moved when this returns — the user has not signed.
//
// ═══ ⛔ AGENT CAPS DO NOT APPLY, AND IT MUST BE SAID ═══════════════════════════════════════════
// The user signs with their own key and spends their own funds — the same reasoning already settled
// for manual bridge, manual send, agent-withdraw and ub-withdraw. The panel states the absence in
// words, because sitting beside a panel that names its caps, silence reads as capped.
//
// ═══ ⭐ NO ACK TOKEN, AND THAT IS A MECHANISM ARGUMENT, NOT AN OMISSION ═════════════════════════
// The bridge mints an HMAC ack token because a client-chosen `maxFee` would let the caller pick the
// band its own acknowledgment is checked against. A swap has no such lever: `minTokenOut` and
// `deadline` live inside a CIRCLE-SIGNED payload and are enforced BY THE ADAPTER — altering either
// fails signature verification on-chain. ⭐ The chain already enforces what the token would.
// An HMAC this server both mints and checks proves nothing against this server anyway.
//
// So the band below is advisory-to-the-human, not an authorization: it is computed SERVER-side (so
// the figure is not a client invention) and the panel blocks on it. A user who clicks past their own
// disclosure harms only themselves, and the floor they sign is still enforced by the contract.
//
// ═══ ⛔ NO RECEIPT IS WRITTEN, HERE OR ANYWHERE ════════════════════════════════════════════════
// docs/manual-swap-scope.md §4a: delivery IS the transaction, the received amount is in that
// transaction's own logs, and there is no estimate to advance. A receipt would buy a history and
// cost a write-after-sign window with nothing recoverable inside it. This endpoint therefore has no
// twin — there is no promote step.

import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { buildSwapCallData, valueInUsdc, SWAP_TOKENS } from "./_swap.mjs";

// ⭐ BANDS SIZED AGAINST A MEASURED FLOOR, NOT INVENTED. The executing quote's `minTokenOut` sits
// EXACTLY 3.00% below `estimatedAmount` (measured 2026-08-30, 4 quotes, both directions, two
// amounts — docs/swap-slippage-copy-overclaim.md), and the provider fee is a further 2.00 bps. So
// an ordinary, healthy swap lands near 3% implied loss and the bridge's 10%/25% ratios would never
// fire — a gate that cannot fire is decoration.
// ⚠️ THESE ARE A JUDGEMENT, AND THE JUDGEMENT IS STATED: `warn` at 5% leaves ~2 points of headroom
// over the ordinary case; `acknowledge` at 10% is a genuinely bad deal on a stablecoin pair.
// 🚨 IF CIRCLE'S TOLERANCE CHANGES, THESE MOVE — they are calibrated to a measurement, not to a
// principle, and the measurement is dated.
export const SWAP_BAND_WARN = 0.05;
export const SWAP_BAND_ACKNOWLEDGE = 0.10;

/**
 * Implied loss of the GUARANTEED outcome against the mid-rate: what the user is certain to receive,
 * valued in USD, versus what they are certain to spend.
 *
 * ⭐ IT IS PRICED ON `minTokenOut`, NOT ON THE ESTIMATE. The estimate is what they will probably
 * get; the floor is what they are SIGNING. A band computed on the estimate would disclose the good
 * case and gate on nothing.
 *
 * ⚠️ USDC↔EURC IS CROSS-CURRENCY. Comparing minor units directly would report a double-digit "loss"
 * on every USDC→EURC swap and fire the gate every time — the "box that always complains" failure the
 * bridge's band design exists to avoid. Both sides are therefore valued in USD first.
 *
 * ⛔ AN UNREADABLE RATE REFUSES. `valueInUsdc` throws rather than returning NaN, for the documented
 * reason that a NaN comparison is FALSE and would silently mean "no band applies". We let it throw.
 */
export function swapLossBand({ amountInUsd, minOutUsd }) {
  if (!Number.isFinite(amountInUsd) || amountInUsd <= 0) throw new Error("cannot band a swap without a positive input value");
  if (!Number.isFinite(minOutUsd) || minOutUsd < 0) throw new Error("cannot band a swap without a readable guaranteed output value");
  const impliedLoss = 1 - minOutUsd / amountInUsd;
  const band = impliedLoss >= SWAP_BAND_ACKNOWLEDGE ? "acknowledge" : impliedLoss >= SWAP_BAND_WARN ? "warn" : "none";
  return { impliedLoss, band, amountInUsd, minOutUsd };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) (await import("./_blobs.mjs")).connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  let b = {};
  try { b = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON body" }); }

  // Symbols come from OUR allowlist, never from the body verbatim.
  const tokenIn = SWAP_TOKENS.find((t) => t === String(b.tokenIn ?? "").toUpperCase());
  const tokenOut = SWAP_TOKENS.find((t) => t === String(b.tokenOut ?? "").toUpperCase());
  if (!tokenIn || !tokenOut) return json(400, { error: "Unsupported tokens — USDC and EURC only." });
  if (tokenIn === tokenOut) return json(400, { error: "Choose two different tokens." });

  const amountIn = Number(b.amountIn);
  if (!Number.isFinite(amountIn) || amountIn <= 0) return json(400, { error: "Enter an amount greater than 0." });

  // 🚨 THE OWNER COMES FROM THE SESSION, NEVER FROM THE BODY. This address becomes the payload's
  // `fromAddress` AND `toAddress`, so a body-supplied value here would be a caller choosing where
  // someone else's swap output lands — the exact hazard the beneficiary assert exists for.
  const owner = session.address;

  let built;
  try {
    built = await buildSwapCallData({ walletAddress: owner, tokenIn, tokenOut, amountIn });
  } catch (e) {
    return json(502, { error: `Could not price this swap right now: ${String(e.message).slice(0, 180)}` });
  }

  // Band it — on the FLOOR, in USD. A rate we cannot read refuses the swap rather than banding it 0.
  let band;
  try {
    const amountInUsd = await valueInUsdc({ token: tokenIn, amount: amountIn });
    const minOutUsd = await valueInUsdc({ token: tokenOut, amount: Number(built.minTokenOut) / 1e6 });
    band = swapLossBand({ amountInUsd, minOutUsd });
  } catch (e) {
    return json(502, { error: `Could not value this swap, so it cannot be disclosed honestly: ${String(e.message).slice(0, 160)}` });
  }

  return json(200, {
    owner,
    tokenIn, tokenOut,
    amountIn,
    ...built,
    band: band.band,
    impliedLoss: band.impliedLoss,
    // ⭐ Returned so the panel can show it, and independently RE-DERIVED by the client from the
    // calldata bytes (decodeAndVerifySwap). If the two ever disagree, the bytes win and the panel
    // refuses — which is the entire point of decoding rather than displaying.
    expectedBeneficiary: owner,
  });
}
