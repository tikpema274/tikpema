// _amount-floor.mjs — ⛔ AN AMOUNT THAT ROUNDS TO ZERO MINOR UNITS MUST REFUSE, NEVER SUCCEED.
//
// ═══ 🚨 WHY `> 0` IS NOT A FLOOR ══════════════════════════════════════════
// `validateStepShape` tested `Number(x) > 0`. That is TRUE for 0.0000001 — and USDC has six
// decimals, so the executor converts it with `BigInt(Math.round(amount * 1e6))` and gets **0n**.
// The chain then executes a transfer of ZERO: a signed, gas-costing, ledger-recorded, fully
// "successful" transaction that moves nothing.
//
// ⛔ THAT IS THE WORST OUTCOME AVAILABLE, not a rounding nit. A refusal tells the caller their
// amount was too small. A zero transfer tells them it worked. The audit row records the amount they
// ASKED for, the day ceiling is charged for it, and the chain shows a transfer of 0 — three records
// that disagree, none of which says "your amount was below the floor".
//
// ⚠️ AND IT IS NOT THE SAME DEFECT AS THE EQUALITY INVARIANT.
// verify-executor-amount-integrity asserts the executed amount EQUALS the capped and audited one.
// **An amount that rounds to zero on every side satisfies that invariant perfectly** — both sides
// agree, and both are wrong. Equality is a relation between two numbers; the floor is a property of
// one. Neither implies the other, so they are two guards, not one.
//
// The floor is ONE MINOR UNIT: the smallest thing the token can represent. Below it there is no
// amount to move, only a rounding decision, and this module refuses to make one.

export const USDC_DECIMALS = 6;

/** Minor units for `amount`, or null if it is not a finite number. */
export function minorUnitsOf(amount, decimals = USDC_DECIMALS) {
  const n = typeof amount === "bigint" ? Number(amount) : Number(amount);
  if (!Number.isFinite(n)) return null;
  // Math.round mirrors what the executors do — the floor must judge the value the CHAIN will see,
  // not a more forgiving one. Anything under half a minor unit rounds to 0n here exactly as there.
  return BigInt(Math.round(n * 10 ** decimals));
}

/**
 * The named reason this amount cannot be executed, or null if it can.
 * ⭐ Returns a REASON, never a boolean — a caller that only learns "no" cannot tell the user why,
 * and "refuse loudly with a named reason" is the requirement, not "refuse".
 */
export function amountFloorViolation(amount, { field = "amount", decimals = USDC_DECIMALS } = {}) {
  const n = Number(amount);
  // ⚠️ NaN FIRST. `NaN > 0` is false and `NaN < 0` is false — a NaN slips past any comparison-based
  // guard in both directions. Name it explicitly. [[nan-fail-open-cap-pattern]]
  if (!Number.isFinite(n)) return `${field} is not a number`;
  if (n < 0) return `${field} must be greater than zero`;
  const units = minorUnitsOf(n, decimals);
  if (units === null) return `${field} is not a number`;
  if (units === 0n) {
    const smallest = 1 / 10 ** decimals;
    return n === 0
      ? `${field} must be greater than zero`
      : `${field} of ${n} is below the smallest amount this token can move (${smallest}); it would execute as zero`;
  }
  return null;
}
