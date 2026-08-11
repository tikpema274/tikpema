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
// ⭐ ONE derivation, imported — not re-implemented here. Independent computation is how the two
// handlers drift apart, which is the whole reason codeIdentityForEvent exists.
import { ddCodeIdentity } from "../build-stamp.mjs";

/** Closed outcome set. Anything unrecognised is a programming error, never a new "serve" case. */
export const HEALTH_REASON = Object.freeze({
  OK: "ok",
  NO_RECORD: "no-record",
  UNREADABLE: "unreadable",
  MALFORMED: "malformed",
  NOT_PASSING: "not-passing",
  VERSION_MISMATCH: "version-mismatch",
  STALE: "stale",
  BUILD_UNRESOLVED: "build-unresolved",
});

// ═══ 🚨 THE `"unknown"` FAIL-OPEN THIS REPLACES — KEEP THE REASONING ══════════════════════════
// `build` used to fall back to the literal string `"unknown"`:
//
//     build: build ?? process.env.COMMIT_REF ?? process.env.BUILD_ID ?? "unknown"
//
// When the build id could not be resolved, BOTH the canary and the endpoint stamped `"unknown"` —
// and `"unknown" === "unknown"` MATCHES. So the version binding did not fail closed, it silently
// became a no-op: an OLD deploy's passing artifact satisfied a NEW deploy's gate, because the only
// field that distinguishes deploys had collapsed to a constant. The deploy gate — the thing that is
// supposed to make shipping new code invalidate the old vouch — stops existing, and nothing says so.
//
// ⚠️ It also went undetected because every offline suite ran in one process with one env, where the
// two sides are trivially identical. **A binding can only be tested across the thing it binds**, and
// nothing exercised build resolution across two different builds. That gap is the real defect;
// `"unknown"` was just how it showed up.
//
// The rule now: an UNRESOLVED build is not a value, it is the ABSENCE of one, and an absence must
// never satisfy a check. `null` is not compared — it REFUSES, before any comparison happens.
// (Same family as [[absence-must-never-read-as-safe]]: the failure was an absence filling the
// result slot and reading as agreement.)

/**
 * Where a build identifier may come from, in order. Extended beyond the original two because a
 * Netlify CLI manual deploy (`netlify deploy --dir=dist`) does NOT run the build pipeline, so the
 * build-time variables are simply absent — which is exactly the deploy type used to test this
 * service, and exactly where an always-"unknown" binding hid.
 *
 * `DD_BUILD_ID` is first so an operator can always pin one explicitly when the platform gives none.
 */
export const BUILD_ID_SOURCES = Object.freeze(["DD_BUILD_ID", "COMMIT_REF", "DEPLOY_ID", "BUILD_ID"]);

/**
 * Resolve the build identifier, or say plainly that it could not be resolved.
 *
 * ⭐ NEVER returns a placeholder. There is no sentinel value, because a sentinel is precisely what
 * broke this: any constant returned on failure will compare equal to itself on the other side.
 * The literal string "unknown" is also REJECTED as an env value, so the old fail-open cannot be
 * reintroduced by setting a variable to it.
 *
 * @returns {{resolved: boolean, id: string|null, source: string|null, detail: string}}
 */
