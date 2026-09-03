#!/usr/bin/env node
// verify-no-prose-state-recovery.mjs — NO CONSUMER MAY RECOVER A STATE BY MATCHING A MESSAGE
// STRING ANOTHER MODULE OWNS.
//
//   node scripts/verify-no-prose-state-recovery.mjs        (also: npm run test:proserecovery)
//
// ═══ 🚨 THE DEFECT THIS GENERALISES ═══════════════════════════════════════════════════════════
// `reverseAgentSpend` (_budget.mjs) refuses a second reversal with a sentence:
//
//     return { reversed: false, refused: "already reversed (id present in reversedIds)" };
//
// TWO consumers recovered that state by matching the sentence — `reverseChargeById` in the same
// file and the sweeper in `budget-sweep.mjs`, character-identical copies:
//
//     const alreadyDone = r.reversed === false && /already reversed/.test(r.refused || "");
//
// Both gate `markChargeResolved`. A REWORD of the refusal — a copy edit, the safest-looking change
// available — flips `alreadyDone` to false at both sites, the mark never runs, and a charge that
// really was reversed stays queued for the backstop forever.
//
// ⛔ AND NOTHING GOES RED. Both copies keep returning a well-formed boolean; there is no assertion
// anywhere that a `false` was EARNED. This is the absence-reads-as-safe family wearing a boolean:
// the failure produces a valid-looking value, not an error. [[absence-must-never-read-as-safe]]
//
// ═══ ⭐⭐ WHY THIS GUARDS THE CLASS AND NOT THE TWO SITES ═════════════════════════════════════
// Pinning the two known lines would be a guard against the instance that has already been fixed —
// green forever, and blind to the third consumer written next month. So this SCANS, and it prints
// its DENOMINATOR: files scanned, decision sites found, how many are typed, how many match prose,
// how many are exempt. A verdict without its denominator cannot be audited — "no prose matches"
// over a set that excludes the prose match is true and worthless.
// [[refuted-by-what-you-read-not-what-you-failed-to-find]]
//
// ═══ ⭐ WHAT IS *NOT* THIS CLASS, AND WHY THE SCANNER MUST TELL THEM APART ════════════════════
//   TYPED      `SET.includes(r.reason)`, `r.refusal === CODE`  — the field carries a CODE and is
//              compared against a closed set. The message is not being read; a symbol is. GOOD.
//   PROSE      `/already reversed/.test(r.refused)`, `msg.includes("…")` — the message is the
//              SUBJECT of a text match, so its wording is load-bearing. THE DEFECT.
// The distinction is the operand position, which is mechanical: is the message-bearing field the
// thing being matched, or the thing being looked up?
//
// ═══ ⚠️ THE EXEMPTION THAT IS REAL, AND WHY IT IS NOT A LOOPHOLE ══════════════════════════════
// You cannot type an error you did not throw. When the value is a THIRD-PARTY error — @netlify/blobs,
// App Kit, viem, undici — its message text is the only discriminator that exists, and refusing to
// read it would not make the code safer, only blinder. Those sites are DECLARED below with the
// owner of the string named, COUNTED in the denominator, and RATCHETED: `MAX_EXEMPT` may only ever
// be lowered. Known debt that cannot grow is a plan.
// ⛔ A declared exemption whose site has DISAPPEARED also fails. A stale entry is a licence nobody
// is using, and it is exactly how a table like this rots into a place to hide.

import { readdirSync, readFileSync } from "node:fs";

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}\n      ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

// ── THE SURFACE ───────────────────────────────────────────────────────────────────────────────
// Runtime only. `scripts/` is EXCLUDED and the count is printed below rather than left implicit:
// a guard asserting that a message SAYS something is an assertion about copy, not a state recovered
// from it, and folding hundreds of those in would bury the class this file exists to see.
// ⚠️ That exclusion is a hypothesis about what the files are, so it is stated, sized and visible.
const SURFACES = ["netlify/functions", "shared", "src"];
const EXCLUDED_SURFACES = ["scripts"];

/** Fields that carry a sentence written for a human. */
const PROSE_FIELDS = [
  "refused", "message", "reason", "detail", "why", "note", "statusText", "msg", "errorMessage",
];

