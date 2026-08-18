#!/usr/bin/env node
// verify-supersession.mjs — STEP 5: prove the supersession landed, from OUTSIDE.
//
//   node scripts/verify-supersession.mjs --target dd-service-v1.1.0
//
// ⭐ READ-ONLY AND SAFE TO RUN AT ANY TIME — before step 4, during, or after. No
// credential, no write, no Circle call. It is designed to be run BEFORE the pointer
// moves too, because a check you have never seen fail tells you nothing: run it first,
// watch CHECK 1 report NOT-YET-MOVED, then run it again after and watch it flip.
//
// ═══ THE THREE CHECKS T ASKED FOR ═══════════════════════════════════════════════════
//   1. tokenURI(851891) on TWO INDEPENDENT RPCs → the new ipfs:// URI, both agreeing
//   2. /api/dd-identity reports v1.1.0 current AND v1.0.0 superseded_by "1.1.0"
//   3. gate:pins' copy-drift check → OK (every CID the companion names is a CID the
//      pinning gate knows about and measures)
//
// ⭐ PLUS the one that makes the other three mean something: the bytes at the new CID
// are FETCHED and RE-HASHED. Checks 1–3 all compare strings to other strings — they
// would pass identically against a CID pointing at nothing at all.
//
// ═══ 🚨 EXIT CODES — AND WHY "NOT YET" IS NOT A FAILURE ══════════════════════════════
//   0  SUPERSEDED   — everything agrees, the move is complete and verifiable
//   0  NOT-YET      — the pointer has not moved; companion is AHEAD, which is CORRECT
//                     before step 4. Reported plainly, never as a pass and never as a fail.
//   1  INCONSISTENT — something disagrees with something else. This is the real failure.
//
// ⚠️ NOT-YET and SUPERSEDED are DIFFERENT OUTCOMES that both exit 0, and the script says
// which one out loud. Collapsing them would make "the deploy shipped but the chain was
// never touched" read exactly like success — the absence-reads-as-safe shape again.

import { createHash } from "node:crypto";

const TARGETS = {
  "dd-service-v1.1.0": {
    label: "Tikpema DD Service — v1.0.0 → v1.1.0",
    agentId: 851891n,
    registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    owner: "0xc54d47211997aca90ef4fcfbc742a3b511b4e621",
    version: "1.1.0",
    cid: "bafkreib6viz4fqa4oqrrgxfecwcttxyda6ilm5nmzr7yplznqeahqmomla",
    sha256: "3eaa33c2c01c7423135ca4158539df030790b675accc7f87af2d81007831cc58",
    bytes: 18756,
    supersedesVersion: "1.0.0",
    supersedesCid: "bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4",
  },
};

const RPCS = ["https://rpc.testnet.arc.network", "https://arc-testnet.drpc.org"];
const COMPANION = "https://app.tikpema.xyz/api/dd-identity";
const GATEWAYS = [
  (c) => `https://ipfs.io/ipfs/${c}`,
  (c) => `https://dweb.link/ipfs/${c}`,
  (c) => `https://${c}.ipfs.w3s.link`,
];

const argv = process.argv.slice(2);
const i = argv.indexOf("--target");
const TARGET_NAME = i === -1 ? null : argv[i + 1];
if (!TARGET_NAME || !TARGETS[TARGET_NAME]) {
  console.error(`--target is required. Known: ${Object.keys(TARGETS).join(", ")}`);
  process.exit(1);
}
const T = TARGETS[TARGET_NAME];
const AGENT_URI = `ipfs://${T.cid}`;

