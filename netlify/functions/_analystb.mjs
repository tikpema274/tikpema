import { MARKET_ID_ALLOWLIST } from "./_cryptodata.mjs";
import { estimateSwapOnly, valueInUsdc, SWAP_TOKENS } from "./_swap.mjs";
import { bridgeFee, resolveDestination } from "./_bridge.mjs";

// ANALYST B — "Markets & Execution". The second, INDEPENDENT opinion.
//
// ── WHAT MAKES IT INDEPENDENT (this is the whole point) ─────────────────────────────────
// Analyst A is the existing pipeline: Exa web retrieval → a narrative brief. It answers
// "SHOULD you do this?" and it can be wrong by being spun — a bullish article, a stale quote,
// a confident source that is simply out of date.
//
// Analyst B never touches the web. It reads TWO sources A cannot:
//   1. CoinGecko  — an independent market price for both assets (euro-coin, usd-coin)
//   2. The CHAIN  — the actual executable rate, right now, from the real swap router
//
// From those it computes something A structurally cannot see: **is the rate you would
// actually get FAIR?**
//
//     implied fair rate = price(USDC) / price(EURC)      ← from the market, independently
//     executable rate   = amountOut / amountIn           ← from the router, for real
//     spread            = how much worse the chain is than the market
//
// A real example, from the live swap we ran:
//     fair       0.99983 / 1.14 = 0.8770 EURC per USDC
//     executable 4.283006 / 5   = 0.8566
//     spread     ~2.3% WORSE than fair
//
// A reading Coinbase would report "the rate is ~0.862" and never notice. That is not a
// difference of opinion — it is a fact A cannot reach. THAT is what makes the disagreement
// real rather than two models agreeing with each other in different words.
//
// ⚠️ B IS BLINDED TO A. It is never shown A's brief. If it were, it would anchor, and the
// independence — the only thing that makes disagreement meaningful — would collapse.
//
// ⚠️ B HAS NO DIRECTIONAL VIEW, ON PURPOSE. It will never tell you where EUR is heading. It
// tells you what the trade costs and whether it can execute at all. Asking it to opine on
// direction would just make it a worse copy of A.

// How far the executable rate may sit from the market-implied fair rate before B objects.
// A stablecoin FX pair should be tight; a wide spread means you are paying for illiquidity.
//
// ⚠️ THESE ARE APPLIED TO THE ABSOLUTE SPREAD — a rate far BETTER than fair is as suspicious
// as one far worse. An "amazing" quote on a stablecoin pair means the QUOTE is wrong or the
// MARKET DATA is wrong; it does not mean free money. B refuses to endorse a price it cannot
// trust in EITHER direction. (This is not hypothetical: the live router currently quotes
// EURC→USDC 16% ABOVE fair value, which the first cut of this code cheerfully called "a
// normal spread" and waved through.)
const SPREAD_CAUTION = 0.01; // 1%  — worth telling the user about
const SPREAD_REFUSE = 0.05;  // 5%  — B refuses; the quote cannot be trusted

// A round trip must LOSE money — you pay the spread both ways. If quoting both directions
// implies a GAIN, the router's pricing is internally inconsistent and no single quote from it
// can be trusted. This check is free (estimates cost nothing) and it is the single strongest
// sanity test available to B.
//
// It is currently FAILING on Arc testnet: 1 USDC → 0.794627 EURC → 1.050234 USDC, a 5%
// round-trip gain. That arbitrage cannot exist. B catches it; a web-reading analyst never would.
const ROUNDTRIP_TOLERANCE = 0.005; // allow 0.5% for rounding/quote timing

const pct = (x) => Math.round(x * 10000) / 100; // 0.0231 → 2.31

const COINGECKO_ID = { USDC: "usd-coin", EURC: "euro-coin" };

