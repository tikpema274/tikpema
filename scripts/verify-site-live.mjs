// verify-site-live.mjs — is tikpema.xyz serving the files in this repo? Read-only: one GET per manifest
// file + two platform reads. The manifest is siteFiles() (scripts/lib/marketing-site.mjs), the SAME list
// deploy-site.mjs publishes — since 2026-10-02 that is site/index.html AND site/evidence/**.
//
//   npm run gate:sitelive
//
// ═══ ⭐⭐ THE STATE THIS EXISTS TO MAKE VISIBLE: REPO AHEAD OF LIVE ══════════════════════════════
// The page no longer drifts the way it did — it is in git, audited claim by claim, and tripwired by
// verify-site-claims.mjs. ⛔ But the DEPLOY IS MANUAL. Nothing publishes on merge, so a correct,
// reviewed, green page can sit in `main` for a month while tikpema.xyz serves something older, and
// every offline check stays green the whole time. That is a REAL state, not a hypothetical: the
// live page was 66 days stale when it was audited, and every claim in the repo was fine.
//
// ⭐ THE DRIFT IS DIRECTIONAL, AND THE DIRECTION IS THE FINDING:
//   · repo == live   → shipped
//   · repo AHEAD     → an unpublished change. Expected right after a merge; a defect if it persists.
//   · live AHEAD     → 🚨 someone drag-and-dropped. The repo is no longer the source of truth, and
//                      the UI path that caused the original 66-day drift is back in use.
// A single "they differ" verdict would collapse those into one line and lose the second, which is
// the one that means the process has been bypassed.
//
// ═══ ⚠️ WHY THIS IS NOT IN test:all ═════════════════════════════════════════════════════════════
// It needs the network. A flaky network inside a BLOCKING aggregate manufactures tolerated red —
// the same reasoning that keeps gate:pins, gate:disclosure and gate:custody out. It is declared in
// UNWIRED_OK with that reason. ⭐ Its offline half IS in test:all (verify-site-claims), so splitting
// it out cannot become dropping it.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
// ⭐ ONE copy of the site identity AND the manifest, shared with deploy-site.mjs — the deployer and the
// verifier must not be able to disagree about which site, or which files.
import { SITE_ID, SITE_DOMAIN, SITE_DIR, PLATFORM_FILES, siteFiles, servedUrl } from "./lib/marketing-site.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const sha1 = (b) => createHash("sha1").update(b).digest("hex");
const files = siteFiles();

// ═══ ⭐⭐ TWO INSTRUMENTS PER FILE ═══════════════════════════════════════════════════════════════
// (1) SERVED: what a visitor receives at the file's URL. (2) PUBLISHED: what the platform says the
// published deploy holds (listSiteFiles → sha1 per path). They come apart: on 2026-09-01 three deploys
// uploaded and left published_deploy on a June deploy, every one exiting 0. A byte match on (1) alone does
// not establish a publish; (2) alone does not establish what a visitor gets. ⛔ An unreadable answer is
// UNKNOWN, never "fine". [[repeating-one-instrument-is-not-corroboration]] · [[absence-must-never-read-as-safe]]
const platform = (op, data) => JSON.parse(execFileSync("npx", ["netlify", "api", op, "--data", JSON.stringify(data)],
  { encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));

function publishedDeploy() {
  try {
    const site = platform("getSite", { site_id: SITE_ID });
    return { ok: true, deploy: site?.published_deploy ?? null };
  } catch (e) { return { ok: false, err: String(e?.message ?? e).split("\n")[0] }; }
}
/** The published deploy's own files: Map "/path" → sha1. ⛔ Unreadable → ok:false, never an empty map. */
function publishedFiles(deployId) {
  try {
    const list = platform("listSiteFiles", { site_id: SITE_ID });
    if (!Array.isArray(list)) return { ok: false, err: "listSiteFiles returned no list" };
    const mine = list.filter((f) => !deployId || f.deploy_id === deployId);
    return { ok: true, files: new Map(mine.map((f) => [f.path, f.sha])) };
  } catch (e) { return { ok: false, err: String(e?.message ?? e).split("\n")[0] }; }
}

// ═══ ⭐⭐ THE DIRECTION IS A CONTENT QUESTION, NOT A TIMESTAMP QUESTION ══════════════════════════
// This used to compare `git log -1 --format=%aI -- site/index.html` against published_at. That is a
// proxy, and it BREAKS in the single most ordinary workflow there is: edit the page, run the gate,
// then deploy. An uncommitted edit changes the local BYTES while leaving the last-commit DATE
// stale, so the file looks older than the deploy and the check printed "LIVE IS AHEAD … someone
// drag-and-dropped" with nothing drag-and-dropped. MEASURED 2026-09-01. ⭐ So ask the question
// directly, per file: were the served bytes ever in this repo's history?
// [[probe-must-discriminate-between-states]] · [[git-history-needs-a-reachability-query]]

/** Is site/<rel> modified relative to HEAD? deploy-site.mjs publishes the WORKING TREE, so a dirty file
 *  means bytes about to go live are in no commit and were reviewed by nobody. */
function worktreeDirty(rel) {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", join(SITE_DIR, rel)], { encoding: "utf8" });
    return { ok: true, dirty: out.trim() !== "" };
  } catch (e) { return { ok: false, err: String(e?.message ?? e).split("\n")[0] }; }
}