/** Text-matching operations. If a prose field is the SUBJECT of one of these, its wording is load-bearing. */
const MATCH_OPS = ["includes", "startsWith", "endsWith", "indexOf", "search", "match"];

/**
 * DECLARED EXEMPTIONS — file → why the message text is the only discriminator available.
 * ⚠️ Every one of these was READ before it was written down; none is "it looked like an error".
 */
const EXEMPT = {
  "netlify/functions/blobs-probe.mjs":
    "THIRD-PARTY: @netlify/blobs error classes. `classifyError` checks `err.name` FIRST " +
    "(BlobsConsistencyError / MissingBlobsEnvironmentError) and falls back to the library's fixed " +
    "message text only so a future RENAME of the class still classifies. Typed-first, prose-as-backup.",
  "netlify/functions/_pay.mjs":
    "THIRD-PARTY: Circle App Kit's async-waiter quirk (issue 1098). `e?.code === 1098` is checked " +
    "FIRST; the 'transaction hash is required' match catches the same fault arriving without the code.",
  "netlify/functions/_ubspend.mjs":
    "THIRD-PARTY: the same App Kit 1098 quirk on the unified-balance spend path, same typed-first shape.",
  "netlify/functions/_receipt.mjs":
    "THIRD-PARTY: node/undici DNS and socket failures. `classifyRpcFailure` tests `e.cause.code` " +
    "against a closed list FIRST; the getaddrinfo/ENOTFOUND text is the fallback for the same fault " +
    "surfaced without a code.",
  "netlify/functions/agent-ub-deposit-background.mjs":
    "THIRD-PARTY: viem error-text prefixes ('RPC Request failed', 'The contract function'). ⭐ AND IT " +
    "RECOVERS NO STATE — the match only decides whether a viem dump is fit to show a user. The money " +
    "decision above it uses `isTransient(e)`.",
  "shared/dd/rpc.mjs":
    "THIRD-PARTY: transport failures thrown by fetch/undici, which carry no typed class. TRANSIENT is " +
    "a closed regex set applied to them to decide RETRY vs SURFACE — and the conservative direction " +
    "is not-transient, which surfaces rather than swallows.",
  "netlify/functions/_budget-test.mjs":
    "IN-REPO TEST HARNESS: it asserts that a refusal message CITES the cap that fired. That is an " +
    "assertion ABOUT copy, not a state recovered FROM copy — the class this file forbids is a " +
    "consumer branching on wording, and an assertion branches on nothing.",
};

// ⭐ RATCHET. Lower it when an exemption is retired; it may never be raised.
const MAX_EXEMPT = 7;

// ── the walk ──────────────────────────────────────────────────────────────────────────────────
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
const sourceFiles = (dirs) => dirs.flatMap(walk)
  .filter((f) => /\.(mjs|js|ts|tsx)$/.test(f) && !/\.d\.mts$/.test(f));

const files = sourceFiles(SURFACES);
const excludedCount = sourceFiles(EXCLUDED_SURFACES).length;

/**
 * ⛔ COMMENTS OUT, LINE NUMBERS INTACT. A block comment removed wholesale shifts every line after
 * it, and a guard that reports the wrong line teaches the reader the guard is broken. It also
 * matters for correctness here: `_budget.mjs` DOCUMENTS the old prose match in its header, and a
 * scanner that read comments would flag the tombstone and never be able to go green.
 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));

/** Locals assigned from a prose field in the same file — `const msg = e?.message || ""`. One hop is
 *  what the real population needs, and a deeper walk would trade precision for reach we cannot use. */
