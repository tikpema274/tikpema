import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { issueSession } from "./_auth.mjs";
import {
  OUTCOME, REASON, MIN_RERUN_MS, REMINDER_MS, PROBE_AMOUNT_USDC, PROBE_DESTINATION,
  DEFAULT_TARGET_URL, DEFAULT_STORE_NAME, DEFAULT_PROBE_OWNER, FUNCTION_NAME,
  judgePlanProbe, shouldSkipRerun, decideNotify, notifyMessage, buildRecord, isCannotVerify,
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
const TIMEOUT_MS = 25_000;

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
    console.log(`[plan-watch] SKIP ${skip.reason} ageMs=${skip.ageMs}`);
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: skip.reason }) };
  }

  // ═══ ⭐⭐ WRITE THE ATTEMPT BEFORE PROBING ══════════════════════════════════════════════════
  // An observer that writes only at the end loses everything when it is stopped — a killed
  // invocation, a platform timeout, a redeploy mid-run — and the absence then reads as "the
  // monitor never ran" instead of "the monitor started and did not come back". This repo has lost
  // a real refusal window to exactly that, twice. The attempt record is overwritten by the
  // complete one below; if it survives, it IS the finding.
  await store.setJSON(LATEST_KEY, {
    schema: "plan-path-watch/1", producedAt: startedAt, phase: "attempt",
    outcome: null, reason: null, target: TARGET,
    prevOutcome: prev?.outcome ?? null, lastNotifiedAt: prev?.lastNotifiedAt ?? null,
    detail: "probe started; no answer yet. If this record persists, the run did not come back.",
  }).catch((e) => console.warn(`[plan-watch] attempt write failed — ${e?.message}`));

  const receiptsBefore = await countReceipts(receipts);

  // ── the request ─────────────────────────────────────────────────────────────────────────────
  let res = { status: null, contentType: null, body: null, networkError: null, timedOut: false };
  const secret = (process.env.SESSION_SECRET || "").trim();
  if (!secret) {
    // ⛔ NEVER a silent skip. A monitor that no-ops without its credential reports success for a
    // path it never examined.
    res.secretMissing = true;
  } else {
    let token = null;
    try { ({ token } = issueSession({ address: OWNER, method: "metamask" })); }
    catch (e) { res.networkError = `session mint failed: ${e?.name || "error"}`; }
    if (token) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const r = await fetch(TARGET, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            plan: [{ type: "bridge_usdc", amountUsdc: PROBE_AMOUNT_USDC, destination: PROBE_DESTINATION, reasoning: "plan-path-watch probe" }],
          }),
          signal: ac.signal,
        });
        res.status = r.status;
        res.contentType = r.headers.get("content-type");
        res.body = await r.text();
      } catch (e) {
        if (e?.name === "AbortError") res.timedOut = true;
        else res.networkError = e?.name || "fetch-failed";
      } finally { clearTimeout(timer); }
    }
  }

  const receiptsAfter = await countReceipts(receipts);
  const judgement = judgePlanProbe(res, { receiptsBefore, receiptsAfter });
  const producedAt = nowIso();
  const record = buildRecord({ judgement, target: TARGET, producedAt, prev });

  console.log(
    `[plan-watch] ${judgement.outcome.toUpperCase()} reason=${judgement.reason} ` +
      `receipts=${receiptsBefore}→${receiptsAfter} detail=${judgement.detail}`
  );

  const decision = decideNotify({
    prevOutcome: prev?.outcome ?? null, outcome: judgement.outcome,
    lastNotifiedAt: prev?.lastNotifiedAt ?? null, now: Date.now(), reminderMs: REMINDER_MS,
  });

  if (decision.notify) {
    const url = WEBHOOK_SOURCES.map((v) => process.env[v]).find((u) => (u || "").trim());
    if (url) {
      try {
        const r = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: notifyMessage({ kind: decision.kind, judgement, target: TARGET, record }) }),
        });
        if (r.ok) record.lastNotifiedAt = producedAt;
        else console.warn(`[plan-watch] webhook rejected HTTP ${r.status}`);
      } catch (e) { console.warn(`[plan-watch] webhook failed — ${e?.message}`); }
    } else {
      console.warn(`[plan-watch] NOTIFY ${decision.kind} but no webhook configured (${WEBHOOK_SOURCES.join(", ")})`);
    }
  }

  await store.setJSON(LATEST_KEY, record).catch((e) => console.warn(`[plan-watch] record write failed — ${e?.message}`));
  // ⭐ IMMUTABLE FAILURE KEYS. `latest` is overwritten every run, so a refusal that recovers before
  // anyone looks would leave no trace at all — the observation would not survive.
  if (judgement.outcome !== OUTCOME.HEALTHY) {
    await store.setJSON(`failure:${producedAt}`, record).catch(() => {});
  }

  return { statusCode: 200, body: JSON.stringify({ outcome: judgement.outcome, reason: judgement.reason, notified: decision.notify }) };
}
