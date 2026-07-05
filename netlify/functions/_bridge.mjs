// BRIDGE PLANE — cross-chain USDC out of Arc via CCTP + Circle's forwarder.
//
// This is the PRODUCTIZED version of scripts/bridge-direct.mjs (proven live:
// Arc burn 0xaf6f5ba2… → Sepolia mint 0xa9fea2c8…). It drives the bridge through
// Circle's dev-controlled `createContractExecutionTransaction` + `waitForTx`
// (the same battle-tested path as send/swap), NOT App Kit's `kit.bridge()` — that
// path aborts on the Circle-SCA async-hash race (see the memory note / spike).
//
// Flow (single Arc-side signature; destination mint is done by Circle's relayer):
//   1. approve  USDC → BridgingKitContract   (only if allowance < amount)
//   2. bridgeWithPreapprovalAndHook(BridgeParams, cctp-forward hookData)
// The Orbit relayer then fetches the attestation and mints on the destination —
// no destination-chain signature. The fee (fetched live from IRIS) is taken OUT
// OF the bridged amount, so the recipient nets amount − fee.
//
// The fee is VOLATILE (destination gas priced in USDC): ~0.2 USDC to an L2,
// ~1.5–14 USDC to Ethereum L1. Callers MUST refuse a bridge where fee ≥ amount.

import { encodeFunctionData, pad, getAddress } from "viem";
import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { publicClient } from "./_predict.mjs";

const BRIDGE_CONTRACT = "0xC5567a5E3370d4DBfB0540025078e283e36A363d"; // BridgingKitContract (Arc testnet)
const IRIS = "https://iris-api-sandbox.circle.com"; // testnet IRIS
const ARC_CCTP_DOMAIN = 26;
const FAST_FINALITY = 1000; // FAST tier
const ZERO_HASH = "0x" + "00".repeat(32);
// CCTP forwarding hookData: ASCII "cctp-forward" + version=0 + length=0 (fixed
// constant — see buildForwardingHookData in @circle-fin/app-kit).
const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";

// Supported forwarded-bridge destinations (Arc → these testnets). CCTP domains
// verified against @circle-fin/app-kit chain defs; each confirmed to have a live
// IRIS forwarding tier from Arc. Natural-language aliases feed the parser. The
// fee fetch is the ultimate gate: if IRIS has no forwarding tier for a domain at
// call time, the bridge is refused — so this list can't over-promise.
export const BRIDGE_DESTINATIONS = {
  ethereum: { label: "Ethereum (Sepolia)", cctpDomain: 0, explorerTx: "https://sepolia.etherscan.io/tx/", aliases: ["ethereum", "eth", "sepolia", "ethereum sepolia", "l1", "mainnet"] },
  base: { label: "Base (Sepolia)", cctpDomain: 6, explorerTx: "https://sepolia.basescan.org/tx/", aliases: ["base", "base sepolia"] },
  arbitrum: { label: "Arbitrum (Sepolia)", cctpDomain: 3, explorerTx: "https://sepolia.arbiscan.io/tx/", aliases: ["arbitrum", "arb", "arbitrum sepolia"] },
  optimism: { label: "Optimism (Sepolia)", cctpDomain: 2, explorerTx: "https://sepolia-optimism.etherscan.io/tx/", aliases: ["optimism", "op", "optimism sepolia"] },
  avalanche: { label: "Avalanche (Fuji)", cctpDomain: 1, explorerTx: "https://testnet.snowtrace.io/tx/", aliases: ["avalanche", "avax", "fuji"] },
  polygon: { label: "Polygon (Amoy)", cctpDomain: 7, explorerTx: "https://amoy.polygonscan.com/tx/", aliases: ["polygon", "matic", "amoy", "polygon amoy"] },
  unichain: { label: "Unichain (Sepolia)", cctpDomain: 10, explorerTx: "https://sepolia.uniscan.xyz/tx/", aliases: ["unichain"] },
  linea: { label: "Linea (Sepolia)", cctpDomain: 11, explorerTx: "https://sepolia.lineascan.build/tx/", aliases: ["linea", "linea sepolia"] },
};

// Resolve a natural-language destination name to a supported destination, or null.
export function resolveDestination(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!n) return null;
  for (const [key, d] of Object.entries(BRIDGE_DESTINATIONS)) {
    if (key === n || d.aliases.includes(n)) return { key, ...d };
  }
  // Loose contains-match so "to ethereum sepolia network" still resolves.
  for (const [key, d] of Object.entries(BRIDGE_DESTINATIONS)) {
    if (d.aliases.some((a) => n.includes(a))) return { key, ...d };
  }
  return null;
}

export const SUPPORTED_DESTINATION_LABELS = Object.values(BRIDGE_DESTINATIONS).map((d) => d.label);

const BRIDGE_ABI = [
  {
    type: "function",
    name: "bridgeWithPreapprovalAndHook",
    stateMutability: "nonpayable",
    outputs: [],
    inputs: [
      {
        name: "bridgeParams",
        type: "tuple",
        components: [
          { name: "amount", type: "uint256" },
          { name: "maxFee", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "mintRecipient", type: "bytes32" },
          { name: "destinationCaller", type: "bytes32" },
          { name: "burnToken", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "destinationDomain", type: "uint32" },
          { name: "minFinalityThreshold", type: "uint32" },
        ],
      },
      { name: "hookData", type: "bytes" },
    ],
  },
];

const ALLOWANCE_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
];

const toMinor = (usdc) => BigInt(Math.round(Number(usdc) * 10 ** USDC_DECIMALS));
const toUsdc = (minor) => Number(minor) / 10 ** USDC_DECIMALS;

