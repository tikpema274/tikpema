import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { requireInternal } from "./_auth.mjs";
import {
  SCHEMA, MIN_RERUN_MS, TTL_MS, REMINDER_MS, GRACE_MS, CANARY_PERIOD_MS, CRON_MS,
  DEFAULT_PATHS, CANONICAL_PATH_KEY, PROBE_SUBJECT, PROBE_MARKER, PROBE_UA,
  DEFAULT_STORE_NAME, WEBHOOK_VAR,
  judge, alertHeadline, decideNotify, windowFrom,
} from "../../shared/dd-watch/watch.mjs";

// dd-watch — is the PUBLIC DD SERVICE answering, on BOTH of its paths?
//
// Scheduled every 5 minutes (registered in netlify.toml — an in-code `export const config` is NOT
// picked up by a CLI deploy). Two real HTTP requests to the deployed endpoint, one record, and a
// push on TRANSITIONS only.
//
// ═══ ⭐ THE PROBE IS FREE, WHICH IS WHY IT CAN RUN THIS OFTEN ═══════════════════════════════════
// dd-analyze's rungs are exposure(−1) → retrieve(−0.5) → HEALTH(0) → … → payment(6). An
// unauthenticated POST with no payment header can only reach the 402 challenge: it never settles,
// never charges, needs no session. 402 = past the health rung. 503 = refusing. $0.00 either way.
// ⭐ The analyzer NEVER runs on this path, so the only per-request cost is subjectPreview's single
// eth_getCode — see PROBE_SUBJECT for why that address was chosen deliberately.
//
// ═══ ⚠️ SEPARATE FROM strong-read-watch, DELIBERATELY ═══════════════════════════════════════════
// That one guards the MONEY path (kill switch, spend ceiling); this guards DD AVAILABILITY. Own
// function, own store, own channel, no shared imports between the two watch modules. The channel
// separation is load-bearing rather than tidy: MUTING IS PER-CHANNEL, so a chatty DD alert sharing
// the money channel would train someone to mute the siren that actually matters.
//
// ═══ 🚨 IN-PROCESS WOULD MEASURE THE WRONG THING ═══════════════════════════════════════════════
// This calls the DEPLOYED URLs over real HTTP. Importing dd-analyze and calling it in-process would
// bypass routing entirely — and ROUTING IS HALF THE QUESTION, since /api/* depends on a
// netlify.toml redirect that has been observed serving SPA HTML while the functions path answered.

const LATEST_KEY = "latest";
const json = (statusCode, body) => ({
  statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body, null, 2),
});

/**
 * Ask ONE path. NEVER THROWS — an unreachable target is a RESULT, not an exception. A monitor that
 * can crash is a monitor that goes silent, and silence is this system's healthy signal.
 */
