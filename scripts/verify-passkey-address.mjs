#!/usr/bin/env node
// verify-passkey-address.mjs — the server-side passkey address derivation (netlify/functions/_passkey-address.mjs).
//
//   node scripts/verify-passkey-address.mjs                       offline: SDK parity + the 0xfd80 on-chain fixture
//   node scripts/verify-passkey-address.mjs --onchain             + 0xfd80's deployment calldata and the factory's
//                                                                   getAddress view, on Arc testnet AND mainnet
//   node scripts/verify-passkey-address.mjs --records <file.jsonl> + stored credentials ({key, rec:{publicKey,address}}
//                                                                   per line); prints MATCH / MISMATCH per record
//
// ═══ WHY (2026-09-30) ══════════════════════════════════════════════════════════════════════════════
// auth-verify's passkey registration took the CLIENT's address (ab85757 → mitigated 94ef870). The proper fix: the server
// DECIDES the address from the key. A Circle MSCA's address is a pure CREATE2 of the P-256 key (factory, salt 0,
// sender = keccak(x, y), the weighted-webauthn plugin as sole owner). The SDK computes it as the INTERNAL, unexported
// computeAddress(owner); the browser instead asks Circle (circle_getAddress). So this suite pins our copy to BOTH: the
// SDK's own function (loaded from its dist) and the chain.
// ⛔ The 16 real stored credentials are NOT committed as a fixture — a public key IS its account's identity. Run
//    --records against a read-only dump instead (measured 2026-09-30: 16 match, 3 mismatch = the 07-03 test artifacts).

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const t = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : String(a));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { derivePasskeyAddress, PASSKEY_ACCOUNT } = await import("../netlify/functions/_passkey-address.mjs");
const { p256 } = await import("@noble/curves/p256");
const { toWebAuthnAccount } = await import("viem/account-abstraction");
const { keccak256 } = await import("viem");

// The SDK's internal computeAddress: copy its dist beside node_modules (so bare imports resolve) + export the internals.
const SDK_DIST = join(ROOT, "node_modules/@circle-fin/modular-wallets-core/dist/index.mjs");
const PARITY_DIR = join(ROOT, "node_modules/.cache/passkey-address-parity");
mkdirSync(PARITY_DIR, { recursive: true });
writeFileSync(join(PARITY_DIR, "sdk.mjs"), readFileSync(SDK_DIST, "utf8") +
  "\nexport { computeAddress as __computeAddress, FACTORY as __FACTORY, UPGRADABLE_MSCA as __MSCA, CIRCLE_WEIGHTED_WEB_AUTHN_MULTISIG_PLUGIN as __PLUGIN, ERC1769_PROXY as __PROXY, getSenderForContract as __sender, getSalt as __salt, getInitializeUpgradableMSCAParams as __initParams };\n");
const SDK = await import(join(PARITY_DIR, "sdk.mjs"));
rmSync(PARITY_DIR, { recursive: true, force: true });
const sdkDerive = (publicKey) => SDK.__computeAddress(toWebAuthnAccount({ credential: { id: "x", publicKey } })).toLowerCase();

const newKey = (prefixed = true) => { const pub = Buffer.from(p256.getPublicKey(p256.utils.randomPrivateKey(), false)).toString("hex"); return "0x" + (prefixed ? pub : pub.slice(2)); };

// 0xfd80…5767 — DEFAULT_PROBE_OWNER; its key recovered from its own deployment's createAccount calldata
// (Arc testnet tx 0x06fd55e20afb6d324c85843f954ca3a387025c2cc3aac1e512b2aeaef2088ef5). Public on chain.
const FD80 = { address: "0xfd801d082479e69f93bf79ccbf5f9dfe3c615767", publicKey: "0x04014bc4cdd76c5a126617c6e087587a0f8e07a9ca0061dc3ea5726866d8b5801ccfadf2ba158744431130796a0a349923485324438378bca4c934a251b388a9b7",
  deployTx: "0x06fd55e20afb6d324c85843f954ca3a387025c2cc3aac1e512b2aeaef2088ef5" };

section("The pinned constants ARE the installed SDK's");
{
  ok("factory", PASSKEY_ACCOUNT.factory.toLowerCase() === SDK.__FACTORY.address.toLowerCase(), PASSKEY_ACCOUNT.factory);
  ok("MSCA implementation", PASSKEY_ACCOUNT.implementation.toLowerCase() === SDK.__MSCA.address.toLowerCase());
  ok("webauthn plugin address", PASSKEY_ACCOUNT.plugin.toLowerCase() === SDK.__PLUGIN.address.toLowerCase());
  ok("webauthn plugin manifest hash", PASSKEY_ACCOUNT.pluginManifestHash.toLowerCase() === SDK.__PLUGIN.manifestHash.toLowerCase());
  ok("ERC-1967 proxy creation code (keccak)", keccak256(PASSKEY_ACCOUNT.proxyCreationCode) === keccak256(SDK.__PROXY.creationCode));
}

section("⭐ Parity with the SDK's own computeAddress — 200 random keys, both key encodings");
{
  let same = 0, bad = [];
  for (let i = 0; i < 200; i++) {
    const k = newKey(i % 2 === 0);
    const ours = derivePasskeyAddress(k), sdk = sdkDerive(k);
    if (ours === sdk) same++; else bad.push([k.slice(0, 12), ours, sdk]);
  }
  ok("⭐⭐ 200/200 identical to the SDK (lowercase)", same === 200, JSON.stringify(bad.slice(0, 2)));
  const k = newKey(true);
  ok("0x04‖x‖y and 0x‖x‖y derive the SAME address", derivePasskeyAddress(k) === derivePasskeyAddress("0x" + k.slice(4)));
  ok("the result is lowercase", /^0x[0-9a-f]{40}$/.test(derivePasskeyAddress(k)));
}

