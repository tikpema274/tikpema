#!/usr/bin/env node
// run-suites.mjs — RUN EVERY SUITE, THEN REPORT. Never stop at the first failure.
//
//   npm run test:all                      every suite in package.json `suites`
//   node scripts/run-suites.mjs a b       just these
//   node scripts/run-suites.mjs --bail    stop at the first failure (the OLD behaviour)
//
// ═══ 🚨 THE MEASURED HARM THIS REPLACES ══════════════════════════════════════════════════════
// `test:all` was an `&&` chain of 18 suites. `test:research` sits 7th, and one stale assertion in
// it — pinning a heading that had been deliberately IMPROVED — held it red from 2026-08-19 16:05
// to 2026-08-20 ~13:00. **For 21 hours, `npm run test:all` could not reach ELEVEN suites**, and it
// exited non-zero for a reason unrelated to every one of them.
//
// ⭐⭐ THAT INCLUDED `test:copy` AT POSITION 10 — where the plan-card and job-status-merge guards
// were added the same day. They landed behind the block on the day they were written, and were
// verified only because each was run DIRECTLY. A `test:all` run would have proved nothing about
// them AND LOOKED LIKE IT HAD.
//
// ⚠️ THE FAILURE MODE IS THE REPORTING, NOT THE STOPPING. A short-circuited chain reports ONE
// failure, so a reader sees a single familiar red line — never "eleven suites were skipped". The
// count of what did not run appeared nowhere. ⭐ Same rule as the UB sweeper's bounded tick, which
// REPORTS its remainder rather than dropping it: a cap that hides its own truncation reads as
// "we covered everything".
//
// ⭐ SO THE ROLL-UP BELOW ALWAYS PRINTS THREE NUMBERS — passed, FAILED, and NOT RUN — even when the
// last two are zero. A number that is only shown when it is bad teaches nobody where to look.
//
// ═══ ⭐ READING THE DURATION COLUMN: A RED SUITE IS ALSO A SHORT SUITE ════════════════════════
// `test:dd` runs ~139s green. While it was failing on one assertion it ran in **21s** — it exited
// at the failure and never reached the rest. ⚠️ SO A SUITE THAT SUDDENLY GOT MUCH FASTER IS A
// SIGNAL, NOT GOOD NEWS: it may have started failing early, or begun skipping. Nothing else in
// this output would tell you — the pass/fail column looks identical, and "the tests got quicker"
// reads as an improvement.
// ⭐ The inverse is the one that misleads hardest: after a fix, a suite getting SLOWER usually
// means it started running. `test:dd` going 21s → 139s was the repair, not a regression.

// ═══ ⛔⛔ A SECTION THAT CANNOT AFFECT THE EXIT CODE IS NOT A CHECK ════════════════════════════
//
// WHERE SUITES ARE WRITTEN, THIS IS THE FAILURE TO KNOW. A suite's verdict is its EXIT CODE. Its
// output is a separate channel, and the two can disagree completely.
//
// 🚨 MEASURED 2026-09-03. A new section was appended to `verify-amount-precision.mjs` by inserting
// before the file's LAST `console.log` — which put it AFTER `if (fail) { …; process.exit(1) }`. The
// section ran. It printed `❌` for its failing checks. The suite exited **0**. Nine assertions, none
// of which could ever have reddened a run.
//
// ⛔⛔ AND A GREEN BASELINE WOULD HAVE LOOKED IDENTICAL. Adding a section and seeing ✅ tells you
// nothing: an unreachable section prints ✅ too. Nothing in a passing run distinguishes "these nine
// checks passed" from "these nine checks cannot fail". ⭐ ONLY MUTATING FOUND IT — two mutation
// runs came back `MUTATION NOT CAUGHT` **with red checks on screen**, which reads as "the guard is
// weak" and is in fact "the guard is unreachable". The natural diagnosis is the wrong one.
//
// ⭐ SO A SUITE'S PASS COUNT IS NOT EVIDENCE ITS SECTIONS CAN FAIL. The count is a sum over whatever
// ran before the verdict was taken; it says nothing about what sits after it. Same family as
// [[a-partial-mock-fails-at-instantiation]] (blind 33 days, and green throughout) and
// [[a-later-command-is-not-proof-of-an-earlier-one]] — visible output and exit status coming from
// different places.
//
// HOW TO NOT REPEAT IT, in order of cost:
//   1. INSERT ABOVE THE TALLY. "The end of the file" is not "the end of the checks".
//   2. AFTER ADDING A SECTION, CONFIRM THE PASS COUNT GREW. 14 → 23 is the evidence the section is
//      wired; ✅ on its own is not.
//   3. MUTATE ONE OF ITS ASSERTIONS RED. That is the only thing that distinguishes a section which
//      passed from one which cannot fail.
//   4. `scripts/verify-assertion-reachability.mjs` scans the estate for this shape and prints its
//      denominator, so the class does not depend on anyone remembering 1–3.
//
// ⚠️ AND WHEN A MUTATION SAYS NOT CAUGHT WHILE FAILURES ARE ON SCREEN, SUSPECT THE PLUMBING BEFORE
// THE ASSERTION. The harness was reporting the exit code correctly; the exit code was reporting a
// tally taken before the section existed.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const argv = process.argv.slice(2);
const bail = argv.includes("--bail");
const named = argv.filter((a) => !a.startsWith("--"));

