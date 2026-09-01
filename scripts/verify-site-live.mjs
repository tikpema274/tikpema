// verify-site-live.mjs — is tikpema.xyz serving the file in this repo? Read-only, one GET.
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
// ⭐ ONE copy of the site identity, shared with deploy-site.mjs — see lib/marketing-site.mjs for
// why the UUID and not the name. The deployer and the verifier must not be able to disagree.
import { SITE_ID, SITE_DOMAIN } from "./lib/marketing-site.mjs";

const URL_ = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : `https://${SITE_DOMAIN}/`;
const sha = (b) => createHash("sha256").update(b).digest("hex");

const local = readFileSync("site/index.html");
const localHash = sha(local);

let servedBuf, res;
try {
  res = await fetch(URL_, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
  servedBuf = Buffer.from(await res.arrayBuffer());
} catch (e) {
  // ⛔ UNREACHABLE IS NOT "IN SYNC". An absence must never fill the result slot as safety.
  console.error(`\n✖ could not fetch ${URL_} — ${String(e?.message ?? e)}`);
  console.error(`  VERDICT: UNKNOWN. This is not evidence the page is current, and not evidence it is stale.\n`);
  process.exit(2);
}
if (!res.ok) {
  console.error(`\n✖ ${URL_} returned HTTP ${res.status}. VERDICT: UNKNOWN, not in-sync.\n`);
  process.exit(2);
}
const servedHash = sha(servedBuf);

// ═══ ⭐⭐ SECOND INSTRUMENT: THE PLATFORM'S OWN PUBLISHED POINTER ════════════════════════════════
// The byte comparison above answers "what does a visitor receive". It does NOT answer "did anything
// ever get published" — and those come apart. On 2026-09-01 three deploys in a row uploaded and
// left `published_deploy` sitting on a deploy from 26 June; every one of them exited 0. So ask the
// platform directly and report BOTH. ⛔ An unreadable answer is UNKNOWN, never "fine".
// [[repeating-one-instrument-is-not-corroboration]] · [[absence-must-never-read-as-safe]]
function publishedDeploy() {
  try {
    const out = execFileSync("npx", ["netlify", "api", "getSite", "--data", JSON.stringify({ site_id: SITE_ID })],
      { encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    const site = JSON.parse(out);
    return { ok: true, deploy: site?.published_deploy ?? null, name: site?.name ?? null };
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e).split("\n")[0] };
  }
}
// ═══ ⭐⭐ THE DIRECTION IS A CONTENT QUESTION, NOT A TIMESTAMP QUESTION ══════════════════════════
// This used to compare `git log -1 --format=%aI -- site/index.html` against published_at. That is a
// proxy, and it BREAKS in the single most ordinary workflow there is: edit the page, run the gate,
// then deploy. An uncommitted edit changes the local BYTES while leaving the last-commit DATE
// stale, so the file looks older than the deploy and the check printed
//   🚨 DIRECTION: LIVE IS AHEAD ... someone drag-and-dropped
// with nothing drag-and-dropped and the served bytes byte-identical to HEAD. ⛔ Firing the verdict
// that means "the process was bypassed" on a routine edit is worse than staying silent: it is the
// alarm nobody will believe the third time. MEASURED 2026-09-01, same command either side of one
// commit and no publish in between: LIVE IS AHEAD → REPO IS AHEAD.
//
// ⭐ So ask the question directly. "Which way" is about PROVENANCE — were the served bytes ever in
// this repo's history? — and that is answerable exactly, by hashing each historical version of the
// file. Timestamps only ever approximated it. [[probe-must-discriminate-between-states]]
// [[git-history-needs-a-reachability-query]] · [[establish-which-action-produced-the-outcome]]

/** Is site/index.html modified relative to HEAD? What deploy-site.mjs publishes is the WORKING
 *  TREE, so a dirty file means the bytes about to go live are in no commit and were reviewed by
 *  nobody. That is a separate fact from the direction, and it is reported separately. */
function worktreeDirty() {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", "site/index.html"], { encoding: "utf8" });
    return { ok: true, dirty: out.trim() !== "" };
  } catch (e) { return { ok: false, err: String(e?.message ?? e).split("\n")[0] }; }
}

