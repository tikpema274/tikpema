// verify-build-skip-predicate.mjs — does the build-skip PREDICATE decide correctly?
//
//   node scripts/verify-build-skip-predicate.mjs        (also: npm run test:buildskip)
//
// ⛔ OFFLINE. No network, no deploy, no build. It evaluates a git command against commit ranges
// that already exist in this repo's history, which is the whole point: the predicate is a pure
// function of two commit refs, so it can be exercised for zero build minutes.
//
// ═══ 🚨 WHAT THIS PROVES, AND WHAT IT DOES NOT — READ BEFORE TRUSTING A GREEN ══════════════════
// It proves the PREDICATE DECIDES CORRECTLY: given (from, to), `git diff --quiet … -- <path>`
// returns skip/build as intended for every commit shape.
//
// ⛔ IT DOES NOT PROVE NETLIFY HONOURS IT. Those are different failures and they look identical
// from here:
//   · Netlify may not run the command at all (wrong key, wrong file, wrong build context)
//   · it may not set `CACHED_COMMIT_REF` / `COMMIT_REF` in the ignore context under these names
//   · it may interpret the exit code the other way round
// ⭐ A CORRECT COMMAND NETLIFY NEVER RUNS LOOKS EXACTLY LIKE NO COMMAND AT ALL — both produce a
// build on every push, and neither produces an error. Only a live push discriminates them.
// [[binding-tested-across-what-it-binds]] · [[a-deploy-check-needs-a-build-it-should-fail-against]]
//
// ═══ ⚠️ AND IT REACHES ONLY ONE OF THE TWO SITES ═══════════════════════════════════════════════
// The predicate below is the one intended for the MARKETING site (`tikpema`, base `site/`). Whether
// it lives in `site/netlify.toml` or in that site's UI settings, **it executes on Netlify's build
// machine in that site's build context — which nothing in this repo can enter.** So a green here is
// a statement about a git command, not about a deploy pipeline.
//
// ⛔ AND THERE IS NO APP-SIDE COMMAND TO TEST AT ALL. Measured 2026-08-31: the app site has NEVER
// built on Netlify — `listSiteBuilds` returns [], 0 of its last 100 deploys carry a `build_id` or a
// `commit_ref`, and its linked repo 404s. It deploys by CLI from a local build. There is no push-
// triggered app build for an ignore command to skip, so none is added: an inert guard implying a
// build path that does not exist is worse than none, because a later reader would trust it.
//
// ⛔ DO NOT RECORD THE SKIP AS VERIFIED ON THE STRENGTH OF THIS FILE. The next real change settles
// it at no extra cost — see the closing note.

import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

/**
 * Netlify's `ignore` contract: exit 0 → SKIP the build, non-zero → BUILD.
 * `git diff --quiet` exits 0 when there is NO difference, so "no change under <path>" → skip.
 * ⭐ A git error (e.g. an unknown ref on the very first build, when CACHED_COMMIT_REF is unset)
 * exits non-zero → BUILD. The failure falls toward building, never toward silently skipping.
 */
function decide(from, to, pathspec) {
  try {
    execFileSync("git", ["diff", "--quiet", from, to, "--", ...pathspec], { stdio: "ignore" });
    return "SKIP";
  } catch {
    return "BUILD";
  }
}

const SITE = ["site"];
const NOT_SITE = [".", ":!site"];

// ═══ ⚠️ THE SEARCH WINDOW, AND WHY IT REPORTS ITS OWN DEPTH ═══════════════════════════════════
// This searched the last 60 commits for one commit of each shape. On 2026-09-03 it went RED — not
// because the predicate broke, but because a busy session pushed the most recent site-only commit
// to **position 61**. ⭐ The guard was right to refuse: it says "the rows below would be vacuous"
// and aborts rather than passing on an empty sample.
//
// ⛔ BUT A SLIDING WINDOW MAKES GREENNESS A FUNCTION OF RECENT COMMIT HABITS, which is not a
// property of the thing under test. Hardcoding SHAs is the other failure — they rot on a rebase.
// ⭐ So the window is wide enough to hold the sample AND the guard REPORTS HOW DEEP IT HAD TO GO,
// warning as it approaches the edge — the same early-warning shape as readWithRetry's NARROW
// MARGIN. A guard that can drift into vacuity should say so BEFORE it does.
const WINDOW = 400;
const commits = git(["log", "--format=%H", `-${WINDOW}`]).split("\n").filter(Boolean);
const shapeOf = (c) => {
  const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", c]).split("\n").filter(Boolean);
  const s = files.filter((f) => f.startsWith("site/")).length;
  const n = files.length - s;
  if (s > 0 && n === 0) return "ONLY-site";
  if (s === 0 && n > 0) return "ONLY-other";
  if (s > 0 && n > 0) return "BOTH";
  return "EMPTY";
};
const found = { "ONLY-site": null, "ONLY-other": null, BOTH: null };
const depth = { "ONLY-site": null, "ONLY-other": null, BOTH: null };
for (let i = 0; i < commits.length; i++) {
  const sh = shapeOf(commits[i]);
  if (sh in found && !found[sh]) { found[sh] = commits[i]; depth[sh] = i + 1; }
  if (Object.values(found).every(Boolean)) break;
}

