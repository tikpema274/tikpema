// vouched.mjs — WHAT DID THE CANARY ACTUALLY VOUCH FOR? Pure, no I/O, no clock of its own.
//
// ═══ ⭐⭐ THIS READS THE HEALTH RECORD. IT IS NOT A SECOND READING OF THE BUILD STAMP ══════════
//
// There were two ways to give production a readable `ddTree`, and only one of them is worth
// building:
//
//   (a) project `ddTree` onto an existing probe. Cheapest, and it CORROBORATES NOTHING — it reads
//       the SAME baked-in stamp from a second place and returns agreement with itself. Repeating
//       one instrument is not corroboration.
//   (b) report what the CANARY vouched for — a value that lives in a record written by a different
//       process, at a different time, into a different store.
//
// This is (b), and the discipline that keeps it (b) is one rule:
//
//   🚨 THE ANSWER IS READ OUT OF THE RECORD'S PAYLOAD, NEVER DERIVED FROM THE STAMP.
//
// `vouchedBuild` reports `record.identity.build` — the string the canary WROTE — and never
// substitutes the running ddTree for it, not even when the record is found under a key derived from
// that ddTree. If those two disagree, the disagreement is the finding, and smoothing it over would
// turn this file back into (a) wearing (b)'s name.
//
// ⚠️ AND THE PROVENANCE IS IN THE RESPONSE, NOT ONLY IN THIS COMMENT. Every value carries a
// `source` naming where it came from, because a reader holding the JSON is who has to know which
// instrument answered.
//
// ═══ ⚠️ WHAT AGREEMENT IS WORTH HERE, STATED SO NOBODY OVER-READS IT ══════════════════════════
// The record is looked up by `healthKey(identity)`, which CONTAINS the running build. So a record
// that is found will normally name that same build — agreement is a property of the lookup, not
// independent confirmation. ⭐ What this endpoint actually adds is not the ddTree value at all:
//
//     whether a canary vouched for the running code AT ALL, WHEN it did, and with WHAT verdict.
//
// None of those three is derivable from the stamp. That is the bigger question, and it is the
// reason to build this rather than (a). DISAGREEMENT is the strong signal; agreement is weak.
//
// ═══ ⛔ AND `vouched` IS NOT A HEALTH TICK ════════════════════════════════════════════════════
// `outcome: "vouched"` means a record exists that names a build. It does NOT mean the service is
// serving: a FAILING record and a STALE record both name a build. The serve/refuse decision belongs
// to `evaluateHealth` and is deliberately not re-derived here — a second implementation of that
// verdict is a duplicate source of truth, and this codebase has paid for those. The raw `verdict`
// and `ageMs` are reported so a reader can see the inputs; the decision is not.

// ═══ ⛔⛔ WHY THIS LIVES OUTSIDE `shared/dd-canary/` — IT MUST NOT BE IN ddTree ════════════════
// `shared/dd-canary/` is a DD_SURFACE_DIR, so a file placed there is hashed into `ddTree` and every
// edit to it ROTATES THE HEALTH KEY. Rotation is not free: between the rotation and the next canary
// tick the DD service refuses, and since step 2 that refusal BLOCKS VAULT DEPOSITS. That cost is
// worth paying for code whose change could make the canary's verdict wrong.
//
// ⭐ THIS FILE IS NOT SUCH CODE. It reads a record and reports it. Neither dd-analyze nor dd-canary
// imports it, and no change here can alter what the canary detects, what it vouches for, or whether
// a buyer is charged. Binding an OBSERVER to the identity of the thing it observes would buy no
// safety and would spend a real deposit outage on every future edit to an observability endpoint —
// the same "stamp-dirty but DD-clean" cost that moved this binding off the deploy id, inverted.
//
// 🚨 THIS IS A DECISION, AND IT IS ASSERTED RATHER THAN COMMENTED: scripts/dd/verify-vouched-build.mjs
// fails if this module ever lands inside the DD surface. Moving it back is allowed — but it has to be
// done deliberately, with the deposit cost in view.

import { ddCodeIdentity } from "../build-stamp.mjs";
import { DEFAULT_TTL_MS } from "../dd-canary/health.mjs";

/**
 * ⛔ THREE OUTCOMES, AND THE FIRST TWO ARE THE ONES THAT GET CONFUSED.
 *
 * `none` is the honest, EXPECTED state between a DD-surface rotation and the next canary tick. It
 * is not an error and it is not an unreadable store. Collapsing it into either would recreate the
 * failure this whole thread exists to prevent: an absence filling the result slot and reading as
 * something it is not — as a tick if smoothed toward `vouched`, as a fault if smoothed toward
 * `unreadable`.
 */
export const VOUCH_OUTCOME = Object.freeze({
  VOUCHED: "vouched",
  NONE: "none",
  UNREADABLE: "unreadable",
});