console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  SUPERSESSION VERIFICATION — ${T.label}`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

let failures = 0;
let pointerMoved = null; // tri-state: true | false | null (UNREADABLE)

async function jrpc(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    return j.error ? { error: j.error.message ?? JSON.stringify(j.error) } : { result: j.result };
  } catch (e) { return { error: `transport: ${e.message}` }; }
  finally { clearTimeout(t); }
}
const decodeString = (hex) => {
  if (!hex || hex === "0x") return null;
  const h = hex.slice(2);
  const len = parseInt(h.slice(64, 128), 16);
  return Number.isFinite(len) ? Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8") : null;
};

// ═══ CHECK 1 — the chain, on two independent providers ═══
console.log("── CHECK 1 — tokenURI on two independent RPCs ──────────────────────");
{
  const idHex = T.agentId.toString(16).padStart(64, "0");
  const seen = [];
  for (const u of RPCS) {
    const r = await jrpc(u, "eth_call", [{ to: T.registry, data: "0xc87b56dd" + idHex }, "latest"]);
    const uri = r.error ? null : decodeString(r.result);
    seen.push({ u, uri, error: r.error });
    console.log(`   ${uri ? "·" : "✗"} ${u.replace("https://", "").padEnd(28)} ${uri ?? "UNREADABLE (" + r.error + ")"}`);
  }
  const readable = seen.filter((s) => s.uri);
  if (readable.length < RPCS.length) {
    // 🚨 TRI-STATE. Not "the pointer did not move" — nobody could SEE the pointer. An
    // unreadable chain must never collapse into either verdict.
    console.log(`   ⚠️  UNREADABLE on ${RPCS.length - readable.length}/${RPCS.length} provider(s) — INDETERMINATE, not a verdict.`);
    failures++;
  } else {
    const vals = [...new Set(readable.map((s) => s.uri))];
    if (vals.length > 1) { console.log(`   ❌ PROVIDERS DISAGREE: ${vals.join("  vs  ")}`); failures++; }
    else if (vals[0] === AGENT_URI) { pointerMoved = true; console.log(`   ✅ MOVED — both providers agree: ${AGENT_URI}`); }
    else if (vals[0] === `ipfs://${T.supersedesCid}`) { pointerMoved = false; console.log(`   ⏳ NOT YET MOVED — still v${T.supersedesVersion}. Expected before step 4.`); }
    else { console.log(`   ❌ UNEXPECTED URI: ${vals[0]}`); failures++; }
  }
  // ownerOf, because a pointer is only meaningful alongside who may move it.
  const o = await jrpc(RPCS[0], "eth_call", [{ to: T.registry, data: "0x6352211e" + idHex }, "latest"]);
  const owner = o.error ? null : "0x" + o.result.slice(-40);
  const ownerOk = owner && owner.toLowerCase() === T.owner;
  console.log(`   ${ownerOk ? "✅" : "❌"} ownerOf(${T.agentId}) = ${owner ?? "UNREADABLE"}`);
  if (!ownerOk) failures++;
}

// ═══ CHECK 2 — the companion ═══
console.log("\n── CHECK 2 — /api/dd-identity ──────────────────────────────────────");
let companionCurrentCid = null;
{
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(COMPANION, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (!res.ok) { console.log(`   ❌ HTTP ${res.status}`); failures++; }
    else {
      const d = await res.json();
      const cur = d?.current_document;
      const versions = Array.isArray(d?.versions) ? d.versions : [];
      const prior = versions.find((v) => v?.version === T.supersedesVersion);
      companionCurrentCid = cur?.cid ?? null;

      const curOk = cur?.version === T.version && cur?.cid === T.cid;
      console.log(`   ${curOk ? "✅" : "❌"} current_document = v${cur?.version} ${String(cur?.cid).slice(0, 20)}…`);
      if (!curOk) failures++;

      const supOk = prior && prior.superseded_by === T.version;
      console.log(`   ${supOk ? "✅" : "❌"} v${T.supersedesVersion}.superseded_by = ${JSON.stringify(prior?.superseded_by)}`);
      if (!supOk) failures++;

      const stillListed = prior && prior.cid === T.supersedesCid;
      console.log(`   ${stillListed ? "✅" : "❌"} v${T.supersedesVersion} still listed with its own CID (the record does not erase what it supersedes)`);
      if (!stillListed) failures++;

      // ⭐ The empty-errata guard. An empty list must SAY it means "nothing found yet".
      const newEntry = versions.find((v) => v?.version === T.version);
      const errataGuarded = !newEntry || (Array.isArray(newEntry.known_errata) && newEntry.known_errata.length) || newEntry.errata_note;
      console.log(`   ${errataGuarded ? "✅" : "⚠️ "} v${T.version} empty known_errata carries an errata_note (absence must not read as audited-clean)`);
      if (!errataGuarded) failures++;
    }
  } catch (e) { console.log(`   ❌ unreachable: ${e.message}`); failures++; }
  finally { clearTimeout(t); }
}