function proseLocals(src) {
  const out = new Set();
  const re = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=[^;\\n]*?\\.(?:${PROSE_FIELDS.join("|")})\\b`, "g");
  for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

/** Every decision site in one file, classified. */
function scanFile(f) {
  const src = stripComments(readFileSync(f, "utf8"));
  const locals = proseLocals(src);
  const ids = [...PROSE_FIELDS, ...locals];
  const idAlt = ids.map((i) => i.replace(/[$]/g, "\\$")).join("|");
  const prose = [], typed = [];

  src.split("\n").forEach((line, i) => {
    const at = { file: f, line: i + 1, text: line.trim().slice(0, 120) };

    // PROSE — the field is the SUBJECT of a text match.
    const subjectOfOp = new RegExp(`(?:\\.|\\b)(?:${idAlt})\\s*\\.\\s*(?:${MATCH_OPS.join("|")})\\s*\\(`);
    // PROSE — the field is the ARGUMENT of a regex test/exec, which is the same thing said backwards.
    const argOfRegex = new RegExp(`\\.\\s*(?:test|exec)\\s*\\(\\s*[^)]*?(?:\\.|\\b)(?:${idAlt})\\b`);
    // TYPED — a closed set is the receiver and the field is what is looked UP, or a direct equality.
    const typedSite = new RegExp(
      `\\.\\s*(?:includes|has)\\s*\\(\\s*[^)]*?(?:\\.|\\b)(?:${idAlt})\\b` +
      `|(?:\\.|\\b)(?:${idAlt})\\s*(?:===|!==)`);

    if (subjectOfOp.test(line) || argOfRegex.test(line)) prose.push(at);
    else if (typedSite.test(line)) typed.push(at);
  });
  return { prose, typed };
}

const scanned = files.map((f) => ({ f, ...scanFile(f) }));
const allProse = scanned.flatMap((s) => s.prose);
const allTyped = scanned.flatMap((s) => s.typed);
const exemptHits = allProse.filter((p) => EXEMPT[p.file]);
const offenders = allProse.filter((p) => !EXEMPT[p.file]);

console.log("\nverify-no-prose-state-recovery — may a consumer recover a state from someone else's sentence?");
console.log(
  `\n     files scanned ${files.length}  ·  decision sites ${allProse.length + allTyped.length}` +
  `  ·  typed ${allTyped.length}  ·  prose-matched ${allProse.length}` +
  `  ·  exempt ${exemptHits.length}  ·  OFFENDING ${offenders.length}`);
console.log(`     surfaces ${SURFACES.join(", ")}  ·  excluded ${EXCLUDED_SURFACES.join(", ")} (${excludedCount} files: guards assert copy, they do not branch on it)`);

// ⭐ `--list` PRINTS THE SET, NOT JUST ITS SIZE. A denominator a reader cannot open is still a
// number they have to trust; this is how an exemption gets audited without re-deriving the scan.
if (process.argv.includes("--list")) {
  console.log("\n     ── every prose match found ──");
  for (const p of allProse) {
    console.log(`     ${EXEMPT[p.file] ? "exempt " : "OFFEND "} ${p.file}:${p.line}  ${p.text}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — ⭐⭐ THE DETECTOR IS ALIVE (without this, every count below is vacuous)");
{
  // The exempt sites are the built-in positive control: they are REAL prose matches that must stay
  // findable. If the scanner breaks, `prose-matched` collapses to 0 and reads exactly like success.
  // [[equality-passes-vacuously-on-empty]] [[control-needs-ownership-and-stability]]
  ok("the scanner finds prose matches AT ALL — the known third-party sites",
    exemptHits.length > 0, `found ${exemptHits.length}`);
  ok("⭐ …and finds them in blobs-probe.mjs specifically, the named exemplar",
    exemptHits.some((h) => h.file === "netlify/functions/blobs-probe.mjs"),
    exemptHits.map((h) => h.file).join(", ") || "none");
  ok("⭐ it also finds TYPED sites, so the two classes are actually being told apart",
    allTyped.length > 0, `${allTyped.length} typed`);
  ok("the surface is non-empty and includes the money path",
    files.includes("netlify/functions/_budget.mjs") && files.includes("netlify/functions/budget-sweep.mjs"),
    `${files.length} files`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 THE CLASS: no unexempted consumer branches on someone else's wording");
{
  ok("⭐⭐ ZERO offending prose matches across the runtime surface",
    offenders.length === 0,
    offenders.map((o) => `${o.file}:${o.line}  ${o.text}`).join("\n      "));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⚠️ THE EXEMPTION TABLE IS HONEST (declared, used, and shrinking)");
{
  const declared = Object.keys(EXEMPT);
  const stale = declared.filter((f) => !allProse.some((p) => p.file === f));
  ok("⛔ every declared exemption still has a site — a stale entry is a licence nobody is using",
    stale.length === 0, `stale: ${stale.join(", ")}`);
  ok("every exemption states WHO owns the string it matches",
    declared.every((f) => /THIRD-PARTY|IN-REPO TEST HARNESS/.test(EXEMPT[f])),
    declared.filter((f) => !/THIRD-PARTY|IN-REPO TEST HARNESS/.test(EXEMPT[f])).join(", "));
  ok(`⭐ the ratchet holds — ${declared.length} exemptions, ceiling ${MAX_EXEMPT}`,
    declared.length <= MAX_EXEMPT, `${declared.length} > ${MAX_EXEMPT}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ THE INSTANCE THAT PROVOKED THIS: one predicate, both consumers");
{
  const budget = readFileSync("netlify/functions/_budget.mjs", "utf8");
  const sweep = readFileSync("netlify/functions/budget-sweep.mjs", "utf8");
  const budgetCode = stripComments(budget);
  const sweepCode = stripComments(sweep);

  ok("`reverseAgentSpend` returns a TYPED refusal code at the already-reversed site",
    /refuseReversal\(REVERSAL_REFUSAL\.ALREADY_REVERSED/.test(budgetCode),
    "the return site must name the code, not only the sentence");
  ok("⭐ the closed set is frozen, so a code cannot be added by assignment at runtime",
    /export const REVERSAL_REFUSAL = Object\.freeze\(/.test(budgetCode));

  const defs = scanned.filter((s) => /export const wasAlreadyReversed/.test(stripComments(readFileSync(s.f, "utf8"))));
  ok("⭐⭐ ONE implementation of the predicate in the whole runtime surface",
    defs.length === 1, `${defs.length} definitions: ${defs.map((d) => d.f).join(", ")}`);

  ok("…and it reads the TYPED field, never the sentence",
    /r\?\.refusal === REVERSAL_REFUSAL\.ALREADY_REVERSED/.test(budgetCode) &&
    !/wasAlreadyReversed[\s\S]{0,200}?refused\s*\|\|/.test(budgetCode));

  ok("consumer 1 — `reverseChargeById` calls the shared predicate",
    /const alreadyDone = wasAlreadyReversed\(r\)/.test(budgetCode));
  ok("consumer 2 — `budget-sweep.mjs` IMPORTS it rather than re-deriving it",
    /import \{[^}]*wasAlreadyReversed[^}]*\} from "\.\/_budget\.mjs"/.test(sweepCode) &&
    /const alreadyDone = wasAlreadyReversed\(r\)/.test(sweepCode));

  // ⭐ THE PAIRWISE INEQUALITY. "Neither file contains the old regex" is satisfied by a file that
  // contains nothing at all; this asserts the two consumers reach the SAME implementation, which a
  // re-derived copy would not. [[collapse-needs-pairwise-inequality]]
  const sweepDerives = /wasAlreadyReversed\s*=/.test(sweepCode);
  ok("⛔ …and does NOT define its own — a second copy is how the drifting one stops guarding",
    !sweepDerives, "budget-sweep.mjs assigns wasAlreadyReversed itself");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
const total = pass + fail;
console.log("\n" + "─".repeat(92));
console.log(`${fail === 0 ? "✅" : "❌"} verify-no-prose-state-recovery — ${pass}/${total} passed, ${fail} failed`);
if (fail) {
  console.log(`\n   FAILED: ${fails.join(" · ")}`);
  console.log(`\n   🚨 A consumer that recovers a state by matching a sentence another module owns is`);
  console.log(`      guarding NOTHING the moment that sentence is reworded — and it keeps returning a`);
  console.log(`      well-formed boolean while it does. Return a typed code from the site that KNOWS`);
  console.log(`      the state; branch on the code. If the string belongs to a third party, declare an`);
  console.log(`      exemption above and name its owner.`);
}
console.log("─".repeat(92) + "\n");
process.exit(fail === 0 ? 0 : 1);
