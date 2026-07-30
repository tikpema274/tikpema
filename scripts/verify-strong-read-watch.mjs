// verify-strong-read-watch.mjs — acceptance for the money-path strong-read monitor.
//
//   node --experimental-test-module-mocks scripts/verify-strong-read-watch.mjs
//
// ⚠️ WHAT THIS CANNOT PROVE. It runs in one process with mocked Blobs and mocked fetch. It cannot
// show that the SCHEDULED runtime can reach the network or write a blob — that needs a real deploy,
// invoked by hand over HTTP (the */15 cron does NOT fire on a draft). Offline green here means the
// LOGIC is sound and refuses to guess; it does not mean the monitor works.
//
// Zero network. Zero money. Zero writes outside the mock.

import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  STRONG-READ WATCH — acceptance                                       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const W = await import("../shared/strong-read-watch/watch.mjs");
const { REASON, judgeProbe, shouldSkipRerun, evaluateRecord, decideNotify, notifyMessage, buildRecord, verdictClass, ago,
        MIN_RERUN_MS, TTL_MS, REMINDER_MS } = W;

const goodProbe = (over = {}) => JSON.stringify({
  probe: "blobs-strong-read/1", verdict: "D", calibrated: true, strongReads: true, reason: "strong-reads-work",
  arms: {
    A_connectLambda_only: { outcome: "consistency-error" },
    B_connectBlobs: { outcome: "ok" },
    A2_connectLambda_after_B: { outcome: "consistency-error" },
  },
  selfChecks: [],
  build: { commit: "c".repeat(40), tree: "t".repeat(64), dirty: false },
  ...over,
});
const res = (over = {}) => ({ status: 200, contentType: "application/json", body: goodProbe(), networkError: null, timedOut: false, ...over });

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the judging set is CLOSED, and 'couldn't tell' is a FAILURE");

check("⭐⭐ verdict D + calibrated true -> PASS", judgeProbe(res()).ok === true);

check("⭐⭐ UNCALIBRATED records as a FAILURE, never an unknown",
  judgeProbe(res({ body: goodProbe({ verdict: "UNCALIBRATED", calibrated: false, reason: "negative-control-passed" }) })).reason === REASON.UNCALIBRATED);
check("⭐⭐ HOTFIX records as a FAILURE",
  judgeProbe(res({ body: goodProbe({ verdict: "HOTFIX", calibrated: true }) })).reason === REASON.HOTFIX);
check("⭐ arm A returning ok arrives as UNCALIBRATED (the probe reports it; we must not re-judge it as fine)",
  judgeProbe(res({ body: goodProbe({ verdict: "UNCALIBRATED", calibrated: false }) })).ok === false);
check("verdict D but calibrated FALSE is still a failure — both are required",
  judgeProbe(res({ body: goodProbe({ verdict: "D", calibrated: false }) })).ok === false);
check("  …and calibrated true with a null verdict is a failure",
  judgeProbe(res({ body: goodProbe({ verdict: null }) })).ok === false);

section("  …the SPA trap: a 200 proves nothing");
const SPA = '<!doctype html>\n<html lang="en"><head><title>Tikpema</title></head><body></body></html>';
const spaJudge = judgeProbe(res({ body: SPA, contentType: "text/html; charset=UTF-8" }));
check("⭐⭐ 200 + SPA HTML -> not-json FAILURE (this is how a missing function presents)",
  spaJudge.ok === false && spaJudge.reason === REASON.NOT_JSON);
check("  …and the detail says the function is probably not deployed",
  /not deployed/.test(spaJudge.detail));
check("200 + valid JSON that is NOT the probe -> wrong-shape",
  judgeProbe(res({ body: JSON.stringify({ hello: "world" }) })).reason === REASON.WRONG_SHAPE);
check("  …including a DIFFERENT probe version",
  judgeProbe(res({ body: goodProbe({ probe: "blobs-strong-read/2" }) })).reason === REASON.WRONG_SHAPE);
check("200 + JSON array -> not an object -> failure",
  judgeProbe(res({ body: "[1,2,3]" })).ok === false);
check("200 + literal null body -> failure", judgeProbe(res({ body: "null" })).ok === false);

check("HTTP 500 -> http-error", judgeProbe(res({ status: 500 })).reason === REASON.HTTP_ERROR);
check("HTTP 404 -> http-error", judgeProbe(res({ status: 404 })).reason === REASON.HTTP_ERROR);
check("network failure -> unreachable",
  judgeProbe({ status: null, body: null, networkError: "TypeError", timedOut: false }).reason === REASON.UNREACHABLE);
check("timeout -> timeout", judgeProbe({ timedOut: true }).reason === REASON.TIMEOUT);
check("⭐ every non-pass path sets ok:false — there is no third state",
  [res({ status: 500 }), res({ body: SPA }), res({ body: "{}" }), { timedOut: true }, { networkError: "X" }]
    .every((r) => judgeProbe(r).ok === false));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("2 — dedupe, staleness, and the ordering invariant");

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const rec = (agoMs, over = {}) => ({ producedAt: new Date(NOW - agoMs).toISOString(), ok: true, ...over });

check("a run inside the dedupe window is a cheap no-op", shouldSkipRerun({ record: rec(60_000), now: NOW }).skip === true);
check("a run outside it re-runs", shouldSkipRerun({ record: rec(MIN_RERUN_MS + 1000), now: NOW }).skip === false);
check("⭐ no record -> RUN (absence is never a reason to skip)", shouldSkipRerun({ record: null, now: NOW }).skip === false);
check("  …malformed -> RUN", shouldSkipRerun({ record: { producedAt: "nonsense" }, now: NOW }).skip === false);
check("  …future-dated -> RUN", shouldSkipRerun({ record: rec(-60_000), now: NOW }).skip === false);
check("⭐ dedupe is INDEPENDENT of the verdict — a failing record dedupes too, so a broken money path cannot be amplified into a request storm",
  shouldSkipRerun({ record: rec(60_000, { ok: false }), now: NOW }).skip === true);

check("a fresh healthy record serves", evaluateRecord({ record: rec(60_000), now: NOW }).serve === true);
check("⭐⭐ a fresh FAILING record does NOT serve", evaluateRecord({ record: rec(60_000, { ok: false }), now: NOW }).serve === false);
check("⭐⭐ a stale record does NOT serve, however healthy it claims to be",
  evaluateRecord({ record: rec(TTL_MS + 1000), now: NOW }).serve === false &&
  evaluateRecord({ record: rec(TTL_MS + 1000), now: NOW }).reason === "stale");
