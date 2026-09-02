#!/usr/bin/env node
// verify-guard-registry.mjs — THE GATE OVER THE GUARDS THEMSELVES.
//
//   node scripts/verify-guard-registry.mjs            (also: npm run test:all)
//
// ═══ WHAT IT ASSERTS, AND WHY EACH ONE EXISTS ════════════════════════════════════════════════
//   1. every component is DECLARED — a new file must say who guards it or that it claims nothing
//   2. a `noClaims` component that GROWS a claim fails — the declaration is checked, not trusted
//   3. every named suite EXISTS and is REACHABLE from an aggregate
//   4. every suite in the repo is reachable or explicitly declared unwired, with a reason
//   5. the known-debt count may not GROW — the ratchet
//   6. every pass-through rebuild is exercised against a REAL recorded payload
//
// ⚠️ WHAT IT DOES NOT ASSERT: that a named suite renders its component NON-EMPTILY. Only rendering
// can show that, so it lives in each suite's own section 0. Reading this gate's green as proof of
// coverage would repeat the exact mistake it was written to catch.
//
// ⭐ AND IT MUST SHIP GREEN. A gate that fails on day one is species 3 — a tolerated red — which is
// the worst of the three failures this registry exists to end. Today's debt is declared and
// ratcheted, not asserted away.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { CLAIM_SURFACES, COMPONENTS, MAX_UNCOVERED, UNWIRED_OK, FILE_UNWIRED_OK, FILE_UNWIRED_TOOLS,
  ORPHAN_GUARD_DEBT, MAX_ORPHAN_GUARDS, PASSTHROUGH, DEBT_HORIZON } from "./guard-registry.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