/**
 * ═══ 🚨 THE ONLY PLACE A DEPLOY ID IS DERIVED ════════════════════════════════════════════════
 * `resolveBuildId` reads env ONLY, and on this project NOTHING resolves in production: a CLI
 * deploy runs no build, so COMMIT_REF / BUILD_ID / DEPLOY_ID are never injected. MEASURED from a
 * real scheduled invocation 2026-07-30 — all four env sources came back ABSENT, while the request
 * carried `x-nf-deploy-id` equal to the published deploy id. So the canary refused at rung 0 and
 * wrote nothing for days, which would have made dd-analyze refuse EVERYTHING the moment
 * DD_PUBLIC_ENABLED was set.
 *
 * ⚠️ `netlify env:get` CANNOT be used to check this — it synthesises COMMIT_REF from the local git
 * HEAD and reports DEPLOY_ID/BUILD_ID as "0". Only the running function can say.
 *
 * 🚨 SUPERSEDED 2026-08-11 — THE DEPLOY ID IS NO LONGER THE BINDING. The paragraph that stood here
 * argued it was "the right binding, not merely the available one, because it changes on EVERY
 * deploy". That reasoning was WRONG IN ITS PREMISE: changing on every deploy is the DEFECT, not the
 * virtue. "Distinguishing deploys" was never the job — distinguishing CODE is. A deploy id answers
 * "which deployment event", and two deploys of byte-identical DD code genuinely deserve one verdict.
 *
 * ⭐ MEASURED: over the last 40 commits, 20 touched the stamped surface and only 2 touched DD —
 * **18 were stamp-dirty but DD-CLEAN.** Under deploy-id binding each of those 18 rotated the health
 * key and refused the service for up to the cron period, on deploys the canary's verdict says
 * nothing about. Once DD went public that became an outage caused by unrelated work.
 *
 * The binding is now `ddCodeIdentity()` (shared/build-stamp.mjs): a content hash of the DD surface.
 * COMMIT_REF was correctly rejected above for being identical across deploys of the same commit —
 * but a CONTENT hash is not the same thing: it changes when the bytes change, including uncommitted
 * edits, which is precisely the property wanted.
 *
 * ⚠️ `deployIdFromEvent` is KEPT and still derived here — recorded on the identity for DIAGNOSIS
 * only, never compared. An operator can still see which deploy wrote a record.
 *
 * 🚨 WHY THIS LIVES IN ONE FUNCTION. dd-canary (CRON) writes the artifact and dd-analyze (HTTP)
 * reads it, in different runtimes. If they derived the id even slightly differently the keys would
 * never match and the gate would refuse forever — or worse, match for the wrong reason. That is
 * exactly how the binding was a silent no-op before 1dd8f75, when both sides independently fell
 * back to the literal "unknown" and `"unknown" === "unknown"` MATCHED. A binding can only be
 * tested across the thing it binds, so BOTH sides must call THIS, and nothing else.
 *
 * ⚠️ SHAPE-VALIDATED, and refusing is the safe direction: an unrecognised value returns null,
 * `buildIsBound` goes false, the canary writes nothing and the service refuses. Binding to a
 * garbage id would be worse — it would look bound while vouching for nothing.
 */
export const DEPLOY_ID_HEADER = "x-nf-deploy-id";
const DEPLOY_ID_RE = /^[a-f0-9]{24}$/i;

/** @returns {string|null} the deploy id, or null when it cannot be read — never a placeholder. */
export function deployIdFromEvent(event) {
  const h = event?.headers;
  if (!h || typeof h !== "object") return null;
  const key = Object.keys(h).find((k) => k.toLowerCase() === DEPLOY_ID_HEADER);
  if (key === undefined) return null;
  const v = h[key] === undefined || h[key] === null ? "" : String(h[key]).trim();
  return DEPLOY_ID_RE.test(v) ? v.toLowerCase() : null;
}

/**
 * THE call both handlers make. Takes the request/invocation event so the deploy id is derived
 * identically on the cron side and the HTTP side. Falls through to resolveBuildId's env sources
 * when no header is present, so a git-triggered build still works.
 */
export function codeIdentityForEvent(event, { schemaVersion, powerSigs, env = process.env }) {
  // ⚠️ THE DEPLOY ID IS NO LONGER THE IDENTITY — it is recorded for DIAGNOSIS ONLY and is never
  // compared. evaluateHealth/shouldSkipRerun compare exactly {schemaVersion, catalogueFingerprint,
  // build}, so an extra field cannot cause a mismatch. Keeping it means an operator can still see
  // WHICH DEPLOY wrote a record without the identity being a property of the deployment event.
  const identity = codeIdentity({ schemaVersion, powerSigs, env });
  const deployId = deployIdFromEvent(event);
  return deployId === null ? identity : { ...identity, deployId };
}