/**
 * ⚠️ `unreadable` IS THE "WE CANNOT TELL YOU" BUCKET, AND IT HAS THREE CAUSES — only one of which
 * is the store failing. They are reported separately because they have different fixes, and because
 * a single `unreadable` with no cause is the same shape as the `"unknown"` sentinel that made the
 * version binding a no-op: one label standing in for distinct states.
 *
 *   store-error       the store was asked and did not answer.
 *   build-unbound     ⭐ the store was NEVER ASKED — with no ddTree there is no key to look up.
 *                     This is emphatically NOT `none`: `none` means we looked and found nothing,
 *                     and claiming that here would assert a fact about a store we never touched.
 *   record-malformed  the store answered with something that names no build. A record exists, so
 *                     `none` would misdescribe the store's contents.
 */
export const UNREADABLE_CAUSE = Object.freeze({
  STORE_ERROR: "store-error",
  BUILD_UNBOUND: "build-unbound",
  RECORD_MALFORMED: "record-malformed",
});

const HEX64 = /^[0-9a-f]{64}$/;

/** A build id read off a record. ⭐ Held to the SAME rejection rules as the stamp side: a record
 *  whose build is "" or "unknown" names nothing, and must not be reported as if it named something. */
const usableBuild = (v) => {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  return t === "" || t === "unknown" || t === "null" || t === "undefined" ? null : t;
};

/**
 * @param {{record: object|null, readable: boolean, now: number,
 *          running?: {resolved:boolean,id:string|null,source:string|null,detail:string},
 *          storeError?: string|null, ttlMs?: number}} input
 */
export function vouchedBuild({
  record,
  readable,
  now,
  running = ddCodeIdentity(),
  storeError = null,
  ttlMs = DEFAULT_TTL_MS,
}) {
  // The running side is reported in EVERY outcome, never omitted — an absent field reads as "we did
  // not say" and a null reads as "we tried and failed", and those are different states.
  const stamp = {
    ddTree: running?.resolved === true ? running.id : null,
    source: running?.resolved === true ? (running.source ?? "build-stamp:ddTree") : null,
    resolved: running?.resolved === true,
    detail: running?.detail ?? "no running identity was supplied",
  };

  const out = (outcome, extra) => ({
    outcome,
    vouched: null,
    stamp,
    ...extra,
  });

  // 0 — ⭐ COULD WE EVEN ASK? No ddTree means no key. Checked before the record, because a record
  //     passed in alongside an unbound build cannot be shown to be about this code.
  if (!stamp.resolved) {
    return out(VOUCH_OUTCOME.UNREADABLE, {
      cause: UNREADABLE_CAUSE.BUILD_UNBOUND,
      detail:
        "this artifact carries no usable ddTree, so there is no health key to look up and the store " +
        "was never asked. This is NOT `none`: nothing was searched, so nothing can be said to be absent.",
      comparison: notComparable("the running build is unbound, so there is nothing to compare a record against"),
      remedy:
        "run `npm run build` (which runs scripts/stamp-build.mjs) and redeploy — the DD identity is a " +
        "content hash of the DD surface baked in at build time.",
    });
  }

  // 1 — did the store answer? An unreadable store is not an absent record.
  if (readable !== true) {
    return out(VOUCH_OUTCOME.UNREADABLE, {
      cause: UNREADABLE_CAUSE.STORE_ERROR,
      detail:
        "the health store did not answer, so we cannot say what the canary vouched for. That is an " +
        "ABSENCE OF AN ANSWER, not an absence of a record — the two have different fixes.",
      ...(storeError ? { storeError } : {}),
      comparison: notComparable("the store did not answer, so no vouched build was obtained"),
    });
  }

  // 2 — ⭐ THE EXPECTED STATE AFTER A ROTATION. Said in those words so it cannot read as a fault.
  if (record === null || record === undefined) {
    return out(VOUCH_OUTCOME.NONE, {
      detail:
        "no health record exists for the running build. The store was read and holds nothing under " +
        "this build's key. ⭐ This is the EXPECTED state between a DD-surface change and the next " +
        "canary tick, and it is neither an error nor a failing canary — during it, dd-analyze " +
        "refuses with `no-record` by design.",
      comparison: notComparable("no record exists for the running build, so there is no vouched build to compare"),
    });
  }
  if (typeof record !== "object" || Array.isArray(record)) {
    return out(VOUCH_OUTCOME.UNREADABLE, {
      cause: UNREADABLE_CAUSE.RECORD_MALFORMED,
      detail: `the health record is not an object (got ${Array.isArray(record) ? "array" : typeof record}), so it names no build`,
      comparison: notComparable("the record could not be interpreted, so it yielded no vouched build"),
    });
  }

  const build = usableBuild(record?.identity?.build);
  if (build === null) {
    return out(VOUCH_OUTCOME.UNREADABLE, {
      cause: UNREADABLE_CAUSE.RECORD_MALFORMED,
      detail:
        "a health record exists under this build's key but carries no usable `identity.build`, so it " +
        "names no code. It is reported as UNREADABLE rather than `none` because a record IS present — " +
        "saying `none` would misdescribe what the store holds.",
      comparison: notComparable("the record names no build"),
    });
  }

  const at = Date.parse(record.producedAt);
  const ageMs = Number.isFinite(at) ? now - at : null;

  return {
    outcome: VOUCH_OUTCOME.VOUCHED,
    vouched: {
      // 🚨 THE PAYLOAD VALUE. Not the key, not the stamp. If this differs from stamp.ddTree the
      // difference is REPORTED, because the difference is the whole reason this endpoint exists.
      build,
      source: "health-record:identity.build",
      sourceDetail:
        "read out of the stored health record the canary wrote. The lookup KEY is derived from the " +
        "running ddTree; this VALUE is not — it is whatever the canary put in the record.",
      verdict: typeof record.verdict === "string" ? record.verdict : null,
      producedAt: typeof record.producedAt === "string" ? record.producedAt : null,
      ageMs,
      ttlMs,
      // Diagnosis only — dd-canary records which deploy wrote a record, and never compares it.
      deployId: typeof record?.identity?.deployId === "string" ? record.identity.deployId : null,
    },
    stamp,
    detail:
      "a health record exists for the running build and names the code it vouches for. ⛔ This is " +
      "NOT a statement that the service is serving: a failing or stale record also names a build. " +
      "The serve/refuse decision is evaluateHealth's and is deliberately not re-derived here.",
    comparison: compare(build, stamp.ddTree),
  };
}

