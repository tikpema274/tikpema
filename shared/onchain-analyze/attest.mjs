// attest.mjs — canon/1 canonicalization, report signing, and STRUCTURED verification.
//
// ═══ WHAT THIS IS NOT ═════════════════════════════════════════════════════════════════════════
// `attestation.signature` here means a CRYPTOGRAPHIC signature: who produced this report. It is not
// `powers[].matched[].signature`, which means a FUNCTION signature ("pause()"). It is not
// `disclosureDigest()`/`ackTokenFor()` in netlify/functions/_vault.mjs (the vault deposit ack, money
// path, frozen). It is not `scannedCodeHash`. Four integrity artifacts, four meanings — conflating
// them is the predictable future mistake, so each says what it is not.
//
// ═══ THE BINDING: (a′) ERC-1271, PROVEN NOT ASSUMED ═══════════════════════════════════════════
// The DD service identity is ERC-8004 agentId 851891, whose owner of record is 0xc54d47…. That owner
// is a Circle developer-controlled SCA (circle_6900_singleowner_v3), NOT an EOA — it has no private
// key of its own, so NO signature ecrecovers to it. A verifier writing
// `ecrecover(hash,sig) == ownerOf(851891)` never matches; if they instead compared against the
// recovered key they would be trusting an address with no on-chain link to the identity. That is
// fail-open in signature form, and it is why the tie is an ERC-1271 contract call:
//
//     ownerOf(agentId) → the SCA           (registry read, authoritative)
//     isValidSignature(digest, sig) → 0x1626ba7e   (the SCA validates its own owner's signature)
//
// Both halves are on-chain reads. NOTHING is declared, so nothing has to be trusted. Verified by
// spike 2026-07-26: magic value returned; and three negative controls (raw-keccak digest, a garbage
// signature, and the same message signed by a DIFFERENT Circle wallet) all returned 0xffffffff — so
// the check discriminates by signer, and a dev/throwaway wallet is structurally invalid without any
// label enforcing it.
//
// ═══ TRANSPORT IS INJECTED ════════════════════════════════════════════════════════════════════
// This module never opens a connection and never holds a key. Signing takes a `sign(message)`
// callback; verification takes the same `client` interface analyze() uses ({ call({method,params}) }).
// Same rule as the rest of shared/: interpretation is shared, transport is per-caller.

import { hashMessage } from "viem";

export const CANON_VERSION = "canon/1";

/** Domain-separated prefixes. A signature under one domain is MATHEMATICALLY invalid under the
 *  other — a relabelled `keyClass` does not help an attacker, because the bytes do not verify.
 *  Under (a′) the separation is additionally STRUCTURAL: a dev wallet is a different SCA, so its
 *  signature fails `isValidSignature` on the production account regardless of the domain string. */
export const DOMAIN = Object.freeze({
  prod: "tikpema-dd-attestation/canon1/prod",
  dev: "tikpema-dd-attestation/canon1/dev",
});

/** Rides on every attestation, machine-readable, so no consumer can claim it was not told.
 *  Mirrors SEVERITY_MEANING in schema.mjs — the caveat travels WITH the artifact, not in a doc
 *  the caller may never open. */
export const VALIDITY_MEANING =
  "ERC-1271 answers 'is this signature valid NOW', not 'was it valid when issued'. Validity is a live " +
  "contract call against the owning smart account: if that account's owner key is ever rotated, " +
  "previously issued attestations STOP verifying. A signature also proves 'true at block N', never " +
  "'true now' — freshness is the verifier's policy decision, not something a signature can supply.";

/** Objects excluded from the signed bytes, BY OBJECT — never by field. */
const EXCLUDED = Object.freeze(["reads", "attestation"]);

