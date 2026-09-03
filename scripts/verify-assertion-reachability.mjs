#!/usr/bin/env node
// verify-assertion-reachability.mjs — ⛔ AN ASSERTION THAT CANNOT REACH THE VERDICT IS NOT A CHECK.
//
//   node scripts/verify-assertion-reachability.mjs        (also: npm run test:reachability)
//   --list  prints every suite scanned with its verdict line and assertion span
//
// ═══ 🚨 THE DEFECT, MEASURED 2026-09-03 ══════════════════════════════════════════════════════
// A new section was appended to `verify-amount-precision.mjs` by inserting before the file's LAST
// `console.log` — which put it AFTER `if (fail) { …; process.exit(1) }`. The section ran, printed
// `❌` for its failing checks, and the suite exited **0**. Nine assertions, none able to redden a run.
//
// ⛔⛔ A GREEN BASELINE LOOKS IDENTICAL. An unreachable section prints ✅ exactly like a reachable
// one, so nothing in a passing run distinguishes "these passed" from "these cannot fail". Only
// MUTATING found it — and the mutation's own report (`MUTATION NOT CAUGHT`, with red on screen)
// reads as "the guard is weak" rather than "the guard is unreachable".
//
// ⭐ THE RULE IS POSITIONAL AND MECHANICAL. A suite's verdict is its exit code. After the LAST
// `process.exit(` in a top-level script, the process falls off the end and returns 0 no matter what
// any later assertion records. So: an assertion after the last exit cannot change the verdict,
// whether that exit was conditional (`if (fail) …`) or not.
//
// ═══ ⚠️ WHAT THIS IS NOT ═════════════════════════════════════════════════════════════════════
// Textual position is a proxy for execution order, and it is exact only for TOP-LEVEL code — which
// is how every suite here is written. It cannot see an assertion that runs but is never counted, or
// one inside a callback that never fires. Those are real and this does not claim them.
// Same family as [[a-partial-mock-fails-at-instantiation]]: blind for 33 days, green throughout.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const fails = [];
const ok = (l, c, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; fails.push(l); console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const SCRIPT_FILE = /scripts\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|mts)/g;

/** Files a `test:all` run actually executes — expanded from `suites`, then followed through
 *  imports and spawns, exactly as verify-guard-registry derives reachability. */
