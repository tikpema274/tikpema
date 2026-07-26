#!/usr/bin/env node
// register-identity.mjs — register the FROZEN unified ERC-8004 identity document
// as this agent's on-chain identity, ONCE, from the EXISTING dev-controlled wallet.
//
// ═══ ⚠️ REAL ON-CHAIN WRITE + REAL TESTNET USDC. Requires --confirm; a bare run
// ═══ prints the plan and exits without touching anything.
//
//   node --env-file=.env scripts/register-identity.mjs --target <name>            # dry run
//   node --env-file=.env scripts/register-identity.mjs --target <name> --confirm   # WRITES
//   node --env-file=.env scripts/register-identity.mjs --target <name> --resume <circleTxId>
//
// --target IS REQUIRED — see TARGETS below. There is no default: one script now serves
// several frozen documents, and letting it guess which one is how the wrong document gets
// a permanent on-chain pointer. Each profile owns its own idFile / nftDump / env key, so
// registering a second identity cannot overwrite the first one's recovered agentId.
//
// WHAT THIS IS NOT: it is not agent-init.mjs. It creates NO wallet. It registers
// from the wallet id below, which already exists. agent-init.mjs mints a brand-new
// wallet on every run — that is how 103 orphan wallets and 2 orphan identities came
// to exist, and it must never be used for registration.
//
// WHY register() ONLY: probe-register-agent.mjs (already run, do not re-run) proved
// this exact call shape works from this exact SCA — it produced throwaway agentId
// 850337. This script is that call with the guards that probe lacked.
//
// ───────────────────────────────────────────────────────────────────────────────
// THE THREE GUARDS, and what each prevents
//
//   1. CID PRE-FLIGHT — fetch the CID, re-hash the bytes, confirm 6e239a3d…
//      Prevents: recording a permanent pointer to bytes nobody verified. This is
//      the irreversible mistake; every other failure here is recoverable.
//
//   2. EXISTENCE CHECK — enumerate this wallet's NFTs via the CIRCLE endpoint
//      GET /v1/w3s/wallets/{walletId}/nfts, then resolve each candidate's tokenURI.
//      Prevents: minting a duplicate identity — a third orphan.
//      ⚠️ DELIBERATELY NOT A CHAIN SCAN. The registry holds ~131k identities and is
//      not enumerable; both a downward ownerOf scan and a windowed getLogs mint-scan
//      were tried and did NOT converge against Arc's public-RPC throttle. A check
//      built on a scan that cannot complete is WORSE than no check: it hangs, or it
//      silently fails open and you mint the duplicate anyway. Circle's endpoint
//      enumerates by owner directly, in bounded time.
//
//   3. ID PERSISTENCE — write the Circle tx id BEFORE waiting, and the agentId the
//      instant it is known, to disk, in the same run.
//      Prevents: THE recurring archaeology. 103 wallets, 2 orphans, and a tokenId
//      hunt that never converged all trace to one root cause — ids that existed for
//      a moment in a terminal and were never persisted. A closed terminal, a 60s
//      timeout, or a thrown error after a successful mint each produce an identity
//      that exists on-chain and is unfindable. That is a new orphan.
//
// FAIL-CLOSED THROUGHOUT: every check has a CLOSED outcome set, and the third
// outcome is always INDETERMINATE → REFUSE. An absence never fills the result slot
// and reads as "safe to proceed".
// ───────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPublicClient, http, parseEventLogs } from "viem";
import { circle, waitForTx, TxPendingError } from "../netlify/functions/_circle.mjs";
import { ARC } from "../netlify/functions/_arc.mjs";

// ═══════════════════════ THE CONSTANTS THAT MUST NOT DRIFT ═══════════════════════

// The wallet that will own the identity. THE ID, not an address: the id is what was
// recovered and verified against prod, and it is what Circle's signing keys on. An
// address in .env is one indirection further from the thing that actually matters,
// and .env is exactly where a stale value hides.
const WALLET_ID = "2c93ca5d-be5c-5f51-883d-1a220647f7b1";
// Expected address for that id — asserted, not trusted. See STEP 0.
const EXPECTED_ADDRESS = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

const GATEWAYS = [
  (cid) => `https://ipfs.io/ipfs/${cid}`,
  (cid) => `https://dweb.link/ipfs/${cid}`,
];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
// Where the agentId lands. Committed-adjacent and obvious — NOT a temp dir.
const OUT_DIR = path.join(REPO_ROOT, "agent-metadata");

