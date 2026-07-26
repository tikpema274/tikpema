// health.mjs — is the DD service KNOWN GOOD right now? Pure, no I/O, no clock of its own.
//
// ═══ ⭐ THE MECHANISM: A DEAD-MAN'S SWITCH, INVERTED ══════════════════════════════════════════
// The canary only ever writes PASS. It NEVER needs to write "unhealthy" for the service to stop,
// because the service requires a POSITIVE, FRESH, VERSION-MATCHED assertion of health in order to
// serve at all. Absence, staleness, unreadability, malformation and version drift are therefore
// INDISTINGUISHABLE FROM FAILURE — deliberately — and every one of them refuses.
//
// That is the whole design. "No news is good news" is not a bug to be avoided here; it is
// structurally impossible, because no news IS the failure signal.
//
// It follows the rule _pause.mjs already states for the money kill-switch: "If the pause flag CANNOT
// BE READ, we treat the agent as PAUSED. A kill switch whose failure mode is 'keep spending' is not
// a kill switch." A canary whose failure mode is "keep answering" is not a canary.
//
// ⚠️ SCOPE: this guards the DD SERVICE ONLY. It has nothing to do with the vault deposit gate, does
// not import it, and is never consulted by it. `_pause.mjs` remains the money kill-switch; this is
// the correctness kill-switch for a read-only analyzer, and the two are deliberately separate
// mechanisms with separate stores — one being unavailable must not disable the other.

import { createHash } from "node:crypto";

/** Closed outcome set. Anything unrecognised is a programming error, never a new "serve" case. */
export const HEALTH_REASON = Object.freeze({
  OK: "ok",
  NO_RECORD: "no-record",
  UNREADABLE: "unreadable",
  MALFORMED: "malformed",
  NOT_PASSING: "not-passing",
  VERSION_MISMATCH: "version-mismatch",
  STALE: "stale",
});

/** How long a PASS vouches for the service. Should be ~2x the canary period so one missed run is
 *  tolerated and two are not. Deliberately short: a stale record is a refusal, and a refusal is
 *  cheap compared with answering from a detector nobody has checked recently. */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/**
 * Anti-amplification: how recently a run must have happened for an invocation to be a cheap no-op.
 *
 * ⚠️ THE ORDERING INVARIANT IS LOAD-BEARING: MIN_RERUN_MS < cron period < DEFAULT_TTL_MS.
 *   · If MIN_RERUN_MS ever reached the cron period, the SCHEDULED run would dedupe itself, the
 *     artifact would stop refreshing, and the service would eventually refuse on staleness. Dedupe
 *     starving the refresh is the failure mode to design against.
 *   · If it reached the TTL, a stale artifact could coast — the exact thing the canary exists to
 *     prevent.
 * Asserted by the acceptance test against the real netlify.toml schedule, not left to comment.
 */
export const MIN_RERUN_MS = 5 * 60 * 1000;

/**
 * Should this invocation SKIP the fixture sweep and reuse the existing artifact?
 *
 * ⭐ DELIBERATELY INDEPENDENT OF THE VERDICT. Reusing evaluateHealth here would be a bug: it reports
 * serve:false for a FAILING record, so a failing service would re-sweep on every single hit —
 * amplification precisely when the system is already broken, which is when an attacker would hammer
 * it. Dedupe asks only "did a run for THIS build happen recently", never "was it good".
 *
 * Also deliberately not bypassable: there is no force flag, because a force flag would re-open both
 * the amplification vector and the request-input-to-behaviour channel that this endpoint does not
 * otherwise have. The operator's force mechanism is a DEPLOY, which changes the code identity and
 * invalidates the artifact.
 */
export function shouldSkipRerun(record, { now, expect, minRerunMs = MIN_RERUN_MS, readable = true }) {
  if (readable !== true) return { skip: false, reason: "store-unreadable" };
  if (!record || typeof record !== "object" || Array.isArray(record)) return { skip: false, reason: "no-record" };
  const { producedAt, identity } = record;
  if (typeof producedAt !== "string" || !identity || typeof identity !== "object") return { skip: false, reason: "malformed" };
  // A record for a different build says nothing about this one — never dedupe across builds.
  if (["schemaVersion", "catalogueFingerprint", "build"].some((k) => identity[k] !== expect[k])) {
    return { skip: false, reason: "version-mismatch" };
  }
  const at = Date.parse(producedAt);
  if (!Number.isFinite(at)) return { skip: false, reason: "malformed" };
  const ageMs = now - at;
  if (ageMs < 0 || ageMs > minRerunMs) return { skip: false, reason: ageMs < 0 ? "future-dated" : "older-than-window" };
  return { skip: true, reason: "recent-run", ageMs };
}

