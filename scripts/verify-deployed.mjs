#!/usr/bin/env node
// verify-deployed.mjs — the POST-deploy assertion. Did the build I just made actually
// become the thing production serves?
//
//   node scripts/verify-deployed.mjs                     # the gate (run after `netlify deploy --prod`)
//   node scripts/verify-deployed.mjs --timeout 900       # seconds to wait for `ready` (default 600)
//   node scripts/verify-deployed.mjs --deploy-id <id>    # additionally pin the expected deploy
//
// ═══ 🚨 WHY THIS EXISTS — FIVE SILENT FAILURES, 2026-08-14 ═══════════════════════════════════
// `deploy:prod` was `gate:watch && build && netlify deploy --prod`. Everything in that chain
// runs BEFORE the artifact leaves the machine. NOTHING ran after it. So on 2026-08-14 five
// consecutive production deploys were created and never finished, and the only reason anyone
// found out was a human asking a fresh session "did it ship?":
//
//   6a7f1abe639d3c2d0e78aedf | new | production | 13:40:14.999Z   ← 412e8d0, never published
//   6a7ee3dbd437680889f43855 | new | production | 09:46:03.894Z
//   6a7ee1a41cdeffd1fc5cf58e | new | production | 09:36:36.994Z
//   (+2 deploy-previews, same shape)
//   6a7e46c0c5a0a131d2a1d9ca | ready| production | 2026-08-13T22:35 ← what was ACTUALLY serving
//
// ⭐⭐ A `new` DEPLOY RECORD READS EXACTLY LIKE A SUCCESS. `error_message` is null. Nothing is
// red. `netlify deploy` had exited, the shell prompt came back, and the site served 12-hour-old
// code for another day. The failure has no symptom at the place a human looks — which is the
// same absence-reads-as-safety shape this repo keeps re-learning, moved up into the deploy step.
//
// 🚨 "FIVE" WAS AN UNDERCOUNT BY 7×. An UNFILTERED scan on 2026-08-15 (300 deploys, 3 pages) found
// 36 abandoned records — 27 production, 9 deploy-preview — going back to 2026-07-01, which is only
// as far as the API reaches. 35 of 36 carried `updated_at == created_at`; one died mid-UPLOAD, 12.5
// minutes in. All were cancelled, so the deploy list can no longer be used to count this class —
// the tally survives ONLY in PROGRESS.md. ⭐ Check 5 could never have surfaced them: it scopes to
// deploys newer than the published one, so it asks "did I lose the deploy I just ran", never "is
// this still happening". Every earlier look used per_page:25 — a filtered read is not a measurement
// of absence, and one page deeper turned an incident into a rate.
//
// ⚠️ WHY IT TAKES SO LONG TO FAIL, and why the window is wide enough to matter: the CLI bundles
// ~60 functions with esbuild before it uploads them. That phase ran 15+ minutes on the 2026-08-14
// deploy, at 150% CPU, with the deploy record sitting at `new` and `updated_at == created_at` the
// entire time. Anything that kills the CLI inside that window — a closed session, a backgrounded
// job reaped at turn end, a timeout — orphans the deploy in exactly this state. THAT is why the
// deploy must be run in the foreground AND asserted afterwards: the foreground fixes one deploy,
// this file fixes the class.
//
// ═══ WHAT IT ASSERTS, AND WHY EACH CHECK IS SEPARATE ═════════════════════════════════════════
//   1. the LOCAL build is stamped                — else there is nothing to compare against
//   2. the PUBLISHED deploy reached `ready`      — the state check
//   3. the SERVED build identity == the local one — `ready` proves a deploy landed, not WHICH
//   4. the two instruments AGREE on the deploy id — control plane vs data plane
//   5. NO ORPHANED production deploys            — the check that actually catches all five
//
// (3) is not redundant with (2). A deploy can be `ready` and be somebody else's — a rollback, a
// concurrent deploy, or a stale publish. `ready` answers "did A deploy finish", never "did MINE".
//
// ═══ ⚠️ THE HONEST COVERAGE BOUNDARY — checks 1–4 would NOT have caught the five ══════════════
// `deploy:prod` chains on `&&`, so a post-check runs only if `netlify deploy` EXITS. The five
// failures did not exit: the CLI was KILLED mid-bundle (`updated_at == created_at`, and
// `required_functions: null` — it never even reached the function-digest step). A killed shell
// takes every later command in its own chain with it. Nothing inside that process tree can
// survive its own death, so checks 1–4 cover a different class: "the CLI returned success and
// production still serves something else."
//
// ⭐ CHECK 5 IS WHAT CLOSES THE KILLED CASE, and it works because an orphan is DURABLE. A deploy
// abandoned at `new` stays in the site's deploy list forever. So this gate, run standalone at any
// later moment — the top of a session, before the next deploy — finds all five without needing to
// have been present when they died. That is why check 5 is not folded into check 2: check 2 asks
// "is the current publish good", check 5 asks "did we ever silently lose one".
//
// ⭐ TWO INSTRUMENTS, NOT TWO READS OF ONE. Check 4 compares the Netlify API's `published_deploy.id`
// (control plane) against the deploy id the running function reports from its own `x-nf-deploy-id`
// (data plane). Six reads of one API would be n=1. These can genuinely disagree, and when they do
// it is worth stopping for: it is the signature of a PINNED DEPLOY (`nf_dpl`) serving a tab — the
// open question from the 2026-08-14 `no-store` entry, where a browser's requests were served by
// something the published deploy's logs could not see.
//
// ⚠️ COMPARE ON `tree`, NOT `commit`. shared/build-stamp.mjs is explicit that the tree hash is the
// identity and the commit is provenance: a dirty stamp names a starting point and does not identify
// the artifact. A commit-only comparison would pass for a dirty build that differs from HEAD.
//
// ⚠️ EVERY UNKNOWN IS A FAILURE. Unreachable probe, unparseable response, absent field, missing
// site id — all exit non-zero. This file exists because an absence was read as a success; it must
// not repeat that in its own implementation.
//
// ⚠️ THE PROBE IS NOT A PURE READ, AND THAT IS DELIBERATE. `blobs-probe` writes its own dedicated
// `__strong-read-probe__` key to prove a strong read actually reaches origin — that IS the probe.
// It touches no application state, and the `*/15` strong-read-watch cron already calls this exact
// URL on this exact schedule, so the gate adds one invocation per deploy to a path that is already
// continuously exercised.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { buildStamp } from "../shared/build-stamp.mjs";
// ⭐ The monitor's own constant, imported rather than transcribed, for the same reason the
// promotion gate imports its constants: a second copy of the target URL drifts, and a gate
// pointed at the wrong host passes while production is broken.
import { DEFAULT_TARGET_URL } from "../shared/strong-read-watch/watch.mjs";
import { bootTimeMs, buildProcesses, livenessOf } from "./lib/deploy-liveness.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const PROBE_URL = flag("url", DEFAULT_TARGET_URL);
const TIMEOUT_S = Number(flag("timeout", "600"));
const PIN_DEPLOY_ID = flag("deploy-id");
const POLL_EVERY_MS = 15_000;
/** A Netlify deploy id is 24 lowercase hex chars. Shape-validated, same as blobs-probe. */
const DEPLOY_ID_RE = /^[0-9a-f]{24}$/;

