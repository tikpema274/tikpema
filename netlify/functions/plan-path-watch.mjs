import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { issueSession } from "./_auth.mjs";
import {
  OUTCOME, REASON, MIN_RERUN_MS, REMINDER_MS, PROBE_AMOUNT_USDC, PROBE_DESTINATION,
  DEFAULT_TARGET_URL, DEFAULT_STORE_NAME, DEFAULT_PROBE_OWNER, FUNCTION_NAME,
  judgePlanProbe, shouldSkipRerun, decideNotify, notifyMessage, buildRecord, buildSkipRecord, classifySend,
  judgeCadence, isCannotVerify,
} from "../../shared/plan-path-watch/watch.mjs";

// plan-path-watch — CAN AN AGENT BRIDGE PLAN STILL REACH A PRICED DECISION ON PROD?
//
// Scheduled every 30 minutes in netlify.toml (an in-code `export const config` is NOT picked up by
// a CLI deploy — same trap as every other scheduled function here).
//
// ═══ WHY THIS RUNS BETWEEN DEPLOYS, WHICH IS THE ENTIRE POINT ════════════════════════════════
// The 2026-09-03 plan-path outage lasted ~38 hours. The only check that touches this path,
// `gate:forgery`, runs INSIDE `deploy:prod` — so it had no prior observation to compare against
// and could not date what it found. A deploy-time gate can tell you a thing is broken; only a
// scheduled one can tell you WHEN it broke.
//
// ⚠️ AND THE LIMIT, STATED RATHER THAN IMPLIED: this dates the class to WITHIN ITS INTERVAL — 30
// minutes — and no finer. It is not continuous monitoring and must never be described as such.
//
// ═══ 🚨 WHY IT CANNOT SPEND ══════════════════════════════════════════════════════════════════
// The probe plan is ONE bridge step of 200 USDC — far above the 25 USDC per-bridge cap. That cap
// is checked in the execution loop BEFORE `executeAction`, so the step is refused having moved
// nothing. ⭐ The cap path is chosen over the acknowledge-band amount deliberately: a probe whose
// safety rests on the CONSENT GATE is circular, because the run where consent breaks is the run
// where the probe spends. See the module header.
// ⛔ AND IT IS PROVEN EVERY RUN, NOT ASSUMED: stepsRun 0, completed false, and the owner's receipt
// count unchanged across the request. If it ever spends, that is `reason: "spent"` and the loudest
// alert this monitor can send — never a quiet pass.
//
// ═══ WHY THE OWNER IS THE ONE gate:forgery ALREADY USES ══════════════════════════════════════
// `agent-execute-plan` resolves the agent wallet before anything else, and `ensureOwnerWallet`
// MINTS a real Circle wallet for an unknown owner. Reusing the established probe identity takes
// the already-mapped fast path, so this monitor creates no wallet and introduces no new identity.
//
// ═══ 🚨 THIS FILE NAMES NO READ MODE ═════════════════════════════════════════════════════════
// Same rule as strong-read-watch, for the same reason: if the monitor's own bookkeeping asked for
// strong reads it would break in exactly the outage it exists to report, and the resulting absence
// would read as "the monitor didn't run". Store created with a bare name, no read options anywhere.

const STORE = process.env.PLAN_WATCH_STORE || DEFAULT_STORE_NAME;
const TARGET = process.env.PLAN_WATCH_URL || DEFAULT_TARGET_URL;
const OWNER = process.env.PLAN_WATCH_OWNER || DEFAULT_PROBE_OWNER;
const RECEIPTS_STORE = "bridge-receipts";
const LATEST_KEY = "latest";
const WEBHOOK_SOURCES = ["WATCH_ALERT_WEBHOOK"];
const TIMEOUT_MS = 20_000;        // per press
const PROBE_BUDGET_MS = 40_000;   // both presses together — under the scheduled function wall-clock

const nowIso = () => new Date().toISOString();

/** Count this owner's receipts. Read-only, and its FAILURE is not a spend signal — an unreadable
 *  count yields null, which `assertNoSpend` treats as "not compared" rather than "unchanged".
 *  ⛔ An absence must not read as safe: null means we could not check, and the record says so. */
