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

// ⭐ SITE_ID / SITE_DOMAIN live in scripts/lib/marketing-site.mjs — ONE copy, with the provenance
// of the UUID and why the NAME must never be used. verify-site-live.mjs imports the same constants,
// so the deployer and the verifier can never disagree about which site they mean.
import { SITE_ID, SITE_DOMAIN } from "./lib/marketing-site.mjs";
const PROD = process.argv.includes("--prod");
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ⛔ THE TTY CHECK IS FIRST, BEFORE ANY NETWORK CALL. It was originally beside the prompt, after
// the draft — which meant a non-interactive `--prod` still uploaded a draft before refusing. The
// refusal must cost nothing: a run that cannot possibly be confirmed should not touch Netlify at
// all. [[verification-method-must-not-mutate]]
if (PROD && !process.stdin.isTTY) {
  console.error(`\n⛔ ABORT — --prod requires a terminal, and stdin is not one. Nothing was uploaded.`);
  console.error(`   Refusing to publish unattended: an unattended --prod is precisely the failure`);
  console.error(`   the confirmation exists to prevent, automated.\n`);
  process.exit(2);
}

// ── stage OUTSIDE the repo: no parent netlify.toml, no netlify/functions ────────────────────────
const stage = mkdtempSync(join(tmpdir(), "tikpema-site-"));
copyFileSync("site/index.html", join(stage, "index.html"));
const localHash = sha(readFileSync("site/index.html"));
console.log(`\n  staged   : ${stage}/index.html`);
console.log(`  sha256   : ${localHash}`);

// ⛔ `cwd: stage` IS THE CONTAINMENT. Staging the page outside the repo does NOT prevent the
// function bundle: `--dir` sets the PUBLISH directory, it does not move the CLI. Config discovery
// follows the CURRENT WORKING DIRECTORY, so an invocation from the repo root finds netlify.toml,
// reads `functions = "netlify/functions"`, and bundles all 86 regardless of --dir or --no-build.
// 🚨 MEASURED 2026-09-01: three consecutive drafts hung because of this. The CLI wrote 86 zips of
// ~22MB (agent-send, agent-execute-plan, agent-vault-withdraw, _pay, _swap …) into a 1.8GB tmpfs,
// filled it, and blocked on ENOSPC ~13 min in. Same command with cwd=stage: 0 functions, live in
// seconds. ⚠️ So the "staged outside the repo" note above was necessary but NOT sufficient.
const nf = (args) => execFileSync("npx", ["netlify", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: stage });
const api = (op, data) => JSON.parse(nf(["api", op, "--data", JSON.stringify(data)]));

// ── 1. DRAFT ───────────────────────────────────────────────────────────────────────────────────
// `--no-build` is REQUIRED, not tidiness: without it the CLI auto-detected Hydrogen/Remix from the
// repo and prompted to run a build command nobody asked for.
console.log("\n  → draft deploy (--no-build, staged dir)…");
nf(["deploy", "--no-build", `--dir=${stage}`, `--site=${SITE_ID}`]);

const draft = api("listSiteDeploys", { site_id: SITE_ID, per_page: 1 })[0];
const fns = (draft.available_functions || []).length;
console.log(`  draft    : ${draft.id}  state=${draft.state}  functions=${fns}`);

// ── 2a. ⛔ STATE FIRST — THE COUNT IS MEANINGLESS ON A DEPLOY THAT NEVER PROCESSED. ────────────
// `available_functions` is EMPTY on a deploy stuck at state=new, so `fns` reads 0 and the check
// below prints "✅ 0 functions — containment holds". The containment PROOF and the containment
// FAILURE are then the same event, which is why two hung drafts on 2026-08-31 and one on
// 2026-09-01 all read as successes. Assert the deploy exists before asserting what it contains.
// [[equality-passes-vacuously-on-empty]] · [[absence-must-never-read-as-safe]]
if (draft.state !== "ready") {
  console.error(`\n⛔ ABORT — draft ${draft.id} is state=${draft.state}, not "ready".`);
  console.error(`   NOTHING is proven about containment: available_functions is empty on a deploy`);
  console.error(`   that never processed, so the count below would read 0 and PASS.`);
  console.error(`   A hang here is usually the function bundle filling TMPDIR — check df -h /tmp.`);
  process.exit(2);
}

