#!/usr/bin/env node
// verify-guards-owed.mjs — WHICH DELIBERATELY-UNWIRED GUARDS ARE OWED A RUN?
//
//   npm run guards:owed                      # against what PRODUCTION serves (the default)
//   npm run guards:owed -- --against HEAD    # against the working tree instead
//   npm run guards:owed -- --json
//
// ═══ ⚠️ WHY "AGAINST PRODUCTION" IS THE DEFAULT AND NOT A DETAIL ══════════════════════════════
// Every path-triggered guard here asserts something about the SERVED artifact — the bundle
// production returns, the live 402, the published page. So the question is never "did I edit
// ManualSwapPanel", it is "did a DEPLOY carry a change to ManualSwapPanel since this guard last
// ran". Diffing against HEAD would raise every trigger the moment work started and leave it raised,
// unclearable, until the deploy — an alert that fires on routine work is one nobody reads, and this
// repo has now recorded that failure three times.
//
// ⭐ SO THE TARGET IS WHAT PRODUCTION SERVES, asked of production. `--against HEAD` answers the
// different (also useful) question "what WILL be owed once I ship this"; `--against stamp` reads
// the local build stamp and is kept only for offline use.
//
// 🚨 DO NOT "OPTIMISE" THIS BACK TO THE BUILD STAMP. That is what the first version did, calling it
// "the deployed commit". It is not one: `npm run stamp` rewrites it to HEAD, and `test:dd` re-stamps
// as a side effect of running tests. MEASURED 2026-09-10 — stamp `46abc3d`, production `d2cad68`.
// The cheap local read gives a confidently wrong answer to this exact question.
//
// ═══ ⛔ THIS IS A REPORT, NOT A GATE — DELIBERATELY, AND THE REASON IS THE POINT ═══════════════
// It is not in `test:all` and not in `deploy:prod`. Wiring it into either turns "a live check is
// owed" into "the build is broken", and the two are not the same: a guard is owed at the moment a
// deploy lands, which is exactly when nothing can be done about it yet.
//
// ⭐ WHAT **IS** ENFORCED, in `gate:registry` inside `test:all`: that every exemption declares a
// trigger, and that the trigger is actionable. The DECLARATION is machine-checkable and blocking;
// whether a human ran the live thing is reported. Making that split explicit is better than a gate
// that everyone learns to ignore.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { UNWIRED_OK, UNWIRED_TRIGGERS } from "./guard-registry.mjs";
import { parseRunLog, owedFor, OWED } from "./lib/guard-staleness.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const flag = (f, d = null) => { const i = argv.indexOf(`--${f}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d; };
const AS_JSON = has("json");
const AGAINST = flag("against", "deployed");   // deployed | stamp | HEAD
const PROBE_URL = "https://app.tikpema.xyz/.netlify/functions/blobs-probe";

const LOG_PATH = new URL("../unwired-guard-runs.jsonl", import.meta.url).pathname;

/**
 * The commit to diff TO.
 *
 * 🚨 IT MUST BE WHAT PRODUCTION SERVES — AND THE LOCAL BUILD STAMP IS NOT THAT. The first version
 * of this file read `shared/build-stamp.generated.mjs` and called it "the deployed commit". It is
 * not: `npm run stamp` rewrites it to whatever HEAD is, and any `test:dd` run re-stamps it as a
 * side effect. MEASURED here on 2026-09-10 — the stamp said `46abc3d` while production served
 * `d2cad68`, two commits behind. Diffing against it would have raised triggers for work that was
 * merely COMMITTED, which is precisely the unclearable nag the deploy-scoping exists to prevent.
 *
 * ⭐ So the default asks production directly, through the same read-only probe `gate:deployed`
 * uses. `--against stamp` keeps the old (local, cheap, WRONG-for-this-question) source available
 * for offline use, and says what it is. `--against HEAD` answers "what WILL be owed once I ship".
 *
 * ⚠️ `null` on any failure, never a fallback to a different commit. An unreachable probe makes
 * every path trigger UNDETERMINED, which reads as owed — the fail-closed direction.
 */
async function targetCommit() {
  if (AGAINST === "HEAD" || AGAINST === "stamp") {
    if (AGAINST === "HEAD") {
      try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 15_000 }).trim(); }
      catch { return null; }
    }
    try {
      const src = readFileSync(new URL("../shared/build-stamp.generated.mjs", import.meta.url), "utf8");
      return src.match(/"commit":\s*"([0-9a-f]{40})"/)?.[1] ?? null;
    } catch { return null; }
  }
  try {
    const res = await fetch(PROBE_URL, { signal: AbortSignal.timeout(30_000), headers: { "cache-control": "no-cache" } });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j?.build?.commit === "string" ? j.build.commit : null;
  } catch { return null; }
}