// ═════════════════════ TARGETS — ONE PROFILE PER FROZEN DOCUMENT ═════════════════════
//
// ⚠️ WHY THIS IS A MAP AND NOT SIX EDITED CONSTANTS. This script produced agentId 851823
// against unified.json with these values hardcoded. Registering a SECOND identity by
// editing them in place would (a) destroy the ability to re-run the 851823 shape, and
// (b) silently repoint ID_FILE at agent-metadata/REGISTERED-IDENTITY.json — which HOLDS
// THE 851823 RECORD. persistId() writes with writeFile, no merge: the first call would
// have erased the only local copy of an id recovered at real cost. The script written to
// prevent id-archaeology would have caused it. Profiles make that collision structurally
// impossible: each target owns its own idFile and nftDump.
//
// Every profile field is a claim that must be true BEFORE a run:
//   cid/sha  — the frozen document's content address and hash, derived from ITS bytes
//   localDoc — the file those bytes live in (drift-checked in STEP 1)
//   idFile   — where THIS identity's id is persisted. MUST be unique per target.
//   envKey   — the prod env var for THIS id. A second identity must NOT reuse AGENT_ID.
const TARGETS = {
  // The Tikpema Agent identity. ALREADY REGISTERED as agentId 851823 — a run against
  // this target is expected to be INERT (STEP 2 finds it and refuses to mint a duplicate).
  unified: {
    label: "Tikpema Agent (unified identity)",
    cid: "bafkreidoeond3akvswce3e425o5grfygsvrfyleqkwathio4ae6y6vujae",
    sha: "6e239a3d815595844d939aebba68970695625c2c90558133a1dc013d8f568901",
    localDoc: path.join(REPO_ROOT, "agent-metadata/unified.json"),
    idFile: path.join(OUT_DIR, "REGISTERED-IDENTITY.json"),
    nftDump: path.join(OUT_DIR, ".nft-enumeration.json"),
    envKey: "AGENT_ID",
    mirror: "https://github.com/tikpema274/tikpema-agent-identity",
  },
  // The DD service. A SECOND identity from the SAME wallet — same operator, separate
  // reputation subject, exactly as the frozen document publishes it. No new wallet.
  "dd-service": {
    label: "Tikpema DD Service",
    cid: "bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4",
    sha: "d3734accb6390a361df2daf87b49c41d4a44d30bfc9285f47be3c3284dbb402f",
    localDoc: path.join(REPO_ROOT, "agent-metadata/dd-service.json"),
    idFile: path.join(OUT_DIR, "REGISTERED-IDENTITY-dd-service.json"),
    nftDump: path.join(OUT_DIR, ".nft-enumeration-dd-service.json"),
    envKey: "DD_AGENT_ID",
    mirror: "(NOT YET CREATED — Phase A mirror + pin still pending)",
  },
};

// ⚠️ NO DEFAULT TARGET, ON PURPOSE. A default is how --confirm registers the wrong
// document: the operator omits a flag and the script picks for them. Fail closed.
const TARGET_IX = process.argv.indexOf("--target");
const TARGET_NAME = TARGET_IX >= 0 ? process.argv[TARGET_IX + 1] : null;
if (!TARGET_NAME || !TARGETS[TARGET_NAME]) {
  console.error(`\n╔══ ABORT ═══════════════════════════════════════════════
--target is REQUIRED and must name a known profile. There is deliberately no default:
picking a document on the operator's behalf is how the wrong one gets registered.

  known targets: ${Object.keys(TARGETS).join(", ")}
  usage: node --env-file=.env scripts/register-identity.mjs --target <name> [--confirm]
╚════════════════════════════════════════════════════════`);
  process.exit(1);
}
const TARGET = TARGETS[TARGET_NAME];

// Derived from the selected profile. Any drift against the local file is a stop, not a warning.
const TARGET_CID = TARGET.cid;
const TARGET_SHA = TARGET.sha;
const AGENT_URI = `ipfs://${TARGET_CID}`;
const LOCAL_DOC = TARGET.localDoc;
const ID_FILE = TARGET.idFile;
const NFT_DUMP = TARGET.nftDump;

