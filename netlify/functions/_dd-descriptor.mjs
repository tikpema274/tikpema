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

/** The canonical, redirect-backed path. ⚠️ NOT `/.netlify/functions/…` — that works but is not the
 *  address we publish, and a reader who copies it inherits an implementation detail. */
export const DD_RESOURCE_URL = "https://app.tikpema.xyz/api/dd-analyze";

/** ⚠️ MUST RESOLVE. Asserted post-deploy, because a published URL nobody fetched is the DCA bug. */
export const DD_OPENAPI_URL = "https://app.tikpema.xyz/api/dd-openapi";

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
