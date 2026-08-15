#!/usr/bin/env node
// stamp-build.mjs — bake provenance INTO the deployed artifact.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════
// Netlify records `commit_ref: null`, `build_id: null` and `commit_message: null` on every CLI
// deploy (`deploy_source: "cli"`, no build runs). Verified against the API on 2026-07-29 for
// every deploy made that day. So the platform CANNOT tell you which commit is serving prod, and
// on 2026-07-29 that gap hid a promotion that never landed: a hotfix build served for 7.5 hours
// while the repo, the suites and the handoff all said Option D was live.
//
// `netlify deploy --dir=dist` ships the WORKING TREE, not a commit. So a commit SHA alone is not
// enough either — it describes what you meant to deploy, not what you did. Three fields together:
//
//   commit  — HEAD at stamp time. What you meant to ship.
//   dirty   — did the deployed surface have uncommitted edits? If true, `commit` is a LABEL and
//             not an identity, and nothing may be concluded from it alone.
//   tree    — sha256 over the actual bytes of everything deployable. THIS is the identity. It can
//             be recomputed at any commit and compared, which is the only real binding available.
//
// ⭐ THE COMMITTED VALUE OF THE GENERATED FILE MUST STAY `null`. A deploy that skipped stamping
// then self-reports UNRESOLVED rather than a stale, confident, wrong SHA. That is the same rule
// as resolveBuildId in shared/dd-canary/health.mjs: never return a placeholder on failed
// resolution, because any constant compares equal to itself and re-opens the exact fail-open the
// version binding was built to close. `scripts/verify-blobs-probe.mjs` asserts it.
//
// Restore it after deploying:  node scripts/stamp-build.mjs --clear

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "shared", "build-stamp.generated.mjs");

/**
 * Everything Netlify actually deploys — server functions AND the client the browser runs.
 *
 * ⚠️ `dist/` is excluded on purpose: it is a build OUTPUT, so hashing it would make the stamp
 * depend on the build it is stamping. `src/` is that output's INPUT and is stamped in `prebuild`,
 * before vite runs, so hashing it is stable and non-circular.
 *
 * ═══ 🚨 WHY `src` WAS ADDED (2026-08-15) ═════════════════════════════════════════════════════
 * The tree hash is documented as THE IDENTITY of a deployed artifact, and `verify-deployed`
 * compares it to decide whether production is serving the build in hand. With only the two server
 * surfaces, a commit touching ONLY `src/` produced a byte-identical tree — so two consecutive
 * production deploys (`0d16bfc`, `dd16f23`) both reported "production serves THIS tree" against a
 * hash that could not have distinguished them. ⭐⭐ THE CHECK PASSED WITHOUT EXAMINING THE THING
 * THAT CHANGED: the client bundle. Only the COMMIT check verified those deploys, and the commit is
 * explicitly documented here as provenance rather than identity.
 *
 * ⚠️ A hash that cannot see the change under test is not a weaker check, it is a check that reports
 * on something else entirely — and it reported PASS both times.
 *
 * ⭐ `ddTree` is UNAFFECTED: it is filtered out of this same walk by DD_SURFACE_DIRS/FILES, none of
 * which match `src/`, so the DD health identity keeps its exact meaning. Verified, not assumed.
 */
const SURFACES = ["netlify/functions", "shared", "src"];

/** Excluded from BOTH the tree hash and the dirty check — hashing the stamp into itself is
 *  circular, and its own regeneration is not source drift. */
const SELF = "shared/build-stamp.generated.mjs";

