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

const URL_ = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "https://tikpema.xyz/";
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

console.log(`\nIS tikpema.xyz SERVING THIS REPO'S PAGE?   ${URL_}`);
console.log(`  local  site/index.html : ${localHash}  (${local.length} bytes)`);
console.log(`  served                 : ${servedHash}  (${servedBuf.length} bytes)`);

if (servedHash === localHash) {
  console.log(`\n✅ IN SYNC — the live page is the file in this repo.\n`);
  process.exit(0);
}

// ── They differ. Say WHICH WAY, because the two directions mean opposite things. ────────────────
const { execFileSync } = await import("node:child_process");
let lastTouch = "unknown";
try {
  lastTouch = execFileSync("git", ["log", "-1", "--format=%h %ad %s", "--date=short", "--", "site/index.html"], { encoding: "utf8" }).trim();
} catch {}

console.log(`\n❌ OUT OF SYNC.`);
console.log(`   site/index.html last changed in git: ${lastTouch}`);
console.log(`\n   ⭐ WHICH DIRECTION — this is the part that matters:`);
console.log(`   · If that commit is NEWER than the live deploy, the repo is AHEAD: a reviewed change`);
console.log(`     was never published. Run  npm run deploy:site -- --prod`);
console.log(`   · If the live deploy is NEWER, someone DRAG-AND-DROPPED. 🚨 The repo is no longer the`);
console.log(`     source of truth and the path that caused the original 66-day drift is back in use.`);
console.log(`     Capture the live bytes into docs/baselines/ BEFORE overwriting them — that window`);
console.log(`     closes the moment anything deploys.`);
console.log(`\n   Deploy timestamps:  netlify api getSite --data '{"site_id":"a892e744-9dfc-45df-8cd4-8cd1b0c480b4"}'\n`);
process.exit(1);
