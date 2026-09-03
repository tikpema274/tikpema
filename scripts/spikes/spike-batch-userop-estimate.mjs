// spike-batch-userop-estimate.mjs — CAN ONE userOp CARRY BOTH THE APPROVE AND THE BURN?
//
//   node --env-file=.env scripts/spikes/spike-batch-userop-estimate.mjs
//
// ═══ ⛔ NOTHING IS BROADCAST. NOTHING IS SIGNED. NO MONEY MOVES. ═══════════════════════════════
// Every call below is `estimateContractExecutionFee`, which simulates and returns a gas figure. It
// is the same instrument the vanilla-bytes spike used as an A/B, and it was chosen for exactly this
// property: it exercises validation without submitting anything.
//
// ═══ WHAT THIS DECIDES ════════════════════════════════════════════════════════════════════════
// The upfront-fee migration needs an approve to TokenMessengerWithFees before the burn. If the two
// are separate transactions, a deadline refusal between them leaves an `amount + fee` allowance
// standing to a UUPS proxy whose `_authorizeUpgrade` has an EMPTY BODY behind a single EOA — no
// timelock, no notice. Batching them into ONE userOp removes the window entirely: `executeBatch`
// loops `callWithReturnDataOrRevert`, so either both land or neither does.
//
// READ FROM VERIFIED SOURCE, FREE, BEFORE WRITING THIS:
//   · the account is `SingleOwnerMSCA` (impl 0xd206ac7f…9ec8) and DOES expose
//     `executeBatch((address,uint256,bytes)[])` — selector 0x34fcd5be, present in the bytecode
//   · `_checkAccessRuleFromEPOrAcctItself` permits `msg.sender == address(this)`, so a self-call
//     is allowed at the contract level
//   · the SDK takes ONE `contractAddress` + `callData`, so a batch is expressed by pointing
//     `contractAddress` at THE WALLET ITSELF: execute(SCA, 0, executeBatch([...]))
//
// ⚠️ TWO QUESTIONS REMAINED, AND ONLY A CALL CAN ANSWER THEM — which is why this script exists:
//   Q1  RUNTIME VALIDATION. `_processPreRuntimeHooksAndValidation` routes on per-wallet installed
//       plugin storage, which is not readable from source.
//   Q2  CIRCLE'S SCREENING. Whether the API accepts a `contractAddress` equal to the wallet itself.
//
// ═══ ⭐⭐ THREE PROBES, AND P1 IS A CONTROL THAT MUST PASS ══════════════════════════════════════
//   P1  CONTROL — a plain approve, contractAddress = USDC. Known-good shape. If THIS fails, the
//       credentials, wallet or network are the problem and P2 says nothing about batching.
//       ⛔ Without it, a failing P2 is unattributable: "the batch was rejected" and "the API call
//       did not work at all" produce the same red.
//   P2  THE TEST — contractAddress = the SCA itself, callData = executeBatch of TWO HARMLESS
//       APPROVES of the same value.
//       ⭐ NO QUOTE IS INVOLVED, DELIBERATELY. If P2 carried the real burn, an expired quote would
//       revert `QuoteExpired` and the failure would be about the quote, not the batch. Two
//       idempotent approves cannot revert for any reason except the batch shape being refused —
//       which isolates exactly the property under test.
//   P3  THE REAL SHAPE — a live quote, approve(amount+fee), then depositForBurnWithFees, batched.
//       Runs only if P2 passed. It confirms the real payload fits (encoding, size, the 868-byte
//       quote tuple); it is not the discriminator.

import { encodeFunctionData, pad, getAddress } from "viem";
import { circle } from "../../netlify/functions/_circle.mjs";
import { ARC, CONTRACTS } from "../../netlify/functions/_arc.mjs";

const TMWF = "0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A";
const WALLET = process.env.AGENT_WALLET_ADDRESS;
const DEST_DOMAIN = 6;               // Base Sepolia
const AMOUNT = 1n;                   // 1 minor unit — the same amount runs 1 and 2 used

