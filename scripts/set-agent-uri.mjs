#!/usr/bin/env node
// set-agent-uri.mjs — STEP 4 of the DD identity supersession: move tokenURI(851891)
// from the v1.0.0 document to the v1.1.0 document that supersedes it.
//
// ═══ ⚠️ REAL ON-CHAIN WRITE + REAL TESTNET USDC. Requires --confirm; a bare run
// ═══ prints the plan, runs every guard, and exits without touching anything.
//
//   node --env-file=.env scripts/set-agent-uri.mjs --target dd-service-v1.1.0
//   node --env-file=.env scripts/set-agent-uri.mjs --target dd-service-v1.1.0 --confirm
//   node --env-file=.env scripts/set-agent-uri.mjs --target dd-service-v1.1.0 --resume <circleTxId>
//
// ⭐ THE OPERATOR RUNS THIS. Not the agent. It moves a permanent public pointer.
//
// ───────────────────────────────────────────────────────────────────────────────
// 🚨 GUARD 1 IS THE ONE THAT MATTERS, AND IT IS NOT ABOUT THE CHAIN.
//
// This write must NOT run until https://app.tikpema.xyz/api/dd-identity is live AND
// reporting v1.1.0 as current with v1.0.0 superseded_by "1.1.0".
//
// Not a style preference — a correctness precondition. The companion payload contains a
// field `pointer_expectation` which states, to every reader: "This route is deployed
// BEFORE setAgentURI is sent, so during the changeover it runs AHEAD of the chain rather
// than behind it." That sentence is FALSE until the route ships. Sending setAgentURI first
// would point the chain at a document whose own named companion still calls v1.0.0 current
// and lists v1.1.0 nowhere — i.e. a companion that denies the existence of the document
// the chain now points at. That is structurally the SAME defect v1.1.0 was written to
// correct: v1.0.0 named a companion that could not be reached. A companion that can be
// reached and contradicts the document is not an improvement on one that 404s.
//
// So the guard is fail-closed and has a CLOSED outcome set: LIVE-AND-CURRENT proceeds;
// anything else — stale payload, HTTP error, unparseable body, timeout — REFUSES. An
// unreachable companion is never read as "probably fine by now".
// ───────────────────────────────────────────────────────────────────────────────
//
// THE OTHER GUARDS
//
//   0. WALLET IDENTITY — the walletId's address must equal the expected owner.
//   2. BYTES PRE-FLIGHT — fetch the CID from public gateways, re-hash, compare to the
//      recorded sha256. Prevents pointing a permanent pointer at bytes nobody re-checked.
//   3. OWNERSHIP — ownerOf(851891) must be this wallet, agreed by TWO independent RPCs.
//   4. CURRENT POINTER — must still be the expected PREVIOUS uri. If it is already the
//      new one the run is INERT and exits 0; if it is neither, REFUSE (someone else moved
//      it, and this script must not race them).
//   5. SIMULATION — eth_call the exact calldata from the exact owner. ⭐ WITH A NEGATIVE
//      CONTROL: the same call from a non-owner MUST revert. A simulation that passes for
//      everybody proves nothing about authorisation, and would pass just as happily
//      against a contract with no auth check at all.
//
// ═══ 🚨 WHY THIS SCRIPT DOES NOT REUSE register-identity.mjs's persistId() ═══════════════
// That function writes the record with mergePreservingProvenance(), whose rule is "never
// downgrade a known value to null". It rescues a field only when the NEW value is null —
// and here every field it protects (txHash, tokenURI, cid, sha256) arrives NON-null and
// DIFFERENT. So the merge would not fire, and the write would silently replace:
//
//     txHash    0xd33cb296…  (the REGISTRATION of 851891)  →  the setAgentURI tx
//     cid       bafkreigton…o2af4                          →  bafkreib6vi…momla
//     sha256    d3734acc…                                  →  3eaa33c2…
//
// The registration txHash is the only local record of how 851891 came to exist, and the
// v1.0.0 cid is load-bearing FOREVER: two paid reports were produced under that document
// and their attestations resolve through it. Overwriting either is exactly the archaeology
// register-identity.mjs was written to prevent — reintroduced through the front door,
// because a supersession is the one operation whose new values are legitimately non-null.
//
// ⭐ THE FIX IS SHAPE, NOT A BIGGER GUARD: the record becomes a HISTORY. `pointerHistory[]`
// gains an entry per move and is append-only; `registrationTxHash` is pinned separately
// from the latest `txHash`. A supersession is an ADDITION to the record, never a mutation
// of it — the same rule the documents themselves follow.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { encodeFunctionData } from "viem";
import { circle, waitForTx, TxPendingError } from "../netlify/functions/_circle.mjs";
import { appendPointerMove, PointerHistoryError } from "./_pointer-history.mjs";

