#!/usr/bin/env node
// verify-deploy-loss-sweep.mjs — the deploy-loss sweep, tested by calling.
//
//   node scripts/verify-deploy-loss-sweep.mjs   (also: npm run test:sweep)
//
// ⭐⭐ THE LOAD-BEARING TEST IS §1: the sweep must NEVER cancel, delete or mutate. That is not
// checked by grepping the source for "cancel" — a source grep has the blind spot it was written to
// close, already a recorded lesson here. It is checked by handing the sweep an API that THROWS on
// any method outside a read allowlist, and running the real code path through it.
//
// ⚠️ NO WALL CLOCK ANYWHERE. `now` is injected. A Date.now()-relative fixture fails at every commit
// once the clock passes its boundary, which is exactly how a phantom defect appeared on 2026-08-15.

import { listAllDeploys, PAGE_SIZE } from "./lib/netlify-api.mjs";
import {
  classifyDeployLosses, formatReport, LIMBO_STATES, KNOWN_PRESERVED,
  DEFAULT_MIN_AGE_HOURS, ZERO_BASELINE_AT, LONGEST_OBSERVED_DEPLOY_MINUTES,
} from "./lib/deploy-loss-sweep.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DEPLOY-LOSS SWEEP — it counts, it never cleans                      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const H = 3600_000;
const at = (msAgo, over = {}) => ({
  id: over.id ?? `d${msAgo}`, state: "new", context: "production",
  created_at: new Date(NOW - msAgo).toISOString(),
  updated_at: new Date(NOW - msAgo).toISOString(), ...over,
});

section("1 — ⭐⭐ IT CANNOT MUTATE: A READ-ONLY API, ENFORCED");
{
  // Anything outside this list is a write as far as this test is concerned.
  const READ_ONLY = new Set(["listSiteDeploys", "getDeploy", "getSiteDeploy"]);
  const called = [];
  const guardedApi = (method, payload) => {
    called.push(method);
    if (!READ_ONLY.has(method)) throw new Error(`MUTATION ATTEMPTED: ${method}`);
    return payload.page === 1 ? [at(20 * H), at(1 * H)] : [];
  };
  const listing = listAllDeploys({ site: "site-1", api: guardedApi });
  const res = classifyDeployLosses(listing.deploys, { now: NOW });
  ok("⭐⭐ a full sweep completes without calling ANY mutating method",
    called.length > 0 && called.every((m) => READ_ONLY.has(m)), `called: ${[...new Set(called)].join(", ")}`);
  ok("  …and it still produced a real count", res.counts.losses === 1, `${res.counts.losses} lost`);
  ok("  cancelSiteDeploy/deleteDeploy are never among them",
    !called.some((m) => /cancel|delete|update|restore|rollback|lock/i.test(m)));
}

section("2 — ⚠️ UNFILTERED AND PAGED TO EXHAUSTION");
{
  const pagesSeen = [];
  const api = (_m, p) => {
    pagesSeen.push(p);
    if (p.page === 1) return Array.from({ length: PAGE_SIZE }, (_, i) => at(30 * H, { id: `p1-${i}` }));
    if (p.page === 2) return Array.from({ length: PAGE_SIZE }, (_, i) => at(30 * H, { id: `p2-${i}` }));
    if (p.page === 3) return [at(30 * H, { id: "p3-0" })];
    return [];
  };
  const r = listAllDeploys({ site: "s", api });
  ok("⭐ it pages until the API returns a short page", r.pages === 3 && r.exhausted === true);
  ok("  …and collects every record across pages", r.deploys.length === 201, `${r.deploys.length}`);
  ok("⭐⭐ per_page is ALWAYS explicit — never the API's default",
    pagesSeen.every((p) => p.per_page === PAGE_SIZE), `per_page=${PAGE_SIZE} on all ${pagesSeen.length} calls`);
  ok("  …and it never scopes to deploys newer than the published one",
    pagesSeen.every((p) => !("published_at" in p) && !("state" in p) && !("branch" in p)),
    "the exact filtering that hid 36 records for six weeks");
  ok("duplicate ids across pages collapse, they do not double-count",
    listAllDeploys({ site: "s", api: (_m, p) => (p.page === 1 ? [at(30 * H, { id: "same" })] : []) }).deploys.length === 1);
}

