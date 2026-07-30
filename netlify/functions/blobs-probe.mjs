import { connectLambda, getStore } from "@netlify/blobs";
import { connectBlobs, strongReadAvailable } from "./_blobs.mjs";
import { buildStamp } from "../../shared/build-stamp.mjs";

// GET /.netlify/functions/blobs-probe — CAN THE DEPLOYED BUILD DO A STRONG BLOBS READ?
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════════════════════
// On 2026-07-29 prod served a build whose three safety reads were degraded to `eventual` for
// 7.5 hours while the repo, twelve green suites and a passing live pause-toggle all indicated
// Option D was live. Nothing in the loop could have caught it:
//
//   · the suites run in-process against the WORKING TREE, so they cannot see the deployed build;
//   · the live pause test passes on BOTH builds — an eventual read still blocks correctly
//     whenever the flag happens to be readable and fresh, so it never discriminated;
//   · Netlify records commit_ref:null on CLI deploys, so the platform cannot say what shipped.
//
// This endpoint is the missing discriminator: it asks the DEPLOYED ARTIFACT, over the real URL,
// whether a strong read actually works — by doing one.
//
// ═══ THE NEGATIVE CONTROL IS BUILT IN, AND THAT IS THE WHOLE POINT ═══════════════════════════
// "A probe that has only ever returned ok is uncalibrated." The obvious calibration — deploy the
// probe onto a hotfix-tree draft — is NOT CONSTRUCTIBLE: `connectBlobs` was ADDED by the fix
// (bdc830f), so on the hotfix tree the probe's own mechanism does not exist and you would be
// deploying a different probe. And prod-as-negative-control disappears the moment D publishes.
//
// So the control is carried INSIDE every invocation, and it never expires:
//
//   ARM A   connectLambda(event) alone, then a strong read   -> MUST THROW   (negative control)
//   ARM B   connectBlobs(event),  then a strong read         -> ok under D   (positive control)
//   ARM A2  connectLambda(event) again, then a strong read   -> MUST THROW   (isolation check)
//
// Arm A is not a simulation of the hotfix — it IS the hotfix's connect path, the same
// `connectLambda` call the pre-fix handlers made, in the same process on the same request. If
// arm A ever returns ok, the probe cannot tell the two builds apart and reports UNCALIBRATED
// rather than a verdict. Arm A2 exists because arm B MUTATES the environment: it runs after B
// and must still throw, proving A's result was not contaminated by a warm container.
//
//   ⭐ Arm A is self-resetting by construction, verified against the installed package rather
//   than assumed: connectLambda (@netlify/blobs@10.7.9 main.js:16-26) builds a FOUR-field context
//   {deployID, edgeURL, siteID, token} and hands it to setEnvironmentContext, which OVERWRITES
//   NETLIFY_BLOBS_CONTEXT wholesale (chunk-YAGWSQMB.js:15-18). Every arm-A call therefore
//   restores the unrepaired state. Arm A2 asserts that rather than trusting it.
//
// The throw is raised in getFinalRequest BEFORE any network call (chunk-YAGWSQMB.js:224), so the
// negative arms cost nothing and a nonexistent key still discriminates.
//
// ═══ SAFETY ══════════════════════════════════════════════════════════════════════════════════
// · GET only. One read of a key that does not exist. No write, no money path, no auth surface.
// · Reads the REAL store the kill switch reads (agent-pause), not a private one — a probe against
//   its own store proves the probe's store works, which is not the question.
// · NEVER returns raw error text, `event.blobs`, or any environment value. `event.blobs` carries
//   the Blobs ACCESS TOKEN. Errors are mapped to a CLOSED SET of outcome codes and the error's
//   class name; anything unrecognised becomes "other-error" rather than being echoed.

/** The store the kill switch reads. Deliberately the real one.
 *  ⚠️ This literal is a SECOND COPY of PAUSE_STORE in _pause.mjs, which is not exported. Copies
 *  drift — so scripts/verify-blobs-probe.mjs reads both files and fails if they ever disagree.
 *  The copy is preferred over exporting from _pause.mjs so this probe imports NOTHING from the
 *  money path and cannot be blamed for a money-path bundle change. */
export const PROBE_STORE = "agent-pause";

/** A key that cannot collide with a real flag: pause keys are `pause:<owner>:<agent>`. Never
 *  written — only read, and expected to be absent. */
export const PROBE_KEY = "__strong-read-probe__";

