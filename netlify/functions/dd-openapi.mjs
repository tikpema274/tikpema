import { json } from "./_arc.mjs";
import { DD_PRICE_HUMAN, DD_PRICE_ATOMIC } from "./_dd-x402.mjs";
import { SUPPORTED_CHAINS, DD_RESOURCE_URL, DD_OPENAPI_URL } from "./_dd-descriptor.mjs";

// dd-openapi — the machine-readable description of the DD service.
//
// ═══ 🚨 WHY THIS EXISTS AS A REAL DOCUMENT, NOT A FIELD ══════════════════════════════════════
// `howToCall.openApiUrl` has to point at something that RESOLVES. Two hours before this was
// written, `agentClient.ts` was found pointing at `/api/dca-create` — a route that never existed —
// and the DCA panel had been 404ing for 22 days. Publishing a URL we have not fetched is that same
// bug with a longer fuse, and a listing that dereferences a dead openApiUrl fails silently on
// someone else's machine.
//
// ⭐ SO: a real OpenAPI 3.1 document, served at a real path, asserted to resolve by the same
// post-deploy check that caught the DCA flip.
//
// ⚠️ SCOPE HONESTLY STATED: this describes the endpoint's SHAPE. It is not a Circle Discovery
// listing envelope — the exact field names that registry wants could NOT be verified against
// Circle's published docs at the time of writing (searched: x402, discovery, marketplace metadata),
// so nothing here claims to satisfy a schema nobody here has read. `openApiUrl` is the standard
// OpenAPI convention and is correct on its own terms; whether a listing wants exactly that key is
// UNVERIFIED and must be checked before submitting anywhere.
//
// ⚠️ READ-ONLY AND UNAUTHENTICATED, deliberately: a description of a paid endpoint is not itself
// paid, and requiring a session to learn how to call it would rebuild the discovery gap one layer
// down.

export async function handler(event) {
  if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") {
    return json(405, { error: "GET only", detail: "this is a static description document" });
  }

  return json(200, {
    openapi: "3.1.0",
    info: {
      title: "Tikpema DD — on-chain due diligence",
      version: "0.2.0",
      summary: "One signed due-diligence report about an address, with an honest coverage manifest.",
      description:
        "Paid per call over x402 (EIP-3009 on Arc). POST without payment to receive the 402 " +
        "challenge, which carries the full terms: what you are buying, the coverage floor, why the " +
        "price does not scale with coverage, and a subjectPreview telling you BEFORE you pay " +
        "whether the subject has contract code at all.\n\n" +
        "⚠️ THE REPORT IS A COVERAGE MANIFEST, NOT A CLEAN BILL. A report that could check little " +
        "still settles and is still the product: it states exactly what was and was not checked, " +
        "and that manifest is inside the signed payload so it cannot be stripped.",
    },
    servers: [{ url: "https://app.tikpema.xyz" }],
    paths: {
      "/api/dd-analyze": {
        post: {
          operationId: "analyzeAddress",
          summary: "Buy one signed due-diligence report",
          description:
            `Costs ${DD_PRICE_HUMAN} (${DD_PRICE_ATOMIC} atomic USDC). Call WITHOUT an ` +
            "X-PAYMENT header to receive the 402 challenge and the full terms.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
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
                        "⚠️ REQUIRED. An address alone does not identify a chain — the same " +
                        "address holds different code on different chains.",
                    },
                  },
                },
                example: { address: "0x3600000000000000000000000000000000000000", chain: SUPPORTED_CHAINS[0] },
              },
            },
          },
          responses: {
            200: {
              description:
                "The signed report. Carries `coverage` (checked / notChecked / totals / summary), " +
                "`severityMeaning` (scope-not-rank: severity describes what a power CAN DO, it is " +
                "never a score), and an ERC-1271 `attestation` verifiable against the on-chain " +
                "owner of ERC-8004 agentId 851891.",
            },
            400: { description: "Refused before analysis. Returned AS A REPORT with an empty coverage manifest — not an error envelope." },
            402: { description: "Payment required. Body carries `accepts`, `whatYouAreBuying` and `subjectPreview`." },
            405: { description: "Wrong method. Carries `howToCall` with a runnable example; returns HTML instead if the request Accepts text/html." },
            503: { description: "Refusing to serve: the deployed code hash has no canary attestation yet, or the service is not published." },
          },
        },
        get: {
          operationId: "describeService",
          summary: "Discovery — how to call this endpoint",
          description:
            "Returns 405 (the method IS unsupported) carrying `howToCall`. With `Accept: text/html` " +
            "it returns a human-readable page instead of JSON.",
          responses: { 405: { description: "howToCall, as JSON or HTML by content negotiation." } },
        },
      },
    },
    "x-tikpema": {
      // ⭐ Namespaced under x- so it cannot be mistaken for a standard OpenAPI field, and cannot
      // collide with whatever a registry later requires.
      resource: DD_RESOURCE_URL,
      openApiUrl: DD_OPENAPI_URL,
      price: DD_PRICE_HUMAN,
      priceAtomicUsdc: DD_PRICE_ATOMIC,
      priceIsFlat: "deliberately does not scale with coverage — a coverage-scaled price would pay us more for CLAIMING more coverage",
      paymentProtocol: "x402 (EIP-3009 on Arc)",
      attestation: "ERC-1271 against the on-chain owner of ERC-8004 agentId 851891",
      supportedChains: [...SUPPORTED_CHAINS],
    },
  });
}
