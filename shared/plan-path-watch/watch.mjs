// watch.mjs — pure logic for the AGENT PLAN PATH monitor. No I/O, no Blobs, no fetch.
//
// ═══ 🚨 WHAT THIS EXISTS FOR ═════════════════════════════════════════════════════════════════
// On 2026-09-03 22:35 (f760077) `valueOfStep` gained a REQUIRED bridge fee. Two callers were left
// on the old contract, so EVERY agent plan containing a bridge step was refused at valuation:
//
//     HTTP 200   { executed: false, blocked: "cannot value plan: cannot value a bridge
//                  without its fee — the day ceiling bounds amount + fee" }
//
// It stayed broken for ~38 hours. The only thing that touches this path — `gate:forgery` — runs
// ONLY inside `deploy:prod`, so it could report the symptom but had no earlier observation to
// compare against and could not say when it began. Nothing ran between deploys.
//
// ⭐ AND NOBODY NOTICED BECAUSE THE PATHS PEOPLE USE WERE HEALTHY. A direct agent bridge and a
// single `bridge_usdc` action both reach `executeAction`, which threads the fee correctly. Three
// bridges completed during the window. The dead path was the one nobody exercised — which is
// exactly the shape a scheduled probe exists to cover.
//
// ═══ ⛔⛔ TWO THINGS THIS MUST NEVER KEY ON ═══════════════════════════════════════════════════
//
// 1. THE HTTP STATUS CODE. The outage answered **200**. `agent-execute-plan` reports refusals in
//    the BODY (`blocked`), so every status-shaped liveness check passes straight through it. This
//    is the same SPA-trap lesson one layer up: a 200 proves a response, never a healthy one.
//
// 2. ⛔ THE `executed` FIELD. It is a HARDCODED LITERAL (`agent-execute-plan.mjs`, the terminal
//    `return json(200, { executed: true, ... })`) meaning "the executor phase was entered" — NOT
//    that anything ran. MEASURED LIVE 2026-09-05: a plan refused at the per-bridge cap answered
//    `executed: true` with `stepsRun: 0`, `stoppedAt: 0`, `completed: false` and moved nothing.
//
//    ⭐⭐ AND THE DECISIVE PART — `executed: false` OCCURS IN BOTH A HEALTHY AND A BROKEN STATE:
//        HEALTHY: the ACKNOWLEDGE refusal returns `executed:false` WITH a full `stepDisclosures`
//                 payload. The plan priced its step and asked for consent. Nothing is wrong.
//        BROKEN:  the valuation outage returns `executed:false` with `blocked` and NO disclosure.
//    One value of the field therefore spans both verdicts, and the other (`true`) means only "we
//    reached the loop". It partitions nothing, in either direction.
//    ⚠️ NOTE THE NEAR-MISS: the cap refusal (healthy) and the outage (broken) happen to DIFFER on
//    `executed`, so a probe keyed on it would look correct against those two alone. It is the
//    acknowledge case that rules the field out — which is why the suite asserts that pair.
//    The field name is also false in the one case a reader needs it true.
//    [[field-name-must-be-true-in-every-case]]
//
// ⭐ THE PROPERTY IS THEREFORE: DID THE REQUEST REACH A DISCLOSURE? A plan that priced its bridge
// step and reached a band is a plan whose valuation worked. That is the thing f760077 broke, and
// it is observable without asserting anything about execution.

/** ⛔ THE CLOSED SET. Three outcomes, never two. An open-ended string is how an unknown slips in
 *  wearing the name of a known-good state. */
export const OUTCOME = Object.freeze({
  HEALTHY: "healthy",       // a disclosure was reached — valuation and pricing both worked
  BLOCKED: "blocked",       // the endpoint answered and REFUSED — the outage shape
  UNREADABLE: "unreadable", // we could not ask, or could not understand the answer
});

/** ⛔ THE SPEND VERDICT IS ALSO THREE-STATE, for the same reason the outcome is: "we did not
 *  confirm" is not "we confirmed nothing happened". */
