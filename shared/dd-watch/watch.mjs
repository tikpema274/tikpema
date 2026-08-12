// dd-watch/watch.mjs — is the PUBLIC DD SERVICE answering, on BOTH of its paths?
//
// Pure. No I/O, no clock of its own, no network. The handler owns transport; this owns judgement,
// so every branch is testable by injection — the same split as shared/strong-read-watch/watch.mjs.
//
// ═══ ⭐ WHY THE PROBE IS FREE, AND WHY THAT MAKES THIS WORTH RUNNING ═════════════════════════════
// dd-analyze's rungs are: exposure (−1) → retrieve (−0.5) → HEALTH (0) → … → payment (6). So an
// unauthenticated POST with no payment header can only ever reach the 402 challenge — it never
// settles, never charges, and needs no session. A 402 therefore MEANS "past the health rung", and a
// 503 service-unverified MEANS "refusing". The whole availability question is answerable for $0.00,
// which is why this can run every few minutes forever.
//
// ═══ 🚨 THE HARD PART: NOT FIRING ON ROUTINE WORK ════════════════════════════════════════════════
// The health key is a content hash of the DD surface, so a DD-code deploy legitimately rotates it,
// and `no-record` is CORRECT until the next canary tick (≤ the */10 period). A monitor that paged on
// that would fire on every DD deploy — and **an alert that fires predictably on routine work is one
// nobody reads.** That is not hypothetical here: this repo already recorded it for the ack gate
// ("a gate that fires spuriously TRAINS CLICK-THROUGH AND DESTROYS ITS OWN VALUE").
//
// ⭐ THE DISCRIMINATOR IS REASON + DURATION, NOT THE REFUSAL ITSELF:
//   · no-record, first seen, and recent           → EXPECTED (a key rotation). Record, do not alert.
//   · no-record persisting beyond GRACE_MS        → REAL. The canary is not writing at all.
//   · version-mismatch / unreadable / malformed
//     / not-passing / build-unresolved            → REAL IMMEDIATELY. None of these is a normal
//                                                   consequence of deploying; they mean the two
//                                                   sides disagree, the store is broken, or the
//                                                   detector failed its own fixtures.
//   · the two PATHS disagreeing                   → REAL IMMEDIATELY (see below).
//
// ⚠️ GRACE IS BOUNDED BY THE CANARY'S PERIOD, NOT CHOSEN FREELY. Two canary periods tolerates one
// missed tick and refuses to tolerate two — the same "TTL ≈ 2× period" reasoning the canary itself
// uses. Anything longer and a genuinely dead canary hides inside the grace window.
//
// ═══ ⭐ WHY BOTH PATHS ══════════════════════════════════════════════════════════════════════════
// `/api/dd-analyze` and `/.netlify/functions/dd-analyze` resolve independently — the first depends
// on a netlify.toml redirect, and a draft has been observed serving SPA HTML on it while the
// functions path answered normally. That divergence was measured ONCE, on one deploy, and is
// otherwise INFERRED. Polling both turns a one-time check into a standing invariant, which is the
// cheapest way to keep it true rather than assumed — and `resource` binds a payment to the exact URL
// hit, so a path that starts serving SPA HTML silently breaks the canonical payment identity.

export const SCHEMA = "dd-watch/1";

/** The canary's period. The grace window is derived from it, never set independently. */
export const CANARY_PERIOD_MS = 10 * 60 * 1000;

/** ⭐ Tolerate ONE missed canary tick after a key rotation; refuse to tolerate two. */
export const GRACE_MS = 2 * CANARY_PERIOD_MS;

/** Anti-amplification and staleness, mirroring strong-read-watch's ordering:
 *  MIN_RERUN_MS < cron period < TTL_MS. Numbers deliberately DIFFER from both other monitors so
 *  nobody assumes one covers another. */
