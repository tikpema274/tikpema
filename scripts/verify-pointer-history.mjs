#!/usr/bin/env node
// verify-pointer-history.mjs — prove the record survives a supersession, WITHOUT writing
// anything and WITHOUT touching the chain.
//
//   node scripts/verify-pointer-history.mjs
//
// ⭐ WHY THIS EXISTS. The dangerous moment in step 4 is not the on-chain write — that is
// simulated, guarded, and reversible by another write. It is the LOCAL RECORD, where
// agentId 851891's registration txHash 0xd33cb296… lives and lives nowhere else. If a
// supersession overwrites it, nothing on-chain is wrong and nothing complains; the fact is
// simply gone, and the loss is invisible until someone needs it.
//
// So the record rule is exercised here against the REAL on-disk record, in memory, before
// any write happens — including the failure cases, because a guard that has only been seen
// passing has not been seen working.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { appendPointerMove, PointerHistoryError } from "./_pointer-history.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RECORD = path.join(__dirname, "..", "agent-metadata/REGISTERED-IDENTITY-dd-service.json");

const REGISTRATION_TX = "0xd33cb296ba2dcc68c29e29cef055f9b959973b11eea3d0a97dadfa9437db20f1";
const V100_CID = "bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4";
const V100_SHA = "d3734accb6390a361df2daf87b49c41d4a44d30bfc9285f47be3c3284dbb402f";
const V110_CID = "bafkreib6viz4fqa4oqrrgxfecwcttxyda6ilm5nmzr7yplznqeahqmomla";
const V110_SHA = "3eaa33c2c01c7423135ca4158539df030790b675accc7f87af2d81007831cc58";
const SET_URI_TX = "0x" + "ab".repeat(32); // stand-in for the not-yet-existing setAgentURI tx

const EXPECT = {
  agentId: "851891",
  registrationTxHash: REGISTRATION_TX,
  supersedesVersion: "1.0.0",
  supersedesCid: V100_CID,
};

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const refuses = async (name, fn, mustMention) => {
  try { fn(); console.log(`   ❌ ${name} — DID NOT REFUSE`); failures++; }
  catch (e) {
    const right = e instanceof PointerHistoryError && (!mustMention || e.message.includes(mustMention));
    console.log(`   ${right ? "✅" : "❌"} ${name} — refused: ${e.message.split("\n")[0].slice(0, 96)}`);
    if (!right) failures++;
  }
};

const prior = JSON.parse(await readFile(RECORD, "utf8"));

console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  POINTER-HISTORY RULE — dry, against the real record, no writes      ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);

console.log("── the record as it stands on disk ─────────────────────────────────");
console.log(`   agentId          ${prior.agentId}`);
console.log(`   txHash           ${prior.txHash}`);
console.log(`   cid              ${prior.cid}`);
console.log(`   pointerHistory   ${Array.isArray(prior.pointerHistory) ? prior.pointerHistory.length + " entries" : "ABSENT (first supersession)"}`);
ok("record.txHash IS the registration tx", prior.txHash?.toLowerCase() === REGISTRATION_TX);
ok("record.cid IS the v1.0.0 CID", prior.cid === V100_CID);

// ═══ THE QUESTION T ASKED: does the seed pick up the REGISTRATION hash? ═══
console.log("\n── ⭐ SEEDING — pointerHistory[0] on the first (SUBMIT) write ───────");
const submitEntry = {
  version: "1.1.0", cid: V110_CID, sha256: V110_SHA, tokenURI: `ipfs://${V110_CID}`,
  txHash: null, circleTxId: "00000000-1111-2222-3333-444444444444", at: "2026-08-18T00:00:00.000Z",
  how: "setAgentURI(uint256,string) — supersession", note: "SUBMITTED — not yet confirmed.",
};
const { merged: afterSubmit, seeded } = appendPointerMove(prior, submitEntry, EXPECT);
const h0 = afterSubmit.pointerHistory[0];

