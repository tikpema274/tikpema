// Shared read-side helpers for TikpemaPrediction on Arc Testnet.
//
// A viem public client + the minimal ABI both predict-* functions need, plus a
// single readMarket() that returns a normalized, JSON-safe snapshot. Kept apart
// from _circle.mjs (the SECRET write plane) — nothing here touches keys, signs,
// or submits a transaction. It only reads chain state over the public RPC.

import { createPublicClient, http, defineChain, formatUnits } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";

// Define the Arc chain from our own constants so this works regardless of the
// installed viem version (the built-in arcTestnet definition landed after the
// pinned viem here). For a read-only http client only id + rpc matter; native
// gas uses 18 decimals on Arc (ERC-20 USDC is 6 — see USDC_DECIMALS).
export const arcChain = defineChain({
  id: ARC.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
});

export function publicClient() {
  return createPublicClient({ chain: arcChain, transport: http(ARC.rpc) });
}

// Status enum order from the contract: OPEN, CLOSED, RESOLVED_YES, RESOLVED_NO, CANCELLED.
export const STATUS = ["OPEN", "CLOSED", "RESOLVED_YES", "RESOLVED_NO", "CANCELLED"];

// Only the reads we use. The placeBet/approve write signatures are passed
// directly to Circle in predict-bet.mjs (string ABI signatures), not from here.
export const PREDICTION_ABI = [
  {
    type: "function",
    name: "nextMarketId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    // Public mapping getter — returns the Market struct's value members in order.
    type: "function",
    name: "markets",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [
      { name: "question", type: "string" },
      { name: "category", type: "string" },
      { name: "resolutionSource", type: "string" },
      { name: "creator", type: "address" },
      { name: "bettingDeadline", type: "uint64" },
      { name: "resolutionTime", type: "uint64" },
      { name: "yesPool", type: "uint256" },
      { name: "noPool", type: "uint256" },
      { name: "creatorFeeBps", type: "uint16" },
      { name: "creatorFeesEarned", type: "uint256" },
      { name: "status", type: "uint8" },
      { name: "creatorClaimed", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getProbabilities",
    stateMutability: "view",
    inputs: [{ name: "marketId", type: "uint256" }],
    outputs: [
      { name: "yesProbBps", type: "uint256" },
      { name: "noProbBps", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quotePayout",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "isYes", type: "bool" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "potentialPayout", type: "uint256" },
      { name: "impliedOdds", type: "uint256" },
    ],
  },
];

const usdc = (v) => Number(formatUnits(v, USDC_DECIMALS));

// Read a market + current implied probabilities and return a JSON-safe snapshot.
// Returns null if the market does not exist (creator is the zero address).
export async function readMarket(client, marketId) {
  const id = BigInt(marketId);
  const address = CONTRACTS.TIKPEMA_PREDICTION;

  const [m, probs] = await Promise.all([
    client.readContract({ address, abi: PREDICTION_ABI, functionName: "markets", args: [id] }),
    client.readContract({ address, abi: PREDICTION_ABI, functionName: "getProbabilities", args: [id] }),
  ]);

  // viem returns multi-output getters as an array of values, in ABI order.
  const [
    question, category, resolutionSource, creator,
    bettingDeadline, resolutionTime, yesPool, noPool,
    creatorFeeBps, , statusIdx,
  ] = m;

  if (!creator || creator === "0x0000000000000000000000000000000000000000") {
    return null;
  }

  const statusNum = Number(statusIdx);
  const deadline = Number(bettingDeadline);

  return {
    marketId: Number(id),
    question,
    category,
    resolutionSource,
    creator,
    bettingDeadline: deadline,
    resolutionTime: Number(resolutionTime),
    status: STATUS[statusNum] ?? `UNKNOWN(${statusNum})`,
    statusCode: statusNum,
    creatorFeeBps: Number(creatorFeeBps),
    pools: {
      yesUsdc: usdc(yesPool),
      noUsdc: usdc(noPool),
      totalUsdc: usdc(yesPool + noPool),
    },
    probabilities: {
      yesPct: Number(probs[0]) / 100, // bps → percent
      noPct: Number(probs[1]) / 100,
    },
  };
}

// True iff a bet can currently be placed: market OPEN and before its deadline.
export function isBettable(snapshot, nowSeconds) {
  return snapshot.statusCode === 0 && nowSeconds < snapshot.bettingDeadline;
}

// Heuristic junk filter. A real market question reads as a sentence: at least
// two letter-bearing words. This drops empty/whitespace questions and the
// single-token keyboard-mashes early testing left on-chain (e.g.
// "gdshgjhjkjkjbfhbhbvc?"), without touching legitimate (if typo-ridden)
// questions like "will nroway win thw world cup?".
export function looksLikeRealQuestion(question) {
  const t = (question || "").trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  return words.length >= 2;
}

// Enumerate every market on-chain and return a cleaned list. nextMarketId() is
// the total count (ids are sequential from 0). We read each market, drop junk /
// placeholder questions, and de-duplicate by question text keeping the FIRST
// occurrence — while preserving each survivor's real on-chain id so the
// analyze / bet / resolve actions still target the right market.
export async function listMarkets(client) {
  const address = CONTRACTS.TIKPEMA_PREDICTION;
  const nextId = await client.readContract({
    address,
    abi: PREDICTION_ABI,
    functionName: "nextMarketId",
  });
  const count = Number(nextId);

  const ids = Array.from({ length: count }, (_, i) => i);
  const snapshots = await Promise.all(ids.map((id) => readMarket(client, id)));

  const seen = new Set();
  const markets = [];
  for (const m of snapshots) {
    if (!m) continue; // never created (zero-address creator)
    if (!looksLikeRealQuestion(m.question)) continue; // junk / placeholder
    const key = m.question.trim().toLowerCase();
    if (seen.has(key)) continue; // keep first occurrence of each question
    seen.add(key);
    markets.push(m);
  }
  return { count, markets };
}
