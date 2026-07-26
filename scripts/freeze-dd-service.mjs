// freeze-dd-service.mjs — Phase A freeze: turn the reviewed DRAFT into the FINAL frozen bytes,
// and derive sha256 + CIDv1(raw) from those bytes LOCALLY.
//
// ⚠️ THE CID IS DERIVED FROM THE FILE'S OWN sha256, BEFORE ANY PIN. It never depends on what a
// pinning service returns, so bytes that differ from the reviewed bytes can never get an address
// minted for them. Same discipline as scripts/pin-invariants.mjs.
//
// ⚠️ FREEZING IS NOT A COPY. The draft's _draft_notice asserts "NOT pinned, NOT content-addressed",
// which is FALSE once frozen — a frozen document must not contain a false statement about its own
// status. The notice is replaced and the version de-drafted here, and NOTHING else changes.
//
// This script does NOT pin, does NOT publish, and does NOT touch the chain.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const DRAFT = "agent-metadata/dd-service.DRAFT.json";
const FROZEN = "agent-metadata/dd-service.json";

// CIDv1, raw codec, sha2-256 — the "bafkrei…" form. Copied deliberately from
// scripts/pin-invariants.mjs:39-50 rather than imported: that script is the PROVEN unified.json
// pipeline and must not be retargeted or refactored while it is the authority for a live CID.
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32NoPad(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const bafkreiRawCid = (sha256Buf) =>
  "b" + base32NoPad(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), sha256Buf]));

if (!existsSync(DRAFT)) { console.error(`missing ${DRAFT}`); process.exit(1); }
if (existsSync(FROZEN)) {
  console.error(`🚨 ${FROZEN} ALREADY EXISTS — refusing to overwrite a frozen document. If a new
version is intended, that is a SUPERSESSION: write dd-service.v2.json and set "supersedes".`);
  process.exit(1);
}

const d = JSON.parse(readFileSync(DRAFT, "utf8"));

// ── De-draft: the only content changes the freeze itself makes ────────────────────────────────
delete d._draft_notice;
const rebuilt = {
  _notice:
    "FROZEN — v1.0.0. These bytes are FINAL and content-addressed. The document asserts that " +
    "tokenURI(agentId) equals the CID of this exact file, so ANY byte change (reformatting, a " +
    "trailing newline, re-serialising through JSON.parse) makes its own central claim false. " +
    "Corrections happen by SUPERSESSION — a new version with 'supersedes' set — never by editing " +
    "these bytes. ⚠️ STATUS AT FREEZE: NO WALLET EXISTS FOR THIS SERVICE, NOTHING IS REGISTERED, " +
    "AND NO agentId EXISTS. Phase B (wallet) and Phase C (on-chain registration) are a separate " +
    "deliberate session using the register-ONLY playbook; agent-init.mjs must never be used for it, " +
    "because it mints a new wallet on every run. Reports from this service are NOT signed or " +
    "attested by any identity today. The public mirror's README is NOT part of this CID and is " +
    "where the agentId and owner address are recorded after registration.",
  ...d,
};
rebuilt.version = "1.0.0";

// Deterministic serialisation, stable and reproducible: 2-space indent, UTF-8, single trailing \n.
// ⚠️ THE TRAILING 0x0a IS PART OF THE FROZEN BYTES.
const bytes = Buffer.from(JSON.stringify(rebuilt, null, 2) + "\n", "utf8");
writeFileSync(FROZEN, bytes);

const sha = createHash("sha256").update(bytes).digest();
const shaHex = sha.toString("hex");
const cid = bafkreiRawCid(sha);

// Re-read from disk and re-hash: proves what LANDED is what we hashed, not what we intended.
const onDisk = readFileSync(FROZEN);
const reHash = createHash("sha256").update(onDisk).digest("hex");

console.log(`\n${"═".repeat(80)}\nPHASE A FREEZE — ${FROZEN}\n${"═".repeat(80)}`);
console.log(`bytes            : ${bytes.length}`);
console.log(`sha256           : ${shaHex}`);
console.log(`CIDv1 (raw)      : ${cid}`);
console.log(`re-read re-hash  : ${reHash}  ${reHash === shaHex ? "✅ MATCH (what landed is what we hashed)" : "❌ MISMATCH"}`);
console.log(`trailing byte    : 0x${onDisk[onDisk.length - 1].toString(16)} ${onDisk[onDisk.length - 1] === 0x0a ? "✅ LF" : "❌ not LF"}`);
console.log(`CR count         : ${[...onDisk].filter((b) => b === 0x0d).length} ${[...onDisk].filter((b) => b === 0x0d).length === 0 ? "✅ no CRLF" : "❌ CRLF present"}`);
console.log(`valid JSON       : ${(() => { try { JSON.parse(onDisk.toString("utf8")); return "✅"; } catch { return "❌"; } })()}`);
console.log(`version          : ${JSON.parse(onDisk.toString("utf8")).version}`);
console.log(`_draft_notice    : ${JSON.parse(onDisk.toString("utf8"))._draft_notice === undefined ? "✅ removed" : "❌ still present"}`);
console.log(`\nNOT pinned. NOT published. No wallet, no chain.`);
console.log(`For pin/mirror, the expected values to gate on are:`);
console.log(`  sha256 = ${shaHex}`);
console.log(`  cid    = ${cid}`);