export const SPEND = Object.freeze({
  CLEAN: "clean",           // the endpoint reported stepsRun 0 — positive evidence nothing ran
  UNVERIFIED: "unverified", // refused before the executor; no positive evidence either way
  SPENT: "spent",           // 🚨 something ran
});

/** Why, within an outcome. Closed, for the same reason. */
export const REASON = Object.freeze({
  DISCLOSED: "disclosed",
  UNVALUABLE: "unvaluable",           // the f760077 shape, by name
  REFUSED_OTHER: "refused-other",     // a different gate refused — still BLOCKED, not healthy
  SPENT: "spent",                     // 🚨 the probe moved money. Never expected. Always an alarm.
  UNREACHABLE: "unreachable",
  TIMEOUT: "timeout",
  HTTP_ERROR: "http-error",
  NOT_JSON: "not-json",
  WRONG_SHAPE: "wrong-shape",
  NO_SECRET: "no-secret",
});

/** ⚠️ A FAILURE TO OBSERVE IS NOT AN OBSERVED FAILURE. These reasons mean we learned NOTHING about
 *  the plan path, so the alert must claim nothing about it. Same rule the strong-read monitor had
 *  to learn after its first real alert asserted a broken state it had never observed. */
const CANNOT_VERIFY = new Set([
  REASON.UNREACHABLE, REASON.TIMEOUT, REASON.HTTP_ERROR,
  REASON.NOT_JSON, REASON.WRONG_SHAPE, REASON.NO_SECRET,
]);

export const isCannotVerify = (reason) => CANNOT_VERIFY.has(reason);

/** Overlap guard — a platform double-fire must not double-probe and double-notify. */
export const MIN_RERUN_MS = 12 * 60 * 1000;

/** How long a record vouches for the plan path. 3x the cron period: two missed runs tolerated. */
export const TTL_MS = 90 * 60 * 1000;

/** While still failing, re-notify at most this often. Transition-only goes silent during a long
 *  outage; every-run pages forever. */
export const REMINDER_MS = 60 * 60 * 1000;

/** ⚠️ LOAD-BEARING ORDERING: MIN_RERUN_MS < CRON_MS < TTL_MS. Asserted by the suite.
 *  ⭐ DELIBERATELY NOT the strong-read monitor's 7/15/45. Different monitor, different thing
 *  guarded; matching numbers invite the assumption that one covers the other. */
/** ⚠️ THE LIMIT, STATED WHERE THE CADENCE IS SET.
 *  This monitor dates a failure to WITHIN ITS INTERVAL — 30 minutes — and no finer.
 *  It is not continuous monitoring and must never be described as such: a break at 12:01 is
 *  indistinguishable from one at 12:29, and the record can only ever say "sometime in this
 *  window". What it buys over a deploy-time gate is not precision but INDEPENDENCE FROM DEPLOYS
 *  — the 38-hour outage was invisible precisely because nothing ran between them. */
export const EXPECTED_CRON = "*/30 * * * *";
export const CRON_MS = Number(EXPECTED_CRON.match(/^\*\/(\d+) \* \* \* \*$/)[1]) * 60 * 1000;
export const FUNCTION_NAME = "plan-path-watch";

/** ═══ ⭐⭐ HOW MANY COMPLETED PROBES `latest` REMEMBERS. THE BOUND IS THE POINT. ═══════════════
 *  8 entries at a 30-minute cadence is ~4 hours of history, in ONE key, overwritten in place —
 *  no new keys per run, so a healthy run costs exactly the write it already made.
 *
 *  🚨 WHY THIS EXISTS. Until 2026-09-05 this monitor could not answer "did it keep running?" from
 *  its own store. Healthy runs overwrite `latest` and only FAILURES got immutable `failure:<ts>`
 *  keys, so the store held ONE key and no history. The dedupe failure — MIN_RERUN_MS set above the
 *  cron period, every run after the first returning `{skipped:true}` — freezes `producedAt` while
 *  leaving a perfectly healthy record in place. On a single read that is INDISTINGUISHABLE from a
 *  running monitor. It was ruled out that day only because someone was polling live, and that
 *  instrument does not survive the session. [[observation-that-does-not-survive]] */
export const TICK_HISTORY = 8;

