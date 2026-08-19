import { baseReport } from "../../shared/onchain-analyze/schema.mjs";

// _dd-descriptor — the ONE place the service describes WHERE it lives and WHAT it accepts.
//
// ═══ 🚨 WHY THESE ARE SHARED CONSTANTS ═══════════════════════════════════════════════════════
// Three surfaces now state the resource URL and the supported chains: the 405's `howToCall`, the
// HTML discovery page, and the OpenAPI document. Three copies of one fact is the
// duplicate-source-of-truth failure this repo keeps meeting — and it is worse here than usual,
// because these are the strings a stranger COPIES. A drifted URL in one of them sends a reader to
// a 404 and they conclude the service is broken.
//
// ⚠️ MEASURED PRECEDENT: `agentClient.ts` pointed at `/api/dca-create` for 22 days while
// netlify.toml declared no such route. A published address nobody fetched.
//
// ⭐ SUPPORTED_CHAINS LIVES HERE, NOT IN dd-analyze. The endpoint validates against it and every
// descriptor advertises from it, so a curl example can never name a chain the endpoint would
// reject — the example and the validator cannot disagree because they read the same array.

export const SUPPORTED_CHAINS = Object.freeze(["arc-testnet"]);

// ═══ ⭐ THE CALL SHAPE — ONE DEFINITION, THREE PLACES IT IS PUBLISHED ═══════════════════════════
// The OpenAPI document, the 402 challenge, and the 400 refusal all have to tell an agent how to
// phrase a call. 🚨 A HAND-WRITTEN COPY IN THE 402 WOULD BE A SECOND SOURCE OF TRUTH FOR THE THING
// AGENTS CALL US WITH — the worst possible field to let drift, because a stale copy teaches an
// agent to build a request the endpoint then refuses, and the agent has no way to know which of the
// two descriptions is current. So the schema lives HERE, beside SUPPORTED_CHAINS, and the enum is
// literally that array rather than a restatement of it: the description and the validator cannot
// disagree because they read the same constant.
export const DD_REQUEST_SCHEMA = Object.freeze({
  type: "object",
  required: ["address", "chain"],
  properties: {
    address: {
      type: "string",
      pattern: "^0x[0-9a-fA-F]{40}$",
      description: "the subject: a 0x-prefixed 20-byte address",
    },
    chain: {
      type: "string",
      enum: [...SUPPORTED_CHAINS],
      description:
        "⚠️ REQUIRED. An address alone does not identify a chain — the same address holds " +
        "different code on different chains.",
    },
  },
  additionalProperties: false,
});

// ⚠️ DESCRIPTIONS ARE HAND-WRITTEN — they have to be — BUT COMPLETENESS IS NOT. The key set below
// is asserted against the real report skeleton at import (see the check at the foot of this file),
// so a field added to the report and forgotten here fails loudly instead of shipping a description
// that quietly under-describes what we return. Same instinct as the coverage manifest: the document
// is generated-adjacent, not hopeful.
export const DD_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  description:
    "The signed report. ⚠️ A COVERAGE MANIFEST, NOT A CLEAN BILL — `coverage.notChecked` is as " +
    "load-bearing as `coverage.checked`, and absence of a finding is never absence of risk.",
  properties: {
    schemaVersion: { type: "string", description: "report schema version; changes when the shape changes" },
    severityMeaning: { type: "object", description: "⭐ SCOPE, NOT RANK: severity describes what a power CAN DO. It is never a score and does not order risks." },
    subject: { type: "object", description: "the address, chain and block the report is about" },
    shape: { type: "object", description: "how the subject was classified (proxy, diamond, plain, unknown) and the evidence for it" },
    powers: { type: "array", description: "each power group the catalogue knows about, and what was observed for it" },
    coverage: {
      type: "object",
      description:
        "⭐ THE LOAD-BEARING FIELD. `checked` / `notChecked` / `totals` / `summary`, generated from " +
        "what actually ran. Every group in the catalogue appears in exactly one list — a group that " +
        "is neither run nor skipped makes the report INVALID rather than clean.",
    },
    reads: { type: "array", description: "the RPC reads performed, with endpoint and retry counts — the audit trail behind the manifest" },
    refusal: { type: ["object", "null"], description: "non-null when the request was refused before or during analysis; the reason is stated, never implied by an empty result" },
    attestation: { type: "object", description: "ERC-1271 signature verifiable against the on-chain owner of ERC-8004 agentId 851891, or {status:\"unsigned\"} — an unsigned report is NEVER charged for" },
  },
});

/** The canonical, redirect-backed path. ⚠️ NOT `/.netlify/functions/…` — that works but is not the
 *  address we publish, and a reader who copies it inherits an implementation detail. */
