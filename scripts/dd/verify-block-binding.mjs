// verify-block-binding.mjs — DD Morpho V2 window, STEP 5: block-hash + block-timestamp binding.
//
//   npm run test:blockbinding           (offline: a mock chain + the attestation suite's ERC-1271 stand-in)
//
// The decided design (PROGRESS 2026-09-28 build order step 5, + T 2026-09-29):
//   · `subject.blockHash` + `subject.blockTimestamp` (integer chain seconds) ride in the report BODY, so canon/1 signs them
//     unchanged ("block-hash binding does NOT change the canon, only the signed CONTENT").
//   · They come from ONE header read of the PINNED block through the same client (quorum-agreed). A header that cannot
//     be read, or that names a different block, → the report REFUSES (a new report is never quietly unbound).
//   · The verifier checks both against the chain (eth_getBlockByNumber(subject.blockNumber)): a different hash or
//     timestamp → INVALID; an unreadable block → valid null (cannot confirm), never true.
//   · A report WITHOUT them (the three purchased reports, frozen) verifies exactly as before and reads NOT hash-bound:
//     absent never reads as bound.

import { privateKeyToAccount } from "viem/accounts";
import { recoverAddress, keccak256, toHex } from "viem";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { attachAttestation, verifyAttestation, canonicalize } from "../../shared/onchain-analyze/attest.mjs";
import { SUBJ, OWNER, word, codeWith, mockClient, transientThrow } from "./_mock-chain.mjs";
import { EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import { getChain } from "../../shared/dd/chains.mjs";
const TESTNET_ID = getChain("arc-testnet").id; // fixture data from the registry, not a literal (test:literals)

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 70 - t.length))}`);

const HASH = keccak256(toHex("block-1000")), TS = 1790939824;
const header = (over = {}) => ({ number: "0x3e8", hash: HASH, timestamp: "0x" + TS.toString(16), parentHash: "0x" + "0".repeat(64), ...over });
const H = (blockAnswer) => ({
  [`code@${SUBJ}`]: codeWith(["pause()"]),
  [`slot@${EIP1967_IMPL_SLOT}`]: "0x" + "0".repeat(64),
  "call@0x8da5cb5b": word(OWNER),
  [`code@${OWNER}`]: "0x",
  ...(blockAnswer === undefined ? {} : { eth_getBlockByNumber: blockAnswer }),
});

section("1 — ⭐ analyze() binds the report to the PINNED block's hash and timestamp");
{
  const r = await analyze(SUBJ, { client: mockClient(H(header())) });
  ok("subject.blockHash = the pinned block's hash", r.subject.blockHash === HASH, r.subject.blockHash);
  ok("subject.blockTimestamp = its timestamp, integer chain SECONDS", r.subject.blockTimestamp === TS, String(r.subject.blockTimestamp));
  ok("…and the report is otherwise a normal report (no refusal)", r.refusal === null, r.refusal?.reason);
  ok("⭐ both are inside the SIGNED bytes (canon/1 unchanged, content bound)", canonicalize(r).includes(HASH.toLowerCase()) && canonicalize(r).includes(`"blockTimestamp":"${TS}"`));
  const u = await analyze(SUBJ, { client: mockClient(H(transientThrow)) });
  ok("⛔ header UNREADABLE → refusal subject-block-unreadable, blockHash null (never an unbound 'normal' report)",
    u.refusal?.reason === "subject-block-unreadable" && u.subject.blockHash === null, `${u.refusal?.reason} ${u.subject.blockHash}`);
  const w = await analyze(SUBJ, { client: mockClient(H(header({ number: "0x3e9" }))) });
  ok("⛔ header for a DIFFERENT block → refusal (subject-block-mismatch)", w.refusal?.reason === "subject-block-mismatch" && w.subject.blockHash === null, w.refusal?.reason);
  const m = await analyze(SUBJ, { client: mockClient(H({ number: "0x3e8", hash: "0x1234", timestamp: "0x1" })) });
  ok("⛔ a malformed hash → refusal, never a bound report", m.refusal?.reason === "subject-block-unreadable", m.refusal?.reason);
}

// ── the verifier, with the attestation suite's ERC-1271 stand-in ────────────────────────────────────────────────
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const owner = privateKeyToAccount(KEY);
const SCA = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621", REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e", AGENT_ID = "851891";
const IDENT = { agentId: AGENT_ID, verifyingContract: SCA, registry: REGISTRY, chainId: String(TESTNET_ID), keyId: "test" };
const pad = (h) => h.replace(/^0x/, "").padStart(64, "0");
const wrap = (v) => ({ result: v, query: {}, evidence: { httpStatus: 200 } });
function vclient({ block = header(), blockThrows = false } = {}) {
  return { async call({ method, params }) {
    if (method === "eth_chainId") return wrap("0x" + TESTNET_ID.toString(16));
    if (method === "eth_getBlockByNumber") { if (blockThrows) throw Object.assign(new Error("request limit reached"), { transient: true }); return wrap(block); }
    const to = String(params?.[0]?.to ?? "").toLowerCase(), data = String(params?.[0]?.data ?? "");
    if (to === REGISTRY && data.startsWith("0x6352211e")) return wrap("0x" + pad(SCA));
    if (to === SCA && data.startsWith("0x1626ba7e")) {
      const body = data.slice(10), digest = "0x" + body.slice(0, 64), len = Number(BigInt("0x" + body.slice(128, 192)));
      const rec = await recoverAddress({ hash: digest, signature: "0x" + body.slice(192, 192 + len * 2) });
      return wrap((rec.toLowerCase() === owner.address.toLowerCase() ? "0x1626ba7e" : "0xffffffff") + "0".repeat(56));
    }
    throw new Error(`mock: unexpected ${method} ${data.slice(0, 10)}`);
  } };
}
const sign = (r) => attachAttestation(r, { sign: (message) => owner.signMessage({ message }), ...IDENT });
const report = (subjectOver = {}) => ({ schemaVersion: "onchain-analyze/0.3.0", subject: { address: SUBJ, chainId: TESTNET_ID, chainName: "arc-testnet", blockNumber: 1000, blockHash: HASH, blockTimestamp: TS, ...subjectOver }, powers: [], coverage: { checked: [], notChecked: [], totals: { checked: 0, notChecked: 0 } }, reads: [], refusal: null });

section("2 — ⭐⭐ the verifier checks the bound block against the chain");
{
  const s = await sign(report());
  const v = await verifyAttestation(s, { client: vclient(), expect: { agentId: AGENT_ID } });
  ok("correct hash + timestamp → valid, hashBound true, boundTo carries both", v.valid === true && v.hashBound === true && v.boundTo.blockHash === HASH && v.boundTo.blockTimestamp === TS, `${v.reason} ${v.hashBound}`);
  ok("attestation.blockHashBound now says true for a bound report (a claim; the verdict is derived from the chain)", s.attestation.blockHashBound === true);
  const bad = await verifyAttestation(await sign(report({ blockHash: keccak256(toHex("another")) })), { client: vclient(), expect: { agentId: AGENT_ID } });
  ok("⭐ a SIGNED hash the chain does not have at that block → INVALID (block-hash-mismatch)", bad.valid === false && bad.reason === "block-hash-mismatch", bad.reason);
  const badTs = await verifyAttestation(await sign(report({ blockTimestamp: TS + 1 })), { client: vclient(), expect: { agentId: AGENT_ID } });
  ok("⭐ a signed timestamp the chain disagrees with → INVALID (block-timestamp-mismatch)", badTs.valid === false && badTs.reason === "block-timestamp-mismatch", badTs.reason);
  const unr = await verifyAttestation(s, { client: vclient({ blockThrows: true }), expect: { agentId: AGENT_ID } });
  ok("⛔ the block UNREADABLE → valid null (cannot confirm), never true", unr.valid === null && unr.reason === "block-unreadable", `${unr.valid} ${unr.reason}`);
  const forged = { ...s, subject: { ...s.subject, blockHash: keccak256(toHex("x")) } };
  ok("tampering the hash after signing breaks the SIGNATURE (it is in the signed bytes)", (await verifyAttestation(forged, { client: vclient({ block: header({ hash: forged.subject.blockHash }) }), expect: { agentId: AGENT_ID } })).valid === false);
}

section("3 — ⭐ a report WITHOUT a bound block (the frozen purchased reports) verifies as before and reads NOT bound");
{
  const legacy = report(); delete legacy.subject.blockHash; delete legacy.subject.blockTimestamp; // the pre-0.4 subject shape
  const relegacy = await sign(legacy);
  const v = await verifyAttestation(relegacy, { client: vclient({ blockThrows: true }), expect: { agentId: AGENT_ID } });
  ok("valid exactly as before — and it did NOT need the block (no read)", v.valid === true && v.reason === "ok", v.reason);
  ok("⭐ hashBound false, boundTo.blockHash null: absent never reads as bound", v.hashBound === false && v.boundTo.blockHash === null);
  ok("attestation.blockHashBound false for it", relegacy.attestation.blockHashBound === false);
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
