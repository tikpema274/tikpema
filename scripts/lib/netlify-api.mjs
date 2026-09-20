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

export function netlifyApi(method, payload, { timeoutMs = 90_000 } = {}) {
  const stdout = execFileSync("npx", ["netlify", "api", method, "--data", JSON.stringify(payload)], {
    encoding: "utf8",
    timeout: timeoutMs,
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
// ═══ ⭐ RETRY, BOUNDED, TRANSIENT-ONLY (2026-09-20) ══════════════════════════════════════════════
// Twice in three deploy:prod runs the listing died with `spawnSync npx ETIMEDOUT` at the 90 s per-call
// ceiling. Exit 2 was CORRECT — a sweep that cannot see is not a sweep that found nothing — but the chain
// died before stage:ledger and left the two ledgers out of step. So each PAGE call is retried:
//   · bound: 3 attempts per page. Per-attempt timeouts escalate 90 s → 180 s → 300 s; backoff 5 s → 20 s
//     between them. Worst case for one page ≈ 10 min, after which the API is genuinely unreachable — and
//     one page exhausting its attempts fails the WHOLE listing (there is no partial count).
//   · transient ONLY: ETIMEDOUT / ECONNRESET / EAI_AGAIN / socket hang up / HTTP 429 and 5xx. A 401, an
//     ENOBUFS, a non-array page are thrown at once — retrying a wrong request is just slower wrongness.
//   · ⛔ EXHAUSTION STILL THROWS, naming the attempts and the last error. A retry makes the MEASUREMENT
//     more likely to succeed; it must never turn "could not measure" into "0 new". The caller reads a
//     thrown error as exit 2 exactly as before.
// `retries` on the result is the number of extra attempts across all pages (0 = measured first time).
export const RETRY = Object.freeze({ maxAttempts: 3, timeoutsMs: [90_000, 180_000, 300_000], backoffMs: [5_000, 20_000] });
const TRANSIENT = /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|socket hang up|\b(429|500|502|503|504)\b/i;
export const isTransient = (e) => TRANSIENT.test(String(e?.code ?? "")) || TRANSIENT.test(String(e?.message ?? ""));
const blockingSleep = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function listAllDeploys({ site, api = netlifyApi, maxPages = 50, sleep = blockingSleep, retry = RETRY } = {}) {
  if (!site) throw new Error("listAllDeploys: no site id — refusing to scan an unknown site");
  const byId = new Map();
  let pages = 0;
  let exhausted = false;
  let retries = 0;
  const fetchPage = (page) => {
    let last = null;
    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      try {
        return api("listSiteDeploys", { site_id: site, per_page: PAGE_SIZE, page }, { timeoutMs: retry.timeoutsMs[Math.min(attempt, retry.timeoutsMs.length) - 1] });
      } catch (e) {
        last = e;
        if (!isTransient(e) || attempt === retry.maxAttempts) break;
        retries++;
        sleep(retry.backoffMs[Math.min(attempt, retry.backoffMs.length) - 1]);
      }
    }
    const attempts = isTransient(last) ? retry.maxAttempts : 1;
    throw Object.assign(new Error(`listAllDeploys: page ${page} failed after ${attempts} attempt${attempts === 1 ? "" : "s"} — last error: ${String(last?.message ?? last).split("\n")[0]}`), { cause: last, attempts });
  };
  for (let page = 1; page <= maxPages; page++) {
    const batch = fetchPage(page);
    pages = page;
    if (!Array.isArray(batch)) throw new Error(`listAllDeploys: page ${page} was not an array`);
    for (const d of batch) if (d?.id) byId.set(d.id, d);
    // A short page means there is nothing after it. An exactly-full page is ambiguous, so we ask
    // for the next one and let an empty response settle it.
    if (batch.length < PAGE_SIZE) { exhausted = true; break; }
  }
  return { deploys: [...byId.values()], pages, exhausted, retries, maxAttempts: retry.maxAttempts };
}

/**
 * The three outcomes a gate prints, kept distinct on purpose:
 *   measured                — first time, count follows
 *   measured-after-retries  — count follows, AND how many extra attempts it took (a transient API is a fact
 *                             worth a line in the ledger's terminal output)
 *   unmeasurable            — the reason; NO count exists and none is printed
 */
export function describeListing(listing, error = null) {
  if (error || !listing) return { kind: "unmeasurable", text: `could not list deploys — ${String(error?.message ?? error ?? "no listing").split("\n")[0]}` };
  if (listing.retries > 0) return { kind: "measured-after-retries", text: `measured after ${listing.retries} retr${listing.retries === 1 ? "y" : "ies"} (transient API failures; bound ${listing.maxAttempts} attempts per page)`, retries: listing.retries };
  return { kind: "measured", text: "measured", retries: 0 };
}