/**
 * Files a DEPLOY carried since the guard last ran. `null` when the range cannot be resolved.
 *
 * ⭐⭐ THE ANCESTRY CHECK IS NOT A DETAIL. Production is frequently BEHIND the commit a guard ran
 * at — the guard reads prod, so running it at a newer local commit is normal and correct. A plain
 * two-dot diff in that situation returns the REVERSE changes, non-empty, and every path trigger
 * would fire on work that has not shipped. So: if nothing is reachable from the deployed commit
 * that was not already reachable at the run commit, NOTHING WAS DEPLOYED SINCE, and the guard is
 * current by definition. [[git-history-needs-a-reachability-query]]
 */
function changedSinceDeployed(from, to) {
  if (!from || !to) return null;
  try {
    const ahead = execFileSync("git", ["rev-list", "--count", `${from}..${to}`], { encoding: "utf8", timeout: 30_000 }).trim();
    if (ahead === "0") return [];              // prod is at or behind the run commit — nothing shipped since
    const out = execFileSync("git", ["diff", "--name-only", `${from}..${to}`], { encoding: "utf8", timeout: 30_000 });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    // An unreachable commit (rewritten history, shallow clone, a run recorded on another machine).
    // owedFor treats null as OWED/undetermined, which is the fail-closed direction.
    return null;
  }
}

let ledgerText = null;
try { ledgerText = readFileSync(LOG_PATH, "utf8"); } catch { /* absent — reported below */ }
const parsed = parseRunLog(ledgerText);
const runs = parsed.ok ? parsed.runs : new Map();

const to = await targetCommit();
const now = Date.now();

const rows = Object.keys(UNWIRED_OK).map((name) => {
  const trigger = UNWIRED_TRIGGERS[name] ?? {};
  const lastRun = runs.get(name) ?? null;
  const changed = lastRun ? changedSinceDeployed(lastRun.commit, to) : null;
  return { name, trigger, lastRun, verdict: owedFor({ trigger, lastRun, changedPaths: changed, now }) };
});

const owed = rows.filter((r) => r.verdict.owed);

if (AS_JSON) {
  console.log(JSON.stringify({ against: AGAINST, target: to, ledger: parsed.ok ? { lines: parsed.lines, skipped: parsed.skipped } : { error: parsed.why }, rows }, null, 2));
} else {
  console.log("\nguards:owed — deliberately-unwired guards, and whether one is due\n");
  console.log(`  base: last recorded run per guard   ·   target: ${AGAINST}${to ? ` ${to.slice(0, 12)}` : " UNRESOLVED"}`);
  if (!parsed.ok) console.log(`  ⚠️ ${parsed.why}`);
  else if (parsed.skipped) console.log(`  ⚠️ ${parsed.skipped} unparseable ledger line(s) skipped`);
  console.log("");
  for (const r of rows) {
    const mark = r.verdict.owed ? "🔴 OWED " : "✅ ok   ";
    console.log(`  ${mark} ${r.name.padEnd(22)} ${r.verdict.detail}`);
    if (r.verdict.owed && r.verdict.reason === OWED.NEVER_RUN) {
      console.log(`             ↳ run: npm run ${r.name}   (${r.trigger.subject ?? "no subject declared"})`);
    }
  }
  console.log("");
  console.log(owed.length === 0
    ? `  ✅ nothing owed — all ${rows.length} unwired guards are current`
    : `  🔴 ${owed.length} of ${rows.length} owed: ${owed.map((r) => r.name).join(", ")}`);
  // ⛔ Never-run is called out separately: it is the only reason that means "this has NEVER been
  // verified", as opposed to "it was verified and something moved since".
  const never = owed.filter((r) => r.verdict.reason === OWED.NEVER_RUN);
  if (never.length) console.log(`  ⚠️ ${never.length} have NEVER been recorded as run — not "clean", UNVERIFIED.`);
  console.log("");
}

// ⭐ Exit code is informational and the caller is told so: 0 = nothing owed, 1 = something is.
// Nothing chains on this today (see the header) — it is here so a future cron or a human's `&&`
// gets a real signal rather than having to grep prose.
process.exit(owed.length > 0 ? 1 : 0);
