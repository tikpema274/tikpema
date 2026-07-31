// verify-attestation.mjs — the two-halves acceptance test for report attestation (canon/1 + ERC-1271).
//
// THE TWO HALVES, and why both are required (the rule from scripts/verify-vault-degraded.mjs):
//   A byte-identical healthy path proves the thing BROKE NOTHING.
//   Only FAULT INJECTION proves it DOES ANYTHING.
// A signing layer that never rejects is indistinguishable from a signing layer that always returns
// true, and the second one is worse than none at all.
//
//   node scripts/dd/verify-attestation.mjs           # offline. Zero network, zero money, zero Circle.
//   node --env-file=.env scripts/dd/verify-attestation.mjs --live   # + the real wallet and real chain
//
// ═══ WHY THE OFFLINE MOCK IS FAITHFUL, NOT A RUBBER STAMP ════════════════════════════════════
// The mock account does a REAL ecrecover over the REAL EIP-191 digest and compares against a REAL
// local keypair — which is precisely what circle_6900_singleowner_v3 does on-chain. It is a
// simulation of the account's logic, not a lookup table that answers "valid" because the test wants
// it to. Every fault below therefore fails for the same reason it would fail against the real SCA.

import { privateKeyToAccount } from "viem/accounts";
import { recoverAddress, keccak256, toBytes } from "viem";
import {
  canonicalize, signingMessage, attestationDigest, attachAttestation,
  verifyAttestation, unsignedAttestation, CANON_VERSION, DOMAIN,
} from "../../shared/onchain-analyze/attest.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);

const MAGIC = "0x1626ba7e";
const NOT_MAGIC = "0xffffffff";
const pad32 = (h) => h.replace(/^0x/, "").padStart(64, "0");
const word = (n) => pad32(BigInt(n).toString(16));

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────
// ⚠️ THESE TWO PRIVATE KEYS ARE PUBLIC BY DESIGN — NOT A LEAK, NOTHING TO ROTATE.
// They are the CANONICAL ANVIL / HARDHAT DEFAULT TEST KEYS, published verbatim in the
// Foundry and Hardhat docs and printed by `anvil` on every start. Every developer on earth
// already has them, which is exactly why they are safe to commit and why a secret scanner
// flagging them (gitleaks `generic-api-key`, on entropy) is a FALSE POSITIVE.
//
//   KEY       = anvil account #1 -> 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
//   OTHER_KEY = anvil account #5 -> 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
//
// They are used here ONLY as signing keypairs against mockClient() below — this suite makes
// no network calls and holds no funds. Nothing in this repo funds these addresses and no
// test depends on their balances. ⚠️ They DO carry Arc-testnet balance put there by faucets
// and other developers (they are a shared public sandbox); anyone can sweep it at any time.
// Never send anything you care about to them, and never reuse them for a real account.
//
// ⭐ RULE THIS ENCODES: a key in a repo is assumed real until proven otherwise. If you add
// another test keypair, say WHICH well-known key it is right here — the cost of the doubt
// lands on whoever reads this next, and on a public repo that is everyone.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OTHER_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
const owner = privateKeyToAccount(KEY);
const otherOwner = privateKeyToAccount(OTHER_KEY);

const SCA = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const AGENT_ID = "851891";