// Cross-profile collision guard: two targets sharing an idFile would let one overwrite
// the other's recovered id. Asserted at startup rather than trusted to review.
{
  const seen = new Map();
  for (const [name, t] of Object.entries(TARGETS)) {
    for (const key of ["idFile", "nftDump", "envKey", "cid"]) {
      const k = `${key}:${t[key]}`;
      if (seen.has(k)) {
        console.error(`\n╔══ ABORT ═══════════════════════════════════════════════
Targets "${seen.get(k)}" and "${name}" share ${key} = ${t[key]}.
One would overwrite the other's record. Refusing to run.
╚════════════════════════════════════════════════════════`);
        process.exit(1);
      }
      seen.set(k, name);
    }
  }
}

const CONFIRM = process.argv.includes("--confirm");
const RESUME_IX = process.argv.indexOf("--resume");
const RESUME_TX = RESUME_IX >= 0 ? process.argv[RESUME_IX + 1] : null;

const ARC_CHAIN = {
  id: ARC.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC.rpc] } },
};

const REGISTRY_ABI = [
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
];
const TRANSFER_ABI = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true },
  ],
}];
const ZERO = "0x0000000000000000000000000000000000000000";

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function die(msg) {
  console.error(`\n╔══ ABORT ═══════════════════════════════════════════════\n${msg}\n╚════════════════════════════════════════════════════════`);
  process.exit(1);
}

// Arc's PUBLIC RPC is rate-throttled — that throttle, not any code bug, is what made
// the earlier scans non-convergent. Every chain read here is BOUNDED (a handful of
// direct calls, never a scan) and retried with backoff. A read that exhausts its
// retries returns null, and null is always treated as INDETERMINATE → refuse.
async function readWithRetry(pub, fn, label, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === attempts) {
        console.log(`      ! ${label}: ${attempts} attempts exhausted (${e?.shortMessage || e?.message})`);
        return null;
      }
      await sleep(800 * i);
    }
  }
  return null;
}

const norm = (uri) => String(uri || "").trim().replace(/^ipfs:\/\//, "").replace(/^\/ipfs\//, "");

console.log("\n╔════════════════════════════════════════════════════════════════════╗");
console.log("║  ERC-8004 IDENTITY REGISTRATION — register-only, existing wallet   ║");
console.log("╚════════════════════════════════════════════════════════════════════╝\n");
console.log(`  mode          : ${RESUME_TX ? `RESUME (${RESUME_TX})` : CONFIRM ? "⚠️  CONFIRM — WILL WRITE ON-CHAIN" : "DRY RUN (default)"}`);
console.log(`  target        : ${TARGET_NAME}  — ${TARGET.label}`);
console.log(`  document      : ${path.relative(REPO_ROOT, LOCAL_DOC)}  (sha256 ${TARGET_SHA.slice(0, 12)}…)`);
console.log(`  wallet id     : ${WALLET_ID}`);
console.log(`  registry      : ${IDENTITY_REGISTRY}  (Arc Testnet ${ARC.chainId})`);
console.log(`  agent URI     : ${AGENT_URI}`);
console.log(`  agentId → file: ${ID_FILE}\n`);

const API_KEY = process.env.CIRCLE_API_KEY;
if (!API_KEY) die("CIRCLE_API_KEY missing. Run with --env-file=.env");

const pub = createPublicClient({ chain: ARC_CHAIN, transport: http(ARC.rpc) });
const client = circle();

// ═════════════════════════ STEP 0 — wallet id resolves ═════════════════════════
// Assert the id maps to the address we expect. If someone swaps the id, or the id
// is stale, this catches it before anything else runs.
console.log("── STEP 0 — resolve the wallet id ──────────────────────────────────");
let walletAddress;
{
  const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${WALLET_ID}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) die(`Circle GET /wallets/${WALLET_ID} → HTTP ${res.status}. Cannot confirm the wallet exists; refusing.`);
  const j = await res.json();
  walletAddress = j?.data?.wallet?.address;
  const blockchain = j?.data?.wallet?.blockchain;
  if (!walletAddress) die("Circle returned no address for that wallet id. Refusing on an absent value.");
  console.log(`  address    : ${walletAddress}`);
  console.log(`  blockchain : ${blockchain}`);
  if (walletAddress.toLowerCase() !== EXPECTED_ADDRESS) {
    die(`Wallet id resolves to ${walletAddress}, expected ${EXPECTED_ADDRESS}.\nThis is NOT the wallet the frozen document names as owner. Refusing.`);
  }
  if (blockchain !== ARC.blockchain) {
    die(`Wallet is on ${blockchain}, expected ${ARC.blockchain}. Refusing.`);
  }
  console.log(`  ✓ matches the owner the frozen document asserts\n`);
}