/** The commit whose site/<rel> hashes to `hash`. null = never in git (the drag-and-drop signature).
 *  ⛔ An unreadable history returns ok:false and must NOT collapse into "never committed". */
function servedProvenance(rel, hash) {
  const path = join(SITE_DIR, rel);
  try {
    const shas = execFileSync("git", ["log", "--format=%H", "--", path], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    if (shas.length === 0) return { ok: true, commit: null, scanned: 0 };
    for (const c of shas) {
      let blob;
      try { blob = execFileSync("git", ["show", `${c}:${path}`], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
      catch { continue; }
      if (sha(blob) === hash) {
        return { ok: true, commit: execFileSync("git", ["log", "-1", "--format=%h %ad %s", "--date=short", c], { encoding: "utf8" }).trim(), scanned: shas.length };
      }
    }
    return { ok: true, commit: null, scanned: shas.length };
  } catch (e) { return { ok: false, err: String(e?.message ?? e).split("\n")[0] }; }
}

const pub = publishedDeploy();
console.log(`\nIS ${SITE_DOMAIN} SERVING THIS REPO'S ${files.length} FILES?`);
if (pub.ok) console.log(`  published_deploy : ${pub.deploy?.id ?? "(NONE)"}  state=${pub.deploy?.state ?? "-"}  at=${pub.deploy?.published_at ?? "-"}`);
else console.log(`  published_deploy : UNREADABLE — ${pub.err}`);

// ── ⛔ NO PUBLISHED DEPLOY AT ALL is a failure even if bytes happen to match. ─────────────────────
if (pub.ok && !pub.deploy?.id) { console.error(`\n❌ THE SITE HAS NO PUBLISHED DEPLOY. Whatever is being served, nothing was published.`); process.exit(1); }
if (pub.ok && pub.deploy.state !== "ready") { console.error(`\n❌ published_deploy ${pub.deploy.id} is state=${pub.deploy.state}, not "ready".`); process.exit(1); }
const pf = pub.ok ? publishedFiles(pub.deploy.id) : { ok: false, err: "no published deploy pointer" };
if (!pf.ok) console.log(`  published files  : UNREADABLE — ${pf.err}`);

let failed = 0, unknown = 0;
const rows = [];
for (const rel of files) {
  const buf = readFileSync(join(SITE_DIR, rel));
  const L = { sha: sha(buf), sha1: sha1(buf) };
  let served = null, status = null;
  try {
    const r = await fetch(servedUrl(rel), { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    status = r.status;
    if (r.ok) served = sha(Buffer.from(await r.arrayBuffer()));
  } catch (e) { status = String(e?.message ?? e); }
  const pubSha1 = pf.ok ? (pf.files.get(`/${rel}`) ?? "absent") : null;
  const servedOk = served === L.sha;
  const pubOk = pubSha1 === L.sha1;
  let verdict;
  if (served === null && status !== 404) { verdict = "UNKNOWN"; unknown++; }
  else if (pubSha1 === null) { verdict = servedOk ? "UNKNOWN" : "DIFFERS"; servedOk ? unknown++ : failed++; }
  else if (servedOk && pubOk) verdict = "IN SYNC";
  else if (servedOk && !pubOk) { verdict = "SERVED ≠ PUBLISHED"; failed++; }
  else { verdict = status === 404 && pubSha1 === "absent" ? "NOT PUBLISHED" : "DIFFERS"; failed++; }
  rows.push({ rel, L, served, status, pubSha1, verdict });
  console.log(`  ${verdict === "IN SYNC" ? "✅" : verdict === "UNKNOWN" ? "✖" : "❌"} ${verdict.padEnd(18)} ${rel}`);
}

// ── files the published deploy holds that the manifest does not ────────────────────────────────
if (pf.ok) {
  for (const [path] of pf.files) {
    const rel = path.replace(/^\//, "");
    if (files.includes(rel)) continue;
    if (PLATFORM_FILES[rel]) { console.log(`  ·  platform file      ${rel} — ${PLATFORM_FILES[rel]}`); continue; }
    failed++;
    console.log(`  ❌ LIVE, NOT IN REPO  ${rel} — the published deploy holds a file this repo does not publish`);
  }
}

// ── per differing file: WHICH WAY, because the two directions mean opposite things ──────────────
for (const r of rows.filter((x) => x.verdict === "DIFFERS")) {
  console.log(`\n  ── ${r.rel}`);
  console.log(`     local ${r.L.sha}  served ${r.served ?? `HTTP ${r.status}`}`);
  if (r.served) {
    const prov = servedProvenance(r.rel, r.served);
    if (!prov.ok) console.log(`     ⚠️ DIRECTION UNDETERMINED — could not read history: ${prov.err}. Do not assume "repo ahead".`);
    else if (prov.commit) console.log(`     ⭐ REPO IS AHEAD — live is this repo's own ${prov.commit}. A reviewed change was never published.`);
    else console.log(`     🚨 LIVE IS AHEAD — the served bytes match none of the ${prov.scanned} committed version(s). Someone drag-and-dropped. Capture the live bytes into docs/baselines/ BEFORE overwriting them.`);
  }
  const d = worktreeDirty(r.rel);
  if (d.ok && d.dirty) console.log(`     ⚠️ AND it has UNCOMMITTED changes: deploy-site.mjs publishes the working tree, so these bytes are in no commit. Commit first.`);
  else if (!d.ok) console.log(`     ⚠️ could not determine whether it is dirty — ${d.err}`);
}
for (const r of rows.filter((x) => x.verdict === "NOT PUBLISHED")) {
  console.log(`\n  ── ${r.rel}: in the repo, not on the site (404, absent from the published deploy). A file added and never deployed.`);
}

if (failed) {
  console.log(`\n❌ ${failed} file(s) are not what the repo holds.${unknown ? ` ${unknown} more could not be read.` : ""}`);
  console.log(`   To publish: npm run deploy:site:prod   (in a terminal — --prod refuses non-interactively)\n`);
  process.exit(1);
}
if (unknown) { console.error(`\n✖ ${unknown} file(s) could not be read. VERDICT: UNKNOWN — not evidence of sync, not evidence of drift.\n`); process.exit(2); }
console.log(`\n✅ IN SYNC — all ${files.length} files are served as the repo holds them, and the published deploy holds them.\n`);
process.exit(0);