const baseFixture = () => ({
  schemaVersion: "onchain-analyze/0.1.0",
  severityMeaning: "scope-not-rank: …",
  subject: { address: "0x240eb85458cd41361bd8c3773253a1d78054f747", chainId: 5042002, chainName: "arc-testnet", blockNumber: 53647839 },
  shape: { class: "plain-contract", family: "vault", variant: null, scannedAddress: "0x240eb85458cd41361bd8c3773253a1d78054f747", evidence: { why: null } },
  owner: { address: "0x5b967871bb9b2ce1ac7e3a3a2ab2ec5c1e4b8a2f", kind: "eoa" },
  powers: [
    { power: "pausable", present: true, matched: [{ signature: "pause()", selector: "0x8456cb59" }], holder: "0x5b96…", holderKind: "eoa", severity: "access-restriction" },
    { power: "emergencyWithdraw", present: true, matched: [{ signature: "emergencyWithdraw()", selector: "0xdb2e21bc" }], holder: "0x5b96…", holderKind: "eoa", severity: "funds-movement" },
  ],
  powersPresent: ["emergencyWithdraw", "pausable"],
  sources: { mode: "quorum", endpoints: ["https://arc-testnet.drpc.org", "https://rpc.testnet.arc.network"], required: 2, independenceVerified: false, note: "Quorum covers PROVIDER integrity…" },
  coverage: {
    checked: [{ id: "power:pausable", kind: "power", group: "pausable" }, { id: "power:emergencyWithdraw", kind: "power", group: "emergencyWithdraw" }],
    notChecked: [{ id: "power:denylist", kind: "power", group: "denylist", reason: "not in this caller's scan selection" }],
    totals: { checked: 2, notChecked: 1 },
    summary: "2 checks ran, 1 did not.",
  },
  reads: [{ method: "eth_getCode", httpStatus: 200, retriedAttempts: 1, endpoint: "https://rpc.testnet.arc.network" }],
  refusal: null,
});

/** A faithful stand-in for circle_6900_singleowner_v3 + the IdentityRegistry.
 *
 *  `envelope` mirrors the REAL scripts/dd/client.mjs contract — `{ result, query, evidence }`, not a
 *  bare string. The live run caught this the hard way: the first version of this mock returned bare
 *  strings, the real client returned the envelope, and verifyAttestation correctly answered
 *  `indeterminate-rpc` rather than mis-verifying. Both shapes are now exercised. */
function mockClient({ ownerKey = owner, registryOwner = SCA, throwOn = null, envelope = true, garbage = false } = {}) {
  const wrap = (hex) => (garbage ? { unexpected: hex } : envelope ? { result: hex, query: {}, evidence: { httpStatus: 200 } } : hex);
  return {
    calls: 0,
    async call({ method, params }) {
      this.calls++;
      if (throwOn && String(params?.[0]?.data ?? "").startsWith(throwOn)) throw new Error("simulated RPC exhaustion");
      const to = String(params?.[0]?.to ?? "").toLowerCase();
      const data = String(params?.[0]?.data ?? "");
      if (to === REGISTRY && data.startsWith("0x6352211e")) return wrap("0x" + word(BigInt(registryOwner)));
      if (data.startsWith("0x1626ba7e")) {
        const body = data.slice(10);
        const digest = "0x" + body.slice(0, 64);
        const len = Number(BigInt("0x" + body.slice(128, 192)));
        const sig = "0x" + body.slice(192, 192 + len * 2);
        let rec;
        try { rec = await recoverAddress({ hash: digest, signature: sig }); } catch { return wrap(NOT_MAGIC + "0".repeat(56)); }
        return wrap((rec.toLowerCase() === ownerKey.address.toLowerCase() ? MAGIC : NOT_MAGIC) + "0".repeat(56));
      }
      throw new Error(`mock: unexpected call ${data.slice(0, 10)}`);
    },
  };
}

const signWith = (acct) => (message) => acct.signMessage({ message });
const IDENT = { agentId: AGENT_ID, verifyingContract: SCA, registry: REGISTRY, chainId: "5042002", keyId: "test" };

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  ATTESTATION ACCEPTANCE — canon/1 + ERC-1271, two halves             ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════════════════════ HALF 1 — HEALTHY ═══════════════════════════
section("HALF 1 — HEALTHY: it works, and it is deterministic");

const rpt = baseFixture();

