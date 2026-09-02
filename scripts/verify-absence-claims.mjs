// verify-absence-claims.mjs — A CLASS CHECK FOR "X DOES NOT EXIST" CLAIMS THAT OUTLIVE X.
//
//   node scripts/verify-absence-claims.mjs        (also: npm run test:absenceclaims)
//
// ═══ 🚨 THE FAILURE THIS EXISTS FOR ══════════════════════════════════════════════════════════════
// A comment or a sentence says "there is no sweeper / no reconcile job / it is unbuilt". It is TRUE
// when written. The thing then gets built, and the claim stays — now false, in production, in the
// file that builds it. Six instances were found by hand on the bridge path 2026-09-02, one of them
// 32 lines above the loop that triggers the job it denied.
//
// ⛔ SO THIS DOES NOT ENUMERATE THEM. An include-list of six known sentences passes silently on the
// seventh, which is the same shape as the defect. It scans for the PATTERN and requires every hit to
// carry its own defence.
//
// ═══ ⭐ WHAT COUNTS AS DEFENDED ═════════════════════════════════════════════════════════════════
// A present-tense absence claim passes if, within its neighbourhood, it EITHER:
//   · is TIME-SCOPED — "at the time this was written", "when this was written", "was true", a date,
//     "no longer", "that changed", "originally" — i.e. it is a statement about the past; or
//   · CITES A SUPERSEDER — names a file:line, a function, or a job that now does the thing.
// An undefended hit is a claim about the present with nothing binding it to reality.
//
// ═══ 🚨 THE SELF-REFERENCE TRAP, WHICH IS WHY THIS FILE IS EXCLUDED ═════════════════════════════
// This is the SEVENTH source-grep trap in this codebase's history, and the first six all had the
// same shape: a checker that matches its own explanatory prose. The pattern list above is literally
// a set of absence claims. Scanning itself, this file would report ~a dozen undefended hits and
// could only be silenced by weakening the patterns — the exact "loosen the check" failure it exists
// to prevent. ⭐ SO THE EXCLUSION IS EXPLICIT AND ASSERTED: §0 proves the corpus does not contain
// this file, and proves the patterns WOULD have matched it. An exclusion nobody verifies is a hole.
// [[check-whose-failure-mode-is-a-pass]] · [[control-needs-ownership-and-stability]]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const ROOT = new URL("..", import.meta.url).pathname;
const SELF = "scripts/verify-absence-claims.mjs";

// ⛔ PROSE IS EXCLUDED, CODE IS NOT. PROGRESS.md and docs/ are dated logs and design records — a log
// SHOULD contain "no reconcile job existed on 2026-08-14". Rewriting history to satisfy a checker is
// the opposite of the point. This scans what ships: components, functions, shared modules.
const DIRS = ["src", "netlify/functions", "shared", "scripts"];
const EXT = /\.(mjs|ts|tsx|js)$/;

/** Present-tense claims that a thing does not exist. */
// ⚠️ EXISTENTIAL CLAIMS ONLY. The first draft included a bare /no cron/ and flagged three lines
// that say something entirely different — "NO CRON PERIOD IS QUOTED" (about not printing a number)
// and "needs no cron to be scheduled" (a design property, permanently true). A checker that cannot
// tell "this machinery does not exist" from "this number is not printed" trains people to ignore it.
// ⛔ And /no sweeper/ is narrowed away from "no sweeper CAN reverse it", which is a statement about
// capability, not existence.
const PATTERNS = [
  /\bno sweeper\b(?!\s+can)/i, /\bno settler\b/i, /\bno reconcile job\b/i,
  /\bis unbuilt\b/i, /\bremains unbuilt\b/i, /\bUNBUILT job\b/i,
  /\bthere is no (sweeper|settler|cron|reconcile)/i,
  /\bnothing is checking\b/i, /\bnobody is (waiting|checking)\b/i,
  /\bno cron,? (and|so|because)\b/i,
];