/**
 * WHICH DEPLOY IS ANSWERING? Needed so a monitor can quote a ROLLBACK TARGET instead of hardcoding
 * one — see shared/strong-read-watch/watch.mjs.
 *
 * ⭐ DELIBERATELY NOT PART OF THE BUILD STAMP. The stamp is generated at BUILD time and cannot know
 * which deploy it lands in; the deploy id is a RUNTIME fact. Folding them together would let a
 * stale stamp appear to name a live deploy.
 *
 * ⭐ THE HEADER IS THE SOURCE, NOT `DEPLOY_ID`. A CLI deploy runs no build, so build-time env vars
 * are absent — the same reason commit_ref is null on every deploy this project makes. The header is
 * what `connectLambda` itself reads (@netlify/blobs main.js:20), so it is present wherever Blobs
 * works at all. `DEPLOY_ID` is kept only as a second source for a git-triggered build.
 *
 * ⚠️ SHAPE-VALIDATED, because this value becomes a ROLLBACK INSTRUCTION. A Netlify deploy id is 24
 * hex characters. Anything else resolves to null rather than being passed along — quoting garbage
 * as a rollback target is worse than admitting we do not know.
 */
export const DEPLOY_ID_SOURCES = Object.freeze(["x-nf-deploy-id", "DEPLOY_ID"]);

export function resolveDeployId({ event, env = process.env } = {}) {
  const headers = event?.headers || {};
  // Netlify lowercases header keys, but do not rely on it.
  const hdr = Object.keys(headers).find((k) => k.toLowerCase() === "x-nf-deploy-id");
  const candidates = [
    ["x-nf-deploy-id", hdr ? headers[hdr] : undefined],
    ["DEPLOY_ID", env?.DEPLOY_ID],
  ];
  for (const [source, raw] of candidates) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (/^[a-f0-9]{24}$/i.test(v)) {
      return { resolved: true, id: v.toLowerCase(), source, detail: `deploy id resolved from ${source}` };
    }
  }
  return {
    resolved: false, id: null, source: null,
    detail:
      `no deploy id could be resolved (checked ${DEPLOY_ID_SOURCES.join(", ")}). Reported as ` +
      `UNRESOLVED rather than guessed: a wrong id here would become a wrong rollback instruction.`,
  };
}

/** CLOSED SET. An unrecognised failure must land in `other-error`, never widen into "ok" and
 *  never leak its message. */
export const OUTCOME = Object.freeze({
  OK: "ok",
  CONSISTENCY: "consistency-error",
  MISSING_ENV: "missing-environment",
  OTHER: "other-error",
});

/** Map a thrown value to the closed set. Matches on the error CLASS first and falls back to the
 *  library's fixed message text, so a future rename of either one still classifies. */
export function classifyError(err) {
  const name = typeof err?.name === "string" ? err.name : "";
  const msg = typeof err?.message === "string" ? err.message : "";
  if (name === "BlobsConsistencyError" || msg.includes("uncachedEdgeURL")) return OUTCOME.CONSISTENCY;
  if (name === "MissingBlobsEnvironmentError" || msg.includes("has not been configured to use Netlify Blobs"))
    return OUTCOME.MISSING_ENV;
  return OUTCOME.OTHER;
}

/**
 * The truth table. UNCALIBRATED always wins over a verdict — a probe whose negative control did
 * not fire must never report "D", because at that point it is not measuring anything.
 */
export function computeVerdict({ armA, armB, armA2, claimedRepaired }) {
  const selfChecks = [];
  const strongReads = armB === OUTCOME.OK;

  if (claimedRepaired === true && !strongReads) {
    selfChecks.push({
      id: "claim-disagrees-with-reality",
      severity: "serious",
      detail:
        "connectBlobs reported repaired:true but a strong read still failed. The repair wrote a " +
        "copy of the context the client does not read — getEnvironmentContext prefers " +
        "globalThis.netlifyBlobsContext over process.env, and getEnvironment() prefers " +
        "Netlify.env / Deno.env over process.env. strongReadAvailable() must never be used as a gate.",
    });
  }
  if (claimedRepaired === false && strongReads) {
    selfChecks.push({
      id: "repair-not-needed",
      severity: "informational",
      detail: "strong reads work without the repair — the platform supplied uncachedEdgeURL itself.",
    });
  }

  const uncalibrated = (reason, detail) => ({
    verdict: "UNCALIBRATED", reason, detail, strongReads: null, calibrated: false, selfChecks,
  });

  if ([armA, armB, armA2].includes(OUTCOME.MISSING_ENV)) {
    return uncalibrated(
      "no-blobs-context",
      "the Blobs environment was not injected into this invocation, so no arm measured anything."
    );
  }
  if (armA === OUTCOME.OK) {
    return uncalibrated(
      "negative-control-passed",
      "arm A did a strong read WITHOUT the repair and it succeeded. The probe therefore cannot " +
        "distinguish a repaired build from an unrepaired one, and reports no verdict. This is the " +
        "expected result if the platform or the client library is fixed upstream — at which point " +
        "this probe has nothing left to measure."
    );
  }
  if (armA === OUTCOME.OTHER || armB === OUTCOME.OTHER || armA2 === OUTCOME.OTHER) {
    return uncalibrated("probe-error", "an arm failed for a reason unrelated to read consistency.");
  }
  if (armA2 !== OUTCOME.CONSISTENCY) {
    return uncalibrated(
      "arm-isolation-broken",
      "arm A2 did not reproduce arm A's failure after arm B ran, so arm B's repair leaked across " +
        "arms and arm A's result cannot be trusted as a control."
    );
  }
  // armA and armA2 both threw the consistency error: the control fired, twice, around arm B.
  return strongReads
    ? {
        verdict: "D", reason: "strong-reads-work", calibrated: true, strongReads: true, selfChecks,
        detail:
          "the repair is present AND effective: a strong read failed without it and succeeded with " +
          "it, in this invocation. The three safety reads can read origin on this build.",
      }
    : {
        verdict: "HOTFIX", reason: "strong-reads-throw", calibrated: true, strongReads: false, selfChecks,
        detail:
          "a strong read throws on this build even through connectBlobs. Any handler asking for " +
          "consistency:\"strong\" will refuse, and any handler degraded to \"eventual\" is reading " +
          "a cache. The three fail-opens are OPEN on this build.",
      };
}