export const MIN_RERUN_MS = 3 * 60 * 1000;
export const EXPECTED_CRON = "*/5 * * * *";
export const CRON_MS = Number(EXPECTED_CRON.match(/^\*\/(\d+) \* \* \* \*$/)[1]) * 60 * 1000;
export const TTL_MS = 20 * 60 * 1000;
/** A sustained problem re-pings at most this often, so an outage does not become a firehose. */
export const REMINDER_MS = 60 * 60 * 1000;

export const FUNCTION_NAME = "dd-watch";
export const DEFAULT_STORE_NAME = "dd-watch";
export const WEBHOOK_VAR = "DD_WATCH_WEBHOOK";

/** The two paths, and the canonical one a listing names. */
export const DEFAULT_PATHS = Object.freeze({
  api: "https://app.tikpema.xyz/api/dd-analyze",
  functions: "https://app.tikpema.xyz/.netlify/functions/dd-analyze",
});
export const CANONICAL_PATH_KEY = "api";

/**
 * ⭐ THE PROBE SUBJECT — chosen deliberately, not whichever address was handy.
 *
 * THE ZERO ADDRESS. Verified 2026-08-11: dd-analyze accepts it and issues a 402, and
 * `eth_getCode` returns `0x`.
 *
 *  · IT CAN NEVER CHANGE STATE. Nobody holds the key, so it can never gain bytecode. The expected
 *    answer is permanently fixed, which means ANY change in the preview is a real signal rather
 *    than subject drift. A probe whose subject can mutate quietly stops testing what you think.
 *  · IT BELONGS TO NOBODY. Hitting a third party's contract ~576×/day is rude and reads as
 *    surveillance in their logs. This is the canonical "nothing here" sentinel.
 *  · IT EXERCISES THE THIN PATH (`hasCode:false`) — the branch that produced the 1-of-12 report —
 *    so the cheapest analysis case stays continuously covered.
 *
 * ⚠️ REJECTED: the delegate/payer wallet, which an early draft used. That is the wallet that BUYS;
 * probing it conflates the payer with the thing being watched, in the logs and in the reasoning.
 *
 * ⭐ COST IS ONE `eth_getCode` PER REQUEST. The monitor stops at the 402, so the ANALYZER never
 * runs — subjectPreview's single bytecode read is the entire per-probe cost.
 */
export const PROBE_SUBJECT = "0x0000000000000000000000000000000000000000";

/**
 * ⭐ THE PROBE MUST BE DISTINGUISHABLE FROM A REAL CALLER.
 * With no other monitoring, a dd-analyze invocation in the logs is one of the only signals a
 * STRANGER touched DD (the other being a revenue-wallet change). ~576 self-generated invocations a
 * day would bury that signal on day one. These keep monitor traffic filterable OUT and real traffic
 * filterable IN.
 * ⚠️ A marked probe can never be mistaken for a PURCHASE — a 402 ends the exchange — only for
 * INTEREST. Telling "someone looked" from "someone bought" still requires the chain read.
 */
export const PROBE_UA = "tikpema-dd-watch/1";
export const PROBE_MARKER = "dd-watch";

/** Closed outcome set. An unrecognised state is a programming error, never a new "healthy" case. */
export const OUTCOME = Object.freeze({
  SERVING: "serving",                 // 402 with a well-formed challenge
  REFUSING: "refusing",               // 503 with a health reason
  NOT_JSON: "not-json",               // SPA HTML — the routing failed, not the service
  UNREACHABLE: "unreachable",
  UNEXPECTED: "unexpected",           // any status/body we do not have a rule for
});

/**
 * Refusal reasons that are NEVER a normal consequence of deploying.
 * ⚠️ THIS NO LONGER GATES ANYTHING — it is documentation and severity only. It USED to be the
 * allow-list of alert-worthy reasons, and that is exactly how `stale` fell through to silence.
 * The gate is now the inverse: everything alerts except no-record inside the grace window.
 */
