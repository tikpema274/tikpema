// netlify-api.mjs — the ONE Netlify API access layer for build tooling.
//
// Extracted from verify-deployed.mjs when the deploy-loss sweep needed the same three things
// (site id, an API call, a full deploy listing). A second copy of `netlifyApi` would have drifted
// from the first — including the `maxBuffer` fix below, which was found the hard way — and
// "duplicate source of truth" is this repo's most-repeated bug.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * From .netlify/state.json — the same linkage `netlify deploy` itself uses, so tooling can never
 * assert against a different site than the one being deployed to. Returns null, never a guess.
 */
export function siteId() {
  try {
    const id = JSON.parse(readFileSync(new URL("../../.netlify/state.json", import.meta.url), "utf8"))?.siteId;
    if (typeof id === "string" && id.length > 0) return id;
    return null;
  } catch {
    return null;
  }
}

export function netlifyApi(method, payload) {
  const stdout = execFileSync("npx", ["netlify", "api", method, "--data", JSON.stringify(payload)], {
    encoding: "utf8",
    timeout: 90_000,
    // ⚠️ FOUND BY verify-deployed's OWN CALIBRATION RUN. `listSiteDeploys` with per_page:25 returns
    // well over the 1MB execFileSync default and died with ENOBUFS — which the fail-closed design
    // correctly reported as FAILED rather than "no orphans found", but it was still a real bug that
    // would have made the orphan check useless on every run. The sweep pages at 100 and inherits it.
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout);
}

/** How many deploys a single page requests. NEVER rely on the API's default — see listAllDeploys. */
export const PAGE_SIZE = 100;

/**
 * ⭐⭐ EVERY DEPLOY, PAGED TO EXHAUSTION. NOT a filtered view, NOT a first page.
 *
 * 🚨 THE BLINDNESS THIS EXISTS TO PREVENT. For six weeks every look at the deploy list used
 * `per_page: 25` and was scoped to deploys newer than the published one. Both are reasonable for
 * "did the deploy I just ran survive". Together they hid 36 abandoned deploys going back to
 * 2026-07-01, and the class read as a one-off incident on 2026-08-14 rather than as a rate.
 *
 * ⚠️ NO SILENT CAP. Paging stops when the API returns a short page (exhausted) or when maxPages is
 * hit — and the caller is TOLD which, because a truncated scan that reports a number reads exactly
 * like a complete one. `exhausted: false` means the count is a floor, not a total.
 *
 * @returns {{deploys: object[], pages: number, exhausted: boolean}}
 */
export function listAllDeploys({ site, api = netlifyApi, maxPages = 50 } = {}) {
  if (!site) throw new Error("listAllDeploys: no site id — refusing to scan an unknown site");
  const byId = new Map();
  let pages = 0;
  let exhausted = false;
  for (let page = 1; page <= maxPages; page++) {
    const batch = api("listSiteDeploys", { site_id: site, per_page: PAGE_SIZE, page });
    pages = page;
    if (!Array.isArray(batch)) throw new Error(`listAllDeploys: page ${page} was not an array`);
    for (const d of batch) if (d?.id) byId.set(d.id, d);
    // A short page means there is nothing after it. An exactly-full page is ambiguous, so we ask
    // for the next one and let an empty response settle it.
    if (batch.length < PAGE_SIZE) { exhausted = true; break; }
  }
  return { deploys: [...byId.values()], pages, exhausted };
}
