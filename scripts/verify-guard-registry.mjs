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
import { COMPONENTS, MAX_UNCOVERED, UNWIRED_OK, PASSTHROUGH, DEBT_HORIZON } from "./guard-registry.mjs";

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
const orphans = allScripts
  .filter(([k, v]) => !UNWIRED_OK[k] &&
    ![...v.matchAll(/scripts\/[A-Za-z0-9_/-]+\.(?:mjs|tsx|mts)/g)].every((m) => reachable.has(m[0])))
  .map(([k]) => k);
ok("⭐⭐ no suite is invisible — every script runs somewhere or says why not",
  orphans.length === 0, orphans.length ? `unwired and undeclared: ${orphans.join(", ")}` : `${allScripts.length} scripts, ${Object.keys(UNWIRED_OK).length} declared unwired`);
// 🚨 A reason that is not written is a reason nobody can evaluate later.
ok("  …and every declared exemption carries a reason",
  Object.values(UNWIRED_OK).every((r) => typeof r === "string" && r.length > 30));

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

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
