// dca-gate.mjs — ⛔ ONE SOURCE FOR WHETHER DCA NEW-SCHEDULE CREATION IS PAUSED.
//
// The server enforces it (dca-create refuses when true) and returns it (dca-list → the DcaPanel
// notice); the swap tab strip reads it directly for the Recurring tab's "paused" pill. All three
// trace to THIS line, so the pill, the page notice, and the enforcement can never disagree.
// ⭐ A compile-time constant: flip it here and a redeploy pauses creation everywhere at once.
export const DCA_CREATE_GATED = false;