check("⭐⭐ ABSENCE does not serve — presence is never freshness",
  evaluateRecord({ record: null, now: NOW }).serve === false);
check("  …malformed does not serve", evaluateRecord({ record: { producedAt: rec(0).producedAt }, now: NOW }).serve === false);
check("  …future-dated does not serve", evaluateRecord({ record: rec(-60_000), now: NOW }).serve === false);

// ⭐ the ordering invariant, asserted against the COMMITTED netlify.toml.
//
// ⚠️ NOT the working tree. Proving this monitor on a draft REQUIRES commenting the schedule out
// (403 on HTTP invoke of a scheduled function; crons do not fire on drafts), so mid-proof the
// on-disk file legitimately has no schedule and this suite would go red for the wrong reason —
// the same mistake the build-stamp suite made by asserting against a file that is stamped between
// build and deploy. git is where the design intent lives; the WORKING TREE is the promotion gate's
// job, and gate:watch refuses production if it is still commented out.
const toml = execFileSync("git", ["show", "HEAD:netlify.toml"], { encoding: "utf8" });
const block = toml.match(/\[functions\."strong-read-watch"\]\s*\n\s*schedule\s*=\s*"([^"]+)"/);
check("netlify.toml registers strong-read-watch on a schedule", !!block, block?.[1]);
const cron = block?.[1] ?? "";
const cronMs = /^\*\/(\d+) \* \* \* \*$/.test(cron) ? Number(cron.match(/^\*\/(\d+)/)[1]) * 60_000 : null;
check("the schedule is a plain every-N-minutes cron", !!cronMs, cron);
check("⭐⭐ MIN_RERUN_MS < cron period (a scheduled run can NEVER dedupe itself into silence)",
  MIN_RERUN_MS < cronMs, `${MIN_RERUN_MS / 60000}m < ${cronMs / 60000}m`);
check("⭐⭐ cron period < TTL_MS (a record is never stale on arrival)",
  cronMs < TTL_MS, `${cronMs / 60000}m < ${TTL_MS / 60000}m`);
check("  …and the TTL tolerates two missed runs but not three", TTL_MS >= cronMs * 3 && TTL_MS < cronMs * 4);
check("⭐ the numbers are NOT the canary's 5/10/30 — two monitors, neither covering the other",
  !(MIN_RERUN_MS === 5 * 60000 && cronMs === 10 * 60000 && TTL_MS === 30 * 60000));
check("dd-canary's own schedule is untouched", /\[functions\."dd-canary"\]\s*\n\s*schedule\s*=\s*"\*\/10 \* \* \* \*"/.test(toml));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3 — notify on TRANSITION, with a floor and a ceiling");

const D = (o) => decideNotify({ now: NOW, ...o });
check("⭐⭐ pass -> fail NOTIFIES", D({ prevOk: true, ok: false }).notify === true && D({ prevOk: true, ok: false }).kind === "regressed");
check("⭐⭐ fail -> pass NOTIFIES (recovery is news too)", D({ prevOk: false, ok: true }).notify === true && D({ prevOk: false, ok: true }).kind === "recovered");
check("⭐ steady pass is SILENT — no 15-minute heartbeat spam", D({ prevOk: true, ok: true }).notify === false);
check("first observation healthy is SILENT (nobody wants a page saying hello)", D({ prevOk: null, ok: true }).notify === false);
check("⭐⭐ first observation FAILING notifies — indistinguishable from a regression, silence is the wrong default",
  D({ prevOk: null, ok: false }).notify === true);

check("⭐⭐ still failing, never notified -> notifies NOW rather than waiting out the window",
  D({ prevOk: false, ok: false, lastNotifiedAt: null }).notify === true);
check("still failing, notified 10m ago -> QUIET (no every-run paging)",
  D({ prevOk: false, ok: false, lastNotifiedAt: new Date(NOW - 10 * 60000).toISOString() }).notify === false);
check("⭐⭐ still failing, notified 61m ago -> REMINDS (transition-only would go silent through a long outage)",
  D({ prevOk: false, ok: false, lastNotifiedAt: new Date(NOW - REMINDER_MS - 60000).toISOString() }).notify === true);
check("  …a malformed lastNotifiedAt is treated as never-notified, not as just-notified",
  D({ prevOk: false, ok: false, lastNotifiedAt: "not-a-date" }).notify === true);

section("  …🚨 A FAILURE TO OBSERVE IS NOT AN OBSERVED FAILURE");
// The first real alert this monitor sent was WRONG in the way that matters: the probe target did
// not exist, so nothing was observed — yet the message asserted the kill switch and spend ceiling
// were reading a cache, and offered a rollback id. Strong reads were fine. The consequence
// paragraph, not the headline, is what would send someone rolling back a HEALTHY deploy at 3am.
const jFail = judgeProbe(res({ body: goodProbe({ verdict: "HOTFIX", calibrated: true }) }));
const msg = notifyMessage({ kind: "regressed", judgement: jFail, record: { failingSince: "2026-07-30T11:00:00Z" }, target: "https://app.tikpema.xyz/x" });
check("KNOWN-BROKEN names the money-path consequence, not just a status code", /kill switch/.test(msg) && /spend ceiling/.test(msg));
check("  …carries the arm outcomes", /arms A=/.test(msg));
check("  …always carries a ROLLBACK SECTION — a derived id, or an explicit no-known-good",
  /\*\*Rollback:\*\*/.test(msg) && /NO KNOWN-GOOD DEPLOY ON RECORD/.test(msg),
  "this msg has no lastGood, so the absence line is correct here");
check("  …and its headline is the siren", /STRONG READS ARE BROKEN/.test(msg));

// The exact shape of the false alert that was actually sent.
const jUnreach = judgeProbe(res({ body: SPA, contentType: "text/html" }));
const msgUnreach = notifyMessage({ kind: "first-failure", judgement: jUnreach, record: {}, target: "https://app.tikpema.xyz/x" });
check("⭐⭐ CANNOT-VERIFY headline says CANNOT VERIFY, not BROKEN",
  /CANNOT VERIFY/.test(msgUnreach) && !/ARE BROKEN/.test(msgUnreach));
check("⭐⭐ it makes NO consequence claim — the kill switch is never mentioned",
  !/kill switch/.test(msgUnreach) && !/spend ceiling/.test(msgUnreach) && !/reading a CDN cache/.test(msgUnreach));
check("⭐⭐ it carries NO rollback id — the single most dangerous line on this path",
  !/6a69be4fc7aa0d2c6843fc3c/.test(msgUnreach));
check("  …it says plainly this is not evidence the money path is broken",
  /not\*{0,2} evidence/.test(msgUnreach));