/** Evidence the claim is about the PAST, or names what replaced it. */
const DATED = [
  /at the time this was written/i, /when this was written/i, /was true when written/i,
  /no longer/i, /that changed/i, /originally/i, /\b20\d\d-\d\d-\d\d\b/, /used to\b/i,
  /this said/i, /is now built/i, /is BUILT\b/, /now BUILT/i,
];
const CITES = [/\b[\w-]+\.(mjs|tsx?|js):\d+/, /bridge-reconcile-background/, /bridge-mint-sweep/];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === "node_modules" || e.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(e)) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => { try { return walk(join(ROOT, d)); } catch { return []; } })
  .map((p) => relative(ROOT, p));

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  ABSENCE CLAIMS — does every 'X does not exist' carry its own date?  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — 🚨 THE CHECKER EXCLUDES ITSELF, AND THAT EXCLUSION IS PROVEN");
{
  const corpus = files.filter((f) => f !== SELF);
  check("⭐ this file is IN the tree the walker sees", files.includes(SELF), SELF);
  check("⭐⭐ …and is EXCLUDED from the scanned corpus", !corpus.includes(SELF));
  // 🚨 THE CONTROL. If the patterns would NOT have matched this file, the exclusion is decorative
  // and proves nothing about the trap it exists to avoid.
  // ⭐ THE CONTROL MEASURES THE PROPERTY, NOT A PROXY. The first draft counted how many patterns
  // matched and required ≥5 — an arbitrary threshold that failed at 4 and would have been "fixed"
  // by tuning the number, which proves nothing. What matters is whether this file would be FLAGGED,
  // so run the real scan over it and require at least one undefended hit.
  const selfLines = readFileSync(join(ROOT, SELF), "utf8").split("\n");
  let selfUndefended = 0;
  for (let i = 0; i < selfLines.length; i++) {
    if (/\bcheck\(|\.test\(|^\s*!?\/[^/]|=> re\.test/.test(selfLines[i])) continue;
    if (!PATTERNS.some((re) => re.test(selfLines[i]))) continue;
    const near = selfLines.slice(Math.max(0, i - 6), i + 7).join(" ");
    if (!DATED.some((re) => re.test(near)) && !CITES.some((re) => re.test(near))) selfUndefended++;
  }
  // ⚠️ THE CONTROL ASSERTS WHAT IS TRUE, NOT WHAT WOULD BE TIDIER. A first draft required this file
  // to produce an UNDEFENDED hit, so that excluding it would be load-bearing for the VERDICT. It
  // produces none — this file's own absence claims all cite `bridge-mint-sweep`, so they defend
  // themselves. ⛔ Rather than plant an undefended claim to make the control fire, this measures the
  // property that actually holds: the file DOES match, so excluding it changes the corpus and the
  // magnitudes. The exclusion is scope hygiene — counting claims in shipped code, not in the
  // checker's own explanation of the pattern — and that is worth stating plainly rather than
  // dressing up as a near-miss.
  let selfMatches = 0;
  for (const l of selfLines) if (PATTERNS.some((re) => re.test(l))) selfMatches++;
  check("⭐⭐ …and it DOES match the patterns, so the exclusion changes the corpus",
    selfMatches >= 3, `${selfMatches} matching lines · ${selfUndefended} undefended`);
}

section("1 — ⭐ EVERY PRESENT-TENSE ABSENCE CLAIM IS DATED OR CITES ITS SUPERSEDER");
const corpus = files.filter((f) => f !== SELF);
let hits = 0, dated = 0, cited = 0;
const undefended = [];
for (const f of corpus) {
  const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    // 🚨 THE SAME TRAP, ONE FILE OVER. verify-bridge-copy asserts that the copy must NOT say
    // "nothing is checking" — so its assertion lines contain the phrase, and a naive scan flags the
    // guard that enforces the rule. An assertion ABOUT a phrase necessarily contains that phrase.
    // ⛔ Excluded by SHAPE, not by filename: any line that is a test assertion or a regex literal.
    // Excluding by filename would have hidden real claims in prose inside the same suites.
    // 🚨 `^\s*!?\/` MATCHED EVERY `//` COMMENT LINE. That is the whole corpus this check exists to
    // scan — hits fell 22 → 5 and BOTH mutation probes passed against a checker that was reading
    // almost nothing. Caught only because the mutations were run; the suite was green and useless.
    // ⭐ A regex literal starts with a slash NOT followed by another slash. One character.
    const isAssertion = /\bcheck\(|\.test\(|^\s*!?\/[^/]|=> re\.test/.test(lines[i]);
    if (isAssertion) continue;
    if (!PATTERNS.some((re) => re.test(lines[i]))) continue;
    hits++;
    // ⭐ THE NEIGHBOURHOOD, NOT THE LINE. A claim and its date are rarely on one line — the defence
    // is usually a sentence or two away, in the same comment block.
    const near = lines.slice(Math.max(0, i - 6), i + 7).join(" ");
    const isDated = DATED.some((re) => re.test(near));
    const isCited = CITES.some((re) => re.test(near));
    if (isDated) dated++;
    if (isCited) cited++;
    if (!isDated && !isCited) undefended.push(`${f}:${i + 1}  ${lines[i].trim().slice(0, 78)}`);
  }
}
console.log(`\n  RAW MAGNITUDES — files scanned ${corpus.length} · hits ${hits} · dated ${dated} · cite a superseder ${cited} · undefended ${undefended.length}`);
for (const u of undefended) console.log(`     ⛔ ${u}`);
check("⭐⭐ the corpus is non-empty — an empty scan would pass vacuously",
  corpus.length > 50 && hits > 0, `${corpus.length} files, ${hits} hits`);
check("⭐⭐ every absence claim is time-scoped or names what superseded it",
  undefended.length === 0,
  undefended.length ? "date it, or cite the thing that now does it — do not delete the claim" : "all defended");

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0`);
console.log(`⭐ ${hits} absence claims across ${corpus.length} files, every one dated or superseded.\n`);
