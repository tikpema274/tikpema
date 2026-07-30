// watch.mjs — pure logic for the strong-read monitor. No I/O, no Blobs, no fetch.
//
// ═══ WHAT IS BEING MONITORED, AND WHY IT CANNOT BE MONITORED IN-PROCESS ══════════════════════
// The kill switch, the spend ceiling and the DD health verdict all read Blobs with
// consistency:"strong". That works only because _blobs.mjs re-injects `url_uncached`, the field
// connectLambda drops. The library resolves its context from globalThis.netlifyBlobsContext BEFORE
// process.env, and from Netlify.env / Deno.env before process.env — none of which we control. So a
// PLATFORM change, with no commit of ours, can silently un-repair it.
//
// ⭐ THE MONITOR MUST ASK OVER HTTP, NOT IN-PROCESS. A scheduled invocation receives a different
// event shape than an HTTP one, so running the probe's logic inside the scheduled function would
// measure the SCHEDULED runtime — not the runtime `_pause.mjs` actually executes in. It could go
// green while the kill switch is bricked, or red while it is fine. A binding can only be tested
// across the thing it binds, so the monitor makes a real request to the real deployed URL.
//
// ═══ WHY DETECTION CANNOT LIVE ON THE READ SIDE ══════════════════════════════════════════════
// The monitor's own bookkeeping deliberately uses DEFAULT consistency (see the handler). That is
// correct — strong bookkeeping would make the monitor die in exactly the outage it exists to
// report — but it means a reader can be served a cached record. Appending immutable failure keys
// narrows that, and does not close it: an eventual LIST can also miss the newest key, so the
// ABSENCE of failure keys is not proof of no failure. Same defect class, one layer up.
//
// That is not a gap to engineer around. It is the structural reason the monitor PUSHES: the record
// is the audit trail, the webhook is the detection. Neither is optional.

/** Overlap guard: a run inside this window reuses the existing record instead of probing again.
 *
 * ⚠️ CORRECTED 2026-07-30. This was justified as anti-amplification, on the belief that "every
 * deployed function is publicly reachable at /.netlify/functions/<name>". THAT IS FALSE FOR
 * SCHEDULED FUNCTIONS. Measured on a real draft: an unscheduled function answers 200, while BOTH
 * scheduled functions (this one and dd-canary) return 403 with an empty body, and an absent path
 * returns SPA HTML 200. Netlify refuses HTTP invocation of anything carrying a schedule, so there
 * is no public caller to amplify.
 *
 * The window is still right, for a smaller and more accurate reason: a scheduled invocation can be
 * retried or double-fired by the platform, and two overlapping runs would double-write the record
 * and double-notify. Keeping the reason honest matters — the wrong reason would have justified
 * removing the window the moment someone noticed the endpoint was unreachable. */
export const MIN_RERUN_MS = 7 * 60 * 1000;

/** How long a record vouches for the money path. 3x the cron period: two consecutive missed runs
 *  are tolerated, three are not. */
export const TTL_MS = 45 * 60 * 1000;

/** While still failing, re-notify at most this often. Transition-only alerting goes SILENT during a
 *  long outage; every-run alerting pages every 15 minutes forever. This is the middle. */
export const REMINDER_MS = 60 * 60 * 1000;

/** ⚠️ LOAD-BEARING ORDERING: MIN_RERUN_MS < cron period < TTL_MS.
 *  Deliberately NOT the canary's 5/10/30 — these are different monitors guarding different things,
 *  and matching numbers invite the assumption that one covers the other. Asserted against the real
 *  netlify.toml entry for [functions."strong-read-watch"]. */

/** The schedule this monitor is DESIGNED for, declared in code so there is ONE expectation and
 *  netlify.toml can be checked against it rather than being its own unreviewable source of truth.
 *  The suite asserts the real file agrees; the promotion gate refuses if it does not. */
export const EXPECTED_CRON = "*/15 * * * *";

/** Milliseconds implied by EXPECTED_CRON, for the ordering invariant. */
export const CRON_MS = Number(EXPECTED_CRON.match(/^\*\/(\d+) \* \* \* \*$/)[1]) * 60 * 1000;

/** The function name netlify.toml must register on that schedule. */
export const FUNCTION_NAME = "strong-read-watch";

export const SCHEMA = "strong-read-watch/1";

/** The shape the probe must self-identify as. A body that does not say this is not the probe, no
 *  matter what else it contains. */
