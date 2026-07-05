// DIRECT-CONTRACT BRIDGE — the SCA-native path that sidesteps App Kit's broken
// orchestration. Arc Testnet -> Ethereum Sepolia, FROM the agent SCA.
//
// WHY this exists: `kit.bridge()` aborts on the Circle-SCA async-submission race
// (code 1098 "Transaction hash is required" on the approve step → FATAL → never
// reaches the burn). See scripts/spike-bridge.mjs + the memory note. This script
// does the SAME on-chain calls, but drives them through Circle's dev-controlled
// `createContractExecutionTransaction` + `waitForTx` — the exact plumbing that
// reliably moves funds for agent-send / prediction bets. That path submits, polls
// the Circle tx by id, and returns the REAL hash, so the 1098 race can't happen.
//
// The bridge call itself is byte-identical to what App Kit would send:
//   1. approve  USDC -> BridgingKitContract   (only if allowance < amount)
//   2. bridgeWithPreapprovalAndHook(BridgeParams, hookData)  on 0xC5567...
// with forwarding hookData so Circle's Orbit relayer mints on Sepolia (no
// destination signature). Fees (maxFee) are fetched live from Circle's IRIS API
// exactly as the SDK computes them.
//
// GUARDRAIL: default amount 1 USDC; refuses to execute when the forwarder fee
// ≥ amount. Raise via SPIKE_AMOUNT for a deliberate larger test. The user runs it.
//
// Run:
//   node scripts/bridge-direct.mjs                     # dry run: fees + calldata, no funds move
//   SPIKE_AMOUNT=15 node scripts/bridge-direct.mjs --execute   # fire the real bridge
//
// Requires in .env: CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, AGENT_WALLET_ADDRESS
// Optional: SPIKE_FROM (source SCA), SPIKE_TO (Sepolia recipient; default = source)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeFunctionData, pad, getAddress, createPublicClient, http, formatUnits } from "viem";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- config (mirrors the Arc/Sepolia chain defs inside @circle-fin/app-kit) ---
const ARC = {
  blockchain: "ARC-TESTNET",
  rpc: "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  cctpDomain: 26,
  usdc: "0x3600000000000000000000000000000000000000",
};
const SEPOLIA = { cctpDomain: 0 };
const BRIDGE = "0xC5567a5E3370d4DBfB0540025078e283e36A363d"; // BridgingKitContract (Arc testnet)
const IRIS = "https://iris-api-sandbox.circle.com"; // testnet IRIS
const FAST_FINALITY = 1000; // FAST tier
const ZERO_HASH = "0x" + "00".repeat(32);
// CCTP forwarding hookData: ASCII "cctp-forward" (24-byte section) + version=0 + length=0.
// Fixed constant — see buildForwardingHookData in @circle-fin/app-kit.
const FORWARD_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";
const USDC_DECIMALS = 6;

// BridgeParams struct + the exact bridge method, extracted from @circle-fin/adapter-viem-v2.
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
const USDC_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
];

