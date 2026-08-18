import { json } from "./_arc.mjs";
import { DD_PRICE_HUMAN, DD_PRICE_ATOMIC, DD_PRICE_DECIMAL } from "./_dd-x402.mjs";
import {
  SUPPORTED_CHAINS, DD_RESOURCE_URL, DD_OPENAPI_URL, DD_OPENAPI_URL_LEGACY, DD_DOCS_URL,
} from "./_dd-descriptor.mjs";
import { discoveryPage } from "./_dd-discovery-page.mjs";

// ⚠️ CONTACT EMAIL IS PUBLISHED TO THE WORLD. Circle asks for info.contact.email so an agent or a
// human can reach someone. It is deliberately a named constant rather than inlined, because the
// value is a DECISION about what identity to expose — a personal address in a public spec is
// scraped forever — and a decision should be visible in one place, not buried in a document.
const DD_CONTACT_EMAIL = "hello@tikpema.xyz";

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

  // ⭐ SAME FUNCTION, TWO AUDIENCES. `/dd` and an `Accept: text/html` request get the human
  // discovery page at HTTP 200 — the page `GET /api/dd-analyze` already renders, but under 405,
  // which is right for the API and wrong for a link in externalDocs. No second function, no second
  // copy of the content: the page is imported, not restated.
  const accept = String(event.headers?.accept || event.headers?.Accept || "");
  const wantsHtml = /text\/html/i.test(accept) || event.path === "/dd";
  if (wantsHtml) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      body: discoveryPage({ method: "GET" }),
    };
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

      // ⭐ THE HIGHEST-LEVERAGE TEXT IN THIS DOCUMENT — it is what plain-language discovery
      // (`circle services search`) matches a buyer's question against. Written as a BUYER WOULD ASK
      // ("can this contract's owner withdraw my deposit?"), never as the engine describes itself:
      // nobody searches for "enumerate POWER_SIGS against EIP-1967 bytecode".
      //
      // ⚠️ "Arc testnet" APPEARS THREE TIMES, INCLUDING THE FIRST SENTENCE. An agent hunting a
      // MAINNET service must bounce off this before paying, not after. SUPPORTED_CHAINS is
      // ["arc-testnet"] and the text must not round that up to "Arc".
      //
      // ⭐ THE PRICE IS HERE *AND* IN x-payment-info — A DELIBERATE DUPLICATE, NOT AN OVERSIGHT.
      // Circle's own example query is "weather forecast API under $0.01", so price is part of the
      // match surface and a listing that omits it loses those searches. The drift risk is closed by
      // interpolating DD_PRICE_HUMAN instead of retyping the figure: one definition in code, two
      // appearances in the rendered document.
      //
      // ⚠️ EVERY QUESTION BELOW MAPS TO A CHECK THE ENGINE ACTUALLY RUNS (POWER_SIGS +
      // classifyOwnerType). Nothing is aspirational — a listing that advertises a check the engine
      // does not perform is a refund request with extra steps.
      "x-guidance":
        "Use this before you put funds into a contract on Arc testnet, to find out what its owner " +
        "can still do to you afterwards. Arc testnet only — not a mainnet service.\n\n" +
        "It answers questions like: can this contract's owner withdraw or sweep my deposit? Can " +
        "they pause the contract so I can't get out? Can they upgrade the code after I've " +
        "deposited, so what I audited is not what runs? Can they blacklist my address or block my " +
        "withdrawal? Can they raise the fees once I'm in? Is there a delay before I can withdraw? " +
        "Who actually controls it — a multisig, a timelock, or one person's private key? Has " +
        "ownership really been renounced, or does it just look that way?\n\n" +
        "Give it a contract address on Arc testnet. You get back a signed report naming which of " +
        "those powers the contract actually has, who holds them, and — for each power — whether it " +
        "was confirmed present, confirmed absent, or could not be determined.\n\n" +
        "It does not tell you a contract is safe. It tells you what was checked and what was not. " +
        "A report where little could be checked still costs the same and is still the answer: the " +
        "list of what it could not determine is part of the signed payload and cannot be stripped " +
        "out. Absence of a finding is never reported as absence of risk.\n\n" +
        `Scope: Arc testnet contracts, read-only, one address per call, ${DD_PRICE_HUMAN}. It does ` +
        "not audit source code, simulate transactions, price tokens, or score anything out of ten.",
      contact: { name: "Tikpema", email: DD_CONTACT_EMAIL, url: DD_DOCS_URL },
    },
    externalDocs: {
      // ⚠️ A DOCS LINK MUST RESOLVE AT 200. See DD_DOCS_URL for why neither the repository README
      // nor the 405-rendered discovery page was usable as-is.
      url: DD_DOCS_URL,
      description: "Human-readable service page: what you are buying, the coverage floor, and a runnable curl.",
    },
    servers: [{ url: "https://app.tikpema.xyz" }],
    paths: {
      "/api/dd-analyze": {
        post: {
          operationId: "analyzeAddress",
          summary: "Buy one signed due-diligence report",

          // ═══ ⭐ x-payment-info — WHAT MAKES THIS OPERATION MACHINE-PAYABLE ════════════════════
          // `amount` is DD_PRICE_DECIMAL: derived from the atomic value with trailing zeros KEPT
          // ("0.060000"), which is a different rule from the human rendering that trims them
          // ("$0.06 USDC"). Both come from one literal — see _dd-x402.mjs. ⚠️ NOT copied from
          // Circle's "0.010000" example: a sample price pasted into a live listing is a service
          // advertising a price it will not honour, and the 402 challenge would contradict it.
          //
          // ⚠️ ONE PROTOCOL ENTRY, NOT TWO. Circle notes that offering x402 AND mpp widens who can
          // pay. Only x402 is declared because only x402 is IMPLEMENTED — the 402 challenge, the
          // EIP-3009 authorization and the settle-gate are all x402. Declaring `mpp: {}` would
          // widen the audience to include buyers this service would then fail, which is worse than
          // being narrow. Add it when there is a WWW-Authenticate: Payment path that actually works.
          "x-payment-info": {
            price: { mode: "fixed", currency: "USDC", amount: DD_PRICE_DECIMAL },
            protocols: [{ x402: {} }],
          },
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
      // ⚠️ The path this document was first published under. It still serves the same document and
      // will keep doing so — a URL that has been published is a promise, and the cost of honouring
      // it is one redirect line.
      openApiUrlLegacy: DD_OPENAPI_URL_LEGACY,
      docsUrl: DD_DOCS_URL,
      price: DD_PRICE_HUMAN,
      priceAtomicUsdc: DD_PRICE_ATOMIC,
      priceIsFlat: "deliberately does not scale with coverage — a coverage-scaled price would pay us more for CLAIMING more coverage",
      paymentProtocol: "x402 (EIP-3009 on Arc)",
      attestation: "ERC-1271 against the on-chain owner of ERC-8004 agentId 851891",
      supportedChains: [...SUPPORTED_CHAINS],
    },
  });
}
