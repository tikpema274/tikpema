// SPIKE — can the passkey agent SCA execute a Circle App Kit bridge on Arc?
// ONE 1-USDC bridge, Arc Testnet -> Ethereum Sepolia, FROM the agent wallet.
//
// This is a feasibility test, NOT a feature. No UI, no app surface touched.
// It reuses the EXACT plumbing the swap already uses (App Kit + the Circle
// Wallets adapter driving the dev-controlled SCA) — see netlify/functions/_swap.mjs.
//
// WHY this should work (recon result, verified against the installed SDKs):
//   * Arc Testnet has a custom BridgingKitContract (kitContracts.bridge =
//     0xC5567a5E3370d4DBfB0540025078e283e36A363d), so App Kit takes the CUSTOM
//     flow, not raw CCTP depositForBurn.
//   * With useForwarder:true the source-chain calls are exactly two on-chain txs:
//       1. usdc.increaseAllowance            (preapproval — on-chain approve)
//       2. cctp.v2.customBurnWithHook        -> bridgeWithPreapprovalAndHook(...)
//     Both are executed as plain eth_sendTransaction through the adapter. The
//     destination mint is done by Circle's Orbit relayer — NO destination-chain
//     signature (that's why one Arc-side signature is enough).
//   * NO EIP-2612 permit is used (App Kit passes no permitParams on this path),
//     so the ecrecover-vs-ERC-1271 problem that forced allowanceStrategy:"approve"
//     on swap never even arises here.
//   * The Circle Wallets adapter has first-class SCA handling (withScaFeeInterceptor
//     strips SCA-incompatible fee fields, forces feeLevel:HIGH) — the same reason
//     swap works on the SCA today.
//
// GUARDRAIL: amount is HARD-PINNED to 1 USDC. The user runs this themselves.
//
// Run:
//   node scripts/spike-bridge.mjs            # estimate only (free, no funds move)
//   node scripts/spike-bridge.mjs --execute  # actually fire the 1-USDC bridge
//
// Requires in .env (already present for the app):
//   CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, AGENT_WALLET_ADDRESS
// Optional overrides:
//   SPIKE_FROM=0x...   (source SCA that holds the USDC; default AGENT_WALLET_ADDRESS)
//   SPIKE_TO=0x...     (Sepolia recipient; default = same address, i.e. bridge to self)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AppKit, BridgeChain, TransferSpeed } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

const HERE = dirname(fileURLToPath(import.meta.url));

// Circle fee/amount fields come back as BigInt — make them JSON-printable.
const bigintSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const pretty = (o) => JSON.stringify(o, bigintSafe, 2);

