#!/usr/bin/env node
// verify-recovery-file.mjs — check the developer-controlled-wallets RECOVERY FILE is still the
// artifact we saved, and is still well-formed.
//
//   node scripts/verify-recovery-file.mjs
//   RECOVERY_FILE=/path/to/recovery_file_*.dat node scripts/verify-recovery-file.mjs
//
// ═══ 🚨 WHAT THIS CHECKS, AND — MORE IMPORTANTLY — WHAT IT DOES NOT ════════════════════════════
// It checks FORM and IDENTITY. It CANNOT check CURRENCY or AUTHENTICITY:
//
//   ✅ the file exists, is not empty, and is the exact bytes we recorded (sha256 pin)
//   ✅ it is the base64 shape the Circle SDK itself validates before writing
//   ❌ NOT that Circle will still accept it — a file DEPRECATED by an Entity Secret rotation or
//      reset passes every check here PERFECTLY. Deprecation happens server-side and leaves the
//      bytes on disk untouched.
//   ❌ NOT that it authenticates — the only surface that proves that is the reset flow itself.
//
// ⭐⭐ THE LIMIT IS PRINTED ON EVERY RUN, INCLUDING GREEN ONES, AND THAT IS THE POINT. A validator
// that says "✅ recovery file OK" teaches the reader "the file is fine" when what is known is "the
// file is well-formed". That substitution is the exact false assurance this check was written to
// prevent — it would manufacture confidence about the one artifact whose failure mode is only ever
// discovered in the emergency it exists for.
//
// ═══ 🚨 WHY A HASH PIN AND NOT JUST A SHAPE CHECK ══════════════════════════════════════════════
// A shape check catches CORRUPTION. It does not catch REPLACEMENT: a different, perfectly
// well-formed recovery file — from another entity, another account, or a later rotation someone
// forgot to tell us about — passes the regex silently and would authenticate nothing for THESE
// wallets. The pin is what makes "still ours" checkable at all.
// ⚠️ If the pin ever fails, do NOT edit the constant to make it pass. A changed file means either
// the artifact was replaced or a rotation occurred; both need explaining before the pin moves.
//
// ═══ ⚠️ THE TRAP THIS WAS WRITTEN AFTER ════════════════════════════════════════════════════════
// On 2026-08-19 two recovery files were found side by side, both dated 2026-06-11:
//   recovery_file_1781206891750.dat  144 bytes  (21:41)  — the real one, written by the SDK
//   recovery_file.dat                  0 bytes  (21:44)  — EMPTY
// The empty one had THE OBVIOUS NAME — the one anybody reaches for in an emergency — and would
// have authenticated nothing. Its likely origin is in Circle's own docs example:
//   fs.writeFileSync("recovery_file.dat", response.data?.recoveryFile ?? "");
// ⭐ Note the `?? ""`: when the field is absent that line writes an EMPTY FILE, silently, under the
// most reassuring possible name. The file was renamed to *.EMPTY-DO-NOT-USE rather than deleted —
// the danger was never that it existed, only that it was named like the thing you need.
//
// READ-ONLY. No network, no credential, no Circle call. CONTENTS ARE NEVER PRINTED — only length,
// shape, and a hash, which is enough to identify the file and never enough to reconstruct it.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

// The bytes we hold, recorded 2026-08-19 from the file the SDK wrote on 2026-06-11.
const PINNED_SHA256 = "3adb019b80550d5ac6d8b4152c9731b4372f03ccaec01221f4ceccddbab05b92";
const PINNED_BYTES = 144;
const PINNED_DECODED_BYTES = 106;

// ═══ ⭐ THE DOCUMENTARY CASE FOR CURRENCY — A CLAIM ABOUT OUR RECORDS, NOT A MEASUREMENT ════════
// The check above is structurally blind to deprecation. This narrows that blind spot with the only
// evidence available short of Circle: an audit of what we have written down.
//
//   · NO Entity Secret rotation or re-registration is recorded anywhere in PROGRESS.md.
//   · Both wallet-creation events POSTDATE the file — per-user wallets 2026-07-03, the DD revenue
//     wallet 2026-07-27, against a file downloaded 2026-06-11. ⭐ That is fine and not evidence
//     against currency: the file recovers the SECRET, and wallets created under that secret are
//     covered by it. Only a ROTATION or RESET deprecates a recovery file — not wallet creation.
//   · A rotation is not something that happens by drift. It is a deliberate console or SDK action
//     by a person, so an unrecorded one implies an unrecorded deliberate act.
//
// ⚠️ THIS AGES, AND IT DOES NOT SELF-UPDATE. It was true when audited and says nothing about
// anything done since. Re-audit the date below rather than trusting its continued presence.
const ROTATION_AUDIT_DATE = "2026-08-19";

// ⚠️ Lives OUTSIDE this repo on purpose — a recovery file must never be committed. Override with
// RECOVERY_FILE when the location moves.
const DEFAULT_FILE = path.join(os.homedir(), "Arc-tikpema", "tikpema-dev", "recovery_file_1781206891750.dat");
const FILE = process.env.RECOVERY_FILE || DEFAULT_FILE;

// The SDK's own validity regex, copied verbatim from
// @circle-fin/developer-controlled-wallets — the check IT runs before writing the file.
const SDK_BASE64 = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;

