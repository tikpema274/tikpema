// spike-vanilla-zero-balance-grief.mjs — DOES THE CREATE PATH REJECT A ZERO-BALANCE PAYER?
//
//   node scripts/spikes/spike-vanilla-zero-balance-grief.mjs
//
// ═══ 🚨 THE OPEN INFERENCE THIS CLOSES ═══════════════════════════════════════════════════════
// x402-vanilla-seller is now ARMED and publicly reachable. Its pre-settle guards check scheme,
// network, asset, `to`, value, `from` presence and the time window — but NOT whether the payer
// actually HOLDS the USDC. So a crafted authorization from an empty address passes every guard and
// reaches the settle call, where the seller submits and pays gas out of its own balance.
//
// ⚠️ THE MITIGATION WAS ASSERTED, NOT MEASURED. Circle's estimation was observed to reject a
// zero-balance payer — but on `estimateContractExecutionFee`, a DIFFERENT ENDPOINT from
// `createContractExecutionTransaction`, which is what the seller actually calls. This repo's
// step-4b spike saw an "ESTIMATION-REJECTED" class on the create path (id issued, FAILED, no hash),
// which is suggestive and is not the same as having measured it here.
//
// ⭐ TESTED THROUGH THE LIVE ENDPOINT, not the SDK, because the endpoint IS the attack surface.
// Anyone on the internet can do exactly what this script does.
//
// ═══ THE DISCRIMINATOR IS ON-CHAIN, NOT IN THE HTTP RESPONSE ═════════════════════════════════
// ⭐⭐ `eth_getTransactionCount(seller)` increments ONLY if a transaction was really broadcast.
// A balance check alone is weaker: unchanged balance is consistent with "no broadcast" AND with
// "broadcast but gas somehow free". The nonce is the clean signal, and the balance corroborates it.
import { keccak256, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const RPC = "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const SELLER_URL = "https://app.tikpema.xyz/.netlify/functions/x402-vanilla-seller";
const CHAIN_ID = 5042002;

const rpc = async (m, p, tries = 4) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) });
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error));
      return j.result;
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw last;
};
const balOf = async (a) => BigInt(await rpc("eth_call", [{ to: USDC, data: "0x70a08231000000000000000000000000" + a.slice(2) }, "latest"]));
const nonceOf = async (a) => parseInt(await rpc("eth_getTransactionCount", [a, "latest"]), 16);

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  Does the CREATE path reject a zero-balance payer, or burn gas?     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

// ── 1. the seller's own challenge, so nothing is hardcoded ──
const chRes = await fetch(SELLER_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const ch = await chRes.json();
const req = ch.accepts?.[0];
if (chRes.status !== 402 || !req) { console.error(`🚨 expected 402 + accepts[], got ${chRes.status}. Seller not armed?`); process.exit(1); }
const SELLER = req.payTo;
console.log(`  seller ${SELLER}   price ${req.amount}   fn ${req.extra.eip3009Function}`);

const before = { bal: await balOf(SELLER), nonce: await nonceOf(SELLER) };
const payer = privateKeyToAccount(generatePrivateKey());
const payerBal = await balOf(payer.address);

console.log("\n════ PRE-REGISTERED, BEFORE ANYTHING IS SENT ════");
console.log(`  payer ${payer.address} holds ${payerBal} atomic — MUST be 0 or this proves nothing`);
console.log(`  P1  seller nonce   ${before.nonce}  -> UNCHANGED   (a broadcast would increment it)`);
console.log(`  P2  seller balance ${before.bal}  -> UNCHANGED   (no gas burned)`);
console.log(`  P3  HTTP response  -> an ERROR, never 200 with the paid data`);
console.log(`  🚨 IF THE NONCE INCREMENTS, THE GRIEFING VECTOR IS REAL and the mitigation is a myth.\n`);
if (payerBal !== 0n) { console.error("🚨 throwaway payer is not empty — aborting, the test would be meaningless"); process.exit(1); }

// ── 2. a REAL signature over the token's real domain, from the empty account ──
const now = Math.floor(Date.now() / 1000);
const auth = { from: payer.address, to: SELLER, value: req.amount, validAfter: "0",
  validBefore: String(now + 300), nonce: keccak256(toHex("grief-probe-" + payer.address)) };
const primaryType = req.extra.eip3009Function === "receiveWithAuthorization" ? "ReceiveWithAuthorization" : "TransferWithAuthorization";
const signature = await payer.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId: CHAIN_ID, verifyingContract: req.asset },
  types: { [primaryType]: [{ name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType,
  message: { from: auth.from, to: auth.to, value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
});
console.log(`  signed a VALID authorization for ${auth.value} atomic from an EMPTY account`);

// ── 3. send it exactly as an attacker would ──
const xPayment = Buffer.from(JSON.stringify({ x402Version: 2, scheme: req.scheme,
  network: req.network, payload: { authorization: auth, signature } }), "utf8").toString("base64");
const t0 = Date.now();
const res = await fetch(SELLER_URL, { method: "POST",
  headers: { "content-type": "application/json", "X-PAYMENT": xPayment }, body: "{}" });
const bodyText = await res.text();
console.log(`\n  → HTTP ${res.status} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`     ${bodyText.slice(0, 220)}`);

// ── 4. the on-chain truth, after a settle window ──
await new Promise(r => setTimeout(r, 15000));
const after = { bal: await balOf(SELLER), nonce: await nonceOf(SELLER) };
const line = (l, ok, got) => console.log(`  ${ok ? "✅" : "❌"} ${l.padEnd(44)} ${got}`);
console.log("\n════ RESULT, BESIDE THE PRE-REGISTRATION ════");
line("P1 seller nonce UNCHANGED (nothing broadcast)", after.nonce === before.nonce, `${before.nonce} -> ${after.nonce}`);
line("P2 seller balance UNCHANGED (no gas burned)", after.bal === before.bal, `${before.bal} -> ${after.bal}`);
line("P3 the buyer did NOT receive the goods", res.status !== 200, `HTTP ${res.status}`);
const safe = after.nonce === before.nonce && after.bal === before.bal;
console.log(`\n  ${safe ? "✅ MITIGATION HOLDS — the create path never broadcast; the griefing vector costs the seller nothing."
                       : `🚨 GRIEFING VECTOR IS REAL — the seller spent ${before.bal - after.bal} atomic on a payment it never received.`}\n`);