export function resolveBuildId({ build = null, env = process.env } = {}) {
  const usable = (v) =>
    typeof v === "string" && v.trim() !== "" && v.trim().toLowerCase() !== "unknown";

  if (usable(build)) {
    return { resolved: true, id: String(build).trim(), source: "explicit", detail: "build id supplied explicitly" };
  }
  for (const key of BUILD_ID_SOURCES) {
    const v = env?.[key];
    if (usable(v)) {
      return { resolved: true, id: String(v).trim(), source: key, detail: `build id resolved from ${key}` };
    }
  }
  return {
    resolved: false,
    id: null,
    source: null,
    detail:
      `no build identifier could be resolved (checked ${BUILD_ID_SOURCES.join(", ")}). The version ` +
      `binding cannot distinguish this deploy from any other, so the health record cannot be trusted ` +
      `to vouch for THIS code. Set DD_BUILD_ID on the deploy to fix it. Refusing is deliberate: the ` +
      `previous behaviour substituted "unknown" here, which made every deploy look identical to every ` +
      `other and silently disabled the deploy gate.`,
  };
}

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
  // ⭐ Same rule as evaluateHealth step 0, for the same reason. Without a build id, "did a run for
  //    THIS build happen recently" is unanswerable — every build looks like every other — so the
  //    honest answer is "do not dedupe", i.e. re-sweep. Erring toward doing the work is the safe
  //    direction here; erring toward skipping would let one stale artifact suppress all future runs.
  if (!buildIsBound(expect)) return { skip: false, reason: "build-unresolved" };
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
export function codeIdentity({ schemaVersion, powerSigs, build = null, env = process.env, stamp = undefined }) {
  const catalogue = Object.entries(powerSigs)
    .map(([group, sigs]) => `${group}:${[...sigs].sort().join(",")}`)
    .sort()
    .join("|");

  // ⭐⭐ THE IDENTITY IS NOW A CONTENT HASH OF THE DD SURFACE, not the deploy id.
  //
  // An explicit `build` still wins — it is how the suites inject an identity — but there is NO
  // fallback chain behind the stamp any more. Previously an unresolved id fell through to
  // DD_BUILD_ID → COMMIT_REF → DEPLOY_ID → BUILD_ID; that made the key a property of the DEPLOYMENT
  // EVENT, so every unrelated deploy rotated it and the service refused for up to the cron period.
  // Measured: 18 of the last 20 stamp-dirty commits changed no DD code at all.
  //
  // 🚨 UNAVAILABLE ⇒ UNBOUND, never the deploy id and never a constant. Both sides derive through
  // THIS function (codeIdentityForEvent → codeIdentity), which is what stops the two handlers
  // drifting apart — the same rule that b9de582 exists to prove.
  const b = usableExplicit(build)
    ? { resolved: true, id: String(build).trim(), source: "explicit", detail: "identity supplied explicitly" }
    : ddCodeIdentity(stamp === undefined ? undefined : stamp);

  return {
    schemaVersion,
    catalogueFingerprint: createHash("sha256").update(catalogue).digest("hex").slice(0, 16),
    // ⭐ null, NOT a placeholder. Consumers must refuse on null rather than compare it.
    build: b.id,
    buildResolved: b.resolved,
    buildSource: b.source,
    buildDetail: b.detail,
  };
}

/** An explicitly supplied identity, held to the same rejection rules as everything else. */
const usableExplicit = (v) =>
  typeof v === "string" && v.trim() !== "" && v.trim().toLowerCase() !== "unknown";

/** Is this identity usable for binding at all? Exported so callers can refuse EARLY and say why,
 *  rather than discovering it as a comparison that happens to succeed. */
export const buildIsBound = (identity) =>
  !!identity && identity.buildResolved === true && typeof identity.build === "string" && identity.build.trim() !== "";

/**
 * Decide whether the service may serve. FAIL CLOSED on every path: `serve` starts false and is only
 * ever set true by the final, fully-satisfied case.
 *
 * @param {{record: object|null, readable: boolean, now: number, expect: object, ttlMs?: number}} input
 * @returns {{serve: boolean, reason: string, detail: string, evidence: object}}
 */
