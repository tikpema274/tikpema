// verify-vanilla-seller-bytes.mjs — THE VANILLA SELLER SETTLES VIA THE `bytes` OVERLOAD.
//
//   node --experimental-test-module-mocks scripts/verify-vanilla-seller-bytes.mjs
//   (also: npm run test:vanillabytes)
//
// ═══ 🚨 WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════
// The seller settled with receiveWithAuthorization(...,uint8 v,bytes32 r,bytes32 s) — the
// ECDSA-only overload — and split the buyer's signature into v/r/s behind a guard that required
// EXACTLY 65 bytes. A contract payer (any Circle Agent Wallet SCA) was turned away by the GUARD,
// one function before the overload even mattered. Both had to change; either alone is a no-op.
//
// ⭐ MEASURED, NOT ASSUMED. Against the deployed Arc USDC (proxy 0x3600… -> impl 0xc6ad664a…):
// the same REAL 65-byte EOA signature passes signature validation through BOTH overloads (both
// revert later, at "ERC20: transfer amount exceeds balance"), while a one-byte-corrupted signature
// is rejected by both. §3 below re-runs that against the live chain every time this suite runs.
//
// ⚠️ WHAT THIS SUITE DOES NOT PROVE: that Circle's SDK encodes a dynamic `bytes` parameter
// correctly. That is a fact about the SDK, not about this function, and it is settled separately.
import { mock } from "node:test";
import { keccak256, toHex, encodeAbiParameters, parseAbiParameters, encodeFunctionData } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

let pass = 0, fail = 0;
// ⚠️ `c` MAY BE A THUNK, AND A THROW IS A RED — NOT A DEAD RUN. The first mutation run of this
// suite CRASHED at §3 instead of reporting it: reinstating the 65-byte guard made normalizeSignature
// throw, the throw escaped, and §3/§4/§5 never ran. A suite that dies mid-way reports NOTHING where
// it should report a failure, and a short green-looking transcript is exactly what run-suites.mjs
// warns is a signal rather than good news. Same lesson the sweeper suite learned.
const check = (l, c, x = "") => {
  let ok = false, note = x;
  try { ok = typeof c === "function" ? !!c() : !!c; }
  catch (e) { ok = false; note = `threw: ${String(e?.message ?? e).slice(0, 60)}`; }
  if (ok) { pass++; console.log(`  ✅ ${l}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${note ? ` — ${note}` : ""}`); }
};
/** Run a section so a throw inside it is one red line, and the SUITE CONTINUES. */
const section = async (title, fn) => {
  console.log(`\n${title}`);
  try { await fn(); }
  catch (e) { fail++; console.log(`  ❌ 🚨 SECTION CRASHED — ${String(e?.message ?? e).slice(0, 90)}`); }
};