// Independent market prices. Free, keyless. Any failure → null, and B says it CANNOT price
// the trade rather than guessing — an analyst that invents a number is worse than no analyst.
async function marketPrices(tokens) {
  const ids = tokens.map((t) => COINGECKO_ID[t]).filter((id) => id && MARKET_ID_ALLOWLIST.has(id));
  if (ids.length !== tokens.length) return null;
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd`,
      { headers: { accept: "application/json" } }
    );
    if (!r.ok) return null;
    const d = await r.json();
    const out = {};
    for (const t of tokens) {
      const p = d?.[COINGECKO_ID[t]]?.usd;
      if (typeof p !== "number" || !(p > 0)) return null;
      out[t] = p;
    }
    return out;
  } catch {
    return null;
  }
}

// ── SWAP: is the executable rate fair, and can it execute at all? ────────────────────────
async function analyseSwap({ walletAddress, tokenIn, tokenOut, amountIn }) {
  const facts = [];

  // 1. The MARKET's view — independent of the chain we are about to trade on.
  const prices = await marketPrices([tokenIn, tokenOut]);
  if (!prices) {
    return {
      verdict: "cannot_verify",
      headline: `Could not price ${tokenIn}/${tokenOut} from an independent market source, so I cannot say whether the on-chain rate is fair.`,
      facts,
    };
  }
  const fairRate = prices[tokenIn] / prices[tokenOut]; // tokenOut per tokenIn
  facts.push(
    `Independent market price (CoinGecko): ${tokenIn} $${prices[tokenIn]}, ${tokenOut} $${prices[tokenOut]} ` +
      `⇒ a fair rate would be ~${fairRate.toFixed(6)} ${tokenOut} per ${tokenIn}.`
  );

  // ── CROSS-CHECK the fair rate against a SECOND independent reference. ──
  // B's whole verdict hangs on the fair rate, so a single source for it is a single point of
  // failure — the exact thing B exists to remove. App Kit's token rates are ECB-backed and
  // entirely separate from CoinGecko. If the two agree, B can trust its own baseline. If they
  // DISAGREE materially, B does not get to pick a winner: it says it cannot verify.
  try {
    const refIn = await valueInUsdc({ token: tokenIn, amount: 1 });
    const refOut = await valueInUsdc({ token: tokenOut, amount: 1 });
    if (refIn > 0 && refOut > 0) {
      const refRate = refIn / refOut;
      const refGap = Math.abs(refRate - fairRate) / fairRate;
      facts.push(
        `Second independent reference (App Kit / ECB): ~${refRate.toFixed(6)} ${tokenOut} per ${tokenIn} ` +
          `— ${refGap < 0.01 ? "agrees with" : "DISAGREES with"} CoinGecko (${pct(refGap)}% apart).`
      );
      if (refGap >= 0.02) {
        return {
          verdict: "cannot_verify",
          headline:
            `My two independent price references disagree by ${pct(refGap)}%, so I cannot establish what a fair rate even is. ` +
            `I will not judge the on-chain price against a baseline I do not trust.`,
          facts,
        };
      }
    }
  } catch {
    facts.push("A second price reference was unavailable, so the fair rate rests on CoinGecko alone.");
  }

  // 2. The CHAIN's view — what you would ACTUALLY get. This is the number that matters, and
  //    it is the one a web-reading analyst never sees.
  let estimate;
  try {
    estimate = await estimateSwapOnly({ walletAddress, tokenIn, tokenOut, amountIn });
  } catch (e) {
    // No route / no liquidity is a HARD refusal, whatever the narrative says. We hit exactly
    // this live ("No route available") — a bullish story cannot conjure a route.
    return {
      verdict: "refuse",
      headline: `The swap cannot execute right now: ${e.message}. No rate, however attractive, matters if the trade cannot be routed.`,
      facts,
    };
  }

  const amountOut = Number(estimate?.estimatedOutput?.amount ?? NaN);
  if (!Number.isFinite(amountOut) || amountOut <= 0) {
    return {
      verdict: "refuse",
      headline: "The swap router returned no usable output amount — the trade cannot be priced, so it must not be proposed.",
      facts,
    };
  }

  const executable = amountOut / Number(amountIn);
  // Positive spread = the chain is WORSE than the market. Negative = suspiciously BETTER.
  const spread = (fairRate - executable) / fairRate;
  const absSpread = Math.abs(spread);
  facts.push(
    `Executable on-chain right now: ${amountIn} ${tokenIn} → ${amountOut.toFixed(6)} ${tokenOut} ` +
      `(~${executable.toFixed(6)} per ${tokenIn}).`
  );
  facts.push(
    spread > 0
      ? `That is ${pct(spread)}% WORSE than the market-implied fair rate.`
      : `That is ${pct(-spread)}% BETTER than the market-implied fair rate — which on a stablecoin pair is itself suspicious.`
  );

  // ── THE ROUND-TRIP CHECK. Free, and the strongest test B has. ──
  // Quote the REVERSE direction. A round trip must LOSE money (you pay the spread twice). If
  // it GAINS, the router is pricing the two directions inconsistently and NO quote from it can
  // be trusted — not the one we are about to act on, either.
  let roundTrip = null;
  try {
    const back = await estimateSwapOnly({ walletAddress, tokenIn: tokenOut, tokenOut: tokenIn, amountIn: amountOut });
    const backAmount = Number(back?.estimatedOutput?.amount ?? NaN);
    if (Number.isFinite(backAmount) && backAmount > 0) {
      roundTrip = backAmount / Number(amountIn); // >1 ⇒ free money ⇒ impossible
      facts.push(
        `Round trip: ${amountIn} ${tokenIn} → ${amountOut.toFixed(6)} ${tokenOut} → ${backAmount.toFixed(6)} ${tokenIn} ` +
          `(${roundTrip > 1 ? "+" : ""}${pct(roundTrip - 1)}%).`
      );
      if (roundTrip > 1 + ROUNDTRIP_TOLERANCE) {
        return {
          verdict: "refuse",
          headline:
            `The swap router is pricing the two directions inconsistently: a round trip would GAIN ${pct(roundTrip - 1)}%, ` +
            `which is impossible. Its quotes cannot be trusted right now, so I will not endorse trading on one.`,
          facts,
          fairRate, executable, spreadPct: pct(spread), amountOut, roundTrip,
        };
      }
    }
  } catch {
    // The reverse quote failing is not fatal — we still have the spread check. Note it and move on.
    facts.push("Could not quote the reverse direction, so the round-trip consistency check was skipped.");
  }

  // ⚠️ SYMMETRIC. A rate far BETTER than fair is not a bargain — it means the quote or the
  // market data is wrong, and B must not endorse a price it cannot trust in either direction.
  if (absSpread >= SPREAD_REFUSE) {
    return {
      verdict: "refuse",
      headline:
        spread > 0
          ? `The on-chain rate is ${pct(spread)}% WORSE than fair value — far outside what a stablecoin pair should cost. ` +
            `I will not endorse converting at this price.`
          : `The on-chain rate is ${pct(-spread)}% BETTER than fair value. On a stablecoin pair that is not a bargain — it means ` +
            `the quote or the reference price is wrong. I will not endorse trading on a price I cannot trust.`,
      facts,
      fairRate, executable, spreadPct: pct(spread), amountOut, roundTrip,
    };
  }
  if (absSpread >= SPREAD_CAUTION) {
    return {
      verdict: "caution",
      headline:
        spread > 0
          ? `The trade executes, but at ${pct(spread)}% worse than fair value. You are paying a real spread to convert now, ` +
            `regardless of where the euro is heading.`
          : `The trade executes at ${pct(-spread)}% BETTER than fair value. That is unusual for a stablecoin pair — treat the ` +
            `quote with suspicion rather than as a windfall.`,
      facts,
      fairRate, executable, spreadPct: pct(spread), amountOut, roundTrip,
    };
  }
  return {
    verdict: "proceed",
    headline:
      `The trade executes at ~${pct(absSpread)}% from fair value — a normal spread for this pair — and the router prices both ` +
      `directions consistently. The mechanics are sound; whether you SHOULD convert is a separate question I do not answer.`,
    facts,
    fairRate, executable, spreadPct: pct(spread), amountOut, roundTrip,
  };
}

// ── BRIDGE: does the economics survive the live fee? ─────────────────────────────────────
async function analyseBridge({ destination, amountUsdc }) {
  const facts = [];
  const dest = resolveDestination(destination);
  if (!dest) {
    return { verdict: "refuse", headline: `"${destination}" is not a destination this agent can bridge to.`, facts };
  }
  let fee;
  try {
    fee = await bridgeFee({ amountUsdc, cctpDomain: dest.cctpDomain });
  } catch (e) {
    return { verdict: "cannot_verify", headline: `Could not price the bridge to ${dest.label} live (${e.message}), so I cannot verify the economics.`, facts };
  }

  const feeUsdc = Number(fee.feeUsdc);
  const net = Number(fee.netUsdc);
  const burn = feeUsdc / Number(amountUsdc);
  facts.push(`Live bridge fee to ${dest.label}: ${feeUsdc.toFixed(4)} USDC on ${amountUsdc} ⇒ ~${net.toFixed(4)} arrives.`);
  facts.push(`The fee is ${pct(burn)}% of the amount — and it is taken OUT of what you send.`);

  if (net <= 0) {
    return { verdict: "refuse", headline: `The fee (${feeUsdc.toFixed(2)}) meets or exceeds the amount — nothing would arrive.`, facts, feeUsdc, netUsdc: net };
  }
  if (burn >= 0.10) {
    return {
      verdict: "caution",
      headline: `The fee eats ${pct(burn)}% of this bridge. It executes, but it is expensive for the size — a larger amount would amortise it better.`,
      facts, feeUsdc, netUsdc: net,
    };
  }
  return {
    verdict: "proceed",
    headline: `The bridge is economical: the fee is ${pct(burn)}% of the amount and ~${net.toFixed(2)} USDC would arrive.`,
    facts, feeUsdc, netUsdc: net,
  };
}

// Analyse the SAME action A proposed — from numbers only.
//
// `proposal` is the model's RAW proposal (A's), used solely to know WHICH action to price.
// B forms no view from A's prose; it re-derives every number itself.
export async function analystB({ proposal, walletAddress }) {
  const action = String(proposal?.action || "").toLowerCase();

  if (action === "swap" || action === "swap_tokens") {
    const tokenIn = SWAP_TOKENS.find((t) => t.toUpperCase() === String(proposal.tokenIn).toUpperCase());
    const tokenOut = SWAP_TOKENS.find((t) => t.toUpperCase() === String(proposal.tokenOut).toUpperCase());
    const amountIn = Number(proposal.amountIn);
    if (!tokenIn || !tokenOut || tokenIn === tokenOut || !(amountIn > 0)) {
      return { verdict: "refuse", headline: "The proposed swap is not well-formed, so there is nothing to price.", facts: [] };
    }
    return { ...(await analyseSwap({ walletAddress, tokenIn, tokenOut, amountIn })), action: "swap_tokens" };
  }

  if (action === "bridge" || action === "bridge_usdc") {
    const amountUsdc = Number(proposal.amountUsdc ?? proposal.amount);
    if (!(amountUsdc > 0)) {
      return { verdict: "refuse", headline: "The proposed bridge has no valid amount, so there is nothing to price.", facts: [] };
    }
    return { ...(await analyseBridge({ destination: proposal.destination, amountUsdc })), action: "bridge_usdc" };
  }

  // No action proposed ⇒ nothing for B to check. That is not a disagreement.
  return { verdict: "no_action", headline: "No action was proposed, so there was nothing for me to price.", facts: [] };
}
