// dd-analyze.mjs — POST /api/dd-analyze — the DD engine's first callable surface.
//
// ═══ WHAT THIS IS NOT, AND WHERE IT SITS ══════════════════════════════════════════════════════
// A NEW function on its OWN route. It imports NOTHING from _vault.mjs and touches no part of the
// deposit path. The honest statement of that invariant is narrower than "independent": this handler
// imports shared/onchain-analyze, which imports shared/onchain-facts — WHICH _vault.mjs ALSO
// IMPORTS. That coupling already exists and is published as the engine's code-independence limit
// (agent-metadata/dd-service.json). What is true here: this adds a READER of the shared primitive,
// modifies nothing in it, and cannot reach the deposit path.
//
// ═══ ⭐ THE NEW RISK A LOCAL MODULE NEVER HAD: UNTRUSTED INPUT ════════════════════════════════
// analyze() treats a malformed address as PROGRAMMER ERROR and throws — correct for a module, whose
// caller is a programmer. Over the wire the caller is not a programmer, and that same throw becomes
// a 500 with a stack trace: an internals leak and, worse, an answer-shaped non-answer. So every rung
// of the ladder below produces a REPORT, and analyze() itself is wrapped so no throw can escape.
//
// Every response — including every refusal — is the SAME report schema, satisfies the SAME
// completeness invariant (assertReportValid), and carries `attestation` and `coverage`. One parser
// for the caller. `powers: []` never appears without a populated `refusal` beside it.
//
// ═══ STATUS CODES DESCRIBE THE REQUEST; THE BODY DESCRIBES THE SUBJECT ════════════════════════
// 400 = the request was not a well-formed question (bad address, unsupported chain).
// 200 = the service answered, INCLUDING when the answer is "I cannot assess this".
// Never a bare error envelope at either — the body is always a report.
//
// ═══ PAYMENT (step 2) — x402 over Circle Gateway ══════════════════════════════════════════════
// The analysis is PAID. The flow is 402 → pay → 202 + handle → retrieve → 200, because Gateway
// settles in delayed batches and facilitator acceptance is not payment. All the money logic lives in
// _dd-x402.mjs; this file owns transport (the SDK client and the RPC) and the ladder below.
//
// ⭐ Three things stay FREE, deliberately:
//   · every input-validation refusal (400) — pre-402, zero RPC. Charging for "that is not a
//     well-formed question" would quote a price for something we answer for free, and would reward
//     narrowing the supported chain set.
//   · every engine outage or refusal — the report comes back with charged:false and the
//     authorization unspent. Charging for our own failure is the thing settle-gate.mjs exists to
//     prevent.
//   · retrieval of an already-paid report, forever.
//
// Still NOT in this step: auth, rate limiting, batch, chains beyond Arc Testnet, caching.

import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
// ⭐ connectBlobs, NOT connectLambda — the shim drops event.blobs' `url_uncached`, without which
// _dd-health's strong-consistency read throws. See _blobs.mjs.
import { connectBlobs } from "./_blobs.mjs";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { json } from "./_arc.mjs";
import {
  PENDING_STORE,
  resolvePayTo,
  ddPaymentRequirements,
  challenge402,
  b64decodePayment,
  runPaidAnalysis,
  retrievePaid,
} from "./_dd-x402.mjs";
import { codeIdentity, evaluateHealth } from "../../shared/dd-canary/health.mjs";
import { readHealth } from "./_dd-health.mjs";
import { exposureState } from "./_dd-exposure.mjs";
import { chainClient } from "../../scripts/dd/client.mjs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { baseReport, assertReportValid, SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";
import { attachAttestation, unsignedAttestation } from "../../shared/onchain-analyze/attest.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";
import { ddAttestationOptions } from "../../scripts/dd/attest-circle.mjs";

