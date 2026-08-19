// _dd-rungs.mjs — THE ONE LADDER. Every entry point that produces a DD report climbs it here.
//
// ═══ ⭐⭐ WHY THIS FILE EXISTS AT ALL ═════════════════════════════════════════════════════════
// There are now TWO ways to obtain a report: a paying buyer over x402 (`dd-analyze`), and a
// session-authed in-app card (`agent-dd-report`). They must return THE SAME ARTIFACT — same schema,
// same quorum, same attestation — because the whole claim of the in-app panel is that the policy
// evaluates something a buyer could independently verify. The moment the two paths compute their
// own ladders, they drift, and the drift is INVISIBLE: both keep returning well-formed reports, and
// nothing fails. One of them just quietly stops checking something.
//
// ⚠️ THIS REPO HAS ALREADY PAID FOR THAT EXACT SHAPE — [duplicate-source-of-truth-is-the-recurring-bug]:
// "a claim copied into a second place always drifts". A validation ladder copied into a second
// handler is that bug with a gate on the end of it.
//
// ═══ ⭐ THE ORDER IS THE PRODUCT, SO THE ORDER LIVES IN ONE ARRAY ══════════════════════════════
// `LADDER` below is the single ordered definition. An entry point does not re-list the rungs it
// wants; it names the ones it SKIPS. That inversion is deliberate and load-bearing:
//
//   · a rung ADDED here is automatically climbed by every entry point, including ones written
//     before it existed. If entry points listed the rungs they run, a new rung would silently apply
//     to whichever handler its author remembered to edit.
//   · a skip is a NAMED, VALIDATED, DELIBERATE act. An unrecognised skip name THROWS rather than
//     being ignored — a typo'd skip that is silently dropped would either re-enable a rung the
//     author meant to skip (noisy, harmless) or, in the mirror case, read as a skip that never
//     happened. Closed sets, never a convenient default. [absence-must-never-read-as-safe]
//
// ═══ 🚨 SOME RUNGS CANNOT BE SKIPPED BY ANYONE ════════════════════════════════════════════════
// `UNSKIPPABLE` is enforced by a throw, not by a comment. HEALTH is on it. A future entry point
// that finds the health gate inconvenient cannot quietly opt out of the last layer that stops an
// unverified detector from answering questions about someone's money.

import { randomUUID } from "node:crypto";
import { json } from "./_arc.mjs";
import { exposureState } from "./_dd-exposure.mjs";
import { readHealth } from "./_dd-health.mjs";
import { codeIdentityForEvent, evaluateHealth, HEALTH_REASON } from "../../shared/dd-canary/health.mjs";
import { SUPPORTED_CHAINS, wantsHtml, DD_RESOURCE_URL } from "./_dd-descriptor.mjs";
import { resolvePayTo, ddPaymentRequirements, DD_PRICE_HUMAN } from "./_dd-x402.mjs";
import { chainClient } from "../../shared/dd/client.mjs";
import { quorumClient } from "../../shared/onchain-analyze/quorum.mjs";
import { ARC_QUORUM_ENDPOINTS } from "../../shared/onchain-analyze/endpoints.mjs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { baseReport, assertReportValid, SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { attachAttestation, unsignedAttestation } from "../../shared/onchain-analyze/attest.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
import { ddAttestationOptions } from "../../shared/dd/attest-circle.mjs";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const MAX_BODY_BYTES = 4096;

/** The closed set of rung names. A skip naming anything outside this is a programmer error. */
export const RUNG = Object.freeze({
  EXPOSURE: "exposure",
  RETRIEVE: "retrieve",
  DISCOVERY: "discovery",
  HEALTH: "health",
  METHOD: "method",
  BODY: "body",
  ADDRESS: "address",
  CHAIN: "chain",
  PAYTO: "payTo",
});