check("canonicalize is byte-identical across two calls", canonicalize(rpt) === canonicalize(baseFixture()));
check("`reads` is EXCLUDED from the signed bytes", !canonicalize(rpt).includes("httpStatus"));
check("`coverage` IS inside the signed bytes", canonicalize(rpt).includes("notChecked"));
check("`sources.independenceVerified` IS inside the signed bytes", canonicalize(rpt).includes("independenceVerified"));
check("numbers become decimal STRINGS", canonicalize(rpt).includes('"blockNumber":"53647839"'));
check("hex is lowercased, never checksummed", canonicalize({ a: "0xAbCdEf01" }) === '{"a":"0xabcdef01"}');
check("prose containing 0x is NOT mangled", canonicalize({ a: "see 0xAB for detail" }).includes("see 0xAB for detail"));
check("keys are sorted (JCS)", canonicalize({ b: 1, a: 2 }) === '{"a":"2","b":"1"}');

let threw = null;
try { canonicalize({ a: undefined }); } catch (e) { threw = e; }
check("`undefined` THROWS rather than silently vanishing", !!threw);
threw = null;
try { canonicalize({ a: 1.5 }); } catch (e) { threw = e; }
check("a non-integer number THROWS (canon/1 has no float encoding)", !!threw);

const signed = await attachAttestation(rpt, { sign: signWith(owner), ...IDENT });
check("attestation.status is 'signed'", signed.attestation.status === "signed");
check("attestation.canon is canon/1", signed.attestation.canon === CANON_VERSION);
check("attestation.method is erc1271", signed.attestation.method === "erc1271");
check("durability caveat rides ON the attestation", /valid NOW/.test(signed.attestation.validityMeaning));
check("blockHashBound is declared false (pass 2 not built)", signed.attestation.blockHashBound === false);
check("signing did not mutate the input report", rpt.attestation === undefined);
check("`attestation` is excluded BY OBJECT from its own signed bytes", !canonicalize(signed).includes("eip191"));

const client = mockClient();
let v = await verifyAttestation(signed, { client, expect: { agentId: AGENT_ID } });
check("healthy → valid:true reason:ok", v.valid === true && v.reason === "ok", `reason=${v.reason}`);
check("verdict carries boundTo (freshness is the verifier's decision)", v.boundTo?.blockNumber === 53647839);
check("verdict carries the durability meaning", /valid NOW/.test(v.meaning));

const roundTripped = JSON.parse(JSON.stringify(signed));
v = await verifyAttestation(roundTripped, { client, expect: { agentId: AGENT_ID } });
check("survives a JSON.parse(JSON.stringify()) round-trip", v.valid === true && v.reason === "ok", `reason=${v.reason}`);

const reordered = { ...signed, powers: [...signed.powers].reverse(), coverage: { ...signed.coverage, checked: [...signed.coverage.checked].reverse() } };
v = await verifyAttestation(reordered, { client, expect: { agentId: AGENT_ID } });
check("re-ordering powers[] stays VALID (canonicalization sorts)", v.valid === true, `reason=${v.reason}`);

const noisyReads = { ...signed, reads: [{ method: "eth_call", httpStatus: 503, retriedAttempts: 9 }] };
v = await verifyAttestation(noisyReads, { client, expect: { agentId: AGENT_ID } });
check("changing telemetry `reads` stays VALID (excluded by design)", v.valid === true, `reason=${v.reason}`);

// ═══════════════════════════ HALF 2 — FAULT INJECTED ═══════════════════════════
section("HALF 2 — FAULT INJECTED: it actually rejects");

const mutate = (fn) => { const c = JSON.parse(JSON.stringify(signed)); fn(c); return c; };

const faults = [
  ["flip a power's `present`", (c) => { c.powers[0].present = false; }],
  ["⭐ STRIP a coverage.notChecked entry (the laundering attack)", (c) => { c.coverage.notChecked = []; c.coverage.totals.notChecked = 0; }],
  ["swap the blockNumber", (c) => { c.subject.blockNumber = 1; }],
  ["flip sources.independenceVerified to true", (c) => { c.sources.independenceVerified = true; }],
  ["add an unlisted power", (c) => { c.powers.push({ power: "upgradeable", present: true, matched: [], holder: null, holderKind: null, severity: "code-replacement" }); }],
  ["erase the refusal", (c) => { c.refusal = { reason: "faked", detail: "x" }; }],
  ["alter the subject address", (c) => { c.subject.address = "0x0000000000000000000000000000000000000bad"; }],
];
for (const [label, fn] of faults) {
  const v2 = await verifyAttestation(mutate(fn), { client, expect: { agentId: AGENT_ID } });
  check(label + " → INVALID", v2.valid === false && v2.reason === "bad-signature", `reason=${v2.reason}`);
}

