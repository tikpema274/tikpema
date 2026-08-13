import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// verify-dca-tick-observability — the scheduler must SAY what it decided, and say it durably.
//
// ═══ 🚨 THE GAP THIS CLOSES ══════════════════════════════════════════════════════════════════
// 2026-08-13: a DCA mandate was created, sat `active` for ~10 minutes across ~10 ticks, and never
// filled. Nobody could say why. `dca-tick` had ZERO console.log statements — the only money-moving
// scheduler in the repo without one (ub-withdraw-sweep 3, bridge-mint-sweep 3, job-sweep 1).
//
// ⭐⭐ AND THE DATA EXISTED THE WHOLE TIME. `beat` records every outcome — into
// `dca-heartbeat/"last"`, ONE KEY OVERWRITTEN EVERY 60 SECONDS. The state was diagnosable for one
// minute; by the time anyone asked, ~15 ticks had overwritten the answer. THE OBSERVATION EXISTED
// AND DID NOT SURVIVE, which is a different defect from not observing — and the harder one to spot,
// because the instrumentation looks complete when you read the code.
//
// ⭐ TWO SILENT PATHS ALSO HAD TO BE CLOSED, both of which produce a number that cannot be read:
//   · `if (!decision.due) continue;` left NO trace, so a not-due mandate showed `scanned=1` and
//     nothing else — indistinguishable from a tick that examined it and inexplicably declined.
//   · the pre-scan skip made `scanned:0` ambiguous between "the store is empty" and "seven mandates
//     exist and all are cancelled". Two very different facts behind one number.
//
// ⚠️ SOURCE-STRUCTURE GUARD, AND THAT IS A REAL LIMIT: it cannot prove the deployed function logs
// anything. The behavioural proof is a deploy plus `netlify logs --source functions`.

const SRC = "netlify/functions/dca-tick.mjs";
const src = readFileSync(SRC, "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };

console.log("\n── dca-tick must say what it decided ──────────────────────────");

t("⭐⭐ it logs a decision line at all — it was the only sweeper that did not", () => {
  assert.ok(/console\.log\(/.test(code), "no console.log — the heartbeat alone lives for 60 seconds");
  assert.match(code, /\[dca-tick\]/, "the line must be greppable by function name");
});

t("⭐ the line carries every outcome counter, not just a total", () => {
  for (const k of ["total", "inactive", "unreadable", "scanned", "submitted", "fired",
                   "skipped", "failed", "stopped", "terminal", "notDue", "deferred", "errors"]) {
    assert.match(code, new RegExp(`${k}=\\$\\{beat\\.${k}\\}`), `the log line omits ${k}`);
  }
});

t("⭐⭐ NOT-DUE leaves a trace — the exact case that could not be answered", () => {
  const m = code.match(/if \(!decision\.due\) \{[\s\S]{0,400}?\}/);
  assert.ok(m, "the not-due branch is no longer a guarded block — did it revert to a bare continue?");
  assert.match(m[0], /beat\.notDue\+\+/, "not-due must be counted");
  assert.match(m[0], /decision\.reason/, "…and the REASON recorded — the count alone diagnoses nothing");
});

t("⭐⭐ `scanned:0` is disambiguated — empty store vs all-inactive vs unreadable", () => {
  assert.match(code, /beat\.total\+\+/, "without a total, scanned:0 cannot distinguish an empty store");
  assert.match(code, /beat\.inactive\+\+/, "…from every mandate being cancelled");
  assert.match(code, /beat\.unreadable\+\+/, "…and a failed GET must not masquerade as either");
});

t("⭐ the detail cap REPORTS its own truncation", () => {
  // ⚠️ A cap that hides what it dropped reads as "that was everything" — the same rule the
  // withdrawal sweeper's `remaining` follows.
  assert.match(code, /\+\$\{more\} more/, "the log must say how many details it dropped");
  assert.match(code, /beat\.details\.length < 8/, "the heartbeat's detail array must be bounded too");
});

t("the heartbeat is still written — the log ADDS to it, never replaces it", () => {
  // ⚠️ The heartbeat is what strong-read-style liveness checks read. Replacing it with a log line
  // would trade one blind spot for another.
  assert.match(code, /writeHeartbeat\(\)/, "the heartbeat write has gone missing");
  assert.ok(code.indexOf("writeHeartbeat()") < code.lastIndexOf("console.log("),
    "the heartbeat must be written BEFORE the log line, so a logging throw cannot cost the record");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-dca-tick-observability: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