async function countReceipts(blobs) {
  try {
    const { blobs: list } = await blobs.list({ prefix: `o/${OWNER.toLowerCase()}/` });
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
}

export async function handler(event) {
  if (event?.blobs) connectBlobs(event);
  const store = getStore(STORE);
  const receipts = getStore(RECEIPTS_STORE);
  const startedAt = nowIso();

  const prev = await store.get(LATEST_KEY, { type: "json" }).catch(() => null);
  const skip = shouldSkipRerun({ record: prev, now: Date.now() });
  if (skip.skip) {
    // ⛔ A SKIP IS WRITTEN, NOT RETURNED SILENTLY. This used to return before touching the store, so
    // a monitor deduping EVERY run left a record identical to a healthy one — the exact state a
    // MIN_RERUN_MS above the cron period produces, and it was invisible to any single read. The
    // write updates bookkeeping ONLY; the last real verdict is left alone, because a skip observed
    // nothing and must not manufacture an observation.
    // ⚠️ One write per invocation — the same cost a completed run already pays, and a skip makes no
    // HTTP request, so this is strictly cheaper than probing. Not a storm.
    await store.setJSON(LATEST_KEY, buildSkipRecord({ prev, now: Date.now(), reason: skip.reason }))
      .catch((e) => console.warn(`[plan-watch] skip write failed — ${e?.message}`));
    console.log(`[plan-watch] SKIP ${skip.reason} ageMs=${skip.ageMs} — recorded, not silent`);
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: skip.reason }) };
  }

  // ═══ ⭐⭐ WRITE THE ATTEMPT BEFORE PROBING ══════════════════════════════════════════════════
  // An observer that writes only at the end loses everything when it is stopped — a killed
  // invocation, a platform timeout, a redeploy mid-run — and the absence then reads as "the
  // monitor never ran" instead of "the monitor started and did not come back". This repo has lost
  // a real refusal window to exactly that, twice. The attempt record is overwritten by the
  // complete one below; if it survives, it IS the finding.
  await store.setJSON(LATEST_KEY, {
    ...prev,
    schema: "plan-path-watch/1", producedAt: startedAt, lastInvokedAt: startedAt, phase: "attempt",
    outcome: null, reason: null, target: TARGET,
    prevOutcome: prev?.outcome ?? null, lastNotifiedAt: prev?.lastNotifiedAt ?? null,
    detail: "probe started; no answer yet. If this record persists, the run did not come back.",
  }).catch((e) => console.warn(`[plan-watch] attempt write failed — ${e?.message}`));

  const receiptsBefore = await countReceipts(receipts);

  // ── the request: QUOTE-THEN-POST, the way a real confirm traverses ────────────────────────────
  // ⛔ a300359 (2026-09-13) added a seal step: a bridge plan with no `quoteToken` is answered with a
  // 409 re-quote BEFORE the cap/balance guards run. The old single-post probe hit that 409 and the
  // judge read every tick as http-error — a 28-hour+ outage nobody could see. THE PROBE IS A CLIENT
  // OF agent-execute-plan; when that endpoint's request contract changed, this caller had to change
  // with it. So the probe now does what the panel does:
  //   press 1 (quoteOnly) → the endpoint prices, seals, returns stepDisclosures[i].quoteToken
  //   press 2 (with those tokens) → the endpoint opens the seals and reaches the cap/balance guards
  // Only press 2 carries a verdict about the guarded path; press 1 proves pricing+sealing worked.
  //
  // ⚠️ PRESS 1 NOW READS THE CHAIN (the requote path reads the agent balance for the fail-open
  // disclosure, 2a17a8b), so publicClient()'s retry backoff can cost seconds on a degraded Arc RPC.
  // That is a NEW failure mode the single-post probe did not have: press 1 can time out or come back
  // without usable tokens. It is reported as its own condition (`press1` in the result), never
  // folded into the press-2 verdict — "we could not even get a quote" is not "the path refused".
  //
  // ⭐ A TOTAL TIME BUDGET across both presses, not just a per-fetch timeout: two chain-reading
  // presses back to back must not exceed the scheduled function's wall-clock.
  const PLAN = [{ type: "bridge_usdc", amountUsdc: PROBE_AMOUNT_USDC, destination: PROBE_DESTINATION, reasoning: "plan-path-watch probe" }];
  let res = { status: null, contentType: null, body: null, networkError: null, timedOut: false, press1: null };
  const secret = (process.env.SESSION_SECRET || "").trim();
  const budgetStart = Date.now();
  const budgetLeft = () => PROBE_BUDGET_MS - (Date.now() - budgetStart);

  const post = async (token, body) => {
    const perPress = Math.min(TIMEOUT_MS, Math.max(0, budgetLeft()));
    if (perPress <= 0) return { status: null, contentType: null, body: null, networkError: null, timedOut: true };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), perPress);
    try {
      const r = await fetch(TARGET, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      return { status: r.status, contentType: r.headers.get("content-type"), body: await r.text(), networkError: null, timedOut: false };
    } catch (e) {
      return { status: null, contentType: null, body: null, networkError: e?.name === "AbortError" ? null : (e?.name || "fetch-failed"), timedOut: e?.name === "AbortError" };
    } finally { clearTimeout(timer); }
  };

  if (!secret) {
    // ⛔ NEVER a silent skip. A monitor that no-ops without its credential reports success for a
    // path it never examined.
    res.secretMissing = true;
  } else {
    let token = null;
    try { ({ token } = issueSession({ address: OWNER, method: "metamask" })); }
    catch (e) { res.networkError = `session mint failed: ${e?.name || "error"}`; }
    if (token) {
      // ── press 1: quote-only. Extract the sealed token per bridge step. ──
      const p1 = await post(token, { plan: PLAN, quoteOnly: true });
      const p1ok = p1.status === 200 && !p1.timedOut && !p1.networkError;
      let quoteTokens = null;
      if (p1ok) {
        try {
          const b1 = JSON.parse(String(p1.body ?? ""));
          const sd = b1?.stepDisclosures;
          if (sd && typeof sd === "object") {
            quoteTokens = {};
            for (const [i, d] of Object.entries(sd)) if (d && typeof d.quoteToken === "string") quoteTokens[i] = d.quoteToken;
          }
        } catch { /* fall through to press1 failure */ }
      }
      const gotTokens = quoteTokens && Object.keys(quoteTokens).length > 0;
      if (!gotTokens) {
        // ⛔ THE NEW FAILURE MODE, NAMED. press 1 did not yield a sealed token: it timed out (a slow
        // chain read), the transport failed, it answered non-200, or it returned no stepDisclosures.
        // The judge maps this to its own reason — NOT the press-2 http-error bucket.
        res.press1 = p1.timedOut ? "timeout" : p1.networkError ? `unreachable:${p1.networkError}`
          : p1.status !== 200 ? `status:${p1.status}` : "no-tokens";
      } else {
        // ── press 2: the real traversal, carrying the sealed tokens. This body is the verdict. ──
        const p2 = await post(token, { plan: PLAN, quoteTokens });
        res.status = p2.status; res.contentType = p2.contentType; res.body = p2.body;
        res.networkError = p2.networkError; res.timedOut = p2.timedOut;
      }
    }
  }

  const receiptsAfter = await countReceipts(receipts);
  const judgement = judgePlanProbe(res, { receiptsBefore, receiptsAfter });
  const producedAt = nowIso();
  const record = buildRecord({ judgement, target: TARGET, producedAt, prev });
  // ⭐ Logged so the FUNCTION LOG carries the same one-read cadence answer the store does.
  const cadence = judgeCadence({ record: prev, now: Date.now() });
  console.log(`[plan-watch] cadence-before-this-run=${cadence.cadence} runCount=${record.runCount} skipCount=${record.skipCount}`);

  console.log(
    `[plan-watch] ${judgement.outcome.toUpperCase()} reason=${judgement.reason} matchedBy=${record.matchedBy ?? "—"} fieldStreak=${record.fieldStreak} ` +
      `receipts=${receiptsBefore}→${receiptsAfter} detail=${judgement.detail}`
  );

  const decision = decideNotify({
    prevOutcome: prev?.outcome ?? null, outcome: judgement.outcome,
    lastNotifiedAt: prev?.lastNotifiedAt ?? null, now: Date.now(), reminderMs: REMINDER_MS,
  });

  if (decision.notify) {
    const url = WEBHOOK_SOURCES.map((v) => process.env[v]).find((u) => (u || "").trim());
    // ⛔ THE ELSE-BRANCH THE OLD `if (r.ok)` NEVER HAD. A 400/404 or a network throw used to be
    // discarded with no status, no body, no count — a genuine unreachable channel was invisible.
    // Now every send attempt records its outcome; only an ok resets the failure streak.
    record.lastSendAt = producedAt;
    let sc;
    if (url) {
      try {
        const r = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: notifyMessage({ kind: decision.kind, judgement, target: TARGET, record }) }),
        });
        const body = r.ok ? null : await r.text().catch(() => null);
        sc = classifySend({ urlPresent: true, ok: r.ok, status: r.status, body });
        if (r.ok) record.lastNotifiedAt = producedAt;
        else console.warn(`[plan-watch] webhook rejected HTTP ${r.status} — ${(sc.lastSendBody || "").slice(0, 80)}`);
      } catch (e) {
        sc = classifySend({ urlPresent: true, error: e?.name || "fetch-failed" });
        console.warn(`[plan-watch] webhook failed — ${e?.message}`);
      }
    } else {
      sc = classifySend({ urlPresent: false });
      console.warn(`[plan-watch] NOTIFY ${decision.kind} but no webhook configured (${WEBHOOK_SOURCES.join(", ")})`);
    }
    record.lastSendStatus = sc.lastSendStatus;
    record.lastSendBody = sc.lastSendBody;
    record.consecutiveSendFailures = sc.sendFailed ? (record.consecutiveSendFailures || 0) + 1 : 0;
    console.log(`[plan-watch] SEND ${decision.kind} → status=${record.lastSendStatus} consecutiveFailures=${record.consecutiveSendFailures}`);
  }

  await store.setJSON(LATEST_KEY, record).catch((e) => console.warn(`[plan-watch] record write failed — ${e?.message}`));
  // ⭐ IMMUTABLE FAILURE KEYS. `latest` is overwritten every run, so a refusal that recovers before
  // anyone looks would leave no trace at all — the observation would not survive.
  if (judgement.outcome !== OUTCOME.HEALTHY) {
    await store.setJSON(`failure:${producedAt}`, record).catch(() => {});
  }

  return { statusCode: 200, body: JSON.stringify({ outcome: judgement.outcome, reason: judgement.reason, notified: decision.notify }) };
}