export const DD_RESOURCE_URL = "https://app.tikpema.xyz/api/dd-analyze";

/** ⚠️ MUST RESOLVE. Asserted post-deploy, because a published URL nobody fetched is the DCA bug.
 *
 * ⭐ CANONICAL PATH IS `/openapi.json` — the location discovery tooling looks for. `/api/dd-openapi`
 * still serves the same document and is NOT removed: it has been published, and a URL that has been
 * published is a promise.
 *
 * 🚨 `/openapi.json` ALREADY RETURNED HTTP 200 BEFORE THIS ROUTE EXISTED — the SPA catch-all
 * (`/*` → /index.html, 200) answers every unmatched path, so a nonexistent path and a working spec
 * are INDISTINGUISHABLE BY STATUS CODE. Measured: `/definitely-not-a-real-path-9f3a.json` also
 * returns 200 text/html. Any check that asks "does it 200?" passes on a route that does not exist
 * and serves a web page to a parser expecting JSON. The gate therefore asserts CONTENT-TYPE and
 * PARSEABILITY — see scripts/verify-api-routes.mjs. */
export const DD_OPENAPI_URL = "https://app.tikpema.xyz/openapi.json";

/** The same document, at the path it was originally published under. Kept working forever. */
export const DD_OPENAPI_URL_LEGACY = "https://app.tikpema.xyz/api/dd-openapi";

/** ⭐ HUMAN-READABLE DOCS, AT A REAL 200. `externalDocs.url` has to be something a person or an
 *  agent can actually open. The obvious candidates both failed: the repository README does not
 *  mention this service at all, and `GET /api/dd-analyze` renders the right page but under HTTP 405
 *  (correct for the API — the method IS unsupported — and wrong for a documentation link an agent
 *  may treat as a failure). So the discovery page is also served here, at 200, by the same function
 *  that serves the spec. No new function, no new content: one page, two entry points. */
export const DD_DOCS_URL = "https://app.tikpema.xyz/dd";

/** A REAL contract on the supported chain (Arc testnet USDC), so a copied example returns a real
 *  report rather than a placeholder that 400s. */
export const DD_SAMPLE_ADDRESS = "0x3600000000000000000000000000000000000000";
export const DD_SAMPLE_ADDRESS_IS =
  "Arc testnet USDC — a real contract, so the sample returns a real report";

/**
 * ⭐⭐ THE CONTENT-NEGOTIATION RULE, IN ONE PLACE AND FAIL-SAFE TOWARD JSON.
 *
 * 🚨 THE FAILURE THAT MATTERS IS SERVING HTML TO A MACHINE. This is a money endpoint; a client that
 * receives a web page where it expected data is exactly the case `readJson` was written to catch
 * ("returned a web page instead of data"). So HTML requires an EXPLICIT `text/html` in Accept, and
 * everything else — including a WILDCARD accept, an absent header, and anything unparseable — gets JSON.
 *
 * ⚠️ THE WILDCARD MUST NOT MATCH. curl sends a wildcard Accept by default and fetch() sends nothing;
 * both are
 * machines and both must get JSON. A naive "does Accept allow html" check would hand a page to
 * every curl in the world.
 */
export function wantsHtml(headers = {}) {
  const raw = headers.accept ?? headers.Accept ?? headers.ACCEPT ?? "";
  if (typeof raw !== "string") return false;
  // Word-boundary match on the exact type. `*/*` has no "text/html" in it, so it falls through.
  return /(^|[,\s])text\/html\b/i.test(raw);
}

// ═══ 🚨 COMPLETENESS INVARIANT — ASSERTED AT IMPORT ════════════════════════════════════════════
// The response schema's key set must EXACTLY equal the real report skeleton's. Descriptions can
// only be written by hand; whether every field HAS one cannot be left to hand. A report that grows
// a field would otherwise ship a public description that silently under-describes what we return —
// and an agent building against it would never learn about the field it was not told about.
// ⭐ Both directions are checked: a missing key means we under-describe, an extra key means we
// describe something we do not return, and the second is the one nobody would ever notice.
{
  const real = Object.keys(baseReport({ address: "0x0", chainId: 0, chainName: "x", blockNumber: null })).sort();
  const described = Object.keys(DD_RESPONSE_SCHEMA.properties).sort();
  const missing = real.filter((k) => !described.includes(k));
  const extra = described.filter((k) => !real.includes(k));
  if (missing.length || extra.length) {
    throw new Error(
      "_dd-descriptor: DD_RESPONSE_SCHEMA drifted from the report skeleton — " +
      (missing.length ? `undescribed field(s): ${missing.join(", ")}. ` : "") +
      (extra.length ? `described but not returned: ${extra.join(", ")}.` : "")
    );
  }
}
