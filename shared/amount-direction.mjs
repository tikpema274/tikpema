// amount-direction.mjs — ⛔ A FIGURE THE READER MUST ACT ON IS NOT A FIGURE THEY READ.
//
// ═══ WHY THIS LIVES IN shared/ ════════════════════════════════════════════════════════════════
// The rule was written at `src/lib/formatAmount.ts` on 2026-09-03 and fixed the two CLIENT sites.
// The SERVER had four more of the identical shape — `agent-send`, `agent-vault-deposit`,
// `agent-withdraw`, `job-swap-approve`, `job-bridge-approve` — and a server function cannot import
// from `src/`. Copying the two helpers across would have been the duplicate-source defect inside the
// module whose whole subject is a number being wrong in one place and right in another.
// ⭐ So the IMPLEMENTATION lives here and `src/lib/formatAmount.ts` re-exports it. Same reasoning as
// `shared/bridge-timing.mjs`. [[duplicate-source-of-truth-is-the-recurring-bug]]
//
// ═══ 🚨 THE DEFECT, MEASURED ══════════════════════════════════════════════════════════════════
// `.toFixed()` rounds to NEAREST, which is right for a number the reader only READS and wrong for
// one they must ACT on. A balance of 9.999 against a need of 10.0, both at 2dp on a 6-dp token,
// renders "Have 10.00 USDC, need 10.00." — a refusal whose own two numbers say it should have
// passed. The test compares full precision; only the message rounds.
//
// ⭐⭐ THE TWO SIDES HAVE OPPOSITE SAFE DIRECTIONS, so one formatter cannot serve both:
//     requiredAmount   rounds UP    — never ask for less than is actually needed
//     availableAmount  rounds DOWN  — never claim more is on hand than actually is
// Each rounds away from the reader's favour. A comparison rendered this way can be pessimistic by a
// rounding unit; it can never read as sufficient when it is not.
//
// ⚠️ THE SCALING IS SNAPPED BEFORE THE CEIL. `2.05 * 100` is 204.99999999999997 in binary floating
// point, and a naive ceil would turn an exact 2.05 into 2.06 — inflating every figure that needed no
// rounding at all.

export const USDC_DECIMALS = 6;

const snap = (n, dp) => Number((n * 10 ** dp).toFixed(9));
const usable = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A figure the reader must MEET. Rounds UP, so the displayed number is never below the real one. */
export function requiredAmount(v, dp = 2, placeholder = "…") {
  const n = usable(v);
  return n === null ? placeholder : (Math.ceil(snap(n, dp)) / 10 ** dp).toFixed(dp);
}

/** A figure the reader HAS. Rounds DOWN, so it never overstates what is on hand. */
export function availableAmount(v, dp = 2, placeholder = "…") {
  const n = usable(v);
  return n === null ? placeholder : (Math.floor(snap(n, dp)) / 10 ** dp).toFixed(dp);
}
