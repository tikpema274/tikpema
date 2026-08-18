#!/usr/bin/env node
// verify-price-rendering.mjs — prove the two USDC formatters stay different in the way that matters.
//
//   node scripts/verify-price-rendering.mjs
//
// ⭐ ONE NUMBER, THREE RENDERINGS. The atomic value is the only hand-written figure; the human
// string and Circle's x-payment-info amount are both derived. The two derivations differ ONLY in
// trailing-zero handling, and that difference is the whole point: a single formatter would emit
// "0.06" into x-payment-info (which may fail Circle's parser) or "$0.060000 USDC" to buyers.
//
// 🚨 THE TEST THAT MATTERS IS NOT "each formatter is right" — it is "they DISAGREE on exactly the
// inputs where they must". A refactor that collapsed them into one function would still pass a
// per-formatter test suite on any value with no trailing zeros. So disagreement is asserted
// directly, on a value chosen because it has them.
//
// READ-ONLY. No network, no chain, no credential.

import {
  DD_PRICE_ATOMIC, DD_PRICE_HUMAN, DD_PRICE_DECIMAL,
  formatUsdcPadded, formatUsdcTrimmed,
} from "../netlify/functions/_dd-x402.mjs";

let bad = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  console.log(`   ${ok ? "✅" : "❌"} ${label.padEnd(46)} ${JSON.stringify(got)}${ok ? "" : `  want ${JSON.stringify(want)}`}`);
  if (!ok) bad++;
};
const throws = (label, fn) => {
  try { const r = fn(); console.log(`   ❌ ${label} — returned ${JSON.stringify(r)} instead of throwing`); bad++; }
  catch { console.log(`   ✅ ${label}`); }
};

console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  USDC PRICE RENDERING — one atomic value, two formatters             ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

console.log("── the live price ──────────────────────────────────────────────────");
eq("DD_PRICE_ATOMIC (the only literal)", DD_PRICE_ATOMIC, "60000");
eq("DD_PRICE_DECIMAL → x-payment-info", DD_PRICE_DECIMAL, "0.060000");
eq("DD_PRICE_HUMAN → buyers + search", DD_PRICE_HUMAN, "$0.06 USDC");

console.log("\n── padded (Circle): trailing zeros KEPT, always 6 dp ───────────────");
eq("60000", formatUsdcPadded("60000"), "0.060000");
eq("1000000 (one whole USDC)", formatUsdcPadded("1000000"), "1.000000");
eq("1 (one atomic unit)", formatUsdcPadded("1"), "0.000001");
eq("100000", formatUsdcPadded("100000"), "0.100000");
eq("0", formatUsdcPadded("0"), "0.000000");
eq("123456789", formatUsdcPadded("123456789"), "123.456789");

console.log("\n── trimmed (human): trailing zeros REMOVED, point dropped if bare ──");
eq("60000", formatUsdcTrimmed("60000"), "0.06");
eq("1000000 (one whole USDC)", formatUsdcTrimmed("1000000"), "1");
eq("1 (one atomic unit)", formatUsdcTrimmed("1"), "0.000001");
eq("100000", formatUsdcTrimmed("100000"), "0.1");
eq("0", formatUsdcTrimmed("0"), "0");
eq("123456789", formatUsdcTrimmed("123456789"), "123.456789");

// ═══ ⭐ THE REGRESSION THAT A PER-FORMATTER SUITE WOULD MISS ════════════════════════════════════
console.log("\n── ⭐ they must DISAGREE where trailing zeros exist ─────────────────");
for (const v of ["60000", "1000000", "100000", "0", "60000000"]) {
  const p = formatUsdcPadded(v), t = formatUsdcTrimmed(v);
  const differ = p !== t;
  console.log(`   ${differ ? "✅" : "❌"} ${v.padEnd(10)} padded ${p.padEnd(12)} trimmed ${t.padEnd(10)} ${differ ? "differ" : "IDENTICAL — the formatters have collapsed"}`);
  if (!differ) bad++;
}
console.log("   (a value with no trailing zeros SHOULD render identically — not a defect:)");
eq("123456789 renders the same both ways", formatUsdcPadded("123456789") === formatUsdcTrimmed("123456789"), true);

// 🚨 Passing an already-formatted string must THROW, not silently render 0.000000 — that would
// advertise a free service. Absence of digits is not a price of zero.
console.log("\n── refusals ────────────────────────────────────────────────────────");
throws("padded rejects an already-formatted \"0.06\"", () => formatUsdcPadded("0.06"));
throws("trimmed rejects an already-formatted \"0.06\"", () => formatUsdcTrimmed("0.06"));
throws("rejects \"$0.06 USDC\"", () => formatUsdcPadded("$0.06 USDC"));
throws("rejects a negative", () => formatUsdcPadded("-60000"));
throws("rejects empty", () => formatUsdcTrimmed(""));
throws("rejects null", () => formatUsdcTrimmed(null));

console.log("\n════════════════════════════════════════════════════════════════════════");
if (bad) { console.log(`❌ ${bad} check(s) failed.`); process.exit(1); }
console.log(`✅ ALL PASS — one atomic literal, two formatters, difference asserted.\n`);