async function irisJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IRIS ${r.status}`);
  return r.json();
}

// Live bridge fee for an amount to a destination domain, computed exactly as the
// SDK does: providerFee (CCTP fast-burn, ~0 on testnet) + forwarderFee (the
// relayer's destination-gas charge). maxFee is in USDC minor units. Throws if the
// destination has no forwarding tier (route not bridgeable right now).
export async function bridgeFee({ amountUsdc, cctpDomain }) {
  const amountMinor = toMinor(amountUsdc);
  const [burn, fwd] = await Promise.all([
    irisJson(`${IRIS}/v2/burn/USDC/fees/${ARC_CCTP_DOMAIN}/${cctpDomain}`),
    irisJson(`${IRIS}/v2/burn/USDC/fees/${ARC_CCTP_DOMAIN}/${cctpDomain}?forward=true`),
  ]);
  const burnTier = burn.find((t) => t.finalityThreshold === FAST_FINALITY);
  const fwdTier = fwd.find((t) => t.finalityThreshold === FAST_FINALITY);
  if (!fwdTier?.forwardFee) throw new Error("destination is not available for forwarded bridging right now");
  const scaledBps = BigInt(Math.round(Number(burnTier?.minimumFee ?? 0) * 100));
  const baseFee = (scaledBps * amountMinor + 999_999n) / 1_000_000n;
  const providerFee = baseFee + baseFee / 10n; // +10% buffer (matches SDK)
  const forwarderFee = BigInt(fwdTier.forwardFee.high);
  const maxFee = providerFee + forwarderFee;
  return {
    amountMinor,
    maxFee,
    feeUsdc: toUsdc(maxFee),
    netUsdc: toUsdc(amountMinor - maxFee),
    providerFeeUsdc: toUsdc(providerFee),
    forwarderFeeUsdc: toUsdc(forwarderFee),
  };
}

// Build the bridgeWithPreapprovalAndHook calldata (byte-identical to App Kit's
// custom-burn path).
function bridgeCallData({ amountMinor, maxFee, recipient, cctpDomain }) {
  const bridgeParams = {
    amount: amountMinor,
    maxFee,
    fee: 0n, // protocolFee
    mintRecipient: pad(getAddress(recipient), { size: 32 }),
    destinationCaller: ZERO_HASH, // any caller (the relayer) may claim
    burnToken: CONTRACTS.USDC,
    feeRecipient: BRIDGE_CONTRACT, // default (no custom fee)
    destinationDomain: cctpDomain,
    minFinalityThreshold: FAST_FINALITY,
  };
  return encodeFunctionData({ abi: BRIDGE_ABI, functionName: "bridgeWithPreapprovalAndHook", args: [bridgeParams, FORWARD_HOOK] });
}

// EXECUTOR — burn on Arc from the agent SCA. Returns after the Arc-side burn
// lands (waitForTx); the destination mint is async (poll bridgeMintStatus).
// Assumes the CALLER already enforced cap / fee-floor / day-ceiling (see
// _actions.executeAction — the one secure path). `recipient` defaults to the
// source wallet (bridge to self on the destination).
export async function agentBridge({ walletAddress, destination, amountUsdc, recipient }) {
  const dest = resolveDestination(destination);
  if (!dest) throw new Error(`unsupported destination "${destination}"`);
  const to = getAddress(recipient || walletAddress);

  const fee = await bridgeFee({ amountUsdc, cctpDomain: dest.cctpDomain });
  const callData = bridgeCallData({ amountMinor: fee.amountMinor, maxFee: fee.maxFee, recipient: to, cctpDomain: dest.cctpDomain });

  const client = circle();

  // 1) Ensure allowance ≥ amount (on-chain approve — SCA-safe, no permit).
  const allowance = await publicClient().readContract({
    address: CONTRACTS.USDC,
    abi: ALLOWANCE_ABI,
    functionName: "allowance",
    args: [getAddress(walletAddress), BRIDGE_CONTRACT],
  });
  if (allowance < fee.amountMinor) {
    const apTx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [BRIDGE_CONTRACT, fee.amountMinor.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    await waitForTx(client, apTx.data?.id);
  }

  // 2) The bridge call itself (Arc burn + forwarding hook).
  const brTx = await client.createContractExecutionTransaction({
    walletAddress,
    blockchain: ARC.blockchain,
    contractAddress: BRIDGE_CONTRACT,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const burnHash = await waitForTx(client, brTx.data?.id);

  return {
    burnHash,
    burnTx: `${ARC.explorer}/tx/${burnHash}`,
    feeUsdc: fee.feeUsdc,
    netUsdc: fee.netUsdc,
    destination: { key: dest.key, label: dest.label, cctpDomain: dest.cctpDomain },
    recipient: to,
  };
}

// Poll IRIS once for the forwarded mint on the destination. Returns the current
// stage so the UI can show "burn done → waiting → minted". `destExplorerTx` lets
// us build the destination tx link.
export async function bridgeMintStatus({ burnHash, destinationKey }) {
  const dest = BRIDGE_DESTINATIONS[destinationKey];
  const url = `${IRIS}/v2/messages/${ARC_CCTP_DOMAIN}?transactionHash=${burnHash}`;
  let data;
  try {
    data = await irisJson(url);
  } catch {
    return { state: "pending" };
  }
  const m = data?.messages?.[0];
  if (!m) return { state: "pending" };
  if (m.forwardState === "FAILED") return { state: "failed" };
  const confirmed = (m.forwardState === "CONFIRMED" || m.forwardState === "COMPLETE") && typeof m.forwardTxHash === "string" && m.forwardTxHash.length > 0;
  if (confirmed) {
    return {
      state: "minted",
      mintTxHash: m.forwardTxHash,
      mintTx: dest ? `${dest.explorerTx}${m.forwardTxHash}` : null,
    };
  }
  return { state: "pending", forwardState: m.forwardState ?? null };
}
