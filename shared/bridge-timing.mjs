// bridge-timing.mjs — ⛔ ONE SOURCE FOR HOW LONG A DESTINATION MINT TAKES.
//
// ═══ 🚨 SIX SURFACES, TWO CONTRADICTORY ANSWERS ═══════════════════════════
// The agent consent screen said "~1–2 min". The self-signed and manual panels said "a few minutes
// (up to ~20 for some chains)". Same event — the CCTP destination mint — quoted two ways, with the
// OPTIMISTIC figure on the screen where a user ticks a box and funds leave.
//
// ⭐ BridgePanel had already recognised the hazard: "this wording is VERBATIM the manual panel's, so
// the two do not quote the range differently." That alignment covered three surfaces and missed two,
// which is exactly what alignment-by-copying does. A constant makes a SEVENTH surface unable to
// disagree.
//
// ═══ ⛔ AND NEITHER STRING WAS RIGHT ══════════════════════════════════════
//   MEASURED, real Arc→Base settlements: 21s, 25s, 29s (PROGRESS.md:12642, :16878).
//   CODE'S OWN BOUND: MINT_DEADLINE_MS = 4 min (_bridge-receipts.mjs:138) — "how long a forwarded
//   mint gets before we stop claiming it is merely still going", matched independently by
//   MAX_POLLS(48) × POLL_MS(5s) on the plan path.
//
// "~1–2 min" is pessimistic against observation. "up to ~20" CONTRADICTS the deadline: the receipt
// system flags the mint as overdue at 4 minutes, so a page promising twenty describes a state the
// app has already escalated. ⛔ Aligning on the pessimistic string would have made the copy disagree
// with the receipt bands — which is why this is a binding and not a copy edit.
//
// ⭐⭐ THE NUMBER IS NOT RETYPED HERE. `MINT_DEADLINE_MINUTES` must equal MINT_DEADLINE_MS/60000, and
// scripts/verify-bridge-timing.mjs asserts that across the two files. A second literal is how the
// six surfaces drifted in the first place.

// ⭐⭐ IT LIVES IN shared/ BECAUSE BOTH SIDES MUST READ THE SAME FILE. The client cannot import
// _bridge-receipts.mjs (it pulls in @netlify/blobs) and the server cannot import from src/. A
// constant in either place would have been a second copy — which is the defect, not the fix.
/** The code's own bound, in minutes. MUST equal `MINT_DEADLINE_MS / 60_000` in _bridge-receipts.mjs. */
export const MINT_DEADLINE_MINUTES = 4;

/**
 * The one sentence every surface renders. Typical case from measurement, tail from the deadline the
 * system actually enforces — so the copy and the receipt bands can never tell different stories.
 */
export const MINT_TIMING = `usually under a minute; we stop calling it routine after ${MINT_DEADLINE_MINUTES} minutes`;

/** The burn half, which is genuinely immediate and is not in dispute. */
export const BURN_TIMING = "the Arc burn is instant";

/** Both halves, for the surfaces that state them together. */
export const BRIDGE_TIMING = `${BURN_TIMING}; the destination mint follows — ${MINT_TIMING}`;
