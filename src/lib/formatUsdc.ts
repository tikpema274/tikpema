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

/**
 * @param v the server's amount — a decimal string from `formatUnits`, or a number.
 * @returns a fixed-width 6dp string, or NO_AMOUNT when the value is not a usable number.
 */
export function formatUsdc(v: unknown): string {
  if (v === null || v === undefined || v === "") return NO_AMOUNT;
  // ⚠️ Reject booleans and objects explicitly: Number(true) === 1 and Number([]) === 0, so a
  // sloppy coercion would invent an amount out of a non-amount.
  if (typeof v !== "string" && typeof v !== "number") return NO_AMOUNT;
  // 🚨 TRIM FIRST, THEN RE-CHECK FOR EMPTY. `Number("")` is 0 — so a whitespace-only string would
  // otherwise render as "0.000000", which is this helper's exact failure mode arriving through its
  // own front door. Caught by verify-format-usdc, not by review.
  const raw = typeof v === "number" ? v : v.trim();
  if (raw === "") return NO_AMOUNT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return NO_AMOUNT;
  return n.toFixed(USDC_DP);
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