/**
 * ⭐⭐ WHICH HEALTH REFUSALS CLEAR BY THEMSELVES — AND WHICH EMPHATICALLY DO NOT.
 *
 * The discovery page tells a stranger whether waiting will help. Getting this wrong in the
 * reassuring direction would put a fresh lie on the one surface built specifically to be honest:
 * "try again in a few minutes" is actively misleading when the detector has FAILED ITS OWN FIXTURES
 * and will keep failing until somebody fixes the code.
 *
 *   · NO_RECORD — the canary has not run for THIS build yet. Guaranteed after every deploy, and the
 *     scheduled sweep resolves it with nobody doing anything.
 *   · STALE     — the artifact aged past its TTL. The next scheduled run refreshes it.
 *
 * ⚠️ EVERYTHING ELSE IS EXCLUDED, and each for its own reason: NOT_PASSING means a fixture actually
 * regressed; VERSION_MISMATCH and BUILD_UNRESOLVED mean the identity does not line up; MALFORMED
 * means the artifact is corrupt; UNREADABLE means we could not see. None of those is a waiting
 * problem. ⭐ CLOSED SET, tested by enumeration — a health reason added later is NOT self-clearing
 * until somebody decides it is, which is the safe direction for a page that tells people what to do.
 */
export const SELF_CLEARING_HEALTH = Object.freeze([HEALTH_REASON.NO_RECORD, HEALTH_REASON.STALE]);

/**
 * ⭐⭐ THE ORDER. Changing this array changes both entry points at once, which is the entire point.
 *
 * Each position is a decision that was argued for once, in `dd-analyze`, and must not be re-argued
 * per handler:
 *   · EXPOSURE first  — cheapest possible check; deploying must not equal publishing.
 *   · RETRIEVE second — behind exposure (no paid callers if never published), but AHEAD of health,
 *     because an already-paid report was produced when the detector was known good and must not be
 *     stranded by a later canary blip. The health gate guards PRODUCTION, not DELIVERY.
 *   · DISCOVERY third — ⭐⭐ AHEAD OF HEALTH FOR EXACTLY THE REASON RETRIEVE IS. The page is not an
 *     answer about a subject; it is DOCUMENTATION. The health gate guards the production of new
 *     answers, and a page explaining how to call the service is not one.
 *
 *     🚨 THE DEFECT THIS FIXES, MEASURED ON PROD 2026-08-16: with the page behind health, a browser
 *     sending `Accept: text/html` during the post-deploy refusal window got `application/json` 503
 *     `service-unverified` instead of the page. That window is up to the canary period and lands
 *     EXACTLY when a human is most likely to look — right after a change. They got a message about
 *     a detector instead of the one page that tells them how to call the thing.
 *
 *     ⚠️ HTML ONLY. A non-POST asking for JSON still falls through to the METHOD rung BEHIND health,
 *     because that response is a report about a request and belongs under the same gate as any
 *     other. Only the human-facing documentation moves.
 *   · HEALTH fourth   — before any validation, so an unverified service is uniformly UNAVAILABLE
 *     rather than selectively degraded.
 *   · then the request-shape rungs, cheapest first.
 *   · PAYTO last of the gates — never quote a price payable to nowhere.
 *
 * ⚠️ PAYMENT IS NOT IN THIS ARRAY, and that is not an oversight. Payment is a BRANCH (challenge vs
 * settle), not a gate that either refuses or falls through, and only one entry point has one. The
 * ladder ends where the paths legitimately diverge; everything above it is shared by construction.
 */
export const LADDER = Object.freeze([
  RUNG.EXPOSURE, RUNG.RETRIEVE, RUNG.DISCOVERY, RUNG.HEALTH,
  RUNG.METHOD, RUNG.BODY, RUNG.ADDRESS, RUNG.CHAIN, RUNG.PAYTO,
]);

/**
 * 🚨 RUNGS NO ENTRY POINT MAY SKIP — enforced by a throw in `assertSkipSet`.
 *
 * HEALTH is here because it is the last layer that keeps a detector which fails its own known-shape
 * fixtures from answering questions about someone else's contracts. The in-app path has a STRONGER
 * reason to respect it than a buyer does, not a weaker one: the card gates a deposit. A buyer who
 * gets a bad report loses the price of a report; a user who deposits on one loses the deposit.
 *
 * The request-shape rungs are here because skipping them does not save work, it only moves the
 * failure — an unvalidated address reaches `analyze()`, which throws on it BY DESIGN (it reserves
 * exceptions for programmer error), and over the wire that throw is a 500 with a stack trace.
 */
export const UNSKIPPABLE = Object.freeze([RUNG.HEALTH, RUNG.METHOD, RUNG.BODY, RUNG.ADDRESS, RUNG.CHAIN]);

/**
 * A refusal that is a REPORT, not an error.
 *
 * Coverage is populated with EVERY power group in the shared catalogue, each marked not-checked with
 * the real reason — so a refusal satisfies the same completeness invariant a successful report does.
 * An empty coverage block would pass through assertReportValid as "coverage-incomplete", turning a
 * clean refusal into a second, confusing one.
 */
