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
    // ⛔⛔ FALSE HERE, AND CONTRACT-ENFORCED. `depositForBurnWithFees` takes the vendor SIGNED QUOTE
    // and ASSERTS that what the FeeManager collects equals what the quote said; `maxFee` is not used
    // on this path at all (`EMPTY_MAX_FEE`, hardcoded zero, measured as zero on chain). So the fee
    // shown IS the fee charged, and a "may be lower" qualifier here would be a FALSE hedge.
    // 🚨 A 2026-09-06 correction: the 55/67 ceiling measurement was true of a mechanic THIS PATH NO
    // LONGER USES, and was nearly applied here on that basis.
    feeIsCeiling: false,
    feeCeilingNote: "",
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
    // ⭐⭐ TRUE HERE. `feeUsdc` is `toUsdc(maxFee)`, and `maxFee` is signed into the calldata as a
    // real CCTP parameter — a bound the burn will not exceed, not a prediction of what it costs.
    // It is built to sit ABOVE the expected charge: a +10% buffer on the provider fee and the
    // forwarder's HIGH estimate. The fee actually taken is determined when the burn runs.
    //
    // ⛔ IT STATES THE RELATIONSHIP, NOT A LIKELIHOOD. "Usually lower" would assert a distribution
    // nobody has measured on THIS path: every on-chain fee verdict we hold is `upfront` (4 of 4,
    // all `matched`), and the 55/67-burns-left-surplus figure was THIRD-PARTY. A maximum and the
    // moment the real figure is set are both derivable from the code; a frequency is not.
    feeIsCeiling: true,
    feeCeilingNote: "That figure is a maximum, signed into the transaction — the fee actually taken is set when the burn runs and can be lower.",
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
    // ⛔ CLAIMS NEITHER. A record that does not say which mechanic applies cannot say whether its
    // fee figure was a maximum or an exact charge.
    feeIsCeiling: null,
    feeCeilingNote: "",
  }),
});

/** The copy for one mechanic, normalised. ⭐ One accessor, so no surface indexes the map directly
 *  and no surface can reach a key that does not exist. */
export function bridgeMechanicCopy(v) {
  return BRIDGE_MECHANIC_COPY[bridgeMechanicOf(v)];
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⭐⭐ A SECOND AXIS: WHO SIGNS THE BURN — AND IT IS NOT THE MECHANIC
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// ⛔ THESE TWO KEYS CORRELATE TODAY AND ARE NOT THE SAME PROPERTY:
//
//     upfront  = server-burned  = leavable      (the agent path)
//     deducted = browser-signed = must stay     (the self-signed path)
//
// ⚠️ THE CORRELATION IS AN ACCIDENT OF WHICH TWO PATHS EXIST, NOT A RULE. A future path can be one
// and not the other — a `delegate` signer (a session key signing server-side on the user's behalf)
// would be browser-INITIATED but server-RECORDED: upfront-adjacent AND leavable. Keying the
// leave/stay sentence on `mechanic` would have made that path unrepresentable, and the coupling
// would then live in the type instead of in a comment, which is harder to see and no less wrong.
//
// ⭐ NAMED FOR WHAT IT DERIVES FROM, NOT FOR ITS EFFECT. "leavable" is the CONSEQUENCE; the FACT is
// who signs the burn and, following from that, whether the receipt write happens in the same
// request. Naming the consequence would have hidden the reason and made the third value invisible.
//
// ⭐ WHY THE CONSEQUENCE MATTERS: on the browser path the burn is signed in the tab and a SECOND
// request writes the receipt. Close the tab between them and the money still moves — the record
// does not. So the two panels give OPPOSITE instructions at the same moment, and both are correct.

/** Who signs the burn. ⭐ `unknown` claims neither instruction, for the same reason the mechanic's
 *  `unknown` claims neither placement: a record that does not say must not be made to say. */
export const BRIDGE_SIGNERS = Object.freeze(["server", "browser", "unknown"]);

export function bridgeSignerOf(v) {
  return BRIDGE_SIGNERS.includes(v) && v !== "unknown" ? v : "unknown";
}

/**
 * ⛔ THE LEAVE/STAY INSTRUCTION IS A CLAIM ABOUT CUSTODY OF THE RECORD, so it lives with the fact
 * that determines it rather than being written twice with opposite values.
 */
export const BRIDGE_SIGNER_COPY = Object.freeze({
  server: Object.freeze({
    /** Where the key is. */
    signedBy: "signed by the server on your behalf",
    /** Whether the tab may be closed once it starts, and why. */
    pageInstruction: "You can leave this page once it starts — the bridge completes on its own.",
    mustStay: false,
  }),
  browser: Object.freeze({
    signedBy: "signed in this browser with your own key",
    // ⚠️ THE MONEY IS NOT AT RISK — THE RECORD IS DELAYED. Saying "your funds are at risk" would be
    // false and would frighten someone into staying for the wrong reason; saying nothing loses the
    // receipt. The sentence names exactly what is at stake and no more.
    //
    // ⛔⛔ THIS IS THE SECOND PRODUCER OF THAT CLAIM, AND IT WAS MISSED 2026-09-07. The hazard
    // callout in ManualBridgePanel was softened to "delayed rather than lost" once the discovery
    // sweeper was scheduled and observed running — and THIS sentence, which renders beside the
    // ACTION, still said "we lose the record of it". For one deploy the panel contradicted itself
    // on the same screen: delayed above, lost at the button.
    // ⭐ IT SURVIVED A BUNDLE PROBE THAT PREDICTED ITS REMOVAL. The literal count went 1 -> 1 and I
    // read that as a stale artefact before finding the real cause: two producers, one changed.
    // ⚠️ AND THE COPY SUITE COULD NOT SEE IT — it renders the panel with NO quote, so
    // BridgeQuoteSummary never mounts and this sentence is absent from the rendered text it asserts
    // on. The assertion was true and the claim was still live.
    // ⭐ SHORTER THAN THE CALLOUT ON PURPOSE: this sits at the action, where the reason and the
    // duplicate-entry consequence would be noise. The callout above carries those.
    pageInstruction: "Stay on this page until the burn confirms. If you leave, the bridge still completes on-chain and your funds are not at risk — the record is delayed, not lost.",
    mustStay: true,
  }),
  unknown: Object.freeze({
    signedBy: "the record does not say who signed this",
    // ⛔ NO INSTRUCTION AT ALL. Telling someone they may leave when we do not know is the one
    // direction that loses a record; telling them to stay when they need not is a smaller harm but
    // still a claim we cannot support. So it instructs nothing and says why.
    pageInstruction: "",
    mustStay: null,
  }),
});

/** One accessor, so no surface indexes the map directly. */
export function bridgeSignerCopy(v) {
  return BRIDGE_SIGNER_COPY[bridgeSignerOf(v)];
}
