import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import {
  MIN_RERUN_MS, TTL_MS, REMINDER_MS, REASON,
  judgeProbe, shouldSkipRerun, decideNotify, notifyMessage, buildRecord,
  DEFAULT_TARGET_URL, DEFAULT_STORE_NAME,
} from "../../shared/strong-read-watch/watch.mjs";

// strong-read-watch — is the money path's strong Blobs read still working ON PROD?
//
// Scheduled every 15 minutes (registered in netlify.toml — an in-code `export const config` is NOT
// picked up by a CLI deploy). It makes ONE real HTTP request to the deployed blobs-probe, records
// the answer, and PUSHES on transitions.
//
// ═══ WHY THIS EXISTS SEPARATELY FROM dd-canary ═══════════════════════════════════════════════
// dd-canary guards the DD ENGINE, which is going standalone and will leave this repo. This guards
// the TIKPEMA APP'S money path — the kill switch, the spend ceiling. Folding the two together
// would mean the pause and budget switches silently lose their monitor the day DD moves out.
// Separate function, separate store, separate module, zero shared imports.
//
// ═══ 🚨 THE ONE RULE THIS FILE MUST NEVER BREAK ══════════════════════════════════════════════
// THIS FILE NAMES NO READ MODE ANYWHERE — not per-operation, not on the store. (`{type:"json"}`
// is a decoding hint and is unrelated.)
//
// If the monitor's own bookkeeping asked for strong reads, then the moment the repair breaks the
// MONITOR breaks too: it throws, writes nothing, and the resulting absence reads as "the monitor
// didn't run" instead of "the money path broke at 03:10". You lose the diagnosis in exactly the
// outage the monitor exists to diagnose.
//
// ⚠️ AND THE DOOR THAT IS EASY TO MISS. Verified in @netlify/blobs@10.7.9, not assumed:
// getFinalRequest serves EVERY operation including writes, and resolves the mode as
// `opConsistency ?? this.consistency` (chunk-YAGWSQMB.js:215, throw at :224). So a STORE-LEVEL
// default leaks into WRITES — `getStore({ name, consistency: "strong" })` would make this
// function's writes throw too. "Don't read with strong" is therefore not a strong enough rule.
// The rule is: ZERO read options anywhere in this file, store created with a bare name.
// scripts/verify-strong-read-watch.mjs greps for it, so a future "fix" fails the suite.
//
// ═══ DETECTION IS THE WEBHOOK, NOT THE RECORD ════════════════════════════════════════════════
// Because bookkeeping is cached, a reader can be served a stale record. Immutable failure keys
// narrow that and do NOT close it — an eventual LIST can also miss the newest key, so the absence
// of failure keys is not proof of no failure. That is structural, not a bug to engineer around:
// the record is the audit trail, the push is the detection. Record FIRST, notify SECOND, and a
// webhook failure is written into the record rather than costing it.

/** ⚠️ SITE-SCOPED, NOT DEPLOY-SCOPED. A draft run writes into the SAME store prod's cron reads: it
 *  would pollute the prod record, and a draft run landing inside MIN_RERUN_MS would make the next
 *  real prod run dedupe ITSELF away. WATCH_STORE exists so a draft proof runs in its own namespace.
 *  Set it ONLY on deploy-preview.
 *
 *  ⚠️ 2026-07-30: proving this on a draft requires temporarily removing the netlify.toml schedule,
 *  because Netlify returns 403 for HTTP invocation of a scheduled function AND crons do not fire on
 *  drafts — so a scheduled function is otherwise unreachable there by BOTH routes. netlify.toml is
 *  NOT part of the build stamp's hashed surface (netlify/functions + shared only), so the
 *  schedule-off draft and the schedule-on production deploy carry an IDENTICAL tree hash: the
 *  function code is provably the same, only the registration differs. */
const DEFAULT_STORE = DEFAULT_STORE_NAME;   // single source: shared/strong-read-watch/watch.mjs
const LATEST_KEY = "latest";

/** Where the money path actually lives. Overridable so the draft proof can aim elsewhere; recorded
 *  in every record so a result can never be mistaken for a different target's. */
const DEFAULT_TARGET = DEFAULT_TARGET_URL;  // single source: shared/strong-read-watch/watch.mjs

/** Netlify's sync ceiling is 10s. Leave room to still write the record after a slow probe. */
const PROBE_TIMEOUT_MS = 6000;

/** ⭐ ONE SOURCE, DELIBERATELY. NO FALLBACK — DO NOT ADD ONE.
 *
 * This briefly fell back to DISCORD_FEEDBACK_WEBHOOK "so it works without a new secret". That
 * variable is already set in the PRODUCTION context, so the fallback meant a prod promotion would
 * silently start pushing money-path alerts into the in-app feedback channel with nobody ever
 * making that decision. An implicit widening arriving through a convenience default — the same
 * shape as `--context all` re-arming a flag that is supposed to be off unless someone says
 * otherwise.
 *
 * Each context now has to be an explicit act. The cost is that an unset variable means nothing is
 * pushed, which is why the PROMOTION GATE exists (scripts/verify-watch-promotion-gate.mjs): a
 * webhook that resolves to nothing is a FAILED PROMOTION, not a healthy monitor. Absence must not
 * read as safe — including the absence of the channel that reports absences.
 *
 * scripts/verify-strong-read-watch.mjs asserts that DISCORD_FEEDBACK_WEBHOOK alone delivers
 * NOTHING, so re-adding the fallback fails the suite. */