// ═══════════════════════════ canon/1 — canonicalization ═══════════════════════════
//
// ⭐ EXCLUSION LIST, NOT INCLUSION LIST — and that choice is load-bearing.
// An inclusion list ("sign these named fields") FAILS OPEN the moment the schema grows: a field
// added next year is unsigned by default, and nothing says so. An exclusion list fails CLOSED — a
// new field is signed automatically, and forgetting to exclude telemetry costs a stable signature,
// which is noisy and visible rather than silent and dangerous. Given that this project's recurring
// defect is absence reading as safe, the direction of the failure decides the design.
//
// Two objects are excluded:
//   `reads`       — telemetry (httpStatus, retriedAttempts, endpoint ordering). Varies between
//                   honest runs; signing it means signing noise.
//   `attestation` — excluded BY OBJECT so there is no chance of signing over part of your own
//                   signature. Absent, not null.

/** Deterministic array ordering. Runtime order must never reach the signed bytes. */
function orderArrays(node, key) {
  if (!Array.isArray(node)) return node;
  const by = (f) => (a, b) => String(a?.[f] ?? "").localeCompare(String(b?.[f] ?? ""));
  if (key === "powers") return [...node].sort(by("power"));
  if (key === "matched") return [...node].sort(by("selector"));
  if (key === "checked" || key === "notChecked") return [...node].sort(by("id"));
  if (key === "endpoints" || key === "powersPresent") return [...node].sort();
  return node;
}

/**
 * Normalize one value into the canon/1 value space: null | boolean | string | array | object.
 *
 * NUMBERS BECOME DECIMAL STRINGS. JCS defers to ECMAScript number serialization, which is a
 * precision trap the moment a value exceeds 2^53 — and block numbers are exactly the kind of value
 * that grows. Strings sidestep it, the same discipline JSON-RPC already uses.
 *
 * HEX IS LOWERCASED. Mixed-case EIP-55 checksums are a canonicalization landmine: two
 * byte-different strings for one address. Only strings that are ENTIRELY hex are touched, so prose
 * is never mangled.
 *
 * `undefined` THROWS. A field that silently vanishes from the signed bytes is this project's
 * failure family in canonicalization form.
 */
function canonValue(v, path) {
  if (v === null) return null;
  const t = typeof v;
  if (t === "undefined") {
    throw new Error(`canon/1: undefined at ${path} — a field that vanishes from the signed bytes is not acceptable. Use an explicit null.`);
  }
  if (t === "boolean") return v;
  if (t === "string") return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
  if (t === "bigint") return v.toString(10);
  if (t === "number") {
    if (!Number.isFinite(v)) throw new Error(`canon/1: non-finite number at ${path}`);
    if (!Number.isInteger(v)) throw new Error(`canon/1: non-integer number at ${path} — canon/1 has no float encoding, by design`);
    return String(v);
  }
  if (Array.isArray(v)) return v.map((x, i) => canonValue(x, `${path}[${i}]`));
  if (t === "object") {
    const out = {};
    for (const k of Object.keys(v)) out[k] = canonValue(orderArrays(v[k], k), `${path}.${k}`);
    return out;
  }
  throw new Error(`canon/1: unserializable ${t} at ${path}`);
}

/** RFC 8785 (JCS) subset serializer. Keys sorted by UTF-16 code unit; no whitespace. Valid as JCS
 *  because canonValue has already removed every number — the one place JCS and JSON.stringify
 *  disagree. Built by hand rather than via JSON.stringify so key order cannot depend on the
 *  engine's own property ordering. */
function serialize(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(serialize).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(v[k])}`).join(",")}}`;
}

/**
 * Canonicalize a report into the exact bytes that get signed.
 * @returns {string} canonical JSON — the same report always produces the same string.
 *
 * Determinism means A GIVEN REPORT always canonicalizes to the same bytes. It does NOT mean two runs
 * at the same block produce the same signature: any wall-clock field will differ between runs, and
 * correctly so. Conflating the two leads to stripping fields to chase a reproducibility that was
 * never needed.
 */
