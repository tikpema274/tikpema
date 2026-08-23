// spike-vanilla-bytes-encoding.mjs — DOES CIRCLE'S API ENCODE A DYNAMIC `bytes` PARAM CORRECTLY?
//
//   node --env-file=.env scripts/spikes/spike-vanilla-bytes-encoding.mjs           # PHASE A only (free)
//   node --env-file=.env scripts/spikes/spike-vanilla-bytes-encoding.mjs --settle  # PHASE A then B (real money)
//
// ═══ 🚨 WHY THIS IS A FACT ABOUT THE SDK, NOT ABOUT THE SELLER ═══════════════════════════════
// x402-vanilla-seller now settles via receiveWithAuthorization(...,bytes) instead of the v,r,s
// overload. Every other contractExecution in this repo passes VALUE types only. A dynamic `bytes`
// is offset-encoded — a 32-byte head pointing at a tail of {length, padded data} — and nothing
// here has ever exercised that. If Circle gets it wrong, the failure appears at SETTLE TIME with a
// real buyer's signed authorization in hand. So it is settled here, standalone, with the function
// still disarmed and VANILLA_SELLER_* still unset in every deployed context.
//
// ⭐ THE SDK DOES NOT ENCODE. Confirmed by inspection: the bundle contains zero occurrences of
// `abiFunctionSignature` and no ABI coder — it is axios posting a payload. Circle encodes
// SERVER-SIDE, so there is no local calldata to inspect and the question can only be answered by
// asking their API and reading what comes back.
//
// ═══ ⭐⭐ PHASE A — THE FREE DISCRIMINATOR, AND WHY IT DISCRIMINATES ═══════════════════════════
// `estimateContractExecutionFee` runs a real eth_estimateGas against the real contract and moves
// nothing. Two estimates are submitted with IDENTICAL parameters except the signature bytes:
//
//   · a REAL signature over the token's real EIP-712 domain, from a throwaway key with ZERO USDC
//   · the same signature with one byte corrupted
//
//   IF CIRCLE MIS-ENCODES the bytes param, the token cannot recover anything from either, so BOTH
//   fail the same way — the signature's validity is invisible.
//   IF CIRCLE ENCODES CORRECTLY, the real one gets PAST signature validation and dies on the empty
//   balance, while the corrupted one dies on the signature. DIFFERENT failures.
//
// ⚠️ Identical failures are therefore the STOP condition. "Both errored" is not evidence of
// correct encoding — it is the exact signature of broken encoding.
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const RPC = "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042002;
const SELLER = process.env.VANILLA_SELLER_ADDRESS;
const SELLER_WALLET = process.env.VANILLA_SELLER_WALLET_ID;
const DELEGATE = process.env.DELEGATE_ADDRESS;
const SIG = "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)";

// ⚠️ RETRIES ON READS ONLY — NEVER ON THE SUBMIT. Arc's public RPC is throttled and dropped out
// mid-run on the first attempt at this spike (ETIMEDOUT to its Cloudflare front, killing the script
// in PHASE A before anything was signed). A transient read failure must not be able to abort a
// money path, and — more to the point — must not be able to abort it AFTER submission, leaving the
// script unable to report what it just did. The Circle submit below is deliberately NOT wrapped:
// retrying a transaction submission is how one payment becomes two.
const rpc = async (m, p, tries = 5) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      const j = await r.json();
      if (j.error) throw new Error(m + ": " + JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      last = e;
      if (i < tries - 1) { console.log(`    (rpc ${m} attempt ${i + 1} failed, retrying)`); await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
    }
  }
  throw last;
};
const balanceOf = async (a) => BigInt(await rpc("eth_call",
  [{ to: USDC, data: "0x70a08231000000000000000000000000" + a.slice(2) }, "latest"]));
const errOf = (e) => {
  const d = e?.response?.data ?? e?.data ?? {};
  return JSON.stringify(d?.message ?? d?.error ?? e?.message ?? String(e)).slice(0, 240);
};

if (!SELLER || !SELLER_WALLET || !DELEGATE) {
  console.error("need VANILLA_SELLER_ADDRESS / VANILLA_SELLER_WALLET_ID / DELEGATE_ADDRESS in .env");
  process.exit(1);
}
const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY, entitySecret: process.env.CIRCLE_ENTITY_SECRET });

const domain = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC };
const types = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  PHASE A — does Circle encode a dynamic `bytes` param correctly?    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

const probe = privateKeyToAccount(generatePrivateKey());
const now = Math.floor(Date.now() / 1000);
const auth = { from: probe.address, to: SELLER, value: "10000",
  validAfter: "0", validBefore: String(now + 600), nonce: keccak256(toHex("encoding-probe-" + probe.address)) };
console.log("  throwaway payer :", probe.address, `(balance ${await balanceOf(probe.address)} atomic — zero by construction)`);

