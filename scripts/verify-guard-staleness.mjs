// verify-guard-staleness.mjs — IS A GUARD OWED A RUN? every branch, driven.
//
//   node scripts/verify-guard-staleness.mjs        (also: npm run test:guardstaleness)
//
// ═══ WHAT THIS PROTECTS ══════════════════════════════════════════════════════════════════════
// Eight guards sit outside `test:all` by decision. Their run-triggers used to be PROSE, so nothing
// could tell whether one had ever been honoured — and the `test:ddwatch` exemption showed what that
// costs: a stated reason that was simply untrue, uncontradicted for two months, keeping 98 offline
// assertions out of every run.
//
// The staleness logic is now the thing standing between a declared trigger and a forgotten one, so
// every way it can be wrong IN THE REASSURING DIRECTION is driven here:
//
//   · a guard that was never run reading as clean
//   · an unresolvable diff reading as "nothing changed"
//   · a ledger whose lines arrive out of order picking the wrong "last" run
//   · a trigger declaring no mechanism at all, which goes permanently clean after one run
//
// Zero network. Zero money. Pure functions and fixtures.

import { parseRunLog, owedFor, triggerIsActionable, OWED } from "./lib/guard-staleness.mjs";
import { UNWIRED_OK, UNWIRED_TRIGGERS } from "./guard-registry.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return !!c;
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const row = (name, at, commit = "c0ffee") => JSON.stringify({ name, at, commit });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  GUARD STALENESS — when is an unwired guard owed a run               ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — THE INSTRUMENT IS NOT VACUOUS");
{
  const t = { onDeployTouching: ["src/components/A.tsx"] };
  const hit = owedFor({ trigger: t, lastRun: { at: ago(1), commit: "a" }, changedPaths: ["src/components/A.tsx"], now: NOW });
  const miss = owedFor({ trigger: t, lastRun: { at: ago(1), commit: "a" }, changedPaths: ["src/components/B.tsx"], now: NOW });
  check("⭐ the same trigger gives OPPOSITE verdicts on two path sets", hit.owed === true && miss.owed === false,
    "a predicate returning a constant would fail here");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 NEVER RUN IS OWED, NOT CLEAN");
for (const [name, lastRun] of [["null", null], ["undefined", undefined]]) {
  const v = owedFor({ trigger: { everyDays: 999999 }, lastRun, changedPaths: [], now: NOW });
  check(`⭐⭐ lastRun ${name} → OWED even with a horizon that could never expire`,
    v.owed === true && v.reason === OWED.NEVER_RUN, v.detail);
}
{
  const p = parseRunLog("");
  check("⭐ an EXISTING but empty ledger parses ok…", p.ok === true && p.runs.size === 0);
  check("⭐⭐ …and every guard then reads as never-run, not as clean",
    owedFor({ trigger: { everyDays: 30 }, lastRun: p.runs.get("gate:pins") ?? null, changedPaths: [], now: NOW }).reason === OWED.NEVER_RUN);
  const absent = parseRunLog(null);
  check("⭐ an ABSENT ledger is reported as not-ok, distinctly from an empty one",
    absent.ok === false, absent.why);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 AN UNRESOLVABLE DIFF IS OWED, NEVER 'NOTHING CHANGED'");
for (const [name, changed] of [["null", null], ["undefined", undefined]]) {
  const v = owedFor({ trigger: { onDeployTouching: ["src/x.tsx"] }, lastRun: { at: ago(1), commit: "gone" }, changedPaths: changed, now: NOW });
  check(`⭐⭐ changedPaths ${name} → OWED (undetermined), not clean`,
    v.owed === true && v.reason === OWED.UNDETERMINED, v.detail);
}
{
  // ⚠️ And it must not fall through to the clock and answer a question nobody asked.
  const v = owedFor({ trigger: { onDeployTouching: ["src/x.tsx"], everyDays: 999999 }, lastRun: { at: ago(1), commit: "gone" }, changedPaths: null, now: NOW });
  check("⭐ …and an unresolvable diff is not rescued by a generous clock", v.reason === OWED.UNDETERMINED);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — PATH TRIGGERS");
{
  const t = { onDeployTouching: ["src/components/ManualSwapPanel.tsx", "site/"] };
  const L = { at: ago(1), commit: "a" };
  check("⭐ an exact path hit is OWED",
    owedFor({ trigger: t, lastRun: L, changedPaths: ["src/components/ManualSwapPanel.tsx"], now: NOW }).reason === OWED.DEPLOY_TOUCHED);
  check("⭐ a DIRECTORY prefix matches a file beneath it",
    owedFor({ trigger: t, lastRun: L, changedPaths: ["site/index.html"], now: NOW }).reason === OWED.DEPLOY_TOUCHED);
  // ⭐⭐ THE DECLARED PATH HERE HAS NO TRAILING SLASH, AND THAT IS THE WHOLE TEST.
  // The first version of this assertion used `"site/"`, which ALREADY ends in a slash — so the
  // separator logic it meant to exercise was a no-op and the check passed against a `startsWith(p)`
  // that swallows siblings. MUTATION FOUND IT: dropping the guard left the suite 33/0 green.
  // A trigger is far more likely to be declared as `"site"` than `"site/"`, so the unslashed form
  // is the one that must be pinned. [[fixtures-that-agree-cannot-discriminate]]
  check("⭐⭐ an UNSLASHED directory trigger does not swallow a sibling with the same prefix",
    owedFor({ trigger: { onDeployTouching: ["site"] }, lastRun: L, changedPaths: ["sitemap.xml"], now: NOW }).owed === false,
    "`site` must not match `sitemap.xml` — the separator is inserted, not assumed");
  check("⭐ …while still matching a real file BENEATH it",
    owedFor({ trigger: { onDeployTouching: ["site"] }, lastRun: L, changedPaths: ["site/index.html"], now: NOW }).reason === OWED.DEPLOY_TOUCHED,
    "and the pair is what makes the assertion above non-vacuous");
  check("⭐ the slashed form behaves identically",
    owedFor({ trigger: { onDeployTouching: ["site/"] }, lastRun: L, changedPaths: ["sitemap.xml"], now: NOW }).owed === false &&
    owedFor({ trigger: { onDeployTouching: ["site/"] }, lastRun: L, changedPaths: ["site/index.html"], now: NOW }).owed === true);
  check("an unrelated change leaves it clean",
    owedFor({ trigger: t, lastRun: L, changedPaths: ["README.md"], now: NOW }).owed === false);
  check("an empty diff leaves it clean", owedFor({ trigger: t, lastRun: L, changedPaths: [], now: NOW }).owed === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — CLOCK TRIGGERS (the only instrument for an OFF-REPO subject)");
{
  const t = { everyDays: 30 };
  check("⭐ past the horizon → OWED (age)",
    owedFor({ trigger: t, lastRun: { at: ago(31), commit: "a" }, changedPaths: [], now: NOW }).reason === OWED.AGE);
  check("inside the horizon → clean",
    owedFor({ trigger: t, lastRun: { at: ago(29), commit: "a" }, changedPaths: [], now: NOW }).owed === false);
  check("⭐ an unparseable run timestamp is OWED, not clean",
    owedFor({ trigger: t, lastRun: { at: "not-a-date", commit: "a" }, changedPaths: [], now: NOW }).reason === OWED.UNDETERMINED);
  check("⭐⭐ a PATH-only trigger never expires by clock — that is the point of declaring one",
    owedFor({ trigger: { onDeployTouching: ["src/x.tsx"] }, lastRun: { at: ago(3650), commit: "a" }, changedPaths: [], now: NOW }).owed === false,
    "a guard watching our files is invalidated by our changes, not by time passing");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — THE LEDGER");
{
  const p = parseRunLog([row("gate:pins", ago(9)), row("gate:pins", ago(2)), row("gate:pins", ago(5))].join("\n"));
  check("⭐⭐ the LAST run is the newest by TIMESTAMP, not the last line",
    p.ok && p.runs.get("gate:pins").at === ago(2),
    "file order is chronological in practice; a verdict that depended on it would break on interleaved appends");
  const q = parseRunLog(`${row("a", ago(1))}\n{ broken\n${row("b", ago(1))}\n{"name":"c"}\n`);
  check("⭐ unparseable and shape-wrong lines are SKIPPED and COUNTED", q.ok && q.skipped === 2, `skipped ${q.skipped}`);
  check("  …and the good lines around them still land", q.runs.has("a") && q.runs.has("b"));
  check("⭐ a row with no timestamp is not silently treated as a run", !q.runs.has("c"));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⛔ A TRIGGER THAT DECLARES NEITHER MECHANISM IS NOT A TRIGGER");
{
  check("neither mechanism → not actionable", triggerIsActionable({ subject: "x" }) === false);
  check("empty path list → not actionable", triggerIsActionable({ onDeployTouching: [] }) === false);
  check("zero/negative days → not actionable", triggerIsActionable({ everyDays: 0 }) === false && triggerIsActionable({ everyDays: -5 }) === false);
  check("⭐ either mechanism alone IS actionable",
    triggerIsActionable({ onDeployTouching: ["a"] }) === true && triggerIsActionable({ everyDays: 1 }) === true);
  check("⭐⭐ and such a trigger would go PERMANENTLY CLEAN after one run — the reason it is banned",
    owedFor({ trigger: { subject: "x" }, lastRun: { at: ago(9999), commit: "a" }, changedPaths: [], now: NOW }).owed === false,
    "9999 days old and clean: an exemption wearing a check's clothes");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — 🚨 MATRIX: NO INPUT COMBINATION LETS A NEVER-RUN GUARD READ CLEAN");
{
  let combos = 0, wrong = 0;
  for (const trigger of [{ everyDays: 1 }, { everyDays: 99999 }, { onDeployTouching: ["a"] }, { onDeployTouching: ["a"], everyDays: 5 }, { subject: "none" }]) {
    for (const changedPaths of [null, [], ["a"], ["zzz"]]) {
      for (const lastRun of [null, undefined]) {
        combos++;
        if (owedFor({ trigger, lastRun, changedPaths, now: NOW }).owed !== true) wrong++;
      }
    }
  }
  check("⭐ the matrix is non-empty", combos === 5 * 4 * 2, `${combos} combinations`);
  check("⭐⭐ EVERY never-run combination is OWED", wrong === 0, `${wrong} read clean of ${combos}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 — GROUNDED: THE REAL DECLARATIONS");
{
  const names = Object.keys(UNWIRED_OK);
  check("⭐ there are unwired guards to check at all", names.length > 0, `${names.length} declared`);
  const notActionable = names.filter((n) => !triggerIsActionable(UNWIRED_TRIGGERS[n]));
  check("⭐⭐ every real declared trigger is ACTIONABLE", notActionable.length === 0,
    notActionable.length ? notActionable.join(", ") : `${names.length} triggers`);
  const noSubject = names.filter((n) => typeof UNWIRED_TRIGGERS[n]?.subject !== "string");
  check("⭐ every trigger names its SUBJECT — what it is watching that we do not control",
    noSubject.length === 0, noSubject.length ? noSubject.join(", ") : "all named");
  // ⭐ Both mechanisms are represented, so neither branch of owedFor is dead in production use.
  const paths = names.filter((n) => (UNWIRED_TRIGGERS[n].onDeployTouching ?? []).length > 0);
  const clocks = names.filter((n) => Number(UNWIRED_TRIGGERS[n].everyDays) > 0);
  check("⭐ both mechanisms are actually in use — neither branch is dead code",
    paths.length > 0 && clocks.length > 0, `${paths.length} path-triggered, ${clocks.length} clock-triggered`);
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
