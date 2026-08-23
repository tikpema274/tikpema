// verify-vanilla-seller-bytes-live.mjs — THE LIVE HALF: does the DEPLOYED token accept what we send?
//
//   node scripts/verify-vanilla-seller-bytes-live.mjs      (also: npm run test:vanillabyteslive)
//
// ═══ ⭐ WHY THIS IS SPLIT OUT OF test:all ═══════════════════════════════════════════════════════
// It talks to Arc's PUBLIC RPC, which this repo has recorded as throttled and which produced a real
// ETIMEDOUT on 2026-08-23 mid-way through a money-path script. A flaky network inside a BLOCKING
// aggregate manufactures a tolerated red — species 3, the worst outcome the guard registry exists to
// end — so this runs deliberately rather than on every commit. Same reasoning as `gate:pins` and
// `test:ddwatch`, and it is declared in UNWIRED_OK with that reason.
//
// 🚨 SPLITTING IT OUT IS NOT THE SAME AS DROPPING IT, AND THE DIFFERENCE HAS TO BE VISIBLE.
// `test:vanillabytes` (in test:all) proves what we SEND: the bytes overload, seven parameters, the
// signature forwarded verbatim, the v=0/1 normalisation preserved. It is structurally incapable of
// proving the TOKEN accepts it — both sides of that boundary are our own code
// ([[binding-tested-across-what-it-binds]]). This file is the only thing that crosses it, so the
// in-process suite ASSERTS THIS FILE EXISTS AND IS REGISTERED rather than mentioning it in a comment
// a reader can miss and time can rot.
//
// ⚠️ AN UNREACHABLE RPC IS A LOUD RED, NEVER A SKIP. "Could not check" and "checked, fine" must not
// look alike — that is the absence-reads-as-safety family this repo keeps re-learning. If the RPC is
// down, this exits non-zero saying so in those words.
import { keccak256, toHex, encodeAbiParameters, parseAbiParameters, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const RPC = "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042002;
const SELLER = "0x1a63e59d1419cf48e2bd48cb54db85f27818dc99";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  let ok = false, note = x;
  try { ok = typeof c === "function" ? !!c() : !!c; }
  catch (e) { ok = false; note = `threw: ${String(e?.message ?? e).slice(0, 60)}`; }
  if (ok) { pass++; console.log(`  ✅ ${l}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${note ? ` — ${note}` : ""}`); }
};

// ⚠️ Reads retry: a throttled RPC must not be able to report a false failure either.
const rpc = async (method, params, tries = 4) => {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      return await r.json();
    } catch (e) { last = e; await new Promise((res) => setTimeout(res, 1500 * (i + 1))); }
  }
  throw new Error(`Arc RPC unreachable after ${tries} attempts: ${String(last?.message ?? last).slice(0, 80)}`);
};

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  LIVE — the deployed Arc USDC accepts what the seller now sends     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

try {
  console.log("\n── 0. CALIBRATION FIRST, or the rest proves the opposite of what it says ──");
  const TYPEHASH = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const local = keccak256(encodeAbiParameters(parseAbiParameters("bytes32, bytes32, bytes32, uint256, address"),
    [TYPEHASH, keccak256(toHex("USDC")), keccak256(toHex("2")), BigInt(CHAIN_ID), USDC]));
  const chain = (await rpc("eth_call", [{ to: USDC, data: "0x3644e515" }, "latest"])).result;
  // 🚨 A signature over the wrong domain fails for the wrong reason, and every assertion below
  // would then "prove" the token rejects us when in fact we asked it the wrong question.
  check("⭐ our EIP-712 domain reproduces the token's real DOMAIN_SEPARATOR",
    local.toLowerCase() === String(chain).toLowerCase(), local.slice(0, 20) + "…");

  console.log("\n── 1. A REAL EOA SIGNATURE IS ACCEPTED BY THE `bytes` OVERLOAD ─────");
  const acct = privateKeyToAccount(generatePrivateKey());   // zero balance by construction
  const now = Math.floor(Date.now() / 1000);
  const msg = { from: acct.address, to: SELLER, value: 10000n, validAfter: 0n,
    validBefore: BigInt(now + 600), nonce: keccak256(toHex("live-suite-" + acct.address)) };
  const sig = await acct.signTypedData({ domain: { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC },
    types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" },
      { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    primaryType: "ReceiveWithAuthorization", message: msg });

  const ABI = [{ name: "receiveWithAuthorization", type: "function", stateMutability: "nonpayable", outputs: [],
    inputs: [{name:"from",type:"address"},{name:"to",type:"address"},{name:"value",type:"uint256"},
      {name:"validAfter",type:"uint256"},{name:"validBefore",type:"uint256"},{name:"nonce",type:"bytes32"},
      {name:"signature",type:"bytes"}] }];
  const args = [msg.from, msg.to, msg.value, msg.validAfter, msg.validBefore, msg.nonce];
  const call = async (s) => {
    const data = encodeFunctionData({ abi: ABI, functionName: "receiveWithAuthorization", args: [...args, s] });
    // ⚠️ from = the payee: receiveWithAuthorization enforces msg.sender == to.
    const j = await rpc("eth_call", [{ from: SELLER, to: USDC, data }, "latest"]);
    return j.error ? (j.error.message || "").replace(/^execution reverted:?\s*/, "") : null;
  };
  const rejected = (m) => m !== null && /invalid signature|ECRecover/i.test(m);
  const good = await call(sig);
  const bad = await call(sig.slice(0, -2) + (sig.slice(-2) === "1b" ? "1c" : "1b"));
  check("⭐⭐ the real EOA signature gets PAST signature validation",
    !rejected(good), good === null ? "no revert" : good);
  // ⚠️ WITHOUT THIS, AN RPC THAT REVERTED ON EVERYTHING WOULD PASS THE LINE ABOVE.
  check("⚠️ …and a corrupted one is REJECTED, so the probe discriminates", rejected(bad), bad);

  console.log("\n── 2. THE CONTRACT BRANCH AN SCA NEEDS STILL EXISTS ────────────────");
  // A contract `from` must NOT take the ECRecover path — that branch is the whole reason for the
  // overload swap. Any deployed contract works as the probe; the Gateway Wallet is a known one.
  const CTR = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
  const ctrData = encodeFunctionData({ abi: ABI, functionName: "receiveWithAuthorization",
    args: [CTR, SELLER, 10000n, 0n, BigInt(now + 600), msg.nonce, "0x" + "ab".repeat(100)] });
  const j = await rpc("eth_call", [{ from: SELLER, to: USDC, data: ctrData }, "latest"]);
  const ctrErr = j.error ? (j.error.message || "").replace(/^execution reverted:?\s*/, "") : null;
  check("⭐ a CONTRACT `from` never reaches ECRecover", !/ECRecover/i.test(String(ctrErr)), ctrErr);
  check("  …and signature LENGTH is irrelevant there (100 bytes, not 65)", ctrErr !== null);
} catch (e) {
  // 🚨 "Could not check" must never look like "checked, fine".
  fail++;
  console.log(`\n  ❌ 🚨 COULD NOT CHECK — ${String(e?.message ?? e).slice(0, 120)}`);
  console.log("     This is NOT a pass. The deployed token's behaviour is UNVERIFIED by this run.");
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ The token accepts our EOA signatures, and still branches for contract payers.\n");
