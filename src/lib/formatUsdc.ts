// formatUsdc — render a USDC amount at FULL precision, or refuse.
//
// ═══ 🚨 WHY 2dp IS WRONG ON THIS SURFACE ═════════════════════════════════════════════════════
// USDC has SIX decimals. The bridge work established that 2dp hides material differences on
// exactly this kind of card — a fee, a remainder or a dust balance can round to something that
// looks identical to a different amount, and the user has no way to tell.
//
// ⚠️ AND THE SERVER'S OWN OUTPUT IS ALREADY INCONSISTENT: `formatUnits` TRIMS trailing zeros, so
// the same balance renders as "2.51", "2" or "1.510000" depending on its value. Rendering that raw
// makes a column of amounts impossible to compare by eye. Fixing the width is the point.
//
// ═══ ⭐ AND WHY IT REFUSES RATHER THAN PRINTING "0" ══════════════════════════════════════════
// A missing, malformed or unreadable amount must NEVER render as a number. On a page answering
// "where is my money", a zero is a claim — "you have nothing" — and it is the one claim we must
// not make from an absence. That is this codebase's recurring failure family, and this helper is
// where the money path meets the DOM.

/** What to show when there is no trustworthy number. Never "0", never "0.000000". */
export const NO_AMOUNT = "—";

export const USDC_DP = 6;
export const USDC_SHORT_DP = 2;

/**
 * ⭐⭐ THE ONE PLACE A USDC AMOUNT IS FLOORED FOR DISPLAY — shared by both formatters below, so the
 * rule lives once. FLOOR toward zero at `dp` decimals — NEVER round up. A displayed balance that
 * reads HIGHER than the true amount is the bridge 2dp defect: a user could act on a figure the wallet
 * cannot cover. Snap the scaling first (`toFixed(9)`) so binary-fp error — 1.234567 * 1e6 is
 * 1234567.0000000002 — does not floor an exact value one atomic unit down. Same snap-then-round-down
 * as shared/amount-direction.mjs's availableAmount; for every real ≤6dp USDC value this is exact.
 *
 * ⚠️ Rejects non-numbers (Number(true)===1, Number([])===0) and whitespace so a non-amount never
 * becomes a number. Returns NO_AMOUNT for anything unusable — never "0".
 */
function floorUsdcAt(v: unknown, dp: number): string {
  if (v === null || v === undefined || v === "") return NO_AMOUNT;
  if (typeof v !== "string" && typeof v !== "number") return NO_AMOUNT;
  const raw = typeof v === "number" ? v : v.trim();
  if (raw === "") return NO_AMOUNT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return NO_AMOUNT;
  const scaled = Number((n * 10 ** dp).toFixed(9));
  return (Math.floor(scaled) / 10 ** dp).toFixed(dp);
}

/**
 * @param v the server's amount — a decimal string from `formatUnits`, or a number.
 * @returns a fixed-width 6dp string (FLOORED), or NO_AMOUNT when the value is not a usable number.
 */
export function formatUsdc(v: unknown): string {
  return floorUsdcAt(v, USDC_DP);
}

/**
 * ⭐ The 2dp DISPLAY of a USDC amount — FLOORED, for a compact scan column where the exact 6dp lives
 * one click away. Same flooring as `formatUsdc`, so it never overstates: 31.309999 → "31.30", never
 * "31.31". NO_AMOUNT for an absent/unreadable value, never "0".
 */
export function formatUsdcShort(v: unknown): string {
  return floorUsdcAt(v, USDC_SHORT_DP);
}

/**
 * ⭐ THE TRI-STATE GATE, IN ONE PLACE. `readable:false` means the CHAIN COULD NOT BE READ — it is
 * NOT a zero balance, and rendering it as an amount is the exact lie this guards against. Callers
 * pass the server's `balance` object; anything short of an explicit `readable === true` yields
 * NO_AMOUNT.
 */
export function formatBalance(
  balance: { readable?: boolean } | null | undefined,
  field: string
): string {
  if (!balance || balance.readable !== true) return NO_AMOUNT;
  return formatUsdc((balance as Record<string, unknown>)[field]);
}