section("⭐ 0xfd80…5767 — a real account, its key taken from its own on-chain deployment");
{
  ok("⭐⭐ derive(0xfd80's key) = 0xfd80…5767", derivePasskeyAddress(FD80.publicKey) === FD80.address, derivePasskeyAddress(FD80.publicKey));
  ok("…and the SDK agrees", sdkDerive(FD80.publicKey) === FD80.address);
}

section("Malformed keys THROW — never an address");
{
  const bad = { "undefined": undefined, "empty": "", "not hex": "0xzz" + "0".repeat(126), "short": "0x04" + "11".repeat(40),
    "long": "0x04" + "11".repeat(65), "no 0x": FD80.publicKey.slice(2), "wrong prefix 0x02": "0x02" + FD80.publicKey.slice(4),
    "number": 5, "off-curve point": "0x04" + "11".repeat(64) };
  for (const [name, v] of Object.entries(bad)) {
    let threw = false; try { derivePasskeyAddress(v); } catch { threw = true; }
    ok(`${name} → throws`, threw);
  }
}

if (process.argv.includes("--onchain")) {
  const { createPublicClient, http, decodeFunctionData, decodeAbiParameters } = await import("viem");
  const { entryPoint07Abi } = await import("viem/account-abstraction");
  // The testnet RPC comes from the app-server's own source (the chain-literal guard: one source per package).
  const { ARC } = await import("../netlify/functions/_arc.mjs");
  const ARC_MAINNET_RPC = "https://rpc.mainnet.arc.io"; // Arc mainnet 5042 — the factory is deployed at the same address
  section("--onchain: 0xfd80's deployment calldata + the factory's getAddress view");
  const tn = createPublicClient({ transport: http(ARC.rpc) });
  let tx = null;
  try { tx = await tn.getTransaction({ hash: FD80.deployTx }); } catch (e) { console.log("   rpc getTransaction:", e.shortMessage || e.message); }
  if (!tx) {
    const r = await (await fetch(`https://explorer.testnet.arc.io/api/v2/transactions/${FD80.deployTx}`)).json();
    tx = { input: r.raw_input ?? r.input };
  }
  const op = decodeFunctionData({ abi: entryPoint07Abi, data: tx.input }).args[0][0];
  const fdata = decodeFunctionData({ abi: SDK.__FACTORY.abi, data: "0x" + op.initCode.slice(42) });
  const installs = decodeAbiParameters([{ type: "address[]" }, { type: "bytes32[]" }, { type: "bytes[]" }], fdata.args[2])[2];
  const pk = decodeAbiParameters([{ type: "address[]" }, { type: "uint256[]" }, { type: "tuple[]", components: [{ name: "x", type: "uint256" }, { name: "y", type: "uint256" }] }, { type: "uint256[]" }, { type: "uint256" }], installs[0])[2][0];
  const onchainKey = "0x04" + pk.x.toString(16).padStart(64, "0") + pk.y.toString(16).padStart(64, "0");
  ok("the deployment's sender is 0xfd80…5767", op.sender.toLowerCase() === FD80.address);
  ok("the key in its createAccount calldata = the pinned fixture key", onchainKey.toLowerCase() === FD80.publicKey.toLowerCase());
  ok("⭐ derive(that key) = the deployed sender", derivePasskeyAddress(onchainKey) === op.sender.toLowerCase());
  const owner = toWebAuthnAccount({ credential: { id: "x", publicKey: FD80.publicKey } });
  for (const [name, url] of [["Arc testnet", ARC.rpc], ["Arc mainnet 5042", ARC_MAINNET_RPC]]) {
    try {
      const c = createPublicClient({ transport: http(url) });
      const [addr] = await c.readContract({ address: PASSKEY_ACCOUNT.factory, abi: SDK.__FACTORY.abi, functionName: "getAddress", args: [SDK.__sender(owner), SDK.__salt(), SDK.__initParams(owner)] });
      ok(`⭐ ${name}: factory.getAddress(0xfd80's key) = derive(key)`, addr.toLowerCase() === derivePasskeyAddress(FD80.publicKey), addr);
      const rk = newKey(true); const o2 = toWebAuthnAccount({ credential: { id: "x", publicKey: rk } });
      const [a2] = await c.readContract({ address: PASSKEY_ACCOUNT.factory, abi: SDK.__FACTORY.abi, functionName: "getAddress", args: [SDK.__sender(o2), SDK.__salt(), SDK.__initParams(o2)] });
      ok(`${name}: factory.getAddress(a random key) = derive(key)`, a2.toLowerCase() === derivePasskeyAddress(rk), a2);
    } catch (e) { ok(`${name}: factory view readable`, false, e.shortMessage || e.message); }
  }
}

const ri = process.argv.indexOf("--records");
if (ri > 0) {
  section(`--records ${process.argv[ri + 1]}`);
  let m = 0, mm = 0;
  for (const line of readFileSync(process.argv[ri + 1], "utf8").trim().split("\n")) {
    const { rec } = JSON.parse(line);
    const d = derivePasskeyAddress(rec.publicKey), same = d === String(rec.address).toLowerCase();
    same ? m++ : mm++;
    console.log(`   ${rec.createdAt}  stored ${t(rec.address)}  derived ${t(d)}  ${same ? "MATCH" : "⛔ MISMATCH"}`);
  }
  console.log(`   → ${m} match, ${mm} mismatch (a record's verdict, not a suite failure)`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-passkey-address — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
