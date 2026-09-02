// verify-amount-zero-floor.mjs — ⛔ NO BOUNDARY MAY EXECUTE AN AMOUNT THAT RESOLVES TO ZERO.
//
//   node scripts/verify-amount-zero-floor.mjs   (also: npm run test:zerofloor)
//
// ═══ 🚨 WHY THIS IS A SEPARATE SUITE FROM THE EQUALITY INVARIANT ═════════
// verify-executor-amount-integrity asserts the executed amount EQUALS the capped and audited one.
// ⛔ AN AMOUNT THAT ROUNDS TO ZERO ON EVERY SIDE SATISFIES THAT INVARIANT PERFECTLY. Both sides
// agree; both are zero; the equality check is green and the chain moves nothing while reporting
// success. Equality is a relation between two numbers. The floor is a property of ONE. Neither
// implies the other — so they are two guards, and merging them would let each hide the other's case.
//
// The old gate was `Number(x) > 0`, which is TRUE for 0.0000001. USDC has six decimals, so the
// executor's `BigInt(Math.round(amount * 1e6))` yields 0n and signs a transfer of zero: gas spent,
// audit row written for the amount ASKED, day ceiling charged, chain shows nothing moved.
//
// ⭐ A REFUSAL MUST BE LOUD AND NAMED. "Succeeded at nothing" is worse than any refusal, because the
// caller is told it worked. So this asserts not merely that sub-floor amounts are rejected, but
// that the rejection SAYS WHY and NAMES THE FIELD.

import { readFileSync } from "node:fs";
import { amountFloorViolation, minorUnitsOf } from "../netlify/functions/_amount-floor.mjs";
import { validateStepShape } from "../netlify/functions/_actions.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const addr = "0x" + "a".repeat(40);

// ⭐ EVERY amount-carrying step type, with the field it spends and a VALID rest-of-shape, so a
// refusal can only come from the amount. A step that fails for an unrelated reason (bad vault, bad
// address) would give a green that says nothing about the floor.
const STEPS = [
  { type: "transfer_usdc",   field: "amountUsdc",    base: { to: addr } },
  { type: "pay_for_service", field: "payAmountUsdc", base: { payTo: addr } },
  { type: "swap_tokens",     field: "amountIn",      base: { tokenIn: "USDC", tokenOut: "EURC" } },
  { type: "bridge_usdc",     field: "amountUsdc",    base: { destination: "base" } },
];
const mk = (s, v) => ({ type: s.type, ...s.base, [s.field]: v });

section("1 — the unit of the floor is ONE MINOR UNIT, not zero");
check("⭐ 0.000001 (exactly one minor unit) is 1n", minorUnitsOf(0.000001) === 1n);
check("⭐ 0.0000004 rounds to 0n — this is the value `> 0` used to accept", minorUnitsOf(0.0000004) === 0n);
check("  …and 0.0000001 likewise", minorUnitsOf(0.0000001) === 0n);

section("2 — 🚨 EVERY amount-carrying type REFUSES a sub-floor amount");
for (const s of STEPS) {
  const r = validateStepShape(mk(s, 0.0000001));
  check(`⛔ ${s.type} refuses 0.0000001`, typeof r === "string" && r.length > 0, r || "ACCEPTED — it would execute as zero");
  check(`  …and the reason NAMES the field (${s.field})`, typeof r === "string" && r.includes(s.field));
  check("  …and says it would execute as zero, not merely that it is invalid",
    typeof r === "string" && /execute as zero|below the smallest/.test(r));
}

section("3 — ⭐ AND ACCEPTS the smallest real amount — a floor that refuses everything is not a floor");
for (const s of STEPS)
  check(`✅ ${s.type} accepts 0.000001`, validateStepShape(mk(s, 0.000001)) === null,
    validateStepShape(mk(s, 0.000001)) || "");

section("4 — zero, negative and NaN each refuse with their OWN reason");
check("0 refuses", /greater than zero/.test(amountFloorViolation(0) || ""));
check("negative refuses", /greater than zero/.test(amountFloorViolation(-1) || ""));
check("⭐ NaN refuses — `NaN > 0` and `NaN < 0` are BOTH false, so comparison guards fail open",
  /not a number/.test(amountFloorViolation(NaN) || ""));
check("  …and a missing field refuses the same way", /not a number/.test(amountFloorViolation(undefined) || ""));

section("5 — ⛔ THE FLOOR IS APPLIED WHERE FUNDS LEAVE, in every such file");
// ⭐ Derived from the files that contain a fund-moving boundary, not from a list of files that
// happen to import it — otherwise removing both the import and the call would pass.
const MOVERS = ["netlify/functions/_actions.mjs", "netlify/functions/agent-ub-spend.mjs"];
for (const f of MOVERS) {
  const src = read(f);
  check(`⭐ ${f} calls amountFloorViolation`, /amountFloorViolation\s*\(/.test(src));
  check("  …and no bare `> 0` amount test remains as the ONLY gate on an amount",
    !/!\(\s*Number\(\s*(?:step\.)?(?:amountUsdc|payAmountUsdc|amountIn)\s*\)\s*>\s*0\s*\)/.test(src));
}

console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
if (!fail) console.log("⭐ Nothing can execute an amount the chain would see as zero.");
process.exit(fail ? 1 : 0);