/** ⛔ THE PROBE AMOUNT IS ABOVE THE PER-BRIDGE CAP, AND THAT IS THE SAFETY MECHANISM.
 *
 * The cap check runs in the execution loop BEFORE `executeAction`, so a step valued over it is
 * refused having moved nothing. Proven live 2026-09-05: `stepsRun 0 of 1`, receipts unchanged.
 *
 * ⭐⭐ WHY NOT THE ACKNOWLEDGE-BAND AMOUNT (0.06, ~90% fee ratio), which `gate:forgery` uses?
 * Because that probe's safety rests on the CONSENT GATE — and a probe whose safety depends on a
 * gate it is also testing is CIRCULAR: the run where consent breaks is the run where the probe
 * spends. The cap path has no such coupling. It is also the better instrument: it exercises the
 * NON-ack route, so a pass does not rest on the acknowledge short-circuit.
 *
 * ⚠️ IT IS A BOUND, NOT AN IMPOSSIBILITY, AND THE RUN PROVES IT EVERY TIME rather than assuming:
 * `assertNoSpend` below requires stepsRun 0, completed false, AND an unchanged receipt count.
 */
export const PROBE_AMOUNT_USDC = 200;
export const PROBE_DESTINATION = "base";

/** The deployed endpoint under test. Declared here so the promotion gate can check the deployed env
 *  against ONE expectation rather than a second copy that drifts. */
export const DEFAULT_TARGET_URL = "https://app.tikpema.xyz/api/agent-execute-plan";
export const DEFAULT_STORE_NAME = "plan-path-watch";

/** The owner the probe acts as — the SAME wallet `gate:forgery` already probes with, so this
 *  introduces no new identity and no new wallet provisioning (`ensureOwnerWallet` takes its fast
 *  path on an already-mapped owner; a fresh address would MINT a Circle wallet). */
export const DEFAULT_PROBE_OWNER = "0xfd801d082479e69f93bf79ccbf5f9dfe3c615767";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Judge one probe response.
 *
 * @param {{status:number|null, contentType:string|null, body:string|null,
 *          networkError:string|null, timedOut:boolean, secretMissing?:boolean}} res
 * @param {{receiptsBefore:number|null, receiptsAfter:number|null}} spend
 */
