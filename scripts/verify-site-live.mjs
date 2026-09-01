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
function gitDate() {
  try {
    return execFileSync("git", ["log", "-1", "--format=%aI", "--", "site/index.html"], { encoding: "utf8" }).trim();
  } catch { return null; }
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
const g = gitDate();
const pAt = pub.ok ? pub.deploy?.published_at ?? null : null;
if (g && pAt) {
  if (new Date(g) > new Date(pAt)) {
    console.log(`\n   ⭐ DIRECTION: REPO IS AHEAD. site/index.html (${g}) is newer than the published`);
    console.log(`      deploy (${pAt}). A reviewed change was never published.`);
    console.log(`      Run  npm run deploy:site -- --prod`);
  } else {
    console.log(`\n   🚨 DIRECTION: LIVE IS AHEAD. The published deploy (${pAt}) is newer than`);
    console.log(`      site/index.html (${g}) — someone drag-and-dropped. The repo is no longer the`);
    console.log(`      source of truth and the path that caused the 66-day drift is back in use.`);
    console.log(`      Capture the live bytes into docs/baselines/ BEFORE overwriting them.`);
  }
} else {
  console.log(`\n   ⚠️ DIRECTION UNDETERMINED — git date=${g ?? "?"} published_at=${pAt ?? "?"}.`);
  console.log(`      Do not assume "repo ahead": that is the benign branch, and assuming it is how a`);
  console.log(`      drag-and-drop would go unnoticed.`);
}
process.exit(1);