/**
 * ⭐ THE PAYMENT TERMS ON A REFUSAL — so a probe that sends a bad body still learns this is payable.
 *
 * Input validation runs BEFORE the 402 (deliberately: charging for "that is not a well-formed
 * question" would quote a price for something answered free, and would reward narrowing the
 * supported chain set). The consequence is that a discovery probe POSTing an empty body gets a 400
 * and learns NOTHING about payability — measured with `circle services inspect -X POST`, which
 * reported the endpoint "unavailable".
 *
 * ⚠️ THIS DOES NOT CHANGE THE STATUS CODE and is not expected to score: Circle's checker keys on
 * HTTP 402. It is here for the reader — human or agent — who gets a 400 and would otherwise have no
 * way to know a price exists at all.
 *
 * 🚨 FAIL-SOFT, ALWAYS. Input 400s fire before the PAYTO rung, so payTo may be unset or malformed
 * at this point. A refusal must never fail because the payment terms could not be assembled — the
 * refusal is the answer, the terms are a courtesy. Unresolvable payTo yields the price with the
 * address omitted and a reason, never a throw and never a fabricated address.
 */
/**
 * ⭐⭐ A CLOSED SET, AND THE DISTINCTION IS THE WHOLE POINT.
 *
 * A 400/405 is a statement about the CALLER — "your input is malformed, and here is what a good one
 * costs" — so quoting a price is an INVITATION TO RETRY, which is exactly right.
 *
 * 🚨 A 503 IS A STATEMENT ABOUT THE SERVICE, which cannot be bought from right now. Attaching
 * payment terms invites an agent to construct an authorization for a call that will refuse again —
 * and during a refusal window that is EVERY call for ~8 minutes (measured: 492s). The agent would
 * sign, retry, refuse, and repeat, against a service that told it the price while telling it no.
 * `payment-misconfigured` is the sharpest case: quoting a payable challenge on a refusal whose
 * reason IS that payment is unconfigured would be self-contradicting.
 *
 * ⭐ Same shape as the existing free-vs-charged rule in dd-analyze: one is about the QUESTION, the
 * other is about OUR INSTRUMENT. We answer questions about the question for free and invite a
 * retry; we never invoice for our own outage, nor imply one can be paid past.
 *
 * ⚠️ CLOSED, TESTED BY ENUMERATION, AND DEFAULT-OFF — a refusal reason added later does NOT inherit
 * payment terms until somebody decides it should, which is the safe direction. Same discipline as
 * SELF_CLEARING_HEALTH above.
 */
export const INPUT_REFUSAL_REASONS = Object.freeze([
  "unsupported-method",   // 405 — wrong verb: the caller's phrasing
  "malformed-request",    // 400 — body too large / not JSON / not an object
  "invalid-address",      // 400 — missing or not a 20-byte hex address
  "chain-not-specified",  // 400 — chain omitted
  "unsupported-chain",    // 400 — a chain this service does not analyse
]);

function paymentTerms() {
  try {
    const r = resolvePayTo();
    if (!r.ok) {
      return { price: DD_PRICE_HUMAN, resource: DD_RESOURCE_URL, accepts: null,
               note: `this endpoint is paid, but the revenue address is not currently resolvable (${r.reason}), so no payable challenge can be quoted here. POST a VALID body to receive the full 402.` };
    }
    return {
      price: DD_PRICE_HUMAN,
      resource: DD_RESOURCE_URL,
      accepts: [ddPaymentRequirements({ resource: DD_RESOURCE_URL, payTo: r.payTo })],
      note: "this request was refused on its INPUT, before payment was ever required. Fix the body and POST again to receive the full 402 challenge.",
    };
  } catch {
    return { price: DD_PRICE_HUMAN, resource: DD_RESOURCE_URL, accepts: null,
             note: "this endpoint is paid; the challenge could not be assembled here. POST a valid body to receive the full 402." };
  }
}