// ── 2b. THE GATE. An absence that decides a publish must be counted, not inferred. ──────────────
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

// ── 3. ⛔ THE CONFIRMATION. NOT OPTIONAL. ───────────────────────────────────────────────────────
// `--prod` on a site with no CI publishes instantly and irreversibly — there is no build to fail,
// no review, no staging. 137 manual deploys reached this domain with NOTHING between the gesture
// and the publish, which is the whole reason for doing it in a script. So the script puts the three
// facts a person needs on the screen — WHICH site, WHICH domain, WHICH bytes — and stops.
//
// ⚠️ A NON-TTY MUST ABORT, NOT PROCEED. Piping this into a script or a CI job would otherwise
// publish with no human at all, which is the failure the prompt exists to prevent, automated.
const { createInterface } = await import("node:readline/promises");
console.log(`\n${"═".repeat(72)}`);
console.log(`  ABOUT TO PUBLISH — this is live and immediate, with no CI in front of it.`);
console.log(`    site id : ${SITE_ID}`);
console.log(`    domain  : https://${SITE_DOMAIN}`);
console.log(`    sha256  : ${localHash}`);
console.log(`    bytes   : ${readFileSync("site/index.html").length}`);
console.log(`    replaces: ${(await fetch(`https://${SITE_DOMAIN}/`).then(r=>r.arrayBuffer()).then(b=>sha(Buffer.from(b))).catch(()=>"unreadable"))}`);
console.log(`${"═".repeat(72)}`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question(`  Type the domain to confirm (${SITE_DOMAIN}): `)).trim();
rl.close();
if (answer !== SITE_DOMAIN) {
  console.error(`\n⛔ ABORT — got ${JSON.stringify(answer)}. Nothing published.\n`);
  process.exit(2);
}

// ── 4. PROMOTE, then verify the SERVED bytes rather than trusting the CLI's success line ────────
// ⛔ READ THE PUBLISHED POINTER FIRST. "It MOVED" is only checkable against what it was.
const beforeId = api("getSite", { site_id: SITE_ID })?.published_deploy?.id ?? null;
console.log(`\n  published before : ${beforeId ?? "(none)"}`);

console.log("  → production deploy…");
nf(["deploy", "--prod", "--no-build", `--dir=${stage}`, `--site=${SITE_ID}`]);

// ── 4a. ⛔ DID IT PROMOTE, OR ONLY UPLOAD? Ask the PLATFORM, not the exit code. ─────────────────
// A deploy command can succeed and leave `published_deploy` untouched — an upload is not a
// promotion, and the CLI's success line cannot tell the two apart. So read the pointer back and
// require that it MOVED to a ready deploy. [[success-message-is-not-evidence-of-effect]]
const after = api("getSite", { site_id: SITE_ID })?.published_deploy ?? null;
console.log(`  published after  : ${after?.id ?? "(none)"}  state=${after?.state ?? "-"}`);
if (!after?.id) {
  console.error(`\n❌ NOT PROMOTED — the site has NO published deploy after a --prod run.`);
  process.exit(1);
}
if (after.id === beforeId) {
  console.error(`\n❌ NOT PROMOTED — published_deploy is STILL ${beforeId}.`);
  console.error(`   The upload succeeded and the live pointer did not move. That is a draft, not a`);
  console.error(`   publish, however the command exited.`);
  process.exit(1);
}
if (after.state !== "ready") {
  console.error(`\n❌ published_deploy moved to ${after.id} but state=${after.state}, not "ready".`);
  process.exit(1);
}
console.log(`  ✅ published_deploy MOVED ${beforeId ?? "(none)"} → ${after.id}`);

const served = await fetch(`https://${SITE_DOMAIN}/`, { headers: { "cache-control": "no-cache" } }).then((r) => r.arrayBuffer());
const servedHash = sha(Buffer.from(served));
console.log(`\n  served sha256 : ${servedHash}`);
console.log(`  local  sha256 : ${localHash}`);
if (servedHash !== localHash) {
  console.error(`\n❌ THE SERVED PAGE IS NOT THE FILE. A "deploy succeeded" line is not evidence of an effect.`);
  process.exit(1);
}
console.log(`\n✅ ${SITE_DOMAIN} is serving site/index.html.\n`);
