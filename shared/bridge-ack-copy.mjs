// bridge-ack-copy.mjs — THE BRIDGE FEE DISCLOSURES, in ONE place, for server and UI: the acknowledgement wording for an
// UPFRONT fee (below) and, since 2026-10-02, the ordinary proposal line (bridgeProposalFeeLine, at the end), which is
// keyed on all three mechanics. ⭐ The rule for the whole family (mechanicpairing §13): every disclosure states what
// ARRIVES and what LEAVES, as figures.
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
// ⚠️ The ACK forms are UPFRONT ONLY. The self-signed path's fee really is deducted; its placement words live in
// bridge-mechanic.mjs (BRIDGE_MECHANIC_COPY), which bridgeProposalFeeLine reads for every mechanic.

import { BRIDGE_MECHANIC_COPY, bridgeMechanicOf } from "./bridge-mechanic.mjs";

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

/**
 * ⭐⭐ THE PROPOSAL'S FEE SENTENCE — the ORDINARY-band disclosure. One producer, four readers: agent-act's reply
 * `message`, MyAgentPanel's confirm panel and plan steps, and the job card's quote (jobTimeline). Moved here from
 * bridge-mechanic.mjs on 2026-10-02 so the fee-disclosure family has one home.
 *
 * ⛔ WHY IT IS NOT bridgeAckSentence: that sentence is UPFRONT-only by design (it says "on top" and "the full amount
 * arrives") and takes the amount + ratio. This line serves ALL THREE mechanics, from what the server priced (fee + net),
 * and carries no percentage: below the warn band a ratio is not the point, the two figures are.
 *
 * ⭐ ARRIVES AND LEAVES (§13, the ordinary band, 2026-10-02). It used to state only the arrival. On BOTH placed mechanics
 * what leaves the wallet is net + fee: upfront, net = the amount and the fee is on top; deducted, net = amount − fee and
 * the amount is what leaves. So one expression is true on both, and the placement words say which way round it is.
 * ⚠️ `unknown` states NEITHER figure: "so ~N arrives" and "~L leaves" are themselves mechanic claims (which number is the
 *    arrival is exactly what the record does not say). A fee it cannot place, it does not extend into figures.
 * ⚠️ 4dp MINIMUM. At 2dp the fee and the arrival collapse into the SAME displayed number (bridging 0.1: 0.0532 fee /
 *    0.0468 arriving both render "~0.05"); the fee is FLAT, so the smaller the bridge the worse the ratio.
 * ⛔ NO SURFACE WRITES THIS SENTENCE ITSELF; the placement phrase is keyed on the mechanic the SERVER priced.
 * @param {{ feeUsdc: number | string, netUsdc: number | string, destinationLabel: string, mechanic: unknown }} p
 */
export function bridgeProposalFeeLine({ feeUsdc, netUsdc, destinationLabel, mechanic }) {
  const key = bridgeMechanicOf(mechanic);
  const m = BRIDGE_MECHANIC_COPY[key];
  const feeN = Number(feeUsdc), netN = Number(netUsdc);
  const fee = `Cross-chain fee ~${feeN.toFixed(4)} USDC (${m.feePlacement})`;
  if (key === "unknown") return `${fee}.`;
  return `${fee}, so ~${netN.toFixed(4)} USDC arrives on ${destinationLabel} and ~${(netN + feeN).toFixed(4)} USDC leaves your wallet.`;
}
