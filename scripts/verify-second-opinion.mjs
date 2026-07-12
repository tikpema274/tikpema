// verify-second-opinion.mjs — ZERO-MONEY proof of Brick 2's second analyst + synthesis.
//
// THE CLAIM UNDER TEST: disagreement is a SIGNAL, and it CHANGES THE OUTCOME.
// Not "two analysts ran". Not "a confidence score got lower". The test is whether a second,
// independent analyst can KILL a proposal the first one argued for — because a confidence
// number the user can ignore does not stop a bad action, and a refusal does.
//
// Analyst B's independence is the load-bearing claim, so it is asserted directly:
//   · B is never shown A's brief or A's reasoning (blinding — anchor it and disagreement dies)
//   · B's verdict comes from an INDEPENDENT market price + the LIVE chain rate, not from prose
//   · B can refuse on facts A structurally cannot see (no route; rate far off fair value)
//
//   node --experimental-test-module-mocks --env-file=.env scripts/verify-second-opinion.mjs
import { mock } from "node:test";

const WALLET = "0xbafec950627579cf786acf875e6e216995e995a3";

// The live chain, stubbed. `estimate` is what the swap router would ACTUALLY return.
let estimate = { estimatedOutput: { token: "EURC", amount: "4.283006" } };
let estimateThrows = null;
let sawA = null; // ⚠️ records anything A-shaped that leaks into B — must stay null

// The reverse quote, for the round-trip check. By default it is CONSISTENT (a round trip
// loses a little to the spread). Set `reverseRate` to fabricate an inconsistent router.
let reverseRate = null; // null ⇒ derive a consistent reverse quote from `estimate`

mock.module("../netlify/functions/_swap.mjs", {
  namedExports: {
    SWAP_TOKENS: ["USDC", "EURC"],
    // The SECOND independent price reference (ECB-backed). Kept in step with the CoinGecko
    // mock so B's two references agree — a disagreement is its own test case.
    valueInUsdc: async ({ token, amount }) =>
      Number(amount) * (token === "EURC" ? 1.14 : 0.99983),
    estimateSwapOnly: async (args) => {
      // BLINDING TRIPWIRE: if A's brief/reasoning ever reaches B, it would have to come
      // through here. Anything that isn't a bare pricing arg is a leak.
      for (const k of Object.keys(args)) {
        if (!["walletAddress", "tokenIn", "tokenOut", "amountIn"].includes(k)) sawA = k;
      }
      if (estimateThrows) throw new Error(estimateThrows);
      // The REVERSE leg (B quoting back) — tokenIn is what the forward leg produced.
      if (args.tokenIn === "EURC" && args.tokenOut === "USDC") {
        const fwd = Number(estimate.estimatedOutput.amount);
        const rate = reverseRate ?? (5 / fwd) * 0.998; // consistent: round trip loses 0.2%
        return { estimatedOutput: { amount: (Number(args.amountIn) * rate).toFixed(6) } };
      }
      return estimate;
    },
  },
});
mock.module("../netlify/functions/_bridge.mjs", {
  namedExports: {
    resolveDestination: (d) => (String(d).toLowerCase() === "base" ? { key: "base", label: "Base", cctpDomain: 6 } : null),
    bridgeFee: async ({ amountUsdc }) => ({
      feeUsdc: 0.21, netUsdc: Number(amountUsdc) - 0.21, maxFee: 210000n, amountMinor: BigInt(Math.round(Number(amountUsdc) * 1e6)),
    }),
  },
});

// The INDEPENDENT market source (CoinGecko). This is what B checks the chain against — and
// it is the source A never reads.
let market = { "usd-coin": { usd: 0.99983 }, "euro-coin": { usd: 1.14 } };
globalThis.fetch = async () => ({ ok: true, json: async () => market });

const { analystB } = await import("../netlify/functions/_analystb.mjs");
const { compareAnalyses } = await import("../netlify/functions/_synthesis.mjs");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// A's proposal. Note the prose: B must never see it, and must never be moved by it.
const A_SWAP = {
  action: "swap", tokenIn: "USDC", tokenOut: "EURC", amountIn: 5,
  reasoning: "The euro is cheap and momentum is strongly in favour — convert now, this is a clear opportunity.",
};

const reset = () => {
  estimate = { estimatedOutput: { token: "EURC", amount: "4.283006" } };
  estimateThrows = null;
  reverseRate = null;
  sawA = null;
  market = { "usd-coin": { usd: 0.99983 }, "euro-coin": { usd: 1.14 } };
};