const realSig = await probe.signTypedData({ domain, types, primaryType: "ReceiveWithAuthorization",
  message: { from: auth.from, to: auth.to, value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce } });
const badSig = realSig.slice(0, -2) + (realSig.slice(-2) === "1b" ? "1c" : "1b");

const estimate = async (label, signature) => {
  const params = [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, signature];
  try {
    const r = await client.estimateContractExecutionFee({
      walletId: SELLER_WALLET, contractAddress: USDC, abiFunctionSignature: SIG, abiParameters: params });
    const m = r?.data?.medium;
    console.log(`  ${label.padEnd(22)} ESTIMATE OK  gasLimit=${m?.gasLimit} maxFee=${m?.maxFee}`);
    return { ok: true, msg: null };
  } catch (e) {
    const msg = errOf(e);
    console.log(`  ${label.padEnd(22)} FAILED  ${msg}`);
    return { ok: false, msg };
  }
};

console.log("\n  ⚠️ msg.sender must == payee, so both estimates are sourced from the SELLER wallet.\n");
const A = await estimate("real signature", realSig);
const B = await estimate("corrupted signature", badSig);

const same = A.ok === B.ok && String(A.msg) === String(B.msg);
console.log("\n════ PHASE A VERDICT ════");
if (same) {
  console.log("  🚨 IDENTICAL OUTCOMES — the signature's validity is INVISIBLE to the contract.");
  console.log("     That is the signature of a mis-encoded `bytes` param. STOPPING; nothing signed.");
  process.exit(1);
}
console.log("  ✅ THE TWO DIFFER — the contract can tell a good signature from a bad one,");
console.log("     so the bytes param reached it intact (offset + length prefix correct).");
console.log(`     real      -> ${A.ok ? "estimate OK" : A.msg}`);
console.log(`     corrupted -> ${B.ok ? "estimate OK" : B.msg}`);

if (!process.argv.includes("--settle")) {
  console.log("\n  PHASE B not requested (pass --settle). Nothing signed, nothing moved.\n");
  process.exit(0);
}

// ═══ PHASE B — THE FIRST VANILLA SETTLEMENT THIS PROJECT HAS DONE ════════════════════════════
const VALUE = 10000n;                      // the seller's real PRICE_ATOMIC — a rehearsal, not a toy
console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  PHASE B — PRE-REGISTERED, PRINTED BEFORE ANYTHING IS SIGNED        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
console.log(`  P1  delivered amount           = EXACTLY ${VALUE} atomic, read from the Transfer EVENT`);
console.log( "  P2  seller balance delta       = delivered MINUS gas, NOT the delivered amount.");
console.log( "        ⭐ USDC IS the gas token on Arc and the seller submits (msg.sender == to), so it");
console.log( "        pays gas out of the same balance with no Transfer event. This is exactly the");
console.log( "        10000-vs-8114 gap found while attributing this wallet; pre-registered so it is");
console.log( "        not rediscovered as a surprise.");
console.log(`  P3  payer balance delta        = EXACTLY -${VALUE} atomic (the payer submits nothing, pays no gas)`);
console.log( "  P4  latency (submit -> money moved on chain):");
console.log( "        · YOUR pre-registration : SUB-SECOND (vs Gateway's measured ~15.4 min flush)");
console.log( "        · MY expectation        : NOT sub-second. Arc mines in ~0.54 s, but Circle QUEUES");
console.log( "          the transaction, and that queue is not the chain. Recorded in advance so");
console.log( "          whichever way it lands is a measurement and not a rationalisation.");
console.log( "  P5  broken out as: submit->id (Circle accept) | submit->mined (what a payee waits for)\n");

const sellerBefore = await balanceOf(SELLER);
const payerBefore = await balanceOf(DELEGATE);
console.log(`  balanceOf BEFORE (from chain)  seller ${sellerBefore}   payer ${payerBefore}\n`);
if (payerBefore < VALUE) { console.error("  payer cannot fund this. stopping."); process.exit(1); }

const now2 = Math.floor(Date.now() / 1000);
const bAuth = { from: DELEGATE, to: SELLER, value: String(VALUE), validAfter: "0",
  validBefore: String(now2 + 600), nonce: keccak256(toHex("vanilla-first-settlement-" + now2)) };
const typedData = JSON.stringify({
  types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" },
    { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...types },
  domain, primaryType: "ReceiveWithAuthorization",
  message: { from: bAuth.from, to: bAuth.to, value: bAuth.value,
    validAfter: bAuth.validAfter, validBefore: bAuth.validBefore, nonce: bAuth.nonce },
});
const signRes = await client.signTypedData({ walletId: process.env.DELEGATE_WALLET_ID, data: typedData });
const bSig = signRes?.data?.signature;
if (!bSig) { console.error("  no signature from Circle. stopping."); process.exit(1); }
console.log(`  delegate signed: ${bSig.slice(0, 22)}… (${(bSig.length - 2) / 2} bytes)`);