export function canonicalize(report) {
  if (!report || typeof report !== "object") throw new Error("canonicalize(): a report object is required");
  const subset = {};
  for (const k of Object.keys(report)) {
    if (EXCLUDED.includes(k)) continue;
    subset[k] = report[k];
  }
  return serialize(canonValue(orderArrays(subset, "$root"), "$"));
}

/** The exact string that is signed: domain prefix, newline, canonical JSON. */
export function signingMessage(report, { domain = DOMAIN.prod } = {}) {
  return `${domain}\n${canonicalize(report)}`;
}

/**
 * ⭐ THE DIGEST IS THE EIP-191 personal_sign HASH — NOT keccak256 OF THE MESSAGE.
 *
 * This is THE named footgun of this spec, and it is proven, not theorised: in the feasibility spike
 * the EIP-191 hash returned the ERC-1271 magic value while the raw keccak256 of the identical
 * message returned 0xffffffff. A verifier who hashes the canonical bytes directly gets a confident
 * "invalid" for a signature that is perfectly good — a wrong answer, not an error. See
 * docs/dd-attestation-canon1.md § "The footgun".
 */
export function attestationDigest(report, { domain = DOMAIN.prod } = {}) {
  return hashMessage(signingMessage(report, { domain }));
}

/** The attestation every UNSIGNED report carries. Never a missing field: a missing field reads as
 *  safe, a present `status:"unsigned"` cannot. */
export function unsignedAttestation(detail = "no signer was configured for this run") {
  return {
    status: "unsigned",
    canon: CANON_VERSION,
    detail,
    validityMeaning: VALIDITY_MEANING,
  };
}

/**
 * Sign a report and return a NEW report carrying the attestation. Does not mutate the input.
 *
 * @param {object} report
 * @param {object} opts
 * @param {(message: string) => Promise<string>} opts.sign  signer over the EIP-191 message
 * @param {string} opts.agentId            ERC-8004 agentId this attestation claims
 * @param {string} opts.verifyingContract  the account whose isValidSignature validates it
 * @param {string} opts.registry           IdentityRegistry holding the agentId
 * @param {string} opts.chainId            chain of BOTH the registry and the verifying contract
 * @param {string} opts.keyId              opaque; swapping the signer is a VALUE change, not schema
 */
export async function attachAttestation(report, {
  sign, agentId, verifyingContract, registry, chainId,
  keyId = null, keyClass = "registered", domain = DOMAIN.prod,
} = {}) {
  if (typeof sign !== "function") throw new Error("attachAttestation(): a sign(message) function is required — this module never holds a key");
  for (const [k, v] of Object.entries({ agentId, verifyingContract, registry, chainId })) {
    if (!v) throw new Error(`attachAttestation(): ${k} is required — an attestation that cannot name what it binds to is not verifiable`);
  }
  const message = signingMessage(report, { domain });
  const signature = await sign(message);
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error(`attachAttestation(): signer returned something that is not a hex signature: ${JSON.stringify(signature)?.slice(0, 80)}`);
  }
  return {
    ...report,
    attestation: {
      status: "signed",
      canon: CANON_VERSION,
      domain,
      alg: "eip191-ecdsa-secp256k1",
      method: "erc1271",
      keyClass,
      keyId,
      agentId: String(agentId),
      verifyingContract: String(verifyingContract).toLowerCase(),
      registry: String(registry).toLowerCase(),
      chainId: String(chainId),
      signature: signature.toLowerCase(),
      // Pass 2 is not built, so no blockHash exists to bind. Stated as a FIELD rather than left to
      // inference: without it the payload binds an index, not state identity, so an old attestation
      // does not by itself prove it is not describing a since-changed contract.
      blockHashBound: false,
      validityMeaning: VALIDITY_MEANING,
    },
  };
}

// ═══════════════════════════ verification ═══════════════════════════

const MAGIC = "0x1626ba7e";
const SEL_IS_VALID_SIG = "0x1626ba7e";
const SEL_OWNER_OF = "0x6352211e";