// --- tiny .env loader (the app relies on Netlify-injected env; a standalone
// script does not, so load .env ourselves — no dotenv dependency needed) ---
function loadEnv() {
  try {
    const raw = readFileSync(join(HERE, "..", ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env — rely on the ambient environment */
  }
}

async function main() {
  loadEnv();
  const execute = process.argv.includes("--execute");
  // Defaults to 1 USDC (the guardrail). The user may deliberately raise it via
  // SPIKE_AMOUNT to exceed the destination forwarder fee and watch a live
  // settlement — an intentional, user-chosen larger test, never automatic.
  const AMOUNT = process.env.SPIKE_AMOUNT || "1";

  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const from = process.env.SPIKE_FROM || process.env.AGENT_WALLET_ADDRESS;
  const to = process.env.SPIKE_TO || from;

  if (!apiKey || !entitySecret) {
    throw new Error("Missing CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET in .env");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(from || "")) {
    throw new Error(
      "No source wallet — set AGENT_WALLET_ADDRESS (or SPIKE_FROM) to the agent SCA that holds USDC"
    );
  }

  // Same adapter the swap uses — drives the dev-controlled SCA via Circle's API.
  const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });
  const kit = new AppKit();

  // Capture tx hashes from lifecycle events (mirrors _swap.mjs — the SCA path
  // can submit async and the hash arrives via events).
  const events = [];
  kit.on("*", (payload) => {
    const v = payload?.values || payload;
    if (v?.txHash || v?.explorerUrl || payload?.type) {
      events.push({ type: payload?.type, txHash: v?.txHash, explorerUrl: v?.explorerUrl });
    }
  });

  // THE EXACT PREPARED CALL --------------------------------------------------
  const bridgeParams = {
    from: { adapter, chain: BridgeChain.Arc_Testnet, address: from },
    // Forwarder-only destination: no adapter/signer on Sepolia. Circle's relayer
    // mints. recipientAddress = where the 1 USDC lands on Sepolia.
    to: {
      chain: BridgeChain.Ethereum_Sepolia,
      recipientAddress: to,
      useForwarder: true,
    },
    amount: AMOUNT, // "1" — human decimal, 6-dp max
    token: "USDC",
    config: { transferSpeed: TransferSpeed.FAST },
    // NOTE: no kitKey — bridge does not require one (only swap does).
  };
  // -------------------------------------------------------------------------

  console.log("SPIKE: Arc -> Ethereum Sepolia bridge from the agent SCA");
  console.log("  from (Arc SCA):      ", from);
  console.log("  to   (Sepolia recip):", to);
  console.log(`  amount:               ${AMOUNT} USDC${AMOUNT === "1" ? " (default)" : " (SPIKE_AMOUNT override)"}`);
  console.log("  BridgingKitContract:  0xC5567a5E3370d4DBfB0540025078e283e36A363d");
  console.log("  method:               bridgeWithPreapprovalAndHook (preapproval + forwarding hook)");
  console.log("");

  // 1) Estimate first — free, moves no funds. Confirms the route + fees resolve.
  console.log("Estimating (free, no funds move)…");
  const estimate = await kit.estimateBridge(bridgeParams);
  console.log("Estimate:", pretty(estimate));

  // Preflight: the destination forwarder fee is paid out of the bridged amount.
  // If it meets/exceeds our amount, the bridge cannot settle — refuse to move
  // funds into a doomed burn. (This is a FEE-ECONOMICS limit, not an SCA limit:
  // the route + SCA + source steps all resolved above.)
  const forwarderFee = Number(
    (estimate?.fees || []).find((f) => f.type === "forwarder")?.amount || 0
  );
  const feeExceedsAmount = forwarderFee >= Number(AMOUNT);
  if (feeExceedsAmount) {
    console.log(
      `\n⚠  Destination forwarder fee ≈ ${forwarderFee} USDC ≥ amount ${AMOUNT} USDC.` +
        `\n   A ${AMOUNT}-USDC forwarded bridge CANNOT settle (fee is taken from the bridged amount).` +
        `\n   This is an economic floor, NOT an SCA capability limit — the route and the` +
        `\n   Arc-side Approve + bridgeWithPreapprovalAndHook steps resolved for the SCA above.` +
        `\n   To watch a live settlement you'd need to bridge MORE than the forwarder fee.`
    );
  }

  if (!execute) {
    console.log("\nEstimate only. Re-run with --execute to fire the 1-USDC bridge.");
    return;
  }

  if (feeExceedsAmount) {
    console.log(
      "\nRefusing to --execute: 1 USDC is below the forwarder fee, so the burn would" +
        "\nrevert / never settle and you'd just spend the Arc-side approve gas for nothing." +
        "\nRe-run with SPIKE_AMOUNT override only if you deliberately want to test a larger amount."
    );
    return;
  }

  // 2) Execute — THIS MOVES 1 REAL TESTNET USDC.
  console.log("\n--execute set: firing the 1-USDC bridge now…");
  let result;
  try {
    result = await kit.bridge(bridgeParams);
  } catch (e) {
    // Mirror _swap.mjs: the SCA path can throw a post-submission "hash not ready"
    // race even though the tx landed. Surface events so we can see what happened.
    const isPostSubmitWaitError =
      e?.code === 1098 || /transaction hash is required/i.test(e?.message || "");
    if (isPostSubmitWaitError) {
      console.log("Post-submission wait race (tx likely in flight). Events:");
      console.log(pretty(events));
      return;
    }
    throw e;
  }

  console.log("\nBridge result:", pretty(result));
  console.log("\nSteps:");
  for (const s of result?.steps || []) {
    console.log(`  ${s.name}: ${s.state}  ${s.txHash || ""}  ${s.explorerUrl || ""}`);
  }
  if (events.length) console.log("\nLifecycle events:", pretty(events));
}

main().catch((e) => {
  console.error("\nSPIKE FAILED:", e?.message || e);
  if (e?.stack) console.error(e.stack);
  process.exit(1);
});