// ═══ ⭐⭐ THE DD SURFACE — what the canary's verdict actually vouches for ════════════════════════
//
// `ddTree` is the health artifact's IDENTITY. It replaces the deploy id, which was a bad proxy for
// "this code": a deploy id changes on EVERY deploy, including a redeploy of byte-identical code
// (measured 2026-08-11 — tree 931f6666… shipped twice under two different deploy ids).
//
// 🚨 MEASURED OVER THE LAST 40 COMMITS: 20 touched the stamped surface, only 2 touched DD, and
// **18 were stamp-dirty but DD-CLEAN**. Under deploy-id binding every one of those 18 caused a DD
// refusal window — a public outage on bridge/research/agent deploys that changed no DD code and
// about which the canary's verdict says nothing.
//
// ⭐ CONTENT HASHING ABSORBS DIRTINESS FOR FREE. This hashes BYTES ON DISK, not git state, so an
// uncommitted DD edit produces its own key and earns its own canary run. No special dirty handling,
// and no friction when proving a DD change on a draft.
//
// ⚠️ SCOPE IS DELIBERATELY CONSERVATIVE — it includes `_blobs.mjs`/`_arc.mjs` because dd-canary
// IMPORTS them, so they can change what the canary observes. Widening the scope only ever costs an
// extra (correct) re-verification; narrowing it risks vouching across a change that mattered. When
// unsure, add the file.
//
// 🚨 ADD A ROW HERE WHENEVER THE CANARY GAINS AN IMPORT, or the binding silently stops covering it.
// ⭐⭐ `shared/dd` ADDED 2026-08-16 — AND THE MOVE ALONE WOULD NOT HAVE BEEN ENOUGH.
//
// 🚨 `dd-analyze` imported `chainClient` and `ddAttestationOptions` from `scripts/dd/`, pulling
// `client/chains/rpc/attest-circle` into the deployed bundle. `scripts/` is in NEITHER `SURFACES`
// nor here, so a change to any of them produced an identical `tree`, an identical `ddTree`, AND no
// dirty flag — invisible in all three channels at once. ⚠️ Including `attest-circle.mjs`: the code
// that SIGNS the attestation sat outside the hash whose whole job is to say which code produced it.
//
// ⭐ RELOCATING TO `shared/` FIXES ONLY HALF. `shared/` is inside SURFACES, so the move repairs the
// `tree` hash — but `ddTree` is filtered by THESE dirs, and `shared/` root files match none of them.
// Without this row the health key still would not rotate on an attestation-signing change, and the
// binding would look fixed while remaining open. Two gaps, closed deliberately, not as a side effect.
//
// ⚠️ The rule two paragraphs down already said this: "ADD A ROW HERE WHENEVER THE CANARY GAINS AN
// IMPORT." The import arrived through dd-analyze rather than dd-canary, and the row was never added.
const DD_SURFACE_DIRS = ["shared/onchain-analyze", "shared/onchain-facts", "shared/dd-canary", "shared/dd"];
const DD_SURFACE_FILES = [
  "netlify/functions/dd-analyze.mjs",
  "netlify/functions/dd-canary.mjs",
  "netlify/functions/_dd-health.mjs",
  "netlify/functions/_dd-x402.mjs",
  "netlify/functions/_dd-exposure.mjs",
  "netlify/functions/_blobs.mjs",  // dd-canary imports it — it decides whether the store is readable
  "netlify/functions/_arc.mjs",    // dd-canary imports it
];

const HEADER = `// GENERATED by scripts/stamp-build.mjs — DO NOT EDIT, DO NOT COMMIT A NON-NULL VALUE.
//
// Committed state is \`null\` on purpose: a deploy that skipped stamping must self-report
// UNRESOLVED, never a stale SHA. \`npm run build\` regenerates this; \`npm run stamp:clear\`
// restores the null. See scripts/stamp-build.mjs for the full reasoning.
`;

const emit = (value) =>
  `${HEADER}\nexport const RAW_BUILD_STAMP = ${value === null ? "null" : JSON.stringify(value, null, 2)};\n`;

if (process.argv.includes("--clear")) {
  writeFileSync(OUT, emit(null), "utf8");
  console.log("build stamp CLEARED -> null (unresolved)");
  process.exit(0);
}

const gitRaw = (args) => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null; // not a repo, or git unavailable — resolves to null, never a placeholder
  }
};

const git = (args) => {
  const out = gitRaw(args);
  return out === null ? null : out.trim();
};

const walk = (dir, acc = []) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
};