const tSubmit = Date.now();
const tx = await client.createContractExecutionTransaction({
  walletId: SELLER_WALLET, contractAddress: USDC, abiFunctionSignature: SIG,
  abiParameters: [bAuth.from, bAuth.to, bAuth.value, bAuth.validAfter, bAuth.validBefore, bAuth.nonce, bSig],
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
});
const tId = Date.now();
const txId = tx?.data?.id;
console.log(`  submitted: circle id ${txId}   (submit->id ${((tId - tSubmit) / 1000).toFixed(2)}s)`);

let txHash = null, state = null, tMined = null;
for (let i = 0; i < 120 && !txHash; i++) {
  const g = await client.getTransaction({ id: txId });
  state = g?.data?.transaction?.state;
  txHash = g?.data?.transaction?.txHash || null;
  if (txHash) { tMined = Date.now(); break; }
  if (state === "FAILED" || state === "CANCELLED") {
    console.error(`  🚨 terminal state ${state}: ${JSON.stringify(g?.data?.transaction?.errorReason ?? "")}`); process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!txHash) { console.error("  no txHash within 120s — reporting that, not retrying."); process.exit(1); }
console.log(`  mined: ${txHash}  state=${state}   (submit->mined ${((tMined - tSubmit) / 1000).toFixed(2)}s)`);

const rcpt = await rpc("eth_getTransactionReceipt", [txHash]);
const blk = await rpc("eth_getBlockByNumber", [rcpt.blockNumber, false]);
const T0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// 🚨 THE CONTRACT ADDRESS IS PART OF THE FILTER, AND LEAVING IT OUT MISREADS THE AMOUNT BY 1e12.
// A settlement on Arc emits the SAME movement twice: once as the USDC ERC-20 Transfer at 0x3600…
// in 6 decimals, and once as the NATIVE-token view at 0xffff…fe in 18 decimals. USDC *is* the gas
// token here, so both are real and both are "a Transfer to the seller". Matching on topic+recipient
// alone picked up the 18-dp one and reported 10000000000000000 for a 10000-atomic payment —
// a measurement failure that read exactly like a settlement failure. Same asset, two views.
const xfer = (rcpt.logs || []).find((l) => l.topics?.[0] === T0 &&
  l.address.toLowerCase() === USDC.toLowerCase() &&
  ("0x" + l.topics[2].slice(26)).toLowerCase() === SELLER.toLowerCase());
const delivered = xfer ? BigInt(xfer.data) : null;
const gasUsed = BigInt(rcpt.gasUsed) * BigInt(rcpt.effectiveGasPrice ?? blk.baseFeePerGas ?? 0n);

const sellerAfter = await balanceOf(SELLER);
const payerAfter = await balanceOf(DELEGATE);

const line = (l, got, exp, ok) => console.log(`  ${ok ? "✅" : "❌"} ${l.padEnd(38)} got ${String(got).padEnd(22)} pre-registered ${exp}`);
console.log("\n════ RESULT, BESIDE THE PRE-REGISTRATION ════");
line("P1 delivered (Transfer event)", delivered, `${VALUE}`, delivered === VALUE);
line("P2 seller balance delta", sellerAfter - sellerBefore, `${VALUE} - gas`, sellerAfter - sellerBefore < VALUE);
line("P3 payer balance delta", payerAfter - payerBefore, `-${VALUE}`, payerAfter - payerBefore === -VALUE);
console.log(`     gas paid by seller (no Transfer event) = ${VALUE - (sellerAfter - sellerBefore)} atomic`);
const gasAtomic = VALUE - (sellerAfter - sellerBefore);
console.log(`     reconciles: ${delivered} delivered - ${gasAtomic} gas = ${sellerAfter - sellerBefore} delta`
  + (delivered !== null && delivered - gasAtomic === sellerAfter - sellerBefore ? "  ✅ closes" : "  ❌ DOES NOT CLOSE — units?"));
console.log("\n  P4/P5 LATENCY");
console.log(`     submit -> circle id : ${((tId - tSubmit) / 1000).toFixed(2)}s`);
console.log(`     submit -> mined     : ${((tMined - tSubmit) / 1000).toFixed(2)}s   <- what a payee waits for`);
console.log(`     sub-second? ${(tMined - tSubmit) < 1000 ? "YES" : "NO — this is a FINDING, recorded as measured, not retried"}`);
console.log(`     block ${parseInt(rcpt.blockNumber, 16)} @ ${new Date(parseInt(blk.timestamp, 16) * 1000).toISOString()}`);
console.log(`\n  balanceOf AFTER (from chain)   seller ${sellerAfter}   payer ${payerAfter}`);
console.log(`  tx ${txHash}\n`);