// ⭐ `chain` IS REQUIRED, AND ONLY ARC IS ACCEPTED — this is the fail-closed boundary.
//
// An implicit-Arc endpoint would answer the wrong question confidently. Cross-chain deterministic
// deployments COLLIDE: Permit2, Multicall3, the Safe 1.3.0 singleton and CreateX all have real
// bytecode at the same address on Arc (measured). A caller asking about Permit2 while meaning
// Ethereum would receive a well-formed, correct-for-Arc report and could read it as being about the
// contract they meant. Forcing the caller to NAME the chain makes every response either explicitly
// correct or explicitly refused — never silently about the wrong chain.
//
// It also makes an existing hardcoded claim true by construction: shared/onchain-analyze/index.mjs
// states in `sources.note` that "every Arc provider syncs from the same permissioned validator set".
// That sentence is false on Base. Refusing every non-Arc chain here means it can never be attached
// to a report about a chain where it does not hold.
//
// scripts/dd/chains.mjs also knows `base` and `base-sepolia`. They stay REFUSED: the frozen service
// document says of any chain beyond Arc Testnet "reachable in principle, never exercised or
// verified", and an unexercised path must not first be exercised by an anonymous caller.
const SUPPORTED_CHAINS = Object.freeze(["arc-testnet"]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_BODY_BYTES = 4096;

const ARC_RPC = "https://rpc.testnet.arc.network";

/** Transport for the Gateway balance read. Injected into _dd-x402 / _x402-confirm so those modules
 *  stay testable without a chain, and so this file remains the only place that knows a URL. */
const rpcCall = async ({ method, params }) => {
  const r = await fetch(ARC_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
};

/**
 * A refusal that is a REPORT, not an error.
 *
 * Coverage is populated with EVERY power group in the shared catalogue, each marked not-checked with
 * the real reason — so a refusal satisfies the same completeness invariant a successful report does.
 * An empty coverage block would pass through assertReportValid as "coverage-incomplete", turning a
 * clean refusal into a second, confusing one.
 */
function refusalReport({ address = null, chainName = null, chainId = null, reason, detail, diagnostic = null }) {
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
  });
}