export function judgePlanProbe(res, spend = {}) {
  const cannot = (reason, detail) =>
    ({ outcome: OUTCOME.UNREADABLE, reason, detail, disclosure: null, spend: null });

  // ⛔ A MISSING CREDENTIAL IS UNREADABLE, NEVER HEALTHY AND NEVER BLOCKED. A monitor that
  // quietly no-ops without its secret reports success for a path it never examined.
  if (res?.secretMissing) return cannot(REASON.NO_SECRET, "no session secret available — the probe could not authenticate, so nothing was observed");
  if (res?.timedOut) return cannot(REASON.TIMEOUT, "the endpoint did not answer before the deadline");
  if (res?.networkError) return cannot(REASON.UNREACHABLE, `the endpoint could not be reached (${res.networkError})`);
  // ⚠️ NOT a health signal — only a readability one. The outage returned 200; this rejects 4xx/5xx
  // as "we could not ask", which is a different claim from "the path is broken".
  if (res?.status !== 200) return cannot(REASON.HTTP_ERROR, `the endpoint answered HTTP ${res?.status}`);

  let body;
  try { body = JSON.parse(String(res.body ?? "")); }
  catch {
    return cannot(REASON.NOT_JSON, `the response was not JSON (content-type ${res.contentType || "none"}) — most likely the SPA fallback, which means the function is not deployed`);
  }
  if (!isObj(body)) return cannot(REASON.NOT_JSON, "the response parsed but is not an object");

  // The shape must be recognisably this endpoint's, or we are judging something else.
  // ⚠️ THE ONLY READ OF `executed` IN THIS FILE, AND IT IS A SHAPE TEST, NOT A HEALTH TEST — it
  // asks "is this our endpoint?", never "is it working?". No verdict below branches on its value.
  const looksLikePlan =
    typeof body.executed === "boolean" ||
    typeof body.blocked === "string" ||
    Array.isArray(body.results);
  if (!looksLikePlan) return cannot(REASON.WRONG_SHAPE, "the response is JSON but carries none of executed/blocked/results");

  // ═══ 🚨 THE SPEND CHECK COMES FIRST, BEFORE ANY VERDICT ═══════════════════════════════════
  // If the probe ever moves money, that is the alarm — not a footnote on an otherwise-fine run,
  // and never something a HEALTHY verdict could mask.
  const spendVerdict = assertNoSpend(body, spend);
  if (!spendVerdict.ok) {
    return { outcome: OUTCOME.BLOCKED, reason: REASON.SPENT, detail: spendVerdict.detail,
             disclosure: null, spend: spendVerdict };
  }

  // ═══ ⭐ THE PROPERTY: DID IT REACH A DISCLOSURE? ═══════════════════════════════════════════
  // Two shapes carry one: `stepDisclosures` (the acknowledge refusal) and a per-step result whose
  // refusal quotes a VALUED figure. The cap refusal is the latter — reaching it proves valuation
  // and pricing both ran, which is exactly what f760077 broke.
  const disc = firstDisclosure(body);
  // ⛔ HEALTHY REQUIRES POSITIVE NON-SPEND EVIDENCE. A disclosure reached without a `clean` spend
  // verdict is not something to call healthy — it would be asserting a safety property nobody
  // measured. In practice the cap refusal always carries stepsRun 0, so this never fires by
  // accident; it fires when the response shape changes underneath us, which is when it matters.
  // ⭐ SCOPED TO THE CAP SHAPE. A `cap` disclosure comes from the TERMINAL path, which always
  // reports `stepsRun`; its absence there is a shape change and must not be waved through. A
  // `band` disclosure is an EARLY RETURN made before the executor is entered, so `unverified` is
  // its correct state — demanding `clean` there would call the acknowledge gate broken.
  if (disc?.kind === "cap" && spendVerdict.state !== SPEND.CLEAN) {
    return { outcome: OUTCOME.UNREADABLE, reason: REASON.WRONG_SHAPE,
             detail: `a cap disclosure was reached but carried no stepsRun, so the non-spend could not be confirmed (${spendVerdict.detail})`,
             disclosure: disc, spend: spendVerdict };
  }
  if (disc) {
    return { outcome: OUTCOME.HEALTHY, reason: REASON.DISCLOSED,
             detail: `the plan reached a priced decision (${disc.kind})`, disclosure: disc, spend: spendVerdict };
  }

  // Anything else that answered is a REFUSAL. Name the outage shape specifically.
  const blocked = String(body.blocked ?? body.results?.[0]?.blocked ?? "");
  if (/cannot value a bridge without its fee/i.test(blocked)) {
    return { outcome: OUTCOME.BLOCKED, reason: REASON.UNVALUABLE,
             detail: `valuation refused: ${blocked}`, disclosure: null, spend: spendVerdict };
  }
  return { outcome: OUTCOME.BLOCKED, reason: REASON.REFUSED_OTHER,
           detail: blocked ? `refused before any disclosure: ${blocked}` : "no disclosure and no stated reason",
           disclosure: null, spend: spendVerdict };
}

/**
 * ⭐ A DISCLOSURE IS A PRICED DECISION, and there are two legitimate shapes.
 * The cap refusal names a value that INCLUDES the fee ("step ~200.05 exceeds…"), which is only
 * derivable if the fee was resolved — so it is positive evidence, not an absence of failure.
 */
export function firstDisclosure(body) {
  const sd = body?.stepDisclosures;
  if (isObj(sd)) {
    const k = Object.keys(sd)[0];
    const d = k !== undefined ? sd[k] : null;
    if (isObj(d) && typeof d.band === "string") {
      return { kind: "band", band: d.band, feeUsdc: d.feeUsdc ?? null, feeRatio: d.feeRatio ?? null };
    }
  }
  const capMsg = String(body?.results?.[0]?.blocked ?? "");
  // "step ~200.05 exceeds per-bridge limit of 25 USDC" — the ~figure is the VALUED amount.
  const m = /step ~([0-9]+(?:\.[0-9]+)?) exceeds per-bridge limit of ([0-9.]+)/i.exec(capMsg);
  if (m) {
    const valued = Number(m[1]);
    return { kind: "cap", valuedUsdc: valued, capUsdc: Number(m[2]),
             // ⭐ THE FEE IS VISIBLE IN THE VALUATION. valued > requested means amount + fee, the
             // post-f760077 semantics. Reported so a reader can see the mechanism, not just a verdict.
             feeImpliedUsdc: Number((valued - PROBE_AMOUNT_USDC).toFixed(6)) };
  }
  return null;
}