const WEBHOOK_SOURCES = ["WATCH_ALERT_WEBHOOK"];

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body, null, 2),
});

/** A store name is either usable or the run REFUSES. A typo must not silently send the record to a
 *  namespace nobody reads — that is indistinguishable from the monitor never running. */
function resolveStoreName(env) {
  const raw = env.WATCH_STORE;
  if (raw === undefined || raw === "") return { ok: true, name: DEFAULT_STORE, overridden: false };
  const name = String(raw).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    return { ok: false, name: null, overridden: true,
      detail: `WATCH_STORE is set to an unusable value (${JSON.stringify(raw)}). Refusing rather than guessing a namespace.` };
  }
  return { ok: true, name, overridden: true };
}

const resolveWebhook = (env) => {
  for (const key of WEBHOOK_SOURCES) {
    const v = env[key];
    if (typeof v === "string" && v.trim().startsWith("http")) return { url: v.trim(), source: key };
  }
  return { url: null, source: null };
};

/** One request to the deployed probe. Never throws; classifies instead. Returns raw text so the
 *  judge — not this function — decides whether it is JSON. */
async function fetchProbe(target) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(target, {
      method: "GET",
      signal: ctl.signal,
      headers: { "user-agent": "tikpema-strong-read-watch/1", "cache-control": "no-cache" },
    });
    const body = await res.text().catch(() => "");
    return { status: res.status, contentType: res.headers.get("content-type"), body, networkError: null, timedOut: false };
  } catch (err) {
    const timedOut = err?.name === "AbortError";
    return { status: null, contentType: null, body: null, timedOut, networkError: timedOut ? null : String(err?.name || "Error") };
  } finally {
    clearTimeout(timer);
  }
}

export const handler = async (event) => {
  connectBlobs(event);

  const env = process.env;
  const store = resolveStoreName(env);
  if (!store.ok) return json(500, { ok: false, reason: "bad-store-override", detail: store.detail });

  const target = (env.WATCH_TARGET_URL || "").trim() || DEFAULT_TARGET;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Bare name. No options object — see the rule at the top of this file.
  const blobs = getStore(store.name);

  // Prior record. An unreadable prior is NOT a reason to skip: treat it as absent and run.
  const prev = await blobs.get(LATEST_KEY, { type: "json" }).catch(() => null);

  const dedupe = shouldSkipRerun({ record: prev, now });
  if (dedupe.skip) {
    return json(200, { ok: true, skipped: true, reason: dedupe.reason, ageMs: dedupe.ageMs, store: store.name });
  }

  const judgement = judgeProbe(await fetchProbe(target));
  const record = buildRecord({ judgement, prev, nowIso, target, storeName: store.name });

  const prevOk = prev && typeof prev.ok === "boolean" ? prev.ok : null;
  const decision = decideNotify({ prevOk, ok: judgement.ok, lastNotifiedAt: prev?.lastNotifiedAt, now });
  record.notify.planned = decision.notify;
  record.notify.kind = decision.kind;

  // ─── WRITE FIRST ────────────────────────────────────────────────────────────────────────────
  // The record is the authoritative artifact. Everything after this point can fail without
  // costing it.
  let recordWritten = true;
  try {
    await blobs.setJSON(LATEST_KEY, record);
    // Failures are APPEND-ONLY under their own key so a later success cannot overwrite the
    // evidence that a failure happened. (This narrows the cached-read window; it does not close
    // it — see the header. That is why the webhook exists.)
    if (!judgement.ok) await blobs.setJSON(`failure:${nowIso}`, record);
  } catch (err) {
    recordWritten = false;
    record.writeError = String(err?.name || "Error");
  }

  // ─── NOTIFY SECOND ──────────────────────────────────────────────────────────────────────────
  if (decision.notify) {
    const hook = resolveWebhook(env);
    if (!hook.url) {
      record.notify.delivered = false;
      record.notify.error = `no webhook configured (checked ${WEBHOOK_SOURCES.join(", ")}) — this monitor cannot reach anyone`;
    } else {
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: notifyMessage({ kind: decision.kind, judgement, record, target }) }),
        });
        record.notify.delivered = res.ok;
        if (!res.ok) record.notify.error = `webhook rejected the message (HTTP ${res.status})`;
      } catch (err) {
        record.notify.delivered = false;
        record.notify.error = String(err?.name || "Error");
      }
    }
    // ⭐ lastNotifiedAt advances ONLY on confirmed delivery, so an undelivered alert is retried on
    // the next run instead of being silently rate-limited away by a send that never landed.
    if (record.notify.delivered === true) record.lastNotifiedAt = nowIso;

    // Patch the record with the notify outcome. If THIS write fails the earlier one still stands —
    // that is the whole point of writing first.
    if (recordWritten) {
      await blobs.setJSON(LATEST_KEY, record).catch(() => {});
      if (!judgement.ok) await blobs.setJSON(`failure:${nowIso}`, record).catch(() => {});
    }
  }

  return json(200, {
    ok: judgement.ok,
    reason: judgement.reason,
    detail: judgement.detail,
    notify: record.notify,
    treeChanged: record.treeChanged,
    recordWritten,
    store: store.name,
    storeOverridden: store.overridden,
    target,
    windows: { minRerunMs: MIN_RERUN_MS, ttlMs: TTL_MS, reminderMs: REMINDER_MS },
    probe: judgement.probe,
    build: judgement.build,
  });
};

export { REASON };