const pad32 = (hexNo0x) => hexNo0x.padStart(64, "0");
const wordFromAddress = (a) => pad32(String(a).replace(/^0x/, "").toLowerCase());
const wordFromUint = (n) => pad32(BigInt(n).toString(16));

/**
 * Normalize what a transport hands back into hex, or null.
 *
 * scripts/dd/client.mjs returns the documented `{ result, query, evidence }` envelope; a plainer
 * caller may hand back the bare hex string. Both are accepted — and NOTHING ELSE IS. This is a
 * CLOSED outcome set on purpose: an unrecognised shape returns null, which every call site turns
 * into INDETERMINATE. Coercing an unknown shape (`String(x)`, `x?.result ?? x`) is how a transport
 * mismatch would silently become a verification answer.
 */
function readHex(ret) {
  if (typeof ret === "string" && ret.startsWith("0x")) return ret;
  if (ret && typeof ret === "object" && typeof ret.result === "string" && ret.result.startsWith("0x")) return ret.result;
  return null;
}

/** ABI-encode isValidSignature(bytes32,bytes) — head/tail, dynamic bytes tail-padded. */
function encodeIsValidSignature(digest, signature) {
  const sig = String(signature).replace(/^0x/, "").toLowerCase();
  const len = sig.length / 2;
  const padded = sig + "0".repeat((32 - (len % 32 || 32)) % 32 * 2);
  return SEL_IS_VALID_SIG
    + pad32(String(digest).replace(/^0x/, "").toLowerCase())
    + wordFromUint(64)
    + wordFromUint(len)
    + padded;
}

/**
 * ⭐ verify() RETURNS A STRUCTURED VERDICT, NOT A BOOL.
 *
 * A bare `false` is this project's own failure mode in signature form: it collapses *unsigned*,
 * *unknown key*, *unsupported canon*, *owner mismatch*, *RPC unreachable* and *bad signature* into
 * one indistinguishable value, and a caller writing `if (verify(r))` would treat a report nobody
 * could check as one that was checked and failed. "Unverified" must never collapse into "invalid".
 *
 * `valid` is TRI-STATE:
 *   true  — the owning account validated the signature
 *   false — a definite negative: we checked and it does not hold
 *   null  — INDETERMINATE: we could not check. Distinct from false, and falsy on purpose, so a
 *           naive `if (v.valid)` still fails CLOSED while `v.reason` carries the real answer.
 *
 * @param {object} report
 * @param {object} opts
 * @param {{call: Function}} opts.client   transport, injected — same interface analyze() takes
 * @param {{agentId?: string, domain?: string}} [opts.expect]  what the CALLER expected to be reading
 */