/**
 * ⛔ PROVE THE NON-SPEND POSITIVELY, EVERY RUN. Not "the amount was over the cap so it cannot have
 * spent" — that is the assumption; this is the measurement.
 */
export function assertNoSpend(body, { receiptsBefore = null, receiptsAfter = null } = {}) {
  const stepsRun = body?.stepsRun;
  const completed = body?.completed;
  const comparable = Number.isFinite(receiptsBefore) && Number.isFinite(receiptsAfter);
  const moved = comparable && receiptsAfter !== receiptsBefore;

  // ── POSITIVE SPEND SIGNALS. Any one of these is the alarm. ────────────────────────────────
  const problems = [];
  if (Number.isFinite(stepsRun) && stepsRun > 0) problems.push(`stepsRun=${stepsRun}`);
  if (completed === true) problems.push("completed=true");
  if (moved) problems.push(`receipts ${receiptsBefore} → ${receiptsAfter}`);
  if (problems.length) {
    return { state: SPEND.SPENT, ok: false, stepsRun: stepsRun ?? null, completed: completed ?? null,
             receiptsBefore, receiptsAfter, corroborated: comparable,
             detail: `🚨 THE PROBE MAY HAVE SPENT — ${problems.join("; ")}` };
  }

  // ═══ ⛔⛔ ABSENT `stepsRun` IS *NOT* A SPEND SIGNAL — AND THIS WAS A REAL BUG ═══════════════
  // A refusal that never reaches the execution loop (the OUTAGE shape: `{executed:false, blocked}`)
  // carries no `stepsRun` at all. The first draft treated `stepsRun !== 0` as evidence of spending,
  // so it judged the outage body `spent` — it would have paged "THE PROBE MAY HAVE SPENT" on every
  // single run of the exact failure it exists to report, burying the real finding under a false
  // one. ⭐ Absence of the field means the executor never ran; that is the OPPOSITE of a spend.
  //
  // ⚠️ BUT ABSENCE MUST NOT READ AS PROOF EITHER. So it is its own state: `unverified` — no
  // positive evidence in either direction. A BLOCKED verdict tolerates it (nothing was going to run
  // anyway); a HEALTHY verdict must NOT rest on it, and `judgePlanProbe` requires `clean`.
  // [[absence-must-never-read-as-safe]]
  const state = Number.isFinite(stepsRun) ? SPEND.CLEAN : SPEND.UNVERIFIED;
  return {
    state, ok: true, stepsRun: stepsRun ?? null, completed: completed ?? null,
    receiptsBefore, receiptsAfter, corroborated: comparable,
    detail: state === SPEND.CLEAN
      ? `nothing ran: stepsRun 0, not completed${comparable ? `, receipts unchanged at ${receiptsAfter}` : ", receipt count UNREADABLE (not corroborated)"}`
      : `the executor was never entered (no stepsRun) — no spend was possible, but nothing positively confirms it${comparable ? `; receipts unchanged at ${receiptsAfter}` : " and the receipt count was UNREADABLE"}`,
  };
}

/** Recent-run guard. Identical intent to the strong-read monitor's, stated here rather than
 *  imported — these monitors share no code by design, so neither can break the other. */
export function shouldSkipRerun({ record, now, minRerunMs = MIN_RERUN_MS }) {
  if (!isObj(record)) return { skip: false, reason: "no-record" };
  const at = Date.parse(record.producedAt);
  if (!Number.isFinite(at)) return { skip: false, reason: "malformed" };
  const ageMs = now - at;
  if (ageMs < 0) return { skip: false, reason: "future-dated" };
  if (ageMs > minRerunMs) return { skip: false, reason: "older-than-window" };
  return { skip: true, reason: "recent-run", ageMs };
}