async function probePath(url) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // ⭐ THE PROBE IDENTIFIES ITSELF. With no other monitoring, a dd-analyze invocation in the
        // logs is one of the only signals a STRANGER touched DD. This monitor is about to add ~576
        // self-generated invocations a day in front of that signal, which would bury it on day one.
        // These two headers keep real traffic filterable IN and monitor traffic filterable OUT.
        // ⚠️ It can never be mistaken for a PURCHASE — a 402 ends the exchange — only for INTEREST.
        // Telling "someone looked" from "someone bought" still needs the chain read.
        "user-agent": PROBE_UA,
        "x-tikpema-monitor": PROBE_MARKER,
      },
      body: JSON.stringify({ address: PROBE_SUBJECT, chain: "arc-testnet" }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: null, error: `${err?.name ?? "Error"}: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

export const handler = async (event) => {
  connectBlobs(event);

  // ═══ 🚨 AUTH — AND THE ASYMMETRY THAT DECIDES ITS SHAPE ════════════════════════════════════════
  // Netlify 403s external HTTP invocations of a SCHEDULED function, so practical exposure is already
  // nil and this is defence in depth. But the two ways to get it wrong are NOT equal:
  //
  //   · too permissive → someone triggers a free, side-effect-light probe. Annoying.
  //   · too strict     → THE CRON ITSELF IS REFUSED, the monitor never runs, and it fails SILENTLY —
  //                      precisely the failure this monitor exists to prevent. A monitor that cannot
  //                      run looks exactly like a system with nothing to report.
  //
  // ⭐ So the token is required only for requests that are clearly EXTERNAL HTTP (they carry an
  // httpMethod). A scheduled invocation is never gated on a header it does not control. The refusal
  // names itself loudly, so a misconfiguration can never be mistaken for a healthy silence.
  const looksHttp = typeof event?.httpMethod === "string" && event.httpMethod !== "";
  if (looksHttp && !requireInternal(event)) {
    return json(401, {
      ok: false,
      reason: "internal-only",
      detail:
        "dd-watch runs from its schedule, not from callers. An HTTP invocation must carry a valid " +
        "x-internal-token. ⚠️ THIS REFUSAL IS NOT A HEALTH REPORT — it means the run did not happen.",
    });
  }

  const env = process.env;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // ⚠️ Bare store name, NO options object. A store-level `consistency` default leaks into WRITES —
  // the trap already recorded for the money-path watch.
  const storeName = (env.DD_WATCH_STORE || "").trim() || DEFAULT_STORE_NAME;
  const blobs = getStore(storeName);

  // An unreadable prior is NOT a reason to skip — treat it as absent and run.
  const prev = await blobs.get(LATEST_KEY, { type: "json" }).catch(() => null);

  // Anti-amplification, independent of the verdict: dedupe asks "did a run happen recently", never
  // "was it good". Reusing the verdict here would re-sweep hardest exactly when things are broken.
  if (prev?.producedAt) {
    const age = now - Date.parse(prev.producedAt);
    if (Number.isFinite(age) && age >= 0 && age < MIN_RERUN_MS) {
      return json(200, { ok: true, deduped: true, ageMs: age, minRerunMs: MIN_RERUN_MS, producedAt: prev.producedAt });
    }
  }

  // ── the two probes ───────────────────────────────────────────────────────────────────────────
  // ⚠️ DD_WATCH_URL_* are CALIBRATION LEVERS — the only way to make the alert branch execute, since
  // it never fires naturally while the service is healthy. `gate:watch` REFUSES production while
  // either is set, so a lever cannot survive the calibration that needed it.
  const targets = {
    api: (env.DD_WATCH_URL_API || "").trim() || DEFAULT_PATHS.api,
    functions: (env.DD_WATCH_URL_FN || "").trim() || DEFAULT_PATHS.functions,
  };
  const paths = { api: await probePath(targets.api), functions: await probePath(targets.functions) };

  const judgement = judge({ paths, prev, now, graceMs: GRACE_MS });
  const win = windowFrom({ prev, judgement, nowIso });

  const record = {
    schema: SCHEMA,
    producedAt: nowIso,
    ok: judgement.ok,
    alert: judgement.alert,
    alertReason: judgement.alertReason,
    detail: judgement.detail,
    outcomes: judgement.outcomes,
    reasons: judgement.reasons,
    expectedWindow: judgement.expectedWindow,
    refusingSince: judgement.refusingSince,
    refusingMs: judgement.refusingMs,
    resources: judgement.resources,
    targets,
    canonical: targets[CANONICAL_PATH_KEY],
    // ⭐ THE REFUSAL WINDOW, MEASURED FOR FREE. Two production deploys failed to catch it by hand;
    // every open and close is now recorded with a duration, so its size stops being a guess.
    window: win,
    windowHistory: [
      ...(Array.isArray(prev?.windowHistory) ? prev.windowHistory : []),
      ...(win.event === "window-closed" ? [{ openedAt: win.openedAt, closedAt: win.closedAt, ms: win.ms }] : []),
    ].slice(-20),
    lastNotifiedAt: prev?.lastNotifiedAt ?? null,
    notify: { kind: null, delivered: null, error: null },
    ttlMs: TTL_MS, cronMs: CRON_MS, canaryPeriodMs: CANARY_PERIOD_MS, graceMs: GRACE_MS,
  };

  // ── notify on TRANSITIONS only; silence is the healthy signal ────────────────────────────────
  const decision = decideNotify({
    prevAlert: prev?.alert === true, alert: judgement.alert,
    lastNotifiedAt: prev?.lastNotifiedAt ?? null, now, reminderMs: REMINDER_MS,
  });
  record.notify.kind = decision.kind;

  if (decision.notify) {
    const hook = (env[WEBHOOK_VAR] || "").trim();
    if (!hook) {
      record.notify.delivered = false;
      record.notify.error = `no webhook configured (${WEBHOOK_VAR}) — this monitor cannot reach anyone`;
    } else {
      // ⭐ RECOVERY IS NEWS TOO. A monitor that can alarm but never stands down trains you to ignore
      // it: every alert becomes permanent, so none of them mean anything.
      const head = judgement.alert
        ? alertHeadline(judgement)
        : { severity: "info", headline: "✅ DD RECOVERED — both paths serving again", why: "" };
      const lines = [
        head.headline,
        head.why ? `> ${head.why}` : null,
        `• paths: ${Object.entries(judgement.outcomes).map(([k, v]) => `${k}=${v}`).join("  ")}`,
        judgement.refusingSince
          ? `• refusing ${Math.round(judgement.refusingMs / 60000)}m (grace ${GRACE_MS / 60000}m = 2 canary periods)`
          : null,
        win.event === "window-closed" && win.ms
          ? `• ⭐ refusal window MEASURED: ${Math.round(win.ms / 60000)}m`
          : null,
        `• canonical: ${record.canonical}`,
      ].filter(Boolean);
      try {
        const res = await fetch(hook, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: lines.join("\n") }),
          signal: AbortSignal.timeout(15_000),
        });
        record.notify.delivered = res.ok;
        if (!res.ok) record.notify.error = `webhook rejected the message (HTTP ${res.status})`;
      } catch (err) {
        record.notify.delivered = false;
        record.notify.error = String(err?.name ?? "Error");
      }
    }
    // ⭐ lastNotifiedAt advances ONLY on confirmed delivery, so an undelivered alert is retried
    // rather than suppressed by a reminder window it never earned.
    if (record.notify.delivered) record.lastNotifiedAt = nowIso;
  }

  await blobs.setJSON(LATEST_KEY, record);
  return json(200, record);
};