// ═══════════════════════ CONSTANTS THAT MUST NOT DRIFT ═══════════════════════

const WALLET_ID = "2c93ca5d-be5c-5f51-883d-1a220647f7b1";
const EXPECTED_ADDRESS = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const COMPANION = "https://app.tikpema.xyz/api/dd-identity";

// ⭐ TWO INDEPENDENT PROVIDERS, and every chain read must AGREE across both. One RPC is
// one instrument; six reads of one instrument is still n=1.
const RPCS = ["https://rpc.testnet.arc.network", "https://arc-testnet.drpc.org"];
// ⚠️ NOT rpc.testnet.arc.com — that host does not resolve. The TLD is .network.

const GATEWAYS = [
  (cid) => `https://ipfs.io/ipfs/${cid}`,
  (cid) => `https://dweb.link/ipfs/${cid}`,
  (cid) => `https://${cid}.ipfs.w3s.link`,
];

const SET_AGENT_URI_ABI = [{
  name: "setAgentURI", type: "function", stateMutability: "nonpayable",
  inputs: [{ name: "agentId", type: "uint256" }, { name: "agentUri", type: "string" }], outputs: [],
}];
// Verified by construction below, not asserted from memory: keccak("setAgentURI(uint256,string)")[0:4].
const EXPECTED_SELECTOR = "0x0af28bd3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ═══════════════════════════════ TARGETS ═══════════════════════════════
// ⚠️ NO DEFAULT. Moving a permanent pointer is not something a script may guess at.
const TARGETS = {
  "dd-service-v1.1.0": {
    label: "Tikpema DD Service — v1.0.0 → v1.1.0",
    agentId: 851891n,
    version: "1.1.0",
    cid: "bafkreib6viz4fqa4oqrrgxfecwcttxyda6ilm5nmzr7yplznqeahqmomla",
    sha256: "3eaa33c2c01c7423135ca4158539df030790b675accc7f87af2d81007831cc58",
    bytes: 18756,
    localDoc: path.join(REPO_ROOT, "agent-metadata/dd-service.v1.1.0.REGISTERED.json"),
    // The pointer this run expects to REPLACE. Asserted, never assumed.
    expectedCurrentCid: "bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4",
    supersedesVersion: "1.0.0",
    supersedesSha256: "d3734accb6390a361df2daf87b49c41d4a44d30bfc9285f47be3c3284dbb402f",
    // ⭐ ASSERTED, NOT INFERRED. pointerHistory[0] is seeded from the record's txHash and
    // LABELLED "the original registration" — a label that is correct only while that field
    // still holds the registration hash. Naming the expected value here makes the seed
    // correct by construction instead of by timing. See scripts/_pointer-history.mjs.
    registrationTxHash: "0xd33cb296ba2dcc68c29e29cef055f9b959973b11eea3d0a97dadfa9437db20f1",
    record: path.join(REPO_ROOT, "agent-metadata/REGISTERED-IDENTITY-dd-service.json"),
  },
};

// ═══════════════════════════════ CLI ═══════════════════════════════

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1] ?? null; };
const CONFIRM = argv.includes("--confirm");
const RESUME_TX = arg("--resume");
const TARGET_NAME = arg("--target");

const die = (m) => { console.error(`\n❌ REFUSING — ${m}\n`); process.exit(1); };

if (!TARGET_NAME) die(`--target is required. Known: ${Object.keys(TARGETS).join(", ")}`);
const T = TARGETS[TARGET_NAME];
if (!T) die(`unknown target "${TARGET_NAME}". Known: ${Object.keys(TARGETS).join(", ")}`);

const AGENT_URI = `ipfs://${T.cid}`;

