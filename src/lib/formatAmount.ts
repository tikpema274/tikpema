// formatAmount.ts — WHERE ROUNDING IS ALLOWED TO HAPPEN.
//
// ═══ ⭐⭐ THE RULE, WRITTEN WHERE THE NEXT PRODUCER WILL BE WRITTEN ═════════════════════════════
//
//   1. A PRODUCER EMITS FULL PRECISION. A balance reader, a quote, a fee, an on-chain read — none
//      of them rounds. Rounding at the source is one decision made invisibly for every consumer at
//      once, and it cannot be undone downstream: the digits are gone.
//   2. ONLY A RENDER ROUNDS. Each surface decides how many digits its reader needs, and can change
//      that later without touching anything else.
//   3. A VALUE USED IN ARITHMETIC IS NEVER READ FROM A ROUNDED ONE. Multiplying a rounded balance
//      compounds the error instead of cancelling it.
//
// 🚨 WHAT THIS COST, MEASURED. `my-wallet.mjs` returned `.toFixed(2)` on a 6-dp token, so eight
// display sites and one ARITHMETIC site received a value already missing four digits. A shown
// 0.40 EURC was anywhere in [0.395, 0.405). BridgePanel's 25/50/75 buttons multiplied that rounded
// balance: at a real balance of 0.409999, "25%" sent 0.10 instead of 0.102499 — 2.44% short, on the
// control a user presses precisely so they do not have to do the arithmetic.
//
// ⛔ AND THE FIX IS NOT PER-CONSUMER. Rounding in each consumer is the same defect distributed:
// consumer nine gets it wrong again, and nothing says where the rule lives. One producer contract,
// one render helper. [[duplicate-source-of-truth-is-the-recurring-bug]]

/**
 * Render a token amount for display. ⭐ 2dp is the DEFAULT, not the truth — the underlying value
 * keeps every digit, and a surface that needs more asks for more.
 *
 * ⚠️ Returns the placeholder unchanged for null/undefined/non-numeric, so a missing balance still
 * renders as "…" rather than as "0.00" — a zero balance and an unknown one are different facts and
 * must never render alike. [[absence-must-never-read-as-safe]]
 */
export function displayAmount(
  v: string | number | null | undefined,
  dp = 2,
  placeholder = "…",
): string {
  if (v === null || v === undefined || v === "") return placeholder;
  const n = Number(v);
  if (!Number.isFinite(n)) return placeholder;
  return n.toFixed(dp);
}

/** ⭐ The exact value, for arithmetic. Never rendered — its job is to be correct, not readable. */
export function exactAmount(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