/** Find the commit whose site/index.html hashes to `hash`. null = these bytes were NEVER in git,
 *  which is the drag-and-drop signature. ⛔ An unreadable history returns ok:false and must NOT
 *  collapse into "never committed" — absence of a match and inability to look are different
 *  answers, and only one of them is alarming. [[absence-must-never-read-as-safe]] */
function servedProvenance(hash) {
  try {
    const shas = execFileSync("git", ["log", "--format=%H", "--", "site/index.html"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    if (shas.length === 0) return { ok: false, err: "no commit in history touches site/index.html" };
    for (const c of shas) {
      let blob;
      try {
        blob = execFileSync("git", ["show", `${c}:site/index.html`],
          { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      } catch { continue; } // the file did not exist at that commit (e.g. it was deleted there)
      if (sha(blob) === hash) {
        const subj = execFileSync("git", ["log", "-1", "--format=%h %ad %s", "--date=short", c], { encoding: "utf8" }).trim();
        return { ok: true, commit: subj, sha: c, scanned: shas.length };
      }
    }
    return { ok: true, commit: null, sha: null, scanned: shas.length };
  } catch (e) { return { ok: false, err: String(e?.message ?? e).split("\n")[0] }; }
}

const pub = publishedDeploy();

console.log(`\nIS ${SITE_DOMAIN} SERVING THIS REPO'S PAGE?   ${URL_}`);
console.log(`  local  site/index.html : ${localHash}  (${local.length} bytes)`);
console.log(`  served                 : ${servedHash}  (${servedBuf.length} bytes)`);
if (pub.ok) {
  const d = pub.deploy;
  console.log(`  published_deploy       : ${d?.id ?? "(NONE)"}  state=${d?.state ?? "-"}  at=${d?.published_at ?? "-"}`);
} else {
  console.log(`  published_deploy       : UNREADABLE — ${pub.err}`);
}

// ── ⛔ NO PUBLISHED DEPLOY AT ALL is a failure even if the bytes happen to match. ────────────────
if (pub.ok && !pub.deploy?.id) {
  console.error(`\n❌ THE SITE HAS NO PUBLISHED DEPLOY. Whatever is being served, nothing was published.`);
  process.exit(1);
}

if (servedHash === localHash) {
  if (!pub.ok) {
    console.error(`\n✖ bytes match, but the published pointer could not be read.`);
    console.error(`  VERDICT: UNKNOWN. A byte match alone does not establish that a publish happened.\n`);
    process.exit(2);
  }
  if (pub.deploy.state !== "ready") {
    console.error(`\n❌ bytes match but published_deploy ${pub.deploy.id} is state=${pub.deploy.state}, not "ready".\n`);
    process.exit(1);
  }

  // ⛔⛔ BIND THE POINTER TO THE CONTENT. "A published deploy exists" and "the bytes I just fetched
  // came from it" are DIFFERENT claims, and the second is the one the verdict asserts. Found by
  // calibration 2026-09-01: pointed at a local server serving the repo file, this printed
  // "✅ IN SYNC … and it is the published deploy" while published_deploy was a June deploy holding
  // completely different bytes. A binding can only be tested ACROSS what it binds, so fetch the
  // published deploy's OWN permalink and require it to carry the same file.
  // [[binding-tested-across-what-it-binds]] · [[control-needs-ownership-and-stability]]
  if (!pub.name) {
    console.error(`\n✖ cannot build the published deploy's permalink (site name unreadable).`);
    console.error(`  VERDICT: UNKNOWN — the pointer was not bound to the content.\n`);
    process.exit(2);
  }
  const permalink = `https://${pub.deploy.id}--${pub.name}.netlify.app/`;
  let pubHash = null;
  try {
    const r = await fetch(permalink, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(30_000) });
    if (r.ok) pubHash = sha(Buffer.from(await r.arrayBuffer()));
  } catch {}
  console.log(`  published bytes        : ${pubHash ?? "UNREADABLE"}  (${permalink})`);
  if (pubHash === null) {
    console.error(`\n✖ could not read the published deploy's own bytes.`);
    console.error(`  VERDICT: UNKNOWN — an unread permalink is not a match.\n`);
    process.exit(2);
  }
  if (pubHash !== localHash) {
    console.error(`\n❌ THE BYTES AT ${URL_} MATCH THE REPO, BUT THE PUBLISHED DEPLOY DOES NOT.`);
    console.error(`   published ${pub.deploy.id} serves ${pubHash}.`);
    console.error(`   Whatever you just fetched, it is not what the published deploy holds.\n`);
    process.exit(1);
  }
  console.log(`\n✅ IN SYNC — the live page is the file in this repo, and the published deploy holds it.\n`);
  process.exit(0);
}

// ── They differ. Say WHICH WAY, because the two directions mean opposite things. ────────────────
let lastTouch = "unknown";
try {
  lastTouch = execFileSync("git", ["log", "-1", "--format=%h %ad %s", "--date=short", "--", "site/index.html"], { encoding: "utf8" }).trim();
} catch {}

// ⭐ THE FINDING IS THE SENTENCE, NOT THE BYTES. At the moment this fires, "the live page is not
// what is in the repo" is the whole result — WHICH bytes differ is noise, and a diff would bury the
// one line a reader needs under 20,000 characters of markup. The two hashes are printed above as
// evidence, not as a comparison to read.
console.log(`\n❌ THE LIVE PAGE IS NOT WHAT IS IN THE REPO.`);
console.log(`   site/index.html last changed in git: ${lastTouch}`);

// ⭐ RESOLVE THE DIRECTION HERE rather than printing two branches and asking the reader to pick.
// The publish timestamp is a fact the platform holds; comparing it to the file's commit date
// answers the question the prose used to leave open.
const dirty = worktreeDirty();
const prov = servedProvenance(servedHash);
const pAt = pub.ok ? pub.deploy?.published_at ?? null : null;

if (!prov.ok) {
  // ⛔ Could not look. That is not evidence either way, and "repo ahead" is the benign branch —
  // assuming it is exactly how a drag-and-drop goes unnoticed.
  console.log(`\n   ⚠️ DIRECTION UNDETERMINED — could not read the file's history: ${prov.err}`);
  console.log(`      Do not assume "repo ahead". Resolve the history before deploying over the live bytes.`);
} else if (prov.commit) {
  // The served bytes ARE a commit in this repo. Live is simply behind HEAD.
  console.log(`\n   ⭐ DIRECTION: REPO IS AHEAD. The live bytes are this repo's own commit:`);
  console.log(`      ${prov.commit}`);
  console.log(`      published ${pAt ?? "?"}. A reviewed change was never published.`);
  console.log(`      Run  npm run deploy:site -- --prod`);
} else {
  // 🚨 The served bytes match NO version of this file that git has ever held.
  console.log(`\n   🚨 DIRECTION: LIVE IS AHEAD. The served bytes match none of the ${prov.scanned} committed`);
  console.log(`      version(s) of site/index.html — they were never in git. Someone drag-and-dropped.`);
  console.log(`      The repo is no longer the source of truth and the path that caused the 66-day`);
  console.log(`      drift is back in use.`);
  console.log(`      Capture the live bytes into docs/baselines/ BEFORE overwriting them.`);
}

// ⭐ REPORTED SEPARATELY, BECAUSE IT IS A SEPARATE FACT. deploy-site.mjs publishes the WORKING
// TREE, not HEAD — so a dirty file means the bytes about to go live are in no commit. This is the
// state that used to be misread as a drag-and-drop; now it is named for what it is.
if (dirty.ok && dirty.dirty) {
  console.log(`\n   ⚠️ AND site/index.html HAS UNCOMMITTED CHANGES. deploy-site.mjs publishes the`);
  console.log(`      working tree, so publishing now would put bytes on tikpema.xyz that are in no`);
  console.log(`      commit and were reviewed by nobody. Commit first.`);
} else if (!dirty.ok) {
  console.log(`\n   ⚠️ could not determine whether site/index.html is dirty — ${dirty.err}`);
}
process.exit(1);