section("3 — 🚨 A CAPPED SCAN IS A FLOOR, AND SAYS SO");
{
  // ⚠️ NO SILENT CAPS. A truncated scan reporting "3 lost" reads exactly like a complete one.
  const alwaysFull = (_m, p) => Array.from({ length: PAGE_SIZE }, (_, i) => at(30 * H, { id: `${p.page}-${i}` }));
  const r = listAllDeploys({ site: "s", api: alwaysFull, maxPages: 4 });
  ok("⭐⭐ hitting the page cap reports exhausted:false", r.exhausted === false && r.pages === 4);
  const lines = formatReport(classifyDeployLosses(r.deploys, { now: NOW }), { exhausted: r.exhausted, pages: r.pages });
  ok("  …and the report says the number is a FLOOR, not a total",
    lines.some((l) => /FLOOR, not a total/.test(l)) && lines.some((l) => /NOT EXHAUSTED/.test(l)));
  ok("refusing to scan an unknown site throws rather than returning empty", (() => {
    try { listAllDeploys({ site: null, api: alwaysFull }); return false; } catch { return true; }
  })(), "an empty result would read as \"nothing lost\"");
}

section("4 — ⭐ AGE: GENEROUS ON PURPOSE, AND WHY IT DIFFERS FROM CHECK 5");
{
  const deploys = [at(7 * H, { id: "old" }), at(2 * H, { id: "young" })];
  const r = classifyDeployLosses(deploys, { now: NOW });
  ok(`⭐ the default threshold is ${DEFAULT_MIN_AGE_HOURS}h, not minutes`, DEFAULT_MIN_AGE_HOURS === 6);
  ok("⭐⭐ …which is >10× the longest real deploy ever observed here",
    DEFAULT_MIN_AGE_HOURS * 60 > LONGEST_OBSERVED_DEPLOY_MINUTES * 10,
    `${DEFAULT_MIN_AGE_HOURS}h vs ${LONGEST_OBSERVED_DEPLOY_MINUTES}min — no real deploy runs that long`);
  ok("a deploy past the threshold is counted", r.losses.some((x) => x.id === "old"));
  ok("⭐ one below it is NOT counted — it may still be running", !r.losses.some((x) => x.id === "young"));
  ok("  …but it is not dropped either; it is surfaced as too-young",
    r.counts.tooYoung === 1 && r.tooYoung[0].id === "young",
    "the sweep undercounts the present and never miscounts the past");
  const later = classifyDeployLosses(deploys, { now: NOW + 5 * H });
  ok("⭐⭐ the too-young one is counted by a LATER run — recall is preserved over time",
    later.counts.losses === 2);
  ok("the threshold is adjustable without touching the code", classifyDeployLosses(deploys, { now: NOW, minAgeHours: 1 }).counts.losses === 2);
}

section("5 — ⭐ `uploading` IS COUNTED SEPARATELY FROM `new`");
{
  // 6a5a0230… died 12.5 minutes IN, during the upload — the only one of the 36 whose updated_at
  // moved. Folding it into `new` erases the one example of that failure mode.
  const real = {
    id: "6a5a0230d556905d8ebd9efd", state: "uploading", context: "production",
    created_at: "2026-07-17T10:21:36.122Z", updated_at: "2026-07-17T10:34:09.128Z",
  };
  const r = classifyDeployLosses([real, at(30 * H, { id: "n1" })], { now: NOW });
  ok("⭐ both states are recognised as limbo", LIMBO_STATES.join(",") === "new,uploading");
  ok("⭐⭐ they are counted SEPARATELY, not merged",
    r.counts.byState.uploading === 1 && r.counts.byState.new === 1);
  ok("  the real 12.5-minute upload death is classified as lost", r.losses.some((x) => x.id === real.id));
  ok("⭐ …and is correctly NOT flagged never-touched — its updated_at moved",
    r.losses.find((x) => x.id === real.id).neverTouched === false,
    "the one record of the 36 that died at a different point in the deploy");
  ok("a `new` record with updated_at == created_at IS flagged never-touched",
    r.losses.find((x) => x.id === "n1").neverTouched === true);
  ok("the report prints the two states separately",
    formatReport(r, {}).some((l) => /new:1 uploading:1/.test(l)));
}