export const EXPECTED_PROBE = "blobs-strong-read/1";

/** CLOSED SET. "Could not tell" is a FAILURE, never an unknown and never a pass. */
export const REASON = Object.freeze({
  OK: "ok",
  HTTP_ERROR: "http-error",
  NOT_JSON: "not-json",
  WRONG_SHAPE: "wrong-shape",
  UNCALIBRATED: "uncalibrated",
  HOTFIX: "hotfix",
  UNREACHABLE: "unreachable",
  TIMEOUT: "timeout",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Judge one probe response. PASS requires verdict "D" AND calibrated true — nothing else passes.
 *
 * @param {{status:number|null, contentType:string|null, body:string|null, networkError:string|null,
 *          timedOut:boolean}} res
 */
export function judgeProbe(res) {
  const fail = (reason, detail) => ({ ok: false, reason, detail, probe: null, build: null });

  if (res?.timedOut) return fail(REASON.TIMEOUT, "the probe did not answer before the deadline");
  if (res?.networkError) {
    // The message is ours (a class name / short string), never remote content.
    return fail(REASON.UNREACHABLE, `the probe could not be reached (${res.networkError})`);
  }
  if (res?.status !== 200) return fail(REASON.HTTP_ERROR, `the probe answered HTTP ${res?.status}`);

  // ⭐ THE SPA TRAP. An unmatched Netlify path returns index.html with status 200, so a 200 proves
  // nothing on its own. The body must actually parse, and must then say it is the probe.
  let body;
  try {
    body = JSON.parse(String(res.body ?? ""));
  } catch {
    const ct = res.contentType || "none";
    return fail(REASON.NOT_JSON, `the response was not JSON (content-type ${ct}) — most likely the SPA fallback, which means the function is not deployed`);
  }
  if (!isObj(body)) return fail(REASON.NOT_JSON, "the response parsed but is not an object");
  if (body.probe !== EXPECTED_PROBE) {
    return fail(REASON.WRONG_SHAPE, `expected a ${EXPECTED_PROBE} response, got ${JSON.stringify(body.probe ?? null)}`);
  }

  const probe = {
    verdict: body.verdict ?? null,
    calibrated: body.calibrated ?? null,
    strongReads: body.strongReads ?? null,
    reason: body.reason ?? null,
    arms: {
      A: body.arms?.A_connectLambda_only?.outcome ?? null,
      B: body.arms?.B_connectBlobs?.outcome ?? null,
      A2: body.arms?.A2_connectLambda_after_B?.outcome ?? null,
    },
    selfChecks: Array.isArray(body.selfChecks) ? body.selfChecks.map((s) => s?.id).filter(Boolean) : [],
  };
  const build = isObj(body.build)
    ? { commit: body.build.commit ?? null, tree: body.build.tree ?? null, dirty: body.build.dirty ?? null }
    : null;

  // UNCALIBRATED is a failure, not an unknown. A monitor that records "couldn't tell" as fine is
  // the same fail-open this whole line of work exists to close.
  if (probe.calibrated !== true) {
    return { ok: false, reason: REASON.UNCALIBRATED, probe, build,
      detail: `the probe could not discriminate (${probe.reason ?? "no reason given"}) — its negative control did not fire, so it measured nothing` };
  }
  if (probe.verdict !== "D") {
    return { ok: false, reason: REASON.HOTFIX, probe, build,
      detail: `the deployed build cannot do a strong read (verdict ${JSON.stringify(probe.verdict)}) — the kill switch, the spend ceiling and the DD health verdict are all reading a cache` };
  }
  return { ok: true, reason: REASON.OK, probe, build, detail: "strong reads work on the deployed build" };
}

/**
 * Should this invocation reuse the existing record instead of running?
 * Independent of the verdict on purpose: deduping on "was it healthy" would re-run continuously
 * while broken, which is exactly when amplification hurts most.
 */
export function shouldSkipRerun({ record, now, minRerunMs = MIN_RERUN_MS }) {
  if (!isObj(record)) return { skip: false, reason: "no-record" };
  const at = Date.parse(record.producedAt);
  if (!Number.isFinite(at)) return { skip: false, reason: "malformed" };
  const ageMs = now - at;
  if (ageMs < 0) return { skip: false, reason: "future-dated" };
  if (ageMs > minRerunMs) return { skip: false, reason: "older-than-window" };
  return { skip: true, reason: "recent-run", ageMs };
}

/**
 * Is an existing record still worth anything to a reader? Absence, staleness and malformation are
 * all REFUSALS — never "fine". Judged from producedAt, never from mere presence, because an
 * eventual read can serve an older record and presence alone would read as freshness.
 */
export function evaluateRecord({ record, now, ttlMs = TTL_MS }) {
  if (!isObj(record)) return { serve: false, reason: "no-record" };
  const at = Date.parse(record.producedAt);
  if (!Number.isFinite(at) || typeof record.ok !== "boolean") return { serve: false, reason: "malformed" };
  const ageMs = now - at;
  if (ageMs < 0) return { serve: false, reason: "future-dated" };
  if (ageMs > ttlMs) return { serve: false, reason: "stale", ageMs };
  return { serve: record.ok === true, reason: record.ok === true ? "ok" : "failing", ageMs };
}

/**
 * Decide whether to push, and why.
 *
 * TRANSITIONS plus a low-rate reminder. `prevOk === null` means no usable prior record: a first
 * observation that is HEALTHY stays silent (nobody wants a page saying hello), a first observation
 * that is FAILING notifies, because from the reader's side that is indistinguishable from a
 * regression and silence would be the wrong default.
 */
export function decideNotify({ prevOk, ok, lastNotifiedAt, now, reminderMs = REMINDER_MS }) {
  const since = Number.isFinite(Date.parse(lastNotifiedAt)) ? Date.parse(lastNotifiedAt) : null;

  if (ok && prevOk === false) return { notify: true, kind: "recovered" };
  if (ok) return { notify: false, kind: prevOk === true ? "steady-ok" : "first-ok" };

  if (prevOk === true) return { notify: true, kind: "regressed" };
  if (prevOk === null) return { notify: true, kind: "first-failure" };

  // Still failing. Remind at most every reminderMs. A never-notified failure streak must notify
  // NOW rather than wait out the window — `since === null` means nobody has been told at all.
  if (since === null || now - since >= reminderMs) return { notify: true, kind: "still-failing" };
  return { notify: false, kind: "still-failing-quiet" };
}

/**
 * ═══ 🚨 A FAILURE TO OBSERVE IS NOT AN OBSERVED FAILURE ══════════════════════════════════════
 * The first real alert this monitor ever sent was WRONG in the way that matters. The probe target
 * did not exist, so the monitor never reached it — and the message asserted that "the kill switch,
 * the spend ceiling and the DD health verdict are reading a CDN cache". They were not. Strong reads
 * were fine on 6a6a49ae. The alert inferred a broken state it had never observed, and the
 * consequence paragraph was an instruction to roll back a HEALTHY deploy, read at 3am.
 *
 * The headline was merely alarming; the consequence claim was the dangerous part. So BOTH are now
 * derived from what the probe actually said:
 *
 *   CANNOT VERIFY — the probe never answered (unreachable / timeout / http-error / not-json /
 *                   wrong-shape). We know NOTHING about strong reads. No consequence claim, no
 *                   rollback id. The action is "check the site is up", because the likeliest cause
 *                   is the monitor's own reach, not the money path.
 *   KNOWN BROKEN  — the probe answered and said so (hotfix / uncalibrated). NOW the consequence
 *                   paragraph is true and the rollback id belongs.
 *
 * ⚠️ AN UNRECOGNISED REASON MAPS TO CANNOT-VERIFY, never to known-broken. Claiming a breakage you
 * did not see is the costlier error: it spends a rollback on a healthy deploy.
 */
export const CANNOT_VERIFY_REASONS = Object.freeze([
  REASON.UNREACHABLE, REASON.TIMEOUT, REASON.HTTP_ERROR, REASON.NOT_JSON, REASON.WRONG_SHAPE,
]);
export const KNOWN_BROKEN_REASONS = Object.freeze([REASON.HOTFIX, REASON.UNCALIBRATED]);

/** @returns {"ok"|"known-broken"|"cannot-verify"} */
export function verdictClass(reason) {
  if (reason === REASON.OK) return "ok";
  if (KNOWN_BROKEN_REASONS.includes(reason)) return "known-broken";
  return "cannot-verify";
}

/** ⚠️ Discord auto-unfurls bare links, which put a marketing card under a siren. Angle brackets
 *  suppress the embed and keep the link clickable. */
const noEmbed = (url) => `<${url}>`;

/** The message body. Plain text, no remote content echoed back — everything here is either our own
 *  closed-set code or a value the probe self-reported from OUR deploy. */
export function notifyMessage({ kind, judgement, record, target }) {
  const cls = judgement.ok ? "ok" : verdictClass(judgement.reason);

  const head =
    cls === "ok"
      ? "✅ **RECOVERED** — strong reads work on prod again"
      : cls === "known-broken"
        ? {
            regressed: "🚨 **STRONG READS ARE BROKEN ON PROD**",
            "first-failure": "🚨 **STRONG READS ARE BROKEN ON PROD** (first observation)",
            "still-failing": "🚨 **STILL BROKEN** — strong reads on prod",
          }[kind] ?? "🚨 **STRONG READS ARE BROKEN ON PROD**"
        : {
            regressed: "⚠️ **CANNOT VERIFY strong reads on prod**",
            "first-failure": "⚠️ **CANNOT VERIFY strong reads on prod** (first observation)",
            "still-failing": "⚠️ **STILL CANNOT VERIFY** strong reads on prod",
          }[kind] ?? "⚠️ **CANNOT VERIFY strong reads on prod**";

  const lines = [head, `\`${judgement.reason}\` — ${judgement.detail}`];

  if (cls === "known-broken") {
    lines.push(
      "**What this means:** the kill switch, the spend ceiling and the DD health verdict are reading a CDN cache, " +
        "so a pause or a ceiling written now may not be seen by the next spend."
    );
  } else if (cls === "cannot-verify") {
    lines.push(
      "**What this means:** NOTHING about strong reads — the probe never answered, so the monitor could not tell. " +
        "This is **not** evidence that the money path is broken."
    );
    lines.push("**Do:** check the site and the probe endpoint are up. Do NOT roll back on this alert alone.");
  }

  if (judgement.probe) {
    lines.push(
      `**Probe:** verdict \`${judgement.probe.verdict}\` calibrated \`${judgement.probe.calibrated}\` · ` +
        `arms A=\`${judgement.probe.arms.A}\` B=\`${judgement.probe.arms.B}\` A2=\`${judgement.probe.arms.A2}\``
    );
    if (judgement.probe.selfChecks.length) lines.push(`**Self-checks:** ${judgement.probe.selfChecks.join(", ")}`);
  }
  if (judgement.build) {
    lines.push(`**Build:** \`${judgement.build.commit ?? "unresolved"}\` tree \`${String(judgement.build.tree ?? "unresolved").slice(0, 16)}…\` dirty \`${judgement.build.dirty}\``);
  }
  if (record?.treeChanged === true) {
    lines.push(`⚠️ **The deployed tree hash CHANGED** since the last run (was \`${String(record.previousTree ?? "").slice(0, 16)}…\`). If you did not deploy, that is its own finding.`);
  }
  if (record?.failingSince && !judgement.ok) lines.push(`**Failing since:** ${record.failingSince}`);
  lines.push(`**Target:** ${noEmbed(target)}`);

  // ⭐ The rollback id belongs ONLY where a breakage was actually observed. On the cannot-verify
  // path it is the single most dangerous line in the message.
  if (cls === "known-broken") {
    lines.push("**Rollback:** restore deploy `6a69be4fc7aa0d2c6843fc3c` if the money path is refusing.");
  }
  return lines.join("\n");
}

/** Build the record. Pure, so the suite can assert its shape without touching Blobs. */
export function buildRecord({ judgement, prev, nowIso, target, storeName }) {
  const prevTree = prev?.build?.tree ?? null;
  const tree = judgement.build?.tree ?? null;
  return {
    schema: SCHEMA,
    producedAt: nowIso,
    ok: judgement.ok,
    reason: judgement.reason,
    detail: judgement.detail,
    probe: judgement.probe,
    build: judgement.build,
    // A tree hash that moves without a deploy you remember making is its own finding.
    treeChanged: prevTree === null || tree === null ? null : prevTree !== tree,
    previousTree: prevTree,
    target,
    store: storeName,
    failingSince: judgement.ok ? null : (prev && prev.ok === false && prev.failingSince) || nowIso,
    lastNotifiedAt: prev?.lastNotifiedAt ?? null,
    notify: { planned: null, delivered: null, kind: null, error: null },
  };
}
