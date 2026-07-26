#!/usr/bin/env node
// pin-invariants.mjs — pin a FROZEN agent-metadata document to Pinata (IPFS), then
// independently verify the pin is real and unmodified by fetching it back from a
// NEUTRAL public gateway and re-hashing.
//
// This script pins and verifies ONLY. It moves no money and registers nothing
// on-chain. It reads PINATA_JWT from the environment; if that is missing it exits
// loudly rather than proceeding unauthenticated.
//
//   node --env-file=.env scripts/pin-invariants.mjs --target <name>
//   export PINATA_JWT=… && node scripts/pin-invariants.mjs --target <name>
//
// ⚠️ PINATA_JWT IS READ FROM process.env AND NOWHERE ELSE. There is no dotenv import,
// and nothing here reads Netlify — setting it in the Netlify prod context does NOT help
// a local pin. Use `--env-file=.env` (Node >=20.6 loads it into process.env; .env is
// gitignored) or a shell export.
//
// --target IS REQUIRED — see TARGETS below. Targets: `unified` (already pinned) and
// `dd-service` (frozen 634f3b4, NOT yet pinned — the thing blocking Phase C). The three
// dead per-role files (researcher/second-opinion/executor) are NOT pinnable: their
// hardcoded sha256s were invalidated by the Route A edits.
//
// Byte-fidelity contract: the file is read as raw bytes and pinned exactly as it
// sits on disk. It is NEVER JSON.parse'd, re-serialized, or reformatted — the bytes
// that reach Pinata must be byte-identical to what was reviewed, so that the
// resulting CID corresponds only to bytes that were actually reviewed.
//
// SELF-REFERENCE — why the expected CID is a hard gate, not a nicety: the document
// asserts its own address ("tokenURI(agentId) == the CID of this exact document").
// EXPECTED_CID below is the CID computed from the reviewed bytes BEFORE pinning. If
// the pinned/derived CID differs by one character, the bytes changed since review and
// the document's central claim would point at a CID that is not itself — false from
// birth. A mismatch aborts before verification and must never reach registration.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Compute the CIDv1 raw-codec CID ("bafkrei...") for a set of bytes. This is the
// deterministic content address of the file as a single raw block, and — because
// the document is well under one IPFS chunk (256 KiB) — it equals the raw LEAF
// that Pinata stores under the pinned DAG. It is the "bafkrei" form used elsewhere
// in the repo (agent-init.mjs:32), distinct from the dag-pb "bafybei"/"Qm" root
// that pinFileToIPFS returns. Derivation: multibase 'b' + base32(
//   0x01 version | 0x55 raw codec | 0x12 sha256 | 0x20 len=32 | <32-byte digest> ).
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32NoPad(bytes) {
  let bits = 0, val = 0, out = "";
  for (const b of bytes) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function bafkreiRawCid(sha256Buf) {
  return "b" + base32NoPad(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), sha256Buf]));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ═════════════════════ TARGETS — ONE PROFILE PER FROZEN DOCUMENT ═════════════════════
//
// ⚠️ WHY A MAP AND NOT EDITED CONSTANTS. This script pinned unified.json with `rel`,
// `sha256` and EXPECTED_CID hardcoded. Pinning a SECOND frozen document by editing them
// in place would destroy the ability to re-run the proven unified path, and — worse —
// a half-finished edit (new rel, stale sha/CID, or vice versa) would abort in step 2/2b
// having *looked* like it was pinning the intended document. Profiles keep each
// document's three facts together so they cannot drift apart.
//
// Each profile's sha256 and expectedCid MUST be derived from that document's own bytes.
// They are hard gates, not labels: step 2 refuses on sha drift, step 2b refuses on CID
// mismatch, both BEFORE anything is uploaded. A CID is never minted for unreviewed bytes.
const TARGETS = {
  // The Tikpema Agent identity. ALREADY PINNED and gateway-verified 2026-07-24; a re-run
  // is expected to be a no-op that re-confirms retrievability.
  unified: {
    name: "unified.json",
    rel: "agent-metadata/unified.json",
    sha256: "6e239a3d815595844d939aebba68970695625c2c90558133a1dc013d8f568901",
    expectedCid: "bafkreidoeond3akvswce3e425o5grfygsvrfyleqkwathio4ae6y6vujae",
  },
  // The DD service document, frozen 2026-07-26 (commit 634f3b4). NOT YET PINNED — this
  // is what blocks Phase C: register-identity.mjs STEP 1 refuses while no gateway serves
  // the CID, because registering a tokenURI pointing at unfetchable bytes is the one
  // irreversible mistake in that flow.
  "dd-service": {
    name: "dd-service.json",
    rel: "agent-metadata/dd-service.json",
    sha256: "d3734accb6390a361df2daf87b49c41d4a44d30bfc9285f47be3c3284dbb402f",
    expectedCid: "bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4",
  },
};