// ═══════════════════ STEP 1 — CID PRE-FLIGHT (guard 1 of 3) ═══════════════════
// Registering a pointer to unverified bytes is the one irreversible mistake here.
// A wrong agentId can be abandoned; a permanent pointer to wrong bytes cannot be
// un-published. So the bytes are proven BEFORE the write, from the network — not
// from the local file, which is not what a third party will read.
console.log("── STEP 1 — CID pre-flight (fetch → re-hash → compare) ─────────────");
{
  // Local copy first: cheap, and catches drift in the repo before we hit the network.
  const localBytes = await readFile(LOCAL_DOC).catch(() => null);
  if (!localBytes) die(`${LOCAL_DOC} not readable. Refusing — cannot compare against the frozen bytes.`);
  const localSha = sha256Hex(localBytes);
  console.log(`  local file : ${localSha} ${localSha === TARGET_SHA ? "OK" : "DRIFT!"}`);
  if (localSha !== TARGET_SHA) die(`Local unified.json has drifted from the frozen sha256.\n  expected ${TARGET_SHA}\n  got      ${localSha}\nThe document is frozen and self-referential; drift means the bytes are not the reviewed ones.`);

  const results = [];
  for (const gw of GATEWAYS) {
    const url = gw(TARGET_CID);
    const host = new URL(url).host;
    process.stdout.write(`  ${host.padEnd(11)}: `);
    let served = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) { served = Buffer.from(await r.arrayBuffer()); break; }
      } catch { /* fall through to retry */ }
      if (attempt < 4) await sleep(3000);
    }
    if (!served) { console.log("NOT RETRIEVED (absence — contributes no evidence)"); results.push({ host, served: false, match: false }); continue; }
    const sha = sha256Hex(served);
    const match = sha === TARGET_SHA;
    console.log(`served ${served.length}B → re-hash ${match ? "MATCH" : "MISMATCH"}`);
    results.push({ host, served: true, match, sha });
  }
  const servedResults = results.filter((r) => r.served);
  // Closed outcome set. An absence is NOT a pass: if nothing served, we know nothing.
  if (servedResults.length === 0) die("No gateway served the CID. The document may not be retrievable by a third party.\nThat is an ABSENCE, not a pass — refusing to register a pointer we cannot confirm resolves.");
  const bad = servedResults.filter((r) => !r.match);
  if (bad.length) die(`A gateway served DIFFERENT bytes at ${TARGET_CID}: ${bad.map((b) => `${b.host}=${b.sha}`).join(", ")}\nRefusing.`);
  console.log(`  ✓ ${servedResults.length} gateway(s) served byte-identical content at the target CID\n`);
}