function reachableFromTestAll() {
  const seen = new Set();
  const queue = [];
  const expand = (cmd) => {
    for (const m of String(cmd).matchAll(SCRIPT_FILE)) if (!seen.has(m[0])) { seen.add(m[0]); queue.push(m[0]); }
    for (const m of String(cmd).matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) if (pkg.scripts?.[m[1]]) expand(pkg.scripts[m[1]]);
  };
  for (const s of pkg.suites ?? []) expand(pkg.scripts[s]);
  while (queue.length) {
    const f = queue.pop();
    if (!existsSync(f)) continue;
    const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
    for (const m of [...src.matchAll(/from\s+"(\.[^"]+)"/g), ...src.matchAll(/["'`](\.\.?\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|mts))["'`]/g)]) {
      const dir = f.slice(0, f.lastIndexOf("/"));
      const out = [];
      for (const seg of `${dir}/${m[1]}`.split("/")) { if (seg === "." || seg === "") continue; if (seg === "..") out.pop(); else out.push(seg); }
      const r = out.join("/");
      if (r.startsWith("scripts/") && !seen.has(r) && existsSync(r)) { seen.add(r); queue.push(r); }
    }
  }
  return seen;
}

const walk = (d) => readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
const files = walk("scripts").filter((f) => /\.(mjs|tsx|mts)$/.test(f));
const inTestAll = reachableFromTestAll();

/** An assertion SITE — the helpers every suite here uses. */
const ASSERT = /(?:^|[^\w.])(?:check|ok|assertOk)\s*\(/;
const EXIT = /(?:^|[^\w.])process\.exit\s*\(/;

/** Analyse one file: where the verdict is taken, and which assertions sit after it. */
function analyse(f) {
  const lines = readFileSync(f, "utf8").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, ""));
  const exits = lines.map((l, i) => (EXIT.test(l) ? i : -1)).filter((i) => i >= 0);
  const asserts = lines.map((l, i) => (ASSERT.test(l) ? i : -1)).filter((i) => i >= 0);
  const lastExit = exits.length ? exits[exits.length - 1] : null;
  const after = lastExit === null ? [] : asserts.filter((i) => i > lastExit);
  return { file: f, asserts, lastExit, after, hasExit: exits.length > 0 };
}

const scanned = files.map(analyse).filter((a) => a.asserts.length > 0);
const suites = scanned.filter((a) => inTestAll.has(a.file));
const tools = scanned.filter((a) => !inTestAll.has(a.file));

const suiteUnreachable = suites.filter((a) => a.after.length > 0);
const suiteNoExit = suites.filter((a) => !a.hasExit);
const toolUnreachable = tools.filter((a) => a.after.length > 0);
const totalSites = scanned.reduce((n, a) => n + a.asserts.length, 0);
const suiteSites = suites.reduce((n, a) => n + a.asserts.length, 0);
const unreachableSites = suiteUnreachable.reduce((n, a) => n + a.after.length, 0);

console.log("\nverify-assertion-reachability — can every assertion actually reach the verdict?");
console.log(
  `\n     files with assertions ${scanned.length}  ·  assertion sites ${totalSites}` +
  `\n     IN test:all: ${suites.length} files · ${suiteSites} sites · reachable ${suiteSites - unreachableSites} · UNREACHABLE ${unreachableSites}` +
  `\n     NOT in test:all (spikes/tools): ${tools.length} files · of which ${toolUnreachable.length} carry assertions after their last exit`);

if (process.argv.includes("--list")) {
  for (const a of suites) {
    console.log(`     suite  ${a.file}  asserts=${a.asserts.length}  verdict@${a.lastExit === null ? "NONE" : a.lastExit + 1}  after=${a.after.length}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — ⭐⭐ THE DETECTOR IS ALIVE (0 unreachable and a broken scanner look identical)");
{
  // ⭐ THE POSITIVE CONTROL IS THE DEFECT ITSELF, RECONSTRUCTED. `verify-amount-precision` is the
  //   file this was found in; its section is now correctly placed, so the shape is rebuilt
  //   synthetically by moving the tally ABOVE the last section — the exact edit that caused it.
  //   [[a-deploy-check-needs-a-build-it-should-fail-against]]
  const real = readFileSync("scripts/verify-amount-precision.mjs", "utf8");
  const broken = real.replace(/\nif \(fail\) \{[\s\S]*?process\.exit\(1\); \}/, "") +
    '\nif (fail) { console.log("x"); process.exit(1); }\ncheck("stranded", false);\n';
  const brokenLines = broken.split("\n");
  const bExits = brokenLines.map((l, i) => (EXIT.test(l) ? i : -1)).filter((i) => i >= 0);
  const bAsserts = brokenLines.map((l, i) => (ASSERT.test(l) ? i : -1)).filter((i) => i >= 0);
  const bAfter = bAsserts.filter((i) => i > bExits[bExits.length - 1]);
  ok("⭐⭐ a synthetic suite with an assertion after its verdict IS detected",
    bAfter.length > 0, `${bAfter.length} stranded`);
  ok("⭐ …and the real file it was built from is NOT flagged — the control is disjoint",
    analyse("scripts/verify-amount-precision.mjs").after.length === 0);
  ok("the scan reaches the estate", scanned.length > 50 && totalSites > 1000, `${scanned.length} files / ${totalSites} sites`);
  ok("⭐ and it can tell suites from tools — both classes are populated",
    suites.length > 0 && tools.length > 0, `${suites.length} suites / ${tools.length} tools`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 NO ASSERTION IN test:all SITS AFTER ITS SUITE'S VERDICT");
{
  ok("⭐⭐ ZERO stranded assertions across every suite test:all runs",
    unreachableSites === 0,
    suiteUnreachable.map((a) => `${a.file}: verdict@${a.lastExit + 1}, asserts at ${a.after.map((i) => i + 1).join(",")}`).join("\n      "));

  // ⚠️ A suite with NO exit at all always returns 0 — the same defect with the verdict missing
  //    rather than misplaced.
  ok("⛔ …and every suite actually TAKES a verdict — a suite with no process.exit always returns 0",
    suiteNoExit.length === 0, suiteNoExit.map((a) => a.file).join(", "));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⚠️ THE TOOLS ARE COUNTED, NOT WAVED THROUGH");
{
  // ⭐ These are spikes and one-shot instruments: `test:spikes` runs only verify-kit-key-guard and
  //   verify-spike-index, so the exploration scripts are never a gate. Their `check()` calls PRINT
  //   findings for a human rather than gating a run, and an early `process.exit` on a precondition
  //   is the intended shape. That is a real difference in KIND, not an excuse — so it is stated,
  //   counted, and its magnitude printed rather than filtered out silently.
  //   [[filtered-read-is-not-absence]]
  ok("⭐ the tool population is measured, not excluded",
    tools.length > 0, `${tools.length} files not reachable from test:all`);
  for (const a of toolUnreachable) {
    console.log(`     · ${a.file} — ${a.after.length} assertion(s) after its last exit (line ${a.lastExit + 1})`);
  }
  ok("⭐ every one of them is a spike or a one-shot instrument, not a wired guard",
    toolUnreachable.every((a) => a.file.startsWith("scripts/spikes/")),
    toolUnreachable.filter((a) => !a.file.startsWith("scripts/spikes/")).map((a) => a.file).join(", "));

  // ⛔ HOW LONG HAVE THEY BEEN INERT? The question the 33-day blind mock taught us to ask. Answered
  //    from git rather than estimated: the date the stranded line was last written.
  for (const a of toolUnreachable.slice(0, 8)) {
    const line = a.after[0] + 1;
    let when = "unknown";
    try {
      when = execFileSync("git", ["log", "-1", "--format=%ad", "--date=short", "-L", `${line},${line}:${a.file}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0] || "unknown";
    } catch { /* a line git cannot follow reports unknown, never a guessed date */ }
    console.log(`     · ${a.file}:${line} — stranded since ${when}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
const total = pass + fail;
console.log("\n" + "─".repeat(92));
console.log(`${fail === 0 ? "✅" : "❌"} verify-assertion-reachability — ${pass}/${total} passed, ${fail} failed`);
if (fail) {
  console.log(`\n   FAILED: ${fails.join(" · ")}`);
  console.log(`\n   ⛔ An assertion after the last process.exit cannot change the exit code. Move the`);
  console.log(`      section ABOVE the tally, then confirm the suite's pass count GREW — ✅ on its own`);
  console.log(`      is not evidence, because an unreachable section prints ✅ too.`);
}
console.log("─".repeat(92) + "\n");
process.exit(fail === 0 ? 0 : 1);