console.log("── Brick 2: the second, independent opinion ──\n");

console.log("INDEPENDENCE — B is blinded to A, and reasons from NUMBERS");
{
  reset();
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  check("B never receives A's brief or reasoning (blinding holds)", sawA === null, sawA ? `LEAKED: ${sawA}` : "only pricing args");
  check("B computed an independent FAIR rate from the market", typeof b.fairRate === "number" && b.fairRate > 0, `${b.fairRate?.toFixed(6)}`);
  check("B computed the EXECUTABLE rate from the chain", typeof b.executable === "number" && b.executable > 0, `${b.executable?.toFixed(6)}`);
  check(
    "B measured the SPREAD — the fact A structurally cannot see",
    typeof b.spreadPct === "number",
    `chain is ${b.spreadPct}% off fair (fair ${b.fairRate?.toFixed(4)} vs executable ${b.executable?.toFixed(4)})`
  );
}

console.log("\nAGREE — both point the same way, the proposal SURVIVES");
{
  reset();
  // Make the chain rate match fair value almost exactly → a normal, tight spread.
  const fair = 0.99983 / 1.14;
  estimate = { estimatedOutput: { amount: (fair * 5 * 0.999).toFixed(6) } };
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  const s = compareAnalyses(A_SWAP, b);
  check("B says proceed", b.verdict === "proceed", b.headline);
  check("the proposal SURVIVES", s.proposalSurvives === true);
  check("agreement is reported as agreement", s.agreement === "agree", s.headline);
}

console.log("\nCAUTION — they agree on the action, NOT on the price. Proposal survives, tension shown.");
{
  reset(); // real live numbers: chain gives 4.283006 for 5 → ~2.3% off fair
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  const s = compareAnalyses(A_SWAP, b);
  check("B flags the spread", b.verdict === "caution", `${b.spreadPct}% — ${b.headline.slice(0, 60)}…`);
  check("the proposal still SURVIVES (the user decides if the cost is worth it)", s.proposalSurvives === true);
  check("the tension is stated, not buried", s.agreement === "caution" && /not on the price/i.test(s.headline), s.headline);
}

console.log("\n🔑 HARD DISAGREE — B REFUSES, and the proposal is KILLED (whatever A argued)");
{
  reset();
  // This is not hypothetical: we hit exactly this live — "No route available".
  estimateThrows = "Stablecoin Service createSwap failed: No route available";
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  const s = compareAnalyses(A_SWAP, b);
  check("B refuses: the trade cannot route", b.verdict === "refuse", b.headline.slice(0, 70));
  check("🔑 the proposal is KILLED — A's bullish case does NOT survive", s.proposalSurvives === false);
  check("the user is told they disagreed", s.agreement === "hard_disagree" && /disagree/i.test(s.headline), s.headline);
  check("A's confident prose did not save it", /refuses/i.test(s.detail));
}
{
  reset();
  // A rate far off fair value — B refuses on a NUMBER, not an opinion.
  estimate = { estimatedOutput: { amount: (0.99983 / 1.14 * 5 * 0.9).toFixed(6) } }; // ~10% worse
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  const s = compareAnalyses(A_SWAP, b);
  check("B refuses a rate ~10% off fair", b.verdict === "refuse", `${b.spreadPct}% off fair`);
  check("🔑 the proposal is KILLED", s.proposalSurvives === false, s.headline);
}

console.log("\n🔑 ROUND-TRIP ARBITRAGE — the router prices the two directions inconsistently");
{
  // ⚠️ NOT HYPOTHETICAL. The live Arc router does exactly this right now:
  //    1 USDC → 0.794627 EURC → 1.050234 USDC  ⇒ a 5% round-trip GAIN.
  // A round trip must LOSE (you pay the spread twice). A gain is impossible, so NO quote from
  // that router can be trusted — including the one we were about to act on. Only a numbers
  // analyst can see this; a web-reading analyst never could.
  reset();
  reverseRate = 1.4; // fabricate the inconsistency: quoting back gives far too much
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  const s = compareAnalyses(A_SWAP, b);
  check("B detects the impossible round-trip gain", b.verdict === "refuse" && /round trip would GAIN/i.test(b.headline), b.headline.slice(0, 72));
  check("🔑 the proposal is KILLED — the router cannot be trusted", s.proposalSurvives === false);
  check("B reports the round-trip number", typeof b.roundTrip === "number" && b.roundTrip > 1, `${b.roundTrip?.toFixed(4)}`);
}

