// _bridge-fee-table.mjs — OUR OWN bridge fees, as a grounding source the brief can cite.
//
// ═══ 🚨 WHY THIS EXISTS — A MEASURED HARM, JOB #181166 ══════════════════════════════════════════
// The question was "should i bridge 4 usdc to base". The proposal priced it at 0.053873 USDC —
// 1.35%. The BRIEF, written seconds earlier, told the buyer that "bridge fees on third-party
// bridges like Across typically run $0.50–$1.50", that "even a $0.50 fee represents a 12.5% cost",
// and concluded: wait until you have a larger amount. A 9–28× overestimate, sourced from an
// unrelated bridge, in a paid artifact, directly above our own correct number.
//
// ⭐ THE CAUSE WAS THE PROMPT, NOT THE MODEL. It said "do NOT propose a rate — the server prices it
// live", which is right about AUTHORITY and wrong about CONSEQUENCE: it left the model with no
// number, so it borrowed a stranger's. The fix is to GIVE it ours, not to forbid numbers.
//
// ═══ ⚠️ THE FEE IS FLAT IN AMOUNT AND *NOT* FLAT IN DESTINATION — MEASURED ══════════════════════
//   ethereum 1.814785   linea 0.082804   arbitrum 0.076110   avalanche 0.059741
//   base     0.053933   polygon 0.051641  unichain 0.051234   optimism  0.050995
// Spread 0.051 → 1.81 USDC, a 34× range. providerFee is 0 on testnet and forwarderFee is a fixed
// destination-gas charge, so it does NOT scale with the amount — which is exactly what makes "a
// $0.50 fee is 12.5% of $4" the wrong frame: the percentage is a property of the AMOUNT.
// 🚨 SO A SINGLE INJECTED NUMBER WOULD BE WRONG BY 34× FOR ETHEREUM — reintroducing the defect with
// our own figure instead of Across's. The WHOLE TABLE is injected, which also removes the need to
// extract a destination from the question at all: the model matches the row to whatever was named.
//
// ⭐ AND IT LETS THE MODEL BE RIGHT WHEN THE ANSWER IS "DON'T". 1.81 USDC on a 4 USDC bridge to
// Ethereum is 45% — genuinely uneconomic. Forbidding proportionality reasoning outright would have
// silenced a true warning; giving it our number lets it make that call correctly.

import { BRIDGE_DESTINATIONS, bridgeFee } from "./_bridge.mjs";

/**
 * Fetch every destination's live fee. ⚠️ DEGRADES, NEVER THROWS: a research brief must not fail
 * because IRIS is slow. An unavailable row is stated as unavailable — never omitted, because a
 * silently missing destination reads as "no fee" to a model scanning the table.
 */
export async function bridgeFeeTable({ now = () => new Date() } = {}) {
  const at = now().toISOString();
  const rows = await Promise.all(
    Object.entries(BRIDGE_DESTINATIONS).map(async ([key, d]) => {
      try {
        // amountUsdc only scales providerFee, which is 0 on testnet — 1 is a probe, not a claim
        // about the user's amount. forwarderFee is what varies, and it is amount-independent.
        const f = await bridgeFee({ amountUsdc: 1, cctpDomain: d.cctpDomain });
        return { chain: key, label: d.label, feeUsdc: Number(f.feeUsdc), available: true };
      } catch (e) {
        // 🚨 "not bridgeable right now" is a FACT the brief should carry, not an absence.
        return { chain: key, label: d.label, feeUsdc: null, available: false,
                 why: String(e?.message ?? e).slice(0, 80) };
      }
    })
  );
  return { at, rows };
}

/**
 * Render the table as ONE grounding entry.
 * ⭐ TIMESTAMPED, like the proposal's `pricedAt` and CoinGecko's "as of …Z". A fee table injected as
 * grounding is a MEASUREMENT, and a brief is read later than it is written — a reader must be able
 * to see how stale the number is. An untimestamped measurement is the defect this codebase flags
 * everywhere else.
 */
export function feeTableGroundingText(table) {
  const lines = table.rows
    .map((r) => (r.available ? `  ${r.label}: ${r.feeUsdc.toFixed(6)} USDC` : `  ${r.label}: not bridgeable right now (${r.why})`))
    .join("\n");
  return (
    `Tikpema's OWN measured bridge fee, per destination, fetched live from Circle IRIS ` +
    `(as of ${table.at}):\n${lines}\n` +
    // ═══ 🚨🚨 THE ONE PLACE A FEE-MECHANICS CLAIM REACHES A MODEL AS FACT ═══════════════════════
    // This sentence is handed to a model as grounding, and downstream it becomes generated prose no
    // guard can read. So it is the ONE place the mechanic can be stated, and the one place it must
    // be corrected when the mechanic changes.
    // ⛔ IT SAID "It is taken out of the amount, so the recipient nets amount − fee." That was true
    // and upfront fees INVERTED it: the fee is charged on the SOURCE, in addition to the amount, and
    // the recipient receives the FULL amount — measured on Base Sepolia, where a burn of 1 minor
    // unit credited exactly 1. Left unchanged, the model would have been handed a false fact and
    // repeated it in its own words, where nothing could catch it.
    // ⚠️ `verify-model-injected-claims` asserts BOTH this sentence and that `bridgeNetUsdc` agrees
    // with it, precisely so the words and the arithmetic cannot drift apart.
    `This fee is FLAT with respect to the amount bridged — it is a destination-gas charge, not a ` +
    `percentage. It is charged IN ADDITION to the amount on the source chain, so the recipient ` +
    `receives the full amount and the sender's wallet pays amount + fee.`
  );
}
