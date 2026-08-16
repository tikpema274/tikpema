// capture-refusal-window.mjs — witness the post-deploy refusal window, from OUTSIDE the process.
//
// ═══ ⭐⭐ WHY THIS EXISTS AS A SCRIPT AND NOT AS A TEST ════════════════════════════════════════
// `verify-dd-report.mjs` proves the banner renders in all three health states — 98/0, in ONE process,
// with health injected. What it structurally cannot see is whether the DISCOVERY rung actually calls
// `healthDisclosure()` and threads the result into the page ON A REAL DEPLOY, during a real refusal.
// That is [binding-tested-across-what-it-binds]: the binding can only be tested across what it binds,
// and both sides are trivially identical inside one process.
//
// ⚠️ THE WINDOW IS THE ONLY MOMENT THIS IS OBSERVABLE, AND IT CLOSES ON ITS OWN. Every publish that
// changes DD-surface bytes mints a new health key, so the canary has no artifact for it and the
// service refuses until the next scheduled run. That is a guaranteed, self-healing outage lasting up
// to one canary period — and it is the ONLY time the banner can be seen in production without
// deliberately breaking the health artifact, which is the one thing standing between a broken
// detector and somebody's deposit. So this runs automatically, right after publish, instead of
// depending on a human happening to be watching in the right ninety seconds.
//
// ═══ 🚨 THREE OUTCOMES, AND "NOT OBSERVED" IS NOT "PASSED" ════════════════════════════════════
//   ✅ OBSERVED + banner present      — the fix is proven across the process boundary, AND the
//      window is then TIMED TO ITS CLOSE, because since step 2 that duration is how long vault
//      DEPOSITS were unavailable. ⚠️ The first version exited the moment it saw the banner: it could
//      prove a window HAPPENED and could not say how long it lasted, which was fine when the window
//      only affected a documentation page and stopped being fine when it began blocking money. The
//      2026-08-16 figure (≤6m49s) had to be obtained by hand, which is the definition of a gap.
//   🚨 OBSERVED + banner ABSENT       — the defect is back. Exit 1.
//   ⚠️ NO WINDOW                      — nothing was witnessed this run. NOT a pass, and it must never
//      print like one. Usually correct (the deploy changed no DD bytes, so no key rotated), but the
//      script says so in those words rather than going quiet.
//
// ⭐ AND IT CARRIES ITS OWN DISCRIMINATOR. Each run records the local `ddTree`. "No window" is
// EXPECTED when ddTree matches the previous entry and SUSPICIOUS when it changed — a rotated key with
// no refusal means either the window closed before the first probe or the health gate is not gating.
// Without the recorded hash those two are indistinguishable, which is how "nothing happened" quietly
// becomes "nothing is wrong".
//
// ⭐ THE LEDGER. Every run appends one line to `dd-refusal-window-log.jsonl`. An observation that
// lives only in a terminal does not survive, and this one is unrepeatable by construction.
//
// ⚠️ THE LEDGER IS TRACKED IN GIT, DELIBERATELY, and it follows `deploy-loss-log.jsonl`. Gitignoring
// it was the first instinct and it is the wrong one: it would leave the single entry that ever
// matters — the one run that actually witnessed the window — living only on whichever machine
// happened to run the deploy. ⚠️ The cost is a modified file in the tree after every prod deploy.
// That is noise, and it is also the reminder to commit the observation. It does NOT make the
// deployed surface dirty (SURFACES is netlify/functions, shared, src), so it cannot block the next
// deploy's tree gate.
//
//   node scripts/dd/capture-refusal-window.mjs [--url <base>] [--seconds N]
//
// READ-ONLY over HTTP: a GET to a documentation page. It cannot change the service's state.