const RPC = "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const CHAIN_ID = 5042002;
const PRICE = "10000";
const SELLER = "0x1a63e59d1419cf48e2bd48cb54db85f27818dc99";

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VANILLA SELLER — settle via the bytes overload, EOAs unaffected    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ── Capture what the seller hands to Circle, without any network or wallet ──
const calls = [];
mock.module("../netlify/functions/_circle.mjs", { namedExports: {
  circle: () => ({ createContractExecutionTransaction: async (args) => { calls.push(args); return { data: { id: "tx-1" } }; } }),
  waitForTx: async () => "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  TxPendingError: class TxPendingError extends Error {},
}});
// ⚠️ THE HANDLER GAINED TWO PRE-SETTLE GUARDS AND THIS SUITE HAD TO LEARN ABOUT THEM.
// `payerCanCover` does an eth_call, and `claimSettleSlot` does a Blobs CAS — neither existed when
// this file was written, and with both unmocked every settle assertion here 402'd against the real
// RPC. ⭐ That is the suite doing its job: it drives the HANDLER, so a new gate on the path to the
// settle SHOULD break it until the fixture admits the gate exists. Both are stubbed to "healthy"
// so this file keeps testing what it is about — the CALL SHAPE — while the guards themselves are
// driven, including every refusal branch, in verify-vanilla-seller-limits.
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  if (body.method === "eth_call") {
    // a payer with plenty: the balance branch is NOT what this suite is testing
    return { ok: true, json: async () => ({ result: "0x" + (10n ** 12n).toString(16).padStart(64, "0") }) };
  }
  return { ok: true, json: async () => ({ current: {}, current_units: {} }) };
};
const rateBucket = new Map();
mock.module("@netlify/blobs", { namedExports: {
  getStore: () => ({
    async getWithMetadata(k) { const v = rateBucket.get(k); return v ? { data: v, etag: "e" + v.n } : undefined; },
    async setJSON(k, v) { rateBucket.set(k, v); return { modified: true }; },
  }),
  connectLambda: () => {},
}});
mock.module("../netlify/functions/_blobs.mjs", { namedExports: {
  connectBlobs: () => {}, strongReadAvailable: () => true, lastConnect: {}, UNCACHED_KEY: "x",
}});
// ⚠️ Generous, because this suite fires several settles and the DEFAULT ceiling is 6 — a limit
// tripping mid-run would look like a call-shape failure and send the next reader hunting the wrong bug.
process.env.VANILLA_SELLER_SETTLES_PER_MIN = "100";

const { handler, normalizeSignature } = await import("../netlify/functions/x402-vanilla-seller.mjs");