// ⚠️ ONE LIST, AND IT LIVES IN package.json — where a reader looking for "what does test:all run"
// actually looks. Keeping a second copy in this file is the duplicate-source-of-truth bug that this
// repo has paid for repeatedly; the runner owns the BEHAVIOUR, package.json owns the MEMBERSHIP.
const suites = named.length ? named : pkg.suites;
if (!Array.isArray(suites) || suites.length === 0) {
  console.error("run-suites: no suites to run — package.json has no `suites` array and none were named.");
  process.exit(2);
}

// 🚨 A NAME THAT IS NOT A SCRIPT IS AN ERROR, NEVER A SKIP. A silently-skipped suite is exactly the
// absence-reads-as-success shape the whole exercise is about, and a typo in the list would
// otherwise remove coverage while the roll-up stayed green.
const unknown = suites.filter((s) => !pkg.scripts?.[s]);
if (unknown.length) {
  console.error(`run-suites: these are not scripts in package.json: ${unknown.join(", ")}`);
  process.exit(2);
}

const results = [];
const started = Date.now();

for (const [i, name] of suites.entries()) {
  console.log(`\n\x1b[1m━━ [${i + 1}/${suites.length}] ${name} ━━\x1b[0m`);
  const t0 = Date.now();
  const r = spawnSync("npm", ["run", name], { stdio: "inherit", shell: false });
  const ms = Date.now() - t0;
  // ⚠️ A SIGNAL IS NOT A PASS. A suite killed by SIGKILL/SIGTERM has `status === null`; treating
  // that as anything but a failure would let an OOM read as success.
  const ok = r.status === 0 && !r.signal;
  results.push({ name, ok, code: r.status, signal: r.signal ?? null, ms });
  if (!ok && bail) {
    console.log(`\n--bail: stopping at the first failure (${name}).`);
    break;
  }
}

const notRun = suites.length - results.length;
const failed = results.filter((r) => !r.ok);
const passed = results.filter((r) => r.ok);

console.log(`\n\x1b[1m╔══════════════════════════════════════════════════════════════════════╗\x1b[0m`);
console.log(`\x1b[1m║  SUITE ROLL-UP                                                       ║\x1b[0m`);
console.log(`\x1b[1m╚══════════════════════════════════════════════════════════════════════╝\x1b[0m`);
for (const r of results) {
  const mark = r.ok ? "\x1b[32m✅ PASS\x1b[0m" : "\x1b[31m❌ FAIL\x1b[0m";
  const why = r.ok ? "" : r.signal ? `  killed by ${r.signal}` : `  exit ${r.code}`;
  console.log(`  ${mark}  ${r.name.padEnd(26)} ${(r.ms / 1000).toFixed(1)}s${why}`);
}
// ⭐ NOT-RUN IS NAMED, NOT INFERRED. With --bail this is the whole point; without it, it should
// always be 0 and saying so is what makes a non-zero value legible.
for (const name of suites.slice(results.length)) {
  console.log(`  \x1b[33m⚠️ NOT RUN\x1b[0m  ${name.padEnd(26)} (stopped earlier)`);
}

console.log(
  `\n  passed ${passed.length}   \x1b[1mFAILED ${failed.length}\x1b[0m   NOT RUN ${notRun}` +
    `   of ${suites.length}   in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`
);
if (failed.length) console.log(`  \x1b[31mfailing:\x1b[0m ${failed.map((f) => f.name).join(", ")}`);
if (notRun) console.log(`  \x1b[33m⚠️ ${notRun} suite(s) never ran — this run proves NOTHING about them.\x1b[0m`);
console.log("");

process.exit(failed.length || notRun ? 1 : 0);