section("6 — ⭐ THE ZERO BASELINE MAKES NEW LOSSES ATTRIBUTABLE");
{
  const before = { ...at(0), id: "pre", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" };
  const after = { ...at(0), id: "post", created_at: "2026-08-18T00:00:00.000Z", updated_at: "2026-08-18T00:00:00.000Z" };
  const r = classifyDeployLosses([before, after], { now: NOW });
  ok(`the baseline is the verified-zero instant (${ZERO_BASELINE_AT})`, ZERO_BASELINE_AT.startsWith("2026-08-15T21:"));
  ok("⭐ a loss created after it counts as NEW", r.counts.sinceBaseline === 1 && r.losses.find((x) => x.id === "post").sinceBaseline === true);
  ok("⭐⭐ one predating it is flagged as UNACCOUNTED, not silently mixed in",
    r.counts.unaccounted === 1 && r.losses.find((x) => x.id === "pre").sinceBaseline === false);
  ok("  …and the report says nobody has accounted for it",
    formatReport(r, {}).some((l) => /nobody has accounted for these/.test(l)),
    "a pre-baseline record outside the known 23 is a genuine surprise");
}

section("6b — ⭐⭐ THE 23 SURVIVORS: A NAMED QUANTITY, NOT A RECURRING ALARM");
{
  // 🚨 THE MISS THIS ENCODES. The baseline claimed 0 abandoned deploys across 300 records — measured
  // with a 3-page cap, hours after writing an entry condemning per_page:25 filtered reads. The site
  // has 437. Paging to exhaustion found 23 more, one page past where that scan stopped.
  const survivor = { id: "6a3c36e7d7b443b06960c0bd", state: "new", context: "production",
                     created_at: "2026-06-24T19:58:31.047Z", updated_at: "2026-06-24T19:58:31.047Z" };
  const fresh = { id: "brand-new", state: "new", context: "production",
                  created_at: "2026-08-19T00:00:00.000Z", updated_at: "2026-08-19T00:00:00.000Z" };
  ok("⭐ all 23 survivors are named explicitly, not matched by a date range", KNOWN_PRESERVED.size === 23);

  const only = classifyDeployLosses([survivor], { now: NOW });
  ok("⭐⭐ a site holding ONLY the known survivors reports ZERO losses",
    only.counts.losses === 0 && only.counts.preserved === 1,
    "a monitor that reports the same 23 forever is one people stop reading");
  ok("  …and they are still counted as limbo, never made invisible", only.counts.limbo === 1);
  ok("  …and the report names them as deliberately uncancelled evidence",
    formatReport(only, {}).some((l) => /known survivor/.test(l)) &&
    formatReport(only, {}).some((l) => /uncontaminated evidence/.test(l)));

  const mixed = classifyDeployLosses([survivor, fresh], { now: NOW });
  ok("⭐⭐ a NEW loss beside them is still reported — the exclusion never masks one",
    mixed.counts.losses === 1 && mixed.losses[0].id === "brand-new" && mixed.counts.sinceBaseline === 1);
  ok("  …and the survivor is not double-counted into it", mixed.counts.preserved === 1);
}

section("7 — AMBIGUITY IS REPORTED, NEVER INFERRED");
{
  const canceled = { id: "c1", state: "error", error_message: "Deploy canceled", context: "production",
                     created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T01:00:00.000Z" };
  const realErr = { id: "e1", state: "error", error_message: "Incorrect function names.", context: "production",
                    created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:10:00.000Z" };
  const r = classifyDeployLosses([canceled, realErr, at(30 * H, { id: "n" })], { now: NOW });
  ok("⭐⭐ `Deploy canceled` is NOT counted as a loss — it is ambiguous by construction",
    r.counts.losses === 1 && r.counts.ambiguousCanceled === 1,
    "since 2026-08-15 a cancelled orphan is indistinguishable from a deliberate cancel");
  ok("  …but it IS surfaced, so the ambiguity is visible rather than hidden",
    formatReport(r, {}).some((l) => /AMBIGUOUS by construction/.test(l)));
  ok("a genuine build error is neither a loss nor counted as cancelled", r.counts.ambiguousCanceled === 1);
}

section("8 — THE MEASUREMENT REFUSES TO GUESS");
{
  ok("⭐ an uninjected clock throws rather than defaulting to now", (() => {
    try { classifyDeployLosses([], {}); return false; } catch { return true; }
  })());
  const bad = { id: "b", state: "new", context: "production", created_at: "not-a-date", updated_at: null };
  const r = classifyDeployLosses([bad], { now: NOW });
  ok("⭐⭐ an unparseable created_at is COUNTED, not silently dropped", r.counts.losses === 1,
    "a record that cannot be aged must not vanish into a total that reads as complete");
  ok("  …with its age reported as null rather than a fabricated number", r.losses[0].ageHours === null);
  ok("  …and its baseline side left null rather than assumed", r.losses[0].sinceBaseline === null);
  const clean = classifyDeployLosses([{ id: "r", state: "ready", created_at: "2026-08-18T00:00:00.000Z" }], { now: NOW });
  ok("a clean site reports zero and says so plainly",
    clean.counts.losses === 0 && formatReport(clean, {}).some((l) => /0 NEW abandoned deploys/.test(l)));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