// ═════════════════ STEP 2 — EXISTENCE CHECK (guard 2 of 3) ═════════════════
// Enumerate via CIRCLE, resolve tokenURI via a BOUNDED number of direct chain reads.
//
// Why both halves: Circle's `metadata` field is not a documented guarantee of the
// on-chain tokenURI, so trusting it could fail open (empty metadata → "no match" →
// duplicate mint). Chain reads are authoritative — and safe here precisely because
// the candidate set is this wallet's own NFTs (a handful), not 131k registry rows.
console.log("── STEP 2 — existence check (Circle enumeration, NOT a chain scan) ──");
let alreadyRegistered = null;
{
  const PAGE_SIZE = 50;
  const url = new URL(`https://api.circle.com/v1/w3s/wallets/${WALLET_ID}/nfts`);
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("includeAll", "true");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
  if (!res.ok) die(`Circle GET /wallets/${WALLET_ID}/nfts → HTTP ${res.status}.\nThe existence check could not run. Refusing: proceeding blind is how a duplicate gets minted.`);
  const body = await res.json();
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(NFT_DUMP, JSON.stringify(body, null, 2)); // raw evidence for audit
  const nfts = body?.data?.nfts;
  if (!Array.isArray(nfts)) die(`Circle response had no data.nfts array (got ${typeof nfts}).\nAn unparseable response is INDETERMINATE, not "no NFTs". Refusing. Raw body dumped to ${NFT_DUMP}`);

  console.log(`  wallet holds ${nfts.length} NFT(s) total  (raw dump → ${path.relative(REPO_ROOT, NFT_DUMP)})`);
  // Completeness: we must not silently truncate. If the page came back full we cannot
  // prove we saw everything, so we refuse rather than guess a cursor field.
  if (nfts.length >= PAGE_SIZE) {
    die(`Circle returned a FULL page (${nfts.length} ≥ pageSize ${PAGE_SIZE}), so the enumeration may be truncated.\nA truncated list could miss an existing identity and let this script mint a duplicate.\nRefusing until cursor pagination is implemented against the real response shape in ${NFT_DUMP}`);
  }

  const candidates = nfts.filter((n) => n?.token?.tokenAddress?.toLowerCase() === IDENTITY_REGISTRY.toLowerCase());
  console.log(`  of which on the IdentityRegistry: ${candidates.length}`);

  for (const n of candidates) {
    const tokenId = n?.nftTokenId;
    if (!tokenId) die(`A registry NFT came back with no nftTokenId. INDETERMINATE — refusing.\nRaw: ${JSON.stringify(n)}`);
    // Authoritative read. NOT a scan — one eth_call per NFT this wallet already holds.
    const uri = await readWithRetry(pub, () => pub.readContract({
      address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: "tokenURI", args: [BigInt(tokenId)],
    }), `tokenURI(${tokenId})`);
    if (uri === null) {
      die(`Could not read tokenURI(${tokenId}) from chain after retries (Arc RPC throttle).\n` +
          `INDETERMINATE: we cannot prove this identity is NOT the target, so we must not assume it isn't.\n` +
          `Refusing. Re-run when the RPC is responsive — waiting costs nothing, a duplicate identity is permanent.`);
    }
    const isTarget = norm(uri) === TARGET_CID;
    console.log(`    agentId ${String(tokenId).padEnd(10)} tokenURI ${norm(uri).slice(0, 24)}…  ${isTarget ? "◀ TARGET" : "(orphan / other)"}`);
    if (isTarget) alreadyRegistered = { agentId: String(tokenId), tokenURI: uri };
  }

  if (alreadyRegistered) {
    // Not a failure — the desired end state already holds. Persist the id (the whole
    // point of this script) and refuse the write, so a re-run is INERT, not duplicating.
    await persistId({
      agentId: alreadyRegistered.agentId,
      owner: walletAddress,
      tokenURI: alreadyRegistered.tokenURI,
      cid: TARGET_CID,
      sha256: TARGET_SHA,
      txHash: null,
      circleTxId: null,
      note: "ALREADY REGISTERED — discovered by the existence check, not minted by this run.",
    });
    console.log(`\n╔══ ALREADY REGISTERED — NOTHING TO DO ══════════════════════════════`);
    console.log(`║  agentId : ${alreadyRegistered.agentId}`);
    console.log(`║  tokenURI: ${alreadyRegistered.tokenURI}`);
    console.log(`║  This wallet ALREADY owns an identity pointing at the target CID.`);
    console.log(`║  Registering again would mint a THIRD orphan. Refusing — correctly.`);
    console.log(`║  The agentId has been written to ${path.relative(REPO_ROOT, ID_FILE)}`);
    console.log(`╚════════════════════════════════════════════════════════════════════`);
    process.exit(0);
  }
  console.log(`  ✓ no existing identity on this wallet points at the target CID → safe to register`);
  console.log(`    (any ids listed above are the known orphans — different tokenURI, left alone)\n`);
}

