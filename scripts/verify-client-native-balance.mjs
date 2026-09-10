// verify-client-native-balance.mjs — the CLIENT reads USDC natively, and every consumer agrees on scale.
//
//   node scripts/verify-client-native-balance.mjs     (also: npm run test:clientnative)
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════
// On Arc, USDC is the native gas token and the ERC-20 `balanceOf` view of it is LOSSY: anything
// under 1e-6 USDC is invisible there, so `balanceOf() == 0` does not prove a balance is zero.
// Circle's own Arc guidance makes the NATIVE balance canonical for a wallet display. The server
// moved first (netlify/functions/_balances.mjs); the client followed.
//
// ═══ 🚨 THE REASON IT IS A SUITE AND NOT A CODE REVIEW — THE FAILURE IS FAIL-OPEN ═════════════
// The two views differ by 10^12. `useModularWallet.ts` holds a PRE-SIGN BALANCE GUARD:
//
//     const units = parseUnits(String(amountUsdc), USDC_NATIVE_DECIMALS);
//     if (units > raw) throw new Error("Insufficient funds…")
//
// Move `raw` to the native read and leave `units` at 1e6 — the single most natural half-edit — and
// `units` is always smaller, so the guard PASSES EVERY SPEND, including ones the wallet cannot
// cover. It does not refuse loudly; it stops refusing at all, while the code above it still reads
// as protected. That is why the scale is asserted rather than trusted.
//
// ⚠️ AND ONE ARGUMENT MUST *NOT* MOVE, which is the subtle half. In
// `availableAmount(formatUnits(raw, USDC_NATIVE_DECIMALS), USDC_DECIMALS)` the first argument is a
// SCALE and had to change; the second is DISPLAY PRECISION — how many digits a human reads — and
// must stay 6. Changing both is as wrong as changing neither, and looks tidier.
//
// ⭐ EURC IS DELIBERATELY THE OTHER WAY, and is asserted so. It is an ordinary ERC-20 with NO
// native view: `balanceOf` is the only way to read it and is exact. The asymmetry between the two
// tokens reads like something nobody tidied, which is exactly why it needs holding in place.
//
// Zero network. Zero money.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p) => strip(readFileSync(p, "utf8"));

const MM = "src/wallet/connectors/metamask.ts";
const MW = "src/wallet/useModularWallet.ts";
const mm = read(MM), mw = read(MW);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  CLIENT BALANCE — native USDC, and every consumer at the same scale  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE INSTRUMENT IS NOT VACUOUS");
check("⭐ both wallet files were read and are non-trivial",
  mm.length > 2000 && mw.length > 2000, `${mm.length} / ${mw.length} chars`);
check("⭐ the constants are distinct — an assertion about scale needs two scales",
  /USDC_DECIMALS\s*=\s*6/.test(readFileSync("src/config/contracts.ts", "utf8")) &&
  /USDC_NATIVE_DECIMALS\s*=\s*18/.test(readFileSync("src/config/contracts.ts", "utf8")));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — USDC IS READ NATIVELY; EURC IS NOT");