/**
 * Identity of the CODE this record vouches for. A health record from an older deploy must never
 * vouch for new code — the same reasoning as pass 2's six-part cache key: an artifact is a function
 * of the inputs AND of how it was produced.
 */
export function codeIdentity({ schemaVersion, powerSigs, build = null }) {
  const catalogue = Object.entries(powerSigs)
    .map(([group, sigs]) => `${group}:${[...sigs].sort().join(",")}`)
    .sort()
    .join("|");
  return {
    schemaVersion,
    catalogueFingerprint: createHash("sha256").update(catalogue).digest("hex").slice(0, 16),
    build: build ?? process.env.COMMIT_REF ?? process.env.BUILD_ID ?? "unknown",
  };
}

/**
 * Decide whether the service may serve. FAIL CLOSED on every path: `serve` starts false and is only
 * ever set true by the final, fully-satisfied case.
 *
 * @param {{record: object|null, readable: boolean, now: number, expect: object, ttlMs?: number}} input
 * @returns {{serve: boolean, reason: string, detail: string, evidence: object}}
 */
export function evaluateHealth({ record, readable, now, expect, ttlMs = DEFAULT_TTL_MS }) {
  const no = (reason, detail, evidence = {}) => ({ serve: false, reason, detail, evidence });

  // 1 — could we even read the store? An unreadable health record is NOT a healthy one.
  if (readable !== true) {
    return no(HEALTH_REASON.UNREADABLE,
      "the health record could not be read. That is an ABSENCE of a pass, not a pass — the service refuses rather than assume it is fine.",
      { readable });
  }
  // 2 — is there a record at all? A fresh deploy has none until the canary runs. That is the deploy
  //     gate, and it costs nothing to state plainly.
  if (record === null || record === undefined) {
    return no(HEALTH_REASON.NO_RECORD,
      "no canary has vouched for this build yet. The service does not serve on the assumption that silence means health.",
      {});
  }
  if (typeof record !== "object" || Array.isArray(record)) {
    return no(HEALTH_REASON.MALFORMED, "the health record is not an object", { got: typeof record });
  }
  // 3 — is it well formed? A record we cannot interpret cannot vouch for anything.
  const { verdict, producedAt, identity } = record;
  if (typeof verdict !== "string" || typeof producedAt !== "string" || !identity || typeof identity !== "object") {
    return no(HEALTH_REASON.MALFORMED,
      "the health record is missing verdict / producedAt / identity, so it cannot be interpreted",
      { hasVerdict: typeof verdict, hasProducedAt: typeof producedAt, hasIdentity: !!identity });
  }
  // 4 — does it vouch for THIS code? An older build's pass says nothing about the running one.
  const mismatched = ["schemaVersion", "catalogueFingerprint", "build"].filter((k) => identity[k] !== expect[k]);
  if (mismatched.length) {
    return no(HEALTH_REASON.VERSION_MISMATCH,
      `the health record vouches for a different build (${mismatched.join(", ")} differ), so it does not vouch for the code now running`,
      { mismatched, recorded: identity, running: expect });
  }
  // 5 — did it actually pass? Only the exact string "pass" counts; anything else, including an
  //     unrecognised verdict, refuses. A typo must never widen what the service will do.
  if (verdict !== "pass") {
    return no(HEALTH_REASON.NOT_PASSING,
      `the last canary run did not pass (verdict: ${JSON.stringify(verdict)}). A detector that fails its own fixtures must not answer questions about anyone else's contracts.`,
      { verdict, failures: (record.fixtures ?? []).filter((f) => !f.ok).map((f) => f.id) });
  }
  // 6 — is it recent enough to still mean anything?
  const at = Date.parse(producedAt);
  if (!Number.isFinite(at)) {
    return no(HEALTH_REASON.MALFORMED, `producedAt is not a parseable timestamp: ${JSON.stringify(producedAt)}`, {});
  }
  const ageMs = now - at;
  if (ageMs > ttlMs || ageMs < -60_000) {
    return no(HEALTH_REASON.STALE,
      ageMs < 0
        ? "the health record is dated in the future, which means a clock or a forged record — either way it is not trustworthy"
        : `the last passing canary is ${Math.round(ageMs / 60000)} minutes old (limit ${Math.round(ttlMs / 60000)}). The canary has stopped reporting, which is treated as failure, not as quiet success.`,
      { ageMs, ttlMs });
  }

  return {
    serve: true,
    reason: HEALTH_REASON.OK,
    detail: "a canary run for this exact build passed within the freshness window",
    evidence: { producedAt, ageMs, fixtures: (record.fixtures ?? []).length, live: record.live?.status ?? "not-run" },
  };
}