/** Is an existing record still worth anything? Absence, staleness and malformation are REFUSALS. */
export function evaluateRecord({ record, now, ttlMs = TTL_MS }) {
  if (!isObj(record)) return { serve: false, reason: "no-record" };
  const at = Date.parse(record.producedAt);
  if (!Number.isFinite(at) || typeof record.outcome !== "string") return { serve: false, reason: "malformed" };
  const ageMs = now - at;
  if (ageMs < 0) return { serve: false, reason: "future-dated" };
  if (ageMs > ttlMs) return { serve: false, reason: "stale", ageMs };
  return { serve: record.outcome === OUTCOME.HEALTHY, reason: record.outcome, ageMs };
}

/**
 * Transitions plus a low-rate reminder.
 *
 * ⛔ UNREADABLE IS ITS OWN STATE AND NEVER COLLAPSES. Folding it into HEALTHY hides an outage
 * behind a broken instrument; folding it into BLOCKED raises a false alarm about a path we did
 * not observe — which this repo has already paid for once, with an alert that told someone to roll
 * back a healthy deploy at 3am. So a move BETWEEN not-healthy states still notifies: going from
 * "the plan path is refusing" to "we can no longer tell" is information, not silence.
 */
export function decideNotify({ prevOutcome, outcome, lastNotifiedAt, now, reminderMs = REMINDER_MS }) {
  const since = Number.isFinite(Date.parse(lastNotifiedAt)) ? Date.parse(lastNotifiedAt) : null;
  const healthy = outcome === OUTCOME.HEALTHY;
  const prevHealthy = prevOutcome === OUTCOME.HEALTHY;

  if (healthy) {
    if (prevOutcome == null) return { notify: false, kind: "first-ok" };
    return prevHealthy ? { notify: false, kind: "steady-ok" } : { notify: true, kind: "recovered" };
  }
  if (prevOutcome == null) return { notify: true, kind: "first-failure" };
  if (prevHealthy) return { notify: true, kind: "regressed" };
  // Not healthy before, not healthy now.
  if (prevOutcome !== outcome) return { notify: true, kind: "changed" };
  if (since === null || now - since >= reminderMs) return { notify: true, kind: "still-failing" };
  return { notify: false, kind: "still-failing-quiet" };
}

/** The alert. ⛔ An UNREADABLE run claims NOTHING about the plan path. */
export function notifyMessage({ kind, judgement, target, record }) {
  const cannot = isCannotVerify(judgement.reason);
  const head =
    judgement.outcome === OUTCOME.HEALTHY
      ? "✅ **RECOVERED** — agent bridge plans reach a priced decision again"
      : judgement.reason === REASON.SPENT
        ? "🚨🚨 **THE PLAN-PATH PROBE MAY HAVE SPENT** — investigate before anything else"
        : cannot
          ? "⚠️ **CANNOT VERIFY THE AGENT PLAN PATH** — the probe never got an answer"
          : {
              regressed: "🚨 **AGENT BRIDGE PLANS ARE REFUSED ON PROD**",
              "first-failure": "🚨 **AGENT BRIDGE PLANS ARE REFUSED ON PROD** (first observation)",
              "still-failing": "🚨 **STILL REFUSED** — agent bridge plans on prod",
              changed: "🚨 **AGENT BRIDGE PLANS — the refusal changed shape**",
            }[kind] || "🚨 **AGENT BRIDGE PLANS ARE REFUSED ON PROD**";

  const lines = [head, "", `outcome: \`${judgement.outcome}\` · reason: \`${judgement.reason}\``, judgement.detail];

  if (cannot) {
    lines.push("", "⛔ This says NOTHING about whether agent plans work — only that we could not ask. Check the site is up before concluding anything about the plan path.");
  } else if (judgement.outcome === OUTCOME.BLOCKED && judgement.reason === REASON.UNVALUABLE) {
    lines.push("", "⭐ This is the f760077 shape: a caller reached `valueOfStep` without a resolved bridge fee. Check every call site — `npm run test:feebinding` asserts the whole caller set.");
  }
  if (judgement.spend && !judgement.spend.ok) lines.push("", judgement.spend.detail);
  lines.push("", `probe: ${target}`, `at: ${record?.producedAt ?? new Date(Date.now()).toISOString()}`);
  // ⚠️ 2000 is Discord's hard limit; truncate rather than have the POST rejected and lose the alert.
  return lines.join("\n").slice(0, 1900);
}