console.log("\n⭐ 1 — EVERY COMMIT SHAPE IS ACTUALLY PRESENT (an absent shape must not pass silently)");
for (const [sh, c] of Object.entries(found)) {
  check(`a real "${sh}" commit exists within the last ${WINDOW}`, !!c,
    c ? `${c.slice(0, 8)} at depth ${depth[sh]}/${WINDOW}` : `NOT FOUND in ${commits.length} commits — the rows below would be vacuous`);
}
// ⚠️ THE EARLY WARNING. Silence until the day it breaks is what made the 60-commit window a
// surprise; this says the sample is receding while there is still room to act.
const deepest = Math.max(...Object.values(depth).filter((d) => d != null));
if (Number.isFinite(deepest) && deepest > WINDOW * 0.6) {
  console.log(`  ⚠️ NARROW MARGIN — the deepest shape sits at ${deepest}/${WINDOW}. Widen WINDOW, or ` +
    `accept that this guard will go vacuous once it passes ${WINDOW}.`);
}
if (!Object.values(found).every(Boolean)) {
  console.log("\n⛔ ABORTING — a shape is missing, so the table below would assert nothing.");
  process.exit(2);
}

console.log("\n⭐⭐ 2 — THE PREDICATE DECIDES CORRECTLY FOR EVERY SHAPE");
const expected = {
  "ONLY-site":  { site: "BUILD", other: "SKIP"  },
  "ONLY-other": { site: "SKIP",  other: "BUILD" },
  BOTH:         { site: "BUILD", other: "BUILD" },
};
for (const [sh, c] of Object.entries(found)) {
  const s = decide(`${c}^`, c, SITE);
  const o = decide(`${c}^`, c, NOT_SITE);
  check(`${sh.padEnd(10)} → marketing ${expected[sh].site}`, s === expected[sh].site, `${c.slice(0, 8)} got ${s}`);
  check(`${sh.padEnd(10)} → app-side  ${expected[sh].other}`, o === expected[sh].other, `${c.slice(0, 8)} got ${o}`);
}

console.log("\n🚨 3 — WHY THE REF PAIR MUST BE CACHED_COMMIT_REF..COMMIT_REF, NOT HEAD^..HEAD");
// A push can carry several commits. `HEAD^ HEAD` inspects only the LAST one, so a site/ change in
// an earlier commit of the same push is skipped — a SILENT stale deploy, which is the failure this
// whole exercise exists to prevent.
{
  const onlySite = found["ONLY-site"];
  const later = commits[commits.indexOf(onlySite) - 1]; // the commit pushed after it
  if (!later) {
    check("⚠️ a multi-commit range is constructible", false, "no commit after the ONLY-site one");
  } else {
    const rangeStart = `${onlySite}^`;
    const wholeRange = decide(rangeStart, later, SITE);
    const lastOnly = decide(`${later}^`, later, SITE);
    check("⭐ the WHOLE range correctly says BUILD", wholeRange === "BUILD",
      `${rangeStart.slice(0, 8)}..${later.slice(0, 8)}`);
    check("🚨 …while HEAD^..HEAD would say SKIP — the silent stale deploy", lastOnly === "SKIP",
      "this is why the command must not use HEAD^");
    check("⛔ …so the two forms genuinely DISAGREE on this range", wholeRange !== lastOnly);
  }
}

console.log(`\n${"═".repeat(78)}`);
console.log(`${fail === 0 ? "✅ THE PREDICATE IS CORRECT" : "❌ PREDICATE FAULT"}   pass ${pass} / fail ${fail}`);
console.log(`${"═".repeat(78)}`);
console.log(`⚠️  SCOPE — what this ${pass}/${fail} does NOT cover:`);
console.log(`   · it does NOT prove Netlify RUNS the command, passes those refs, or reads the exit`);
console.log(`     code the same way. A correct command Netlify never runs is INDISTINGUISHABLE from`);
console.log(`     no command at all — both build on every push, neither errors.`);
console.log(`   · it reaches ONE site's intent only. The command executes in the MARKETING site's`);
console.log(`     build context on Netlify, which nothing in this repo can enter.`);
console.log(`   · there is NO app-side ignore command: the app has never built on Netlify.`);
console.log(`⛔ DO NOT record the build-skip as verified on this alone. The next real change settles`);
console.log(`   it free: the first post-relink build MUST run (CACHED_COMMIT_REF is unset), then one`);
console.log(`   app-only push must produce NO new marketing deploy. Check with:`);
console.log(`     netlify api listSiteDeploys --data '{"site_id":"a892e744-9dfc-45df-8cd4-8cd1b0c480b4","per_page":5}'`);
process.exit(fail === 0 ? 0 : 1);
