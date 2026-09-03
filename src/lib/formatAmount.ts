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

/**
 * ═══ ⭐⭐ A FIGURE THE USER MUST ACT ON IS NOT A FIGURE THEY READ ═══════════════════════════════
 *
 * `displayAmount` rounds to NEAREST. That is right for a number the reader only has to READ, and
 * wrong for one they have to ACT on, because nearest-rounding a REQUIREMENT understates it:
 *
 *     MEASURED, 2026-09-03. An upfront-fee total of 2.054121 USDC renders at 4dp as "2.0541" —
 *     TWENTY-ONE MILLIONTHS SHORT. A wallet holding exactly what the screen said fails the approve.
 *     At 2dp it is "2.05", four thousandths short. The rounding is not the error; the DIRECTION is.
 *
 * ⛔ AND IT ALREADY COMPOSED INTO A SELF-CONTRADICTORY REFUSAL, at two live sites. A balance of
 * 2.0512 against a need of 2.0549, both rendered at 2dp on a 6-dp token, reads "You have 2.05, need
 * 2.05" — a refusal whose own two numbers say it should have passed. `verify-refusal-quantity`
 * guards that shape: the printed quantity is not the quantity the test compared, and here ROUNDING
 * is what makes them differ.
 *
 * ⭐⭐ THE TWO SIDES HAVE OPPOSITE SAFE DIRECTIONS, SO ONE FORMATTER CANNOT SERVE BOTH:
 *
 *     requiredAmount   rounds UP    — never ask for less than is actually needed
 *     availableAmount  rounds DOWN  — never claim more is on hand than actually is
 *
 * Each rounds away from the reader's favour. A comparison rendered this way can be pessimistic by a
 * rounding unit; it can never read as sufficient when it is not. There is no single "correct
 * precision" that fixes this — precision is a readability choice, direction is a safety one, and
 * choosing only the first is how a 6-dp token ended up compared at 2dp.
 *
 * ═══ ⚠️ THE POPULATION — WHERE THIS APPLIES, WHICH IS WIDER THAN BALANCES ════════════════════════
 * Anywhere a rendered number is an INSTRUCTION rather than a DESCRIPTION. The test is not "is it
 * money" but "will the reader act on this figure and be judged against the real one?":
 *   · a balance to top up to, a total a wallet must hold, an allowance to approve
 *   · a minimum a form will accept, a cap a value must stay under (that one rounds DOWN — it is an
 *     availability, not a requirement; the direction follows the COMPARISON, never the field name)
 *   · a deadline or a countdown a caller will race
 * ⭐ A figure that merely reports what happened — a fee already charged, an amount already sent — is
 * a description and rounds to nearest. Ask which side of the comparison the reader stands on.
 *
 * ⚠️ THE SCALING IS SNAPPED BEFORE THE CEIL. `2.05 * 100` is 204.99999999999997 in binary floating
 * point, and a naive ceil would turn an exact 2.05 into 2.06 — inflating every figure that needed no
 * rounding at all. Fixing the representation error first is what keeps the direction rule from
 * becoming a rounding bug of its own.
 */
// ⭐⭐ THE IMPLEMENTATION MOVED TO shared/amount-direction.mjs AND IS RE-EXPORTED HERE.
// The rule was written at this file and fixed the two CLIENT sites; the SERVER had four more of the
// identical shape, and a netlify function cannot import from `src/`. One implementation, two
// importers — the same reason `shared/bridge-timing.mjs` exists.
// [[duplicate-source-of-truth-is-the-recurring-bug]]
export { requiredAmount, availableAmount } from "../../shared/amount-direction.mjs";

/** ⭐ The exact value, for arithmetic. Never rendered — its job is to be correct, not readable. */
export function exactAmount(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
