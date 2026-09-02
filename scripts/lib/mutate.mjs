#!/usr/bin/env node
// mutate.mjs — ⛔ A MUTATION PROOF THAT REFUSES TO REPORT A VERDICT IT HAS NOT EARNED.
//
//   node scripts/lib/mutate.mjs \
//     --file netlify/functions/_actions.mjs \
//     --find 'amountIn: String(step.amountIn),' \
//     --replace 'amountIn: Number(step.amountIn).toFixed(2),' \
//     --run 'node scripts/verify-executor-amount-integrity.mjs' \
//     --expect-names '_actions.mjs:'
//
// ═══ 🚨 WHY THIS EXISTS ═══════════════════════════════════════════════════
// A mutation proof has a failure mode that LOOKS EXACTLY LIKE A ROBUST GUARD: if the edit never
// lands, the suite runs against unmutated code, passes, and the transcript reads "mutation applied,
// suite still green — the guard is fine." Nothing distinguishes that from the real thing.
//
// ⛔ THIS HAPPENED, TODAY, IN A SESSION ABOUT EXACTLY THIS. A python replace whose pattern did not
// match reported the suite's green as the mutation's result, and `git checkout` could not restore
// the file because it was untracked — so the "restore" was a no-op over an unmutated file too.
//
// ⭐ THE RULE: the verdict of the command is NEVER printed unless the mutation is CONFIRMED landed.
// Not applied is its own outcome — `MUTATION NOT APPLIED`, exit 2 — and it is not a pass or a fail.
//
// ⭐⭐ AND IT SNAPSHOTS EXPLICITLY, NEVER `git checkout`. An untracked file has no committed
// version to restore from; a checkout on one exits non-zero and leaves the mutation in place, where
// every later run silently tests mutated code.

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const flag = (n) => argv.includes(`--${n}`);

const create = arg("create");                    // create a NEW file (for "a new file appears" proofs)
const content = arg("content", "// created by mutate.mjs\n");
const file = arg("file");
const find = arg("find");
const replace = arg("replace", "");
const run = arg("run");
const expectNames = arg("expect-names");        // the failure output must contain this
const mustPass = flag("must-pass");             // default: the command must FAIL on the mutation
const occurrences = Number(arg("occurrences", "1"));

// ── CREATE MODE: prove a guard reacts to a file APPEARING, with the same applied-discipline. ──
if (create) {
  if (!run) { console.error("usage: mutate.mjs --create PATH --run CMD [--expect-names S]"); process.exit(64); }
  if (existsSync(create)) {
    console.error(`\n⛔ MUTATION NOT APPLIED — ${create} already exists; creating it would prove nothing.`);
    process.exit(2);
  }
  writeFileSync(create, content);
  if (!existsSync(create)) {
    console.error(`\n⛔ MUTATION NOT APPLIED — ${create} was not created.`);
    process.exit(2);
  }
  console.log(`✓ mutation landed — ${create} created`);
  let c = 0, o = "";
  try { o = execSync(run, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { c = e.status ?? 1; o = `${e.stdout || ""}${e.stderr || ""}`; }
  finally {
    rmSync(create, { force: true });
    // ⭐ VERIFY THE REMOVAL. A left-behind file would make every later run test a different repo.
    if (existsSync(create)) { console.error(`\n🚨 CLEANUP FAILED — ${create} still exists.`); process.exit(3); }
  }
  const namedC = !expectNames || o.includes(expectNames);
  console.log(`  command exit ${c} (expected non-zero)`);
  if (expectNames) console.log(`  names "${expectNames}": ${namedC ? "yes" : "NO"}`);
  if (c !== 0 && namedC) { console.log(`✅ MUTATION PROVEN — the guard caught the new file, and it is removed.`); process.exit(0); }
  console.error(`\n⛔ MUTATION NOT CAUGHT — the guard did not reject a file it has never seen.`);
  process.exit(1);
}

if (!file || find === undefined || !run) {
  console.error("usage: mutate.mjs --file F --find S [--replace R] --run CMD [--expect-names S] [--must-pass]");
  process.exit(64);
}
if (!existsSync(file)) { console.error(`⛔ no such file: ${file}`); process.exit(64); }

// ── 1. SNAPSHOT, explicitly. Works for tracked and untracked alike. ──────────
const snapDir = mkdtempSync(join(tmpdir(), "mutate-"));
const snap = join(snapDir, basename(file));
copyFileSync(file, snap);
const before = readFileSync(file, "utf8");

const restore = () => {
  copyFileSync(snap, file);
  // ⭐ VERIFY THE RESTORE. A restore that silently fails leaves every later run testing a mutant,
  // and nothing downstream would ever say so.
  if (readFileSync(file, "utf8") !== before) {
    console.error(`\n🚨 RESTORE FAILED — ${file} does not match its snapshot. Snapshot kept at ${snap}`);
    process.exit(3);
  }
};

let code = 0, out = "";
try {
  // ── 2. APPLY, and PROVE it applied before anything else runs. ─────────────
  const foundBefore = before.split(find).length - 1;
  if (foundBefore !== occurrences) {
    restore();
    console.error(`\n⛔ MUTATION NOT APPLIED — the target appears ${foundBefore}× in ${file}, expected ${occurrences}×.`);
    console.error(`   Nothing was run. The suite's verdict is NOT reported, because it would be a verdict about unmutated code.`);
    process.exit(2);
  }
  const after = before.replace(find, replace);
  if (after === before) {
    restore();
    console.error(`\n⛔ MUTATION NOT APPLIED — the replacement produced an identical file.`);
    console.error(`   Nothing was run.`);
    process.exit(2);
  }
  writeFileSync(file, after);

  const reread = readFileSync(file, "utf8");
  const foundAfter = reread.split(find).length - 1;
  if (reread === before || foundAfter !== foundBefore - 1) {
    restore();
    console.error(`\n⛔ MUTATION NOT APPLIED — target count went ${foundBefore} → ${foundAfter}, expected ${foundBefore - 1}.`);
    process.exit(2);
  }
  console.log(`✓ mutation landed in ${file} — target ${foundBefore} → ${foundAfter}`);

  // ── 3. ONLY NOW does the command run, and only now is a verdict meaningful. ─
  try { out = execSync(run, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { code = e.status ?? 1; out = `${e.stdout || ""}${e.stderr || ""}`; }
} finally {
  restore();
}

// ── 4. Judge. ───────────────────────────────────────────────────────────────
const caught = mustPass ? code === 0 : code !== 0;
const named = !expectNames || out.includes(expectNames);
console.log(`  command exit ${code}${mustPass ? " (expected 0)" : " (expected non-zero)"}`);
if (expectNames) console.log(`  names "${expectNames}": ${named ? "yes" : "NO"}`);

if (caught && named) {
  console.log(`✅ MUTATION PROVEN — the guard ${mustPass ? "accepted" : "caught"} it, and ${file} is restored.`);
  process.exit(0);
}
console.error(`\n⛔ MUTATION NOT CAUGHT — the guard did not ${mustPass ? "accept" : "reject"} this change${named ? "" : ", or did not name it"}.`);
console.error(out.split("\n").filter((l) => /❌|fail/i.test(l)).slice(0, 6).join("\n"));
process.exit(1);
