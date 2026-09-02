// verify-mutation-harness.mjs — ⛔ THE HARNESS THAT REFUSES UNEARNED VERDICTS, VERIFIED.
//
//   node scripts/verify-mutation-harness.mjs   (also: npm run test:mutationharness)
//
// ═══ 🚨 WHY A HARNESS NEEDS ITS OWN SUITE ═════════════════════════════════
// scripts/lib/mutate.mjs exists to stop a mutation proof reporting a verdict it did not earn. Its
// own failure mode is the same one: if IT silently stopped checking that the edit landed, every
// proof run through it would go on printing ✅ and nothing would say otherwise.
//
// ⛔ AND IT SHIPPED UNINVOKED. On 2026-09-02 the harness was written, used by hand three times, and
// called by nothing — while gate:registry printed green, because that gate counted package.json
// entries and a file with no entry was not in the set it counted. This suite is what makes the
// harness INVOKED; the disk-walk in gate:registry is what makes a repeat visible.
//
// ⭐ EVERYTHING HERE RUNS AGAINST A TEMP FILE. A suite that mutates real source to test itself
// would leave a mutant behind if the process died mid-run — inside `npm run test:all`, on someone
// else's machine. The harness's discipline is provable without pointing it at the repo.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const HARNESS = new URL("./lib/mutate.mjs", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "mh-"));
const target = join(dir, "subject.mjs");
const ORIGINAL = "export const VALUE = 'GOOD';\n";
writeFileSync(target, ORIGINAL);

/** A stand-in guard: exits non-zero iff the subject no longer says GOOD. */
const guard = join(dir, "guard.mjs");
writeFileSync(guard, `
import { readFileSync } from "node:fs";
const src = readFileSync(${JSON.stringify(target)}, "utf8");
if (!src.includes("GOOD")) { console.log("SUBJECT WAS CHANGED"); process.exit(1); }
console.log("subject intact"); process.exit(0);
`);

const runHarness = (args) => {
  try { return { code: 0, out: execFileSync("node", [HARNESS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` }; }
};

section("1 — 🚨 AN UNAPPLIED MUTATION IS ITS OWN OUTCOME, NOT A VERDICT");
{
  const r = runHarness(["--file", target, "--find", "STRING_THAT_IS_NOT_THERE", "--replace", "x",
    "--run", `node ${guard}`]);
  check("⛔ a target that does not exist exits 2, not 0 and not 1", r.code === 2, `exit ${r.code}`);
  check("  …and says MUTATION NOT APPLIED", /MUTATION NOT APPLIED/.test(r.out));
  // ⭐⭐ THE ASSERTION THAT MATTERS. The green run today said the suite passed. It must not.
  check("⭐⭐ …and does NOT report the command's verdict — that verdict would be about unmutated code",
    !/MUTATION PROVEN|MUTATION NOT CAUGHT|subject intact/.test(r.out));
  check("  …and the subject is untouched", readFileSync(target, "utf8") === ORIGINAL);
}

section("2 — a replacement that changes nothing is also NOT APPLIED");
{
  const r = runHarness(["--file", target, "--find", "GOOD", "--replace", "GOOD", "--run", `node ${guard}`]);
  check("⛔ find === replace exits 2", r.code === 2, `exit ${r.code}`);
  check("  …and the subject is untouched", readFileSync(target, "utf8") === ORIGINAL);
}

section("3 — ⭐ A REAL MUTATION IS APPLIED, CAUGHT, AND RESTORED");
{
  const r = runHarness(["--file", target, "--find", "GOOD", "--replace", "BAD",
    "--run", `node ${guard}`, "--expect-names", "SUBJECT WAS CHANGED"]);
  check("✅ a landed mutation the guard catches exits 0", r.code === 0, `exit ${r.code}`);
  check("  …and reports the target count moving 1 → 0", /target 1 → 0/.test(r.out));
  check("  …and says MUTATION PROVEN", /MUTATION PROVEN/.test(r.out));
  // 🚨 THE RESTORE IS THE WHOLE POINT. `git checkout` cannot restore an untracked file, which is
  // how a mutant survived a "restore" today. This subject has never been in git at all.
  check("🚨 …and the subject is byte-identical afterwards, though it is not in git",
    readFileSync(target, "utf8") === ORIGINAL, JSON.stringify(readFileSync(target, "utf8")));
}

section("4 — a guard that does NOT catch the mutation fails loudly");
{
  const blind = join(dir, "blind.mjs");
  writeFileSync(blind, "process.exit(0);\n");   // never fails — the guard that guards nothing
  const r = runHarness(["--file", target, "--find", "GOOD", "--replace", "BAD", "--run", `node ${blind}`]);
  check("⛔ a blind guard makes the proof FAIL, not pass", r.code === 1, `exit ${r.code}`);
  check("  …and says MUTATION NOT CAUGHT", /MUTATION NOT CAUGHT/.test(r.out));
  check("  …and still restores the subject", readFileSync(target, "utf8") === ORIGINAL);
}

section("5 — ⭐ CREATE MODE: a file APPEARING is a mutation too");
{
  const newFile = join(dir, "appeared.mjs");
  const seesFile = join(dir, "sees.mjs");
  writeFileSync(seesFile, `
import { existsSync } from "node:fs";
if (existsSync(${JSON.stringify(newFile)})) { console.log("UNEXPECTED FILE"); process.exit(1); }
process.exit(0);
`);
  const r = runHarness(["--create", newFile, "--run", `node ${seesFile}`, "--expect-names", "UNEXPECTED FILE"]);
  check("✅ create mode proves a guard reacts to a new file", r.code === 0, `exit ${r.code}`);
  check("🚨 …and the created file is REMOVED afterwards", !existsSync(newFile));
  const again = runHarness(["--create", target, "--run", `node ${guard}`]);
  check("⛔ creating a file that already exists is NOT APPLIED, not a pass", again.code === 2, `exit ${again.code}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
if (!fail) console.log("⭐ The harness cannot report a verdict it has not earned.");
process.exit(fail ? 1 : 0);
