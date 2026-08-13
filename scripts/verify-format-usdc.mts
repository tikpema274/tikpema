import assert from "node:assert/strict";
import { formatUsdc, formatBalance, NO_AMOUNT, USDC_DP } from "../src/lib/formatUsdc.ts";

// verify-format-usdc — an absence must never render as an amount, and 6dp is not optional.
//
// ═══ 🚨 THE TWO RULES ════════════════════════════════════════════════════════════════════════
// 1. `readable:false` IS NOT ZERO. On a page answering "where is my money", a rendered 0 is a
//    CLAIM — "you have nothing" — and it is the one claim we must never make from an absence.
//    This is the failure family this repo keeps closing, at the point where it meets the DOM.
// 2. SIX DECIMALS. USDC has 6; the bridge work established that 2dp hides material differences on
//    exactly this surface. ⚠️ And the server's own `formatUnits` output TRIMS zeros — "2.51", "2",
//    "1.510000" for comparable amounts — so raw rendering is inconsistent as well as coarse.

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e: any) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); }
};

console.log("\n── formatUsdc: absence is not zero ─────────────────────────────");

t("⭐⭐ readable:false yields NO AMOUNT, never a zero", () => {
  assert.equal(formatBalance({ readable: false, availableUsdc: "0" } as any, "availableUsdc"), NO_AMOUNT);
  assert.equal(formatBalance({ readable: false } as any, "availableUsdc"), NO_AMOUNT);
  // ⚠️ Even when the server sends a number alongside readable:false, the flag WINS.
  assert.equal(formatBalance({ readable: false, availableUsdc: "2.51" } as any, "availableUsdc"), NO_AMOUNT,
    "an unreadable chain must not render an amount even if one is present in the payload");
});

t("⭐ a MISSING readable flag is also not readable — absence fails closed", () => {
  assert.equal(formatBalance({ availableUsdc: "2.51" } as any, "availableUsdc"), NO_AMOUNT);
  assert.equal(formatBalance(null, "availableUsdc"), NO_AMOUNT);
  assert.equal(formatBalance(undefined, "availableUsdc"), NO_AMOUNT);
  assert.equal(formatBalance({ readable: "true" } as any, "availableUsdc"), NO_AMOUNT,
    "a truthy non-boolean is not the flag");
});

t("readable:true renders the amount", () => {
  assert.equal(formatBalance({ readable: true, availableUsdc: "2.51" } as any, "availableUsdc"), "2.510000");
});

t("⭐⭐ SIX decimals always — the server's trimmed output is normalised", () => {
  assert.equal(USDC_DP, 6);
  assert.equal(formatUsdc("2.51"), "2.510000", "the exact case the GET returns today");
  assert.equal(formatUsdc("2"), "2.000000", "formatUnits trims to a bare integer");
  assert.equal(formatUsdc("1.510000"), "1.510000");
  assert.equal(formatUsdc(0.000001), "0.000001", "one atomic unit must be visible");
});

t("⭐ 2dp would have hidden this — the reason the rule exists", () => {
  // Two balances that are materially different but identical at 2dp.
  assert.notEqual(formatUsdc("2.5137"), formatUsdc("2.5142"));
  assert.equal(formatUsdc("2.5137").slice(0, 4), formatUsdc("2.5142").slice(0, 4),
    "…they agree to 2dp, which is exactly why 2dp is not enough here");
});

t("⭐⭐ non-numbers NEVER become an amount — no coercion inventing a value", () => {
  for (const v of [null, undefined, "", "  ", "abc", NaN, Infinity, -Infinity,
                   true, false, {}, [], [1]]) {
    assert.equal(formatUsdc(v as any), NO_AMOUNT, `${JSON.stringify(v)} rendered as a number`);
  }
  // ⚠️ These are the coercion traps specifically: Number(true)===1, Number([])===0, Number([1])===1.
  assert.equal(formatUsdc(true as any), NO_AMOUNT, "Number(true) is 1 — a boolean must not become 1 USDC");
  assert.equal(formatUsdc([] as any), NO_AMOUNT, "Number([]) is 0 — an empty array must not become a zero balance");
});

t("a real zero DOES render — a true 0 is a fact, not an absence", () => {
  assert.equal(formatUsdc("0"), "0.000000");
  assert.equal(formatUsdc(0), "0.000000");
  assert.equal(formatBalance({ readable: true, withdrawableUsdc: "0" } as any, "withdrawableUsdc"), "0.000000");
});

t("NO_AMOUNT is not something a reader could mistake for a number", () => {
  assert.equal(NO_AMOUNT, "—");
  assert.ok(!/\d/.test(NO_AMOUNT));
});

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-format-usdc: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
