#!/usr/bin/env node
// deploy-loss-sweep.mjs — how many deploys have we silently lost since the baseline?
//
//   node scripts/deploy-loss-sweep.mjs                 # the sweep (also: npm run sweep:deploys)
//   node scripts/deploy-loss-sweep.mjs --hours 12      # raise the age threshold
//   node scripts/deploy-loss-sweep.mjs --json          # machine-readable, for a cron/monitor
//   node scripts/deploy-loss-sweep.mjs --no-log        # skip the durable ledger
//   node scripts/deploy-loss-sweep.mjs --gate-new      # GATE MODE (also: npm run gate:deployloss)
//
// ═══ ⭐ GATE MODE — WHY IT EXISTS AND HOW ITS VERDICT DIFFERS ═════════════════════════════════
// Wired into `deploy:prod` so the census can never go unrun again. It had gone 25 DAYS between
// lines (baseline 2026-08-15 → 2026-09-09) while 8 losses accumulated, and 3 of those went
// unrecorded for over a week. The census only ever ran when a human remembered to run it.
//
// ⭐ WHY A DEPLOY HOOK AND NOT A CRON, measured 2026-09-09: 100/100 recent deploys are
// `deploy_source: "cli"` with `build_id: null` — nothing but the local machine deploys this site.
// An orphan can therefore only be created by a local `netlify deploy`, so running the census on
// every deploy has COMPLETE coverage of the event that creates one. A scheduled function would
// poll for an event only this machine can cause, and would need an account-wide Netlify PAT in
// production env (there is none today — 33 keys, none Netlify-shaped) readable by 131 functions.
// That is the account's most powerful credential bought for a monitoring convenience. Rejected.
//
// ⚠️ THE VERDICT IS THE DELTA, NOT THE TOTAL. Default mode exits 1 on any standing loss, which is
// right for a human census and wrong for a gate: 8 losses stand BY DECISION, so a gate on the
// total would fail every deploy forever. Gate mode fails only on a loss the last census had not
// already recorded. Full reasoning in scripts/lib/deploy-loss-delta.mjs.
//
// ⚠️ GATE MODE STILL EXITS 2 ON "CANNOT MEASURE", and adds two ways to get there that the plain
// census does not need: a scan that returned nothing at all, and a ledger with no usable baseline.
// Neither is allowed to read as "nothing new".
//
// ⭐⭐ IT COUNTS. IT NEVER CLEANS. The reasoning — and why auto-remediation would destroy the very
// measurement this exists to take — is in scripts/lib/deploy-loss-sweep.mjs's header, along with
// why an AGE threshold is correct here and would be wrong in verify-deployed's check 5.
//
// ⚠️ EXIT CODE IS THE SIGNAL: 0 = nothing lost, 1 = losses found, 2 = the sweep could not measure
// (no site id, API failure, paging capped). ⭐ 2 is NOT folded into 0 — a sweep that cannot see is
// not a sweep that found nothing, and this repo has shipped that exact conflation before.
//
// ⭐ THE LEDGER, AND WHY IT IS NOT OPTIONAL IN SPIRIT. Cancelling a record erases the evidence that
// it was ever abandoned — that is what happened to all 36 on 2026-08-15, and it is why the deploy
// list can no longer count this class. The list is also not permanent: it holds 437 records today,
// and nothing guarantees the oldest survive. So every run APPENDS one line to deploy-loss-log.jsonl:
// the tally plus the ids. An observation that lives only in a terminal does not survive, and
// "was it recorded" is a different question from "how long does it last".

import { appendFileSync, readFileSync } from "node:fs";
import { siteId, netlifyApi, listAllDeploys } from "./lib/netlify-api.mjs";
import { classifyDeployLosses, formatReport, DEFAULT_MIN_AGE_HOURS } from "./lib/deploy-loss-sweep.mjs";
import { previousCensus, diffLosses, formatDelta, verdictFor } from "./lib/deploy-loss-delta.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const MIN_AGE_HOURS = Number(flag("hours", String(DEFAULT_MIN_AGE_HOURS)));
const MAX_PAGES = Number(flag("max-pages", "50"));
const AS_JSON = has("json");
const LOG_PATH = flag("log", new URL("../deploy-loss-log.jsonl", import.meta.url).pathname);
const WRITE_LOG = !has("no-log");
const GATE_NEW = has("gate-new");

if (!Number.isFinite(MIN_AGE_HOURS) || MIN_AGE_HOURS <= 0) {
  console.error(`deploy-loss-sweep: --hours must be a positive number, got ${flag("hours")}`);
  process.exit(2);
}

const site = siteId();
if (!site) {
  console.error("deploy-loss-sweep: no site id in .netlify/state.json — cannot scan. This is a FAILURE to measure, not a clean result.");
  process.exit(2);
}

let listing;
try {
  // ⚠️ UNFILTERED AND PAGED TO EXHAUSTION. No per_page default, no scoping to deploys newer than
  // the published one. Both of those are what hid 36 records for six weeks.
  listing = listAllDeploys({ site, api: netlifyApi, maxPages: MAX_PAGES });
} catch (e) {
  console.error(`deploy-loss-sweep: could not list deploys — ${e?.message?.split("\n")[0]}`);
  console.error("This is a FAILURE to measure. Exiting 2 so it cannot be read as \"nothing lost\".");
  process.exit(2);
}

