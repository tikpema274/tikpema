// bridge-ack-copy.mjs — THE ACKNOWLEDGEMENT WORDING for an UPFRONT bridge fee, in ONE place, for server and UI.
//
// ═══ WHY (2026-10-01) ═══════════════════════════════════════════════════════════════════════════════════
// The agent bridge's fee is charged ON TOP (`bridgeFee()` → mechanic "upfront"): the full amount arrives and
// amount + fee leaves the wallet. Five surfaces still described it as a deduction: two server refusals and the
// second opinion's headline (fixed d5239d7 / e269abc), and three acknowledgement CARDS, whose headings said
// "This bridge loses X% to fees" / "Step N loses X% to fees" and whose consent said "most of this amount will be
// spent on the network fee". Under an upfront fee the fee floor (fee ≥ amount → refused) keeps the fee under half of
// what leaves the wallet, so "most of it" was never true either.
// ⭐ It lives in shared/ because the browser cannot import netlify/functions/_bridge.mjs (Circle, Blobs and RPC
// clients load at its module scope). _bridge.mjs RE-EXPORTS bridgeAckSentence, so server and UI hold the same function.
// ⛔ No "lose", "only", "eats", "deducted" or "most of": nothing is taken from the amount. The percentage is OF the
// amount (feeRatio = fee / amount). Pinned: verify-bridge-ack-sentence (server) + verify-bridge-mechanic-pairing §12.
// ⚠️ UPFRONT ONLY. The self-signed path's fee really is deducted; its wording lives in bridge-mechanic.mjs.

const pctOf = (feeRatio) => (Number(feeRatio) * 100).toFixed(1);

/**
 * The fee fact, in T's wording: what is charged, what arrives, what leaves.
 * @param {{ amountUsdc: number | string, feeUsdc: number | string, feeRatio: number }} p
 */
export function bridgeAckSentence({ amountUsdc, feeUsdc, feeRatio }) {
  const amount = Number(amountUsdc), fee = Number(feeUsdc);
  return `This bridge charges a fee of ${fee.toFixed(4)} USDC on top of the ${amount} you're sending — ` +
    `${pctOf(feeRatio)}% of the amount. The full ${amount} arrives; about ` +
    `${(amount + fee).toFixed(4)} leaves your wallet.`;
}

/**
 * The card heading — the same "% of the amount, charged on top" terms as the sentence.
 * @param {{ feeRatio: number, step?: number }} p
 */
export const bridgeAckHeading = ({ feeRatio, step }) =>
  `${step ? `Step ${step}: the` : "The"} fee is ${pctOf(feeRatio)}% of the amount, charged on top`;

/** Why a small bridge is expensive, without implying the fee is taken out of it. */
export const BRIDGE_ACK_FLAT_FEE_NOTE =
  "The cross-chain fee is flat, so it costs the same whether you bridge 0.1 or 100 USDC. " +
  "Bridging a larger amount at once, or not bridging, both leave you with more.";

/**
 * The consent the checkbox records.
 * @param {{ step?: number }} [p]
 */
export const bridgeAckConsent = ({ step } = {}) => step
  ? `I understand step ${step}'s fee is charged on top of its amount, and I want to run this plan anyway.`
  : "I understand the fee is charged on top of the amount, and I want to bridge anyway.";