const notComparable = (why) => ({
  comparable: false,
  agree: null,
  verdict: "not-comparable",
  whatThisMeans: `${why}. ⚠️ Not comparable is not agreement — no claim is made about whether the canary's evidence covers the running code.`,
});

/**
 * ⭐⭐ THE POINT OF THE ENDPOINT IS THE DISAGREEMENT, SO THE CONCLUSION IS STATED HERE RATHER THAN
 * LEFT TO THE READER TO WORK OUT.
 */
function compare(vouched, ddTree) {
  if (vouched === ddTree) {
    return {
      comparable: true,
      agree: true,
      verdict: "agree",
      whatThisMeans:
        "the record names the build that is running. ⚠️ READ THIS AS WEAK EVIDENCE: the record was " +
        "looked up by a key containing the running ddTree, so a record that is found will normally " +
        "name it — agreement is largely a property of the lookup. The informative fields here are " +
        "`outcome`, `producedAt` and `verdict`, none of which the build stamp can answer.",
    };
  }
  return {
    comparable: true,
    agree: false,
    verdict: "differ",
    // ⛔ THE FAIL-OPEN THIS CLOSES, SPELLED OUT.
    whatThisMeans:
      "🚨 THE CANARY'S RECORD NAMES A DIFFERENT BUILD FROM THE ONE RUNNING. Do NOT treat this vouch " +
      "as covering the running code: a record vouches for the build it NAMES, whatever key it was " +
      "filed under. Concretely — the health evidence and the running artifact disagree about what " +
      "code this is, so any 'the canary passed' claim about this deploy is unfounded. ⚠️ THIS IS " +
      "NOT A NORMAL ROTATION: a rotation produces `none` (no record under the new key), never a " +
      "record that disagrees. A disagreeing record means a misfiled or forged write, or a key " +
      "derivation that has drifted between the writer and the reader — the exact drift the single " +
      "shared codeIdentityForEvent exists to prevent. Expect dd-analyze to refuse `version-mismatch`.",
  };
}

/**
 * ⭐⭐ THE STATUS CODE CARRIES THE DISAGREEMENT, so it is visible at the crudest level of
 * inspection there is — an operator reading a status line, a curl in a shell chain, a monitor that
 * never parses the body.
 *
 *   200  vouched + agree    a record names the running build
 *   200  none               no record for the running build — the EXPECTED post-rotation state,
 *                           and deliberately NOT an error code: nothing failed.
 *   409  vouched + differ   🚨 the record names DIFFERENT code from what is running
 *   503  unreadable         we cannot tell you (store error / unbound build / malformed record)
 *
 * ⚠️ The BODY is authoritative and the status mirrors it, never the other way round. A reader who
 * only sees 200 has still not been told whether a canary vouched — that is `outcome`.
 */
export const httpStatusFor = (v) => {
  if (v.outcome === VOUCH_OUTCOME.UNREADABLE) return 503;
  if (v.outcome === VOUCH_OUTCOME.NONE) return 200;
  return v.comparison?.agree === false ? 409 : 200;
};