// ⚠️ NO DEFAULT TARGET. Pinning is an outward-facing publish: the bytes become
// retrievable by anyone. Letting the script pick which document to publish is not a
// convenience, it is a way to publish the wrong one. Fail closed.
const TARGET_IX = process.argv.indexOf("--target");
const TARGET_NAME = TARGET_IX >= 0 ? process.argv[TARGET_IX + 1] : null;
if (!TARGET_NAME || !TARGETS[TARGET_NAME]) {
  console.error(
    `\nABORT: --target is REQUIRED and must name a known profile. There is deliberately no\n` +
      `default — pinning PUBLISHES the bytes, so the document must be named explicitly.\n\n` +
      `  known targets: ${Object.keys(TARGETS).join(", ")}\n` +
      `  usage: node --env-file=.env scripts/pin-invariants.mjs --target <name>\n` +
      `         (or: export PINATA_JWT=… && node scripts/pin-invariants.mjs --target <name>)\n`
  );
  process.exit(1);
}

// Cross-profile collision guard: two profiles sharing a rel/sha/CID would mean one
// document's gates were silently checking another's bytes. Asserted, not reviewed.
{
  const seen = new Map();
  for (const [n, t] of Object.entries(TARGETS)) {
    for (const k of ["rel", "sha256", "expectedCid", "name"]) {
      const key = `${k}:${t[k]}`;
      if (seen.has(key)) {
        console.error(`\nABORT: targets "${seen.get(key)}" and "${n}" share ${k} = ${t[k]}. Refusing.`);
        process.exit(1);
      }
      seen.set(key, n);
    }
  }
}

const TARGET = TARGETS[TARGET_NAME];
// Single-element list: the loop structure below is the proven unified.json path and is
// deliberately left untouched.
const FILES = [{ name: TARGET.name, rel: TARGET.rel, sha256: TARGET.sha256 }];

// The CID computed from the reviewed bytes BEFORE pinning — the value the document
// asserts about itself. Every CID this script derives or receives must equal it.
const EXPECTED_CID = TARGET.expectedCid;

// Neutral public gateways — deliberately NOT Pinata's own gateway. Retrievability
// from a third-party gateway is what proves the pin is real and public, not just
// visible to the account that uploaded it. We try each in turn, with retries,
// because a just-created pin can take time to propagate across the IPFS network.
const GATEWAYS = [
  (cid) => `https://ipfs.io/ipfs/${cid}`,
  (cid) => `https://dweb.link/ipfs/${cid}`,
  (cid) => `https://cloudflare-ipfs.com/ipfs/${cid}`,
];
const FETCH_ATTEMPTS = 8;
const FETCH_BACKOFF_MS = 4000;

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function die(msg) {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
}

// --- 1. Authentication gate ------------------------------------------------
// A non-empty check is NOT enough: `netlify env:get PINATA_JWT` prints the
// sentence "No value set in the production context for environment variable
// PINATA_JWT" to stdout with exit code 0 when the var is unset, so a naive
// `export PINATA_JWT=$(netlify env:get ...)` captures that message as a fake,
// non-empty value. We therefore validate the SHAPE: a real Pinata JWT is
// `header.payload.signature` — three base64url segments, and the header segment
// begins with "ey" (base64 of `{"`). Anything else fails loudly here, at the
// gate, instead of leaking a garbage token to Pinata as a 401.
const JWT = (process.env.PINATA_JWT || "").trim();
if (!JWT) {
  die(
    "PINATA_JWT is missing or empty. Refusing to run unauthenticated. " +
      "Set it in this shell only and retry. NOTE: do NOT trust " +
      "`export PINATA_JWT=$(netlify env:get PINATA_JWT --context production)` blindly — " +
      "if the var is unset that command captures a 'No value set...' message, not a token."
  );
}
if (/\s/.test(JWT)) {
  die("PINATA_JWT contains whitespace — not a valid JWT. It was likely set to a CLI message, not a token.");
}
const segments = JWT.split(".");
const MIN_LEN = 100; // a real Pinata JWT is a few hundred chars; the "No value set" msg is 74
if (segments.length !== 3 || !JWT.startsWith("ey") || JWT.length <= MIN_LEN) {
  die(
    `PINATA_JWT is not JWT-shaped: got ${segments.length} dot-separated segment(s) (need 3), ` +
      `${JWT.startsWith("ey") ? 'starts with "ey"' : 'does NOT start with "ey"'}, ` +
      `length ${JWT.length} (need > ${MIN_LEN}). ` +
      `A real Pinata JWT is header.payload.signature, starts with "ey", and is a few hundred chars. ` +
      `You probably captured a CLI status message (e.g. "No value set...") instead of the token.`
  );
}