ok("seeded on the first write", seeded === true);
ok("🚨 pointerHistory[0].txHash === 0xd33cb296…", h0.txHash?.toLowerCase() === REGISTRATION_TX, h0.txHash);
ok("pointerHistory[0].how says 'the original registration'", /original registration/.test(h0.how));
ok("pointerHistory[0].version === 1.0.0", h0.version === "1.0.0");
ok("pointerHistory[0].cid === the v1.0.0 CID", h0.cid === V100_CID);
ok("pointerHistory[0].sha256 === the v1.0.0 hash", h0.sha256 === V100_SHA);
ok("pointerHistory[0].circleTxId preserved", h0.circleTxId === prior.circleTxId, h0.circleTxId);
ok("registrationTxHash pinned separately", afterSubmit.registrationTxHash?.toLowerCase() === REGISTRATION_TX);
// ⚠️ On the SUBMIT write the new txHash is still null, so the top-level txHash must NOT be
// blanked — that is the mergePreservingProvenance invariant, still needed inside this rule.
ok("top-level txHash not blanked by a null incoming value", afterSubmit.txHash?.toLowerCase() === REGISTRATION_TX);

console.log("\n── the second (CONFIRM) write — no reseed, history grows ────────────");
const confirmEntry = { ...submitEntry, txHash: SET_URI_TX, note: "CONFIRMED by this run." };
const { merged: afterConfirm, seeded: seeded2 } = appendPointerMove(afterSubmit, confirmEntry, EXPECT);
ok("did NOT reseed", seeded2 === false);
ok("history is append-only (3 entries)", afterConfirm.pointerHistory.length === 3, `${afterConfirm.pointerHistory.length}`);
ok("🚨 pointerHistory[0] STILL the registration tx", afterConfirm.pointerHistory[0].txHash?.toLowerCase() === REGISTRATION_TX);
ok("registrationTxHash STILL the registration tx", afterConfirm.registrationTxHash?.toLowerCase() === REGISTRATION_TX);
ok("top-level txHash is now the setAgentURI tx", afterConfirm.txHash === SET_URI_TX);
ok("top-level cid is now v1.1.0", afterConfirm.cid === V110_CID);
ok("top-level sha256 is now v1.1.0", afterConfirm.sha256 === V110_SHA);
ok("currentVersion === 1.1.0", afterConfirm.currentVersion === "1.1.0");
// ⭐ THE WHOLE POINT: the superseded document's coordinates survive the move.
ok("⭐ v1.0.0 CID still recoverable from the record", JSON.stringify(afterConfirm).includes(V100_CID));
ok("⭐ v1.0.0 sha256 still recoverable from the record", JSON.stringify(afterConfirm).includes(V100_SHA));

// ═══ THE FAILURE CASES — a guard only seen passing has not been seen working ═══
console.log("\n── refusals (each of these MUST refuse) ────────────────────────────");

// 🚨 THE EXACT BUG T ASKED ABOUT: a record whose txHash is no longer the registration.
// Without the assertion this seeds pointerHistory[0] with the setAgentURI hash and labels
// it "the original registration" — permanently, and it looks completely normal.
await refuses("record.txHash is NOT the registration tx (the mislabel bug)",
  () => appendPointerMove({ ...prior, txHash: SET_URI_TX }, submitEntry, EXPECT), "expected the REGISTRATION tx");

await refuses("no prior record at all",
  () => appendPointerMove(null, submitEntry, EXPECT), "refusing to write a fresh one over an absence");

await refuses("record has no txHash to seed from",
  () => appendPointerMove({ ...prior, txHash: null }, submitEntry, EXPECT), "no txHash to seed");

await refuses("record is for a different agentId",
  () => appendPointerMove({ ...prior, agentId: "851823" }, submitEntry, EXPECT), "expected 851891");

await refuses("record.cid is not the CID being superseded",
  () => appendPointerMove({ ...prior, cid: "bafkreiSOMETHINGELSE" }, submitEntry, EXPECT), "does not describe the pointer");

await refuses("caller forgot to pass the expected registration tx",
  () => appendPointerMove(prior, submitEntry, { ...EXPECT, registrationTxHash: null }), "must be asserted, not inferred");

console.log("\n════════════════════════════════════════════════════════════════════════");
if (failures) { console.log(`❌ ${failures} check(s) failed — do NOT run step 4.`); process.exit(1); }
console.log(`✅ ALL CHECKS PASS — the record survives the supersession.`);
console.log(`   pointerHistory[0].txHash = ${REGISTRATION_TX}`);
console.log(`   asserted against a constant, so the seed cannot silently pick up the wrong tx.`);
console.log(`   ⚠️  Nothing was written. This ran entirely in memory.\n`);