// ══════════════════ ID PERSISTENCE (guard 3 of 3) — the helper ══════════════════
// Called the INSTANT an id is known, before anything that could throw.
async function persistId(record) {
  await mkdir(OUT_DIR, { recursive: true });

  // 🚨 CLOBBER GUARD. writeFile does not merge. If this file already records a DIFFERENT,
  // non-null agentId, writing would erase the only local copy of an id that may have cost
  // a registry hunt to recover — the exact archaeology guard 3 exists to prevent, turned
  // against itself by a mis-set --target. Profiles make the collision unlikely; this makes
  // it impossible. Re-persisting the SAME id is allowed (that is the recovery path).
  const prior = await readFile(ID_FILE, "utf8").then((s) => JSON.parse(s)).catch(() => null);
  if (prior?.agentId && record.agentId && String(prior.agentId) !== String(record.agentId)) {
    die(`${ID_FILE} already records agentId ${prior.agentId}, and this run wants to write ${record.agentId}.\n` +
        `REFUSING to overwrite. That file may be the only local copy of ${prior.agentId}.\n` +
        `If this is genuinely a different identity, it needs its own --target profile with its own idFile.`);
  }
  if (prior?.agentId && !record.agentId) {
    // A "SUBMITTED, id not yet known" write must never blank an id that is already known.
    die(`${ID_FILE} already records agentId ${prior.agentId}, but this run is about to write a\n` +
        `null agentId (pre-settlement handle). That would erase a known id. REFUSING.\n` +
        `This target appears already registered — re-run the dry run to confirm before proceeding.`);
  }

  const payload = { ...record, target: TARGET_NAME, registry: IDENTITY_REGISTRY, chainId: ARC.chainId, walletId: WALLET_ID, writtenAt: new Date().toISOString() };
  await writeFile(ID_FILE, JSON.stringify(payload, null, 2) + "\n");
  console.log(`  💾 PERSISTED → ${ID_FILE}`);
  return payload;
}

// ═══════════════════════════ DRY RUN STOPS HERE ═══════════════════════════
if (!CONFIRM && !RESUME_TX) {
  console.log("╔══ DRY RUN — nothing was written ═══════════════════════════════════");
  console.log("║  All pre-flight guards PASSED. The write would be:");
  console.log("║");
  console.log(`║    register("${AGENT_URI}")`);
  console.log(`║    → ${IDENTITY_REGISTRY}`);
  console.log(`║    from walletId ${WALLET_ID}`);
  console.log(`║    (${walletAddress}, self-paid gas, no paymaster)`);
  console.log("║");
  console.log("║  Re-run with --confirm to execute. YOU run it — not the agent.");
  console.log("╚════════════════════════════════════════════════════════════════════\n");
  process.exit(0);
}

// ═══════════════════════════ STEP 3 — THE WRITE ═══════════════════════════
let circleTxId = RESUME_TX;

