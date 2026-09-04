// dd-vouched-build — WHAT HAS THE CANARY ACTUALLY VOUCHED FOR? One strong read, no writes.
//
// ═══ ⭐⭐ WHY THIS EXISTS: ddTree WAS THE ONE IDENTITY FIELD WITH NO PRODUCTION READ ═══════════
// `blobs-probe` serves commit, dirty, tree and fileCount straight off production. It does not serve
// `ddTree`, and neither does /api/dd-identity, /built, or /api/dd-analyze (a declared 405). So every
// production claim about ddTree was DERIVED — bound transitively through the tree hash — while every
// other identity field was an observation. `capture:window`'s comparison does not close that either:
// it compares the local stamp against the previous ledger entry, and both operands live on the
// deploying machine.
//
// ⛔ AND THE CHEAP FIX WAS REJECTED. Projecting `ddTree` onto blobs-probe would read the SAME baked-in
// stamp from a second place and return agreement with itself — repeating one instrument. It would
// also put a new read with a new failure surface onto a probe that sits on the money path. This is a
// SEPARATE endpoint, and it answers a strictly bigger question: not "what does this build call
// itself" but "did a canary vouch for it, when, and with what verdict". See shared/dd-canary/vouched.mjs
// for the rule that keeps it the bigger question.
//
// ═══ ⭐ PUBLIC, AND HERE IS THE REASONING ══════════════════════════════════════════════════════
// 1. IT DISCLOSES NOTHING NEW. The refusal it reports on is ALREADY publicly observable: during a
//    window, /api/dd-analyze renders a health banner to anyone who asks. This endpoint makes the
//    same fact CHECKABLE instead of merely visible. The DD service's product is flagging
//    trusted-mutable-surfaces in other people's contracts, and /api/dd-identity already states that
//    it does not exempt itself — "a disclosure only a source-code reader would see is not a
//    disclosure". An identity field readable only by its operator is that same shape.
// 2. ddTree IS A CONTENT HASH. It leaks no contents, no addresses, no balances.
// 3. THERE IS NO REQUEST-INPUT-TO-BEHAVIOUR CHANNEL. Same seal as dd-canary, and for the same
//    reason: `event` is read for exactly two things — `httpMethod` and `.blobs` (which Netlify's
//    shim injects and an HTTP caller cannot set). No query string, no body, no headers reach the
//    logic. There is no parameter to sanitise because there is no parameter.
//
// ⚠️ THE EXPOSURE THIS DOES ADD, STATED: one strong (origin, uncached) Blobs read per request. It
// performs NO write, runs NO fixture sweep, and must never trigger a canary run — a read endpoint
// that can cause a write is an amplifier. If that read ever needs bounding, the dedupe pattern is
// `shouldSkipRerun`; it is deliberately not here, because there is nothing expensive to skip.
//
// 🚨 THE INVARIANT TO KEEP: this function must never write, never call runFixtures, and never import
// _pause.mjs or the vault path. It is the DD correctness thread, not the money thread.

// ⭐ connectBlobs, NOT connectLambda — the shim drops event.blobs' `url_uncached`, without which
// _dd-health's strong-consistency read throws. Same reason dd-canary does it.
import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
import { codeIdentityForEvent, buildIsBound } from "../../shared/dd-canary/health.mjs";
import { vouchedBuild, httpStatusFor } from "../../shared/dd-vouch/vouched.mjs";
import { readHealth, DD_HEALTH_STORE } from "./_dd-health.mjs";

export async function handler(event) {
  if (event?.httpMethod !== "GET" && event?.httpMethod !== "HEAD") {
    return json(405, {
      error: "GET only",
      detail: "this is a read-only report of what the DD canary vouched for; it writes nothing",
    });
  }
  if (event?.blobs) connectBlobs(event);

  // ⭐ THE SAME DERIVATION dd-canary USES TO WRITE, not a second one. A parallel path is precisely
  // how the two sides drift into keys that never match — or match for the wrong reason.
  const identity = codeIdentityForEvent(event, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
  const running = {
    resolved: identity.buildResolved === true,
    id: identity.build,
    source: identity.buildSource,
    detail: identity.buildDetail,
  };

  // ⛔ DO NOT ASK THE STORE WITHOUT A KEY. With an unbound build, healthKey() would compose a
  // literal "null" into the key and read a slot that means nothing. Not asking is the honest move,
  // and vouchedBuild reports it as UNREADABLE/build-unbound rather than as `none`.
  let read = { record: null, readable: true, error: undefined };
  if (buildIsBound(identity)) {
    read = await readHealth(identity);
  }

  const result = vouchedBuild({
    record: buildIsBound(identity) ? read.record : null,
    readable: buildIsBound(identity) ? read.readable : true,
    now: Date.now(),
    running,
    storeError: read.error ?? null,
  });

  return json(httpStatusFor(result), {
    endpoint: "dd-vouched-build/1",
    question: "which build did the DD canary vouch for, when, and with what verdict?",
    // ⚠️ SAID IN THE PAYLOAD, because a reader holding the JSON is who can misread it.
    whatThisIsNot:
      "NOT a health verdict and NOT a claim that the service is serving — a failing or stale record " +
      "also names a build. NOT a second reading of the build stamp either: `vouched.build` is read " +
      "out of the stored record, while `stamp.ddTree` is the baked-in value. Compare them; do not " +
      "assume they came from the same place.",
    ...result,
    read: {
      store: DD_HEALTH_STORE,
      consistency: "strong",
      writes: "none — this endpoint reads and never writes, and cannot trigger a canary run",
      // Diagnosis: the non-compared half of the identity, so an operator can see WHICH key was read.
      key: buildIsBound(identity)
        ? `health:${identity.schemaVersion}:${identity.catalogueFingerprint}:${identity.build}`
        : null,
      keyNote:
        "⭐ the KEY is derived from the running ddTree; the ANSWER in `vouched.build` is not — it is " +
        "whatever the canary wrote into the record found there. That distinction is the whole point.",
    },
  });
}