console.log(`\n╔══ setAgentURI — ${T.label}`);
console.log(`║  agentId ${T.agentId}   →   ${AGENT_URI}`);
console.log(`║  mode: ${RESUME_TX ? "RESUME " + RESUME_TX : CONFIRM ? "🚨 WRITE" : "dry run"}`);
console.log(`╚═══════════════════════════════════════════════════════════════════\n`);

// ═══════════════════════════════ HELPERS ═══════════════════════════════

async function rpcCall(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json();
    return j.error ? { error: j.error } : { result: j.result };
  } catch (e) {
    return { error: { message: `transport: ${e.message}` } };
  } finally { clearTimeout(t); }
}

// ⭐ EVERY CHAIN READ GOES THROUGH HERE. Two providers, and DISAGREEMENT IS A REFUSAL —
// not a tie broken by whichever answered first. A read only one provider could serve is
// INDETERMINATE, and indeterminate never fills the result slot as "fine".
async function readBothRpcs(label, method, params) {
  const answers = [];
  for (const u of RPCS) {
    const r = await rpcCall(u, method, params);
    answers.push({ u, ...r });
    console.log(`     ${r.error ? "✗" : "✓"} ${u.replace("https://", "")} → ${r.error ? JSON.stringify(r.error).slice(0, 90) : String(r.result).slice(0, 76)}`);
  }
  const ok = answers.filter((a) => !a.error);
  if (ok.length < RPCS.length) return { state: "INDETERMINATE", note: `${label}: only ${ok.length}/${RPCS.length} providers answered` };
  const vals = [...new Set(ok.map((a) => a.result))];
  if (vals.length > 1) return { state: "DISAGREE", note: `${label}: providers disagree — ${vals.join(" vs ")}` };
  return { state: "OK", value: vals[0] };
}

function decodeString(hex) {
  if (!hex || hex === "0x") return null;
  const h = hex.slice(2);
  const len = parseInt(h.slice(64, 128), 16);
  if (!Number.isFinite(len)) return null;
  return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8");
}

// ═══════════════ GUARD 0 — the wallet is the wallet ═══════════════

console.log("── GUARD 0 — wallet identity ───────────────────────────────────────");
const client = circle();
let walletAddress;
try {
  const w = await client.getWallet({ id: WALLET_ID });
  walletAddress = w.data?.wallet?.address?.toLowerCase();
} catch (e) { die(`could not read walletId ${WALLET_ID} from Circle: ${e?.message}`); }
if (!walletAddress) die(`Circle returned no address for walletId ${WALLET_ID}. UNKNOWN is not a pass.`);
if (walletAddress !== EXPECTED_ADDRESS) die(`walletId ${WALLET_ID} is ${walletAddress}, expected ${EXPECTED_ADDRESS}`);
console.log(`  ✅ walletId ${WALLET_ID} → ${walletAddress}\n`);

// ═══════════════ 🚨 GUARD 1 — THE COMPANION MUST BE LIVE AND AHEAD ═══════════════

console.log("── 🚨 GUARD 1 — the companion route (THE blocking precondition) ────");
{
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let payload;
  try {
    const res = await fetch(COMPANION, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) die(`${COMPANION} returned HTTP ${res.status}. The route is not serving; step 4 must not run.`);
    payload = await res.json();
  } catch (e) {
    die(`${COMPANION} unreachable (${e.message}). An unreachable companion is NOT "probably fine by now" — ` +
        `the pointer_expectation text is false until this route is live, and this write would make the ` +
        `chain point at a document the companion denies exists.`);
  } finally { clearTimeout(t); }

  const currentCid = payload?.current_document?.cid;
  const currentVer = payload?.current_document?.version;
  const versions = Array.isArray(payload?.versions) ? payload.versions : [];
  const prior = versions.find((v) => v?.version === T.supersedesVersion);

  if (!currentCid) die(`companion answered 200 but named no current_document.cid — payload shape changed; this guard has lost its grip.`);
  if (currentCid !== T.cid)
    die(`companion still reports current CID ${currentCid}, expected ${T.cid}.\n` +
        `   → The route has NOT been redeployed with v${T.version}. Deploy it FIRST, then re-run.\n` +
        `   → Sending setAgentURI now points the chain at a document whose own companion calls\n` +
        `     v${T.supersedesVersion} current and lists v${T.version} nowhere.`);
  if (currentVer !== T.version) die(`companion current_document.version is ${currentVer}, expected ${T.version}`);
  if (!prior) die(`companion's versions[] has no v${T.supersedesVersion} entry — the supersession chain is not published.`);
  if (prior.superseded_by !== T.version)
    die(`companion still says v${T.supersedesVersion}.superseded_by = ${JSON.stringify(prior.superseded_by)}, expected "${T.version}".`);

  console.log(`  ✅ live, current = v${currentVer} ${currentCid.slice(0, 14)}…`);
  console.log(`  ✅ v${T.supersedesVersion}.superseded_by = "${prior.superseded_by}"`);
  console.log(`  ⭐ the companion is AHEAD of the chain — the correct direction. Proceed.\n`);
}