// --- 2. Load + integrity-check each file (no pinning yet) -------------------
console.log(`Target: ${TARGET_NAME} — ${TARGET.rel}`);
console.log(`  expected sha256: ${TARGET.sha256}`);
console.log(`  expected CID   : ${TARGET.expectedCid}\n`);
console.log("Reading and hashing local files (raw bytes, no re-serialization)...\n");
for (const f of FILES) {
  f.abs = path.join(REPO_ROOT, f.rel);
  f.bytes = await readFile(f.abs); // Buffer — raw bytes, never parsed
  f.localSha = sha256Hex(f.bytes);
  const ok = f.localSha === f.sha256;
  console.log(
    `  ${f.name.padEnd(20)} ${f.localSha} ${ok ? "OK" : "DRIFT!"}  (${f.bytes.length} bytes)`
  );
  if (!ok) {
    die(
      `${f.rel} has drifted from its committed sha256.\n` +
        `  expected ${f.sha256}\n  got      ${f.localSha}\n` +
        `Not pinning — the bytes on disk are not the reviewed bytes.`
    );
  }
}
// --- 2b. Self-reference gate: derive the CID from the reviewed bytes ---------
// This runs BEFORE pinning. The CID is a pure function of the bytes, so if it does
// not equal the CID the document asserts about itself, the bytes are not the ones
// that were reviewed — stop here rather than minting an address for the wrong bytes.
for (const f of FILES) {
  f.cid = bafkreiRawCid(Buffer.from(f.localSha, "hex"));
  console.log(`\n  derived CID    : ${f.cid}`);
  console.log(`  expected CID   : ${EXPECTED_CID}`);
  if (f.cid !== EXPECTED_CID) {
    die(
      `CID MISMATCH before pinning.\n` +
        `  expected ${EXPECTED_CID}\n  derived  ${f.cid}\n` +
        `The document asserts tokenURI(agentId) == the CID of itself. These bytes address ` +
        `differently than the reviewed bytes, so that claim would be false from birth. ` +
        `Not pinning, and NOT eligible for registration.`
    );
  }
  console.log(`  -> CID matches the document's self-reference.`);
}

console.log("\nDocument matches its reviewed sha256 and its self-asserted CID. Proceeding to pin.\n");

// --- 3. Pin each file's raw bytes to Pinata --------------------------------
async function pinRawBytes(f) {
  const form = new FormData();
  // Blob wraps the exact bytes; no encoding/parse round-trip.
  form.append("file", new Blob([f.bytes]), f.name);
  form.append("pinataMetadata", JSON.stringify({ name: f.name }));
  // cidVersion: 1 -> the pinned DAG root comes back as "bafybei..." (dag-pb v1),
  // and the raw leaf under it is the "bafkrei..." CID we report and verify below.
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));

  const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${JWT}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    die(`Pinata pin failed for ${f.name}: HTTP ${res.status} ${text}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    die(`Pinata returned non-JSON for ${f.name}: ${text}`);
  }
  if (!json.IpfsHash) {
    die(`Pinata response for ${f.name} had no IpfsHash: ${text}`);
  }
  return json.IpfsHash;
}

for (const f of FILES) {
  console.log(`Pinning ${f.name} (cidVersion: 1) ...`);
  f.rootCid = await pinRawBytes(f); // the CID Pinata returns as the pin root
  // f.cid (the raw-codec "bafkrei..." leaf) was derived from the file's own sha256
  // in step 2b. For a single-chunk file under cidVersion:1 Pinata's returned root IS
  // that raw leaf (nothing to wrap), so rootCid should equal it — the two are computed
  // independently, which makes this an honest cross-check of what Pinata actually stored.
  console.log(`  -> pinned root : ${f.rootCid}`);
  console.log(`  -> raw CID     : ${f.cid}`);
  if (f.rootCid !== f.cid) {
    console.log(
      `  -> NOTE: Pinata's root differs from the raw leaf (dag-pb wrapper), so the ` +
        `root is not the self-referenced address. Verification below uses the raw CID.`
    );
  }
  console.log("");
}

