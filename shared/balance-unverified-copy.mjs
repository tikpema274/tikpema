// balance-unverified-copy.mjs — THE ONE SENTENCE FOR "WE COULD NOT READ YOUR BALANCE".
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════
// The bridge pre-flight (_bridge.mjs readBridgeBalanceMinor) fails OPEN on a read error: the bridge
// proceeds on Circle's own pre-broadcast check. That is deliberate and defensible ONLY if the person
// bridging can see it happened. `balanceChecked:false` was written into four response bodies and
// rendered on none — a silent downgrade of a safety check. Fourth instance of
// written-hashed-never-projected (errata_note, dataDisclosure ×2).
// [[human-facing-field-ships-with-its-render-assertion]]
//
// ⭐ ONE PRODUCER, four renderers (BridgeQuoteSummary, the chat's single-action and plan cards, the
// proposal card). verify-balance-unverified-render asserts the RENDERED sentence on each, and asserts
// its content here — so a rewording that drifts into "your balance was checked" fails a test.
//
// ⛔ WHAT IT MUST AND MUST NOT SAY. It is a disclosure, not a refusal and not a shortfall: no figures,
// no "insufficient", nothing that implies the balance was checked and passed. It names the
// mechanism the bridge now relies on (the provider's own check) so the reader knows what stands
// between them and a failed burn, and it says plainly that nothing about the balance is known here.

export const BALANCE_UNVERIFIED_NOTE =
  "Your agent wallet's balance could not be read just now, so it was not checked for this bridge — " +
  "the bridge relies on the provider's own check before anything moves. This is not a shortfall: " +
  "nothing about your balance is known here.";

/** The note when — and only when — the producer said the balance was NOT checked. `true` and
 *  `undefined` (a surface that never checks, e.g. a self-signed quote) render nothing. */
export function balanceUnverifiedNote(balanceChecked) {
  return balanceChecked === false ? BALANCE_UNVERIFIED_NOTE : null;
}
