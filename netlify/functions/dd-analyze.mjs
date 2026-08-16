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
  readSubjectCode,
  subjectPreview,
  DD_PRICE_HUMAN,
} from "./_dd-x402.mjs";
import {
  SUPPORTED_CHAINS, DD_RESOURCE_URL, DD_OPENAPI_URL, DD_SAMPLE_ADDRESS, DD_SAMPLE_ADDRESS_IS,
  wantsHtml,
} from "./_dd-descriptor.mjs";
import { discoveryPage } from "./_dd-discovery-page.mjs";
// ⭐⭐ THE LADDER IS NOT DEFINED HERE ANY MORE — see _dd-rungs.mjs. This handler climbs the SAME
// ordered rungs the in-app report route climbs, and names the ones it does not (none: the paid path
// runs every gate). The report producer is shared too, which is what makes the in-app card's policy
// evaluate an artifact a buyer could independently verify.
import {
  RUNG, runLadder, refusalReport, makeProduceReport, newCorrelationId,
  ADDRESS_RE, MAX_BODY_BYTES,
} from "./_dd-rungs.mjs";
import { SCHEMA_VERSION } from "../../shared/onchain-analyze/schema.mjs";

// ⭐ RE-EXPORTED, NOT RE-DEFINED. These moved to _dd-rungs.mjs so both entry points share one copy;
// the re-export keeps every existing importer (and every test that asserts on them) pointing at the
// single implementation rather than at a second one that would drift.
export { escalateProviderIntegrity, isSystemicReadFailure, refusalReport } from "./_dd-rungs.mjs";

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
// ⭐ MOVED to _dd-descriptor.mjs: the endpoint validates against it and every descriptor (405
// JSON, HTML page, OpenAPI) advertises from it, so an example can never name a chain the
// endpoint would reject — they cannot disagree because they read the same array.

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