let bad = 0;
const ok = (label, cond, detail = "") => {
  console.log(`   ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) bad++;
};

console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  RECOVERY FILE — form and identity (NOT currency, NOT authenticity)  ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝\n`);
console.log(`   file: ${FILE}\n`);

if (!existsSync(FILE)) {
  console.log(`   ❌ MISSING. The recovery file is not at this path.`);
  console.log(`      🚨 If both the Entity Secret and this file are lost, no new dev-controlled`);
  console.log(`         wallets can be created and no transactions can be initiated from existing`);
  console.log(`         ones. Circle does not store the secret and cannot recover it.\n`);
  process.exit(1);
}

const raw = readFileSync(FILE, "utf8");
const t = raw.trim();
const sha = createHash("sha256").update(t).digest("hex");

ok("not empty", t.length > 0, t.length === 0 ? "🚨 ZERO BYTES — this file authenticates nothing" : `${t.length} chars`);
ok("matches the SDK's own base64 validity regex", t.length > 0 && SDK_BASE64.test(t));
let decoded = null;
try { decoded = Buffer.from(t, "base64"); } catch { /* handled below */ }
ok("decodes as base64", !!decoded, decoded ? `${decoded.length} bytes` : "decode failed");
ok(`decoded length is the recorded ${PINNED_DECODED_BYTES} bytes`, decoded?.length === PINNED_DECODED_BYTES, String(decoded?.length));
ok(`on-disk length is the recorded ${PINNED_BYTES} chars`, t.length === PINNED_BYTES, String(t.length));

// 🚨 THE PIN — catches REPLACEMENT, which a shape check cannot.
ok("sha256 matches the pinned artifact", sha === PINNED_SHA256, `${sha.slice(0, 12)}… vs pinned ${PINNED_SHA256.slice(0, 12)}…`);
if (sha !== PINNED_SHA256 && t.length > 0) {
  console.log(`      ⚠️ THE FILE CHANGED. Do NOT edit the pin to make this pass. Either the artifact`);
  console.log(`         was replaced, or an Entity Secret rotation/reset produced a new one — and a`);
  console.log(`         rotation DEPRECATES the previous file. Establish which before moving the pin.`);
}

// ⭐ Surface any sibling that could be mistaken for this one in a hurry.
console.log(`\n── siblings in the same directory ──────────────────────────────────`);
try {
  const dir = path.dirname(FILE);
  const sibs = readdirSync(dir).filter((f) => /recovery/i.test(f));
  for (const f of sibs) {
    const p = path.join(dir, f);
    const sz = statSync(p).size;
    const isTarget = p === FILE;
    const flag = isTarget ? "← the pinned file" : (sz === 0 ? "🚨 EMPTY" : "⚠️ another recovery-shaped file");
    console.log(`   ${String(sz).padStart(6)} bytes  ${f}  ${flag}`);
  }
  // A file named exactly recovery_file.dat is the one someone grabs under pressure.
  const trap = sibs.find((f) => f === "recovery_file.dat");
  ok("no bare `recovery_file.dat` decoy present", !trap,
     trap ? "🚨 a file with the obvious emergency name exists — rename it unless it IS the good one" : "none");
} catch (e) {
  console.log(`   (could not list directory: ${e.message})`);
}

// ═══ ⭐⭐ THE LIMIT — PRINTED ON EVERY RUN, PASS OR FAIL ════════════════════════════════════════
console.log(`\n════════════════════════════════════════════════════════════════════════`);
console.log(`⚠️  WHAT A GREEN RUN HERE DOES AND DOES NOT MEAN`);
console.log(`    Checked : the file is present, non-empty, well-formed, and byte-identical to the`);
console.log(`              artifact recorded on 2026-08-19.`);
console.log(`    NOT checked: that Circle will ACCEPT it. A recovery file DEPRECATED by an Entity`);
console.log(`              Secret rotation or reset passes every check above perfectly — deprecation`);
console.log(`              happens server-side and does not touch these bytes.`);
console.log(`    ⭐ "Well-formed" is not "valid". The only surface that proves acceptance is the`);
console.log(`       reset flow itself, and running that to test it PERFORMS the reset.`);
console.log(`════════════════════════════════════════════════════════════════════════`);

// ═══ ⚠️ DELIBERATELY A SEPARATE BLOCK, AND DELIBERATELY NOT A ✅/❌ CHECK ══════════════════════
// Everything above is a measurement of the FILE. This is a claim about OUR RECORDS. Rendering it as
// a check would let a reader carry it home as "verified", and an audit of what we wrote down is not
// verification of what Circle holds. Keeping the two visually and structurally apart is the same
// discipline the rest of this script is built on — the moment they merge, the honesty is gone.
console.log(`\nℹ️  THE DOCUMENTARY CASE FOR CURRENCY — a claim about OUR RECORDS, not a measurement`);
console.log(`    As of ${ROTATION_AUDIT_DATE}: NO Entity Secret rotation or re-registration is recorded`);
console.log(`    anywhere in PROGRESS.md. A rotation is a deliberate console/SDK action by a person,`);
console.log(`    not something that drifts — so an unrecorded one implies an unrecorded deliberate act.`);
console.log(`    Wallet creations (per-user 2026-07-03, revenue 2026-07-27) POSTDATE the file, which`);
console.log(`    does NOT weaken it: the file recovers the SECRET, and wallets created under that`);
console.log(`    secret are covered. Only rotation or reset deprecates a recovery file.`);
console.log(`    ⚠️ This ages and does not self-update. It is silent about anything done since`);
console.log(`       ${ROTATION_AUDIT_DATE}; re-audit rather than trusting its continued presence here.`);
console.log(`    ⭐ So the blind spot above is NARROW AND REASONED, not wide open — but it is still a`);
console.log(`       blind spot, and this paragraph is not a substitute for Circle confirming it.`);

if (bad) { console.log(`\n❌ ${bad} check(s) failed.\n`); process.exit(1); }
console.log(`\n✅ FORM AND IDENTITY INTACT — still the file we recorded. Currency remains unverified.\n`);