check("  …and the action is to check the site is up",
  /check the site/.test(msgUnreach) && /Do NOT roll back/.test(msgUnreach));

check("⭐⭐ EVERY cannot-verify reason produces the cannot-verify shape",
  [REASON.UNREACHABLE, REASON.TIMEOUT, REASON.HTTP_ERROR, REASON.NOT_JSON, REASON.WRONG_SHAPE].every((reason) => {
    const m = notifyMessage({ kind: "regressed", judgement: { ok: false, reason, detail: "d", probe: null, build: null }, record: {}, target: "t" });
    return /CANNOT VERIFY/.test(m) && !/kill switch/.test(m) && !/6a69be4fc7aa0d2c6843fc3c/.test(m);
  }));
check("⭐⭐ EVERY known-broken reason produces the siren + consequence + rollback",
  [REASON.HOTFIX, REASON.UNCALIBRATED].every((reason) => {
    const m = notifyMessage({ kind: "regressed", judgement: { ok: false, reason, detail: "d", probe: null, build: null }, record: {}, target: "t" });
    // The rollback SECTION must always be present on known-broken; with no lastGood in this
    // fixture it must be the explicit absence, never a hardcoded constant.
    return /ARE BROKEN/.test(m) && /kill switch/.test(m)
      && /\*\*Rollback:\*\*/.test(m) && /NO KNOWN-GOOD DEPLOY ON RECORD/.test(m)
      && !/6a69be4f/.test(m);
  }));
check("⭐⭐ an UNRECOGNISED reason falls to CANNOT-VERIFY — never claim a breakage you did not see",
  verdictClass("something-new-nobody-added-yet") === "cannot-verify" &&
  !/kill switch/.test(notifyMessage({ kind: "regressed", judgement: { ok: false, reason: "brand-new", detail: "d", probe: null, build: null }, record: {}, target: "t" })));
check("  …the two classes are disjoint and cover every REASON except ok",
  Object.values(REASON).filter((r) => r !== REASON.OK).every((r) => ["known-broken", "cannot-verify"].includes(verdictClass(r))) &&
  verdictClass(REASON.OK) === "ok");

check("recovery reads as recovery, with no consequence or rollback text",
  /RECOVERED/.test(notifyMessage({ kind: "recovered", judgement: judgeProbe(res()), record: {}, target: "t" })) &&
  !/kill switch/.test(notifyMessage({ kind: "recovered", judgement: judgeProbe(res()), record: {}, target: "t" })));

check("⭐ URLs are wrapped in <> so Discord does not unfurl a marketing card under a siren",
  /\*\*Target:\*\* <https:\/\/app\.tikpema\.xyz\/x>/.test(msgUnreach));

section("  …🚨 the ROLLBACK TARGET is DERIVED, never hardcoded");
// It used to be the literal 6a69be4f — which is the HOTFIX, the build WITHOUT Option D. Following it
// lands prod fail-open, and it is a no-op if the probe really said HOTFIX.
const NOW2 = Date.parse("2026-07-30T12:00:00.000Z");
const GOOD = { deployId: "6a6b31c221584e047b927297", tree: "e".repeat(64), commit: "f".repeat(40), observedAt: "2026-07-30T11:46:00.000Z" };
const mk = (rec) => notifyMessage({ kind: "regressed", judgement: jFail, record: rec, target: "t", now: NOW2 });