export const ALWAYS_REAL_REASONS = Object.freeze([
  "version-mismatch", "unreadable", "malformed", "not-passing", "build-unresolved",
]);

/**
 * Judge ONE path's response. Never throws; an unrecognised shape is UNEXPECTED, not healthy.
 * @param {{status:number, body:any, error?:string}} res
 */
export function judgePath(res) {
  if (!res || typeof res !== "object") return { outcome: OUTCOME.UNEXPECTED, detail: "no response object" };
  if (res.error) return { outcome: OUTCOME.UNREACHABLE, detail: String(res.error) };

  const b = res.body;
  // ⚠️ HTML means NOTHING MATCHED THIS PATH — a routing answer, not a statement about the service.
  // Judged before status, because this site's catch-all has returned BOTH 200 and 404 with SPA HTML.
  if (typeof b === "string") {
    return /<!doctype html|<html/i.test(b)
      ? { outcome: OUTCOME.NOT_JSON, detail: "SPA HTML — nothing matched this path (routing, not the service)" }
      : { outcome: OUTCOME.UNEXPECTED, detail: `non-JSON body (${b.slice(0, 60)})` };
  }
  if (!b || typeof b !== "object") return { outcome: OUTCOME.UNEXPECTED, detail: `body is ${typeof b}` };

  if (res.status === 402) {
    const acc = Array.isArray(b.accepts) ? b.accepts[0] : null;
    if (!acc) return { outcome: OUTCOME.UNEXPECTED, detail: "402 without an accepts[] entry" };
    return {
      outcome: OUTCOME.SERVING,
      detail: "402 challenge issued — past the health rung",
      resource: typeof acc.resource === "string" ? acc.resource : null,
      payTo: typeof acc.payTo === "string" ? acc.payTo.toLowerCase() : null,
      amount: acc.maxAmountRequired ?? null,
    };
  }
  if (res.status === 503) {
    const r = b.refusal ?? {};
    const reason = typeof r.reason === "string" ? r.reason : "unknown";
    const healthReason = typeof r.diagnostic?.healthReason === "string" ? r.diagnostic.healthReason : null;
    return {
      outcome: OUTCOME.REFUSING,
      detail: `503 ${reason}${healthReason ? ` (${healthReason})` : ""}`,
      reason, healthReason,
    };
  }
  return { outcome: OUTCOME.UNEXPECTED, detail: `unexpected status ${res.status}` };
}

/**
 * ⭐⭐ THE JUDGEMENT. Combines both paths and decides whether this is ALERT-WORTHY.
 *
 * `refusingSince` is threaded from the PREVIOUS record — duration is what separates an expected
 * post-deploy window from a canary that has stopped writing, and a single observation cannot supply
 * it. This is the same predicted/measured discipline used elsewhere: the first sighting is not the
 * finding, the persistence is.
 */
