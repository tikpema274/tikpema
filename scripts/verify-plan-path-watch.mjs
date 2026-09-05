#!/usr/bin/env node
// verify-plan-path-watch.mjs — the between-deploys probe for the AGENT PLAN PATH.
//
//   node scripts/verify-plan-path-watch.mjs   (also: npm run test:planwatch)
//
// ═══ 🚨 WHAT THIS DEFENDS ════════════════════════════════════════════════════════════════════
// The probe must be UNABLE to report health during the outage it exists to catch. Two ways it
// could, both proven live on 2026-09-05 and both asserted against below:
//   1. keying on the HTTP STATUS — the outage answered 200
//   2. keying on `executed` — a hardcoded literal that read `true` on a total refusal
// And it must be unable to spend, must keep UNREADABLE distinct, and must survive being stopped.

import { readFileSync } from "node:fs";
import {
  OUTCOME, REASON, MIN_RERUN_MS, TTL_MS, REMINDER_MS, CRON_MS, EXPECTED_CRON, FUNCTION_NAME,
  PROBE_AMOUNT_USDC, DEFAULT_TARGET_URL, DEFAULT_PROBE_OWNER,
  judgePlanProbe, decideNotify, shouldSkipRerun, evaluateRecord, notifyMessage, buildRecord,
  firstDisclosure, assertNoSpend, isCannotVerify,
} from "../shared/plan-path-watch/watch.mjs";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

const HANDLER = readFileSync(new URL("../netlify/functions/plan-path-watch.mjs", import.meta.url), "utf8");
const MODULE = readFileSync(new URL("../shared/plan-path-watch/watch.mjs", import.meta.url), "utf8");
const TOML = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const res = (over = {}) => ({ status: 200, contentType: "application/json", body: "{}", networkError: null, timedOut: false, ...over });
const json = (o) => JSON.stringify(o);
/** The real production shape of a cap refusal, verbatim from the live probe on 2026-09-05. */
const CAP_BODY = { executed: true, completed: false, stoppedAt: 0, stepsRun: 0, stepsTotal: 1, totalUsdc: 200,
  results: [{ index: 0, ok: false, blocked: `step ~${(PROBE_AMOUNT_USDC + 0.053947).toFixed(2)} exceeds per-bridge limit of 25 USDC` }] };
/** The real outage shape, verbatim. */
const OUTAGE_BODY = { executed: false, blocked: "cannot value plan: cannot value a bridge without its fee — the day ceiling bounds amount + fee" };
const SPEND = { receiptsBefore: 22, receiptsAfter: 22 };
/** ⭐ THE ACKNOWLEDGE REFUSAL — a HEALTHY plan path that answers `executed:false`. Verbatim shape
 *  from agent-execute-plan's consent return. This is the fixture that proves `executed` cannot
 *  discriminate: it shares its value with the outage while being the opposite verdict. */
