// spike-erc20-fee-burn.mjs — MIGRATION STEP 3. The first ERC-20-feeToken burn on Arc.
//
// ⛔ THIS SPENDS REAL TESTNET USDC AND IS IRREVERSIBLE. ~0.054155 USDC (1 minor unit burned +
//    ~0.054154 fee). Pre-registered at docs/erc20-fee-burn-preregistration.md, committed d4c011c
//    BEFORE this ran, so the prediction cannot be edited to match the outcome.
//
// ═══ ⛔ WHICH STORES / RECORDS THIS WRITES — answered from code, BEFORE sending ══════════════
//
//   OUR NETLIFY BLOBS STORES:  **NOTHING.**
//     · `_circle.mjs` has no `@netlify/blobs` import and no `getStore`/`setJSON` call — verified.
//       This spike calls `circle()` + `waitForTx` DIRECTLY.
//     · The day-ledger and audit rows are written by `recordAgentSpend` (_budget.mjs:126,
//       BUDGET_STORE). Only `_actions.mjs`, `agent-send` and the handlers call it. Not reached.
//     · The bridge receipt rows are written by `_bridge-record.mjs`, called by handlers. Not reached.
//     · `budget-sweep` enumerates from the AUDIT LOG, not the chain, so with no audit row the
//       sweeper can never see this burn. Nothing retro-creates a record.
//   ⭐ SO THERE IS NO ROW TO MARK. That is the cleanest answer and it is the one that holds: a spike
//      row cannot contaminate the ledger the DCA and budget proofs rest on if no row is written.
//
//   CIRCLE'S OWN TRANSACTION RECORD:  **YES, and it is unavoidable.**
//     `createContractExecutionTransaction` creates a transaction in Circle's system against
//     AGENT_WALLET_ID. That is THEIR ledger, not ours; we cannot annotate it. Two entries: the
//     approve and the burn.
//
//   THE CHAIN:  **YES.** Two transactions from 0xc54d…e621. Permanent, by design — they are the
//     measurement.
//
//   ⚠️ ONE RESIDUE IF THE BURN FAILS AFTER THE APPROVE: a standing allowance of amount+fee to
//     TokenMessengerWithFees remains on the AGENT wallet. ~0.054155 USDC, on the wallet agents use.
//     A successful burn consumes it exactly and returns it to 0.
//
// ⚠️ AND THIS IS AN EXPLICIT OVERRIDE of the standing rule that the USER runs fund-moving tests
//    [[live-proof-fund-moving-user-runs]]. Authorised for this pre-registered ~0.054 USDC
//    measurement, with preconditions cleared and the amount stated first. Recorded so the override
//    is auditable rather than silent.
//
//   node scripts/spikes/spike-erc20-fee-burn.mjs

import { encodeFunctionData, pad, getAddress } from "viem";
import { writeFileSync } from "node:fs";
import { circle, waitForTx } from "../../netlify/functions/_circle.mjs";
import { ARC, CONTRACTS } from "../../netlify/functions/_arc.mjs";

const OUT = "/tmp/claude-1000/-home-salifu-Arc-now2-tikpema/75e196a1-613c-429a-9a71-101d3beca133/scratchpad/burn";
const TMWF = "0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A";
// ⭐ VANILLA_SELLER, NOT THE AGENT WALLET. The store analysis closes the CONTAMINATION question —
// this writes no row — but not the RESIDUE one: a burn that fails after the approve leaves a
// standing allowance to a UUPS PROXY, and the 2026-09-03 decision is that between-bridge permission
// stays exactly ZERO. Leaving one on the wallet the agent paths use would contradict that decision.
// This wallet is an x402 spike/demo receiver on no agent execution path, and 0.314272 covers 0.054
// with room for one retry.
const WALLET = process.env.VANILLA_SELLER_ADDRESS;
const AMOUNT = 1n;                     // one minor unit — smallest viable, and unambiguous vs the fee
const DEST_DOMAIN = 6;                 // Base Sepolia
// ═══ ⛔⛔ THIS SCRIPT DOES NOTHING UNLESS TOLD TO SPEND ═══════════════════════════════════════
// 🚨 WHY THIS EXISTS, MEASURED 2026-09-03: I tried to LOAD-CHECK this file with
// `node -e "import('./…')"`. **`import()` EXECUTES A MODULE.** It requested a quote and attempted
// the approve; only a missing `--env-file` stopped it, and that was luck, not a safeguard.
// ⛔ "The run that works is the only run that spends" was a property of the TASK. It is now a
// property of the SCRIPT: loading, importing, or running bare reaches no network at all.
// ⚠️ THE GUARD IS FIRST, ABOVE EVERY fetch AND EVERY circle() CALL. A guard after the first request
// would still have spent the quote window. [[verification-method-must-not-mutate]]
if (!process.argv.includes("--send")) {
  console.log(`\n⛔ NO-OP — this script SPENDS REAL TESTNET USDC and requires an explicit argument.`);
  console.log(`   Nothing was requested, signed, or read. No network call was made.\n`);
  console.log(`   To actually spend ~0.054 USDC:  node --env-file=.env ${"scripts/spikes/spike-erc20-fee-burn.mjs"} --send\n`);
  process.exit(64);   // EX_USAGE — a distinct code so a no-op can never be mistaken for a completed run
}

