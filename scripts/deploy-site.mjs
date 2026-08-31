// deploy-site.mjs — publish site/index.html to tikpema.xyz, with the leak proven closed FIRST.
//
//   npm run deploy:site            # DRAFT only. Prints the function count and stops.
//   npm run deploy:site -- --prod  # draft → assert 0 functions → promote. Refuses otherwise.
//
// ═══ 🚨 WHY THIS IS NOT `netlify deploy --prod --dir=site` ══════════════════════════════════════
// That exact command was run as a DRAFT on 2026-08-31 and bundled **120 functions**, including
// agent-send, user-swap-start, user-bridge-start, agent-vault-deposit, dca-create and ub-withdraw.
// They were LIVE on the draft URL at /.netlify/functions/* — agent-send answered 401 (the handler
// ran), dd-analyze answered 503 with a real policy body. On a --prod run that is the app's entire
// money-moving surface published to the marketing domain.
//
// ⚠️ AND `/api/*` RETURNED 404 ON THAT DRAFT, WHICH READ LIKE CONTAINMENT. It was not: the
// redirects had not come, so only the pretty paths were missing. The direct function paths worked.
// ⛔ Never conclude containment from the /api/* status. Count the functions.
//
// ⭐ RUNNING FROM `cd site` DID NOT HELP — that was tried, and the 120 still came. So this script
// does not rely on cwd. It STAGES the page into a directory outside the repo, where there is no
// parent netlify.toml to discover and no netlify/functions to find, and deploys from there.
//
// ═══ ⛔ WHAT THIS SCRIPT DOES NOT FIX ═══════════════════════════════════════════════════════════
// The page drifted because it lived OUTSIDE GIT — unreviewable, with no check. That is fixed: it is
// filed at site/index.html, audited claim by claim in docs/marketing-site-claim-audit.md, and
// tripwired by verify-site-claims.mjs inside test:all.
// 🚨 THE DEPLOY STAYS MANUAL. So the repo can be AHEAD of the live page and nothing here notices —
// a real state, and the one this script cannot close. `verify-site-live.mjs` is what makes it
// visible; run it after this, and periodically regardless.

import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SITE_ID = "a892e744-9dfc-45df-8cd4-8cd1b0c480b4"; // ⭐ the ID, never the name: the site was
// renamed to `tikpema274111111111111111111111111111` on 2026-08-31 and a name-keyed command broke.
const PROD = process.argv.includes("--prod");
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ── stage OUTSIDE the repo: no parent netlify.toml, no netlify/functions ────────────────────────
const stage = mkdtempSync(join(tmpdir(), "tikpema-site-"));
copyFileSync("site/index.html", join(stage, "index.html"));
const localHash = sha(readFileSync("site/index.html"));
console.log(`\n  staged   : ${stage}/index.html`);
console.log(`  sha256   : ${localHash}`);

const nf = (args) => execFileSync("npx", ["netlify", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const api = (op, data) => JSON.parse(nf(["api", op, "--data", JSON.stringify(data)]));

// ── 1. DRAFT ───────────────────────────────────────────────────────────────────────────────────
// `--no-build` is REQUIRED, not tidiness: without it the CLI auto-detected Hydrogen/Remix from the
// repo and prompted to run a build command nobody asked for.
console.log("\n  → draft deploy (--no-build, staged dir)…");
nf(["deploy", "--no-build", `--dir=${stage}`, `--site=${SITE_ID}`]);

const draft = api("listSiteDeploys", { site_id: SITE_ID, per_page: 1 })[0];
const fns = (draft.available_functions || []).length;
console.log(`  draft    : ${draft.id}  state=${draft.state}  functions=${fns}`);

// ── 2. THE GATE. An absence that decides a publish must be counted, not inferred. ───────────────
if (fns !== 0) {
  console.error(`\n⛔ ABORT — the draft bundled ${fns} functions. Containment FAILED.`);
  console.error(`   Inspect: netlify api getDeploy --data '{"deploy_id":"${draft.id}"}'`);
  console.error(`   Do NOT promote. This is the 120-function leak, and /api/* returning 404 is not`);
  console.error(`   evidence against it — check /.netlify/functions/<name> directly.`);
  process.exit(2);
}
console.log("  ✅ 0 functions — containment holds for THIS deploy");

if (!PROD) {
  console.log(`\n  DRAFT ONLY. Review ${draft.deploy_ssl_url}, then re-run with --prod.\n`);
  process.exit(0);
}

// ── 3. PROMOTE, then verify the SERVED bytes rather than trusting the CLI's success line ────────
console.log("\n  → production deploy…");
nf(["deploy", "--prod", "--no-build", `--dir=${stage}`, `--site=${SITE_ID}`]);

const served = await fetch("https://tikpema.xyz/", { headers: { "cache-control": "no-cache" } }).then((r) => r.arrayBuffer());
const servedHash = sha(Buffer.from(served));
console.log(`\n  served sha256 : ${servedHash}`);
console.log(`  local  sha256 : ${localHash}`);
if (servedHash !== localHash) {
  console.error(`\n❌ THE SERVED PAGE IS NOT THE FILE. A "deploy succeeded" line is not evidence of an effect.`);
  process.exit(1);
}
console.log(`\n✅ tikpema.xyz is serving site/index.html.\n`);