/**
 * The running identity, reported so it can never be MISSING. `runningBuild` is the derived id or
 * the literal "unbound" — never absent, never a bare null, because an omitted field reads as "we
 * did not say" and a null reads as "we tried and failed", and those are different states.
 *
 * ⭐ The build comes from `expect`, which the handlers derive via codeIdentityForEvent — the SAME
 * single derivation dd-canary uses to WRITE the artifact. There is deliberately no second way to
 * obtain it here: a parallel path is exactly what 324c75c removed, and it is how the binding became
 * a no-op the first time.
 */
const runningEvidence = (expect) => ({
  running: expect ?? null,
  runningBuild: expect?.build ?? "unbound",
});

export function evaluateHealth({ record, readable, now, expect, ttlMs = DEFAULT_TTL_MS }) {
  const no = (reason, detail, evidence = {}) => ({ serve: false, reason, detail, evidence });

  // 0 — ⭐ IS THE BINDING EVEN MEANINGFUL? Checked FIRST, before the record is looked at, because a
  //     comparison against an unresolved build is not a weak check — it is a check that always
  //     passes, and one that always passes must never run. `null === null` would MATCH.
  //
  //     This refuses even when a perfectly good, freshly-written PASS is sitting in the store. That
  //     is correct and intended: without a build id we cannot tell whether that pass is about THIS
  //     code or about something deployed weeks ago. "Probably fine" is not what this gate answers.
  if (!buildIsBound(expect)) {
    return no(HEALTH_REASON.BUILD_UNRESOLVED,
      `the running code has no resolvable build identifier, so no health record can be shown to vouch for it. ${expect?.buildDetail ?? ""}`.trim(),
      // Uses the SAME runningEvidence helper, so `runningBuild` is present here too — reporting
      // the literal "unbound" rather than omitting the field. This is the branch where an
      // unresolvable build actually surfaces, so it is the one that must say so out loud.
      { ...runningEvidence(expect), buildSources: BUILD_ID_SOURCES });
  }

  // 1 — could we even read the store? An unreadable health record is NOT a healthy one.
  if (readable !== true) {
    return no(HEALTH_REASON.UNREADABLE,
      "the health record could not be read. That is an ABSENCE of a pass, not a pass — the service refuses rather than assume it is fine.",
      { readable });
  }
  // 2 — is there a record at all? A fresh deploy has none until the canary runs. That is the deploy
  //     gate, and it costs nothing to state plainly.
  if (record === null || record === undefined) {
    // ⭐ NO-RECORD IS THE COMMONEST REFUSAL THIS SERVICE WILL EVER EMIT. Deploy-id binding
    // guarantees it on EVERY deploy: between publishing and the canary's first run there is by
    // construction no artifact for the new build id. version-mismatch, by contrast, is rare. The
    // evidence used to be `{}` — richest where it fires least, EMPTY WHERE IT FIRES MOST — so a
    // caller hitting it learned nothing and could not distinguish "this deploy's canary has not run
    // yet" from "the service is broken".
    //
    // ⚠️ DIAGNOSTIC ONLY. This adds evidence to an ALREADY-DECIDED refusal. The verdict, the reason
    // and the detail are untouched; nothing here can widen what the service will do.
    //
    // ⚠️ THE RUNNING BUILD IS REPORTED, NEVER OMITTED. `runningBuild` is always present — the id, or
    // the literal "unbound". Omitting it on failure would make "we could not derive a build" look
    // identical to "we did not bother to say", which is the absence-reads-as-safe shape.
    //
    // ⚠️ AND ABSENT-BECAUSE-NOTHING-RECORDED IS SAID EXPLICITLY, not encoded as an empty or null
    // `recorded` field. Nothing-was-written and we-could-not-read-it are different states with
    // different fixes; `recorded: null` would collapse them.
    return no(HEALTH_REASON.NO_RECORD,
      "no canary has vouched for this build yet. The service does not serve on the assumption that silence means health.",
      {
        ...runningEvidence(expect),
        recordedNote:
          "none — no health artifact exists for this build id, so there is nothing to compare against. " +
          "This is the EXPECTED state between publishing a deploy and its first canary run, not a fault.",
      });
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
