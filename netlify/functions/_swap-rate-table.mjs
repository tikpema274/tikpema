// _swap-rate-table.mjs — OUR OWN USDC/EURC rate, as a grounding source the brief can cite.
//
// ═══ 🚨 WHY THIS EXISTS — JOB #181295, AND IT IS THE FEE-TABLE HARM AGAIN ══════════════════════
// The brief headlined `~0.874 EURC per USDC` from SimpleSwap — an aggregator quote carrying their
// spread — and told the buyer 4 USDC "would yield approximately 3.50 EURC". Analyst B, on the same
// page, computed 0.854369 from CoinGecko and corroborated it against ECB-backed App Kit rates
// 0.04% away. The right answer was 3.417.
//
// ⭐⭐ AND THIS IS WORSE THAN THE BRIDGE CASE IN ONE EXACT WAY. For bridges (`8c1d1e9`) the better
// number lived in a table the model had never seen, so borrowing a stranger's was at least
// explicable. Here **our own measurement was already in the brief's own citation list** — entries
// [7] and [8] ARE the injected CoinGecko prices. The model held both components, cited them, and
// used them as decoration for a worse number it got elsewhere. Giving it the raw ingredients was
// not enough; it has to be handed the DIVISION, already done, as a fact of its own.
//
// ═══ ⚠️ TWO INSTRUMENTS, NOT ONE — and the disagreement is part of the entry ═══════════════════
// A single price source for a rate is a single point of failure, which is the exact thing analyst B
// was built to remove. So this fetches CoinGecko AND the ECB-backed App Kit reference and states
// BOTH, plus how far apart they are. ⭐ If they disagree materially the entry SAYS SO rather than
// picking a winner — a model reading "these two disagree by 3%" should hedge, and a model reading
// one confident number cannot know to.
//
// ⚠️ DEGRADES, NEVER THROWS. A research brief must not fail because CoinGecko is slow. No table →
// the brief proceeds exactly as it does today.

import { MARKET_ID_ALLOWLIST } from "./_cryptodata.mjs";
import { valueInUsdc } from "./_swap.mjs";

const COINGECKO_ID = { USDC: "usd-coin", EURC: "euro-coin" };
const pct = (x) => Math.round(x * 10000) / 100;

async function coingeckoPair() {
  const ids = Object.values(COINGECKO_ID).filter((id) => MARKET_ID_ALLOWLIST.has(id));
  if (ids.length !== 2) return null;
  const r = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`,
    { headers: { accept: "application/json" } }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const usdc = d?.[COINGECKO_ID.USDC]?.usd;
  const eurc = d?.[COINGECKO_ID.EURC]?.usd;
  if (typeof usdc !== "number" || typeof eurc !== "number" || !(usdc > 0) || !(eurc > 0)) return null;
  return { usdc, eurc, rate: usdc / eurc };
}

/**
 * Our own USDC→EURC rate from two independent references.
 * @returns {Promise<null | {at:string, usdc:number, eurc:number, rate:number,
 *                           refRate:number|null, gapPct:number|null, agree:boolean|null}>}
 */
export async function swapRateTable({ now = () => new Date() } = {}) {
  const at = now().toISOString();
  const cg = await coingeckoPair().catch(() => null);
  if (!cg) return null; // ⚠️ no primary → no entry at all. Never a half-stated rate.

  // Second, independent reference. Its absence is NOT a failure — it is a weaker entry, and the
  // entry says which it is rather than implying corroboration it does not have.
  let refRate = null;
  try {
    const refIn = await valueInUsdc({ token: "USDC", amount: 1 });
    const refOut = await valueInUsdc({ token: "EURC", amount: 1 });
    if (refIn > 0 && refOut > 0) refRate = refIn / refOut;
  } catch {
    refRate = null;
  }
  const gapPct = refRate === null ? null : pct(Math.abs(refRate - cg.rate) / cg.rate);
  return { at, usdc: cg.usdc, eurc: cg.eurc, rate: cg.rate, refRate,
           gapPct, agree: gapPct === null ? null : gapPct < 1 };
}

/**
 * Render as ONE numbered grounding entry, timestamped like the fee table and CoinGecko's own facts.
 * ⭐ IT STATES THE QUOTIENT EXPLICITLY, because handing the model two prices demonstrably was not
 * enough — job #181295 cited both and still headlined somebody else's number.
 * ⚠️ It also names what an aggregator's rate IS, so the model can quote one honestly (labelled,
 * attributed) instead of either borrowing it silently or being forbidden a number at all —
 * forbidding numbers is what caused the bridge defect in the first place.
 */
export function swapRateGroundingText(t) {
  const lines = [
    `Tikpema's OWN measured USDC/EURC rate, computed from independent market prices ` +
      `(as of ${t.at}):`,
    `  CoinGecko: USDC $${t.usdc}, EURC $${t.eurc} ⇒ ${t.rate.toFixed(6)} EURC per USDC`,
  ];
  if (t.refRate === null) {
    lines.push(`  Second reference (App Kit / ECB): unavailable — this rate rests on ONE source.`);
  } else {
    lines.push(
      `  Second independent reference (App Kit / ECB): ${t.refRate.toFixed(6)} EURC per USDC ` +
        `— ${t.agree ? "agrees with" : "DISAGREES with"} CoinGecko (${t.gapPct}% apart).`
    );
  }
  lines.push(
    `Use THIS rate for any amount you quote. A rate advertised by a swap aggregator is an ` +
      `EXECUTABLE quote that includes that venue's spread, so it will sit below this one; you may ` +
      `cite such a rate, but say whose it is and call it indicative — do not describe it as ` +
      `consistent with the prices above unless it is within 1%.`
  );
  return lines.join("\n");
}
