// deploy-loss-sweep.mjs — COUNT the deploys that were silently lost. Never touch them.
//
// ═══ 🚨 WHY THIS EXISTS ══════════════════════════════════════════════════════════════════════
// `deploy:prod` loses deploys. A killed CLI leaves a record at `new` with `error_message: null`,
// `required: []` and `updated_at == created_at` — indistinguishable from a success at the place a
// human looks. verify-deployed's check 5 catches that for the deploy you JUST ran.
//
// It cannot catch the class. Check 5 scopes to deploys newer than the published one, so the moment
// a good deploy publishes, every earlier corpse goes invisible. On 2026-08-15 an unfiltered scan
// found 36 of them — 27 production, 9 deploy-preview — going back to 2026-07-01, the API's reach.
// Six weeks of losses that every previous look was structurally unable to see.
//
// ═══ ⭐⭐ CONSTRAINT 1: IT REPORTS. IT DOES NOT CLEAN. ═════════════════════════════════════════
// This module NEVER cancels, deletes, retries or mutates anything. That is not squeamishness — it
// is the whole point. Cancelling the 36 on 2026-08-15 stamped them `Deploy canceled`, which is
// exactly what a deliberate human cancellation looks like, so the deploy list can no longer be
// used to count this class at all. An auto-remediating sweep would repeat that evidence loss ON A
// SCHEDULE and permanently destroy the ability to measure the thing it was built to watch.
//
// ⭐ The guarantee is enforced by INJECTION, not by a comment or a source grep: `api` is a
// parameter, and verify-deploy-loss-sweep.mjs passes one that throws on any non-read method. The
// promise is therefore tested by CALLING, the way `errorWithPayload` was.
//
// ═══ ⭐ CONSTRAINT 3: AGE IS THE RIGHT INSTRUMENT HERE — AND WRONG IN CHECK 5 ═════════════════
// 🚨 DO NOT "CORRECT" THIS TO MATCH check 5. They answer different questions and the difference is
// physical, not stylistic:
//
//   check 5 judges ONE deploy, in real time, ON THE MACHINE THAT RAN IT. Liveness evidence is
//   available there — /proc/stat's btime, a process table — so an elapsed-time guess would be a
//   proxy standing in for evidence that is sitting right there. It needs PRECISION: a false
//   ORPHANED costs a redundant 26-minute deploy, and it is judging a deploy that may still be alive.
//
//   this sweep counts a POPULATION over time, from wherever it happens to run — a cron box, CI,
//   another laptop. Both liveness tests are MACHINE-LOCAL and simply do not exist here: there is no
//   /proc for the machine that ran a deploy three weeks ago, and its process table is long gone.
//   It needs RECALL, and age is not a proxy for anything — it IS the measurement.
//
// ⚠️ A GENEROUS THRESHOLD HAS NO FALSE POSITIVES, because no real deploy runs that long. The
// longest observed real deploy in this repo is ~26 minutes (2026-08-15, 20:36:07Z → 21:02:28Z,
// ~60 functions bundled by esbuild). The default below is 6 hours — roughly 14× that. A deploy
// sitting in `new` for six hours is not slow; it is dead.
//
// ⚠️ THE ONLY THING THE THRESHOLD COSTS IS THE MOST RECENT WINDOW. A deploy that died an hour ago
// is not counted until it ages past the threshold, and is then counted by the next run. The sweep
// therefore UNDERCOUNTS the present and never miscounts the past — the correct direction for a
// population counter, and the reason a short threshold would buy nothing.

/** No real deploy runs this long. See the reasoning above before changing it. */
export const DEFAULT_MIN_AGE_HOURS = 6;

/** Longest real deploy actually observed in this repo, for anyone re-deriving the threshold. */
export const LONGEST_OBSERVED_DEPLOY_MINUTES = 26;

/**
 * ⭐ THE BASELINE. On 2026-08-15, 36 abandoned deploys were cancelled and a re-listing confirmed 0
 * remaining. Anything created after this instant is a NEW loss, cleanly attributable — not backlog.
 *
 * 🚨 AND THE BASELINE WAS WRONG WHEN IT WAS WRITTEN — THIS SWEEP'S FIRST REAL RUN PROVED IT.
 * "0 remaining" was measured over 300 deploys across 3 pages, which was assumed to be the whole
 * history because the oldest record it returned was 2026-07-01. The site actually has 437 deploys.
 * Paging to EXHAUSTION found 23 more abandoned production deploys, 2026-06-24 → 2026-06-28, sitting
 * one page past where the scan stopped.
 *
 * ⭐⭐ THE SCAN THAT DIAGNOSED A FILTERED READ WAS ITSELF A FILTERED READ. The entry written hours
 * earlier says "a filtered read is not a measurement of absence" and names per_page:25 as the thing
 * that hid 36 records for six weeks — and then established its own baseline with a 3-page cap and
 * called it the site's history. A cap you chose yourself is still a filter; "the oldest record I saw
 * is 2026-07-01" is not "the site began on 2026-07-01". This is the single strongest argument for
 * why listAllDeploys pages to exhaustion and reports `exhausted` rather than trusting a page count.
 */