export function judge({ paths, prev = null, now, graceMs = GRACE_MS }) {
  const keys = Object.keys(paths);
  const results = Object.fromEntries(keys.map((k) => [k, judgePath(paths[k])]));
  const serving = keys.filter((k) => results[k].outcome === OUTCOME.SERVING);
  const allServing = serving.length === keys.length;

  // ── path divergence: one serves, another does not, or the resources disagree ──────────────────
  const divergent = !allServing && serving.length > 0;
  const resources = serving.map((k) => results[k].resource).filter(Boolean);
  const payTos = new Set(serving.map((k) => results[k].payTo).filter(Boolean));
  const amounts = new Set(serving.map((k) => String(results[k].amount ?? "")).filter(Boolean));

  // ⚠️ resources are EXPECTED to differ (each binds to the URL hit). payTo and price are NOT.
  const quoteDivergence = payTos.size > 1 || amounts.size > 1;

  // ── refusal duration ─────────────────────────────────────────────────────────────────────────
  const refusing = keys.filter((k) => results[k].outcome === OUTCOME.REFUSING);
  const reasons = [...new Set(refusing.map((k) => results[k].healthReason ?? results[k].reason))];
  // ═══ 🚨 CLOSED SET, INVERTED — enumerate what is NOT alert-worthy ═════════════════════════════
  // MEASURED 2026-08-12: `reasons: ['stale']` produced alert:false. `stale` was not in
  // ALWAYS_REAL_REASONS and was not `no-record`, so it fell through EVERY branch into silence — and
  // `stale` is the canary having stopped writing, i.e. exactly what the canary exists to signal. DD
  // refused continuously for 25 minutes and this monitor never alerted for the right reason.
  //
  // ⭐ THE DEFECT WAS THE DIRECTION OF THE ENUMERATION. I listed the reasons that DO alert and let
  // everything else fall through to quiet. Any reason added to the health ladder later — or any typo
  // — would be silently unmonitored. The closed-set discipline was applied to OUTCOME and not to
  // reasons, inside the monitor built to stop absences reading as safety.
  //
  // So the rule is now: A REFUSAL ALERTS UNLESS IT IS SPECIFICALLY THE EXPECTED POST-DEPLOY WINDOW.
  // An unrecognised reason alerts, which is the safe direction and cannot rot.
  const onlyNoRecord = reasons.length > 0 && reasons.every((r) => r === "no-record");

  const stillRefusing = refusing.length > 0;
  const refusingSince = stillRefusing ? (prev?.refusingSince ?? new Date(now).toISOString()) : null;
  const refusingMs = refusingSince ? now - Date.parse(refusingSince) : 0;
  const persisted = Number.isFinite(refusingMs) && refusingMs > graceMs;

  // ── ok / alert ───────────────────────────────────────────────────────────────────────────────
  const ok = allServing && !quoteDivergence;

  // ⭐ ALERT IS NOT !ok. A first-seen no-record is a REFUSAL but NOT an alert — it is the expected
  //   consequence of a key rotation. Alerting on it would page on every DD deploy.
  let alert = false;
  let alertReason = null;
  if (quoteDivergence) { alert = true; alertReason = "quote-divergence"; }
  else if (divergent) { alert = true; alertReason = "path-divergence"; }
  else if (keys.some((k) => [OUTCOME.NOT_JSON, OUTCOME.UNREACHABLE, OUTCOME.UNEXPECTED].includes(results[k].outcome))) {
    alert = true; alertReason = results[keys.find((k) => results[k].outcome !== OUTCOME.SERVING)].outcome;
  } else if (stillRefusing && !(onlyNoRecord && !persisted)) {
    // Any refusal EXCEPT no-record inside the grace window. Unknown reasons land here by design.
    alert = true;
    alertReason = onlyNoRecord ? "no-record-persisting" : `refusing:${reasons.join(",")}`;
  }

  return {
    ok, alert, alertReason,
    outcomes: Object.fromEntries(keys.map((k) => [k, results[k].outcome])),
    results,
    reasons,
    expectedWindow: onlyNoRecord && !persisted,
    refusingSince,
    refusingMs: stillRefusing ? refusingMs : 0,
    resources,
    detail: ok
      ? `both paths serving (${keys.join(", ")})`
      : alert
        ? `ALERT ${alertReason}${refusingSince ? ` for ${Math.round(refusingMs / 60000)}m` : ""}`
        : `refusing ${reasons.join(",")} for ${Math.round(refusingMs / 60000)}m — within the expected post-deploy window`,
  };
}

/**
 * ⭐ THE REFUSAL WINDOW, MEASURED FOR FREE. Two production deploys failed to observe it by hand;
 * this records every start and end so its real size stops being a guess.
 */