export async function verifyAttestation(report, { client, expect = {} } = {}) {
  const boundTo = {
    chainId: report?.subject?.chainId ?? null,
    blockNumber: report?.subject?.blockNumber ?? null,
    blockHash: null, // pass 2 not built — see attestation.blockHashBound
    address: report?.subject?.address ?? null,
  };
  const verdict = (valid, reason, extra = {}) => ({
    valid, reason, boundTo,
    method: report?.attestation?.method ?? null,
    keyClass: report?.attestation?.keyClass ?? null,
    agentId: report?.attestation?.agentId ?? null,
    meaning: VALIDITY_MEANING,
    ...extra,
  });

  const att = report?.attestation;
  if (!att || att.status === "unsigned") {
    return verdict(false, "unsigned", { detail: att?.detail ?? "the report carries no attestation object at all" });
  }
  if (att.status !== "signed") return verdict(null, "malformed-attestation", { detail: `unknown attestation.status ${JSON.stringify(att.status)}` });

  // An unsupported canonicalization means the verifier HAS LEARNED NOTHING — which is not the same
  // as having disproved the signature. Never a silent false.
  if (att.canon !== CANON_VERSION) {
    return verdict(null, "unsupported-canon", { detail: `report is ${JSON.stringify(att.canon)}, this verifier implements ${CANON_VERSION}` });
  }
  if (att.method !== "erc1271") {
    return verdict(null, "unsupported-method", { detail: `attestation.method is ${JSON.stringify(att.method)}; this verifier only implements erc1271` });
  }
  for (const f of ["signature", "verifyingContract", "registry", "agentId", "domain"]) {
    if (!att[f]) return verdict(null, "malformed-attestation", { detail: `attestation.${f} is missing` });
  }

  // Is this the identity the CALLER meant to be reading? A valid signature from the wrong agent is
  // still the wrong agent — and that is a different failure from a bad signature.
  if (expect.agentId && String(expect.agentId) !== String(att.agentId)) {
    return verdict(false, "unknown-key", { detail: `report attests agentId ${att.agentId}; caller expected ${expect.agentId}` });
  }
  const wantDomain = expect.domain ?? DOMAIN.prod;
  if (att.domain !== wantDomain) {
    // Detected from the DECLARED domain before any call: under ERC-1271 the contract returns only
    // valid/invalid, so a domain mismatch would otherwise be indistinguishable from a bad signature.
    return verdict(false, "domain-mismatch", { detail: `signed under ${att.domain}; this verifier requires ${wantDomain}` });
  }

  if (!client?.call) throw new Error("verifyAttestation(): a transport client is required — ERC-1271 validity is an on-chain question and cannot be answered offline");

  // ── the identity half: does the declared verifying contract actually own the agentId? ──
  let ownerRaw;
  try {
    ownerRaw = await client.call({
      method: "eth_call",
      params: [{ to: att.registry, data: SEL_OWNER_OF + wordFromUint(att.agentId) }, "latest"],
    });
  } catch (e) {
    return verdict(null, "indeterminate-rpc", { detail: `ownerOf(${att.agentId}) did not complete: ${e?.message ?? e}` });
  }
  const ownerHex = readHex(ownerRaw);
  if (!ownerHex || ownerHex.length < 66) {
    return verdict(null, "indeterminate-rpc", { detail: `ownerOf(${att.agentId}) returned unusable data: ${JSON.stringify(ownerRaw)?.slice(0, 80)}` });
  }
  const ownerOnChain = "0x" + ownerHex.slice(-40).toLowerCase();
  if (ownerOnChain !== att.verifyingContract.toLowerCase()) {
    // The signature may be perfectly valid for that contract — but that contract is not the owner of
    // record, so the report is not attested BY THE IDENTITY it claims. A distinct failure.
    return verdict(false, "owner-key-mismatch", {
      detail: `ownerOf(${att.agentId}) is ${ownerOnChain}, but the attestation names verifyingContract ${att.verifyingContract}`,
      ownerOnChain,
    });
  }

  // ── the signature half: ERC-1271 against that same account ──
  const digest = attestationDigest(report, { domain: att.domain });
  let ret;
  try {
    ret = await client.call({
      method: "eth_call",
      params: [{ to: att.verifyingContract, data: encodeIsValidSignature(digest, att.signature) }, "latest"],
    });
  } catch (e) {
    return verdict(null, "indeterminate-rpc", { detail: `isValidSignature did not complete: ${e?.message ?? e}` });
  }
  const retHex = readHex(ret);
  if (!retHex) {
    return verdict(null, "indeterminate-rpc", { detail: `isValidSignature returned unusable data: ${JSON.stringify(ret)?.slice(0, 80)}` });
  }
  const magic = retHex.slice(0, 10).toLowerCase();
  if (magic === MAGIC) return verdict(true, "ok", { digest, ownerOnChain });
  return verdict(false, "bad-signature", {
    digest, ownerOnChain, returned: magic,
    detail: "the owning account did not validate this signature over the canonical bytes — the report was altered after signing, or it was signed by a different key",
  });
}
