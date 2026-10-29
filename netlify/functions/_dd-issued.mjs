// _dd-issued.mjs — A RECORD OF EVERY DD REPORT A CALLER WAS GIVEN.
//
// ═══ ⭐ WHY THIS EXISTS (2026-10-29) ═════════════════════════════════════════════════════════
// The transparent-proxy finding (PROGRESS.md, 8308729) asked "was anyone told this contract was clean?"
// and could answer only for the three PAID reports — the vault card, the deposit gate and the mandate
// checks kept nothing. A future finding about the engine must be checkable against what was said.
//
// ⭐ WHAT IS RECORDED: one record per report that reached a caller AND makes a claim about a subject.
// ⛔ REFUSALS ARE NOT RECORDED (T, 2026-10-29). A refusal established nothing about the subject, and
// the public refusal path is free and unauthenticated — with no retention limit, recording each one
// would let anyone grow this store without paying. Refusals stay in the logs.
// ⛔ NO USER IDENTITY (T, 2026-10-29): no wallet, holder, mandate id or session. The record answers
// "was a report saying X about subject Y issued, when, on which path" — not who received it.
// ⛔ NOT CALLED INSIDE analyze(). The shared engine stays storage-free, and the canary's fixture runs
// — which no user sees — are not recorded.
//
// ═══ ⭐ THE WRITE NEVER BLOCKS THE ANSWER (T, 2026-10-29) ════════════════════════════════════
// A failed write still serves the report. The failure is counted under its own key prefix in the DD
// health store — NEVER the canary's health record, which decides whether the service serves at all —
// and alerted on the DD channel, at most once per instance per ALERT_WINDOW_MS with the count.
// ⚠️ THE LIMIT, STATED: a Blobs outage that fails the record will usually fail the counter too. Then
// the alert and the log line are the only signals, and with DD_WATCH_WEBHOOK unset the alert reaches
// nobody — the log line says so.
//
// Retention: none. Every record is kept (T, 2026-10-29).

import { createHash, randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { canonicalize } from "../../shared/onchain-analyze/attest.mjs";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
import { codeIdentity } from "../../shared/dd-canary/health.mjs";
import { DD_HEALTH_STORE } from "./_dd-health.mjs";

export const DD_ISSUED_STORE = "dd-issued";
/** Under DD_HEALTH_STORE, and disjoint from `health:` — the canary's record is never written here. */
export const FAILURE_PREFIX = "issued-record-failure/";
// paid       — served on retrieve after the payment confirmed (_dd-x402 retrievePaid)
// paid-free  — served free by the paid endpoint because it was not chargeable (e.g. an unsigned answer)
// in-app-card — the signed-in DD card (agent-dd-report)
// deposit-disclosure / deposit-execution — the vault paths, with what the user was shown
// mandate-check — a vault mandate's signed check report
export const ISSUED_PATHS = Object.freeze(["paid", "paid-free", "in-app-card", "deposit-disclosure", "deposit-execution", "mandate-check"]);
export const WRITE_TIMEOUT_MS = 1500;
export const ALERT_WINDOW_MS = 10 * 60 * 1000;
export const RECORD_VERSION = 1;

/**
 * The record for one issuance. PURE. Built only from the report and what the caller was shown —
 * nothing here can carry the holder, because the holder is never passed in.
 */
export function buildIssuedRecord({ path, report, shown = null, pendingHandle = null }, { now = () => Date.now() } = {}) {
  if (!ISSUED_PATHS.includes(path)) throw new Error(`buildIssuedRecord: unknown path ${JSON.stringify(path)}`);
  const ev = report?.shape?.evidence ?? {};
  return {
    v: RECORD_VERSION,
    issuedAt: new Date(now()).toISOString(),
    path,
    subject: {
      address: String(report?.subject?.address ?? "").toLowerCase() || null,
      chainId: report?.subject?.chainId ?? null,
      blockNumber: report?.subject?.blockNumber ?? null,
    },
    schemaVersion: report?.schemaVersion ?? null,
    // the DD code identity that produced it; null when unbound (never a placeholder)
    ddBuild: codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS }).build ?? null,
    // ⭐ links this record to a signed report: canon/1 excludes only `reads` and `attestation`
    canonHash: createHash("sha256").update(canonicalize(report)).digest("hex"),
    attestation: report?.attestation?.status === "signed" ? "signed" : "unsigned",
    shape: { class: report?.shape?.class ?? null, variant: report?.shape?.variant ?? null, admin: ev.admin ?? null },
    owner: { kind: report?.owner?.kind ?? null, stillControlledVia: report?.owner?.stillControlledVia ?? null },
    powersPresent: Array.isArray(report?.powersPresent) ? [...report.powersPresent] : [],
    notChecked: (report?.coverage?.notChecked ?? []).map((e) => e?.group).filter(Boolean),
    shown: shown ? { level: shown.level ?? null, warnCodes: [...(shown.warnCodes ?? [])].sort(), digest: shown.digest ?? null } : null,
    pendingHandle: path === "paid" ? pendingHandle ?? null : null,
  };
}