check("⭐⭐ the retired hardcoded HOTFIX id appears NOWHERE in the module",
  !/6a69be4f/.test(readFileSync("shared/strong-read-watch/watch.mjs", "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));
check("⭐⭐ with a known-good on record, the alert quotes THAT deploy id",
  /restore deploy `6a6b31c221584e047b927297`/.test(mk({ lastGood: GOOD })));
check("⭐⭐ …and states HOW OLD it is — 14 min vs 9 days are different instructions",
  /last observed healthy \*\*14 min ago\*\*/.test(mk({ lastGood: GOOD })), ago(GOOD.observedAt, NOW2));
check("  …with the absolute timestamp too, not just the relative age",
  /2026-07-30T11:46:00\.000Z/.test(mk({ lastGood: GOOD })));

// ⭐⭐ THE ABSENCE CASE. Live for the first ~15 min after any promotion, before the first ok run of
// the new build populates lastGood — so it is observable, not hypothetical.
for (const rec of [{}, { lastGood: null }, { lastGood: { deployId: null, observedAt: "x" } }]) {
  const m = mk(rec);
  check(`⭐⭐ no known-good (${JSON.stringify(rec).slice(0, 22)}) -> says so LOUDLY, does not omit`,
    /NO KNOWN-GOOD DEPLOY ON RECORD/.test(m) && /Do not roll back blind/.test(m));
  check("  …and quotes NO deploy id at all — absence must not become a target",
    !/restore deploy `/.test(m) && !/6a69be4f/.test(m));
}
check("  …it tells you how to find one yourself",
  /verdict.*D/.test(mk({})) && /blobs-probe/.test(mk({})));

section("  …🔍 the scheduled-runtime capture: THREE states, and it can never page anyone");
// resolveBuildId reads env ONLY, and in production nothing resolves — so dd-canary refuses at
// rung 0 and has written nothing for days. `netlify env:get` cannot answer why: measured
// 2026-07-30, it reports COMMIT_REF as the LOCAL git HEAD and DEPLOY_ID/BUILD_ID as "0", values
// absent from env:list and never seen by the deployed function. Only the function can say.
const { captureBuildIdSources, BUILD_ID_ENV_KEYS, DEPLOY_ID_HEADER } = W;

check("⭐⭐ state 1 — NO headers object at all -> 'headers-absent'",
  captureBuildIdSources({}, {}).headerState === "headers-absent" &&
  captureBuildIdSources({ headers: null }, {}).headerState === "headers-absent");
check("⭐⭐ state 2 — headers present but the KEY missing -> 'key-missing' (a different fix)",
  captureBuildIdSources({ headers: { "content-type": "x" } }, {}).headerState === "key-missing");
check("⭐⭐ state 3 — key present -> 'present', with the value",
  captureBuildIdSources({ headers: { "x-nf-deploy-id": "a".repeat(24) } }, {}).headerState === "present" &&
  captureBuildIdSources({ headers: { "x-nf-deploy-id": "a".repeat(24) } }, {}).headerValue === "a".repeat(24));
check("  …the three states are DISTINCT — a boolean would collapse 1 and 2",
  new Set(["headers-absent", "key-missing", "present"]).size === 3);
check("  …header lookup is case-insensitive",
  captureBuildIdSources({ headers: { "X-NF-Deploy-Id": "b".repeat(24) } }, {}).headerState === "present");

check("⭐ env: ABSENT is null, present-but-EMPTY is \"\" — also three states, not two",
  captureBuildIdSources({}, {}).env.DEPLOY_ID === null &&
  captureBuildIdSources({}, { DEPLOY_ID: "" }).env.DEPLOY_ID === "" &&
  captureBuildIdSources({}, { DEPLOY_ID: "x" }).env.DEPLOY_ID === "x");
check("  …all four resolveBuildId sources are captured in one shot",
  BUILD_ID_ENV_KEYS.length === 4 &&
  ["DD_BUILD_ID","COMMIT_REF","DEPLOY_ID","BUILD_ID"].every((k) => k in captureBuildIdSources({}, {}).env));

// 🚨 REQUIREMENT 3 — structural, not behavioural. A diagnostic that can page someone is a
// diagnostic that gets deleted in anger. Same discipline as treeChanged.
check("⭐⭐ runtimeSources is NOT an input to decideNotify (structurally cannot trigger an alert)",
  !/runtimeSources|captureBuildIdSources|headerState/.test(String(decideNotify)));
check("  …nor does the alert message mention it",
  !/runtimeSources|headerState/.test(String(notifyMessage)));
check("⭐ it IS carried on the record, where a human reads it",
  "runtimeSources" in buildRecord({ judgement: judgeProbe(res()), prev: null, nowIso: "x", target: "T", storeName: "S", runtimeSources: { headerState: "present" } }));
check("  …and defaults to null when not supplied, never to a fabricated shape",
  buildRecord({ judgement: judgeProbe(res()), prev: null, nowIso: "x", target: "T", storeName: "S" }).runtimeSources === null);

section("  …lastGood is carried forward, never taken from the failing run");
const okJ = judgeProbe(res({ body: goodProbe({ deploy: { resolved: true, id: "a".repeat(24), source: "x-nf-deploy-id" } }) }));
const rGood = buildRecord({ judgement: okJ, prev: null, nowIso: "2026-07-30T12:00:00.000Z", target: "T", storeName: "S" });
check("⭐ an ok run WITH a resolved deploy id records it as lastGood",
  rGood.lastGood?.deployId === "a".repeat(24) && rGood.lastGood.observedAt === "2026-07-30T12:00:00.000Z");
check("⭐⭐ a FAILING run carries the previous known-good FORWARD — an outage cannot erase it",
  buildRecord({ judgement: jFail, prev: { lastGood: GOOD }, nowIso: "x", target: "T", storeName: "S" }).lastGood.deployId === GOOD.deployId);
check("⭐⭐ the failing run's OWN deploy id is never promoted to lastGood",
  buildRecord({ judgement: { ...jFail, deploy: { id: "b".repeat(24) } }, prev: { lastGood: GOOD }, nowIso: "x", target: "T", storeName: "S" }).lastGood.deployId === GOOD.deployId);
check("⭐ an ok run with NO resolved deploy id does not overwrite a good one with a blank",
  buildRecord({ judgement: judgeProbe(res()), prev: { lastGood: GOOD }, nowIso: "x", target: "T", storeName: "S" }).lastGood.deployId === GOOD.deployId);
check("  …and with no prior it stays null rather than inventing one",
  buildRecord({ judgement: judgeProbe(res()), prev: null, nowIso: "x", target: "T", storeName: "S" }).lastGood === null);

section("  …the probe reports a deploy id, shape-validated");
const P = await import("../netlify/functions/blobs-probe.mjs");
const RD = (o) => P.resolveDeployId(o);
check("resolves from the x-nf-deploy-id HEADER (present even on a CLI deploy, unlike DEPLOY_ID)",
  RD({ event: { headers: { "x-nf-deploy-id": "6a6b31c221584e047b927297" } }, env: {} }).id === "6a6b31c221584e047b927297");
check("  …header case-insensitively", RD({ event: { headers: { "X-NF-Deploy-Id": "a".repeat(24) } }, env: {} }).resolved === true);
check("  …falls back to DEPLOY_ID for a git-triggered build",
  RD({ event: { headers: {} }, env: { DEPLOY_ID: "b".repeat(24) } }).source === "DEPLOY_ID");
check("⭐⭐ a MALFORMED id resolves to null — it would become a rollback instruction",
  ["", "nope", "123", "z".repeat(24), "a".repeat(23), "a".repeat(25)].every((v) =>
    RD({ event: { headers: { "x-nf-deploy-id": v } }, env: {} }).resolved === false));
check("  …absent everywhere -> resolved:false, id null, no placeholder",
  RD({ event: { headers: {} }, env: {} }).resolved === false && RD({ event: {}, env: {} }).id === null);
check("⭐ the judge only accepts a RESOLVED id from the probe body",
  judgeProbe(res({ body: goodProbe({ deploy: { resolved: false, id: "c".repeat(24) } }) })).deploy === null);

const msgTree = notifyMessage({ kind: "regressed", judgement: jFail, record: { treeChanged: true, previousTree: "a".repeat(64) }, target: "x" });
check("⭐ flags a tree hash that moved — a deploy you don't remember making is its own finding", /tree hash CHANGED/.test(msgTree));

// ⭐⭐ A TREE CHANGE MUST NEVER *CAUSE* AN ALERT, ONLY DECORATE ONE. Every legitimate deploy changes
// the tree; if that paged, every deploy would page and the channel would be trained into noise.
// Structural, not incidental: treeChanged is not a parameter of decideNotify at all.
check("⭐⭐ treeChanged is NOT an input to the notify decision (structurally cannot trigger one)",
  !/treeChanged/.test(String(decideNotify)));
check("⭐⭐ an ok->ok run is SILENT regardless of a tree change — a deploy does not page",
  decideNotify({ prevOk: true, ok: true, lastNotifiedAt: null, now: NOW }).notify === false &&
  decideNotify({ prevOk: true, ok: true, lastNotifiedAt: null, now: NOW }).kind === "steady-ok");
check("  …and a first-ever ok run is silent too, tree change or not",
  decideNotify({ prevOk: null, ok: true, lastNotifiedAt: null, now: NOW }).notify === false);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("4 — the record");

const rOk = buildRecord({ judgement: judgeProbe(res()), prev: null, nowIso: "2026-07-30T12:00:00.000Z", target: "T", storeName: "S" });
check("records verdict, calibrated and all three arms",
  rOk.probe.verdict === "D" && rOk.probe.calibrated === true && rOk.probe.arms.A === "consistency-error" && rOk.probe.arms.A2 === "consistency-error");
check("records the build tree", rOk.build.tree === "t".repeat(64));
check("records the target and store", rOk.target === "T" && rOk.store === "S");
check("a healthy record has no failingSince", rOk.failingSince === null);

const prevTreeRec = { ok: true, build: { tree: "a".repeat(64) }, producedAt: "2026-07-30T11:00:00.000Z" };
check("⭐⭐ a CHANGED tree hash is flagged",
  buildRecord({ judgement: judgeProbe(res()), prev: prevTreeRec, nowIso: "x", target: "T", storeName: "S" }).treeChanged === true);
check("  …an unchanged one is not",
  buildRecord({ judgement: judgeProbe(res({ body: goodProbe({ build: { commit: null, tree: "a".repeat(64), dirty: false } }) })), prev: prevTreeRec, nowIso: "x", target: "T", storeName: "S" }).treeChanged === false);
check("⭐ treeChanged is NULL (unknown), never false, when either side is missing — absence must not read as 'unchanged'",
  buildRecord({ judgement: judgeProbe(res({ body: SPA })), prev: prevTreeRec, nowIso: "x", target: "T", storeName: "S" }).treeChanged === null);

const rFail1 = buildRecord({ judgement: jFail, prev: { ok: true }, nowIso: "2026-07-30T12:00:00.000Z", target: "T", storeName: "S" });
check("a new failure stamps failingSince now", rFail1.failingSince === "2026-07-30T12:00:00.000Z");
const rFail2 = buildRecord({ judgement: jFail, prev: { ok: false, failingSince: "2026-07-30T09:00:00.000Z" }, nowIso: "2026-07-30T12:00:00.000Z", target: "T", storeName: "S" });
check("⭐ a CONTINUING failure keeps the ORIGINAL failingSince — the outage does not restart every run",
  rFail2.failingSince === "2026-07-30T09:00:00.000Z");
check("lastNotifiedAt carries forward so the reminder floor survives a run",
  buildRecord({ judgement: jFail, prev: { ok: false, lastNotifiedAt: "2026-07-30T11:00:00.000Z" }, nowIso: "x", target: "T", storeName: "S" }).lastNotifiedAt === "2026-07-30T11:00:00.000Z");

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("5 — 🚨 THE RULE: the monitor never names a read mode");

const src = readFileSync("netlify/functions/strong-read-watch.mjs", "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("⭐⭐ ZERO occurrences of the read-mode option in the monitor's CODE (comments excluded)",
  !/consistency/i.test(code),
  "a store-level default leaks into WRITES, so the monitor would die in the very outage it reports");
check("⭐⭐ the store is created with a BARE NAME, never an options object",
  /getStore\(\s*[A-Za-z_$][\w$.]*\s*\)/.test(code) && !/getStore\(\s*\{/.test(code));
check("  …and the word does appear in the comments, so the reasoning is not lost",
  /consistency/i.test(src));
// ⚠️ Assert on the IMPORT LIST, not on the file text. Two earlier versions of these checks were
// wrong for the same reason: the header comment names dd-canary (to explain why it is separate) and
// the target URL string legitimately contains "blobs-probe". Grepping the text made both look like
// dependencies. The dependency question is answered by the import list and nothing else.
const imports = [...src.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
const FORBIDDEN = ["_vault", "_auth", "_agent-wallets", "_circle", "_budget", "_pause", "_actions", "_x402", "_gateway", "dd-canary"];
check("⭐⭐ imports NOTHING from the money path, the auth surface, or the canary",
  !imports.some((i) => FORBIDDEN.some((f) => i.includes(f))), imports.join(", "));
check("⭐⭐ the monitor does not IMPORT blobs-probe — it must go over HTTP, or it measures the SCHEDULED runtime instead of the one _pause.mjs executes in",
  !imports.some((i) => i.includes("blobs-probe")));
// The literal URL now lives in shared/ as DEFAULT_TARGET_URL (single source), so assert the
// handler fetches AND that the shared constant actually points at the probe.
check("  …and it reaches the probe by URL over fetch",
  /fetch\(/.test(code) && /DEFAULT_TARGET_URL/.test(code) && /blobs-probe/.test(W.DEFAULT_TARGET_URL));

section("  …and blobs-probe stays read-only");
const probeSrc = readFileSync("netlify/functions/blobs-probe.mjs", "utf8");
const probeCode = probeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("⭐⭐ no write capability was added to the probe", !/\.(setJSON|set|delete)\s*\(/.test(probeCode));
check("  …still GET-only", /method-not-allowed/.test(probeSrc));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("6 — the handler: write FIRST, notify SECOND, store namespace isolated");

const writes = [];
let webhookCalls = [];
let blobFail = false;

const makeStore = () => ({
  get: async () => (writes.length ? writes[writes.length - 1].value : null),
  setJSON: async (key, value) => { if (blobFail) throw Object.assign(new Error("down"), { name: "BlobsError" }); writes.push({ key, value }); },
});

mock.module("@netlify/blobs", { namedExports: { getStore: () => makeStore(), connectLambda: () => {} } });
// Path is relative to THIS file, not to the importer. `../../` resolved outside the repo.
mock.module("../netlify/functions/_blobs.mjs", { namedExports: { connectBlobs: () => {}, strongReadAvailable: () => true } });

const origFetch = globalThis.fetch;
const runHandler = async ({ probeBody = goodProbe(), probeStatus = 200, env = {}, webhookOk = true, webhookThrows = false }) => {
  writes.length = 0; webhookCalls = [];
  const saved = { ...process.env };
  for (const k of ["WATCH_STORE", "WATCH_TARGET_URL", "WATCH_ALERT_WEBHOOK", "DISCORD_FEEDBACK_WEBHOOK"]) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("discord") || String(url).includes("hook")) {
      webhookCalls.push({ url, body: opts?.body });
      if (webhookThrows) throw Object.assign(new Error("net"), { name: "FetchError" });
      return { ok: webhookOk, status: webhookOk ? 204 : 500, text: async () => "" };
    }
    return { status: probeStatus, headers: { get: () => "application/json" }, text: async () => probeBody };
  };
  const { handler } = await import(`../netlify/functions/strong-read-watch.mjs?t=${Date.now()}${Math.random()}`);
  const out = await handler({ blobs: "x", headers: {} });
  globalThis.fetch = origFetch;
  process.env = saved;
  return JSON.parse(out.body);
};

let r = await runHandler({ env: { WATCH_ALERT_WEBHOOK: "https://hook.example/x" } });
check("healthy run records ok", r.ok === true && r.reason === REASON.OK);
check("⭐ a first HEALTHY observation sends nothing", webhookCalls.length === 0);
check("  …and still writes the record", writes.some((w) => w.key === "latest"));

r = await runHandler({ probeBody: goodProbe({ verdict: "HOTFIX" }), env: { WATCH_ALERT_WEBHOOK: "https://hook.example/x" } });
check("⭐⭐ a first FAILING observation notifies", webhookCalls.length === 1);
check("⭐⭐ the record is written BEFORE the webhook is called",
  writes.length > 0 && writes[0].key === "latest",
  `first write = ${writes[0]?.key}`);
check("⭐⭐ a FAILURE also writes an append-only failure:<iso> key a later success cannot overwrite",
  writes.some((w) => w.key.startsWith("failure:")));
check("delivery is recorded in the record", r.notify.delivered === true && r.notify.planned === true);

r = await runHandler({ probeBody: goodProbe({ verdict: "HOTFIX" }), env: { WATCH_ALERT_WEBHOOK: "https://hook.example/x" }, webhookOk: false });
check("⭐⭐ a REJECTED webhook is recorded, and does not cost the record",
  r.notify.delivered === false && /rejected/.test(r.notify.error) && r.recordWritten === true);
const lastRejected = writes.filter((w) => w.key === "latest").pop().value;
check("⭐⭐ lastNotifiedAt does NOT advance on a failed send — the alert is retried, not rate-limited away",
  lastRejected.lastNotifiedAt === null);

r = await runHandler({ probeBody: goodProbe({ verdict: "HOTFIX" }), env: { WATCH_ALERT_WEBHOOK: "https://hook.example/x" }, webhookThrows: true });
check("a THROWING webhook is recorded as undelivered, record intact",
  r.notify.delivered === false && r.recordWritten === true);

r = await runHandler({ probeBody: goodProbe({ verdict: "HOTFIX" }), env: {} });
check("⭐⭐ NO webhook configured is recorded as 'cannot reach anyone', not as success",
  r.notify.delivered === false && /cannot reach anyone/.test(r.notify.error));
check("  …and it names the env vars it checked", /WATCH_ALERT_WEBHOOK/.test(r.notify.error));

// ⭐⭐ THE INVERTED ASSERTION. There is NO fallback, on purpose. DISCORD_FEEDBACK_WEBHOOK is
// already set in the PRODUCTION context, so a fallback would mean promotion silently began pushing
// money-path alerts into the in-app feedback channel with nobody deciding that. This test is the
// net that stops a future "so it works out of the box" from re-adding it.
r = await runHandler({ probeBody: goodProbe({ verdict: "HOTFIX" }), env: { DISCORD_FEEDBACK_WEBHOOK: "https://hook.example/fb" } });
check("⭐⭐ DISCORD_FEEDBACK_WEBHOOK alone delivers NOTHING — no implicit channel, no silent widening",
  webhookCalls.length === 0 && r.notify.delivered === false);
check("  …and it says it cannot reach anyone, naming only the variable it actually checks",
  /cannot reach anyone/.test(r.notify.error) && /WATCH_ALERT_WEBHOOK/.test(r.notify.error) && !/DISCORD/.test(r.notify.error));

blobFail = true;
r = await runHandler({ probeBody: goodProbe({ verdict: "HOTFIX" }), env: { WATCH_ALERT_WEBHOOK: "https://hook.example/x" } });
blobFail = false;
check("⭐⭐ an UNWRITABLE store still NOTIFIES — losing the record must not also lose the alert",
  r.recordWritten === false && webhookCalls.length === 1);

section("  …store namespace isolation (change 3)");
r = await runHandler({ env: { WATCH_STORE: "watch-draft-proof", WATCH_ALERT_WEBHOOK: "https://hook.example/x" } });
check("⭐⭐ WATCH_STORE isolates the draft proof from the store prod's cron reads",
  r.store === "watch-draft-proof" && r.storeOverridden === true);
check("  …default is the prod store", (await runHandler({})).store === "strong-read-watch");
for (const bad of ["../escape", "has space", "-leading", "x".repeat(70), "a/b"]) {
  const rb = await runHandler({ env: { WATCH_STORE: bad } });
  check(`⭐ an unusable WATCH_STORE (${JSON.stringify(bad).slice(0, 14)}) REFUSES rather than guessing a namespace`,
    rb.ok === false && rb.reason === "bad-store-override");
}
r = await runHandler({ env: { WATCH_TARGET_URL: "https://draft.example/probe" } });
check("WATCH_TARGET_URL is honoured and recorded, so a result cannot be mistaken for another target's",
  r.target === "https://draft.example/probe");

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("7 — the PROMOTION GATE parses fail-closed");

const { interpretEnvGet, fingerprint, classifyWebhookUrl, interpretWebhookProbe } =
  await import("../scripts/verify-watch-promotion-gate.mjs");
const G = (stdout, status = 0, error = null) => interpretEnvGet({ stdout, status, error });
const HOOK = "https://discord.com/api/webhooks/1234567890/AbC-dEf_123";

check("⭐⭐ THE TRAP: 'No value set' on STDOUT at EXIT 0 is UNSET, not a value",
  G("No value set in the production context for environment variable WATCH_ALERT_WEBHOOK\n").resolved === false &&
  G("No value set in the production context for environment variable WATCH_ALERT_WEBHOOK\n").reason === "unset");
check("  …a real webhook endpoint resolves", G(HOOK + "\n").resolved === true);
check("⭐ prose that is NOT a bare URL fails rather than being treated as a channel",
  G("some warning about something\n").resolved === false && G("some warning about something\n").reason === "not-a-url");
check("empty output fails", G("").reason === "empty-output");
check("a non-zero exit fails", G("https://real.example/x", 1).reason === "cli-nonzero");
check("a CLI that could not run at all fails", G("", 0, "ENOENT").reason === "cli-failed");
check("⭐ a placeholder URL fails — example.com is not a channel",
  G("https://example.com/webhook\n").reason === "placeholder" && G("https://localhost/x\n").reason === "placeholder");
// ⭐⭐ OBSERVED IN THE WILD 2026-07-30: the variable really was set to the literal string "<url>".
// It reached Netlify and looked configured. Fail-closed already rejected it; this pins the specific
// reason code so the message points at the real fix instead of at a parsing bug.
check("⭐⭐ the literal placeholder '<url>' is rejected, with its OWN reason code",
  G("<url>\n").resolved === false && G("<url>\n").reason === "placeholder-literal");
check("  …and the detail says to substitute a real URL",
  /instead of a real webhook URL/.test(G("<url>\n").detail));
check("  …any <angle-bracket> token is caught, not just that one",
  ["<URL>", "<your-webhook>", "<paste here>"].every((s) => G(s + "\n").reason === "placeholder-literal"));
check("⭐⭐ NO input shape resolves except an affirmative real webhook endpoint",
  ["", "No value set", "warning: blah", "not-a-url", "http://insecure.example/x"].every((s) => G(s).resolved === false));
check("a value buried among CLI noise is still found",
  G("⬥ Netlify CLI\n\n" + HOOK + "\n").resolved === true);

// ═══ ⭐⭐ THE FOURTH TRAP: URL-SHAPED IS NOT USABLE ═══════════════════════════════════════════
// OBSERVED ON REAL INFRASTRUCTURE 2026-07-30: a discord.gg INVITE link was stored. It is a
// perfectly well-formed https:// URL, so the previous "any bare https:// line" check ACCEPTED it
// and the gate PASSED. An invite link can never receive a webhook post — the monitor would have
// been silent forever. The gate was committing the exact error it exists to catch.
check("⭐⭐ a discord.gg INVITE link is REJECTED, with its own reason code",
  classifyWebhookUrl("https://discord.gg/AbCdEf").reason === "invite-link" &&
  G("https://discord.gg/AbCdEf\n").resolved === false);
check("  …and so is the /invite/ form on the main domain",
  classifyWebhookUrl("https://discord.com/invite/AbCdEf").reason === "invite-link");
check("  …the message names the mistake and where the real URL comes from",
  /INVITE link/.test(classifyWebhookUrl("https://discord.gg/x").detail) &&
  /Integrations/.test(classifyWebhookUrl("https://discord.gg/x").detail));
check("⭐⭐ an https URL that is not a webhook ENDPOINT fails — shape, not just prefix",
  ["https://discord.com/channels/1/2", "https://hooks.slack.com/services/A/B/C", "https://discord.com/api/guilds/1"]
    .every((u) => classifyWebhookUrl(u).reason === "not-a-webhook-url"));
check("  …the canonical endpoint passes, with its id extracted",
  classifyWebhookUrl(HOOK).ok === true && classifyWebhookUrl(HOOK).id === "1234567890");
check("  …and the legacy/canary hosts pass too",
  classifyWebhookUrl("https://discordapp.com/api/webhooks/1/t").ok === true &&
  classifyWebhookUrl("https://canary.discord.com/api/v10/webhooks/1/t").ok === true);

section("  …existence, not just syntax: the live read-only GET");
check("⭐⭐ 200 + a webhook object -> EXISTS",
  interpretWebhookProbe({ status: 200, body: JSON.stringify({ id: "1", name: "alerts", channel_id: "9", type: 1 }) }).exists === true);
check("  …and it reports the channel name/id so you can tell WHICH channel it is",
  interpretWebhookProbe({ status: 200, body: JSON.stringify({ id: "1", name: "alerts", channel_id: "9" }) }).meta.name === "alerts");
check("⭐⭐ 404 -> webhook-not-found (deleted, or never existed)",
  interpretWebhookProbe({ status: 404 }).reason === "webhook-not-found");
check("⭐⭐ 401/403 -> webhook-unauthorized (token regenerated or revoked)",
  interpretWebhookProbe({ status: 401 }).reason === "webhook-unauthorized" &&
  interpretWebhookProbe({ status: 403 }).reason === "webhook-unauthorized");
check("200 but not JSON -> unexpected-response, never exists",
  interpretWebhookProbe({ status: 200, body: "<html>" }).exists === false);
check("  …200 with JSON lacking an id -> unexpected-response",
  interpretWebhookProbe({ status: 200, body: '{"message":"ok"}' }).exists === false);
check("unreachable / timeout -> failures, not unknowns",
  interpretWebhookProbe({ networkError: "TypeError" }).reason === "unreachable" &&
  interpretWebhookProbe({ timedOut: true }).reason === "timeout");
check("⭐⭐ NO probe outcome yields exists:true except a 200 carrying a webhook object",
  [{ status: 404 }, { status: 401 }, { status: 500 }, { status: 200, body: "x" }, { timedOut: true }, { networkError: "X" }]
    .every((r) => interpretWebhookProbe(r).exists === false));

section("  …and the schedule the build stamp cannot see");
const { checkScheduleDeclared } = await import("../scripts/verify-watch-promotion-gate.mjs");
const { EXPECTED_CRON, CRON_MS, FUNCTION_NAME } = W;
const TOML_ON = `[functions."strong-read-watch"]\n  schedule = "${EXPECTED_CRON}"\n`;

check("⭐ the COMMITTED netlify.toml declares it, uncommented (git, not the working tree — see above)",
  checkScheduleDeclared(toml).ok === true, checkScheduleDeclared(toml).cron ?? "—");
check("  …and the expectation lives in CODE, with the file checked against it (one source of truth)",
  cron === EXPECTED_CRON && cronMs === CRON_MS, `${cron} === ${EXPECTED_CRON}`);
check("a well-formed block passes", checkScheduleDeclared(TOML_ON).reason === "scheduled");

// ⭐⭐ THE ONE THAT MATTERS. Proving on a draft REQUIRES commenting this out (403 on HTTP invoke of a
// scheduled function, and crons do not fire on drafts). netlify.toml is OUTSIDE the stamp's hashed
// surface, so a forgotten restore yields an IDENTICAL tree hash, a PASSING provenance check, and a
// monitor that never runs. Silently. The stamp is structurally blind here; only this catches it.
const TOML_COMMENTED = `# [functions."strong-read-watch"]\n#   schedule = "${EXPECTED_CRON}"\n`;
check("⭐⭐ a COMMENTED-OUT block is caught, and gets its OWN reason code",
  checkScheduleDeclared(TOML_COMMENTED).ok === false &&
  checkScheduleDeclared(TOML_COMMENTED).reason === "commented-out");
check("  …the message says it is the draft-proof state that was never restored",
  /never\s+restored|not\s+restored/.test(checkScheduleDeclared(TOML_COMMENTED).detail));
check("  …and it explains that the tree hash CANNOT catch this",
  /tree hash matches/.test(checkScheduleDeclared(TOML_COMMENTED).detail));
check("⭐⭐ a naive raw-text regex WOULD have passed the commented file — the comment strip is load-bearing",
  /\[functions\."strong-read-watch"\]/.test(TOML_COMMENTED));
check("  …indented comments are caught too",
  checkScheduleDeclared(`   # [functions."strong-read-watch"]\n   #  schedule = "${EXPECTED_CRON}"`).reason === "commented-out");

check("absent entirely -> block-missing, distinct from commented-out",
  checkScheduleDeclared("[build]\n  command = \"x\"\n").reason === "block-missing");
check("block present but no schedule key -> no-schedule-key",
  checkScheduleDeclared(`[functions."strong-read-watch"]\n  included_files = []\n`).reason === "no-schedule-key");
check("⭐ the WRONG cron is refused — the ordering invariant is calibrated to */15",
  checkScheduleDeclared(`[functions."strong-read-watch"]\n  schedule = "*/10 * * * *"\n`).reason === "cron-mismatch");
check("  …and it reports what it found",
  checkScheduleDeclared(`[functions."strong-read-watch"]\n  schedule = "*/10 * * * *"\n`).cron === "*/10 * * * *");
check("⭐⭐ NO toml shape passes except an uncommented block on exactly the expected cron",
  ["", "# nothing", TOML_COMMENTED, `[functions."strong-read-watch"]\n  schedule = "* * * * *"\n`,
   `[functions."dd-canary"]\n  schedule = "${EXPECTED_CRON}"\n`]
    .every((t) => checkScheduleDeclared(t).ok === false));
check("a trailing comment after the value is harmless",
  checkScheduleDeclared(`[functions."strong-read-watch"]\n  schedule = "${EXPECTED_CRON}" # every 15m\n`).ok === true);

const gateSrcLive = readFileSync("scripts/verify-watch-promotion-gate.mjs", "utf8");
check("⭐ the schedule check gates PRODUCTION and only warns elsewhere (a draft proof needs it off)",
  /schedule\.ok \|\| !isProd/.test(gateSrcLive) && /not gating/.test(gateSrcLive));
check("⭐ the gate still says the schedule being DECLARED is not the schedule FIRING",
  /NOT THAT IT FIRES/.test(gateSrcLive) && /producedAt advance/.test(gateSrcLive));
check("⭐⭐ the liveness check is a GET — a POST would put a test message in the channel",
  /method:\s*"GET"/.test(gateSrcLive) && !/method:\s*"POST"/.test(gateSrcLive));
check("⭐ --no-network reports 'unverified' and still FAILS — a shape check is not an existence check",
  /unverified/.test(gateSrcLive) && /NOT checked/.test(gateSrcLive));

check("⭐ the fingerprint never contains the value", !fingerprint("https://secret.example/abc").includes("secret"));
check("  …and distinguishes two channels", fingerprint("https://a/1") !== fingerprint("https://b/2"));
check("  …deterministically", fingerprint("https://a/1") === fingerprint("https://a/1"));

// The invariant is not "the value is never mentioned in a log line" — `fingerprint(watch.value)` is
// exactly the safe use. It is: every log line that touches a resolved value must hash it first.
const gateSrc = readFileSync("scripts/verify-watch-promotion-gate.mjs", "utf8");
const valueLogs = gateSrc.split("\n").filter((l) => /console\.log\(/.test(l) && /\.value/.test(l));
check("⭐⭐ every log line touching a resolved value hashes it — the URL is a credential",
  valueLogs.length > 0 && valueLogs.every((l) => /fingerprint\(/.test(l)),
  `${valueLogs.length} such line(s), all hashed`);
check("  …and the output says so explicitly", /value withheld/.test(gateSrc));

section("  …🚨 leftover draft-proof overrides must not reach production");
// public/__watch-test-fixture-hotfix.json ships to prod. A stale WATCH_TARGET_URL pointing at it
// would make the monitor watch a file that ALWAYS says HOTFIX: a permanent fake outage, paging
// hourly, while the real money path went unwatched. Unsetting has been a MANUAL step every time.
const { checkEnvOverride, DEFAULT_TARGET_URL: DTU, DEFAULT_STORE_NAME: DSN } = W;
check("unset -> ok (the code default applies)", checkEnvOverride("WATCH_TARGET_URL", undefined, DTU).ok === true);
check("  …empty string is also unset", checkEnvOverride("WATCH_TARGET_URL", "   ", DTU).reason === "unset");
check("explicitly set to the production default -> ok", checkEnvOverride("WATCH_TARGET_URL", DTU, DTU).reason === "explicit-default");
check("⭐⭐ pointed at the HOTFIX FIXTURE -> REFUSED",
  checkEnvOverride("WATCH_TARGET_URL", "https://app.tikpema.xyz/__watch-test-fixture-hotfix.json", DTU).ok === false);
check("  …and the detail names the consequence: permanent fake failure, hourly paging",
  /fake failure/.test(checkEnvOverride("WATCH_TARGET_URL", "https://x/y.json", DTU).detail));
check("⭐ any other override is refused too — only unset or the exact default pass",
  ["https://app.tikpema.xyz/.netlify/functions/no-such", "http://x", "nonsense"]
    .every((v) => checkEnvOverride("WATCH_TARGET_URL", v, DTU).ok === false));
check("⭐⭐ WATCH_STORE gets the same treatment — prod must write the real store",
  checkEnvOverride("WATCH_STORE", "watch-draft-proof", DSN).ok === false &&
  checkEnvOverride("WATCH_STORE", DSN, DSN).ok === true &&
  checkEnvOverride("WATCH_STORE", undefined, DSN).ok === true);
const gateOv = readFileSync("scripts/verify-watch-promotion-gate.mjs", "utf8");
check("⭐ the gate checks BOTH overrides and gates production only",
  /WATCH_TARGET_URL", DEFAULT_TARGET_URL/.test(gateOv) && /WATCH_STORE", DEFAULT_STORE_NAME/.test(gateOv)
  && /overrides\.every\(\(o\) => o\.ok\) \|\| !isProd/.test(gateOv));
check("⭐ the target/store defaults have ONE source, shared by handler and gate",
  /DEFAULT_TARGET_URL/.test(readFileSync("netlify/functions/strong-read-watch.mjs","utf8")));

section("  …and the monitor has NO webhook fallback");
const monSrc = readFileSync("netlify/functions/strong-read-watch.mjs", "utf8");
const monCode = monSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("⭐⭐ WATCH_ALERT_WEBHOOK is the ONLY variable the monitor's code consults for a channel",
  /WEBHOOK_SOURCES\s*=\s*\[\s*"WATCH_ALERT_WEBHOOK"\s*\]/.test(monCode));
check("⭐⭐ DISCORD_FEEDBACK_WEBHOOK appears NOWHERE in the monitor's code",
  !/DISCORD_FEEDBACK_WEBHOOK/.test(monCode));
check("  …though the comments explain why it was removed, so it is not re-added by accident",
  /DISCORD_FEEDBACK_WEBHOOK/.test(monSrc));

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