// Content hash of every deployable byte, path-sensitive and order-independent.
// A rename changes it; a whitespace edit changes it; regenerating this file does not.
const files = SURFACES.flatMap((s) => walk(join(ROOT, s)))
  .map((f) => relative(ROOT, f).split("\\").join("/"))
  .filter((p) => p !== SELF)
  .sort();

const tree = createHash("sha256");
for (const p of files) {
  tree.update(p, "utf8");
  tree.update("\0", "utf8");
  tree.update(createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex"), "utf8");
  tree.update("\n", "utf8");
}

// ⭐ THE DD IDENTITY. Same construction as `tree` (path + content, order-independent) but scoped to
// the DD surface, and computed from the SAME `files` walk so a file cannot be in one and not the
// other. A MISSING file is not skipped silently — it makes ddTree null, i.e. UNBOUND, because a
// surface we cannot fully read is one we cannot claim to have hashed.
const ddPaths = files.filter(
  (p) => DD_SURFACE_DIRS.some((d) => p.startsWith(`${d}/`)) || DD_SURFACE_FILES.includes(p)
);
const missingDd = DD_SURFACE_FILES.filter((f) => !files.includes(f));
let ddTree = null;
if (missingDd.length === 0 && ddPaths.length > 0) {
  const dd = createHash("sha256");
  for (const p of ddPaths) {
    dd.update(p, "utf8");
    dd.update("\0", "utf8");
    dd.update(createHash("sha256").update(readFileSync(join(ROOT, p))).digest("hex"), "utf8");
    dd.update("\n", "utf8");
  }
  ddTree = dd.digest("hex");
}

const commit = git(["rev-parse", "HEAD"]);

// Dirty is scoped to the DEPLOYED SURFACE and ignores the stamp itself. Untracked scratch files
// elsewhere in the tree are not deploy drift and must not raise a false alarm — a dirty flag that
// cries wolf is a dirty flag people learn to ignore.
// ⚠️ gitRaw, NOT git. Porcelain v1 lines are `XY <path>` — the status columns are POSITIONAL and
// column 1 is a space for an unstaged change. Trimming the whole blob eats that leading space on
// the FIRST line only, shifting its path by one character so the SELF comparison silently misses
// and the stamp reports itself as drift. Caught by its own output: it printed
// "hared/build-stamp.generated.mjs". A dirty flag that cries wolf is one people learn to ignore.
const porcelain = gitRaw(["status", "--porcelain", "--", ...SURFACES]);
const dirtyPaths =
  porcelain === null
    ? null
    : porcelain
        .split("\n")
        .filter((l) => l.length > 3)
        .map((l) => l.slice(3).trim())
        .filter((p) => p && p !== SELF);

const stamp = {
  commit,
  dirty: dirtyPaths === null ? null : dirtyPaths.length > 0,
  dirtyCount: dirtyPaths === null ? null : dirtyPaths.length,
  tree: tree.digest("hex"),
  // ⭐ The health artifact's identity. null = UNBOUND, never a placeholder — see health.mjs.
  ddTree,
  ddFileCount: ddPaths.length,
  fileCount: files.length,
  generatedAt: new Date().toISOString(),
};

writeFileSync(OUT, emit(stamp), "utf8");

console.log("build stamp written:");
console.log(`  commit     ${stamp.commit ?? "(unresolved)"}`);
console.log(`  dirty      ${stamp.dirty}${stamp.dirtyCount ? ` (${stamp.dirtyCount} path(s))` : ""}`);
console.log(`  tree       ${stamp.tree}`);
console.log(`  ddTree     ${stamp.ddTree ?? "(UNBOUND — DD health cannot bind; canary will refuse to write)"} (${stamp.ddFileCount} files)`);
if (missingDd.length) {
  console.log(`  ⚠️  DD surface INCOMPLETE — missing: ${missingDd.join(", ")}`);
  console.log("     ddTree is null on purpose: a surface we cannot fully read is one we cannot claim to have hashed.");
}
console.log(`  files      ${stamp.fileCount}`);
if (stamp.dirty) {
  console.log("\n  ⚠️  DEPLOYED SURFACE IS DIRTY — `commit` is a label, not an identity.");
  for (const p of dirtyPaths) console.log(`      ${p}`);
}