/**
 * The durable record. `attempt` is written BEFORE the probe — see the handler.
 *
 * ⭐⭐ THE SINGLE-READ DISCRIMINATOR IS `lastInvokedAt` vs `producedAt`.
 *   `lastInvokedAt` moves on EVERY invocation, including one that dedupes and probes nothing.
 *   `producedAt`    moves only when a probe actually completed.
 * A monitor that is being invoked but never probing therefore shows a fresh `lastInvokedAt` beside
 * a stale `producedAt` — visible in one read, with no history and no second key needed. The rolling
 * `recentProducedAt` then shows the CADENCE, so a reader can see the interval rather than infer it.
 */
export function buildRecord({ judgement, target, producedAt, deployId = null, prev = null }) {
  const history = [producedAt, ...(Array.isArray(prev?.recentProducedAt) ? prev.recentProducedAt : [])]
    .filter((t) => typeof t === "string")
    .slice(0, TICK_HISTORY);
  return {
    schema: "plan-path-watch/1",
    producedAt,
    lastInvokedAt: producedAt,
    phase: "complete",
    outcome: judgement.outcome,
    reason: judgement.reason,
    detail: judgement.detail,
    disclosure: judgement.disclosure,
    spend: judgement.spend,
    target,
    deployId,
    prevOutcome: prev?.outcome ?? null,
    lastNotifiedAt: prev?.lastNotifiedAt ?? null,
    // ⭐ COUNTS, CARRIED FORWARD. Monotonic, so a reset to 0 is itself a signal (a new store, or a
    // record that was rebuilt rather than updated).
    runCount: (Number.isFinite(prev?.runCount) ? prev.runCount : 0) + 1,
    skipCount: Number.isFinite(prev?.skipCount) ? prev.skipCount : 0,
    lastSkipAt: prev?.lastSkipAt ?? null,
    recentProducedAt: history,
  };
}

/**
 * ⛔ A SKIPPED RUN MUST BE VISIBLE AS A SKIP, NOT AS SILENCE.
 *
 * The dedupe path used to `return` before writing anything, so a monitor skipping every run left a
 * store identical to one that had simply not been invoked yet — and identical to a healthy one, if
 * you only read `outcome`. Now it writes the SAME key, updating only the bookkeeping and leaving
 * the verdict fields exactly as they were: the last real verdict is not overwritten by a
 * non-observation.
 *
 * ⚠️ NOT A WRITE STORM. One write per invocation, which is what a completed run already costs, and
 * invocations are bounded by the cron. A skip is strictly cheaper than a probe — it makes no HTTP
 * request — so this can only ever reduce work per invocation.
 */
export function buildSkipRecord({ prev, now, reason = "recent-run" }) {
  const at = new Date(now).toISOString();
  return {
    ...prev,
    lastInvokedAt: at,
    lastSkipAt: at,
    skipReason: reason,
    skipCount: (Number.isFinite(prev?.skipCount) ? prev.skipCount : 0) + 1,
    // ⛔ `producedAt`, `outcome` and the history are DELIBERATELY untouched. A skip observed
    // nothing; writing a verdict here would manufacture an observation that never happened.
  };
}

/** The cadence verdicts. Closed, like every other verdict set here. */
export const CADENCE = Object.freeze({
  RUNNING: "running",
  DEGRADED: "degraded",               // probing, but materially slower than the cron asks
  FROZEN_SKIPPING: "frozen-skipping", // being invoked, never probing — THE DEDUPE FAILURE
  NOT_INVOKED: "not-invoked",         // the schedule itself stopped firing
  NO_RECORD: "no-record",
});

