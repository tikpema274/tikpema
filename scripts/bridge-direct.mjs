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


// ═══ ⛔⛔ THE GUARD IS THIS MODULE'S FIRST EXECUTABLE STATEMENT ════════════════════════════════
// Per the PR-4 runner: `node -e "import('./…')"` EXECUTES a module, and on an earlier spike only a
// missing --env-file stopped a real approve — luck, not a safeguard. This file previously gated at
// line 124, AFTER fees were fetched from IRIS and calldata was built. Loading it did network work before anything asked whether it should.
//
// ⚠️ AND "FIRST STATEMENT" IS NOT THE WHOLE GUARANTEE, BECAUSE ESM IMPORTS HOIST. Every `import`
// below runs BEFORE this line regardless of where it sits in the text, so placing the guard at the
// top buys nothing on its own — the real property is that the imported graph performs no network
// work at load. That is not assumed: `verify-script-inert` instruments fetch AND node:http/https to
// THROW, imports this module bare, and asserts ZERO calls. If a dependency ever starts dialling at
// import time, that suite goes red rather than this comment quietly becoming false.
//
// ⛔ EXIT CODE 4, NEVER 0. A no-op that exits 0 reads as a completed run to any caller, script
// or CI step that checks only success — which is exactly how a "dry run" becomes indistinguishable
// from a bridge that moved money. The code is DISTINCT from the generic failure exit 1 so a refusal
// is not confused with a crash.
// ⭐ THREE STATES, THREE OUTCOMES — they were two, and one of them was a lie.
//   bare        inert. No network, exit 4.
//   --dry-run   fees + calldata, reads only, moves nothing, exit 0.
//   --send      the real burn.
const SEND = process.argv.includes("--send") || process.argv.includes("--execute");
const DRY = process.argv.includes("--dry-run");
if (!SEND && !DRY) {
  console.log(
    "\n⛔ INERT — nothing was sent and NO NETWORK CALL WAS MADE.\n" +
    "   bridge-direct MOVES REAL USDC and, when it does, writes a real receipt (origin: tool-signed).\n" +
    "   This run wrote nothing, read nothing, and moved nothing.\n" +
    "   --dry-run for fees and calldata (reads only). --send to actually fire it.\n"
  );
  process.exit(4);
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { encodeFunctionData, pad, getAddress, createPublicClient, http, formatUnits } from "viem";
import { BRIDGE_DESTINATIONS } from "../netlify/functions/_bridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- config (mirrors the Arc/Sepolia chain defs inside @circle-fin/app-kit) ---
const ARC = {
  blockchain: "ARC-TESTNET",
  rpc: "https://rpc.testnet.arc.network",
  explorer: "https://testnet.arcscan.app",
  cctpDomain: 26,
  usdc: "0x3600000000000000000000000000000000000000",
};
// ⭐ DERIVED, NOT A LITERAL. `0` was written here by hand, and 0 is also what an absence coerces
// to — so a hand-typed 0 and a missing value were indistinguishable at the point of use. It now
// reads the same registry the quote path and the receipt renderer read.
const SEPOLIA = { cctpDomain: BRIDGE_DESTINATIONS.ethereum.cctpDomain };
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
  // 🚨 THIS READ `process.argv.includes("--execute")` WHILE THE GUARD ABOVE ACCEPTED `--send`, SO
  // `--send` PASSED THE GUARD AND LEFT `execute` FALSE. The run fell to the dry-run branch, which
  // then printed "Re-run with --send" — an instruction whose only effect is the identical run. A
  // refusal that tells you to do exactly what you just did is worse than a silent one: it costs a
  // person their own trust in the tool before it costs them anything else. One flag, one meaning.
  const execute = SEND;
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
    console.log("\n— DRY RUN — fees and calldata above. Nothing was sent, nothing was written.");
    console.log("  Re-run with --send to fire the bridge.");
    return;   // exit 0: a dry run that did what it said IS a success.
  }

  // ⛔ WOULD A BURN FROM THIS SOURCE BE INVISIBLE? Asked BEFORE the money checks, because a burn
  // nobody can ever find is a worse outcome than one that fails for lack of balance.
  const { checkSpikeSource } = await import("../shared/spike-source-guard.mjs");
  const vis = checkSpikeSource({ from, acknowledged: process.argv.includes("--accept-invisible") });
  if (!vis.ok) { console.log(`\n⛔ REFUSING TO SEND — ${vis.detail}`); process.exit(5); }
  if (vis.detail) console.log(`\n${vis.detail}`);

  // ⭐⭐ PROVE THE RECORD CAN BE WRITTEN **BEFORE** THE MONEY MOVES. A post-burn write failure is
  // unrecoverable in the only way that matters — the burn already happened and the record is gone.
  // Checked here, the answer is simply "do not send". ⚠️ It READS; it never writes a probe row.
  const { assertStoreReachable } = await import("../shared/blobs-cli.mjs");
  const { getStore: _gs } = await import("@netlify/blobs");
  const reach = await assertStoreReachable(_gs, {});
  if (!reach.ok) {
    console.log(`\n⛔ REFUSING TO SEND — ${reach.detail}\n` +
      `   This tool writes a receipt for every burn it makes. If it cannot write one, it does not\n` +
      `   burn: money that moves without a record is the defect this guard exists to prevent.`);
    process.exit(6);
  }
  console.log(`\n✅ receipt store reachable (${reach.detail}) — a receipt can be written for this burn.`);
  // ⛔ A REFUSAL IS NOT A DRY RUN, AND THEY MUST NOT EXIT ALIKE. Both of these used to `return`,
  // i.e. exit 0 — indistinguishable to any caller from a completed dry run, and reached only after
  // the dry-run branch had already printed a false instruction. Each now reports ITSELF and carries
  // its own code, so "why did nothing happen" is answerable from the exit status alone.
  if (feeExceedsAmount) {
    console.log(
      `\n⛔ REFUSING TO SEND — the fee EXCEEDS the amount on this route.\n` +
      `   maxFee ${formatUnits(maxFee, 6)} USDC ≥ amount ${amountHuman} USDC, so the burn cannot settle:\n` +
      `   on the deducted path the fee comes OUT of the amount, leaving nothing to deliver.\n` +
      `   Nothing was attempted and no money moved.\n` +
      `   Fix it by raising the amount above the fee (SPIKE_AMOUNT=<n>), or by choosing a cheaper\n` +
      `   destination — Ethereum carries a forwarder fee two orders of magnitude above the L2s.`);
    process.exit(7);
  }
  if (bal < amountMinor) {
    console.log(
      `\n⛔ REFUSING TO SEND — insufficient balance.\n` +
      `   ${from} holds ${formatUnits(bal, 6)} USDC and this burn needs ${amountHuman}.\n` +
      `   Nothing was attempted and no money moved. Fund the wallet or lower SPIKE_AMOUNT.`);
    process.exit(8);
  }

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

  // ═══ ⭐⭐ THE RECEIPT — SAME WRITER, SAME FOUR GATES, NO SECOND PATH ════════════════════════════
  // This tool moves real USDC on the production path, so its burns belong in the record like any
  // other. It reuses `discoveredReceipt` and the discovery module's gates rather than growing a
  // second receipt writer — a parallel path is how two records of the same thing start disagreeing.
  // ⭐ origin is `tool-signed`, NOT `chain-discovered`: nothing discovered this: the process that
  // signed the burn witnessed it. See RECEIPT_ORIGIN for why the distinction is load-bearing.
  // ⚠️ A FAILED WRITE IS REPORTED LOUDLY AND NEVER SWALLOWED — the money has already moved, so the
  // only honest outcome is to say exactly which burn has no record and how to recover it.
  try {
    const { discoveredReceipt, isSettleable, RECEIPT_ORIGIN } = await import("../netlify/functions/_bridge-discover.mjs");
    const { receiptKey, isStranded } = await import("../netlify/functions/_bridge-receipts.mjs");

    const blk = await pub.getBlock({ blockNumber: (await pub.getTransactionReceipt({ hash: burnHash })).blockNumber });
    const r = discoveredReceipt({
      burnHash, owner: from.toLowerCase(), amountMinor: amountMinor.toString(),
      maxFeeMinor: maxFee.toString(), destinationDomain: SEPOLIA.cctpDomain,
      mintRecipient: to.toLowerCase(), blockNumber: (await pub.getTransactionReceipt({ hash: burnHash })).blockNumber,
      blockTimestamp: new Date(Number(blk.timestamp) * 1000).toISOString(),
    }, { origin: RECEIPT_ORIGIN.TOOL_SIGNED });
    const store = reach.store;   // ⭐ the SAME handle already proven readable above
    const key = receiptKey(r.owner, r.burnHash);
    // THE FOUR GATES, unchanged from the backfill path.
    if (!isSettleable(r)) throw new Error("receipt is not settleable (no usable burnedAt)");
    if (!isStranded(r) && r.state !== "burn_confirmed") throw new Error("receipt would not be reachable by the settler");
    if (await store.get(key, { type: "json" }).catch(() => null)) throw new Error("a receipt already exists at this key");
    if ("intentId" in r || "txId" in r) throw new Error("receipt claims an intent");
    await store.setJSON(key, r);
    console.log(`  ✅ receipt written  ${key}  (origin ${r.origin})`);
  } catch (e) {
    console.error(`\n🚨 THE BURN LANDED BUT NO RECEIPT WAS WRITTEN — ${e?.message || e}`);
    console.error(`   burnHash ${burnHash}  owner ${from}`);
    console.error(`   The money moved and this record is missing. Recover it with:`);
    console.error(`     node scripts/bridge-discover-run.mjs   (it will find this burn from chain)`);
  }

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