// ── the same claim detector the sweep used, so declarations are checked against one definition ──
const CLAIM = /\b(never|always|guarante\w+|instant\w*|cannot|can't|only|nothing|no one|nobody|automatic\w*|live|real-time|realtime|verified|proven|audited|safe|secure|every|all of|we finish|we do not|you do not|your money|refund\w*|free|at no|without)\b/i;
const textNodes = (src) => {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  return [...s.matchAll(/>([^<>{}]{25,})</g)]
    .map((m) => m[1].replace(/\s+/g, " ").trim())
    .filter((t) => t.split(" ").length >= 5);
};

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  GUARD REGISTRY — who guards what, and is anyone actually running it ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — EVERY COMPONENT IS DECLARED (a new file must say who guards it)");
const onDisk = readdirSync("src/components").filter((f) => f.endsWith(".tsx")).map((f) => f.slice(0, -4));
const undeclared = onDisk.filter((c) => !COMPONENTS[c]);
const ghosts = Object.keys(COMPONENTS).filter((c) => !onDisk.includes(c));
ok("⭐ every component on disk is declared", undeclared.length === 0,
  undeclared.length ? `undeclared: ${undeclared.join(", ")}` : `${onDisk.length} declared`);
// ⚠️ BOTH DIRECTIONS. A registry naming a deleted component quietly stops guarding anything while
// still reading as coverage — the same shape as a stale copy guard pinning a heading that moved.
ok("⭐ …and no declaration points at a component that no longer exists", ghosts.length === 0,
  ghosts.length ? `ghosts: ${ghosts.join(", ")}` : "");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 A `noClaims` COMPONENT THAT GROWS A CLAIM FAILS");
const grew = [];
for (const [name, entry] of Object.entries(COMPONENTS)) {
  if (!entry.noClaims || !onDisk.includes(name)) continue;
  const claims = textNodes(readFileSync(`src/components/${name}.tsx`, "utf8")).filter((t) => CLAIM.test(t));
  if (claims.length) grew.push(`${name} (${claims.length}): "${claims[0].slice(0, 60)}…"`);
}
ok("🚨 no component declared claim-free has acquired one", grew.length === 0, grew.join(" · "));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — EVERY NAMED SUITE EXISTS AND IS REACHABLE");
// ⭐ Reachability is DERIVED from package.json, never declared twice: expand `suites` and
// `deploy:prod` transitively and see which script files actually get run.
const reachable = new Set();
const expand = (cmd, depth = 0) => {
  if (depth > 6 || !cmd) return;
  for (const m of cmd.matchAll(/npm run ([a-zA-Z:]+)/g)) expand(pkg.scripts[m[1]], depth + 1);
  for (const m of cmd.matchAll(/scripts\/[A-Za-z0-9_/-]+\.(?:mjs|tsx|mts)/g)) reachable.add(m[0]);
};
for (const s of pkg.suites ?? []) expand(pkg.scripts[s]);
expand(pkg.scripts["deploy:prod"]);

const named = [...new Set(Object.values(COMPONENTS).map((e) => e.suite).filter(Boolean))];
const missing = named.filter((s) => !existsSync(`scripts/${s}`) && !existsSync(`scripts/dd/${s}`));
ok("⭐ every named suite file exists", missing.length === 0, missing.join(", "));
const unreached = named.filter((s) => ![...reachable].some((r) => r.endsWith(`/${s}`)));
ok("⭐⭐ …and every one is REACHABLE from test:all or deploy:prod — an unwired guard is no guard",
  unreached.length === 0, unreached.join(", "));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — EVERY SUITE IN THE REPO IS RUN, OR DECLARED UNWIRED WITH A REASON");
const allScripts = Object.entries(pkg.scripts)
  .filter(([k]) => /^(test|gate):/.test(k) && k !== "test:all")
  .filter(([, v]) => /scripts\//.test(v));
// ⭐ ONE predicate for "is this script actually run", derived once and reused by BOTH directions
// below. Two copies would drift, and the copy that drifted would be the one that stopped guarding —
// silently, because it would go on printing a ✅.
const SCRIPT_FILE = /scripts\/[A-Za-z0-9_/-]+\.(?:mjs|tsx|mts)/g;
const isReached = (cmd) => [...cmd.matchAll(SCRIPT_FILE)].every((m) => reachable.has(m[0]));
const needsExemption = new Set(allScripts.filter(([, v]) => !isReached(v)).map(([k]) => k));

// ═══ 🚨 THE DENOMINATOR: FILES ON DISK, NOT package.json ENTRIES ═══════════
// ⛔ THIS SECTION USED TO ENUMERATE `pkg.scripts`. A guard FILE with no npm entry was therefore
// invisible to the check whose stated job is "no suite is invisible" — and one shipped that way on
// 2026-09-02 (scripts/lib/mutate.mjs, present and called by nothing). The verdict was green because
// the thing it missed was not in the set it counted.
//
// ⭐⭐ A VERDICT WITHOUT ITS DENOMINATOR CANNOT BE AUDITED. "no orphans" over a set that excludes
// the orphan is true and worthless. So this walks the directory, and PRINTS THE MAGNITUDES — found,
// invoked, registered, exempt, orphaned — so a reader can see what was counted, not just the answer.
const walkScripts = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? walkScripts(`${dir}/${d.name}`) : [`${dir}/${d.name}`]);
const diskFiles = walkScripts("scripts").filter((f) => /\.(mjs|tsx|mts)$/.test(f));

// ⭐ A helper is COVERED if something invoked imports it — reachability follows imports, or every
// shared module would read as an orphan and the exemption table would fill with noise.
const covered = new Set(reachable);
const queue = [...reachable];
while (queue.length) {
  const f = queue.pop();
  if (!existsSync(f)) continue;
  // ⛔ COMMENTS STRIPPED FIRST. A path MENTIONED in prose is not a path INVOKED — and this file's
  // own header names scripts/lib/mutate.mjs while not running it, which would mark it covered.
  const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // ⭐ Reachability follows IMPORTS **and SPAWNS**. verify-mutation-harness runs the harness with
  // execFileSync and a `new URL("./lib/mutate.mjs")` — an import-only walk called it an orphan while
  // a suite was running it every time. "Covered" means something invoked it, by any mechanism.
  for (const m of [
    ...src.matchAll(/from\s+"(\.[^"]+)"/g),
    ...src.matchAll(/import\(\s*"(\.[^"]+)"/g),
    ...src.matchAll(/["'`](\.\.?\/[A-Za-z0-9_./-]+\.(?:mjs|tsx|mts))["'`]/g),
  ]) {
    const dir = f.slice(0, f.lastIndexOf("/"));
    const parts = `${dir}/${m[1]}`.split("/");
    const out = [];
    for (const seg of parts) { if (seg === "." || seg === "") continue; if (seg === "..") out.pop(); else out.push(seg); }
    const resolved = out.join("/");
    if (!covered.has(resolved) && existsSync(resolved)) { covered.add(resolved); queue.push(resolved); }
  }
}
// Named by SOME npm script (reachable or not) — those are section 4's existing subject.
const npmNamed = new Set();
for (const v of Object.values(pkg.scripts)) for (const m of String(v).matchAll(SCRIPT_FILE)) npmNamed.add(m[0]);

const invokedFiles  = diskFiles.filter((f) => covered.has(f));
const registeredOnly = diskFiles.filter((f) => !covered.has(f) && npmNamed.has(f));
// ⭐ A prefix rule in FILE_UNWIRED_OK covers a whole directory; FILE_UNWIRED_TOOLS is per-file.
const exemptReason = (f) =>
  FILE_UNWIRED_TOOLS[f] ?? Object.entries(FILE_UNWIRED_OK).find(([k]) => f.startsWith(k))?.[1] ?? null;
const debtSet = new Set(ORPHAN_GUARD_DEBT);
const unaccounted   = diskFiles.filter((f) => !covered.has(f) && !npmNamed.has(f));
const exemptFiles   = unaccounted.filter((f) => exemptReason(f));
const declaredDebt  = unaccounted.filter((f) => !exemptReason(f) && debtSet.has(f));
const orphanFiles   = unaccounted.filter((f) => !exemptReason(f) && !debtSet.has(f));

console.log(`     files ${diskFiles.length}  ·  invoked ${invokedFiles.length}  ·  registered-not-invoked ${registeredOnly.length}  ·  exempt ${exemptFiles.length}  ·  declared debt ${declaredDebt.length}  ·  ORPHANED ${orphanFiles.length}`);
// ⭐⭐ THE CLASSES MUST PARTITION THE SET EXACTLY. If they do not, a file is being counted twice or
// not at all — and "not at all" is the failure this whole section exists to end.
const partition = invokedFiles.length + registeredOnly.length + exemptFiles.length + declaredDebt.length + orphanFiles.length;
ok("⭐⭐ the five classes account for EVERY file, exactly once", partition === diskFiles.length,
  `${partition} classified of ${diskFiles.length} on disk`);
ok("⭐⭐ every script FILE on disk is invoked, registered, or exempted with a reason",
  orphanFiles.length === 0,
  orphanFiles.length ? `present but called by nothing: ${orphanFiles.join(", ")}` : `${diskFiles.length} files, all accounted for`);
// 🚨 The exemption table is checked the same way the npm one is: a ghost entry covers whatever next
// takes its path, and a stale one covers a file that is now wired.
// ⛔ A PREFIX RULE CANNOT BE existsSync'd — it names a directory shape, not a file. It earns its
// keep a different way: at least one file must match it, or it is covering nothing and its next
// match will be a file nobody decided about.
const isPrefix = (k) => k.endsWith("/") || k.endsWith("-");
const prefixDead = Object.keys(FILE_UNWIRED_OK).filter((k) => isPrefix(k) && !diskFiles.some((f) => f.startsWith(k)));
ok("⭐ every PREFIX exemption still matches at least one file", prefixDead.length === 0,
  prefixDead.join(", ") || `${Object.keys(FILE_UNWIRED_OK).filter(isPrefix).length} prefix rules`);
const fileGhosts = [...Object.keys(FILE_UNWIRED_OK).filter((k) => !isPrefix(k)), ...Object.keys(FILE_UNWIRED_TOOLS)]
  .filter((f) => !existsSync(f));
ok("⭐ every per-file exemption names a file that exists", fileGhosts.length === 0,
  fileGhosts.join(", ") || `${Object.keys(FILE_UNWIRED_TOOLS).length} per-file exemptions`);
const fileStale = Object.keys(FILE_UNWIRED_TOOLS).filter((f) => existsSync(f) && (covered.has(f) || npmNamed.has(f)));
ok("⭐⭐ …and every one is ACTUALLY uninvoked", fileStale.length === 0, fileStale.join(", ") || "no stale file exemptions");
ok("  …and every file exemption carries a reason",
  [...Object.values(FILE_UNWIRED_OK), ...Object.values(FILE_UNWIRED_TOOLS)]
    .every((r) => typeof r === "string" && r.length > 30));

// ═══ 🚨 THE ORPHANED-GUARD RATCHET — declared debt, not exemption ═══════════
// ⛔ These are `verify-*` files that exist and run nowhere. An EXEMPTION says "this should not run";
// this list says "NOBODY HAS DECIDED", and spelling the second like the first is how untriaged work
// becomes permanent. Counted, printed every run, may shrink and never grow.
ok(`🚨 orphaned guard files ≤ ${MAX_ORPHAN_GUARDS}`, declaredDebt.length <= MAX_ORPHAN_GUARDS,
  `${declaredDebt.length} guard-shaped files run by nothing`);
ok("  …and every declared-debt entry still exists — a ghost hides a file that was deleted, not fixed",
  ORPHAN_GUARD_DEBT.every((f) => existsSync(f)),
  ORPHAN_GUARD_DEBT.filter((f) => !existsSync(f)).join(", ") || "all present");
ok("⭐⭐ …and every one is ACTUALLY uninvoked — a stale debt entry covers a file that IS now wired",
  ORPHAN_GUARD_DEBT.every((f) => !covered.has(f) && !npmNamed.has(f)),
  ORPHAN_GUARD_DEBT.filter((f) => covered.has(f) || npmNamed.has(f)).join(", ") || "none wired");
console.log(`\n  ⚠️ KNOWN DEBT — ${declaredDebt.length} guard-shaped file(s) that NOTHING runs:`);
for (const f of declaredDebt) console.log(`     · ${f}`);
if (declaredDebt.length < MAX_ORPHAN_GUARDS)
  console.log(`  ⭐ Below the ratchet — lower MAX_ORPHAN_GUARDS to ${declaredDebt.length} to lock the gain in.`);

const orphans = [...needsExemption].filter((k) => !UNWIRED_OK[k]);
ok("⭐⭐ no suite is invisible — every script runs somewhere or says why not",
  orphans.length === 0, orphans.length ? `unwired and undeclared: ${orphans.join(", ")}` : `${allScripts.length} scripts, ${Object.keys(UNWIRED_OK).length} declared unwired`);
// 🚨 A reason that is not written is a reason nobody can evaluate later.
ok("  …and every declared exemption carries a reason",
  Object.values(UNWIRED_OK).every((r) => typeof r === "string" && r.length > 30));

// ═══ ⭐⭐ THE OTHER DIRECTION — added 2026-08-25. §1 has checked it for components all along ═════
// An exemption is only honest while the thing it exempts is genuinely unwired. `gate:draft` sat in
// UNWIRED_OK declaring an exemption it did not need: it shares its SCRIPT FILE with gate:watch, and
// reachability is tracked per-FILE, so it was never a candidate orphan and its key never fired.
//
// 🚨 INERT IS NOT HARMLESS. Repoint gate:draft at a file of its own and the stale key would have
// exempted that new script from the orphan check WITH NOBODY DECIDING IT — a fail-open inherited by
// whatever next takes the name. Same shape as §1's ghost check: a registry entry that guards
// nothing still reads as coverage, which is the exact failure this file exists to end.
const exemptGhosts = Object.keys(UNWIRED_OK).filter((k) => !pkg.scripts?.[k]);
ok("⭐ every declared exemption names a script that exists", exemptGhosts.length === 0,
  exemptGhosts.length ? `ghosts: ${exemptGhosts.join(", ")}` : `${Object.keys(UNWIRED_OK).length} exemptions`);
const staleExempt = Object.keys(UNWIRED_OK).filter((k) => pkg.scripts?.[k] && !needsExemption.has(k));
ok("⭐⭐ …and every one is ACTUALLY unwired — a stale exemption silently covers whatever next takes its name",
  staleExempt.length === 0,
  staleExempt.length ? `declared unwired but REACHABLE: ${staleExempt.join(", ")}` : "no stale exemptions");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — 🚨 THE RATCHET: known debt may shrink, never grow");
const uncovered = Object.entries(COMPONENTS).filter(([, e]) => e.uncovered);
ok(`🚨 uncovered claim-bearing components ≤ ${MAX_UNCOVERED}`, uncovered.length <= MAX_UNCOVERED,
  `${uncovered.length} of ${onDisk.length}`);
ok("  …and every one states WHY it matters, not just that it is missing",
  uncovered.every(([, e]) => typeof e.uncovered === "string" && e.uncovered.length > 25));
// ⭐ The number is printed on EVERY run, green or not. A debt reported only when it grows is a debt
// nobody pays — the same rule as the roll-up always printing NOT RUN.
console.log(`\n  ⚠️ KNOWN DEBT — ${uncovered.length} claim-bearing component(s) no suite renders:`);
for (const [n, e] of uncovered) console.log(`     · ${n.padEnd(18)} ${e.uncovered}`);
if (uncovered.length < MAX_UNCOVERED)
  console.log(`  ⭐ Debt is BELOW the ratchet — lower MAX_UNCOVERED to ${uncovered.length} to lock the gain in.`);
// ⭐⭐ THE PULL. Printed every run, green or not — a horizon nobody sees is a horizon nobody works
// toward. ⚠️ It never fails the gate: a deadline that turns a suite red on a date is a tolerated
// red scheduled in advance.
if (uncovered.length > 0) {
  const days = Math.ceil((new Date(DEBT_HORIZON.date) - new Date()) / 86400000);
  const rate = (uncovered.length / Math.max(days, 1)).toFixed(2);
  console.log(`  ⚠️ HORIZON ${DEBT_HORIZON.date} (${DEBT_HORIZON.why}): ${days} day(s) left — ` +
    `${uncovered.length} to clear, ${rate}/day to land it. NOT a gate failure, on purpose.`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐ EVERY PASS-THROUGH IS EXERCISED AGAINST A REAL RECORDED PAYLOAD");
for (const p of PASSTHROUGH) {
  const suiteOk = existsSync(`scripts/${p.suite}`);
  const fixtureOk = existsSync(`scripts/fixtures/${p.fixture}`);
  const usesIt = suiteOk && readFileSync(`scripts/${p.suite}`, "utf8").includes(p.fixture);
  ok(`⭐ ${p.site} → ${p.suite}`, suiteOk && fixtureOk && usesIt,
    !suiteOk ? "suite missing" : !fixtureOk ? `fixture ${p.fixture} missing`
      : !usesIt ? `suite does not load ${p.fixture} — a fixture nobody reads proves nothing` : p.fixture);
}

section("7 — ⭐⭐ NON-COMPONENT CLAIM SURFACES ARE DECLARED, AND THEIR GUARDS EXIST");
// §2 cannot reach these files at all — it scans src/components only. A hand-written declaration is
// the ONLY thing standing between a claim-bearing page and no coverage, so the declaration itself
// must not be allowed to rot: the surface must exist, and so must the guard it names.
for (const [surface, e] of Object.entries(CLAIM_SURFACES)) {
  ok(`⭐ ${surface} exists`, existsSync(surface));
  ok(`⭐ …and its guard ${e.guard} exists`, existsSync(`scripts/${e.guard}`));
  ok(`⚠️ …and it declares what the guard CANNOT see`,
    Number(e.architectural) > 0 && Array.isArray(e.unguardedAnywhere),
    `${e.mechanical} pinned / ${e.architectural} not · ${e.unguardedAnywhere.length} pinned by nothing`);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
