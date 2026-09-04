// verify-bridge-batch-atomicity.mjs — THE APPROVE AND THE BURN RIDE IN ONE userOp, OR THIS FAILS.
//
//   node scripts/verify-bridge-batch-atomicity.mjs      (also: npm run test:batchatomicity)
//
// ═══ ⛔⛔ THIS IS NOT A STYLE CHECK. IT IS THE GUARD ON A SAFETY PROPERTY ═══════════════════════
//
// Under CCTP upfront fees the burn needs an allowance of `amount + fee` to
// `TokenMessengerWithFees`. Sent as TWO SEQUENTIAL TRANSACTIONS, anything that fails between them
// — a quote that expired, a revert, a timeout, a deploy — leaves that allowance STANDING.
//
// 🚨 AND STANDING AGAINST WHAT, EXACTLY. TMWF is a UUPS proxy. Read from its verified source and
// from chain on 2026-09-03:
//     ERC-1967 admin slot   0x000…000        -> no ProxyAdmin
//     _authorizeUpgrade     onlyOwner {}     -> EMPTY BODY, no delay, no condition
//     owner()               0x3b61abee…3ef1  -> 0 bytes, nonce 237  =>  a single EOA
// Immediate, single-key, no timelock, no notice. ⚠️ `Ownable2Step` in the inheritance list governs
// ownership TRANSFER, not upgrades — it reads as a governance delay and is not one.
//
// ⭐ SO BATCHING WAS CHOSEN OVER "revoke on refusal" AND OVER "leave it and record it". `executeBatch`
// loops `callWithReturnDataOrRevert`: either both calls land or neither does, and no allowance ever
// stands alone. A future edit that splits them back into two transactions would silently restore
// the window — silently, because both versions bridge correctly on the happy path and the
// difference only shows up on a failure nobody is watching.
//
// ⚠️ AND THE BATCH IS VALIDATION-PROVEN, NOT SETTLEMENT-PROVEN. `estimateContractExecutionFee`
// showed the account accepts a self-targeted `executeBatch` and Circle accepts a `contractAddress`
// equal to the wallet. AN ESTIMATE SIMULATES; IT DOES NOT SETTLE. No batched burn has landed on
// chain. That is what `docs/batched-burn-preregistration.md` exists for, and this suite does not
// claim otherwise.
//
// Zero network. Zero money.

import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeFunctionData, getAddress, pad } from "viem";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-secret-for-batch-atomicity";

import { bridgeBatchCallData, bridgeDebitMinor, TMWF } from "../netlify/functions/_bridge.mjs";
import { CONTRACTS } from "../netlify/functions/_arc.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return !!c;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const SRC = readFileSync("netlify/functions/_bridge.mjs", "utf8");
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const WALLET = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const QUOTE_BYTES = "0x01" + "ab".repeat(64);
const FEE = { amountMinor: 1_000_000n, feeMinor: 54_121n, feeUsdc: 0.054121, netUsdc: 1,
  quote: { signedQuote: QUOTE_BYTES } };

