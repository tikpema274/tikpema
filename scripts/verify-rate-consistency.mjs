// verify-rate-consistency.mjs — A REAL BRIEF, THROUGH THE REAL CHECKER.
//
//   node scripts/verify-rate-consistency.mjs            (also: npm run test:research)
//
// ═══ 🚨 WHAT THIS GUARDS ═════════════════════════════════════════════════════════════════════
// Job #181295 headlined `~0.874 EURC per USDC` from SimpleSwap and called it *"consistent with
// EURC trading at ~$1.17 vs USDC at ~$1.00 [7][8]"* — our own injected CoinGecko prices, whose
// quotient is 0.854369. **2.30% apart, and the word "consistent" is what stopped anyone dividing.**
// The buyer's number, "approximately 3.50 EURC", should have been 3.417.
//
// ⭐ THE FIXTURE IS THE FAILING JOB ITSELF, not a constructed one. Every previous instance of this
// family was caught late because the guard above it built its own input and could only prove the
// component worked when fed. `scripts/fixtures/job-brief-181295.json` is the recorded record.
//
// ⚠️ AND THE RULE IS CONDITIONAL BY DESIGN — an over-constrained version would be wrong. Quoting an
// aggregator's rate is legitimate and often useful; what cannot stand is asserting agreement
// between numbers that disagree. Section 3 asserts the honest form still PASSES, because a guard
// that forbids the honest form would just push briefs into saying nothing at all — which is the
// mistake that caused the bridge-fee defect (`8c1d1e9`) in the first place.

import { readFileSync } from "node:fs";
import {
  checkRateConsistency, componentPrices, statedRate, VERDICT, RATE_TOLERANCE,
} from "../netlify/functions/_rate-consistency.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const REC = JSON.parse(readFileSync(new URL("./fixtures/job-brief-181295.json", import.meta.url), "utf8"));
const BRIEF = REC.brief;
const GROUNDING = [...(BRIEF.sources ?? []), ...(BRIEF.retrievedNotCited ?? [])];

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  RATE CONSISTENCY — the real brief #181295, through the real checker ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — 🚨 THE FIXTURE MUST STILL CARRY WHAT THIS CHECKS");
// Same rule as the merge guard's section 0: if the fixture ever loses its prices or its rate, every
// assertion below would pass vacuously against a NOT_APPLICABLE.
const px = componentPrices(GROUNDING);
check("🚨 the fixture still carries BOTH measured component prices",
  px.USDC === 0.999612 && px.EURC === 1.17, `USDC=${px.USDC} EURC=${px.EURC}`);
const st = statedRate(`${BRIEF.answer}\n${BRIEF.reasoning}`);
check("🚨 …and the brief still states a rate", !!st, st ? `${st.rate} ${st.to} per ${st.from}` : "none parsed");
check("⭐ …and the arithmetic still reproduces analyst B's figure to six decimals",
  (px.USDC / px.EURC).toFixed(6) === "0.854369", (px.USDC / px.EURC).toFixed(6));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE DEFECT: asserted consistency that fails the arithmetic");
const v = checkRateConsistency({ answer: BRIEF.answer, reasoning: BRIEF.reasoning, grounding: GROUNDING });
check("⭐⭐ #181295 is CAUGHT", v.verdict === VERDICT.ASSERTED_BUT_WRONG, v.verdict);
check("  …the gap is the measured 2.30%", v.gap > 0.022 && v.gap < 0.024, `${(v.gap * 100).toFixed(2)}%`);
check("  …and the reason names both numbers, so a reader can check it themselves",
  /0\.874/.test(v.why) && /0\.854369/.test(v.why));
check("⭐ the checker saw the consistency CLAIM, which is what makes it a violation",
  v.assertsConsistency === true);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⚠️ THE TOLERANCE IS THE DECISION, SO PIN IT");
check(`⭐ tolerance is ${RATE_TOLERANCE * 100}%, matching _analystb's own "agrees with" line (refGap < 0.01)`,
  RATE_TOLERANCE === 0.01);
const near = (rate, extra = "") => checkRateConsistency({
  answer: `1 USDC ≈ ${rate} EURC, consistent with the prices above.${extra}`, grounding: GROUNDING });
check("⭐ a rate 0.04% out PASSES — the measured cross-source noise on this very job",
  near((0.999612 / 1.17) * 1.0004).verdict === VERDICT.OK);
check("  …0.9% out still passes (inside the band)", near((0.999612 / 1.17) * 1.009).verdict === VERDICT.OK);
check("🚨 …1.5% out FAILS — the band is real, not decorative",
  near((0.999612 / 1.17) * 1.015).verdict === VERDICT.ASSERTED_BUT_WRONG);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE HONEST FORM MUST STILL PASS (or the guard forbids the truth)");
// The SAME divergent 0.874, presented straight. This is the assertion that keeps the rule keyed on
// the claim rather than on divergence — over-constraining here would push briefs into silence.
const honest = checkRateConsistency({
  answer: "The indicative rate quoted by SimpleSwap is ~0.874 EURC per USDC, which includes their spread.",
  grounding: GROUNDING });
check("⭐⭐ a divergent rate that is LABELLED indicative and attributed → OK",
  honest.verdict === VERDICT.OK, `${honest.verdict} (gap ${(honest.gap * 100).toFixed(2)}%)`);
check("  …and the checker still recorded the divergence rather than ignoring it",
  honest.gap > 0.022 && honest.assertsConsistency === false);
const bare = checkRateConsistency({ answer: "1 USDC ≈ 0.874 EURC. Swapping 4 USDC yields about 3.50 EURC.", grounding: GROUNDING });
check("🚨 the same number with NO label and NO attribution → still a violation",
  bare.verdict === VERDICT.DIVERGENT_UNLABELLED, bare.verdict);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — 🚨 UNCHECKABLE IS NOT A PASS");
// The failure family this repo keeps closing: an absence filling the result slot and reading as
// safety. A brief we could not check must be distinguishable from one we checked and cleared.
check("🚨 no grounding prices → NOT_APPLICABLE, never OK",
  checkRateConsistency({ answer: "1 USDC ≈ 0.874 EURC, consistent with the above.", grounding: [] }).verdict
    === VERDICT.NOT_APPLICABLE);
check("🚨 no stated rate → NOT_APPLICABLE, never OK",
  checkRateConsistency({ answer: "EURC is a euro stablecoin.", grounding: GROUNDING }).verdict
    === VERDICT.NOT_APPLICABLE);
check("⭐ …and NOT_APPLICABLE is a distinct value from OK, so a caller cannot conflate them",
  VERDICT.NOT_APPLICABLE !== VERDICT.OK);

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
