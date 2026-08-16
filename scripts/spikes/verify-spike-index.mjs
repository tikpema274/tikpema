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

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

const README = "scripts/spikes/README.md";
const doc = readFileSync(README, "utf8");

// Helpers/tests are infrastructure, not evidence — they are not expected to have an index row.
const NOT_EVIDENCE = new Set(["verify-spike-index.mjs"]);

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

// ── the same rule binds the smoke scripts, which are live tooling rather than evidence ──────────
// ⚠️ THEY ARE CHECKED HERE ON PURPOSE. They were the last two prod-Netlify consumers, and a guard
// scoped only to scripts/spikes/ would report "clean" while the dependency it exists to prevent
// lived one directory up — a filtered read presented as a measurement of absence.
const SMOKE = ["scripts/smoke-analystb.mjs", "scripts/smoke-swap-estimate.mjs"];
const smokeBad = SMOKE.filter((f) => /env:get KIT_KEY/.test(readFileSync(f, "utf8")));
check("🚨🚨 no smoke script sources KIT_KEY from Netlify production", smokeBad.length === 0,
  smokeBad.length ? smokeBad.join(", ") : `${SMOKE.length} clean`);
check("⭐ …and both route their key through the shared guard",
  SMOKE.every((f) => /requireKitKey\(\)/.test(readFileSync(f, "utf8"))));

// ═══ IMPORT RESOLUTION ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ WHY THIS LIVES HERE: 12 of 22 spikes sat with unresolvable imports — dead on load — and nobody
// noticed for weeks. `spike-phase0.mjs` was found broken *by accident* during the shared/dd move, not
// by a guard, and PROGRESS.md:1801 records it being left alone as "not this commit's business". Two
// positional causes (scripts/dd → shared/dd, and one directory level from the move into spikes/),
// neither of which any suite could see, because nothing in test:all loads a spike.
//
// ⚠️ RESOLUTION, NOT EXECUTION. These are money-path scripts; one of them broadcasts a real approve.
// Import specifiers are resolved against the filesystem and NOTHING IS RUN — a spike must never be
// executed to find out whether it still works.

/** Broken relative/bare specifiers in `src`, as if it lived at `file`. Pure — no execution. */
function brokenImports(src, file) {
  const specs = [...new Set([
    ...src.matchAll(/^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm),
    // ⚠️ Dynamic imports count: step3 pulls shared/dd via `await import(...)` inside its Part B
    // branch, so a static-only scan would have declared that file clean while it was broken.
    ...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]))];

  const out = [];
  for (const s of specs) {
    if (s.startsWith("node:")) continue;
    if (s.startsWith(".")) {
      if (!existsSync(resolve(dirname(file), s))) out.push(s);
    } else if (existsSync("node_modules")) {
      // ⚠️ Only assert on packages when node_modules EXISTS. On a fresh clone every bare specifier
      // would "fail", turning a missing install into 20 fake defects and training the reader to
      // ignore this check.
      const parts = s.split("/");
      const pkg = s.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
      if (!existsSync(join("node_modules", pkg))) out.push(`${s} (package)`);
    }
  }
  return out;
}

// ── 🚨 SELF-CHECK FIRST: prove the scanner can SEE a break ───────────────────────────────────────
// A resolution pass that parses nothing reports "0 broken" and looks identical to a healthy repo.
// That is the vacuous-green family this repo has hit before (step5a's spy counted 0 for every call).
// So the instrument is verified against a known-bad and a known-good input before it is trusted.
const PROBE = "scripts/spikes/__probe.mjs";
const bad = brokenImports('import { x } from "./definitely-not-here.mjs";\nawait import("../also-missing.mjs");', PROBE);
check("🚨 the scanner DETECTS broken imports (static + dynamic) before we trust a green result",
  bad.length === 2, bad.join(", ") || "detected nothing — the check below would be vacuous");
const good = brokenImports('import { requireKitKey } from "../_kit-key.mjs";\nimport { readFileSync } from "node:fs";', PROBE);
check("⚠️ …and does not cry wolf on a resolvable relative import or a node: builtin",
  good.length === 0, good.join(", "));

// ── the real scan ────────────────────────────────────────────────────────────────────────────────
// Smoke scripts included for the same reason the credential rule covers them: a guard scoped to
// scripts/spikes/ alone would report clean while a neighbour rotted.
const ALL = [...files.map((f) => `scripts/spikes/${f}`), ...SMOKE];
const dead = ALL.map((f) => [f, brokenImports(readFileSync(f, "utf8"), f)]).filter(([, b]) => b.length);
check("⭐⭐ every spike and smoke script resolves all its imports", dead.length === 0,
  dead.length ? dead.map(([f, b]) => `${f} → ${b.join(", ")}`).join(" · ") : `${ALL.length} files clean`);

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
