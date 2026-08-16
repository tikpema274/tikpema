// verify-spike-index.mjs — every spike must appear in README.md, and every README row must exist.
//
// ⭐⭐ WHY: the step-8 spikes (8a/8b/8c/8d) sat UNINDEXED while the reversal code they evidence was
// already live. That is `absence-must-never-read-as-safe` aimed at the index itself — a reader of a
// complete-looking table concludes the missing scripts are not provenance, and live money-path work
// quietly loses its recorded proof. Nobody noticed for weeks because nothing checked.
//
// ⚠️ IT CHECKS BOTH DIRECTIONS. A one-way check ("every row has a file") would have stayed green
// through the exact failure it is meant to catch — the same one-directional blind spot `gate:routes`
// had. The reverse direction ("every file has a row") is the one that was actually broken.
//
//   node scripts/spikes/verify-spike-index.mjs

import { readdirSync, readFileSync } from "node:fs";

const README = "scripts/spikes/README.md";
const doc = readFileSync(README, "utf8");

// Helpers/tests are infrastructure, not evidence — they are not expected to have an index row.
const NOT_EVIDENCE = new Set(["_kit-key.mjs", "verify-kit-key-guard.mjs", "verify-spike-index.mjs"]);

const files = readdirSync("scripts/spikes")
  .filter((f) => f.endsWith(".mjs") && !NOT_EVIDENCE.has(f));

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };

console.log(`\nverify-spike-index — ${files.length} evidence scripts vs ${README}\n`);

// ── direction 1: every spike file is named in the README ────────────────────────────────────────
const unindexed = files.filter((f) => !doc.includes(f));
check("⭐⭐ every spike is named in the index", unindexed.length === 0,
  unindexed.length ? `MISSING: ${unindexed.join(", ")}` : `all ${files.length}`);

// ── direction 2: every README-named spike still exists on disk ──────────────────────────────────
const named = [...new Set([...doc.matchAll(/`?(spike-[a-zA-Z0-9._-]+\.mjs)`?/g)].map((m) => m[1]))];
const orphaned = named.filter((n) => !files.includes(n));
check("⚠️ every spike named in the index still exists", orphaned.length === 0,
  orphaned.length ? `ORPHANED ROWS: ${orphaned.join(", ")}` : `all ${named.length}`);

// ── the money marking is present for each, since that is what a reader acts on ──────────────────
check("⭐ the index still declares a money column for its evidence tables",
  /Moves money\?/.test(doc));

// ── 🚨 the credential rule must not regress into the index ──────────────────────────────────────
check("🚨 the index never tells anyone to pull KIT_KEY from Netlify production",
  !/env:get KIT_KEY/.test(doc));
check("⭐ …and it teaches the history-safe recipe instead",
  /read -rs KIT_KEY/.test(doc));

// ── and no spike header may re-introduce it ─────────────────────────────────────────────────────
const offenders = files.filter((f) => /env:get KIT_KEY/.test(readFileSync(`scripts/spikes/${f}`, "utf8")));
check("🚨🚨 no spike sources KIT_KEY from Netlify production", offenders.length === 0,
  offenders.length ? offenders.join(", ") : `${files.length} clean`);

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