if (!WALLET) {
  console.error("\n⛔ AGENT_WALLET_ADDRESS is not set. Run with:  node --env-file=.env " +
    "scripts/spikes/spike-batch-userop-estimate.mjs\n");
  process.exit(64);
}

const CALL_ABI = [{
  name: "executeBatch", type: "function", stateMutability: "payable",
  outputs: [{ type: "bytes[]" }],
  inputs: [{ name: "calls", type: "tuple[]", components: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }] }],
}];
const APPROVE_ABI = [{
  name: "approve", type: "function", stateMutability: "nonpayable", outputs: [{ type: "bool" }],
  inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
}];
const BURN_ABI = [{
  name: "depositForBurnWithFees", type: "function", stateMutability: "payable", outputs: [],
  inputs: [
    { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" },
    { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "claim", type: "tuple", components: [
      { name: "signedQuote", type: "bytes" }, { name: "refundAddress", type: "address" }] },
  ],
}];

const client = circle();
const line = (s = "") => console.log(s);

/** One estimate. Returns { ok, gas } or { ok:false, kind, detail } — never throws. */
async function estimate(label, contractAddress, callData) {
  try {
    const r = await client.estimateContractExecutionFee({
      walletAddress: WALLET, blockchain: ARC.blockchain, contractAddress, callData,
    });
    const g = r?.data?.medium?.gasLimit ?? r?.data?.high?.gasLimit ?? "?";
    line(`  ✅ ${label} — ACCEPTED, gasLimit ${g}`);
    return { ok: true, gas: g };
  } catch (e) {
    // ⭐⭐ THE ERROR'S SHAPE IS THE ANSWER, NOT JUST ITS PRESENCE. See the verdict block below:
    // an API-level rejection and an on-chain simulation revert settle DIFFERENT questions.
    const status = e?.response?.status ?? e?.status ?? null;
    const body = e?.response?.data ? JSON.stringify(e.response.data) : (e?.message ?? String(e));
    line(`  ❌ ${label} — REFUSED${status ? ` (HTTP ${status})` : ""}`);
    line(`     ${String(body).slice(0, 400)}`);
    return { ok: false, status, detail: String(body) };
  }
}

line(`\n═══ BATCH userOp PROBE · ${new Date().toISOString()} ═══`);
line(`wallet ${WALLET}  ·  ${ARC.blockchain}  ·  NOTHING IS BROADCAST`);

// ── P1 — THE CONTROL. A shape we already run in production every bridge. ──────────────────────
line(`\nP1  CONTROL — a plain approve (contractAddress = USDC). MUST PASS.`);
const approveData = encodeFunctionData({
  abi: APPROVE_ABI, functionName: "approve", args: [getAddress(TMWF), 1000n],
});
const p1 = await estimate("plain approve", CONTRACTS.USDC, approveData);
if (!p1.ok) {
  line(`\n⛔ INCONCLUSIVE — the control failed, so nothing below is attributable to batching.`);
  line(`   Fix credentials / wallet / network first. This is NOT evidence against option C.\n`);
  process.exit(2);
}

// ── P2 — THE TEST. Two harmless approves, batched, self-targeted. No quote involved. ──────────
line(`\nP2  THE TEST — executeBatch of TWO identical approves, contractAddress = the SCA ITSELF.`);
const batchTwoApproves = encodeFunctionData({
  abi: CALL_ABI, functionName: "executeBatch",
  args: [[
    { target: getAddress(CONTRACTS.USDC), value: 0n, data: approveData },
    { target: getAddress(CONTRACTS.USDC), value: 0n, data: approveData },
  ]],
});
const p2 = await estimate("self-targeted executeBatch", getAddress(WALLET), batchTwoApproves);

// ── P3 — THE REAL SHAPE. Only meaningful once P2 has answered. ────────────────────────────────
let p3 = null;
if (p2.ok) {
  line(`\nP3  THE REAL SHAPE — a live quote, approve(amount+fee) + depositForBurnWithFees, batched.`);
  const qRes = await fetch(`https://iris-api-sandbox.circle.com/v2/quote/burn/usdc/26/${DEST_DOMAIN}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: AMOUNT.toString(), feeToken: CONTRACTS.USDC, requests: [{ type: "FORWARD" }] }),
  });
  const q = await qRes.json();
  const FEE = BigInt(q.feeTotalAmount);
  line(`    quote: fee ${FEE} minor · mode ${q.expiry?.mode} · ${q.expiry.expiresAt - Math.floor(Date.now() / 1000)}s left`);
  const realBatch = encodeFunctionData({
    abi: CALL_ABI, functionName: "executeBatch",
    args: [[
      { target: getAddress(CONTRACTS.USDC), value: 0n,
        data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [getAddress(TMWF), AMOUNT + FEE] }) },
      { target: getAddress(TMWF), value: 0n,
        data: encodeFunctionData({ abi: BURN_ABI, functionName: "depositForBurnWithFees", args: [
          AMOUNT, DEST_DOMAIN, pad(getAddress(WALLET)), CONTRACTS.USDC, pad("0x0", { size: 32 }),
          { signedQuote: q.signedQuote, refundAddress: getAddress(WALLET) }] }) },
    ]],
  });
  line(`    batch calldata ${(realBatch.length - 2) / 2} bytes`);
  p3 = await estimate("real approve+burn batch", getAddress(WALLET), realBatch);
}

// ═══ THE VERDICT — WRITTEN SO THE RESULT CANNOT BE READ TWO WAYS ══════════════════════════════
line(`\n${"═".repeat(78)}`);
if (p2.ok && p3?.ok) {
  line(`✅ OPTION C IS AVAILABLE. Both Q1 and Q2 are answered YES:`);
  line(`   Q1 runtime validation ACCEPTS the self-call to executeBatch;`);
  line(`   Q2 Circle's screening ACCEPTS contractAddress == the wallet itself.`);
  line(`   Build item 3 as ONE batched userOp — the allowance window never opens.`);
} else if (p2.ok && p3 && !p3.ok) {
  line(`⚠️ THE BATCH SHAPE IS ACCEPTED (P2) BUT THE REAL PAYLOAD IS NOT (P3).`);
  line(`   Q1 and Q2 are both YES — the refusal is about the PAYLOAD, not batching.`);
  line(`   Read P3's error: a QuoteExpired revert means re-run (the window closed mid-probe) and`);
  line(`   is NOT a verdict; anything else is a real finding about the burn call itself.`);
} else if (!p2.ok && p2.status && p2.status >= 400 && p2.status < 500) {
  line(`❌ OPTION C IS BLOCKED BY CIRCLE'S API — an HTTP ${p2.status} rejection, before any chain.`);
  line(`   Q2 is answered NO: the API refuses a self-targeted contractAddress.`);
  line(`   ⚠️ Q1 IS LEFT UNANSWERED — the call never reached validation, so this says NOTHING`);
  line(`   about whether the account would have accepted it. Do not record Q1 as settled.`);
  line(`   ⇒ BUILD OPTION A: revoke on refusal.`);
} else if (!p2.ok) {
  line(`❌ OPTION C IS BLOCKED ON CHAIN — the call reached simulation and reverted.`);
  line(`   Q2 is answered YES (the API accepted the shape); Q1 is answered NO.`);
  line(`   Look for UnauthorizedCaller / InvalidExecutionFunction / a plugin validation error:`);
  line(`   the account's runtime validation refuses the self-call.`);
  line(`   ⇒ BUILD OPTION A: revoke on refusal.`);
}
line(`${"═".repeat(78)}\n`);
line(`P1 ${p1.ok ? "pass" : "FAIL"} · P2 ${p2.ok ? "pass" : "FAIL"} · P3 ${p3 === null ? "not run" : p3.ok ? "pass" : "FAIL"}`);
line(`⛔ Nothing was broadcast. No allowance was granted. No USDC moved.\n`);