function loadEnv() {
  try {
    const raw = readFileSync(join(HERE, "..", ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch {}
}

async function irisJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`IRIS ${r.status} for ${url}`);
  return r.json();
}

// maxFee = providerFee (CCTP fast-burn) + forwarderFee, computed exactly as the SDK does.
async function computeMaxFee(amountMinor) {
  const burn = await irisJson(`${IRIS}/v2/burn/USDC/fees/${ARC.cctpDomain}/${SEPOLIA.cctpDomain}`);
  const fwd = await irisJson(`${IRIS}/v2/burn/USDC/fees/${ARC.cctpDomain}/${SEPOLIA.cctpDomain}?forward=true`);
  const burnTier = burn.find((t) => t.finalityThreshold === FAST_FINALITY);
  const fwdTier = fwd.find((t) => t.finalityThreshold === FAST_FINALITY);
  if (!burnTier || !fwdTier) throw new Error("no FAST fee tier from IRIS");
  // providerFee: scaledBps = round(minimumFee * 100); baseFee = ceil(scaledBps*amount/1e6); +10% buffer
  const scaledBps = BigInt(Math.round(Number(burnTier.minimumFee) * 100));
  const baseFee = (scaledBps * amountMinor + 999_999n) / 1_000_000n;
  const providerFee = baseFee + baseFee / 10n;
  // forwarderFee: the "high" tier, already in minor units
  const forwarderFee = BigInt(fwdTier.forwardFee.high);
  return { providerFee, forwarderFee, maxFee: providerFee + forwarderFee };
}

async function main() {
  loadEnv();
  const execute = process.argv.includes("--execute");
  const amountHuman = process.env.SPIKE_AMOUNT || "1";
  const amountMinor = BigInt(Math.round(Number(amountHuman) * 10 ** USDC_DECIMALS));

  const from = getAddress(process.env.SPIKE_FROM || process.env.AGENT_WALLET_ADDRESS || "");
  const to = getAddress(process.env.SPIKE_TO || from);
  if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) throw new Error("Missing CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET in .env");

  const pub = createPublicClient({ transport: http(ARC.rpc) });

  console.log("DIRECT bridge: Arc -> Ethereum Sepolia from the agent SCA");
  console.log("  from (Arc SCA):      ", from);
  console.log("  to   (Sepolia recip):", to);
  console.log(`  amount:               ${amountHuman} USDC`);
  console.log("  BridgingKitContract:  ", BRIDGE);
  console.log("  method:               bridgeWithPreapprovalAndHook (via Circle createContractExecutionTransaction)\n");

  // Fees (live).
  const { providerFee, forwarderFee, maxFee } = await computeMaxFee(amountMinor);
  console.log(`Fees (live IRIS): providerFee=${formatUnits(providerFee, 6)} forwarderFee=${formatUnits(forwarderFee, 6)} → maxFee=${formatUnits(maxFee, 6)} USDC`);

  // Build BridgeParams + calldata (byte-identical to App Kit's custom-burn path).
  const bridgeParams = {
    amount: amountMinor,
    maxFee,
    fee: 0n, // protocolFee
    mintRecipient: pad(to, { size: 32 }),
    destinationCaller: ZERO_HASH, // any caller may claim (relayer)
    burnToken: ARC.usdc,
    feeRecipient: BRIDGE, // default (no custom fee)
    destinationDomain: SEPOLIA.cctpDomain,
    minFinalityThreshold: FAST_FINALITY,
  };
  const callData = encodeFunctionData({ abi: BRIDGE_ABI, functionName: "bridgeWithPreapprovalAndHook", args: [bridgeParams, FORWARD_HOOK] });
  console.log("\nbridgeParams:", JSON.stringify(bridgeParams, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log("calldata:", callData.slice(0, 74) + "…", `(${(callData.length - 2) / 2} bytes)`);

  // Preflight state.
  const [bal, allowance] = await Promise.all([
    pub.readContract({ address: ARC.usdc, abi: USDC_ABI, functionName: "balanceOf", args: [from] }),
    pub.readContract({ address: ARC.usdc, abi: USDC_ABI, functionName: "allowance", args: [from, BRIDGE] }),
  ]);
  console.log(`\nOn-chain: balance=${formatUnits(bal, 6)} USDC, allowance→bridge=${formatUnits(allowance, 6)} USDC`);

  const feeExceedsAmount = maxFee >= amountMinor;
  if (feeExceedsAmount) {
    console.log(`\n⚠  maxFee (${formatUnits(maxFee, 6)}) ≥ amount (${amountHuman}) — bridge cannot settle (fee taken from amount). Raise SPIKE_AMOUNT.`);
  }
  if (bal < amountMinor) console.log(`\n⚠  Insufficient balance: have ${formatUnits(bal, 6)}, need ${amountHuman}.`);

  if (!execute) {
    console.log("\nDry run only. Re-run with --execute to fire the bridge.");
    return;
  }
  if (feeExceedsAmount) { console.log("\nRefusing to --execute: fee ≥ amount."); return; }
  if (bal < amountMinor) { console.log("\nRefusing to --execute: insufficient balance."); return; }

  // --- EXECUTE via Circle dev-controlled client (reliable async submit + poll) ---
  const { circle, waitForTx } = await import("../netlify/functions/_circle.mjs");
  const client = circle();

  // 1) Ensure allowance ≥ amount (on-chain approve — the SCA-safe path, no permit).
  if (allowance < amountMinor) {
    console.log("\nApproving USDC → bridge (allowance below amount)…");
    const apTx = await client.createContractExecutionTransaction({
      walletAddress: from,
      blockchain: ARC.blockchain,
      contractAddress: ARC.usdc,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [BRIDGE, amountMinor.toString()],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const apHash = await waitForTx(client, apTx.data?.id);
    console.log("  approve tx:", `${ARC.explorer}/tx/${apHash}`);
  } else {
    console.log("\nAllowance already sufficient — skipping approve.");
  }

  // 2) The bridge call itself.
  console.log("\nSubmitting bridgeWithPreapprovalAndHook…");
  const brTx = await client.createContractExecutionTransaction({
    walletAddress: from,
    blockchain: ARC.blockchain,
    contractAddress: BRIDGE,
    callData,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  const burnHash = await waitForTx(client, brTx.data?.id);
  console.log("  ✅ Arc burn tx:", `${ARC.explorer}/tx/${burnHash}`);

  // 3) Poll IRIS for the forwarder mint on Sepolia (relayer completes it).
  console.log("\nWaiting for Circle's Orbit relayer to mint on Sepolia (polling IRIS)…");
  const msgUrl = `${IRIS}/v2/messages/${ARC.cctpDomain}?transactionHash=${burnHash}`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    let data;
    try { data = await irisJson(msgUrl); } catch { continue; }
    const m = data?.messages?.[0];
    const state = m?.forwardState || m?.status;
    if (i % 3 === 0) console.log(`  …forwardState=${m?.forwardState ?? "?"} status=${m?.status ?? "?"}`);
    if (m?.forwardTxHash && (m?.forwardState === "CONFIRMED" || m?.status === "complete")) {
      console.log("  ✅ Sepolia mint tx:", `https://sepolia.etherscan.io/tx/${m.forwardTxHash}`);
      console.log("\nDONE — end-to-end bridge complete.");
      return;
    }
  }
  console.log("\nBurn landed on Arc; relayer mint not yet confirmed within the poll window.");
  console.log("Check:", msgUrl);
}

main().catch((e) => { console.error("\nFAILED:", e?.message || e); if (e?.stack) console.error(e.stack); process.exit(1); });