/** One arm: connect via `connect`, then attempt a strong read. Returns a closed-set outcome and
 *  the error's class name — never its message. */
async function runArm(connect, event) {
  // No injected context ⇒ nothing to measure. Said plainly, rather than letting connectLambda's
  // own decode failure surface as a generic "other-error" that reads like a probe bug.
  if (!event?.blobs) return { outcome: OUTCOME.MISSING_ENV, errorName: null, stage: "connect" };
  try {
    connect(event);
  } catch (err) {
    return { outcome: OUTCOME.OTHER, errorName: String(err?.name || "Error"), stage: "connect" };
  }
  try {
    const store = getStore(PROBE_STORE);
    // Same call shape as the kill switch's read in _pause.mjs, against a key that does not exist.
    const value = await store.get(PROBE_KEY, { type: "json", consistency: "strong" });
    return { outcome: OUTCOME.OK, errorName: null, stage: "read", keyExisted: value !== null && value !== undefined };
  } catch (err) {
    return { outcome: classifyError(err), errorName: String(err?.name || "Error"), stage: "read" };
  }
}

export const handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };

  if ((event?.httpMethod || "GET").toUpperCase() !== "GET") {
    return {
      statusCode: 405,
      headers: { ...headers, Allow: "GET" },
      body: JSON.stringify({ error: "method-not-allowed", detail: "this probe is read-only; use GET." }),
    };
  }

  // ORDER IS LOAD-BEARING: A (unrepaired) -> B (repaired) -> A2 (unrepaired again).
  const armA = await runArm(connectLambda, event);
  const armB = await runArm(connectBlobs, event);
  const claimedRepaired = strongReadAvailable();
  const armA2 = await runArm(connectLambda, event);

  // Does the store answer AT ALL on this build? Separates "strong is broken" from "Blobs is down",
  // which would otherwise both surface as a failing arm B.
  let eventualReachable = null;
  try {
    connectBlobs(event);
    await getStore(PROBE_STORE).get(PROBE_KEY, { type: "json", consistency: "eventual" });
    eventualReachable = true;
  } catch {
    eventualReachable = false;
  }

  const v = computeVerdict({
    armA: armA.outcome, armB: armB.outcome, armA2: armA2.outcome, claimedRepaired,
  });

  const stamp = buildStamp();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(
      {
        probe: "blobs-strong-read/1",
        verdict: v.verdict,
        reason: v.reason,
        detail: v.detail,
        calibrated: v.calibrated,
        strongReads: v.strongReads,
        arms: {
          A_connectLambda_only: armA,
          B_connectBlobs: armB,
          A2_connectLambda_after_B: armA2,
          expected: {
            A_connectLambda_only: OUTCOME.CONSISTENCY,
            A2_connectLambda_after_B: OUTCOME.CONSISTENCY,
            B_connectBlobs: `${OUTCOME.OK} under D, ${OUTCOME.CONSISTENCY} under the hotfix`,
          },
        },
        eventualReachable,
        claimedRepaired,
        selfChecks: v.selfChecks,
        // Diagnostics for the shadowing risk named in claim-disagrees-with-reality. Booleans and a
        // kind only — these objects hold the Blobs access token and must never be serialised.
        runtime: {
          globalThisBlobsContextPresent: Boolean(globalThis.netlifyBlobsContext),
          envKind: globalThis.Netlify?.env ? "Netlify.env" : globalThis.Deno?.env ? "Deno.env" : "process.env",
          blobsContextInjected: Boolean(event?.blobs),
        },
        build: stamp,
        // Runtime, not build-time — kept separate from `build` on purpose.
        deploy: resolveDeployId({ event }),
        store: PROBE_STORE,
        key: PROBE_KEY,
      },
      null,
      2
    ),
  };
};