export async function handler(event) {
  const correlationId = randomUUID();
  try {
    if (event?.blobs) connectBlobs(event);

    // ── ⭐ RUNG -1: IS THIS SERVICE EVEN SUPPOSED TO ANSWER THE PUBLIC? ───────────────────────
    // FIRST — before the health check, before validation, before anything. Deploying this function
    // must NOT be the same act as publishing it: `/api/dd-analyze` is committed and Netlify has no
    // per-function deploy, so without this gate a routine `netlify deploy --prod` would stand up a
    // free public signed-attestation endpoint under agentId 851891 by accident.
    //
    // UNSET = DISABLED, and so is anything unrecognised. Deployed-but-inert is the default; serving
    // is the deliberate act. Cheapest possible check too — no blob read, no chain read, no analysis.
    {
      const exposure = exposureState();
      if (!exposure.enabled) {
        return json(503, refusalReport({
          reason: "service-not-enabled",
          detail: `${exposure.detail} (${exposure.reason}). The service is deployed but not published. Set DD_PUBLIC_ENABLED to enable it deliberately.`,
        }));
      }
    }

    // ── ⭐ RETRIEVE: redeem a handle for a report already paid for ────────────────────────────
    // Placed HERE on purpose: behind the exposure gate, but AHEAD of the health gate.
    //
    // · Behind exposure, because if the service was never published there can be no paid callers,
    //   and serving reports while "not published" would contradict the flag outright.
    // · AHEAD of health, because this report was ALREADY produced and paid for, back when the
    //   detector was known good. Re-checking health now would strand a paying caller on a canary
    //   blip that has nothing to do with the artifact they bought. The health gate guards the
    //   PRODUCTION of new answers, not the delivery of old ones.
    //
    // Also ahead of the POST check — a redemption is a retrieval, not a new question.
    {
      const q = event.queryStringParameters || {};
      const handle = q.handle || (event.headers || {})["x-payment-handle"];
      if (handle) {
        return await retrievePaid({ handle, store: getStore(PENDING_STORE), rpcCall });
      }
    }

    // ── ⭐ RUNG 0: IS THIS SERVICE KNOWN GOOD? ────────────────────────────────────────────────
    // FIRST, before anything else, so an unverified service is uniformly UNAVAILABLE rather than
    // selectively degraded. A detector that fails its own known-shape fixtures must not answer
    // questions about anyone else's contracts — a wrong confident answer is worse than no answer.
    //
    // This requires a POSITIVE, FRESH, VERSION-MATCHED pass. Absence, staleness, unreadability,
    // malformation and version drift all refuse. "No news is good news" is structurally impossible
    // here, which is the entire point: the last safety layer must not itself fail open.
    {
      const identity = codeIdentity({ schemaVersion: SCHEMA_VERSION, powerSigs: POWER_SIGS });
      const { record, readable } = await readHealth(identity);
      const health = evaluateHealth({ record, readable, now: Date.now(), expect: identity });
      if (!health.serve) {
        // ⭐ The identity evidence is INCLUDED, not discarded. evaluateHealth computes exactly what
        // an operator needs to diagnose a refusal — which fields differ, and the two identities side
        // by side — and forwarding only `reason` made a build-binding failure indistinguishable from
        // a stale record from outside. Diagnosing the "unknown"-build defect required this and it
        // was thrown away one line before it would have helped.
        //
        // Safe to expose: a schema version, a truncated catalogue hash, and a deploy/build id. No
        // secret, no key, no address, and nothing an attacker can act on — a caller who can reach
        // this endpoint already knows which deploy answered them.
        const ev = health.evidence ?? {};
        return json(503, refusalReport({
          reason: "service-unverified",
          detail: `${health.detail} (${health.reason}). The service is REFUSING TO SERVE rather than answering from a detector that is not known good. This is not a degraded result — it is no result.`,
          diagnostic: {
            healthReason: health.reason,
            ...(ev.mismatched ? { mismatchedFields: ev.mismatched } : {}),
            ...(ev.running ? { running: ev.running } : {}),
            ...(ev.recorded ? { recorded: ev.recorded } : {}),
            ...(ev.buildSources ? { buildSources: ev.buildSources } : {}),
            ...(ev.ageMs !== undefined ? { ageMs: ev.ageMs, ttlMs: ev.ttlMs } : {}),
          },
        }));
      }
    }

    // ── rung 1: method ────────────────────────────────────────────────────────────────────────
    if (event.httpMethod !== "POST") {
      return json(405, refusalReport({
        reason: "unsupported-method",
        detail: `this endpoint accepts POST; received ${event.httpMethod}`,
      }));
    }

    // ── rung 2: body ──────────────────────────────────────────────────────────────────────────
    const raw = event.body ?? "";
    if (raw.length > MAX_BODY_BYTES) {
      return json(400, refusalReport({ reason: "malformed-request", detail: `request body exceeds ${MAX_BODY_BYTES} bytes` }));
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(400, refusalReport({ reason: "malformed-request", detail: "request body is not valid JSON" }));
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return json(400, refusalReport({ reason: "malformed-request", detail: "request body must be a JSON object" }));
    }

    // ── rung 3: address ───────────────────────────────────────────────────────────────────────
    // Checked BEFORE analyze() rather than relying on it: analyze() throws on a bad address by
    // design, and that throw over the wire is a 500 with a stack instead of an answer.
    const { address, chain } = body;
    if (address === undefined || address === null || address === "") {
      return json(400, refusalReport({ reason: "invalid-address", detail: "`address` is required and was missing or empty" }));
    }
    if (typeof address !== "string" || !ADDRESS_RE.test(address.trim())) {
      return json(400, refusalReport({
        reason: "invalid-address",
        detail: "`address` must be a 0x-prefixed 20-byte hex string",
      }));
    }
    const addr = address.trim().toLowerCase();

    // ── rung 4: chain ─────────────────────────────────────────────────────────────────────────
    if (chain === undefined || chain === null || chain === "") {
      return json(400, refusalReport({
        address: addr,
        reason: "chain-not-specified",
        detail: `\`chain\` is required — an address alone does not identify a chain, and the same address holds different code on different chains. Supported: ${SUPPORTED_CHAINS.join(", ")}`,
      }));
    }
    if (typeof chain !== "string" || !SUPPORTED_CHAINS.includes(chain)) {
      return json(400, refusalReport({
        address: addr,
        chainName: typeof chain === "string" ? chain : null,
        reason: "unsupported-chain",
        detail: `this service analyzes ${SUPPORTED_CHAINS.join(", ")} only; refusing ${JSON.stringify(chain)}. Any other chain is unexercised and unverified here, and answering anyway would be a confident answer about something never tested.`,
      }));
    }

    // ── rung 5: is there a revenue address to be paid? ────────────────────────────────────────
    // Checked BEFORE the 402 so we never quote a price payable to nowhere. Fail-closed: an unset
    // payTo refuses the request rather than silently downgrading a paid service to a free one.
    const payToResolution = resolvePayTo();
    if (!payToResolution.ok) {
      console.error(`[dd-analyze ${correlationId}] payTo unresolved: ${payToResolution.reason}`);
      return json(503, refusalReport({
        address: addr,
        chainName: chain,
        reason: "payment-misconfigured",
        detail: `${payToResolution.detail} (${payToResolution.reason})`,
      }));
    }

    // ── the analysis, as a thunk ──────────────────────────────────────────────────────────────
    // NOT run here. It is handed to runThenSettle(), which guarantees it runs BEFORE anything
    // touches money — that ordering is the product, and it is enforced structurally rather than by
    // this file remembering to do it in the right order.
    //
    // Wrapped: analyze() reserves exceptions for programmer error, but this caller is untrusted, so
    // an unexpected throw must become a report rather than a stack trace. It returns a REFUSAL
    // report, which the settle gate then declines to charge for — an outage bills nothing.
    const produceReport = async () => {
      let report;
      try {
        report = await analyze(addr, { client: chainClient(chain) });
      } catch (e) {
        console.error(`[dd-analyze ${correlationId}] analyze threw:`, e);
        return refusalReport({
          address: addr,
          chainName: chain,
          reason: "internal-error",
          detail: `the analysis could not run. This is INDETERMINATE, not a clean bill. Reference: ${correlationId}`,
        });
      }

      // ── attestation: sign, but DEGRADE rather than fail ─────────────────────────────────────
      // A signer outage must not destroy an otherwise-good report. `attestation.status` already
      // models the unsigned case, which is exactly why it is a status field and not a promise.
      try {
        return await attachAttestation(report, ddAttestationOptions());
      } catch (e) {
        console.error(`[dd-analyze ${correlationId}] signing failed:`, e);
        return {
          ...report,
          attestation: unsignedAttestation(`the report is complete but could not be signed on this run. Reference: ${correlationId}`),
        };
      }
    };

    // ── rung 6: payment ───────────────────────────────────────────────────────────────────────
    const headers = event.headers || {};
    const proto = headers["x-forwarded-proto"] || "https";
    const host = headers["host"] || "";
    const resource = `${proto}://${host}${event.path || "/api/dd-analyze"}`;
    const requirements = ddPaymentRequirements({ resource, payTo: payToResolution.payTo });

    const paymentHeader = headers["payment-signature"];
    if (!paymentHeader) return challenge402({ requirements });

    let payload;
    try {
      payload = b64decodePayment(paymentHeader);
    } catch {
      return json(400, refusalReport({
        address: addr,
        chainName: chain,
        reason: "malformed-payment",
        detail: "the payment-signature header is not base64-encoded JSON",
      }));
    }

    return await runPaidAnalysis({
      facilitator: new BatchFacilitatorClient(),
      rpcCall,
      store: getStore(PENDING_STORE),
      payload,
      requirements,
      produceReport,
      resource,
    });
  } catch (e) {
    // Last resort. The real error goes to logs; the caller gets a report and a reference, never a
    // stack, a path, or a message we did not choose.
    console.error(`[dd-analyze ${correlationId}] unhandled:`, e);
    return json(500, refusalReport({
      reason: "internal-error",
      detail: `the request could not be processed. Reference: ${correlationId}`,
    }));
  }
}

export const _internals = { SUPPORTED_CHAINS, ADDRESS_RE, MAX_BODY_BYTES, SCHEMA_VERSION };