section("HALF 2b — the structural dev/prod separation");
const wrongWalletReport = await attachAttestation(rpt, { sign: signWith(otherOwner), ...IDENT });
v = await verifyAttestation(wrongWalletReport, { client, expect: { agentId: AGENT_ID } });
check("a DIFFERENT wallet's signature → INVALID (no label enforced it)", v.valid === false && v.reason === "bad-signature", `reason=${v.reason}`);

const devSigned = await attachAttestation(rpt, { sign: signWith(owner), ...IDENT, domain: DOMAIN.dev, keyClass: "dev-throwaway" });
v = await verifyAttestation(devSigned, { client, expect: { agentId: AGENT_ID } });
check("a DEV-domain signature → domain-mismatch, NOT bad-signature", v.valid === false && v.reason === "domain-mismatch", `reason=${v.reason}`);
check("  …and it is distinguishable BEFORE any chain call", devSigned.attestation.domain === DOMAIN.dev);

section("HALF 2c — 'unverified' must never collapse into 'invalid'");

v = await verifyAttestation({ ...rpt, attestation: unsignedAttestation() }, { client });
check("unsigned → reason 'unsigned', never a bare false", v.valid === false && v.reason === "unsigned", `reason=${v.reason}`);
v = await verifyAttestation(rpt, { client });
check("no attestation object at all → reason 'unsigned'", v.reason === "unsigned");

v = await verifyAttestation(mutate((c) => { c.attestation.canon = "canon/99"; }), { client });
check("unsupported canon → valid:null (learned NOTHING ≠ disproved)", v.valid === null && v.reason === "unsupported-canon", `valid=${v.valid} reason=${v.reason}`);
check("  …and null is FALSY, so `if (v.valid)` still fails closed", !v.valid);

v = await verifyAttestation(mutate((c) => { c.attestation.method = "ecrecover"; }), { client });
check("unsupported method → valid:null", v.valid === null && v.reason === "unsupported-method", `reason=${v.reason}`);

v = await verifyAttestation(signed, { client, expect: { agentId: "999999" } });
check("a different agentId than expected → unknown-key", v.valid === false && v.reason === "unknown-key", `reason=${v.reason}`);

v = await verifyAttestation(signed, { client: mockClient({ registryOwner: "0x00000000000000000000000000000000deadbeef" }), expect: { agentId: AGENT_ID } });
check("verifyingContract ≠ ownerOf(agentId) → owner-key-mismatch", v.valid === false && v.reason === "owner-key-mismatch", `reason=${v.reason}`);

v = await verifyAttestation(signed, { client: mockClient({ throwOn: "0x6352211e" }), expect: { agentId: AGENT_ID } });
check("ownerOf RPC exhausted → valid:null indeterminate-rpc (NOT invalid)", v.valid === null && v.reason === "indeterminate-rpc", `valid=${v.valid} reason=${v.reason}`);

v = await verifyAttestation(signed, { client: mockClient({ throwOn: "0x1626ba7e" }), expect: { agentId: AGENT_ID } });
check("isValidSignature RPC exhausted → valid:null indeterminate-rpc", v.valid === null && v.reason === "indeterminate-rpc", `valid=${v.valid} reason=${v.reason}`);

v = await verifyAttestation(mutate((c) => { delete c.attestation.signature; }), { client });
check("missing signature field → malformed-attestation (valid:null)", v.valid === null && v.reason === "malformed-attestation", `reason=${v.reason}`);

section("HALF 2d — transport shape is a CLOSED set (the bug the live run found)");

