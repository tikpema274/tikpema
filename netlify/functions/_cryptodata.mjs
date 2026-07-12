// _cryptodata.mjs — crypto-analysis FIRST CUT: pure on-chain decoders + a free
// market-data fetch. NO money logic lives here (the x402 pay path stays in
// _research/_x402). These are pure transforms + one free public GET. Every decoder
// DROPS an undecodable result (returns []) — a raw 0x… or a wrong-decimals number
// must NEVER become a claim. DEFERRED (not this cut): eth_call / contract reads / ABI.

import { formatUnits } from "viem";

// On-chain methods this cut supports (cleanly decodable; NO eth_call / contract reads).
export const ALLOWED_ONCHAIN_METHODS = new Set([
  "eth_getBalance",
  "eth_gasPrice",
  "eth_blockNumber",
]);

// CoinGecko id allowlist (cut 1 — do NOT trust arbitrary classifier-generated ids).
export const MARKET_ID_ALLOWLIST = new Set([
  "bitcoin", "ethereum", "usd-coin", "tether", "solana", "binancecoin",
  "ripple", "cardano", "dogecoin", "avalanche-2", "polygon-ecosystem-token",
  // EURC. Added for Brick 2's Analyst B: it needs a EURC price from a source that is
  // INDEPENDENT of the swap router it is checking, otherwise its "is this rate fair?" verdict
  // would be circular. CoinGecko is free and keyless, so this costs nothing.
  "euro-coin",
]);

// Arc native (gas) balance decimals for eth_getBalance.
// ARC GOTCHA: Arc's native/gas balance (eth_getBalance) is 18-DECIMAL — even though
// USDC the ERC-20 token (0x3600…0000) is 6-decimal. Both represent the SAME USDC value
// at different scales: eth_getBalance ÷1e18 == USDC balanceOf ÷1e6. Decode the native
// balance with 18, NOT 6 (÷1e6 would print a value 1e12× too large — a FALSE number).
// CROSS-CHECK 2026-07-08 (verified against live Arc Testnet, address 0xc54d…e621):
//   eth_getBalance ÷1e18 = 43.75  ==  USDC balanceOf ÷1e6 = 43.75  (= Arcscan USDC balance) → MATCH.
//   (Also 0x6db3…b380: 0.09 == 0.09.) The earlier "6 decimals" premise was DISPROVEN.
// DECIMALS_VERIFIED flipped to true ONLY after this match; the decoder now emits.
export const NATIVE_DECIMALS = 18;
export const DECIMALS_VERIFIED = true;

const RPC_SOURCE = "Arc Testnet RPC (QuickNode)";

// Parse a hex quantity to BigInt, or null if missing / not a clean 0x-hex string.
export function hexToBigInt(x) {
  if (typeof x !== "string" || !/^0x[0-9a-fA-F]+$/.test(x)) return null;
  return BigInt(x);
}

// Build a validated JSON-RPC body for an allowed method, or null (→ caller DROPS,
// before any payment). eth_getBalance is refused unless DECIMALS_VERIFIED, so we
// never pay for a balance we cannot safely decode.
export function buildRpcBody(method, params) {
  if (!ALLOWED_ONCHAIN_METHODS.has(method)) return null;
  const p = Array.isArray(params) ? params : [];
  if (method === "eth_getBalance") {
    if (!DECIMALS_VERIFIED) return null; // don't PAY for an undecodable balance
    const addr = String(p[0] || "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
    return { jsonrpc: "2.0", id: 1, method, params: [addr, "latest"] };
  }
  return { jsonrpc: "2.0", id: 1, method, params: [] }; // gasPrice / blockNumber
}

// Decode a seller's JSON-RPC response into [{ claim, source }] — or [] if undecodable.
export function decodeRpc(method, sellerBody, params, asOf) {
  const result = sellerBody?.result;
  const stamp = asOf || "now";

  if (method === "eth_blockNumber") {
    const n = hexToBigInt(result);
    if (n === null) return [];
    return [{ claim: `Arc Testnet block height: ${n.toString()} (as of ${stamp})`, source: RPC_SOURCE }];
  }

  if (method === "eth_gasPrice") {
    const wei = hexToBigInt(result);
    if (wei === null) return [];
    return [{ claim: `Arc Testnet gas price: ${formatUnits(wei, 9)} gwei (as of ${stamp})`, source: RPC_SOURCE }];
  }

  if (method === "eth_getBalance") {
    const wei = hexToBigInt(result);
    if (wei === null || !DECIMALS_VERIFIED) return []; // never emit on a disproven premise
    const addr = Array.isArray(params) ? String(params[0] || "") : "";
    const human = formatUnits(wei, NATIVE_DECIMALS);
    return [{ claim: `Balance of ${addr} on Arc Testnet: ${human} USDC (as of ${stamp})`, source: RPC_SOURCE }];
  }

  return [];
}

// Free market data via CoinGecko keyless public API — no key, no wallet, no pay/gate.
// params: { ids: "bitcoin,ethereum" } (or an array). Ids outside the allowlist are
// dropped. Any failure → [] (caller degrades to Exa-only).
export async function fetchMarketData(params) {
  try {
    const raw = params?.ids ?? params;
    const requested = (Array.isArray(raw) ? raw : String(raw || "").split(","))
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean);
    const ids = [...new Set(requested)].filter((id) => MARKET_ID_ALLOWLIST.has(id));
    if (!ids.length) return [];

    const url =
      `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}` +
      `&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true&include_last_updated_at=true`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return [];
    const data = await r.json();

    const facts = [];
    for (const id of ids) {
      const d = data?.[id];
      if (!d || typeof d.usd !== "number") continue; // missing → drop
      const asOf = d.last_updated_at ? new Date(d.last_updated_at * 1000).toISOString() : "now";
      const parts = [`price: $${d.usd}`];
      if (typeof d.usd_market_cap === "number") parts.push(`market cap: $${Math.round(d.usd_market_cap)}`);
      if (typeof d.usd_24h_vol === "number") parts.push(`24h volume: $${Math.round(d.usd_24h_vol)}`);
      facts.push({ claim: `${id} — ${parts.join(" · ")} (as of ${asOf})`, source: "CoinGecko (api.coingecko.com)" });
    }
    return facts;
  } catch {
    return [];
  }
}