const result = classifyDeployLosses(listing.deploys, { now: Date.now(), minAgeHours: MIN_AGE_HOURS });

// ⚠️ VACUITY GUARD. "0 losses out of 0 deploys scanned" is not a clean result, it is a scan that
// saw nothing — and it prints identically to a real zero. `listing.exhausted` does not cover this:
// an API returning one empty page IS exhausted. Both modes, because a vacuous pass is never right.
// ⚠️ It reports here but does NOT exit here: the verdict has exactly one source (verdictFor,
// below), and a second `process.exit(2)` encoding the same rule is how two copies drift apart.
// What it DOES gate is the append — a census line claiming zero deploys would poison the baseline.
if (result.scanned === 0) {
  console.error("deploy-loss-sweep: the scan returned 0 deploys. That is a FAILURE to measure, not");
  console.error("  \"nothing lost\" — a site with 551 records cannot legitimately scan to zero.");
  console.error("  No census line will be appended: a zero-scan baseline would make every later");
  console.error("  standing loss read as NEW, turning one bad scan into a permanent false alarm.");
}

// ── GATE MODE: READ THE BASELINE BEFORE THIS RUN APPENDS ITS OWN LINE ────────────────────────
// ⚠️ ORDER IS THE MECHANISM. Appending first would make every run its own baseline and the delta
// would be permanently empty — a gate that cannot fail, which is the shape this repo has shipped
// before and now tests for explicitly.
let baseline = null;
let delta = null;
if (GATE_NEW) {
  let ledgerText = null;
  let readErr = null;
  try {
    ledgerText = readFileSync(LOG_PATH, "utf8");
  } catch (e) {
    // ENOENT is "no baseline yet" and previousCensus says so. Anything else (permissions, a
    // directory, IO) is a different failure and must not be laundered into the same message.
    if (e?.code !== "ENOENT") readErr = e?.message?.split("\n")[0] ?? String(e);
  }
  baseline = readErr
    ? { ok: false, why: `the ledger could not be read (${readErr})`, lines: 0 }
    : previousCensus(ledgerText);
  if (baseline.ok) delta = diffLosses(baseline.lossIds, result.losses);
}

if (WRITE_LOG && result.scanned > 0) {
  try {
    appendFileSync(LOG_PATH, JSON.stringify({
      observedAt: new Date().toISOString(),
      scanned: result.scanned,
      pages: listing.pages,
      exhausted: listing.exhausted,
      minAgeHours: MIN_AGE_HOURS,
      counts: result.counts,
      // ⚠️ The ledger records every limbo record INCLUDING known survivors — the exclusion is a
      // reporting decision, and a durable log that inherited it would lose the very evidence
      // those 23 records exist to preserve.
      ids: result.limbo.map((r) => ({ id: r.id, state: r.state, created_at: r.created_at, context: r.context, preserved: r.preserved })),
      // ⭐ THE DELTA IS RECORDED, NOT JUST REPORTED. Gate mode alarms on a new loss exactly ONCE:
      // this line then becomes the next run's baseline, so the same id is `carried` afterwards and
      // the deploy stops failing. That self-acknowledgement is deliberate — a gate that re-fires
      // forever on a condition nobody intends to clear is the thing being avoided — but it means
      // the ALARM is transient and only this field is durable. Which run first saw an id is
      // recoverable from here and nowhere else.
      ...(GATE_NEW ? { mode: "gate-new", baselineOk: baseline.ok } : {}),
      ...(delta ? { newLossIds: delta.appeared.map((r) => r.id), resolvedLossIds: delta.resolved } : {}),
    }) + "\n");
  } catch (e) {
    // ⚠️ A ledger failure must not be silent, and must not fail the measurement either.
    console.error(`  ⚠️ could not append to the ledger (${LOG_PATH}): ${e?.message?.split("\n")[0]}`);
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({
    ...result,
    pages: listing.pages,
    exhausted: listing.exhausted,
    ...(GATE_NEW ? { gate: { baselineOk: baseline.ok, why: baseline.ok ? null : baseline.why, appeared: delta?.appeared ?? null, resolved: delta?.resolved ?? null } } : {}),
  }, null, 2));
} else {
  console.log(`\ndeploy-loss-sweep — how many deploys have been silently lost?${GATE_NEW ? "   [GATE MODE — verdict is the DELTA]" : ""}\n`);
  for (const line of formatReport(result, { exhausted: listing.exhausted, pages: listing.pages })) console.log(line);
  if (GATE_NEW) {
    if (baseline.ok) {
      for (const line of formatDelta(delta, { observedAt: baseline.observedAt })) console.log(line);
    } else {
      console.log("");
      console.log(`  ⛔ NO BASELINE — ${baseline.why}.`);
      console.log("     This run's census has been appended, so the NEXT run can gate. This one cannot:");
      console.log("     a delta with no baseline is not \"nothing new\", it is nothing measured.");
    }
  }
  console.log("");
}

const verdict = verdictFor({
  scanned: result.scanned,
  exhausted: listing.exhausted,
  gateNew: GATE_NEW,
  baselineOk: baseline?.ok ?? null,
  appearedCount: delta?.appeared.length ?? 0,
  standingLosses: result.counts.losses,
});

if (verdict === 2) {
  console.error("deploy-loss-sweep: EXIT 2 — could not measure. This is NOT \"nothing lost\".");
}

process.exit(verdict);