// --- 4. Fetch each CID back from a NEUTRAL gateway and re-hash --------------
// Each gateway is tried INDEPENDENTLY and its own result recorded, rather than
// stopping at the first success — so the report can say which gateways actually
// served the bytes and whether each one's re-hash matched. A gateway that never
// serves is recorded as "not retrieved", which is an ABSENCE, not a pass.
async function fetchOneGateway(gw, cid) {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const url = gw(cid);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        return { buf, url, status: res.status };
      }
      var lastStatus = res.status;
    } catch (e) {
      var lastErr = e?.message || String(e);
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(FETCH_BACKOFF_MS);
  }
  return { buf: null, url: gw(cid), status: lastStatus ?? null, err: lastErr ?? null };
}

console.log("Verifying the pin via neutral public gateways (ipfs.io / dweb.link / cloudflare)...\n");
for (const f of FILES) {
  f.gatewayResults = [];
  for (const gw of GATEWAYS) {
    const host = new URL(gw(f.cid)).host;
    process.stdout.write(`  ${host} ... `);
    const got = await fetchOneGateway(gw, f.cid);
    if (!got.buf) {
      f.gatewayResults.push({ host, url: got.url, served: false, sha: null, match: false });
      console.log(`NOT RETRIEVED (${got.err ? `error: ${got.err}` : `HTTP ${got.status}`})`);
      continue;
    }
    const sha = sha256Hex(got.buf);
    const match = sha === f.sha256;
    f.gatewayResults.push({ host, url: got.url, served: true, sha, match, bytes: got.buf.length });
    console.log(`served ${got.buf.length} bytes -> re-hash ${match ? "MATCH" : "MISMATCH"}`);
  }
  const served = f.gatewayResults.filter((r) => r.served);
  // A pin verifies only if at least one neutral gateway actually served the bytes
  // AND no gateway that served them returned different bytes.
  f.match = served.length > 0 && served.every((r) => r.match);
  f.gatewaySha = served[0]?.sha ?? null;
}

// --- 5. Final report -------------------------------------------------------
console.log("\n================= RESULT =================\n");
let allOk = true;
for (const f of FILES) {
  const verdict = f.match ? "MATCH" : "MISMATCH";
  if (!f.match) allOk = false;
  console.log(f.name);
  console.log(`  local sha256   : ${f.localSha}`);
  console.log(`  CID (bafkrei)  : ${f.cid}`);
  console.log(`  expected CID   : ${EXPECTED_CID}  ${f.cid === EXPECTED_CID ? "MATCH" : "MISMATCH"}`);
  console.log(`  ipfs uri       : ipfs://${f.cid}`);
  console.log(`  pinned root    : ${f.rootCid}${f.rootCid === f.cid ? " (== raw CID)" : " (dag-pb wrapper)"}`);
  console.log(`  gateways       :`);
  for (const r of f.gatewayResults) {
    console.log(
      `    ${r.host.padEnd(22)} ${r.served ? `served  re-hash ${r.match ? "MATCH   " : "MISMATCH"} ${r.sha}` : "NOT RETRIEVED"}`
    );
  }
  console.log(`  verdict        : ${verdict}`);
  console.log("");
}

if (!allOk) {
  die(
    "The document did not verify MATCH end-to-end (no neutral gateway served it, or one served different bytes). " +
      "Do NOT record this CID on-chain."
  );
}
console.log(`Pin verified byte-identical via a neutral gateway, at the self-asserted CID ${EXPECTED_CID}.`);
console.log("Reminder: this script pinned + verified only. Nothing was registered or moved on-chain.");