export const ZERO_BASELINE_AT = "2026-08-15T21:20:00.000Z";

/**
 * ⭐ THE 23 SURVIVORS — DELIBERATELY NOT CANCELLED, AND THEREFORE THE ONLY UNCONTAMINATED EVIDENCE
 * OF THIS CLASS THAT STILL EXISTS. Cancelling the first 36 stamped them `Deploy canceled`, which is
 * indistinguishable from a human cancelling on purpose; these were found afterwards, under a
 * report-do-not-clean rule, so they were left exactly as they died: `new`, `error_message: null`,
 * `updated_at == created_at`. Every one is production, every one never touched its own record.
 *
 * ⚠️ THEY ARE EXCLUDED FROM THE LOSS COUNT ON PURPOSE. A monitor that reports the same 23 forever
 * is a monitor people learn to ignore, and then it is worth nothing on the day the number changes.
 * They are reported as a standing, named quantity instead. Anything pre-baseline that is NOT in this
 * set is a genuine surprise and is escalated separately.
 */
export const KNOWN_PRESERVED = new Set([
  "6a3c36e7d7b443b06960c0bd", "6a3c3af8b62618c4704ce4a3", "6a3c4081e8107cd27a44a774", // 2026-06-24
  "6a3c453ae0273fe7356fbf8c",
  "6a3e58a44955d8122611bc63", "6a3e594cddec2f1a4acb1618", "6a3e59faa99287199b63c29d", // 2026-06-26
  "6a3e5a204699361a028e2153", "6a3ebe9acca1355fa84b4538", "6a3ec6053216d388058085a4",
  "6a3ec6f0659bb47f527d2129",
  "6a3fcd290d9c9d113d87221f", "6a3fd32faacb1886be037059", "6a3fd3bc41f5137a5a7bc85c", // 2026-06-27
  "6a3fd45a78eb7b89deb4d2f0",
  "6a40f9e7d1fce024c1baaa5d", "6a41244a042c98a70b0da818", "6a4125b8bcfb3fa0094b6425", // 2026-06-28
  "6a4126cd48c463b5d94de56f", "6a41272e990f1cb48540f295", "6a41285ad1fce0bb48baa9c2",
  "6a412b2df430d4b31d34108f", "6a412cf6bcfb3fb49b4b6433",
]);

/**
 * ⭐ CONSTRAINT 4: `uploading` IS ITS OWN CLASS, COUNTED SEPARATELY.
 * `new` is a CLI killed before it could touch its own record. `uploading` is a CLI killed with the
 * upload already in progress — a second death at a second point in the deploy. 6a5a0230d556905d…
 * was created 2026-07-17T10:21:36Z and last touched 10:34:09Z: it died 12.5 minutes in, and it is
 * the only record of the 36 whose `updated_at` differs from its `created_at`. Folding it into `new`
 * would have erased the one example of a failure mode nothing else in the tooling had a name for.
 */
export const LIMBO_STATES = ["new", "uploading"];

const HOUR_MS = 3600_000;

/**
 * Count what was lost. Pure over its inputs — no clock, no network, no mutation.
 *
 * @param {object[]} deploys      every deploy, unfiltered (see listAllDeploys)
 * @param {number}   now          epoch ms, injected — never Date.now() in here
 * @param {number}   minAgeHours  below this age a record is too young to judge
 * @param {string}   baselineAt   ISO instant of the zero baseline
 */