export async function handler(event) {
  const correlationId = newCorrelationId();
  try {
    if (event?.blobs) connectBlobs(event);

    // ══ ⭐⭐ THE LADDER — CLIMBED FROM _dd-rungs.mjs, NOT RE-IMPLEMENTED HERE ══════════════════
    //
    // The paid path skips NOTHING: it runs every gate in `LADDER`, in the order defined there. That
    // order and its reasoning (exposure first, retrieve ahead of health, health before validation)
    // now live in ONE array that the in-app report route climbs too, so the two cannot drift into
    // checking different things while both keep returning well-formed reports.
    //
    // ⚠️ The discovery decoration on a non-POST is passed in rather than moved: the REFUSAL is
    // shared, the marketing surface hung off it is this endpoint's alone. See decorateMethodRefusal.
    const climbed = await runLadder({
      event,
      skip: [],
      deps: {
        retrieve: (handle) => retrievePaid({ handle, store: getStore(PENDING_STORE), rpcCall }),
        resolvePayTo: () => {
          const r = resolvePayTo();
          if (!r.ok) console.error(`[dd-analyze ${correlationId}] payTo unresolved: ${r.reason}`);
          return r;
        },
        decorateMethodRefusal: (refusal, ev) => {
          // ═══ 🚨 CONTENT NEGOTIATION — JSON IS THE DEFAULT, ALWAYS ═══════════════════════════
          // A human gets a page; a machine gets the JSON refusal UNCHANGED. The failure that matters
          // is the reverse: serving HTML to a client expecting data is exactly what `readJson` was
          // written to catch. So HTML requires an EXPLICIT `text/html`, and `*/*` (curl's default), an
          // absent header, and anything unparseable all fall through to JSON. See wantsHtml().
          // ⚠️ THE STATUS STAYS 405 for both. The method IS unsupported; a 200 would be a nicer lie,
          // and browsers render the body regardless.
          if (wantsHtml(ev.headers ?? {})) {
            return {
              statusCode: 405,
              headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
              body: discoveryPage({ method: ev.httpMethod }),
            };
          }
          // ═══ ⭐ THE DISCOVERY GAP ══════════════════════════════════════════════════════════
          // A refusal that says what was wrong and nothing about how to be right leaves asking
          // someone as the only route to a working call. `howToCall` closes that with one field.
          // ⚠️ THE REFUSAL ITSELF IS UNCHANGED — this ADDS a field; it softens no claim.
          // ⭐⭐ THE PRICE IS IMPORTED, NEVER RESTATED (DD_PRICE_HUMAN lives beside the atomic value
          // the 402 charges), and the terms are POINTED AT rather than paraphrased into a second
          // copy that would drift.
          return json(405, {
            ...refusal,
            howToCall: {
              resource: DD_RESOURCE_URL,
              method: "POST",
              contentType: "application/json",
              body: { address: "0x<20-byte hex>", chain: SUPPORTED_CHAINS[0] },
              // ⚠️ MUST RESOLVE — a published URL nobody fetched is the DCA bug with a longer fuse.
              openApiUrl: DD_OPENAPI_URL,
              humanReadable: "the same URL with `Accept: text/html` returns a page instead of this JSON",
              curl:
                `curl -sS -X POST ${DD_RESOURCE_URL} ` +
                "-H 'Content-Type: application/json' " +
                `-d '{"address":"${DD_SAMPLE_ADDRESS}","chain":"${SUPPORTED_CHAINS[0]}"}'`,
              // ⚠️ A REAL address on the supported chain (Arc USDC), so the sample is a call that
              // actually returns a report rather than a placeholder that 400s.
              sampleAddressIs: DD_SAMPLE_ADDRESS_IS,
              supportedChains: SUPPORTED_CHAINS,
              price: DD_PRICE_HUMAN,
              youGet:
                "one signed on-chain due-diligence report, with an HONEST COVERAGE MANIFEST of what was " +
                "and was not checked, attested via ERC-1271 against the on-chain owner of ERC-8004 " +
                "agentId 851891.",
              fullTerms:
                "POST the call above WITHOUT payment: the 402 response carries `whatYouAreBuying` — the " +
                "coverage floor, why the price does not scale with coverage, and `subjectPreview`, " +
                "which tells you BEFORE paying whether your subject has contract code at all.",
              paymentProtocol: "x402 (EIP-3009 on Arc); the 402 body's `accepts` carries the requirements.",
            },
          });
        },
      },
    });
    if (climbed.done) return climbed.done;
    const { addr, chain, payTo } = climbed;

    // ── the analysis, as a thunk ──────────────────────────────────────────────────────────────
    // NOT run here. It is handed to runThenSettle(), which guarantees it runs BEFORE anything
    // touches money — that ordering is the product, and it is enforced structurally rather than by
    // this file remembering to do it in the right order.
    //
    // ⭐⭐ AND IT IS THE SHARED PRODUCER. Quorum, the systemic-failure refusal, the provider-integrity
    // escalation and the attestation all live in _dd-rungs.mjs, so the report the in-app card hands
    // to evaluatePolicy is byte-for-byte the artifact a buyer receives. A shared ladder feeding two
    // different producers would still have let the two diverge on the thing that actually matters.
    const produceReport = makeProduceReport({ addr, chain, correlationId });

    // ── rung 6: payment ───────────────────────────────────────────────────────────────────────
    const headers = event.headers || {};
    const proto = headers["x-forwarded-proto"] || "https";
    const host = headers["host"] || "";
    const resource = `${proto}://${host}${event.path || "/api/dd-analyze"}`;
    const requirements = ddPaymentRequirements({ resource, payTo });

    const paymentHeader = headers["payment-signature"];
    if (!paymentHeader) {
      // ⭐ ONE eth_getCode, so the buyer learns which coverage case THEY are in before paying —
      // the thin outcome is fully determined by the subject, and we already know the subject here.
      //
      // 🚨 THIS MUST NEVER BLOCK THE 402. The challenge is free, and refusing to quote because a
      // diagnostic read failed would trade a real capability for an observation — the same rule the
      // quote record and the bridge receipt write follow. readSubjectCode never throws; a failure
      // resolves to UNREADABLE, which the preview renders as an explicit UNKNOWN rather than as
      // either reassurance or alarm.
      const code = await readSubjectCode({ rpcCall, address: addr });
      return challenge402({
        requirements,
        preview: subjectPreview({ address: addr, code }),
      });
    }

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