const log = (m) => { console.log(m); writeFileSync(`${OUT}/run.log`, m + "\n", { flag: "a" }); };

const ABI = [{
  name: "depositForBurnWithFees", type: "function", stateMutability: "payable", outputs: [],
  inputs: [
    { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" },
    { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "claim", type: "tuple", components: [
      { name: "signedQuote", type: "bytes" }, { name: "refundAddress", type: "address" }] },
  ],
}];

log(`\n═══ STEP 3 — ERC-20 fee burn · ${new Date().toISOString()} ═══`);
log(`wallet ${WALLET}  ·  amount ${AMOUNT} minor  ·  dest domain ${DEST_DOMAIN}`);

// ── 1. QUOTE, recorded VERBATIM before anything else ────────────────────────────────────────
const qRes = await fetch(`https://iris-api-sandbox.circle.com/v2/quote/burn/usdc/26/${DEST_DOMAIN}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ amount: AMOUNT.toString(), feeToken: CONTRACTS.USDC, requests: [{ type: "FORWARD" }] }),
});
const raw = await qRes.text();
writeFileSync(`${OUT}/quote.json`, raw);              // verbatim, on disk, before any decision
const q = JSON.parse(raw);
const FEE = BigInt(q.feeTotalAmount);
const now = Math.floor(Date.now() / 1000);
log(`\n1. QUOTE  http=${qRes.status}  recorded -> quote.json`);
log(`   issuedAt ${q.issuedAt}  ·  expiry.mode ${q.expiry.mode}  ·  expiresAt ${q.expiry.expiresAt}`);
log(`   window ${q.expiry.expiresAt - q.issuedAt}s  ·  ${q.expiry.expiresAt - now}s remaining`);
log(`   feeTotalAmount ${FEE} minor (${Number(FEE) / 1e6} USDC)  ·  feeToken ${q.feeToken}`);
if (q.feeToken.toLowerCase() !== CONTRACTS.USDC.toLowerCase()) {
  log(`\n⛔ ABORT — the quote came back with feeToken ${q.feeToken}, not the ERC-20 USDC we asked for.`);
  process.exit(2);
}

// ── 2. APPROVE amount + fee, FROM THIS QUOTE, rounded up ────────────────────────────────────
// BigInt minor units: the sum is exact, so "rounded up" means no conversion is performed at all.
const NEED = AMOUNT + FEE;
log(`\n2. APPROVE ${NEED} minor (${Number(NEED) / 1e6} USDC) to TokenMessengerWithFees`);
const client = circle();
const ap = await client.createContractExecutionTransaction({
  walletAddress: WALLET, blockchain: ARC.blockchain, contractAddress: CONTRACTS.USDC,
  abiFunctionSignature: "approve(address,uint256)", abiParameters: [TMWF, NEED.toString()],
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
});
log(`   circle id ${ap.data?.id} — awaiting the receipt (NOT just acceptance)`);
const apHash = await waitForTx(client, ap.data?.id);
log(`   approve mined: ${apHash}`);

// ── 3. BURN inside the window. Hash captured BEFORE anything is read. ───────────────────────
const callData = encodeFunctionData({ abi: ABI, functionName: "depositForBurnWithFees", args: [
  AMOUNT, DEST_DOMAIN, pad(getAddress(WALLET)), CONTRACTS.USDC, pad("0x0", { size: 32 }),
  { signedQuote: q.signedQuote, refundAddress: getAddress(WALLET) },
]});
const left = q.expiry.expiresAt - Math.floor(Date.now() / 1000);
log(`\n3. BURN  calldata ${(callData.length - 2) / 2} bytes  ·  ${left}s left in the quote window`);
if (left <= 5) { log(`\n⛔ ABORT — only ${left}s left; the burn would revert QuoteExpired. Re-run.`); process.exit(3); }
const br = await client.createContractExecutionTransaction({
  walletAddress: WALLET, blockchain: ARC.blockchain, contractAddress: TMWF, callData,
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
});
writeFileSync(`${OUT}/burn-circle-id.txt`, String(br.data?.id));
log(`   circle id ${br.data?.id}  -> burn-circle-id.txt`);
const burnHash = await waitForTx(client, br.data?.id);
writeFileSync(`${OUT}/burn-hash.txt`, burnHash);      // written down before ANY read
log(`   ⭐ BURN HASH ${burnHash}  -> burn-hash.txt`);
log(`\n✅ submitted. Measure against the pre-registration next; nothing has been read yet.`);