// ═══════════════ GUARD 2 — the bytes, re-hashed from the network ═══════════════

console.log("── GUARD 2 — bytes pre-flight ──────────────────────────────────────");
{
  const local = await readFile(T.localDoc);
  const localSha = createHash("sha256").update(local).digest("hex");
  if (local.length !== T.bytes) die(`${T.localDoc} is ${local.length} bytes, expected ${T.bytes}. The bytes moved after pinning — the CID no longer describes them.`);
  if (localSha !== T.sha256) die(`${T.localDoc} hashes ${localSha}, expected ${T.sha256}.`);
  console.log(`  ✅ local ${T.bytes} bytes, sha256 ${localSha.slice(0, 16)}…`);

  let served = 0;
  for (const g of GATEWAYS) {
    const url = g(T.cid);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) { console.log(`     ✗ ${new URL(url).host} HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const sha = createHash("sha256").update(buf).digest("hex");
      if (sha !== T.sha256) die(`${new URL(url).host} served ${buf.length} bytes hashing ${sha} — DIFFERENT BYTES at the same CID. Stop and investigate.`);
      console.log(`     ✓ ${new URL(url).host} ${buf.length} bytes — hash MATCH`);
      served++;
    } catch (e) { console.log(`     ✗ ${new URL(url).host} ${e.message}`); }
    finally { clearTimeout(t); }
  }
  // ⚠️ A COLD FETCH LEGITIMATELY 504s — measured on both v1.0.0 and v1.1.0. So the bar is
  // "at least one gateway served the right bytes", not "all did". But ZERO is a refusal:
  // pointing the chain at bytes no gateway will serve is publishing a dead pointer.
  if (!served) die(`NO gateway served ${T.cid}. Do not point the chain at bytes nobody can fetch.`);
  console.log(`  ✅ ${served}/${GATEWAYS.length} gateway(s) served correct bytes`);
  console.log(`  ⚠️  that is RETRIEVAL, not custody — all of them fetch from the same single`);
  console.log(`      pinning operator. See npm run gate:pins.\n`);
}

// ═══════════════ GUARD 3 + 4 — ownership and the current pointer ═══════════════

console.log("── GUARD 3 — ownerOf, across two independent providers ─────────────");
const idHex = T.agentId.toString(16).padStart(64, "0");
{
  const r = await readBothRpcs("ownerOf", "eth_call", [{ to: IDENTITY_REGISTRY, data: "0x6352211e" + idHex }, "latest"]);
  if (r.state !== "OK") die(r.note);
  const owner = "0x" + r.value.slice(-40);
  if (owner.toLowerCase() !== EXPECTED_ADDRESS) die(`ownerOf(${T.agentId}) is ${owner}, not ${EXPECTED_ADDRESS}. This wallet cannot move that pointer.`);
  console.log(`  ✅ ownerOf(${T.agentId}) = ${owner}\n`);
}

console.log("── GUARD 4 — the pointer this run expects to replace ───────────────");
{
  const r = await readBothRpcs("tokenURI", "eth_call", [{ to: IDENTITY_REGISTRY, data: "0xc87b56dd" + idHex }, "latest"]);
  if (r.state !== "OK") die(r.note);
  const uri = decodeString(r.value);
  if (uri === AGENT_URI) {
    console.log(`  ⭐ ALREADY ${AGENT_URI}`);
    console.log(`     The pointer has already moved. This run is INERT — nothing to do.\n`);
    process.exit(0);
  }
  if (uri !== `ipfs://${T.expectedCurrentCid}`)
    die(`tokenURI(${T.agentId}) is ${uri}\n   expected ipfs://${T.expectedCurrentCid}\n` +
        `   Someone or something moved this pointer. Do not race it — reconcile the record first.`);
  console.log(`  ✅ currently ipfs://${T.expectedCurrentCid.slice(0, 14)}… (v${T.supersedesVersion}, as expected)\n`);
}

// ═══════════════ GUARD 5 — simulate, WITH a negative control ═══════════════

console.log("── GUARD 5 — simulation + negative control ─────────────────────────");
const CALLDATA = encodeFunctionData({ abi: SET_AGENT_URI_ABI, functionName: "setAgentURI", args: [T.agentId, AGENT_URI] });
if (!CALLDATA.startsWith(EXPECTED_SELECTOR)) die(`calldata selector ${CALLDATA.slice(0, 10)} ≠ ${EXPECTED_SELECTOR}`);
console.log(`  selector ${CALLDATA.slice(0, 10)}  (setAgentURI(uint256,string)), ${(CALLDATA.length - 2) / 2} bytes calldata`);
{
  const good = await readBothRpcs("simulate as owner", "eth_call", [{ from: EXPECTED_ADDRESS, to: IDENTITY_REGISTRY, data: CALLDATA }, "latest"]);
  if (good.state !== "OK") die(`the call does NOT simulate clean from the owner — ${good.note}`);
  console.log(`  ✅ simulates clean from the owner`);

  // ⭐ WITHOUT THIS, GUARD 5 IS DECORATIVE. A call that succeeds for everyone would pass the
  // check above against a registry with no authorisation at all — the check would be
  // measuring "the RPC answered", not "this wallet may do this".
  let reverted = 0;
  for (const u of RPCS) {
    const r = await rpcCall(u, "eth_call", [{ from: "0x000000000000000000000000000000000000dEaD", to: IDENTITY_REGISTRY, data: CALLDATA }, "latest"]);
    if (r.error) reverted++;
  }
  if (reverted < RPCS.length) die(`NEGATIVE CONTROL FAILED — the same call did NOT revert from a non-owner on ${RPCS.length - reverted} provider(s). ` +
                                  `Either authorisation is not enforced, or the simulation is not measuring what it claims.`);
  console.log(`  ✅ negative control: reverts from a non-owner on ${reverted}/${RPCS.length} providers ("Not authorized")\n`);
}

// ═══════════════ COST ═══════════════
{
  const g = await rpcCall(RPCS[0], "eth_estimateGas", [{ from: EXPECTED_ADDRESS, to: IDENTITY_REGISTRY, data: CALLDATA }]);
  const p = await rpcCall(RPCS[0], "eth_gasPrice", []);
  const b = await rpcCall(RPCS[0], "eth_getBalance", [EXPECTED_ADDRESS, "latest"]);
  if (g.result && p.result) {
    const cost = Number(BigInt(g.result) * BigInt(p.result)) / 1e18;
    console.log(`── COST ────────────────────────────────────────────────────────────`);
    console.log(`  gas ${BigInt(g.result)} @ ${BigInt(p.result)} wei  ≈ ${cost.toFixed(8)} USDC`);
    if (b.result) console.log(`  wallet balance ≈ ${(Number(BigInt(b.result)) / 1e18).toFixed(6)} USDC (native gas on Arc IS USDC, 18-dp view)`);
    console.log(`  self-paid gas, no paymaster.\n`);
  }
}

// ═══════════════════════════ DRY RUN STOPS HERE ═══════════════════════════
if (!CONFIRM && !RESUME_TX) {
  console.log("╔══ DRY RUN — nothing was written ═══════════════════════════════════");
  console.log("║  Every guard PASSED. The write would be:");
  console.log("║");
  console.log(`║    setAgentURI(${T.agentId}, "${AGENT_URI}")`);
  console.log(`║    → ${IDENTITY_REGISTRY}`);
  console.log(`║    from walletId ${WALLET_ID} (${walletAddress})`);
  console.log("║");
  console.log("║  Re-run with --confirm to execute. YOU run it — not the agent.");
  console.log("╚════════════════════════════════════════════════════════════════════\n");
  process.exit(0);
}

// ═══════════════════════════ THE WRITE ═══════════════════════════════

async function appendHistory(entry) {
  // The rule itself lives in ./_pointer-history.mjs — pure, and unit-tested against the real
  // record by scripts/verify-pointer-history.mjs WITHOUT touching the chain.
  let prior = null;
  try { prior = JSON.parse(await readFile(T.record, "utf8")); } catch { prior = null; }
  let merged, seeded;
  try {
    ({ merged, seeded } = appendPointerMove(prior, entry, {
      agentId: T.agentId.toString(),
      registrationTxHash: T.registrationTxHash,
      supersedesVersion: T.supersedesVersion,
      supersedesCid: T.expectedCurrentCid,
    }));
  } catch (e) {
    if (e instanceof PointerHistoryError) die(`${T.record}: ${e.message}`);
    throw e;
  }
  merged.writtenAt = new Date().toISOString();
  await writeFile(T.record, JSON.stringify(merged, null, 2) + "\n");
  if (seeded) console.log(`  🛡 seeded pointerHistory[0] with the ORIGINAL registration ${T.registrationTxHash.slice(0, 12)}… (asserted, not inferred)`);
  console.log(`  💾 PERSISTED → ${T.record}  (pointerHistory now ${merged.pointerHistory.length} entr${merged.pointerHistory.length === 1 ? "y" : "ies"})`);
}

let circleTxId = RESUME_TX;
if (!RESUME_TX) {
  console.log("── THE WRITE — submitting setAgentURI ──────────────────────────────");
  const tx = await client.createContractExecutionTransaction({
    walletId: WALLET_ID,
    contractAddress: IDENTITY_REGISTRY,
    abiFunctionSignature: "setAgentURI(uint256,string)",
    abiParameters: [T.agentId.toString(), AGENT_URI],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  circleTxId = tx.data?.id;
  if (!circleTxId) die("Circle returned no transaction id. The write may still land — check the wallet before retrying.");

  // ⭐ PERSIST THE HANDLE BEFORE WAITING. If the wait times out or the terminal dies, the
  // tx may STILL land, and without this there is no local trace of how to find it.
  await appendHistory({
    version: T.version, cid: T.cid, sha256: T.sha256, tokenURI: AGENT_URI,
    txHash: null, circleTxId, at: new Date().toISOString(),
    how: "setAgentURI(uint256,string) — supersession",
    note: `SUBMITTED — not yet confirmed. Resume with: node --env-file=.env scripts/set-agent-uri.mjs --target ${TARGET_NAME} --resume ${circleTxId}`,
  });
  console.log(`  circle tx id: ${circleTxId}  (persisted BEFORE waiting)`);
}

console.log("\n── waiting for settlement ──────────────────────────────────────────");
let txHash;
try { txHash = await waitForTx(client, circleTxId); }
catch (e) {
  if (e instanceof TxPendingError)
    die(`Still PENDING after the deadline. THE TRANSACTION MAY STILL LAND.\n` +
        `   Do NOT re-run without --resume.\n` +
        `   Resume with: node --env-file=.env scripts/set-agent-uri.mjs --target ${TARGET_NAME} --resume ${circleTxId}`);
  die(`Transaction failed: ${e?.message}`);
}
console.log(`  tx hash : ${txHash}`);
console.log(`  explorer: https://testnet.arcscan.app/tx/${txHash}`);

await appendHistory({
  version: T.version, cid: T.cid, sha256: T.sha256, tokenURI: AGENT_URI,
  txHash, circleTxId, at: new Date().toISOString(),
  how: "setAgentURI(uint256,string) — supersession",
  note: "CONFIRMED by this run.",
});

// ═══════════════ READ BACK FROM CHAIN ═══════════════
console.log("\n── post-write verification (read back, both providers) ─────────────");
{
  const r = await readBothRpcs("tokenURI", "eth_call", [{ to: IDENTITY_REGISTRY, data: "0xc87b56dd" + idHex }, "latest"]);
  if (r.state !== "OK") { console.log(`  ⚠️  ${r.note} — the write landed; verify by hand.`); process.exit(1); }
  const uri = decodeString(r.value);
  const ok = uri === AGENT_URI;
  console.log(`  tokenURI(${T.agentId}) = ${uri}  ${ok ? "✅ matches" : "❌ MISMATCH"}`);
  if (!ok) process.exit(1);
}

console.log(`\n✅ STEP 4 COMPLETE. Now run step 5:`);
console.log(`   node scripts/verify-supersession.mjs --target ${TARGET_NAME}\n`);