v = await verifyAttestation(signed, { client: mockClient({ envelope: true }), expect: { agentId: AGENT_ID } });
check("`{result, query, evidence}` envelope (the real dd client) → valid", v.valid === true, `reason=${v.reason}`);
v = await verifyAttestation(signed, { client: mockClient({ envelope: false }), expect: { agentId: AGENT_ID } });
check("bare hex string (a plainer transport) → valid", v.valid === true, `reason=${v.reason}`);
v = await verifyAttestation(signed, { client: mockClient({ garbage: true }), expect: { agentId: AGENT_ID } });
check("⭐ an UNRECOGNISED transport shape → indeterminate, never coerced", v.valid === null && v.reason === "indeterminate-rpc", `valid=${v.valid} reason=${v.reason}`);

// ═══════════════════════════ THE NAMED FOOTGUN ═══════════════════════════
section("THE FOOTGUN — EIP-191, not raw keccak256");

const msg = signingMessage(signed, { domain: signed.attestation.domain });
const correctDigest = attestationDigest(signed, { domain: signed.attestation.domain });
const rawDigest = keccak256(toBytes(msg));
check("the two digests genuinely differ", correctDigest !== rawDigest);

const enc = (d) => {
  const sig = signed.attestation.signature.replace(/^0x/, "");
  return "0x1626ba7e" + pad32(d) + word(64) + word(sig.length / 2) + sig + "0".repeat((32 - ((sig.length / 2) % 32)) % 32 * 2);
};
const unwrap = (r) => (typeof r === "string" ? r : r.result);
const okRet = unwrap(await client.call({ method: "eth_call", params: [{ to: SCA, data: enc(correctDigest) }, "latest"] }));
const rawRet = unwrap(await client.call({ method: "eth_call", params: [{ to: SCA, data: enc(rawDigest) }, "latest"] }));
check("EIP-191 digest → MAGIC 0x1626ba7e", okRet.startsWith(MAGIC), okRet.slice(0, 10));
check("⚠️ raw keccak256 digest → 0xffffffff (a VALID sig read as invalid)", rawRet.startsWith(NOT_MAGIC), rawRet.slice(0, 10));

const spec = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../docs/dd-attestation-canon1.md", import.meta.url), "utf8"));
check("the footgun is NAMED in the verifier spec, not left to be discovered", /footgun/i.test(spec) && /EIP-191/.test(spec) && /0xffffffff/.test(spec));
check("the spec states ecrecover CANNOT work against the SCA", /ecrecover/i.test(spec) && /smart contract account/i.test(spec));
check("the spec carries the durability caveat", /valid \*now\*|valid NOW/i.test(spec));

// ═══════════════════════════ OPTIONAL LIVE PASS ═══════════════════════════
if (process.argv.includes("--live")) {
  section("LIVE — real Circle wallet, real Arc Testnet chain reads");
  try {
    const { ddAttestationOptions } = await import("./attest-circle.mjs");
    const { chainClient } = await import("./client.mjs");
    const live = await attachAttestation(rpt, ddAttestationOptions());
    check("Circle produced a signature", /^0x[0-9a-f]+$/.test(live.attestation.signature), `${live.attestation.signature.slice(0, 20)}…`);
    const lv = await verifyAttestation(live, { client: chainClient("arc-testnet"), expect: { agentId: AGENT_ID } });
    check("LIVE: verified against the real SCA + real registry", lv.valid === true && lv.reason === "ok", `reason=${lv.reason} ${lv.detail ?? ""}`);
    const tampered = JSON.parse(JSON.stringify(live)); tampered.coverage.notChecked = [];
    const tv = await verifyAttestation(tampered, { client: chainClient("arc-testnet"), expect: { agentId: AGENT_ID } });
    check("LIVE: stripped coverage → rejected by the real chain", tv.valid === false && tv.reason === "bad-signature", `reason=${tv.reason}`);
  } catch (e) {
    check("LIVE pass completed", false, String(e?.message ?? e).slice(0, 160));
  }
} else {
  console.log("\n  (offline only — re-run with `--live` to also exercise the real wallet and chain)");
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