// ── the failure path ─────────────────────────────────────────────────────────────────────────
// Per-instance throttle state. A Netlify function instance is reused across invocations, so an
// outage alerts once per window per instance rather than once per report.
const throttle = { lastAlertAt: null, unalerted: 0 };
/** Test hook: reset the per-instance throttle. */
export function _resetAlertThrottle() { throttle.lastAlertAt = null; throttle.unalerted = 0; }

function postDdAlert(content) {
  const url = process.env.DD_WATCH_WEBHOOK; // service-integrity channel, NOT the money siren
  if (!url) return false;
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }).catch(() => {});
  return true;
}

// ⚠️ A plain timer, cleared when the write settles. An unref'd one let a hung write outlive the
// timeout entirely when nothing else held the event loop (found by verify-dd-issued §C).
function withTimeout(p, ms) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/**
 * Record one issuance. NEVER THROWS, and resolves within ~WRITE_TIMEOUT_MS whatever the store does.
 * @returns {Promise<{recorded: boolean, reason: string|null, key?: string}>}
 */
export async function recordIssued(entry, deps = {}) {
  const {
    store = () => getStore(DD_ISSUED_STORE),
    failureStore = () => getStore(DD_HEALTH_STORE),
    alert = postDdAlert,
    now = () => Date.now(),
    uuid = randomUUID,
    timeoutMs = WRITE_TIMEOUT_MS,
    log = console,
  } = deps;

  const report = entry?.report;
  if (!report || typeof report !== "object") return { recorded: false, reason: "no-report" };
  if (report.refusal) return { recorded: false, reason: "refusal-not-recorded" };

  let record, key;
  try {
    record = buildIssuedRecord(entry, { now });
    key = `${record.issuedAt}-${uuid()}`;
    await withTimeout(Promise.resolve().then(() => store().setJSON(key, record)), timeoutMs);
    return { recorded: true, reason: null, key };
  } catch (e) {
    const err = String(e?.message ?? e).slice(0, 200);
    const at = new Date(now()).toISOString();
    const subject = String(report?.subject?.address ?? "").toLowerCase() || null;
    let counted = true;
    try {
      await withTimeout(Promise.resolve().then(() =>
        failureStore().setJSON(`${FAILURE_PREFIX}${at}-${uuid()}`, { at, path: entry?.path ?? null, subject, error: err })), timeoutMs);
    } catch (e2) {
      counted = false;
      log.error(`[dd-issued] the failure COUNTER could not be written either: ${String(e2?.message ?? e2).slice(0, 200)}`);
    }

    throttle.unalerted++;
    let alerted = false, attempted = false;
    if (throttle.lastAlertAt === null || now() - throttle.lastAlertAt >= ALERT_WINDOW_MS) {
      attempted = true;
      const n = throttle.unalerted;
      alerted = alert(
        `⚠️ **[dd-issued]** RECORD WRITE FAILED — ${n} DD report(s) were served with NO issued-report record\n` +
        `latest: path \`${entry?.path}\` · subject \`${subject}\` · ${at}\n` +
        `The reports were served; what they said is not recorded. ` +
        (counted ? `Each failure is counted under \`${FAILURE_PREFIX}\` in \`${DD_HEALTH_STORE}\`.` : `⛔ The failure counter could not be written either — this alert and the log are the only record.`) +
        `\nError: \`${err}\``,
      );
      throttle.lastAlertAt = now();
      throttle.unalerted = 0;
    }
    log.error(`[dd-issued] record write FAILED (served anyway): ${JSON.stringify({ path: entry?.path ?? null, subject, at, err, counted,
      alert: alerted ? "sent" : attempted ? "DD_WATCH_WEBHOOK unset — this reached NOBODY" : "throttled" })}`);
    return { recorded: false, reason: "write-failed", counted };
  }
}