export function classifyDeployLosses(deploys, { now, minAgeHours = DEFAULT_MIN_AGE_HOURS, baselineAt = ZERO_BASELINE_AT } = {}) {
  if (!Number.isFinite(now)) throw new Error("classifyDeployLosses: `now` must be injected as epoch ms");
  const cutoff = now - minAgeHours * HOUR_MS;
  const baselineMs = Date.parse(baselineAt);

  const limbo = [];
  const tooYoung = [];
  for (const d of deploys) {
    if (!LIMBO_STATES.includes(d?.state)) continue;
    const createdMs = Date.parse(d?.created_at ?? "");
    // ⚠️ An unparseable timestamp is NOT quietly dropped — it cannot be aged, so it is surfaced as
    // its own bucket rather than vanishing into a count that reads as complete.
    const rec = {
      id: d.id,
      state: d.state,
      context: d.context ?? null,
      created_at: d.created_at ?? null,
      updated_at: d.updated_at ?? null,
      ageHours: Number.isFinite(createdMs) ? +((now - createdMs) / HOUR_MS).toFixed(2) : null,
      // The killed-instantly signature: 35 of the 36 found on 2026-08-15 carried it.
      neverTouched: d.created_at != null && d.created_at === d.updated_at,
      sinceBaseline: Number.isFinite(createdMs) && Number.isFinite(baselineMs) ? createdMs > baselineMs : null,
      preserved: KNOWN_PRESERVED.has(d.id),
    };
    if (!Number.isFinite(createdMs) || createdMs <= cutoff) limbo.push(rec);
    else tooYoung.push(rec);
  }

  // ⭐ THE ACTIONABLE NUMBER. The 23 known survivors are a fixed, named quantity; everything else in
  // limbo is a loss somebody needs to look at. Keeping them apart is what stops this from becoming a
  // monitor that reports the same figure forever and is therefore never read.
  const losses = limbo.filter((r) => !r.preserved);
  const preserved = limbo.filter((r) => r.preserved);
  // ⚠️ Pre-baseline AND not in the known set = a record nobody has accounted for. Its own bucket.
  const unaccounted = losses.filter((r) => r.sinceBaseline === false);

  const byState = {};
  for (const s of LIMBO_STATES) byState[s] = losses.filter((r) => r.state === s).length;
  const byContext = {};
  for (const r of losses) byContext[r.context ?? "unknown"] = (byContext[r.context ?? "unknown"] ?? 0) + 1;

  // ⚠️ `Deploy canceled` is reported but NOT counted as loss. After 2026-08-15 it is ambiguous by
  // construction: a cancelled orphan and a deliberate human cancellation are now identical. Saying
  // so is the honest move; inferring either way would be fabrication.
  const canceled = deploys.filter((d) => d?.state === "error" && d?.error_message === "Deploy canceled").length;

  return {
    scanned: deploys.length,
    limbo,
    losses,
    preserved,
    unaccounted,
    tooYoung,
    counts: {
      limbo: limbo.length,
      losses: losses.length,
      preserved: preserved.length,
      unaccounted: unaccounted.length,
      byState,
      byContext,
      neverTouched: losses.filter((r) => r.neverTouched).length,
      sinceBaseline: losses.filter((r) => r.sinceBaseline === true).length,
      tooYoung: tooYoung.length,
      ambiguousCanceled: canceled,
    },
    minAgeHours,
    baselineAt,
  };
}

/** Human-readable report. Returns lines; printing is the caller's business. */
export function formatReport(result, { exhausted = true, pages = 0 } = {}) {
  const c = result.counts;
  const L = [];
  L.push(`  scanned ${result.scanned} deploys over ${pages} page(s)${exhausted ? "" : "  ⚠️ NOT EXHAUSTED"}`);
  L.push(`  threshold: older than ${result.minAgeHours}h  ·  zero baseline: ${result.baselineAt}`);
  L.push("");
  if (c.losses === 0) {
    L.push("  ✅ 0 NEW abandoned deploys — nothing has been silently lost since the baseline");
  } else {
    L.push(`  🚨 ${c.losses} ABANDONED DEPLOY(S)  —  new:${c.byState.new} uploading:${c.byState.uploading}`);
    L.push(`     ${Object.entries(c.byContext).map(([k, v]) => `${k}:${v}`).join("  ")}`);
    L.push(`     ${c.neverTouched} never touched their own record (killed before they could start)`);
    L.push(`     ⭐ ${c.sinceBaseline} created SINCE the baseline — new, cleanly attributable losses`);
    if (c.unaccounted > 0) {
      L.push(`     ⚠️ ${c.unaccounted} predate the baseline and are NOT among the 23 known survivors —`);
      L.push(`        nobody has accounted for these. Investigate before treating them as backlog.`);
    }
    L.push("");
    for (const r of result.losses) {
      L.push(`     ${r.id}  ${r.state.padEnd(9)} ${r.created_at}  ${r.ageHours}h  ${r.context}${r.neverTouched ? "  never-touched" : ""}`);
    }
  }
  if (c.preserved > 0) {
    L.push("");
    L.push(`  · ${c.preserved} known survivor(s) from 2026-06-24→06-28, deliberately left uncancelled and`);
    L.push(`    NOT counted as new loss. They are the only uncontaminated evidence of this class that`);
    L.push(`    still exists — everything cancelled on 2026-08-15 now reads as a deliberate cancel.`);
  }
  if (c.tooYoung > 0) {
    L.push("");
    L.push(`  · ${c.tooYoung} non-ready deploy(s) younger than ${result.minAgeHours}h — NOT judged; may still be running.`);
    L.push(`    They are counted by a later run. The sweep undercounts the present, never the past.`);
  }
  if (c.ambiguousCanceled > 0) {
    L.push("");
    L.push(`  · ${c.ambiguousCanceled} record(s) read "Deploy canceled" — AMBIGUOUS by construction since`);
    L.push(`    2026-08-15 and deliberately NOT counted as loss. See PROGRESS.md.`);
  }
  if (!exhausted) {
    L.push("");
    L.push(`  🚨 PAGING HIT ITS CAP — this scan is a FLOOR, not a total. Re-run with --max-pages higher.`);
  }
  return L;
}
