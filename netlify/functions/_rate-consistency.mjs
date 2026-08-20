// _rate-consistency.mjs — IF A BRIEF CLAIMS ITS RATE IS CONSISTENT WITH ITS PRICES, THE
// ARITHMETIC MUST HOLD.
//
// ═══ 🚨 THE MEASURED HARM — JOB #181295 ═══════════════════════════════════════════════════════
// The brief headlined `~0.874 EURC per USDC [1]` (SimpleSwap, a rate that embeds their spread) and
// wrote: *"consistent with EURC trading at ~$1.17 vs USDC at ~$1.00 [7][8]"*. Those two grounding
// entries are OUR OWN injected CoinGecko measurement, and their quotient is 0.999612 / 1.17 =
// **0.854369** — the SAME number analyst B computed, to six decimals, corroborated by an
// ECB-backed second source 0.04% away. The headline was wrong by **2.30%**, and the buyer's
// takeaway number, "approximately 3.50 EURC", should have been 3.417.
//
// ⭐⭐ THE DEFECT IS THE WORD "CONSISTENT", NOT THE DIVERGENT RATE. Quoting SimpleSwap's 0.874 while
// saying *"indicative, from SimpleSwap, which includes their spread"* is HONEST and must keep
// passing — an aggregator's executable quote is a real, useful fact. What cannot stand is asserting
// agreement between two numbers 2.3% apart, because that assertion is exactly what stops a reader
// doing the division themselves.
//
// ⚠️ SO THE RULE IS CONDITIONAL, AND DELIBERATELY NOT "the rate must equal the quotient":
//     asserts consistency  → the arithmetic MUST hold within TOLERANCE
//     does not assert it   → a divergent rate is ALLOWED, but must be LABELLED indicative
//     unlabelled + divergent + silent → still a violation: an unqualified number reads as ours
//
// ═══ ⚠️ THIS MATCHES PROSE, WHICH IS NORMALLY THE ANTI-PATTERN HERE ═══════════════════════════
// `ce58631` exists because a refusal CAUSE was re-derived by matching B's prose downstream instead
// of being typed at the catch site. This is not that. The consistency assertion EXISTS NOWHERE BUT
// THE PROSE — it is a claim the model made in words, and words are the only place it lives. ⭐ The
// numbers it is checked against are NOT taken from prose: the component prices come from the
// GROUNDING ENTRIES, which are our own measurement. Only the assertion is read from text.
//
// Pure. No network, no clock, no I/O — so a guard can run it offline against a recorded record.

/**
 * ⚠️⚠️ THE TOLERANCE IS THE DECISION IN THIS FILE, AND IT IS ARGUED, NOT ROUNDED.
 *
 * FLOOR (how tight can it be before honest briefs fail?). The brief's grounding and B's check are
 * fetched seconds apart, so the pair can drift between them. On job #181295 two GENUINELY
 * INDEPENDENT sources — CoinGecko and ECB-backed App Kit — landed **0.04% apart**. That is the
 * measured noise across different providers, which is strictly wider than the same provider a few
 * seconds later. So the real floor is well under 0.1%.
 *
 * CEILING (how loose before the defect passes?). The observed harm was **2.30%**.
 *
 * ⭐ CHOSEN: 1.0%, and the reason is CONSISTENCY OF MEANING rather than taste. `_analystb.mjs`
 * ALREADY draws this line: `refGap < 0.01` renders as "agrees with", `refGap >= 0.02` makes B
 * refuse to verify at all. Picking anything else would give this codebase two different meanings
 * for "these two rates agree", and a second meaning is how the duplicate-source-of-truth bug starts.
 *
 * That leaves 25× headroom over the measured 0.04% cross-source noise, and 2.3× margin under the
 * defect it must catch.
 *
 * ⚠️ AND THE ERROR COSTS ARE ASYMMETRIC, WHICH IS WHY "WHEN UNSURE, TIGHTER" IS RIGHT HERE: a false
 * FAIL costs a brief that must call its rate indicative — cheap, and honest anyway. A false PASS
 * ships a wrong number in an artifact someone paid for. Never loosen this to make a brief pass.
 */
export const RATE_TOLERANCE = 0.01;

/** CoinGecko ids as they appear in an injected grounding entry, mapped to the token symbol. */
const GROUNDING_ID = { "usd-coin": "USDC", "euro-coin": "EURC" };

/**
 * The model claiming its rate agrees with the prices it cited. ⭐ Deliberately broad: every phrase
 * here does the same work on a reader — it discharges the duty to check.
 */
const CONSISTENCY_CLAIM = /\b(consistent with|in line with|matches|agrees with|corroborat\w+|which tracks|tallies with|implied by)\b/i;

/**
 * Language that presents a rate as somebody else's quote rather than our measurement. ⭐ Naming the
 * venue counts: "the SimpleSwap rate" is already an attribution, and demanding a magic word would
 * fail briefs that are being perfectly straight.
 */
