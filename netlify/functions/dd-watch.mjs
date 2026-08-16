import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { requireInternal } from "./_auth.mjs";
// ⭐ SO EVERY RECORD SAYS WHICH CODE WROTE IT. Without this, attributing an observation to a code
// change means comparing a timestamp against a fuzzy publish moment — and a tick can straddle the
// transition, so a result from the OLD code gets credited to the new one. Same attribution problem
// as the settler probe: a concurrent change makes an observation unattributable however clean it
// looks. The stamp is baked at build time, so it identifies the artifact that produced the record.
import { buildStamp } from "../../shared/build-stamp.mjs";
import {
  SCHEMA, MIN_RERUN_MS, TTL_MS, REMINDER_MS, GRACE_MS, CANARY_PERIOD_MS, CRON_MS,
  DEFAULT_PATHS, CANONICAL_PATH_KEY, PROBE_SUBJECT, PROBE_MARKER, PROBE_UA,
  DEFAULT_STORE_NAME, WEBHOOK_VAR, MONEY_WEBHOOK_VAR,
  judge, alertHeadline, decideNotify, windowFrom, leverActive, blocksDeposits,
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

  // ═══ 🚨 AUTH — AND THE BUG THIS BLOCK ALREADY SHIPPED ONCE ═════════════════════════════════════
  // The first version refused any invocation carrying an httpMethod without an internal token. It
  // ran five times on schedule (22:05→22:25) and wrote NOTHING, because **Netlify delivers SCHEDULED
  // invocations WITH an httpMethod** — so `looksHttp` was true for the cron itself, every run
  // returned 401, and the monitor silently never ran. Durations gave it away: 22–29ms, when two
  // HTTPS probes cannot complete in under ~200ms.
  //
  // ⚠️ THE WARNING FOR EXACTLY THIS WAS WRITTEN IN THIS BLOCK AT THE TIME ("too strict → the cron
  // itself is refused, the monitor never runs, and it fails SILENTLY"). Naming a failure mode is not
  // the same as choosing a discriminator that avoids it.
  //
  // ⭐ THE ENFORCEMENT IS THE PLATFORM, AND IT IS MEASURED, NOT ASSUMED: an external
  // `POST /.netlify/functions/dd-watch` returns **403** because the function is SCHEDULED — Netlify
  // blocks it before any of this code runs. There is therefore no reachable external caller for an
  // in-code check to protect against, and the check could only ever do harm: its false-positive kills
  // the monitor, while its true-positive is unreachable.
  //
  // So the token is RECORDED, never enforced. A monitor must never be able to refuse itself.
  const invokedWithToken = requireInternal(event);

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
  // ⭐ INDUCED vs REAL, derived not remembered. A calibration lever opens a window that looks
  // identical to a real outage in windowHistory — and the history's whole purpose is answering how
  // big the post-deploy refusal window actually is. Labelling it automatically means nobody has to
  // tag it and nobody can forget.
  const induced = leverActive(targets);
  const win = windowFrom({ prev, judgement, nowIso, induced });

  const stamp = buildStamp();
  const record = {
    schema: SCHEMA,
    producedAt: nowIso,
    // ⭐ SELF-ATTRIBUTION. `resolved:false` means the deploy skipped stamping — reported, never guessed.
    build: { commit: stamp.commit, tree: stamp.tree, resolved: stamp.resolved },
    ok: judgement.ok,
    alert: judgement.alert,
    alertReason: judgement.alertReason,
    detail: judgement.detail,
    outcomes: judgement.outcomes,
    reasons: judgement.reasons,
    expectedWindow: judgement.expectedWindow,
    refusingSince: judgement.refusingSince,
    refusingMs: judgement.refusingMs,
    // ⭐ The window clock — ANY not-ok state, not just refusals. See judge()'s note: a path serving
    // SPA HTML is a real outage and used to leave no trace here.
    unhealthySince: judgement.unhealthySince,
    unhealthyMs: judgement.unhealthyMs,
    resources: judgement.resources,
    targets,
    leverActive: induced,
    canonical: targets[CANONICAL_PATH_KEY],
    // ⭐ THE REFUSAL WINDOW, MEASURED FOR FREE. Two production deploys failed to catch it by hand;
    // every open and close is now recorded with a duration, so its size stops being a guess.
    window: win,
    windowHistory: [
      ...(Array.isArray(prev?.windowHistory) ? prev.windowHistory : []),
      ...(win.event === "window-closed" ? [{ openedAt: win.openedAt, closedAt: win.closedAt, ms: win.ms, induced: win.induced === true }] : []),
    ].slice(-20),
    invokedWithToken,
    lastNotifiedAt: prev?.lastNotifiedAt ?? null,
    notify: { kind: null, delivered: null, error: null },
    ttlMs: TTL_MS, cronMs: CRON_MS, canaryPeriodMs: CANARY_PERIOD_MS, graceMs: GRACE_MS,
  };

  // ── notify on TRANSITIONS only; silence is the healthy signal ────────────────────────────────
  const decision = decideNotify({
    prevAlert: prev?.alert === true, alert: judgement.alert, ok: judgement.ok,
    lastNotifiedAt: prev?.lastNotifiedAt ?? null, now, reminderMs: REMINDER_MS,
  });
  record.notify.kind = decision.kind;

  // ═══ 🚨 PERSIST BEFORE BROADCAST — the same inversion _dd-x402 already had to learn ════════════
  // The first version notified FIRST and wrote LAST. If that write ever failed, the message went out
  // and `prev` stayed null — so the NEXT run would see prevAlert=false, classify a continuing
  // problem as `first-alert` again, and send again. Every five minutes. Forever. The reminder
  // window that exists to stop a firehose would never be consulted, because the state proving there
  // was anything to remind about is exactly what failed to persist.
  //
  // ⭐ SO THE ALERT STATE IS PERSISTED BEFORE ANY MESSAGE IS SENT. If the process dies between the
  // two, the next run sees prevAlert=true and takes the reminder path — one repeat, rate-limited,
  // instead of an unbounded loop. The failure direction is a duplicate, never a storm and never
  // silence.
  //
  // ⚠️ The natural order fails in the direction that punishes the reader, which is the same reason
  // the facilitator writes its pending record before it broadcasts a payment.
  await blobs.setJSON(LATEST_KEY, record);

  if (decision.notify) {
    const hook = (env[WEBHOOK_VAR] || "").trim();
    if (!hook) {
      record.notify.delivered = false;
      record.notify.error = `no webhook configured (${WEBHOOK_VAR}) — this monitor cannot reach anyone`;
    } else {
      // ⭐ RECOVERY IS NEWS TOO. A monitor that can alarm but never stands down trains you to ignore
      // it: every alert becomes permanent, so none of them mean anything.
      // ⭐ The headline is chosen from the DECISION KIND, not from `alert` alone — that conflation is
      // what let a stand-down fire into a live outage.
      const head = judgement.alert
        ? alertHeadline(judgement)
        : decision.kind === "de-escalated"
          ? alertHeadline({ alertReason: "de-escalated" })
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
    // ── ⭐⭐ THE SECOND ROUTE: past the grace, this is a MONEY-PATH event ─────────────────────
    // 🚨 A stale health artifact blocks the vault DEPOSIT since step 2, not just report sales. The
    // DD channel above still gets everything; the money channel gets ONLY the deposit-blocking case,
    // so the separation that keeps the kill-switch siren audible survives intact.
    // ⚠️ NEVER THROWS AND NEVER GATES THE PRIMARY — it runs after the DD post has already been made
    // and its outcome recorded. A second-channel failure must not cost the first message.
    record.notify.money = { attempted: false, delivered: null, reason: null };
    if (blocksDeposits(judgement)) {
      const moneyHook = (env[MONEY_WEBHOOK_VAR] || "").trim();
      record.notify.money.attempted = true;
      if (!moneyHook) {
        record.notify.money.delivered = false;
        record.notify.money.reason = `no ${MONEY_WEBHOOK_VAR} configured — the deposit-blocking alert cannot reach the money channel`;
      } else {
        // ⭐ REFRAMED, NOT MIRRORED. The DD message describes availability; this one has to say what
        // it MEANS where money moves, because the reader of this channel is not tracking DD at all.
        const moneyLines = [
          "🚨 DEPOSITS BLOCKED — the DD health artifact is not serving",
          "> Vault deposits gate on the DD report since step 2, so while this refuses the deposit path REFUSES too. This is fail-closed and correct; it is not a data loss.",
          `• refusing ${Math.round(judgement.refusingMs / 60000)}m (past the ${GRACE_MS / 60000}m grace; health TTL is ${TTL_MS / 60000}m)`,
          `• reason: ${judgement.alertReason ?? "unknown"}`,
          "• likeliest cause: the dd-canary cron has not fired. Margin is TWO missed ticks; the third blocks deposits.",
          `• canonical: ${record.canonical}`,
        ];
        try {
          const r2 = await fetch(moneyHook, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: moneyLines.join("\n") }),
            signal: AbortSignal.timeout(15_000),
          });
          record.notify.money.delivered = r2.ok;
          if (!r2.ok) record.notify.money.reason = `money webhook rejected the message (HTTP ${r2.status})`;
        } catch (err) {
          record.notify.money.delivered = false;
          record.notify.money.reason = String(err?.name ?? "Error");
        }
      }
    }

    // ⭐ lastNotifiedAt advances ONLY on confirmed delivery, so an undelivered alert is retried
    // rather than suppressed by a reminder window it never earned.
    if (record.notify.delivered) record.lastNotifiedAt = nowIso;

    // Second write: the delivery OUTCOME. ⚠️ Best-effort by design — if THIS fails the alert state
    // is already safe on disk, so the cost is one repeated message, not a loop and not silence.
    await blobs.setJSON(LATEST_KEY, record).catch(() => {});
  }

  // ⭐ No trailing write here. The record was persisted BEFORE the broadcast (above), and the
  // delivery outcome was written after it. A third write would only re-save what is already on disk
  // and would blur which write is the load-bearing one.
  return json(200, record);
};
