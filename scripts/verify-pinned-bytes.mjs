#!/usr/bin/env node
// verify-pinned-bytes.mjs — A PINNED DOCUMENT'S BYTES ARE ITS ADDRESS. GUARD THEM AUTOMATICALLY.
//
//   node scripts/verify-pinned-bytes.mjs      (also: npm run test:pinnedbytes, npm run test:all)
//
// ═══ 🚨 WHAT THIS CATCHES, AND WHY A LABEL WAS NOT ENOUGH ═════════════════════════════════════
// Every document in PINNED_SET is content-addressed: its CID is a pure function of its bytes, and
// each document ASSERTS that `tokenURI(agentId)` equals that CID. So ANY byte change — a reformat,
// a trailing newline, a re-serialise through JSON.parse, an editor's "clean up on save" — silently
// makes the document's own central claim false, and makes it no longer the thing the chain points
// at. Nothing about the file looks wrong afterwards.
//
// ⚠️ THE BYTES WERE ALREADY CHECKED — BUT ONLY BY SCRIPTS A HUMAN RUNS ON PURPOSE.
// `pin-second-operator.mjs` and `pin-invariants.mjs` both re-hash and die on mismatch, and
// `set-agent-uri.mjs` hashes the local doc before moving the pointer. None of them are in
// `test:all`. So before this suite existed, an accidental edit surfaced at `set-agent-uri.mjs` —
// i.e. at the exact moment an on-chain pointer was about to move. That is the most expensive
// possible place to discover it, and the discovery was luck rather than design.
//
// ⭐ A FILENAME IS A LABEL ASKING A HUMAN NOT TO EDIT. THIS IS A MECHANISM THAT CATCHES THEM WHEN
// THEY DO. Only the second one is a guard. Both are worth having; only one of them fails.
//
// ⚠️ AND IT IS WHAT MAKES A RENAME SAFE. The recorded objection to renaming these files was that a
// rename "invites a re-save, and a re-save changes the CID". That objection is correct. With this
// check wired into test:all, an accidental re-save goes red immediately instead of surviving to the
// next pointer move — so the guard is a precondition for touching the filenames at all, not an
// afterthought.
//
// OFFLINE — zero network, zero money. Reads local files and compares to recorded constants.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_SET } from "./_pinned-set.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  let ok = false, note = extra;
  try { ok = typeof cond === "function" ? !!cond() : !!cond; }
  catch (e) { ok = false; note = `threw: ${String(e?.message ?? e).slice(0, 70)}`; }
  if (ok) { pass++; console.log(`  ✅ ${label}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${note ? ` — ${note}` : ""}`); }
};

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  PINNED BYTES — do the local documents still match what was pinned?  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 🚨 A GUARD OVER AN EMPTY SET PASSES VACUOUSLY. This repo has shipped that exact shape before —
// a check nothing could reach, green at 25/0. Assert the set is populated BEFORE trusting any
// per-entry result, and assert each entry actually carries the fields the comparison needs, so a
// typo'd or half-written entry FAILS instead of being quietly skipped.
console.log(`\n── 1. THE SET ITSELF IS REAL (an empty guard is not a guard) ───────`);
check("⭐⭐ PINNED_SET is a non-empty array", Array.isArray(PINNED_SET) && PINNED_SET.length > 0,
  `${PINNED_SET?.length ?? 0} entries`);
const REQUIRED = ["key", "rel", "sha256", "bytes", "cid"];
for (const d of PINNED_SET) {
  const missing = REQUIRED.filter((f) => d?.[f] === undefined || d?.[f] === null || d?.[f] === "");
  check(`⭐ entry "${d?.key ?? "(unnamed)"}" declares every field the check needs`,
    missing.length === 0, missing.length ? `MISSING: ${missing.join(", ")}` : REQUIRED.join(", "));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ⭐ BOTH LENGTH AND HASH. The hash alone would be sufficient cryptographically, but the length is
// what makes a failure legible at a glance — "18756 → 18757" says "someone's editor added a newline"
// in a way that two 64-char hex strings do not.
// ⚠️ A MISSING OR UNREADABLE FILE IS A FAILURE, NEVER A SKIP. An absent document cannot be the
// thing the chain points at, and "we could not check" must not fill the result slot as safety.
console.log(`\n── 2. 🚨 EVERY PINNED DOCUMENT IS BYTE-IDENTICAL TO WHAT WAS PINNED ─`);
const WHY =
  "a pinned document's bytes changed; its CID no longer matches what the chain points at, so the " +
  "document's own claim that tokenURI(agentId) == its CID is now FALSE and any report whose " +
  "attestation resolves through it can no longer be verified against these bytes";

for (const d of PINNED_SET) {
  const abs = path.join(REPO_ROOT, d.rel);
  let buf = null, readErr = null;
  try { buf = readFileSync(abs); } catch (e) { readErr = String(e?.code ?? e?.message ?? e); }

  if (readErr) {
    check(`🚨 ${d.key} — ${d.rel} is READABLE`, false,
      `${readErr}. ${WHY.split(";")[0]} (the file is gone or unreadable, which is not "unchanged")`);
    continue;
  }

  const sha = createHash("sha256").update(buf).digest("hex");
  check(`⭐ ${d.key} — byte length is ${d.bytes}`, buf.length === d.bytes,
    buf.length === d.bytes ? `${buf.length} bytes` : `GOT ${buf.length}, EXPECTED ${d.bytes} — ${WHY}`);
  check(`⭐⭐ ${d.key} — sha256 matches the pinned document`, sha === d.sha256,
    sha === d.sha256 ? `${sha.slice(0, 16)}… (${d.rel})` : `GOT ${sha}\n        EXPECTED ${d.sha256}\n        ${WHY}`);
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("\n🚨 DO NOT 'FIX' THIS BY UPDATING THE RECORDED HASH. The recorded value is what was");
  console.log("   actually pinned and what the chain points at. If the bytes changed by accident,");
  console.log("   restore them (git checkout). If they changed ON PURPOSE, that is a SUPERSESSION:");
  console.log("   a new version, a new CID, and setAgentURI — never an edit in place.\n");
  process.exit(1);
}
console.log("⭐ A filename asks a human not to edit. This is the mechanism that catches them when they do.\n");