const INDICATIVE_LABEL = /\b(indicative|approximate|may differ|will differ|priced at execution|not (?:a )?quote|third[- ]party|aggregator|simpleswap|according to|as (?:quoted|advertised) by|quoted by)\b/i;

/** `usd-coin — price: $0.999612 · …` → { USDC: 0.999612 } */
export function componentPrices(groundingEntries = []) {
  const out = {};
  for (const e of groundingEntries) {
    const t = typeof e === "string" ? e : e?.title ?? "";
    const m = /^\s*([a-z-]+)\s*[—-]\s*price:\s*\$([0-9]*\.?[0-9]+)/i.exec(t);
    if (!m) continue;
    const sym = GROUNDING_ID[m[1].toLowerCase()];
    const px = Number(m[2]);
    if (sym && px > 0) out[sym] = px;
  }
  return out;
}

/**
 * The rate the brief STATES, in `tokenOut per tokenIn`. Handles the two shapes briefs actually use:
 * `1 USDC ≈ 0.874 EURC` and `~0.874 EURC per USDC`.
 * ⚠️ Returns null when nothing parses — and null is NOT "fine", see the tri-state below.
 */
export function statedRate(text = "") {
  const m1 = /\b1\s*(USDC|EURC)\s*(?:≈|~|=|is worth|buys)\s*\$?([0-9]*\.?[0-9]+)\s*(USDC|EURC)\b/i.exec(text);
  if (m1 && m1[1].toUpperCase() !== m1[3].toUpperCase())
    return { rate: Number(m1[2]), from: m1[1].toUpperCase(), to: m1[3].toUpperCase() };
  const m2 = /~?\s*([0-9]*\.?[0-9]+)\s*(USDC|EURC)\s*(?:per|\/)\s*(USDC|EURC)\b/i.exec(text);
  if (m2 && m2[2].toUpperCase() !== m2[3].toUpperCase())
    return { rate: Number(m2[1]), from: m2[3].toUpperCase(), to: m2[2].toUpperCase() };
  return null;
}

export const VERDICT = Object.freeze({
  OK: "ok",
  ASSERTED_BUT_WRONG: "asserted-consistency-fails-arithmetic",
  DIVERGENT_UNLABELLED: "divergent-rate-not-labelled-indicative",
  // 🚨 NOT A PASS. "We could not check" and "we checked and it is fine" are different answers, and
  // collapsing them is the failure family this repo keeps closing. A caller must render it as an
  // unchecked brief, never as a clean one.
  NOT_APPLICABLE: "not-applicable",
});

/**
 * @param {{answer?:string, reasoning?:string, grounding?:any[]}} brief
 * @returns {{verdict:string, why:string, stated?:number, computed?:number, gap?:number,
 *            assertsConsistency?:boolean, labelled?:boolean}}
 */
export function checkRateConsistency({ answer = "", reasoning = "", grounding = [] } = {}) {
  const text = `${answer}\n${reasoning}`;
  const px = componentPrices(grounding);
  const stated = statedRate(text);

  if (!stated) return { verdict: VERDICT.NOT_APPLICABLE, why: "no rate is stated in the prose" };
  if (px[stated.from] === undefined || px[stated.to] === undefined)
    return { verdict: VERDICT.NOT_APPLICABLE,
             why: `the grounding carries no measured price for ${stated.from}/${stated.to}, so there is nothing to check the stated rate against` };

  const computed = px[stated.from] / px[stated.to];
  const gap = Math.abs(stated.rate - computed) / computed;
  const asserts = CONSISTENCY_CLAIM.test(text);
  const labelled = INDICATIVE_LABEL.test(text);
  const base = { stated: stated.rate, computed, gap, assertsConsistency: asserts, labelled };

  if (gap <= RATE_TOLERANCE)
    return { ...base, verdict: VERDICT.OK, why: `the stated rate is within ${RATE_TOLERANCE * 100}% of our own measured prices` };

  // ⭐ DIVERGENT FROM HERE. Which of the two rules applies is decided by what the brief CLAIMED.
  if (asserts)
    return { ...base, verdict: VERDICT.ASSERTED_BUT_WRONG,
             why: `the brief asserts its rate is consistent with the cited prices, but ${stated.rate} vs a computed ${computed.toFixed(6)} is ${(gap * 100).toFixed(2)}% apart` };
  if (!labelled)
    return { ...base, verdict: VERDICT.DIVERGENT_UNLABELLED,
             why: `the rate is ${(gap * 100).toFixed(2)}% from our own measured prices and is presented without saying it is indicative or whose quote it is` };
  return { ...base, verdict: VERDICT.OK,
           why: `divergent by ${(gap * 100).toFixed(2)}%, but presented as an indicative third-party quote rather than as agreeing with our prices — which is honest` };
}