for (const [name, code] of [[MM, mm], [MW, mw]]) {
  const f = name.split("/").pop();
  check(`⭐⭐ ${f} reads the balance with getBalance`, /getBalance\(\{\s*address:/.test(code));
  check(`⛔ …and NEVER reads CONTRACTS.USDC through balanceOf`,
    !/CONTRACTS\.USDC[\s\S]{0,160}?functionName:\s*"balanceOf"/.test(code),
    "the lossy view must not return as a second source of the same number");
}
check("⭐ EURC still uses balanceOf — it has no native view and balanceOf is exact for it",
  /CONTRACTS\.EURC[\s\S]{0,160}?functionName:\s*"balanceOf"/.test(mm));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 EVERY CONSUMER OF A NATIVE RAW IS AT 18");
for (const [name, code] of [[MM, mm], [MW, mw]]) {
  const f = name.split("/").pop();
  check(`⭐⭐ ${f} formats the raw balance at NATIVE decimals`,
    /formatUnits\([^,)]*raw[^,)]*,\s*USDC_NATIVE_DECIMALS\)/.test(code));
  // ⛔ THE ONE THAT CATCHES A HALF-EDIT. A `raw` left on USDC_DECIMALS reads 10^12 times too large.
  // ⚠️ SCOPED TO THE USDC READER. metamask.ts also holds refreshEurcBalance, whose `raw` is a
  // genuine 6-dp ERC-20 balance — the first draft flagged it, and the flag was WRONG. A guard that
  // cannot tell the two tokens apart would push someone to "fix" the correct one.
  const usdcArea = code.split(/async function refreshEurcBalance/)[0];
  check(`⛔⛔ …and NO USDC raw is still formatted at the 6-dp token scale`,
    !/formatUnits\([^,)]*raw[^,)]*,\s*USDC_DECIMALS\)/.test(usdcArea),
    "a consumer left at 6 does not read slightly wrong — it reads a trillion times wrong");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE PRE-SIGN GUARD COMPARES LIKE WITH LIKE");
check("⭐⭐ the amount is scaled to NATIVE units before the comparison",
  /parseUnits\(String\(amountUsdc\),\s*USDC_NATIVE_DECIMALS\)/.test(mw),
  "both sides of `units > raw` must share a scale or the guard stops refusing");
check("⛔ no float arithmetic on a money amount remains anywhere in this file",
  !/Math\.round\(amountUsdc \* 1e6\)/.test(mw),
  "parseUnits works from the string; the old form multiplied a float before flooring it");
check("⭐ the guard still exists and still throws", /if \(units > raw\)/.test(mw) && /Insufficient funds/.test(mw));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⚠️ DISPLAY PRECISION DID *NOT* MOVE");
// The subtle half: one argument is a SCALE, the next is how many digits a human reads.
check("⭐⭐ the refusal renders the balance at NATIVE scale…",
  /availableAmount\(formatUnits\(raw,\s*USDC_NATIVE_DECIMALS\)/.test(mw));
check("⭐⭐ …but still DISPLAYS 6 digits, not 18",
  /availableAmount\(formatUnits\(raw,\s*USDC_NATIVE_DECIMALS\),\s*USDC_DECIMALS\)/.test(mw),
  "changing both arguments is as wrong as changing neither, and looks tidier");
check("⭐ the need is still rendered at display precision too",
  /requiredAmount\(amountUsdc,\s*USDC_DECIMALS\)/.test(mw));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐⭐ THE INVERSE: AN ERC-20 APPROVE MUST *NOT* USE NATIVE SCALE");
// ⭐ FOUND BY THIS SUITE'S OWN FIRST DRAFT, which flagged `Math.round(amountUsdc * 1e6)` as
// leftover in TWO places. Neither was: both feed `approve(...)`, the 6-decimal ERC-20 interface.
// Manual tracing had found ONE of them; the assertion found the second by refusing to write when
// its anchor matched twice.
// ⛔ THE RULE IS NOT "EVERYTHING IS 18 NOW". Native scale belongs to balances and msg.value; token
// scale belongs to approve/transfer/allowance. Both live in this one file, and "tidying" an approve
// to native would authorise 10^12 times the budget.
{
  const approves = [...mw.matchAll(/functionName:\s*"approve"/g)].length;
  check("⭐ there are approve sites to be about", approves >= 2, `${approves} found`);
  const natively = /parseUnits\(String\(amountUsdc\),\s*USDC_NATIVE_DECIMALS\)[\s\S]{0,400}?functionName:\s*"approve"/.test(mw);
  check("⛔⛔ no approve is scaled natively", !natively,
    "approving at 18 decimals would authorise a trillion times the intended amount");
  const tokenScaled = [...mw.matchAll(/parseUnits\(String\(amountUsdc\),\s*USDC_DECIMALS\)/g)].length;
  check("⭐⭐ both approve amounts are scaled at TOKEN decimals", tokenScaled === approves,
    `${tokenScaled} token-scaled vs ${approves} approves`);
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
