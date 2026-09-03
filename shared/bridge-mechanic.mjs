// bridge-mechanic.mjs — ⛔ ONE SOURCE FOR WHERE THE BRIDGE FEE IS CHARGED.
//
// ═══ 🚨 TWO FEE MECHANICS ARE LIVE AT ONCE, AND THAT IS NOT A TRANSITIONAL STATE ═══════════════
//
//   upfront   the agent path. `depositForBurnWithFees` collects the fee on the SOURCE chain, in
//             addition to the amount, and the recipient receives the FULL amount. Measured on Base
//             Sepolia in PR-3: a burn of 1 minor unit credited exactly 1.
//   deducted  the self-signed path. `bridgeWithPreapprovalAndHook` takes the fee OUT OF the burned
//             amount, so the recipient nets amount − fee.
//
// ⭐ THE SELF-SIGNED PATH IS NOT WAITING TO BE MIGRATED. A browser EOA signs one transaction at a
// time, so moving it to the upfront path would mean a separate approve then a separate burn —
// reintroducing, on the one path that CANNOT batch, the standing-allowance window batching was
// chosen to eliminate. Both mechanics are permanent until that changes.
//
// ═══ ⛔⛔ WHY THE COPY LIVES HERE AND NOT AT THE SURFACES ═══════════════════════════════════════
//
// ~31 sites render a claim about where the fee is charged. 23 serve the agent path, 3 serve the
// self-signed path and are CORRECT AS THEY STAND, and 5 serve BOTH. A sweep that rewrote them all
// would have broken the self-signed path's honest copy.
//
// 🚨 SO NO SURFACE WRITES ITS OWN SENTENCE. The producer decides the mechanic; the surface renders
// that mechanic's copy and is structurally unable to state the other one. Same shape as
// `refundClass` and `MINT_TIMING`: the producer decides the class, and no surface re-derives it.
// ⚠️ A surface that composed its own wording could render a true sentence for the wrong path, and
// nothing about it would look wrong — which is exactly how the two vocabularies would drift.

/**
 * ⭐⭐ THREE VALUES, AND THE THIRD IS NOT A PLACEHOLDER.
 *
 * `unknown` is the honest verdict for every receipt written before the mechanic was recorded. Those
 * records carry no mechanic AND no `origin` to derive one from — `promoteUserBridge` dropped it —
 * so there is nothing to infer from and nothing to backfill.
 *
 * ⛔ DEFAULTING TO EITHER MECHANIC WOULD MAKE THE STORE ASSERT SOMETHING IT NEVER RECORDED, ABOUT
 * MONEY THAT HAS ALREADY MOVED. Defaulting to `upfront` would tell a user the full amount arrived
 * on a bridge that deducted the fee; defaulting to `deducted` would understate every agent bridge by
 * exactly the fee. Both are wrong in the direction that matters, and neither is visible.
 */
export const BRIDGE_MECHANICS = Object.freeze(["upfront", "deducted", "unknown"]);

/** Normalise anything read off a record. ⛔ An unrecognised value becomes `unknown`, never a guess:
 *  a mechanic we do not recognise is one whose copy we cannot write. */
export function bridgeMechanicOf(v) {
  return BRIDGE_MECHANICS.includes(v) && v !== "unknown" ? v : "unknown";
}

/**
 * ⭐⭐ THE SENTENCES, KEYED BY MECHANIC. Every surface reads from here.
 *
 * ⚠️ EACH KEY MUST BE ANSWERABLE FOR ALL THREE MECHANICS, including `unknown` — and the `unknown`
 * copy must claim NEITHER. That is the constraint that keeps this honest: if a sentence cannot be
 * written for `unknown` without asserting a mechanic, the surface should not be rendering it at all.
 */
export const BRIDGE_MECHANIC_COPY = Object.freeze({
  upfront: Object.freeze({
    /** Where the fee sits relative to the amount. */
    feePlacement: "charged on top of the amount",
    /** What the recipient gets, as a phrase. */
    arrival: "the full amount arrives",
    /** The one-line explanation a quote or receipt can carry. */
    summary: "The fee is charged on the source chain in addition to the amount, so the full amount arrives and your wallet pays amount + fee.",
    // ⭐⭐ A PREFIX AND A SUFFIX, NOT ONE FIELD DOING TWO JOBS. The first draft carried an
    // `arrivalIsEstimate` boolean AND a label, and the renderer applied both — which produced
    // "estimated N USDC estimated to arrive" on the deducted path and a dangling "N USDC recorded
    // as" on `unknown`. Two fields with one job each cannot compose into nonsense.
    /** ⭐ Empty: on this path the arrival is the amount requested, not arithmetic. */
    arrivalPrefix: "",
    arrivalSuffix: "to arrive",
    /** Whether the arrival figure is arithmetic. Read ONLY by the unconfirmed-mint wording. */
    arrivalIsEstimate: false,
  }),
  deducted: Object.freeze({
    feePlacement: "taken out of the amount",
    arrival: "the recipient nets amount − fee",
    summary: "The fee is taken out of the amount you send, so the recipient receives amount − fee.",
    // ⭐ TRUE HERE AND ONLY HERE. `netPredicted` on this path is arithmetic — amount − fee — and the
    // fee can move between quote and burn, so the figure genuinely is an estimate until the
    // destination-chain read promotes it.
    arrivalPrefix: "estimated ",
    arrivalSuffix: "to arrive",
    arrivalIsEstimate: true,
  }),
  unknown: Object.freeze({
    // ⛔ CLAIMS NEITHER. It does not say the full amount arrives and it does not say a fee was
    // deducted — because the record does not say, and inventing either would be the store asserting
    // a mechanic it never wrote down.
    feePlacement: "charged — the record does not say whether on top of the amount or out of it",
    arrival: "how much arrived is not derivable from this record",
    summary: "This receipt predates the fee-mechanic record, so it does not say whether the fee was charged on top of the amount or taken out of it. The burn and the fee figures are still exact; only their relationship is unrecorded.",
    // ⛔ IT DOES NOT SAY "to arrive". That would assert the figure IS the arrival, which is exactly
    // the thing this record cannot support: on one mechanic it is, on the other it is amount − fee.
    arrivalPrefix: "",
    arrivalSuffix: "recorded as the arrival — this record does not say how the fee was charged",
    arrivalIsEstimate: true,
  }),
});

/** The copy for one mechanic, normalised. ⭐ One accessor, so no surface indexes the map directly
 *  and no surface can reach a key that does not exist. */
export function bridgeMechanicCopy(v) {
  return BRIDGE_MECHANIC_COPY[bridgeMechanicOf(v)];
}
