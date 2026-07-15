#!/usr/bin/env node
// pin-invariants.mjs — pin the three committed agent-metadata invariants files to
// Pinata (IPFS), then independently verify each pin is real and unmodified by
// fetching it back from a NEUTRAL public gateway and re-hashing.
//
// This script pins and verifies ONLY. It moves no money and registers nothing
// on-chain. It reads PINATA_JWT from the environment; if that is missing it exits
// loudly rather than proceeding unauthenticated.
//
// Byte-fidelity contract: each file is read as raw bytes and pinned exactly as it
// sits on disk. It is NEVER JSON.parse'd, re-serialized, or reformatted — the bytes
// that reach Pinata must be byte-identical to what is committed at cdd4530, so that
// the resulting CID corresponds only to bytes that were actually reviewed.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// The authoritative sha256 of each file as committed at cdd4530. If a local file
// has drifted from these, we abort BEFORE pinning — we will not mint a CID for
// bytes that differ from what was reviewed.
const FILES = [
  {
    name: "researcher.json",
    rel: "agent-metadata/researcher.json",
    sha256: "4340b1f39c3ce831832a7cefd25bf28295898fb54d38aa6d189793f8e785886e",
  },
  {
    name: "second-opinion.json",
    rel: "agent-metadata/second-opinion.json",
    sha256: "b947d00e0d237fe8a0b4ba3d9a32625d7fc56893de5c56d8ba0cb3f00841df73",
  },
  {
    name: "executor.json",
    rel: "agent-metadata/executor.json",
    sha256: "5d210af2ec5efaf5346997619eefc2d3c81db64e22d6c4c145712141981af71a",
  },
];

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
console.log("\nAll three files match their committed sha256. Proceeding to pin.\n");

// --- 3. Pin each file's raw bytes to Pinata --------------------------------
async function pinRawBytes(f) {
  const form = new FormData();
  // Blob wraps the exact bytes; no encoding/parse round-trip.
  form.append("file", new Blob([f.bytes]), f.name);
  form.append("pinataMetadata", JSON.stringify({ name: f.name }));

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
  console.log(`Pinning ${f.name} ...`);
  f.cid = await pinRawBytes(f);
  console.log(`  -> CID ${f.cid}\n`);
}

// --- 4. Fetch each CID back from a NEUTRAL gateway and re-hash --------------
async function fetchFromGateway(cid) {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    for (const gw of GATEWAYS) {
      const url = gw(cid);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          return { buf, url };
        }
      } catch {
        // ignore and try the next gateway / attempt
      }
    }
    if (attempt < FETCH_ATTEMPTS) {
      process.stdout.write(
        `  ...not retrievable yet (attempt ${attempt}/${FETCH_ATTEMPTS}), waiting for propagation\n`
      );
      await sleep(FETCH_BACKOFF_MS);
    }
  }
  return null;
}

console.log("Verifying each pin via a neutral public gateway (ipfs.io / dweb.link / cloudflare)...\n");
for (const f of FILES) {
  const got = await fetchFromGateway(f.cid);
  if (!got) {
    f.gatewaySha = null;
    f.match = false;
    console.log(`  ${f.name}: could not retrieve ${f.cid} from any neutral gateway`);
    continue;
  }
  f.gatewaySha = sha256Hex(got.buf);
  f.match = f.gatewaySha === f.sha256;
  console.log(`  ${f.name}: fetched from ${got.url} -> ${f.match ? "MATCH" : "MISMATCH"}`);
}

// --- 5. Final report -------------------------------------------------------
console.log("\n================= RESULT =================\n");
let allOk = true;
for (const f of FILES) {
  const verdict = f.match ? "MATCH" : "MISMATCH";
  if (!f.match) allOk = false;
  console.log(f.name);
  console.log(`  local sha256   : ${f.localSha}`);
  console.log(`  CID            : ${f.cid}`);
  console.log(`  gateway sha256 : ${f.gatewaySha ?? "(not retrieved)"}`);
  console.log(`  verdict        : ${verdict}`);
  console.log("");
}

if (!allOk) {
  die("One or more files did not verify MATCH end-to-end. Do NOT record these CIDs on-chain.");
}
console.log("All three pins verified byte-identical via a neutral gateway.");
console.log("Reminder: this script pinned + verified only. Nothing was moved on-chain.");