export function windowFrom({ prev, judgement, nowIso, induced = false }) {
  const wasRefusing = !!prev?.refusingSince;
  const isRefusing = !!judgement.refusingSince;
  // ⚠️ `induced` is CARRIED FORWARD from the opening observation: a window that OPENED under a
  // calibration lever stays labelled induced even if the lever is removed while it is still open.
  const carried = induced || prev?.window?.induced === true;
  if (!wasRefusing && isRefusing) return { event: "window-opened", openedAt: nowIso, closedAt: null, ms: null, induced };
  if (wasRefusing && !isRefusing) {
    const ms = Date.parse(nowIso) - Date.parse(prev.refusingSince);
    return { event: "window-closed", openedAt: prev.refusingSince, closedAt: nowIso, ms: Number.isFinite(ms) ? ms : null, induced: carried };
  }
  return { event: isRefusing ? "window-open" : "steady", openedAt: judgement.refusingSince, closedAt: null, ms: judgement.refusingMs || null, induced: carried };
}

/**
 * ⭐⭐ IS A CALIBRATION LEVER ACTIVE? — the automatic INDUCED/REAL discriminator.
 *
 * 🚨 WHY THIS EXISTS. windowHistory is the record of how long DD refused, and its whole value is
 * answering "how big is the post-deploy refusal window really?" — a number three production deploys
 * have failed to capture by hand. But a CALIBRATION also opens a window, and an induced entry looks
 * identical to a real one. Someone reading the history in a month would average them and conclude
 * the window is ~N minutes, when the largest entries are ones we caused ON PURPOSE.
 *
 * ⭐ The monitor already knows: if either target differs from its default, a lever is set. So the
 * label is DERIVED, never remembered — no operator has to tag anything, and forgetting is impossible.
 *
 * ⚠️ THE ONE IT STILL CANNOT SEE: an outage caused by something other than a lever (a bad deploy,
 * say) is REAL by this test, which is correct — but it is still not the CANARY-KEY-ROTATION window
 * that motivated the measurement. `induced:false` means "not caused by a lever", not "caused by a
 * key rotation". Read the reasons alongside it: only `no-record` is the rotation case.
 */
export const leverActive = (targets) =>
  targets?.api !== DEFAULT_PATHS.api || targets?.functions !== DEFAULT_PATHS.functions;

/**
 * ⭐⭐ TWO REASONS TO ALERT, AND THEY ARE NOT THE SAME EVENT — so they do not share a headline.
 *
 * · REFUSING — the service is unavailable. Fail-closed: no 402, so nothing can be paid. Costs
 *   availability. Ordinary severity.
 * · PATH DIVERGENCE — `/api/dd-analyze` and `/.netlify/functions/dd-analyze` are behaving
 *   DIFFERENTLY in production. That is a more serious and stranger event: it means the two entry
 *   points derive different identities on the same deploy, which is currently INFERRED from a single
 *   measurement and never continuously observed. And `resource` binds a payment to the exact URL
 *   hit, so a path that starts serving SPA HTML silently breaks the canonical payment identity a
 *   listing would name.
 *
 * ⚠️ Collapsing these into one "DD is unhealthy" line would bury the rarer, worse one under the
 * common one — the same mistake as a coverage manifest averaged into a score.
 */