export function refusalReport({ address = null, chainName = null, chainId = null, reason, detail, diagnostic = null }) {
  const notChecked = Object.keys(POWER_SIGS).map((group) => ({
    id: `power:${group}`,
    kind: "power",
    group,
    reason: `request refused before any analysis ran (${reason}) — nothing was scanned`,
  }));
  return assertReportValid({
    ...baseReport({ address, chainId, chainName, blockNumber: null }),
    shape: { class: "unknown", family: "unknown", variant: null, scannedAddress: null, evidence: { why: reason } },
    coverage: {
      checked: [],
      notChecked,
      totals: { checked: 0, notChecked: notChecked.length },
      summary:
        "NOTHING was checked: the request was refused before analysis began. This is an INDETERMINATE result, not a clean bill.",
    },
    refusal: { reason, detail, ...(diagnostic ? { diagnostic } : {}) },
    // Input-validation refusals are deliberately NOT signed. They are statements about a REQUEST,
    // not about a subject on chain, and signing anonymous malformed input would turn this endpoint
    // into an unmetered signing oracle over attacker-chosen bytes.
    attestation: unsignedAttestation("input rejected before analysis — there is no on-chain claim to attest"),
    // ⭐ Sibling of the report, not part of it: a report is a statement about a SUBJECT, and payment
    // terms are not. It rides on the same response because that is the only thing the caller holds.
    // ⚠️ ONLY on refusals about the CALLER — see INPUT_REFUSAL_REASONS.
    ...(INPUT_REFUSAL_REASONS.includes(reason) ? { howToPay: paymentTerms() } : {}),
  });
}

/**
 * ⭐⭐ THE SAME HEALTH READ, USED FOR DISCLOSURE INSTEAD OF FOR GATING.
 *
 * The discovery page now renders AHEAD of the health gate, which creates a new hazard the move
 * itself does not solve: **a page served while health is down must not imply the service is up.**
 * If it rendered unchanged, a reader would copy the curl, run it, get a 503, and reasonably conclude
 * they had done something wrong. That is worse than the bare 503 they used to get, because the bare
 * 503 at least said what was happening. Rendering unchanged would be disclosure-by-omission on the
 * one surface built specifically to be honest to a stranger.
 *
 * ⭐ SAME DISCIPLINE AS `POLICY_CEILING` RIDING ON EVERY POLICY RESULT: the constraint travels WITH
 * the artifact rather than depending on the reader already knowing it.
 *
 * ⚠️ IT NEVER GATES AND IT NEVER THROWS. This is a statement attached to a page, not a decision. A
 * failure to read health must not take the documentation down with it — the page's whole value is
 * being available when other things are not.
 *
 * 🚨 AND IT NEVER RESOLVES TO "HEALTHY" ON FAILURE. `serving` is a TRI-STATE: `true`, `false`, or
 * `null` for could-not-tell, and `null` renders as an explicit unknown. A catch that returned
 * `{serving: true}` would be [absence-must-never-read-as-safe] on the honesty surface itself.
 *
 * @returns {Promise<{serving: boolean|null, reason: string|null, detail: string|null,
 *                    selfClearing: boolean|null}>}
 */