import { appendFileSync, readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = argOf("--url", process.env.DD_CAPTURE_URL || "https://app.tikpema.xyz");
const WINDOW_SECONDS = Number(argOf("--seconds", "150"));
// ⭐ How long to keep watching AFTER the banner appears, waiting for it to clear. Generous against
// the real mechanism: the canary period is 10m and the health TTL 30m, so a window that has not
// closed in 20m is not a routine post-deploy refusal any more — it is the thing worth paging about.
const CLOSE_TIMEOUT_SECONDS = Number(argOf("--close-seconds", "1200"));
const INTERVAL_MS = 5000;
const LOG = "dd-refusal-window-log.jsonl";
const URL_ = `${BASE.replace(/\/$/, "")}/api/dd-analyze`;

// ── the local build identity, so "no window" can be told apart from "no rotation" ──────────────
// ⚠️ NEVER INVENTED. If the stamp is absent (cleared, or a run outside a build) ddTree is null and
// the report says the discriminator was unavailable, rather than comparing against a fabricated value.
let ddTree = null, commit = null;
try {
  const src = readFileSync(new URL("../../shared/build-stamp.generated.mjs", import.meta.url), "utf8");
  const m = src.match(/"ddTree":\s*"([0-9a-f]{64})"/);
  const c = src.match(/"commit":\s*"([0-9a-f]{40})"/);
  ddTree = m ? m[1] : null;
  commit = c ? c[1] : null;
} catch { /* stamp unreadable → discriminator unavailable, stated below */ }

let previous = null;
if (existsSync(LOG)) {
  const lines = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const e = JSON.parse(lines[i]); if (e.ddTree) { previous = e; break; } } catch { /* skip */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Classify one HTML GET. Never throws — a probe failure is an outcome, not a crash. */
async function probe() {
  try {
    const res = await fetch(URL_, { method: "GET", headers: { Accept: "text/html" } });
    const ctype = res.headers.get("content-type") || "";
    const body = await res.text();
    const isHtml = /text\/html/i.test(ctype);
    const banner = body.includes('class="down"');
    // ⚠️ Variant read from the RENDERED PAGE, not from a source assumption.
    let variant = null;
    if (banner) {
      if (/could not determine whether this service is currently answering/i.test(body)) variant = "unknown";
      else if (/will NOT clear by waiting/.test(body)) variant = "not-self-clearing";
      else if (/clears by itself, usually within minutes/.test(body)) variant = "self-clearing";
      else variant = "unrecognised";
    }
    const reason = (body.match(/Reason:\s*<code>([a-z-]+)<\/code>/) || [])[1] ?? null;
    const bannerAt = body.indexOf('class="down"'), curlAt = body.indexOf("curl -sS");
    return {
      ok: true, status: res.statusCode ?? res.status, ctype, isHtml, banner, variant, reason,
      bannerAboveCurl: banner ? (bannerAt > 0 && bannerAt < curlAt) : null,
      bytes: body.length,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

const started = new Date().toISOString();
console.log(`\ncapture-refusal-window — ${URL_}`);
console.log(`  ddTree ${ddTree ? ddTree.slice(0, 12) : "UNAVAILABLE"}   previous ${previous?.ddTree ? previous.ddTree.slice(0, 12) : "none recorded"}`);
console.log(`  polling every ${INTERVAL_MS / 1000}s for up to ${WINDOW_SECONDS}s\n`);

const observations = [];
let witnessed = null, firstProbe = null, witnessedAt = null, closedAt = null;
const deadline = Date.now() + WINDOW_SECONDS * 1000;

while (Date.now() < deadline) {
  const p = await probe();
  observations.push({ at: new Date().toISOString(), ...p });
  if (!firstProbe) firstProbe = p;
  const tag = !p.ok ? `probe failed: ${p.error}`
    : `${p.ctype.split(";")[0]}  banner=${p.banner ? p.variant : "none"}${p.reason ? ` (${p.reason})` : ""}`;
  console.log(`  [${new Date().toISOString().slice(11, 19)}] ${tag}`);
  if (p.ok && p.banner) { witnessed = p; witnessedAt = Date.now(); break; }
  // ⭐ EXIT EARLY ON A CONFIRMED NON-WINDOW. If the very first probe finds the service serving AND
  // the key did not rotate, no window was ever going to open — waiting the full 150s would only
  // delay the deploy chain for an outcome already determined.
  if (p.ok && !p.banner && previous?.ddTree && ddTree && previous.ddTree === ddTree) break;
  await sleep(INTERVAL_MS);
}

// ── ⭐⭐ WAIT FOR THE CLOSE. The duration IS the finding. ─────────────────────────────────────
// ⚠️ A window that opens and is never seen to close is NOT the same observation as one that closed,
// and it must not be reported as though the system self-healed. `closedAt` stays null and the
// verdict says the close was not witnessed — an unobserved recovery is an unknown, not a recovery.
if (witnessed) {
  console.log(`\n  banner seen — now waiting for it to CLEAR (up to ${CLOSE_TIMEOUT_SECONDS}s)`);
  const closeBy = Date.now() + CLOSE_TIMEOUT_SECONDS * 1000;
  while (Date.now() < closeBy) {
    await sleep(15000);
    const q = await probe();
    observations.push({ at: new Date().toISOString(), phase: "await-close", ...q });
    if (q.ok && !q.banner) {
      closedAt = Date.now();
      console.log(`  [${new Date().toISOString().slice(11, 19)}] banner GONE — window closed`);
      break;
    }
    console.log(`  [${new Date().toISOString().slice(11, 19)}] still refusing (${Math.round((Date.now() - witnessedAt) / 1000)}s)`);
  }
}
const durationMs = witnessed && closedAt ? closedAt - witnessedAt : null;

// ── verdict ───────────────────────────────────────────────────────────────────────────────────
const rotated = ddTree && previous?.ddTree ? previous.ddTree !== ddTree : null;
let outcome, exit = 0, lines = [];

if (witnessed) {
  const good = witnessed.isHtml && witnessed.bannerAboveCurl === true;
  outcome = good ? "observed-banner" : "observed-banner-malformed";
  exit = good ? 0 : 1;
  lines = [
    `✅ WINDOW OBSERVED — the page rendered DURING a real refusal and said so.`,
    `   content-type      : ${witnessed.ctype}   ${witnessed.isHtml ? "(html — the reorder is holding)" : "🚨 NOT HTML"}`,
    `   banner variant    : ${witnessed.variant}${witnessed.reason ? `  reason=${witnessed.reason}` : ""}`,
    `   banner above curl : ${witnessed.bannerAboveCurl}`,
    // ⭐⭐ THE NUMBER THAT MATTERS SINCE STEP 2: how long vault DEPOSITS were unavailable.
    durationMs !== null
      ? `   ⏱  WINDOW DURATION: ${Math.round(durationMs / 1000)}s (${(durationMs / 60000).toFixed(1)}m) — deposits were unavailable for this long.`
      : `   ⚠️ THE CLOSE WAS NOT WITNESSED within ${CLOSE_TIMEOUT_SECONDS}s. Duration UNKNOWN — this is not evidence it recovered.`,
    good ? `   ⭐ Proven ACROSS the process boundary, not inside one process.`
         : `   🚨 The banner rendered but is malformed (not html, or placed below the curl).`,
  ];
  // ⚠️ A window that never closed is its OWN outcome and exits non-zero: at that point it is no
  // longer a routine post-deploy refusal, it is an outage nobody has been paged about.
  if (durationMs === null) { outcome = "observed-banner-never-closed"; exit = 1; }
} else if (firstProbe && !firstProbe.ok) {
  outcome = "could-not-measure"; exit = 2;
  lines = [`⚠️ COULD NOT MEASURE — every probe failed (${firstProbe.error}).`,
           `   ⭐ This is deliberately NOT folded into "no window": a capture that cannot see is not`,
           `      a capture that saw nothing.`];
} else if (firstProbe && !firstProbe.isHtml) {
  // 🚨 THE ORIGINAL DEFECT, RETURNING. An html GET answered with json means DISCOVERY fell back
  // behind HEALTH — the exact regression this whole change removed.
  outcome = "regression-not-html"; exit = 1;
  lines = [`🚨 REGRESSION — an \`Accept: text/html\` GET was answered with ${firstProbe.ctype}.`,
           `   The discovery rung is no longer ahead of the health gate.`];
} else if (rotated === true) {
  outcome = "no-window-despite-rotation"; exit = 0;
  lines = [`🚨 SUSPICIOUS — the DD key ROTATED but no refusal window was seen in ${WINDOW_SECONDS}s.`,
           `   Either the canary refreshed before the first probe, or the health gate is not gating.`,
           `   ⚠️ Worth a look: a rotated key with no refusal is what a fail-open would look like.`];
} else {
  outcome = "no-window"; exit = 0;
  lines = [`⚠️ NO WINDOW OBSERVED — and this is NOT a pass.`,
           `   ddTree ${rotated === null ? "could not be compared (no prior entry or no stamp)" : "did not change"},`,
           `   so no health key rotated and no refusal was expected. Nothing was witnessed this run.`,
           `   ⭐ The banner remains proven only in-process until a DD-surface change ships.`];
}

appendFileSync(LOG, JSON.stringify({
  at: started, url: URL_, commit, ddTree, previousDdTree: previous?.ddTree ?? null, rotated,
  outcome, exit, windowSeconds: WINDOW_SECONDS,
  // ⭐ RECORDED IN THE LEDGER, because this is the figure a later reader will want and the terminal
  // it was printed to is gone.
  durationMs, durationSeconds: durationMs === null ? null : Math.round(durationMs / 1000),
  openedAt: witnessedAt ? new Date(witnessedAt).toISOString() : null,
  closedAt: closedAt ? new Date(closedAt).toISOString() : null,
  witnessed: witnessed ? { variant: witnessed.variant, reason: witnessed.reason, ctype: witnessed.ctype,
                           bannerAboveCurl: witnessed.bannerAboveCurl } : null,
  probes: observations.length,
}) + "\n");

console.log("\n" + "─".repeat(88));
for (const l of lines) console.log(l);
console.log(`   recorded → ${LOG}`);
console.log("─".repeat(88) + "\n");
process.exit(exit);
