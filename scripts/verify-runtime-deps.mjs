#!/usr/bin/env node
// verify-runtime-deps.mjs — EVERY PACKAGE IMPORTED AT RUNTIME IS IN `dependencies`.
//
//   node scripts/verify-runtime-deps.mjs      (also: npm run gate:deps)
//
// ═══ 🚨 THE TWO DEFECTS THIS PINS, BOTH FOUND 2026-08-28 ═══════════════════════════════════════
//
// 1. `@circle-fin/developer-controlled-wallets` sat in **devDependencies** while `_circle.mjs:1`
//    imports it at runtime — on EVERY money path. It worked only because Netlify's build installs
//    devDeps and bundles them; `npm ci --omit=dev`, or any production-install path, would have
//    broken signing entirely.
//
// 2. ⭐⭐ WORSE: `@circle-fin/adapter-viem-v2` was imported by `_swap.mjs:3` and declared
//    **NOWHERE**. It resolved only because `@circle-fin/adapter-circle-wallets` happens to depend
//    on it. A version bump of that package — one we do not control and did not ask about — could
//    drop or move it, and the swap path breaks with NOTHING in this repo having changed.
//
// ⛔ NEITHER FAILS AT BUILD TIME, WHICH IS WHY NEITHER WAS NOTICED. The bundler resolves whatever
// is on disk; `node_modules` does not care which stanza a name appears in. The declaration is the
// only place the intent is recorded, and an undeclared dependency is a dependency on luck.
//
// ⚠️ THE MATCHER SKIPS COMMENTS, DELIBERATELY. A first pass over these files reported `reverted`
// and `starting` as undeclared packages — both were prose inside comments (`distinguish "slow"
// from "reverted"`). A guard that cries wolf gets muted, so the false positives are excluded here
// rather than tolerated in the output.

import { readFileSync, readdirSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = pkg.dependencies || {};
const devDeps = pkg.devDependencies || {};

// Directories whose imports run in PRODUCTION. `scripts/` is excluded on purpose: it is tooling,
// and its imports legitimately live in devDependencies.
const RUNTIME_DIRS = ["netlify/functions", "shared", "src"];

const walk = (dir, acc = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!/node_modules/.test(p)) walk(p, acc); }
    else if (/\.(mjs|js|ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
};

/** Strip block and line comments so prose cannot masquerade as an import. */
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const found = new Map();   // package → first file that imports it
for (const dir of RUNTIME_DIRS) {
  for (const f of walk(dir)) {
    const src = decomment(readFileSync(f, "utf8"));
    const rx = /(?:^|\s)(?:import\s[^;]*?from\s*|import\s*|(?:await\s+)?import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
    for (const m of src.matchAll(rx)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!found.has(name)) found.set(name, f);
    }
  }
}

let bad = 0;
const line = (ok, msg, detail = "") => { console.log(`  ${ok ? "✅" : "❌"} ${msg}${detail ? `  — ${detail}` : ""}`); if (!ok) bad++; };

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  RUNTIME DEPENDENCIES — declared, not merely present                ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");
console.log(`  scanned ${RUNTIME_DIRS.join(", ")} — ${found.size} distinct package import(s)\n`);

for (const [name, file] of [...found].sort()) {
  if (deps[name]) { console.log(`  ✅ ${name.padEnd(44)} dependencies ${deps[name]}`); continue; }
  if (devDeps[name]) line(false, `🚨 ${name} is in devDependencies but imported at RUNTIME`, `${file} — breaks under \`npm ci --omit=dev\``);
  else line(false, `⛔ ${name} is imported at runtime and DECLARED NOWHERE`, `${file} — resolves only by luck via a transitive install`);
}

console.log(`\n${"═".repeat(72)}`);
if (bad) { console.log(`❌ ${bad} misdeclared runtime dependency(ies).\n`); process.exit(1); }
console.log(`✅ ALL GREEN   every runtime import is in \`dependencies\`\n`);