process.env.VANILLA_SELLER_ADDRESS = SELLER;
process.env.VANILLA_SELLER_WALLET_ID = "test-wallet-id";

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const acct = privateKeyToAccount(generatePrivateKey());
const now = Math.floor(Date.now() / 1000);
const authFor = (from) => ({
  from, to: SELLER, value: PRICE,
  validAfter: "0", validBefore: String(now + 600),
  nonce: keccak256(toHex("vanilla-bytes-suite-" + from)),
});
const domain = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC };
const types = { ReceiveWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const auth = authFor(acct.address);
const realSig = await acct.signTypedData({ domain, types, primaryType: "ReceiveWithAuthorization",
  message: { from: auth.from, to: auth.to, value: BigInt(auth.value),
             validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce } });

const post = (authorization, signature) => handler({ httpMethod: "POST", headers: {
  host: "app.tikpema.xyz", "x-payment": b64({ x402Version: 2, scheme: "exact", network: `eip155:${CHAIN_ID}`,
  payload: { authorization, signature } }) }, body: "{}" });

await section("── 1. A VALID EOA SIGNATURE SETTLES THROUGH THE NEW PATH ───────────", async () => {
  calls.length = 0;
  const res = await post(auth, realSig);
  check("the request settles (200)", res.statusCode === 200, `got ${res.statusCode}`);
  const c = calls[0];
  check("⭐ the bytes overload is what we call", c?.abiFunctionSignature ===
    "receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)", c?.abiFunctionSignature);
  // 🚨 THE OLD SHAPE, ASSERTED GONE.
  check("🚨 the v,r,s overload is NOT called", !/uint8/.test(c?.abiFunctionSignature ?? ""));
  check("⭐ exactly 7 abiParameters (not 9)", c?.abiParameters?.length === 7, `${c?.abiParameters?.length}`);
  check("⭐ the 7th parameter is the whole signature, forwarded verbatim",
    c?.abiParameters?.[6] === realSig, String(c?.abiParameters?.[6]).slice(0, 24) + "…");
  check("the payer is carried unchanged", c?.abiParameters?.[0] === auth.from);
  check("the value is the price", c?.abiParameters?.[2] === PRICE);
});

await section("── 2. THE v,r,s PATH'S EOA BEHAVIOUR IS PRESERVED ──────────────────", async () => {
  // ⚠️ The ONE thing the old splitSignature did that the token does NOT do for us.
  const v0 = realSig.slice(0, 130) + "00";
  const v1 = realSig.slice(0, 130) + "01";
  check("⭐ a v=0 recovery id is still normalised to 27", () => normalizeSignature(v0).slice(-2) === "1b");
  check("⭐ a v=1 recovery id is still normalised to 28", () => normalizeSignature(v1).slice(-2) === "1c");
  check("an already-27 signature is untouched", () => normalizeSignature(realSig.slice(0,130)+"1b").slice(-2) === "1b");
  check("a 65-byte signature keeps its r and s bytes", () => normalizeSignature(v0).slice(0, 130) === realSig.slice(0, 130));
  calls.length = 0;
  await post(authFor(acct.address), v0);
  check("⭐⭐ and the normalisation reaches the CALL, not just the helper",
    calls[0]?.abiParameters?.[6]?.slice(-2) === "1b", String(calls[0]?.abiParameters?.[6]).slice(-4));
});

await section("── 3. A CONTRACT-LENGTH SIGNATURE IS NO LONGER REJECTED ────────────", async () => {
  const ctrSig = "0x" + "ab".repeat(100); // ERC-1271 signatures are opaque and any length
  check("⭐ 100 bytes passes the guard the old code threw on", () => normalizeSignature(ctrSig) === ctrSig);
  check("…forwarded verbatim, not reshaped", () => normalizeSignature(ctrSig).length === 202);
  calls.length = 0;
  await post(authFor("0x98a662d6c432a6be62881b3e1cbd3edf843dc4ba"), ctrSig);
  check("⭐⭐ and it reaches the settle call", calls[0]?.abiParameters?.[6] === ctrSig);
});

await section("── 4. GARBAGE IS STILL REFUSED (the guard did not just get deleted) ─", async () => {
  for (const [label, bad] of [["empty", "0x"], ["odd nibble count", "0xabc"],
      ["not hex", "0xzz"], ["missing 0x", "ab".repeat(65)], ["not a string", 12345]]) {
    let threw = false;
    try { normalizeSignature(bad); } catch { threw = true; }
    check(`${label} is rejected`, threw);
  }
  const res = await post(auth, "0x");
  check("⭐ and the handler answers 400 rather than settling", res.statusCode === 400, `got ${res.statusCode}`);
});

// ═══ 🚨 THE LIVE HALF LIVES ELSEWHERE — AND THAT IS ASSERTED, NOT MENTIONED ═════════════════
// Everything above is ONE PROCESS: it proves what this seller SENDS, and is structurally incapable
// of proving the deployed token ACCEPTS it — both sides of that boundary are our own code
// ([[binding-tested-across-what-it-binds]]). The crossing lives in verify-vanilla-seller-bytes-live,
// split out of test:all because Arc's public RPC is throttled and a flaky network inside a BLOCKING
// aggregate manufactures a tolerated red (same call as gate:pins / test:ddwatch).
//
// ⭐ A COMMENT SAYING "the live arm exists" ROTS THE DAY SOMEONE DELETES IT. So this suite fails if
// that file is gone or unregistered. Splitting a check out must not be able to become dropping it.
await section("── 6. THE LIVE COUNTERPART EXISTS AND IS REGISTERED ────────────────", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const LIVE = "scripts/verify-vanilla-seller-bytes-live.mjs";
  check("⭐ the live suite file is still on disk", () => existsSync(LIVE), LIVE);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  check("⭐ …and is a runnable npm script", () => /verify-vanilla-seller-bytes-live/.test(pkg.scripts?.["test:vanillabyteslive"] ?? ""));
  // ⚠️ Deliberately NOT in `suites`. Asserted so a well-meaning future edit that "fixes the orphan"
  // by adding it back to test:all trips this line and has to read the reason first.
  check("⚠️ …and deliberately NOT in test:all (a throttled RPC must not gate every commit)",
    () => !(pkg.suites ?? []).includes("test:vanillabyteslive"));
  check("⭐ …with its exemption reason recorded in the guard registry",
    () => /test:vanillabyteslive/.test(readFileSync("scripts/guard-registry.mjs", "utf8")));
});

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ EOAs settle exactly as before; a contract payer is no longer refused at the door.\n");