// ═══ CHECK 3 — the copy-drift check inside gate:pins ═══
console.log("\n── CHECK 3 — gate:pins copy-drift ──────────────────────────────────");
console.log("   (every CID the companion names must be one the pinning gate measures)");
{
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", ["scripts/verify-pin-providers.mjs"], { encoding: "utf8", timeout: 180000 });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  const line = out.split("\n").find((l) => /^\s+(OK|DRIFT|UNKNOWN) — /.test(l));
  if (!line) { console.log(`   ❌ could not find the drift verdict in gate:pins output`); failures++; }
  else {
    const state = line.trim().split(" ")[0];
    console.log(`   ${state === "OK" ? "✅" : "❌"} drift: ${line.trim()}`);
    if (state !== "OK") failures++;
  }
  // ⚠️ EXPECTED AND NOT A REGRESSION: gate:pins itself exits 1 while all three CIDs are
  // announced by a single operator. That is the ITEM-1 finding, not a supersession defect,
  // so it is reported here and deliberately NOT counted as a failure of this script.
  const ops = out.match(/❌ SINGLE OPERATOR \(([^)]+)\)/g) ?? [];
  if (ops.length) {
    console.log(`   ⚠️  gate:pins exits ${r.status} — ${ops.length} CID(s) on a SINGLE pinning operator.`);
    console.log(`      EXPECTED at this step and NOT a regression: pinning v${T.version} DOUBLED that`);
    console.log(`      exposure rather than addressing it. A second operator is still the open item.`);
  }
}

// ═══ CHECK 4 — the bytes actually exist and hash right ═══
console.log("\n── CHECK 4 — fetch the CID and re-hash (checks 1–3 are string compares) ──");
{
  let served = 0;
  for (const g of GATEWAYS) {
    const url = g(T.cid);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) { console.log(`   ✗ ${new URL(url).host.padEnd(24)} HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const sha = createHash("sha256").update(buf).digest("hex");
      const ok = sha === T.sha256 && buf.length === T.bytes;
      console.log(`   ${ok ? "✓" : "❌"} ${new URL(url).host.padEnd(24)} ${buf.length} bytes  sha256 ${sha.slice(0, 16)}…`);
      if (!ok) failures++; else served++;
    } catch (e) { console.log(`   ✗ ${new URL(url).host.padEnd(24)} ${e.message}`); }
    finally { clearTimeout(t); }
  }
  if (!served) { console.log(`   ❌ NO gateway served the bytes.`); failures++; }
  else {
    console.log(`   ✅ ${served}/${GATEWAYS.length} served bytes hashing to the CID`);
    console.log(`   ⚠️  RETRIEVAL, NOT CUSTODY — these gateways all fetch from the same single`);
    console.log(`      pinning operator. ${served} successes is ${served} readers of one copy.`);
  }
}

// ═══ VERDICT ═══
console.log("\n════════════════════════════════════════════════════════════════════════");
if (failures) {
  console.log(`❌ INCONSISTENT — ${failures} check(s) failed. Do not treat the supersession as done.`);
  process.exit(1);
}
if (pointerMoved === true) {
  console.log(`✅ SUPERSEDED — tokenURI(${T.agentId}) resolves to v${T.version}, the companion agrees,`);
  console.log(`   every named CID is measured, and the bytes fetch and re-hash correctly.`);
  console.log(`\n   ⭐ STILL OPEN: a SECOND PINNING OPERATOR. Three CIDs, one operator.`);
  process.exit(0);
}
if (pointerMoved === false) {
  console.log(`⏳ NOT YET — everything checked is CONSISTENT, but the chain still points at`);
  console.log(`   v${T.supersedesVersion}. The companion is AHEAD of the chain, which is the correct`);
  console.log(`   direction before step 4. This is NOT a pass and NOT a failure.`);
  console.log(`\n   Step 4:  node --env-file=.env scripts/set-agent-uri.mjs --target ${TARGET_NAME} --confirm`);
  process.exit(0);
}
console.log(`⚠️  INDETERMINATE — the chain could not be read. No verdict is available.`);
process.exit(1);