export function alertHeadline(judgement) {
  const r = judgement.alertReason ?? "";
  if (r === "de-escalated") {
    return {
      severity: "warning",
      headline: "⚠️ DD NO LONGER ALERT-WORTHY — but it is STILL NOT SERVING",
      why:
        "The alert condition cleared while the service is still refusing, so this is NOT a recovery. " +
        "It usually means a DD-code deploy rotated the health key and the refusal is now the expected " +
        "post-deploy window. Keep watching: a real all-clear says both paths are serving.",
    };
  }
  if (r === "quote-divergence") {
    return {
      severity: "critical",
      headline: "🚨 DD QUOTE DIVERGENCE — the two paths quote DIFFERENT payment terms",
      why:
        "payTo or price differs between /api/dd-analyze and /.netlify/functions/dd-analyze. A buyer's " +
        "payment binds to whichever they hit. This is a split-brain in the money path, not an " +
        "availability problem — treat it as such.",
    };
  }
  if (r === "path-divergence" || r === OUTCOME.NOT_JSON) {
    return {
      severity: "critical",
      headline: "🚨 DD PATH DIVERGENCE — the two entry points are behaving differently",
      why:
        "One path serves and the other does not (SPA HTML means the ROUTE missed, not that the " +
        "service is down). The canonical resource a listing names is /api/dd-analyze; if that is the " +
        "failing side, anything pointing at it is broken while the service itself looks fine.",
    };
  }
  if (r === "no-record-persisting") {
    return {
      severity: "warning",
      headline: "⚠️ DD REFUSING — no health artifact, well past the expected window",
      why:
        "no-record is EXPECTED for up to two canary periods after a DD-code deploy. Persisting " +
        "beyond that means the canary is not writing at all — check that dd-canary's schedule is " +
        "present and that the build stamp carries a ddTree.",
    };
  }
  if (typeof r === "string" && r.startsWith("refusing:")) {
    return {
      severity: "warning",
      headline: `⚠️ DD REFUSING — ${r.slice("refusing:".length)}`,
      why:
        "This reason is never a normal consequence of deploying: it means the two sides disagree on " +
        "identity, the store is unreadable, or the detector failed its own fixtures.",
    };
  }
  return {
    severity: "warning",
    headline: `⚠️ DD UNAVAILABLE — ${r || "unknown"}`,
    why: "The probe could not reach a recognisable answer on at least one path.",
  };
}

/** Transition-only notification with a rate-limited reminder. Silence is the healthy signal. */
export function decideNotify({ prevAlert, alert, ok = true, lastNotifiedAt, now, reminderMs = REMINDER_MS }) {
  if (alert && !prevAlert) return { notify: true, kind: "first-alert" };

  // ═══ 🚨 "RECOVERED" IS A CLAIM ABOUT `ok`, NOT ABOUT `alert` ══════════════════════════════════
  // MEASURED 2026-08-12: this branch fired on `alert` going false and sent "✅ DD RECOVERED — both
  // paths serving again" WHILE BOTH PATHS WERE REFUSING. Nothing had recovered; the reason had
  // merely changed from `not-json` to `stale`, which the old alert gate did not recognise.
  //
  // ⭐ A FALSE ALL-CLEAR IS WORSE THAN A MISSED ALERT: a missed alert leaves you looking, an
  // all-clear tells you to stop. So the stand-down requires the thing it claims — `ok` — and a
  // de-escalation that is still unhealthy says so in its own words instead of borrowing the
  // recovery headline.
  if (!alert && prevAlert) {
    return ok
      ? { notify: true, kind: "recovered" }
      : { notify: true, kind: "de-escalated" };
  }
  if (alert && prevAlert) {
    // ⭐⭐ THE NEVER-DELIVERED BRANCH, EXPLICIT — and it is the MIRROR of the persist-before-broadcast
    // bug. Because `lastNotifiedAt` advances ONLY on confirmed delivery, a successful state write
    // followed by a FAILED send leaves prevAlert=true with nothing ever delivered. Suppressing that
    // as a "reminder" would silence an alert nobody has ever seen, using a window it never earned.
    //
    // ⚠️ THIS WAS PREVIOUSLY CORRECT ONLY BY FALL-THROUGH: `since` became Infinity and
    // `Number.isFinite(Infinity)` happened to be false. A refactor tightening that predicate would
    // have inverted it silently, and the reported kind said "reminder" when nobody had been
    // reminded of anything. Its sibling (strong-read-watch) states the case outright; so does this.
    const at = Date.parse(lastNotifiedAt);
    const told = Number.isFinite(at);
    if (!told) return { notify: true, kind: "never-delivered" };
    return now - at < reminderMs
      ? { notify: false, kind: "suppressed-reminder" }
      : { notify: true, kind: "reminder" };
  }
  return { notify: false, kind: "steady-ok" };
}
