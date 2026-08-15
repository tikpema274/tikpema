#!/usr/bin/env node
// deploy-loss-sweep.mjs — how many deploys have we silently lost since the baseline?
//
//   node scripts/deploy-loss-sweep.mjs                 # the sweep (also: npm run sweep:deploys)
//   node scripts/deploy-loss-sweep.mjs --hours 12      # raise the age threshold
//   node scripts/deploy-loss-sweep.mjs --json          # machine-readable, for a cron/monitor
//   node scripts/deploy-loss-sweep.mjs --no-log        # skip the durable ledger
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

import { appendFileSync } from "node:fs";
import { siteId, netlifyApi, listAllDeploys } from "./lib/netlify-api.mjs";
import { classifyDeployLosses, formatReport, DEFAULT_MIN_AGE_HOURS } from "./lib/deploy-loss-sweep.mjs";

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

if (WRITE_LOG) {
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
    }) + "\n");
  } catch (e) {
    // ⚠️ A ledger failure must not be silent, and must not fail the measurement either.
    console.error(`  ⚠️ could not append to the ledger (${LOG_PATH}): ${e?.message?.split("\n")[0]}`);
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ ...result, pages: listing.pages, exhausted: listing.exhausted }, null, 2));
} else {
  console.log("\ndeploy-loss-sweep — how many deploys have been silently lost?\n");
  for (const line of formatReport(result, { exhausted: listing.exhausted, pages: listing.pages })) console.log(line);
  console.log("");
}

if (!listing.exhausted) process.exit(2);
process.exit(result.counts.losses > 0 ? 1 : 0);