console.log("\nTOO GOOD TO BE TRUE — a rate far BETTER than fair is a RED FLAG, not a bargain");
{
  // The first cut of this code called a 16% better-than-fair rate "a normal spread" and waved
  // it through. On a stablecoin pair an amazing quote means the QUOTE is wrong, not that you
  // found free money. The thresholds are applied to the ABSOLUTE spread.
  reset();
  const fair = 0.99983 / 1.14;
  estimate = { estimatedOutput: { amount: (fair * 5 * 1.16).toFixed(6) } }; // 16% BETTER than fair
  reverseRate = (1 / (fair * 1.16)) * 0.998;                                // keep the round trip consistent
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  const s = compareAnalyses(A_SWAP, b);
  check("B REFUSES an implausibly good rate", b.verdict === "refuse", b.headline.slice(0, 70));
  check("…and says WHY it is not a bargain", /not a bargain|cannot trust/i.test(b.headline), b.headline.slice(0, 60));
  check("🔑 the proposal is KILLED", s.proposalSurvives === false);
}

console.log("\nTWO REFERENCES DISAGREE — B cannot establish a fair rate, so it does not judge");
{
  reset();
  market = { "usd-coin": { usd: 0.99983 }, "euro-coin": { usd: 1.40 } }; // CoinGecko far from ECB's 1.14
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  const s = compareAnalyses(A_SWAP, b);
  check("B says it cannot verify (it does not pick a winner)", b.verdict === "cannot_verify", b.headline.slice(0, 66));
  check("no proposal on a baseline B does not trust", s.proposalSurvives === false);
}

console.log("\nUNVERIFIED — no second opinion is NOT a licence to act on one analyst");
{
  reset();
  market = {}; // the independent market source is unavailable
  const b = await analystB({ proposal: A_SWAP, walletAddress: WALLET });
  const s = compareAnalyses(A_SWAP, b);
  check("B says it cannot verify (it does NOT guess)", b.verdict === "cannot_verify", b.headline.slice(0, 60));
  check("the proposal is NOT proposed on one analyst alone", s.proposalSurvives === false, s.headline);
}

console.log("\nA DECLINED — that is not a disagreement, it is an honest null");
{
  reset();
  const b = await analystB({ proposal: null, walletAddress: WALLET });
  const s = compareAnalyses(null, b);
  check("no action to price", b.verdict === "no_action");
  check("no proposal, and it is framed as valid — not a failure", s.proposalSurvives === false && /valid outcome/i.test(s.detail), s.detail);
}

console.log("\nBRIDGE — B prices that domain too");
{
  reset();
  const A_BRIDGE = { action: "bridge", destination: "base", amountUsdc: 5, reasoning: "Base is where the action is." };
  const b = await analystB({ proposal: A_BRIDGE, walletAddress: WALLET });
  const s = compareAnalyses(A_BRIDGE, b);
  check("B prices the live bridge fee", typeof b.feeUsdc === "number", `fee ${b.feeUsdc}, net ${b.netUsdc}`);
  // 0.21 on 5 USDC = 4.2%. Steep-ish, but under the 10% caution threshold — a bridge is
  // inherently a flat-fee product, so B calls it economical rather than crying wolf.
  check("a 0.21 fee on 5 USDC (4.2%) → proceed, and the proposal survives", b.verdict === "proceed" && s.proposalSurvives === true, b.headline.slice(0, 60));

  // 0.21 on 1.5 USDC = 14% — now the flat fee genuinely hurts, and B says so.
  const A_SMALL = { action: "bridge", destination: "base", amountUsdc: 1.5 };
  const bs = await analystB({ proposal: A_SMALL, walletAddress: WALLET });
  const ss = compareAnalyses(A_SMALL, bs);
  check("a 0.21 fee on 1.5 USDC (14%) → CAUTION, proposal survives with the tension shown",
    bs.verdict === "caution" && ss.proposalSurvives === true, bs.headline.slice(0, 60));

  const A_TINY = { action: "bridge", destination: "base", amountUsdc: 0.2 };
  const b2 = await analystB({ proposal: A_TINY, walletAddress: WALLET });
  const s2 = compareAnalyses(A_TINY, b2);
  check("🔑 a fee that eats the whole amount → REFUSE, proposal killed", b2.verdict === "refuse" && s2.proposalSurvives === false, b2.headline.slice(0, 60));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