const BATCH_ABI = [{
  name: "executeBatch", type: "function", stateMutability: "payable", outputs: [{ type: "bytes[]" }],
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

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BATCH ATOMICITY — one userOp, or the allowance window reopens       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — THE BATCH CONTAINS BOTH CALLS, DECODED — not asserted from source");
const batch = bridgeBatchCallData({ walletAddress: WALLET, fee: FEE, recipient: WALLET, cctpDomain: 6 });
const decoded = decodeFunctionData({ abi: BATCH_ABI, data: batch });
const calls = decoded.args[0];
check("⭐ the payload is an executeBatch", decoded.functionName === "executeBatch");
check("⭐⭐ …carrying EXACTLY TWO calls", calls.length === 2, `${calls.length} calls`);

const [c0, c1] = calls;
check("⭐ call 0 targets USDC", getAddress(c0.target) === getAddress(CONTRACTS.USDC));
check("⭐ call 1 targets TokenMessengerWithFees", getAddress(c1.target) === getAddress(TMWF));
// ⛔ ORDER IS LOAD-BEARING: the burn pulls the allowance the approve grants, so a batch that burned
// first would revert as a unit — safe, but permanently broken. Both properties matter.
const ap = decodeFunctionData({ abi: APPROVE_ABI, data: c0.data });
const bn = decodeFunctionData({ abi: BURN_ABI, data: c1.data });
check("⛔ the APPROVE comes first and the BURN second — the burn spends what the approve grants",
  ap.functionName === "approve" && bn.functionName === "depositForBurnWithFees");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 THE APPROVED AMOUNT IS EXACTLY amount + fee — no buffer, no shortfall");
check("⭐⭐ the approve is for the exact debit, from the SAME quote",
  ap.args[1] === bridgeDebitMinor(FEE), `${ap.args[1]} vs ${bridgeDebitMinor(FEE)}`);
check("⭐ …and the spender is TMWF, not the old BridgingKitContract",
  getAddress(ap.args[0]) === getAddress(TMWF));
// ⛔ A BUFFER WOULD BE A STANDING ALLOWANCE BY ANOTHER NAME. Approving more than the burn consumes
// leaves the remainder approved after a SUCCESSFUL bridge — which is the state this whole option
// exists to prevent, arrived at through the happy path instead of the failure one.
check("⛔ the approve is not padded — a buffer would survive a SUCCESSFUL burn as a standing allowance",
  ap.args[1] === FEE.amountMinor + FEE.feeMinor);
// ⚠️ And the burn asks for the AMOUNT, not the debit. Burning amount+fee would send the fee across
// the bridge as well as paying it.
check("⚠️ the burn's amount is the AMOUNT, not the debit", bn.args[0] === FEE.amountMinor);
check("⭐ …and the burn carries the quote's signed bytes", bn.args[5].signedQuote === QUOTE_BYTES);
check("⭐ …with the refund address set to the paying wallet",
  getAddress(bn.args[5].refundAddress) === getAddress(WALLET));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⛔⛔ THE EXECUTOR SUBMITS ONE TRANSACTION, AND ONLY ONE");
{
  // 🚨 THE MUTATION THIS EXISTS FOR: splitting the batch back into a sequential approve + burn.
  // It is counted on the STRIPPED source so a comment mentioning `approve` cannot satisfy or break
  // it — the property is about calls the executor MAKES, not words it contains.
  const submits = (CODE.match(/createContractExecutionTransaction\(/g) || []).length;
  check("⛔⛔ agentBridge submits EXACTLY ONE transaction — two would reopen the allowance window",
    submits === 1, `${submits} createContractExecutionTransaction call site(s) in _bridge.mjs`);
  check("🚨 …and none of them is a standalone approve",
    !/abiFunctionSignature:\s*"approve\(address,uint256\)"/.test(CODE),
    "a separate approve transaction is exactly the split this guard forbids");
  check("⭐ the single submit targets the WALLET ITSELF — the self-call that makes a batch reachable",
    /contractAddress:\s*getAddress\(walletAddress\)/.test(CODE));
  check("⭐ …and its callData is the batch, not a bare burn",
    /callData\s*=\s*bridgeBatchCallData\(/.test(CODE));
  // ⚠️ There is also no allowance read left: the approve is unconditional and inside the batch, so
  // a read could not change what is submitted.
  check("⚠️ no allowance read remains on the agent path — its answer could not change the submission",
    !/functionName:\s*"allowance"/.test(CODE.slice(CODE.indexOf("export async function agentBridge"))));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — THE REASON IS WRITTEN WHERE THE EDIT WOULD BE MADE");
{
  // ⭐ A guard that fails without saying why gets deleted by whoever it blocks. The argument has to
  // sit at the code, not only in this file.
  const prose = SRC.replace(/^\s*(\/\/|\*)\s?/gm, " ").replace(/\s+/g, " ");
  // ═══ 🚨 THIS SECTION USED TO PIN AN OVERCLAIM AND A CLAIM THAT HAD GONE FALSE ════════════════
  // It required the prose to say "either both land or neither does, and no allowance ever stands
  // alone" — the atomicity claim — and to say "No batched burn has landed on chain".
  //   · The first is UNTESTED (PR-6: Circle refuses deterministic reverts pre-broadcast, so the
  //     revert never happens; only a simulation-to-inclusion race reaches the chain).
  //   · The second became FALSE the moment PR-4 landed, and falser again at PR-5.
  // ⭐⭐ A GUARD THAT PINS A CLAIM KEEPS IT TRUE OR KEEPS IT FROZEN — and this one froze a sentence
  // the runs had already overtaken, while reading green. So it now pins the DISTINCTION rather than
  // the wording: what is established, and that the untested part is MARKED untested.
  check("⭐⭐ the safety property is still named at the code",
    /THERE IS NO SEPARATE APPROVE TRANSACTION, AND THAT IS THE SAFETY PROPERTY/i.test(prose));
  check("⛔⛔ …and rollback-on-revert is MARKED NOT TESTED, not asserted",
    /NOT TESTED/.test(prose) && /NOT TESTED IS NOT UNTRUE/i.test(prose));
  check("⭐ …with the structural reason: simulation refuses deterministic reverts pre-broadcast",
    /simulates[\s\S]{0,80}before broadcasting/i.test(prose) &&
    /BETWEEN simulation and inclusion/i.test(prose));
  check("⭐⭐ …and what IS established is stated: the race class and the split design's refusal-after-approve",
    /THE RACE CLASS/i.test(prose) && /REFUSAL-AFTER-APPROVE/i.test(prose));
  check("🚨 …with the upgrade authority that makes a standing allowance matter",
    /EMPTY BODY behind a single EOA/i.test(prose) && /no timelock, no notice/i.test(prose));
  check("⭐ …and the success path is marked as unable to settle atomicity",
    /consistent with atomicity/i.test(prose) && /happened to succeed/i.test(prose));
  check("⭐ …pointing at the pre-registrations, including the induced-failure one",
    /batched-burn-preregistration/.test(prose) &&
    /induced-failure-atomicity-preregistration/.test(prose));
  check("⭐ this guard is named at the code it guards, so a splitter finds it before the reviewer does",
    /verify-bridge-batch-atomicity/.test(prose));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — THE OLD DEDUCTED PATH IS STILL INTACT, AND STILL SEPARATE");
{
  // ⚠️ The self-signed path CANNOT batch — a browser EOA signs one transaction at a time — so it
  // keeps BridgingKitContract and the deducted-fee mechanic. That is a decision, and it means two
  // fee mechanics are live at once. This asserts the split is real rather than accidental.
  check("⭐ the deducted-mechanic trio still exists for the self-signed path",
    /export async function bridgeFeeDeducted/.test(CODE) &&
    /export function bridgeCallDataDeducted/.test(CODE) &&
    /export function bridgeNetDeducted/.test(CODE));
  check("⛔ …and the agent path does not use them",
    !new RegExp("bridgeFeeDeducted|bridgeCallDataDeducted").test(
      CODE.slice(CODE.indexOf("export async function agentBridge"))));
  const user = readFileSync("netlify/functions/_user-bridge.mjs", "utf8");
  check("⭐ the self-signed path uses the deducted trio and nothing else",
    /bridgeFeeDeducted\(/.test(user) && /bridgeCallDataDeducted\(/.test(user) &&
    !/\bbridgeBatchCallData\b/.test(user));
  check("⚠️ …and the reason it was NOT migrated is written down, not left to be guessed",
    /A browser EOA cannot do that/i.test(SRC.replace(/^\s*(\/\/|\*)\s?/gm, " ").replace(/\s+/g, " ")));
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