if (!RESUME_TX) {
  console.log("── STEP 3 — submitting register() ──────────────────────────────────");
  const tx = await client.createContractExecutionTransaction({
    walletId: WALLET_ID,                       // the ID, never an address from .env
    contractAddress: IDENTITY_REGISTRY,
    abiFunctionSignature: "register(string)",
    abiParameters: [AGENT_URI],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  circleTxId = tx.data?.id;
  if (!circleTxId) die("Circle returned no transaction id. Cannot track this write — treat as UNKNOWN and check the wallet before retrying.");

  // ⭐ PERSIST THE HANDLE BEFORE WAITING. If the wait times out, the terminal closes,
  // or anything throws below, the tx may STILL land on-chain — and without this line
  // that identity would exist with no record of how to find it. A new orphan.
  await persistId({
    agentId: null, owner: walletAddress, tokenURI: AGENT_URI, cid: TARGET_CID, sha256: TARGET_SHA,
    txHash: null, circleTxId,
    note: "SUBMITTED — agentId not yet known. If this file still says null, resume with: node --env-file=.env scripts/register-identity.mjs --resume " + circleTxId,
  });
  console.log(`  circle tx id: ${circleTxId}  (persisted before waiting — see note above)`);
}

// ═════════════════ STEP 4 — settle, recover agentId, PERSIST ═════════════════
console.log("\n── STEP 4 — waiting for settlement ─────────────────────────────────");
let txHash;
try {
  txHash = await waitForTx(client, circleTxId);
} catch (e) {
  if (e instanceof TxPendingError) {
    die(`Still PENDING after the deadline. THE TRANSACTION MAY STILL LAND.\n` +
        `Do NOT re-run without --resume: a second register() would mint a duplicate.\n` +
        `The circle tx id is saved in ${ID_FILE}. Resume with:\n` +
        `  node --env-file=.env scripts/register-identity.mjs --resume ${circleTxId}`);
  }
  die(`Transaction failed: ${e?.message}`);
}
console.log(`  tx hash : ${txHash}`);
console.log(`  explorer: ${ARC.explorer}/tx/${txHash}`);

// register() returns the agentId, but a return value is not available from a receipt —
// so we read it out of the ERC-721 mint log, same as the probe did.
const receipt = await readWithRetry(pub, () => pub.getTransactionReceipt({ hash: txHash }), "getTransactionReceipt", 8);
if (!receipt) die(`Could not fetch the receipt for ${txHash} after retries.\nThe identity likely EXISTS — recover the agentId from the explorer link above and record it by hand in ${ID_FILE}. Do NOT re-register.`);

const minted = parseEventLogs({ abi: TRANSFER_ABI, eventName: "Transfer", logs: receipt.logs }).filter((e) => e.args.from === ZERO);
if (!minted.length) die(`No ERC-721 mint log in the receipt — cannot determine the agentId.\nThe tx succeeded, so an identity may exist. Inspect ${ARC.explorer}/tx/${txHash} before ANY retry.`);

const agentId = minted[0].args.tokenId.toString();
const owner = minted[0].args.to;

// ⭐ PERSIST IMMEDIATELY — before verification, before printing, before anything
// that can throw. This line is the whole reason the archaeology does not repeat.
await persistId({ agentId, owner, tokenURI: AGENT_URI, cid: TARGET_CID, sha256: TARGET_SHA, txHash, circleTxId, note: "REGISTERED by this run." });

// ═══════════════ STEP 5 — verify on-chain, from chain, after the fact ═══════════════
console.log("\n── STEP 5 — post-write verification (read back from chain) ─────────");
const onChainUri = await readWithRetry(pub, () => pub.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: "tokenURI", args: [BigInt(agentId)] }), "tokenURI");
const onChainOwner = await readWithRetry(pub, () => pub.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: "ownerOf", args: [BigInt(agentId)] }), "ownerOf");
const uriOk = onChainUri !== null && norm(onChainUri) === TARGET_CID;
const ownerOk = onChainOwner !== null && onChainOwner.toLowerCase() === EXPECTED_ADDRESS;
console.log(`  tokenURI(${agentId}) = ${onChainUri ?? "UNREADABLE"}  ${uriOk ? "✓ matches target CID" : "✗"}`);
console.log(`  ownerOf(${agentId})  = ${onChainOwner ?? "UNREADABLE"}  ${ownerOk ? "✓ matches expected owner" : "✗"}`);

console.log("\n╔════════════════════════════════════════════════════════════════════╗");
console.log("║                      ⭐  REGISTERED  ⭐                             ║");
console.log("╠════════════════════════════════════════════════════════════════════╣");
console.log(`║  agentId : ${agentId}`);
console.log(`║  owner   : ${owner}`);
console.log(`║  tokenURI: ${AGENT_URI}`);
console.log(`║  tx      : ${txHash}`);
console.log(`║  saved   : ${path.relative(REPO_ROOT, ID_FILE)}`);
console.log("╚════════════════════════════════════════════════════════════════════╝");

if (!uriOk || !ownerOk) {
  console.log("\n  ⚠️  The mint succeeded but read-back did NOT fully verify (see ✗ above).");
  console.log("      The agentId is saved regardless. Investigate BEFORE any retry —");
  console.log("      re-registering would mint a duplicate.");
}

// ══════════════════ THE RUN IS NOT COMPLETE UNTIL THIS IS DONE ══════════════════
console.log(`
╔══ ⚠️  NOT DONE YET — the id must reach prod env ════════════════════
║  A file on your disk is one machine away from being lost. The run is
║  NOT complete until the agentId is in prod:
║
║    netlify env:set ${TARGET.envKey} ${agentId} --context production
║
║  Then confirm it took (env:list lies; env:get prints "No value set"
║  to stdout at exit 0 when unset, so read the actual value):
║
║    netlify env:get ${TARGET.envKey} --context production
║
║  Then update the public mirror's README with the concrete agentId.
║  The README is not part of the CID, so that edit is free:
║    ${TARGET.mirror}
║
║  ⛔ ${path.relative(REPO_ROOT, LOCAL_DOC)} MUST NOT be edited. Ever. It is
║     self-referential: it asserts tokenURI == the CID of its own bytes.
╚════════════════════════════════════════════════════════════════════
`);