/**
 * ⭐⭐ IS THIS MONITOR ACTUALLY RUNNING? Answerable from ONE read of `latest`.
 *
 * ⛔ THE TWO FAILURES IT SEPARATES, which look the same from `outcome` alone:
 *   FROZEN_SKIPPING — invocations are arriving and being deduped. `outcome` still says healthy,
 *                     `producedAt` is stale, `lastInvokedAt` is fresh. This is what a MIN_RERUN_MS
 *                     set above the cron period produces, and it is the state this whole record
 *                     shape exists to make visible.
 *   NOT_INVOKED     — nothing is arriving at all: the schedule was dropped, or the deploy lost it.
 * Collapsing them would send someone to the wrong file.
 *
 * @param {{record:object|null, now:number, cronMs?:number}} args
 */
export function judgeCadence({ record, now, cronMs = CRON_MS }) {
  if (!isObj(record)) return { cadence: CADENCE.NO_RECORD, detail: "the store holds no record — this monitor has never completed a run" };
  // Two missed cron periods is the tolerance, matching the TTL's reasoning.
  const limit = cronMs * 2;
  const produced = Date.parse(record.producedAt);
  const invoked = Date.parse(record.lastInvokedAt ?? record.producedAt);
  const producedAge = Number.isFinite(produced) ? now - produced : Infinity;
  const invokedAge = Number.isFinite(invoked) ? now - invoked : Infinity;

  const intervals = intervalsOf(record.recentProducedAt);
  if (producedAge <= limit) {
    // ═══ ⭐⭐ RATE DEGRADATION — THE FAILURE THIS ACTUALLY HAS ═══════════════════════════════
    // ⛔ THE PREMISE THIS REPLACES WAS WRONG, and writing the guard is what exposed it. The concern
    // was that MIN_RERUN_MS above the cron period would FREEZE the monitor: every run after the
    // first dedupes, `producedAt` never moves, the store keeps a healthy record forever. That is
    // NOT what happens. A skip does not touch `producedAt`, so its age keeps growing and the next
    // tick is past the window and probes. The real effect is HALF-RATE probing — the monitor stays
    // alive and lies about its resolution instead of dying visibly.
    //
    // ⭐ Which is worse in one respect: a frozen monitor eventually trips the TTL and reads stale.
    // A half-rate one never does. It simply watches less often than anybody believes, and every
    // single field looks correct. Only the INTERVALS show it.
    const median = intervals.length ? [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)] : null;
    if (median !== null && intervals.length >= 2 && median > cronMs * 1.5) {
      return { cadence: CADENCE.DEGRADED, producedAge, invokedAge, intervals, median,
               detail: `⚠️ PROBING AT THE WRONG RATE — observed interval ~${Math.round(median / 60000)}m against a ${Math.round(cronMs / 60000)}m cron, with ${record.skipCount ?? 0} skip(s). The monitor is alive and watching LESS OFTEN than its schedule implies. Check MIN_RERUN_MS against the cron period.` };
    }
    return { cadence: CADENCE.RUNNING, producedAge, invokedAge, intervals,
             detail: `last probe ${Math.round(producedAge / 60000)}m ago; ${record.runCount ?? "?"} completed run(s)` };
  }
  if (invokedAge <= limit) {
    return { cadence: CADENCE.FROZEN_SKIPPING, producedAge, invokedAge,
             detail: `🚨 INVOKED BUT NOT PROBING — last invocation ${Math.round(invokedAge / 60000)}m ago but the last completed probe was ${Math.round(producedAge / 60000)}m ago, with ${record.skipCount ?? 0} skip(s). The record still says "${record.outcome}" and that verdict is STALE. Check MIN_RERUN_MS against the cron period.` };
  }
  return { cadence: CADENCE.NOT_INVOKED, producedAge, invokedAge,
           detail: `nothing has invoked this monitor for ${Math.round(invokedAge / 60000)}m — check the schedule is still registered on the deploy` };
}

/** Gaps between consecutive remembered probes, newest first, in ms. Lets a reader SEE the cadence
 *  rather than trust a claim about it. */
export function intervalsOf(list) {
  if (!Array.isArray(list)) return [];
  const t = list.map((x) => Date.parse(x)).filter(Number.isFinite);
  return t.slice(0, -1).map((v, i) => v - t[i + 1]);
}