const failures = [];
const notes = [];
const fail = (check, detail) => { failures.push({ check, detail }); console.log(`  ✗ ${check}\n      ${detail}`); };
const pass = (check, detail) => console.log(`  ✓ ${check}${detail ? `\n      ${detail}` : ""}`);
const short = (v, n = 12) => (typeof v === "string" ? v.slice(0, n) : String(v));

// ── site id ──────────────────────────────────────────────────────────────────────────────────
// From .netlify/state.json — the same linkage `netlify deploy` itself uses, so the gate can
// never assert against a different site than the one just deployed to.
function siteId() {
  try {
    const id = JSON.parse(readFileSync(new URL("../.netlify/state.json", import.meta.url), "utf8"))?.siteId;
    if (typeof id === "string" && id.length > 0) return id;
    return null;
  } catch {
    return null;
  }
}

function netlifyApi(method, payload) {
  const stdout = execFileSync("npx", ["netlify", "api", method, "--data", JSON.stringify(payload)], {
    encoding: "utf8",
    timeout: 90_000,
    // ⚠️ FOUND BY THIS GATE'S OWN CALIBRATION RUN. `listSiteDeploys` with per_page:25 returns well
    // over the 1MB execFileSync default and died with ENOBUFS — which the fail-closed design
    // correctly reported as FAILED rather than "no orphans found", but it was still a real bug
    // that would have made check 5 useless on every run.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

// ── deploy liveness ──────────────────────────────────────────────────────────────────────────
// ⭐⭐ Extracted to scripts/lib/deploy-liveness.mjs so the branches that only fire when something
// is ALREADY going wrong (no process found; both instruments unreadable) are tested by CALLING
// them — see scripts/verify-deploy-liveness.mjs. The full reasoning lives in that module's header.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log("\nverify-deployed — is production serving the build in this working tree?\n");

// ── 1. THE LOCAL BUILD MUST BE STAMPED ───────────────────────────────────────────────────────
// Without a stamp there is no identity to compare, and "no identity" must never resolve to
// "matches". The committed stamp is null on purpose (see scripts/stamp-build.mjs), so this also
// catches a deploy attempted without running the build at all.
console.log("1. LOCAL BUILD");
const local = buildStamp();
if (!local.resolved) {
  // ⚠️ EXPECTED ON A FRESH CHECKOUT, and the reason is worth stating: the COMMITTED stamp is null
  // on purpose, so a standalone run (session start, days after the deploy) lands here every time.
  // `npm run stamp` regenerates it WITHOUT rebuilding — checks 2 and 5 still ran above/below and
  // still mean what they say; only the tree comparison is unavailable, which is why this is a
  // failure and not a skip.
  fail(
    "the local build is stamped",
    `${local.detail} — run \`npm run stamp\` (no rebuild needed) or \`npm run build\`, then re-run. ` +
      `The committed stamp is null by design, so this is the expected state of a fresh checkout.`
  );
} else {
  pass("the local build is stamped", `commit ${short(local.commit ?? "none")} tree ${short(local.tree)} (${local.detail})`);
  if (local.dirty === true) {
    // Not fatal — the tree hash still identifies the artifact exactly. But it must be SAID,
    // because the commit in every later log line will name source that was never deployed.
    notes.push("the deployed surface was DIRTY at stamp time — the commit names a starting point, not this artifact");
    console.log("      ⚠️  DIRTY at stamp time — comparison is on tree, which is still exact");
  }
}

// ── 2. THE PUBLISHED DEPLOY MUST REACH `ready` ───────────────────────────────────────────────
// THE CHECK THAT WOULD HAVE CAUGHT ALL FIVE. Anything that is not `ready` is a failure,
// enumerated by name so `new` can never be mistaken for a terminal success again.
console.log("\n2. PUBLISHED DEPLOY STATE");
const site = siteId();
let published = null;
if (!site) {
  fail("the site is linked", "no siteId in .netlify/state.json — cannot ask the platform what is published.");
} else {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  let last = null, attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const pd = netlifyApi("getSite", { site_id: site })?.published_deploy ?? null;
      last = pd?.state ?? "absent";
      if (pd && pd.state === "ready") { published = pd; break; }
      // A deploy still bundling/uploading is not a failure YET — it is the window this gate
      // exists to sit through. Report progress so a long wait is legible rather than a hang.
      console.log(`      … published deploy is "${last}" (attempt ${attempts}, ${Math.round((deadline - Date.now()) / 1000)}s left)`);
    } catch (e) {
      last = `api_error: ${e?.message?.split("\n")[0]}`;
      console.log(`      … ${last} (attempt ${attempts})`);
    }
    if (Date.now() + POLL_EVERY_MS < deadline) await sleep(POLL_EVERY_MS);
    else break;
  }
  if (published) {
    pass("the published deploy is `ready`", `${published.id} — published ${published.published_at ?? published.created_at}`);
  } else {
    fail(
      "the published deploy is `ready`",
      `after ${TIMEOUT_S}s the published production deploy is "${last}", not "ready". ` +
        `A "new" record means the CLI created the deploy and never finished uploading it — it has a ` +
        `null error_message and looks exactly like a success. The site is still serving whatever it ` +
        `served before. Re-run the deploy IN THE FOREGROUND and let it finish.`
    );
  }
}

// ── 3 & 4. WHAT IS ACTUALLY ON THE WIRE ──────────────────────────────────────────────────────
// `ready` is the platform's account of itself. This is the artifact answering for itself.
console.log("\n3. SERVED BUILD IDENTITY");
let probe = null;
try {
  const res = await fetch(PROBE_URL, { signal: AbortSignal.timeout(45_000), headers: { "cache-control": "no-cache" } });
  const text = await res.text();
  if (!res.ok) fail("the probe answers", `${PROBE_URL} → HTTP ${res.status}. ${text.slice(0, 200)}`);
  else {
    try { probe = JSON.parse(text); } catch { fail("the probe answers JSON", `unparseable response: ${text.slice(0, 200)}`); }
  }
} catch (e) {
  // Unreachable is a FAILURE, never an unknown. If we cannot see what is deployed, we have not
  // verified the deploy — that is the whole premise of this file.
  fail("the probe is reachable", `${PROBE_URL} — ${e?.message}. Unreachable is reported as FAILED, not unknown.`);
}

if (probe) {
  const servedBuild = probe.build ?? {};
  const servedDeploy = probe.deploy ?? {};

  if (servedBuild.resolved !== true || typeof servedBuild.tree !== "string") {
    fail(
      "the served build is stamped",
      `the deployed artifact reports UNRESOLVED provenance (${servedBuild.detail ?? "no detail"}). It was ` +
        `deployed without stamping, so it cannot say which source produced it.`
    );
  } else if (local.resolved) {
    // ⭐ THE TREE IS THE IDENTITY. See shared/build-stamp.mjs.
    if (servedBuild.tree === local.tree) {
      pass("production serves THIS tree", `tree ${short(servedBuild.tree)} — stamped ${servedBuild.generatedAt}`);
    } else {
      fail(
        "production serves THIS tree",
        `local tree ${short(local.tree)} but production serves ${short(servedBuild.tree)} ` +
          `(commit ${short(servedBuild.commit ?? "none")}, stamped ${servedBuild.generatedAt}). ` +
          `A deploy finished — it just was not this one.`
      );
    }
    // ⭐⭐ THE COMMIT IS PROVENANCE, NOT IDENTITY — AND THIS GATE GOT IT WRONG ON ITS FIRST REAL RUN.
    //
    // It originally FAILED on any commit mismatch. Minutes after being committed it reported
    // "❌ DEPLOY NOT VERIFIED — local 2c904a6 vs served 412e8d0" for a production site that was
    // serving a byte-identical deployed surface. The stamped surface is a fixed set of directories
    // (scripts/stamp-build.mjs SURFACES), so a commit touching PROGRESS.md, package.json or scripts/
    // advances HEAD and changes NOTHING that is deployed. The tree hash proved it: same 5dd4439e…
    // on both sides, different commits.
    //
    // ⚠️ UPDATED 2026-08-15 — THE SURFACE WAS TOO NARROW, AND THIS CHECK IS WHY WE KNOW. It was
    // `netlify/functions` + `shared` only, which meant a commit touching just `src/` also produced a
    // byte-identical tree. Two production deploys (`0d16bfc`, `dd16f23`) passed check 3 against a
    // hash that could not have distinguished them, and only the commit line verified them.
    // ⭐ `src` is now part of SURFACES, so the tree once again identifies the whole artifact and this
    // clause covers only what it should: commits outside the deployed surface entirely.
    //
    // ⚠️ THAT IS A FALSE ALARM ON A SAFETY GATE, which is not a small bug — it is how a gate teaches
    // people to ignore it, and an ignored gate is the same as no gate. It is also the identical shape
    // build-stamp.mjs already documents for ddCodeIdentity ("18 were stamp-dirty but DD-clean"), one
    // level up. So: a commit mismatch UNDER A MATCHING TREE is reported and never failed.
    if (local.commit && servedBuild.commit) {
      if (servedBuild.commit === local.commit) {
        pass("the served commit matches", short(servedBuild.commit));
      } else if (servedBuild.tree === local.tree) {
        notes.push(
          `HEAD is ${short(local.commit)} but the deployed artifact was stamped at ${short(servedBuild.commit)} — ` +
            `NOT a discrepancy: the trees are identical, so every commit since touched only files outside ` +
            `the stamped surface (netlify/functions, shared). Nothing deployable is missing from production.`
        );
        console.log(
          `  ⚠️  HEAD ${short(local.commit)} ≠ stamped ${short(servedBuild.commit)}, but the TREES MATCH\n` +
            `      → later commits touched only non-deployed files. Not a failure: the tree is the identity.`
        );
      } else {
        // The tree check has already failed; this is corroborating detail, not a second verdict.
        console.log(`      (commit also differs: local ${short(local.commit)} vs served ${short(servedBuild.commit)})`);
      }
    }
  }

  console.log("\n4. THE TWO INSTRUMENTS AGREE");
  const servedId = typeof servedDeploy.id === "string" ? servedDeploy.id.toLowerCase() : null;
  if (!servedDeploy.resolved || !servedId || !DEPLOY_ID_RE.test(servedId)) {
    fail("the running function names its deploy", servedDeploy.detail ?? "no deploy id resolved from the response");
  } else if (published?.id) {
    if (servedId === String(published.id).toLowerCase()) {
      pass("control plane == data plane", `both name ${servedId}`);
    } else {
      fail(
        "control plane == data plane",
        `the API says the published deploy is ${published.id}, but the function that answered says it is ` +
          `running under ${servedId}. That gap is the signature of a PINNED DEPLOY (nf_dpl) or a stale ` +
          `edge — requests are being served by something other than what is published.`
      );
    }
  } else {
    notes.push("deploy-id cross-check skipped: no published deploy id to compare against (check 2 already failed)");
    console.log("      – skipped: check 2 did not yield a published deploy id");
  }

  if (PIN_DEPLOY_ID) {
    if (String(PIN_DEPLOY_ID).toLowerCase() === servedId) pass("the pinned deploy id is the one serving", PIN_DEPLOY_ID);
    else fail("the pinned deploy id is the one serving", `expected ${PIN_DEPLOY_ID}, serving ${servedId}`);
  }
}

// ── 5. NOTHING WAS SILENTLY LOST ─────────────────────────────────────────────────────────────
// ⭐ THE CHECK THAT ACTUALLY CATCHES THE FIVE. A production deploy created AFTER the one that is
// published, and still not `ready`, is a deploy somebody started and nobody finished. It is
// invisible everywhere else: null error_message, nothing red, the CLI's shell prompt long since
// returned. And it is DURABLE — which is what lets this run find it days later.
//
// ⭐⭐ A deploy in flight and an abandoned one differ by exactly one thing — whether a process is
// still working on it — so that is what this asks. It used to ask how OLD the record was and
// presume anything under 30 minutes was in flight. That guess printed "presumed in flight, not
// orphaned" about a deploy whose machine had since REBOOTED, on 2026-08-15, at the top of the
// session convened to find out whether the deploy had landed. The reassurance was strongest
// exactly when someone was looking, because the window covers the moment right after the failure.
//
// ⭐ THE CLASS: a guard that accepts a TIMEOUT in place of EVIDENCE has the same shape as the
// thing it guards against. This file's own thesis is that an absence must not fill a result slot
// — and "30 minutes have not yet elapsed" is an absence of elapsed time standing in for a
// presence of work. Both positive tests below are cheap and immediate; neither one waits.
//
// ⚠️ SCOPED TO ORPHANS NEWER THAN THE PUBLISHED DEPLOY, deliberately. Once a good deploy lands,
// earlier abandoned attempts stop being "a change you believe shipped" — check 3 now answers that
// question directly by comparing trees. So this scan narrows to zero the moment a publish succeeds,
// which is correct for "did I lose MY deploy" and is NOT a claim that the old records are gone.
console.log("\n5. ORPHANED DEPLOYS");
if (!site) {
  console.log("      – skipped: no site id");
} else {
  try {
    const deploys = netlifyApi("listSiteDeploys", { site_id: site, per_page: 25 });
    const publishedAt = published?.created_at ? Date.parse(published.created_at) : 0;
    const suspects = (Array.isArray(deploys) ? deploys : []).filter(
      (d) => d?.context === "production" && d?.state !== "ready" && Date.parse(d?.created_at ?? 0) > publishedAt
    );

    // ⚠️ SCOPE: both tests are about THIS machine. A deploy running from another machine or CI
    // would read as dead here. That is the deliberate trade — this gate's question is "did I lose
    // MY deploy", it runs on the box that deploys, and the costs are asymmetric: a false ORPHANED
    // costs one redundant 25-minute deploy, a false IN FLIGHT costs a change everyone believes
    // shipped and nobody re-checks. The old comment ranked those the other way round.
    const boot = bootTimeMs();
    const procs = buildProcesses();
    if (suspects.length > 0) {
      console.log(
        `      liveness instruments: boot ${boot === null ? "UNREADABLE" : new Date(boot).toISOString()}` +
          ` · build processes ${procs === null ? "UNREADABLE (ps failed)" : procs.length}`
      );
    }

    const judged = suspects.map((d) => ({ d, live: livenessOf(d.created_at, boot, procs) }));
    const orphans = judged.filter((j) => j.live.dead === true);
    const inFlight = judged.filter((j) => j.live.dead === false);
    const undetermined = judged.filter((j) => j.live.dead === null);

    for (const { d, live } of inFlight) {
      notes.push(`deploy ${d.id} is "${d.state}" and IN FLIGHT — ${live.why}`);
      console.log(`      ⚠️  ${d.id} is "${d.state}" — in flight, not orphaned (${live.why})`);
    }
    if (orphans.length === 0 && undetermined.length === 0) {
      pass("no abandoned production deploys", `scanned ${deploys.length} deploys newer than the published one`);
    } else if (orphans.length > 0) {
      fail(
        "no abandoned production deploys",
        `${orphans.length} production deploy(s) were created after the published one, never reached \`ready\`, ` +
          `and are PROVABLY not being worked on:\n` +
          orphans.map(({ d, live }) => `        ${d.id} | ${d.state} | ${d.created_at}\n          ↳ ${live.why}`).join("\n") +
          `\n      Each was started and never finished — almost certainly a CLI killed mid-bundle. They ` +
          `carry no error and are invisible in every other view. Nothing is broken by leaving them, but ` +
          `each one is a change somebody believed had shipped.`
      );
    }
    // ⚠️ Undetermined is its OWN failure, not folded into either verdict: neither "abandoned" nor
    // "in flight" was established, and silently picking the calmer one is the original bug.
    if (undetermined.length > 0) {
      fail(
        "liveness of every non-ready deploy is established",
        `${undetermined.length} non-ready production deploy(s) could not be judged either way:\n` +
          undetermined.map(({ d, live }) => `        ${d.id} | ${d.state} | ${d.created_at}\n          ↳ ${live.why}`).join("\n") +
          `\n      Check by hand before assuming anything: \`ps -ef | grep -E "netlify|esbuild"\`.`
      );
    }
  } catch (e) {
    fail("the deploy list is readable", `${e?.message?.split("\n")[0]} — cannot rule out abandoned deploys, so this is FAILED, not skipped.`);
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(92));
for (const n of notes) console.log(`⚠️  ${n}`);
if (failures.length === 0) {
  console.log(`✅ DEPLOY VERIFIED — production is serving tree ${short(local.tree)} under deploy ${published?.id}.`);
  console.log("─".repeat(92) + "\n");
  process.exit(0);
}
console.log(`❌ DEPLOY NOT VERIFIED — ${failures.length} check(s) failed:\n`);
for (const f of failures) console.log(`   · ${f.check}\n     ${f.detail}\n`);
console.log("🚨 DO NOT record this deploy as shipped. Production is serving something else.");
console.log("─".repeat(92) + "\n");
process.exit(1);