const ACK_BODY = { executed: false, needsAck: true,
  blocked: "step 1 would lose 89.9% to fees — the fee to Base (Sepolia) is ~0.0539 USDC of 0.06 USDC...",
  stepDisclosures: { 0: { band: "acknowledge", feeUsdc: 0.053947, feeRatio: 0.899, ackToken: "abc" } } };

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  plan-path-watch — the between-deploys probe for agent bridge plans  ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 ⛔⛔ IT CANNOT KEY ON `executed` — the field that lies");
{
  // 🚨 THE WHOLE POINT. The live cap refusal answers executed:true having run nothing; the live
  // outage answers executed:false. A probe keyed on `executed` would therefore call the REFUSAL
  // healthy and the OUTAGE unhealthy — inverted on the case that matters.
  ok("⭐ the healthy fixture really does carry executed:true (or this section is vacuous)",
    CAP_BODY.executed === true);
  ok("⭐ …and the outage fixture carries executed:false", OUTAGE_BODY.executed === false);

  const healthy = judgePlanProbe(res({ body: json(CAP_BODY) }), SPEND);
  const outage = judgePlanProbe(res({ body: json(OUTAGE_BODY) }), SPEND);
  ok("⭐⭐ the cap refusal (executed:true) is HEALTHY — judged on the DISCLOSURE",
    healthy.outcome === OUTCOME.HEALTHY, `${healthy.outcome}/${healthy.reason}`);
  ok("⭐⭐ the outage (executed:false) is BLOCKED",
    outage.outcome === OUTCOME.BLOCKED && outage.reason === REASON.UNVALUABLE, `${outage.outcome}/${outage.reason}`);

  // ═══ ⭐⭐ THE ASSERTION THAT ACTUALLY RETIRES `executed` ══════════════════════════════════
  // The acknowledge refusal is a HEALTHY plan path — it priced the step and asked for consent —
  // and it answers `executed:false`, the SAME value the outage answers. One value of the field
  // therefore spans both verdicts, so it cannot partition them in either direction. Asserting only
  // "cap is healthy, outage is blocked" would have been satisfied BY a probe keyed on `executed`,
  // since those two happen to differ on it. This pair is what rules it out.
  const ack = judgePlanProbe(res({ body: json(ACK_BODY) }), SPEND);
  ok("⭐⭐ the ACK refusal is HEALTHY — a priced decision was reached",
    ack.outcome === OUTCOME.HEALTHY, `${ack.outcome}/${ack.reason}`);
  ok("⭐⭐⭐ …and it shares `executed:false` with the OUTAGE — one value, two opposite verdicts",
    ACK_BODY.executed === false && OUTAGE_BODY.executed === false &&
    ack.outcome === OUTCOME.HEALTHY && outage.outcome === OUTCOME.BLOCKED);
  ok("⭐ the ACK path is legitimately `unverified` — it returns BEFORE the executor is entered",
    ack.spend.state === "unverified");

  // ⛔ SOURCE-LEVEL: the judge must never read the field at all.
  // ⛔ PRECISE: reading `executed` to RECOGNISE the endpoint is fine; branching a VERDICT on its
  // VALUE is the defect. So the ban is on comparing it to true/false, not on mentioning it.
  const code = strip(MODULE) + strip(HANDLER);
  ok("⛔ no verdict branches on the VALUE of `executed`",
    !/executed\s*===\s*(true|false)/.test(code) && !/if\s*\(\s*[A-Za-z_.?]*executed\s*\)/.test(code));
  ok("⭐ …and the one place it IS read is a shape test, labelled as such",
    /typeof body\.executed === "boolean"/.test(MODULE) && /shape test, NOT a health test/i.test(MODULE));
  ok("⭐ …and WHY it is unusable is written in the module, not left to be rediscovered",
    /hardcoded literal/i.test(MODULE) && /executor phase was entered/i.test(MODULE));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 ⛔ IT CANNOT KEY ON THE STATUS CODE — 200 is what the outage returned");
{
  const outage200 = judgePlanProbe(res({ status: 200, body: json(OUTAGE_BODY) }), SPEND);
  ok("⭐⭐ a 200 carrying the outage body is BLOCKED, not healthy",
    outage200.outcome === OUTCOME.BLOCKED, `${outage200.outcome}`);
  // The SPA trap: an unmatched path returns index.html at 200.
  const spa = judgePlanProbe(res({ status: 200, contentType: "text/html", body: "<!doctype html><html>" }), SPEND);
  ok("⛔ a 200 of SPA HTML is UNREADABLE — not healthy, and not 'blocked' either",
    spa.outcome === OUTCOME.UNREADABLE && spa.reason === REASON.NOT_JSON, `${spa.outcome}/${spa.reason}`);
  const shapeless = judgePlanProbe(res({ body: json({ hello: "world" }) }), SPEND);
  ok("⛔ a 200 of unrelated JSON is UNREADABLE — we judged something that is not this endpoint",
    shapeless.outcome === OUTCOME.UNREADABLE && shapeless.reason === REASON.WRONG_SHAPE);
  ok("⭐ …and the reason it must not read status as health is written down",
    /the outage answered \*\*200\*\*|answered \*\*200\*\*|outage answered/i.test(MODULE));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 🚨 IT CANNOT SPEND — and proves it every run rather than assuming");
{
  ok("⭐ the probe amount is above the 25 USDC per-bridge cap", PROBE_AMOUNT_USDC > 25, `${PROBE_AMOUNT_USDC}`);
  ok("⛔ …and the reason the ack-band amount was REJECTED as circular is stated",
    /circular/i.test(MODULE) && /consent gate/i.test(MODULE));

  ok("⭐ a clean run asserts the non-spend positively",
    assertNoSpend(CAP_BODY, SPEND).ok && assertNoSpend(CAP_BODY, SPEND).state === "clean");
  // ⛔⛔ THE REGRESSION THAT NEARLY SHIPPED. The outage body has NO stepsRun; the first draft read
  // that as evidence of spending and would have paged "MAY HAVE SPENT" on every run of the very
  // outage this monitor reports. Absence of the executor is the OPPOSITE of a spend.
  const outageSpend = assertNoSpend(OUTAGE_BODY, SPEND);
  ok("🚨 REGRESSION — the OUTAGE body is not read as a spend", outageSpend.ok, outageSpend.state);
  ok("⛔ …but it is `unverified`, not `clean` — absence is not proof either",
    outageSpend.state === "unverified");
  // ⭐ SCOPED TO THE CAP SHAPE. A `cap` disclosure comes from the terminal path, which always
  // reports stepsRun; its absence there is a shape change. A `band` disclosure is an early return
  // and is expected to lack it — demanding `clean` there would call the consent gate broken.
  ok("⛔⛔ a CAP disclosure with no stepsRun is UNREADABLE, never HEALTHY",
    judgePlanProbe(res({ body: json({ ...CAP_BODY, stepsRun: undefined }) }), SPEND).outcome === OUTCOME.UNREADABLE);
  // 🚨 EACH SPEND SIGNAL INDEPENDENTLY RAISES THE ALARM.
  ok("🚨 stepsRun > 0 → SPENT, never healthy",
    judgePlanProbe(res({ body: json({ ...CAP_BODY, stepsRun: 1 }) }), SPEND).reason === REASON.SPENT);
  ok("🚨 completed:true → SPENT",
    judgePlanProbe(res({ body: json({ ...CAP_BODY, completed: true }) }), SPEND).reason === REASON.SPENT);
  ok("🚨 the receipt count MOVED → SPENT, even with a perfect body",
    judgePlanProbe(res({ body: json(CAP_BODY) }), { receiptsBefore: 22, receiptsAfter: 23 }).reason === REASON.SPENT);
  ok("⭐⭐ the spend check runs BEFORE the verdict — a disclosure can never mask a spend",
    judgePlanProbe(res({ body: json({ ...CAP_BODY, stepsRun: 1 }) }), SPEND).outcome !== OUTCOME.HEALTHY);
  // ⛔ An unreadable count must not read as "unchanged".
  ok("⛔ an UNREADABLE receipt count is not compared, and does not fake a pass",
    assertNoSpend(CAP_BODY, { receiptsBefore: null, receiptsAfter: null }).receiptsBefore === null);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 ⛔ THREE OUTCOMES — UNREADABLE never collapses into either");
{
  const cases = [
    ["unreachable", res({ networkError: "TypeError", status: null }), REASON.UNREACHABLE],
    ["timeout", res({ timedOut: true }), REASON.TIMEOUT],
    ["http 500", res({ status: 500 }), REASON.HTTP_ERROR],
    ["no secret", res({ secretMissing: true }), REASON.NO_SECRET],
  ];
  for (const [name, r, reason] of cases) {
    const j = judgePlanProbe(r, SPEND);
    ok(`⛔ ${name} → UNREADABLE/${reason}`, j.outcome === OUTCOME.UNREADABLE && j.reason === reason, `${j.outcome}/${j.reason}`);
    ok(`   …and it claims NOTHING about the plan path`, isCannotVerify(j.reason) &&
      /says NOTHING about whether agent plans work/i.test(notifyMessage({ kind: "first-failure", judgement: j, target: "t", record: {} })));
  }
  ok("⭐⭐ the three outcomes are DISTINCT values — a collapse would make the set meaningless",
    new Set([OUTCOME.HEALTHY, OUTCOME.BLOCKED, OUTCOME.UNREADABLE]).size === 3);
  // ⭐ A move BETWEEN not-healthy states is information, not silence.
  ok("⭐ blocked → unreadable NOTIFIES (we can no longer tell, which is a change worth knowing)",
    decideNotify({ prevOutcome: OUTCOME.BLOCKED, outcome: OUTCOME.UNREADABLE, lastNotifiedAt: new Date().toISOString(), now: Date.now() }).notify === true);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 ⭐ NOTIFY DISCIPLINE — transitions plus a bounded reminder");
{
  const now = Date.now(), iso = (ms) => new Date(ms).toISOString();
  ok("first HEALTHY is quiet", decideNotify({ prevOutcome: null, outcome: OUTCOME.HEALTHY, lastNotifiedAt: null, now }).notify === false);
  ok("first failure notifies", decideNotify({ prevOutcome: null, outcome: OUTCOME.BLOCKED, lastNotifiedAt: null, now }).notify === true);
  ok("⭐ healthy → blocked notifies (regressed)", decideNotify({ prevOutcome: OUTCOME.HEALTHY, outcome: OUTCOME.BLOCKED, lastNotifiedAt: null, now }).notify === true);
  ok("⭐ blocked → healthy notifies (recovered)", decideNotify({ prevOutcome: OUTCOME.BLOCKED, outcome: OUTCOME.HEALTHY, lastNotifiedAt: null, now }).notify === true);
  ok("steady healthy is silent", decideNotify({ prevOutcome: OUTCOME.HEALTHY, outcome: OUTCOME.HEALTHY, lastNotifiedAt: null, now }).notify === false);
  ok("⛔ a never-notified failure streak notifies NOW rather than waiting out the window",
    decideNotify({ prevOutcome: OUTCOME.BLOCKED, outcome: OUTCOME.BLOCKED, lastNotifiedAt: null, now }).notify === true);
  ok("still failing, recently told → quiet",
    decideNotify({ prevOutcome: OUTCOME.BLOCKED, outcome: OUTCOME.BLOCKED, lastNotifiedAt: iso(now - 60_000), now }).notify === false);
  ok("⭐ …but reminds once the reminder window passes",
    decideNotify({ prevOutcome: OUTCOME.BLOCKED, outcome: OUTCOME.BLOCKED, lastNotifiedAt: iso(now - REMINDER_MS - 1), now }).notify === true);
  ok("⭐ the outage alert names the caller-set check, so the reader knows what to run",
    /test:feebinding/.test(notifyMessage({ kind: "regressed", judgement: judgePlanProbe(res({ body: json(OUTAGE_BODY) }), SPEND), target: "t", record: {} })));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 ⭐⭐ IT WRITES INCREMENTALLY — a stopped run must not lose everything");
{
  ok("⭐⭐ an ATTEMPT record is written BEFORE the fetch",
    /phase: "attempt"/.test(HANDLER) &&
    HANDLER.indexOf('phase: "attempt"') < HANDLER.indexOf("await fetch(TARGET"), "attempt write precedes the request");
  ok("⭐ …and it says what its own survival means", /did not come back/i.test(HANDLER));
  ok("⛔ a failure is ALSO written under an immutable key — `latest` alone would lose a refusal that recovered",
    /failure:\$\{producedAt\}/.test(HANDLER));
  ok("⭐ the record carries a phase so a reader can tell attempt from complete",
    /phase: "complete"/.test(MODULE));
  ok("⛔ the handler names NO read consistency anywhere — it must not break in the outage it reports",
    !/consistency/i.test(strip(HANDLER)));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 ⚠️ THE SCHEDULE, AND THE ORDERING IT DEPENDS ON");
{
  ok("⭐⭐ netlify.toml registers this function on the schedule the CODE expects",
    new RegExp(`\\[functions\\."${FUNCTION_NAME}"\\][\\s\\S]{0,200}?schedule = "${EXPECTED_CRON.replace(/\*/g, "\\*")}"`).test(TOML),
    EXPECTED_CRON);
  ok("⛔ MIN_RERUN < CRON < TTL — shorter and it dedupes itself silent; longer and every record is stale",
    MIN_RERUN_MS < CRON_MS && CRON_MS < TTL_MS, `${MIN_RERUN_MS / 60000}m < ${CRON_MS / 60000}m < ${TTL_MS / 60000}m`);
  ok("⭐ the numbers differ from strong-read-watch's 7/15/45 — nobody should assume one covers the other",
    !(MIN_RERUN_MS === 7 * 60000 && CRON_MS === 15 * 60000 && TTL_MS === 45 * 60000));
  ok("⚠️ the LIMIT is recorded IN THE MODULE, beside the cadence it qualifies",
    /WITHIN ITS\s+INTERVAL/i.test(MODULE) && /no finer/i.test(MODULE));
  ok("⭐ …and netlify.toml says so too, where the interval is actually set",
    /and no finer/i.test(TOML));
  const rec = buildRecord({ judgement: judgePlanProbe(res({ body: json(CAP_BODY) }), SPEND), target: DEFAULT_TARGET_URL, producedAt: new Date().toISOString() });
  ok("⭐ a fresh healthy record serves", evaluateRecord({ record: rec, now: Date.now() }).serve === true);
  ok("⛔ …and a stale one does NOT, however healthy it says it is",
    evaluateRecord({ record: { ...rec, producedAt: new Date(Date.now() - TTL_MS - 1).toISOString() }, now: Date.now() }).serve === false);
  ok("⛔ absence is a refusal, never 'fine'", evaluateRecord({ record: null, now: Date.now() }).serve === false);
  ok("⭐ the rerun guard dedupes a platform double-fire",
    shouldSkipRerun({ record: rec, now: Date.now() }).skip === true);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("8 ⭐ THE DISCLOSURE IS POSITIVE EVIDENCE, not an absence of failure");
{
  const d = firstDisclosure(CAP_BODY);
  ok("⭐ the cap refusal yields a disclosure", d?.kind === "cap", JSON.stringify(d));
  ok("⭐⭐ …whose valued figure EXCEEDS the requested amount — i.e. the fee was resolved",
    d.valuedUsdc > PROBE_AMOUNT_USDC, `${d.valuedUsdc} > ${PROBE_AMOUNT_USDC} (fee ≈ ${d.feeImpliedUsdc})`);
  const band = firstDisclosure({ stepDisclosures: { 0: { band: "acknowledge", feeUsdc: 0.05, feeRatio: 0.9 } } });
  ok("⭐ the acknowledge shape also counts as a disclosure", band?.kind === "band" && band.band === "acknowledge");
  ok("⛔ the outage body yields NO disclosure — the property is genuinely absent there",
    firstDisclosure(OUTAGE_BODY) === null);
  ok("⛔ a refusal with no disclosure and no known reason is BLOCKED/refused-other, never healthy",
    judgePlanProbe(res({ body: json({ executed: false, blocked: "something else entirely" }) }), SPEND).reason === REASON.REFUSED_OTHER);
  ok("⭐ the probe owner is the one gate:forgery already uses — no new wallet is provisioned",
    DEFAULT_PROBE_OWNER === "0xfd801d082479e69f93bf79ccbf5f9dfe3c615767" && /ensureOwnerWallet/.test(HANDLER));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