export async function healthDisclosure(event) {
  try {
    const identity = codeIdentityForEvent(event, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
    const { record, readable } = await readHealth(identity);
    const h = evaluateHealth({ record, readable, now: Date.now(), expect: identity });
    if (h.serve) return { serving: true, reason: null, detail: null, selfClearing: null };
    return {
      serving: false,
      reason: h.reason ?? null,
      detail: h.detail ?? null,
      // ⚠️ MEMBERSHIP IN A CLOSED SET, never a truthiness test. An unrecognised reason is NOT
      // self-clearing, so a new health outcome cannot inherit "just wait" by default.
      selfClearing: SELF_CLEARING_HEALTH.includes(h.reason),
    };
  } catch (e) {
    return {
      serving: null,
      reason: "disclosure-unreadable",
      detail: `could not determine the service's current health: ${String(e?.message ?? e)}`,
      selfClearing: null,
    };
  }
}

/**
 * ⭐ Validate the skip set. Throws on anything unrecognised or forbidden.
 *
 * ⚠️ THROWS RATHER THAN FILTERING. A silently-dropped skip name is a lie in both directions, and the
 * caller is a programmer, so a throw is the correct register — the same reasoning `analyze()` uses
 * for a malformed address. This runs at request time rather than module load only because handlers
 * build their skip list inline; the tests call it directly so the throw is exercised by CALLING it,
 * not by grepping for it. [assert-on-rendered-output-not-source-regex]
 */
export function assertSkipSet(skip) {
  if (!Array.isArray(skip)) throw new Error(`runLadder(): \`skip\` must be an array, got ${typeof skip}`);
  const known = new Set(Object.values(RUNG));
  for (const s of skip) {
    if (!known.has(s)) {
      throw new Error(`runLadder(): unknown rung ${JSON.stringify(s)} in \`skip\` — known rungs: ${[...known].join(", ")}`);
    }
    if (UNSKIPPABLE.includes(s)) {
      throw new Error(`runLadder(): rung ${JSON.stringify(s)} is UNSKIPPABLE and must not be bypassed by any entry point`);
    }
  }
  return new Set(skip);
}

/**
 * Climb the ladder.
 *
 * @param {object}   event                the Netlify event
 * @param {string[]} skip                 rung names to skip — validated, never silently ignored
 * @param {object}   deps                 per-rung dependencies (only needed for rungs not skipped)
 * @param {function} deps.retrieve        (handle) => http response — required unless RETRIEVE skipped
 * @param {function} deps.resolvePayTo    () => {ok, payTo, ...}    — required unless PAYTO skipped
 * @param {function} deps.decorateMethodRefusal  optional: (refusal, event) => http response
 * @returns {Promise<{done: object}|{ok: true, body, addr, chain, payTo}>}
 *          `done` is a finished HTTP response (a refusal, or a retrieval). `ok` means keep going.
 */
export async function runLadder({ event, skip = [], deps = {} }) {
  const skipped = assertSkipSet(skip);
  const ran = [];
  const ctx = { body: null, addr: null, chain: null, payTo: null };

  for (const rung of LADDER) {
    if (skipped.has(rung)) continue;
    ran.push(rung);

    // ── ⭐ RUNG -1: IS THIS SERVICE EVEN SUPPOSED TO ANSWER THE PUBLIC? ────────────────────────
    // Deploying this function must NOT be the same act as publishing it. UNSET = DISABLED, and so is
    // anything unrecognised. Deployed-but-inert is the default; serving is the deliberate act.
    //
    // ⚠️ THE IN-APP PATH SKIPS THIS DELIBERATELY, and the reason is that it is not the same question.
    // `DD_PUBLIC_ENABLED` governs whether an ANONYMOUS caller may reach a signed attestation endpoint
    // under agentId 851891. A session-authed owner reading their own vault card is already past a
    // stronger gate. Gating the card on the public flag would mean shipping the service disabled
    // (the safe default) also silently disables the deposit disclosure.
    if (rung === RUNG.EXPOSURE) {
      const exposure = exposureState();
      if (!exposure.enabled) {
        return { done: json(503, refusalReport({
          reason: "service-not-enabled",
          detail: `${exposure.detail} (${exposure.reason}). The service is deployed but not published. Set DD_PUBLIC_ENABLED to enable it deliberately.`,
        })), ran };
      }
      continue;
    }

    // ── ⭐ RETRIEVE: redeem a handle for a report already paid for ─────────────────────────────
    if (rung === RUNG.RETRIEVE) {
      if (typeof deps.retrieve !== "function") {
        throw new Error("runLadder(): rung `retrieve` is not skipped but no deps.retrieve was supplied");
      }
      const q = event.queryStringParameters || {};
      const handle = q.handle || (event.headers || {})["x-payment-handle"];
      if (handle) return { done: await deps.retrieve(handle), ran };
      continue;
    }

    // ── ⭐⭐ DISCOVERY: THE DOCUMENTATION, WHICH IS NOT AN ANSWER ABOUT A SUBJECT ───────────────
    // Ahead of health for the same reason RETRIEVE is: the health gate guards the PRODUCTION of new
    // answers. A page saying how to call the service is not one.
    //
    // ⚠️ HTML ONLY — `wantsHtml` requires an EXPLICIT `text/html`, so `*/*` (curl's default), an
    // absent header and anything unparseable all fall through to the METHOD rung behind health.
    // Machines are unaffected by this move; only humans are.
    //
    // ⭐ THE HEALTH DISCLOSURE RIDES ALONG. See healthDisclosure(): the page renders whether or not
    // the service is serving, and SAYS WHICH — a page that looked identical during a refusal window
    // would send a reader to a curl that 503s and let them conclude they got it wrong.
    if (rung === RUNG.DISCOVERY) {
      if (event.httpMethod !== "POST" && wantsHtml(event.headers ?? {})) {
        if (typeof deps.discoveryPage !== "function") {
          throw new Error("runLadder(): rung `discovery` is not skipped but no deps.discoveryPage was supplied");
        }
        const health = await healthDisclosure(event);
        return {
          done: {
            statusCode: 405,
            // ⚠️ THE STATUS STAYS 405 whatever health says. The METHOD is what is unsupported; a 503
            // here would describe the service when the sentence being answered is about the request,
            // and a 200 would be a nicer lie. The banner carries the health fact; the code does not.
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
            body: deps.discoveryPage({ method: event.httpMethod, health }),
          },
          ran,
        };
      }
      continue;
    }

    // ── ⭐ RUNG 0: IS THIS SERVICE KNOWN GOOD? ─────────────────────────────────────────────────
    // Requires a POSITIVE, FRESH, VERSION-MATCHED pass. Absence, staleness, unreadability,
    // malformation and version drift all refuse. "No news is good news" is structurally impossible
    // here, which is the entire point: the last safety layer must not itself fail open.
    if (rung === RUNG.HEALTH) {
      // ⭐ SAME derivation as dd-canary (codeIdentityForEvent). The cron WRITES the artifact and
      // this HTTP path READS it; if the two derived the id differently the keys would never match.
      const identity = codeIdentityForEvent(event, { schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
      const { record, readable } = await readHealth(identity);
      const health = evaluateHealth({ record, readable, now: Date.now(), expect: identity });
      if (!health.serve) {
        const ev = health.evidence ?? {};
        return { done: json(503, refusalReport({
          reason: "service-unverified",
          detail: `${health.detail} (${health.reason}). The service is REFUSING TO SERVE rather than answering from a detector that is not known good. This is not a degraded result — it is no result.`,
          diagnostic: {
            healthReason: health.reason,
            ...(ev.mismatched ? { mismatchedFields: ev.mismatched } : {}),
            ...(ev.running ? { running: ev.running } : {}),
            ...(ev.runningBuild ? { runningBuild: ev.runningBuild } : {}),
            ...(ev.recordedNote ? { recordedNote: ev.recordedNote } : {}),
            ...(ev.recorded ? { recorded: ev.recorded } : {}),
            ...(ev.buildSources ? { buildSources: ev.buildSources } : {}),
            ...(ev.ageMs !== undefined ? { ageMs: ev.ageMs, ttlMs: ev.ttlMs } : {}),
          },
        })), ran };
      }
      continue;
    }

    // ── rung 1: method ─────────────────────────────────────────────────────────────────────────
    // ⭐ THE DECISION IS SHARED; THE DECORATION IS AN EXPLICIT, NAMED DIFFERENCE. The public endpoint
    // hangs a discovery page and a `howToCall` block off this refusal because a human who clicks the
    // link deserves a route to a working call. An in-app route has no discovery problem — its only
    // caller is our own fetch. Passing a decorator keeps the REFUSAL identical and makes the extra
    // marketing surface a thing an entry point opts into, not a thing it re-implements.
    if (rung === RUNG.METHOD) {
      if (event.httpMethod !== "POST") {
        const refusal = refusalReport({
          reason: "unsupported-method",
          detail: `this endpoint accepts POST; received ${event.httpMethod}`,
        });
        return {
          done: typeof deps.decorateMethodRefusal === "function"
            ? deps.decorateMethodRefusal(refusal, event)
            : json(405, refusal),
          ran,
        };
      }
      continue;
    }

    // ── rung 2: body ───────────────────────────────────────────────────────────────────────────
    if (rung === RUNG.BODY) {
      const raw = event.body ?? "";
      if (raw.length > MAX_BODY_BYTES) {
        return { done: json(400, refusalReport({ reason: "malformed-request", detail: `request body exceeds ${MAX_BODY_BYTES} bytes` })), ran };
      }
      try {
        ctx.body = raw ? JSON.parse(raw) : {};
      } catch {
        return { done: json(400, refusalReport({ reason: "malformed-request", detail: "request body is not valid JSON" })), ran };
      }
      if (ctx.body === null || typeof ctx.body !== "object" || Array.isArray(ctx.body)) {
        return { done: json(400, refusalReport({ reason: "malformed-request", detail: "request body must be a JSON object" })), ran };
      }
      continue;
    }

    // ── rung 3: address ────────────────────────────────────────────────────────────────────────
    // Checked BEFORE analyze() rather than relying on it: analyze() throws on a bad address by
    // design, and that throw over the wire is a 500 with a stack instead of an answer.
    if (rung === RUNG.ADDRESS) {
      const { address } = ctx.body ?? {};
      if (address === undefined || address === null || address === "") {
        return { done: json(400, refusalReport({ reason: "invalid-address", detail: "`address` is required and was missing or empty" })), ran };
      }
      if (typeof address !== "string" || !ADDRESS_RE.test(address.trim())) {
        return { done: json(400, refusalReport({ reason: "invalid-address", detail: "`address` must be a 0x-prefixed 20-byte hex string" })), ran };
      }
      ctx.addr = address.trim().toLowerCase();
      continue;
    }

    // ── rung 4: chain ──────────────────────────────────────────────────────────────────────────
    // ⭐ `chain` IS REQUIRED, AND ONLY ARC IS ACCEPTED. Cross-chain deterministic deployments
    // COLLIDE: Permit2, Multicall3, the Safe 1.3.0 singleton and CreateX all have real bytecode at
    // the same address on Arc (measured). Forcing the caller to NAME the chain makes every response
    // either explicitly correct or explicitly refused — never silently about the wrong chain.
    if (rung === RUNG.CHAIN) {
      const { chain } = ctx.body ?? {};
      if (chain === undefined || chain === null || chain === "") {
        return { done: json(400, refusalReport({
          address: ctx.addr,
          reason: "chain-not-specified",
          detail: `\`chain\` is required — an address alone does not identify a chain, and the same address holds different code on different chains. Supported: ${SUPPORTED_CHAINS.join(", ")}`,
        })), ran };
      }
      if (typeof chain !== "string" || !SUPPORTED_CHAINS.includes(chain)) {
        return { done: json(400, refusalReport({
          address: ctx.addr,
          chainName: typeof chain === "string" ? chain : null,
          reason: "unsupported-chain",
          detail: `this service analyzes ${SUPPORTED_CHAINS.join(", ")} only; refusing ${JSON.stringify(chain)}. Any other chain is unexercised and unverified here, and answering anyway would be a confident answer about something never tested.`,
        })), ran };
      }
      ctx.chain = chain;
      continue;
    }

    // ── rung 5: is there a revenue address to be paid? ─────────────────────────────────────────
    // Fail-closed: an unset payTo refuses rather than silently downgrading a paid service to a free
    // one. The in-app path skips it because it is not selling anything — there is no price to quote.
    if (rung === RUNG.PAYTO) {
      if (typeof deps.resolvePayTo !== "function") {
        throw new Error("runLadder(): rung `payTo` is not skipped but no deps.resolvePayTo was supplied");
      }
      const resolution = deps.resolvePayTo();
      if (!resolution.ok) {
        return { done: json(503, refusalReport({
          address: ctx.addr,
          chainName: ctx.chain,
          reason: "payment-misconfigured",
          detail: `${resolution.detail} (${resolution.reason})`,
        })), ran };
      }
      ctx.payTo = resolution.payTo;
      continue;
    }
  }

  return { ok: true, ...ctx, ran };
}

/**
 * Did our INSTRUMENT fail, as opposed to the subject having little to find?
 *
 * ⭐⭐ THE BILLING BOUNDARY on the paid path — and it stays in the SHARED producer even though the
 * in-app path never bills, because it is also the honesty boundary. A report where every read failed
 * is not a thin answer, it is no answer, and a card that rendered it as "nothing found against your
 * rules" would be the clean bill this whole subsystem exists to prevent.
 *
 * ⚠️ A DISAGREEMENT IS NOT AN INSTRUMENT FAILURE and is deliberately excluded. We did read; they
 * conflicted. That is a finding about the providers.
 */
export function isSystemicReadFailure(report) {
  const cov = report?.coverage;
  if (!cov || !Array.isArray(cov.checked) || !Array.isArray(cov.notChecked)) return false;
  if (cov.checked.length > 0) return false;              // something was established → an answer
  if (cov.notChecked.length === 0) return false;         // nothing to judge
  const INSTRUMENT = ["rpc-unreadable", "rpc-quorum-unmet"];
  return cov.notChecked.every((n) => INSTRUMENT.includes(n.reason));
}

/**
 * ⚠️ NEVER THROWS. An alerting failure must not destroy a report the buyer may have paid for.
 *
 * ⭐ Takes the REPORT AND NOTHING ELSE, and is called from inside the producer — BEFORE any caller
 * decides anything about settlement. The charge decision is not in scope here and cannot be branched
 * on, because it does not exist yet. ⚠️ DO NOT "simplify" this by passing it `charged`: the moment
 * those meet, whether we shout about a bad provider becomes a function of whether we got paid.
 */
export function escalateProviderIntegrity(report, correlationId) {
  try {
    const integrity = report?.sources?.integrity;
    if (!integrity?.providerDisagreement) return;
    console.error(
      `[dd ${correlationId}] 🚨 PROVIDER DISAGREEMENT — endpoints returned different values ` +
        `for the same call at the same block. At least one source is serving something FALSE. ` +
        `subject=${report?.subject?.address} chain=${report?.subject?.chainId} ` +
        `block=${report?.subject?.blockNumber} splits=${integrity.splits.map((x) => x.id).join(",")} ` +
        `endpoints=${(report?.sources?.endpoints || []).join(" | ")} — ⚠️ a single-endpoint build of ` +
        `this service would have SIGNED AND SOLD this answer. Re-verify endpoint independence out of ` +
        `band; a retry may return agreement and erase the evidence.`
    );
  } catch {
    /* an alert that breaks the response is worse than a missed alert */
  }
}

/**
 * ⭐⭐ THE REPORT PRODUCER — SHARED, SO THE IN-APP CARD EVALUATES AN ARTIFACT A BUYER COULD VERIFY.
 *
 * This is the other half of "one ladder". A shared ladder that fed two different producers would
 * still hand the policy a report the buyer never sees. Quorum, the systemic-failure refusal, the
 * provider-integrity escalation and the attestation are all HERE, once.
 *
 * ⭐ QUORUM ON BOTH PATHS, AND NO CACHE. `ARC_QUORUM_ENDPOINTS` is read per render — deliberately
 * un-memoised on the first cut so the real load is a measured number rather than an estimate. Arc's
 * public RPC has throttled this repo before, so the load is worth knowing before it is worth hiding.
 * ⚠️ Any cache added later inherits the CDN lesson recorded in [netlify-blobs-strong-consistency]:
 * `no-store` stops new storage and CANNOT evict what is already stored.
 *
 * @returns {function(): Promise<object>} a thunk — NOT run here. The paid path hands it to
 *          runThenSettle(), which guarantees it runs BEFORE anything touches money.
 */
export function makeProduceReport({ addr, chain, correlationId }) {
  return async () => {
    let report;
    try {
      report = await analyze(addr, {
        client: quorumClient(ARC_QUORUM_ENDPOINTS.map((rpc) => chainClient(chain, { rpc }))),
      });

      // ⭐ Escalate FIRST, and from a scope that has no billing outcome in it.
      escalateProviderIntegrity(report, correlationId);

      // ⚠️ TOTAL INSTRUMENT FAILURE IS NOT A THIN ANSWER.
      if (isSystemicReadFailure(report)) {
        console.error(`[dd ${correlationId}] systemic read failure — every check unreadable; refusing rather than presenting an empty report as a result`);
        return refusalReport({
          address: addr,
          chainName: report?.subject?.chainName ?? null,
          chainId: report?.subject?.chainId ?? null,
          reason: "chain-unreadable",
          detail:
            "no check could be completed: every read failed across the whole endpoint set, so this " +
            "is our instrument failing rather than a thin subject. You are not charged.",
        });
      }
    } catch (e) {
      console.error(`[dd ${correlationId}] analyze threw:`, e);
      return refusalReport({
        address: addr,
        chainName: chain,
        reason: "internal-error",
        detail: `the analysis could not run. This is INDETERMINATE, not a clean bill. Reference: ${correlationId}`,
      });
    }

    // ── attestation: sign, but DEGRADE rather than fail ────────────────────────────────────────
    // A signer outage must not destroy an otherwise-good report. `attestation.status` already models
    // the unsigned case, which is exactly why it is a status field and not a promise.
    try {
      return await attachAttestation(report, ddAttestationOptions());
    } catch (e) {
      console.error(`[dd ${correlationId}] signing failed:`, e);
      return {
        ...report,
        attestation: unsignedAttestation(`the report is complete but could not be signed on this run. Reference: ${correlationId}`),
      };
    }
  };
}

export const newCorrelationId = () => randomUUID();
