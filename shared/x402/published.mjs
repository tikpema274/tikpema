// published.mjs — THE CHAIN AND ASSET EVERY 402 CHALLENGE WE HAVE PUBLISHED NAMES. What buyers were TOLD.
//
// ═══ ⭐ DISTINCT FROM `ARC` (the chain we RUN on) — AND THAT DISTINCTION IS THE WHOLE POINT ═════════
// A seller's 402 challenge publishes a CAIP-2 network and an asset address to a paying buyer. Those two
// strings are also in the directory listings, the OpenAPI, and the registered identity metadata. If the
// runtime chain moved (a mainnet flip, a typo in _arc.mjs) and the challenge simply DERIVED its network
// from the runtime, the seller would silently advertise a different chain to buyers who were told
// another — and settle their money there. So the runtime is DERIVED (one source per package) and the
// published pair is PINNED here, and `assertPublishedOffer` refuses to boot the seller when they differ.
//
// A refusal here is never a defect to route around: it is the sentence "the offer changed" waiting for
// a person to change the OFFER — this file, the listings, the OpenAPI, the identity — on purpose. On
// a mainnet flip this file is the conscious acknowledgement; without it every seller refuses to boot.
//
// ═══ HISTORY ════════════════════════════════════════════════════════════════════════════════════
// Until phase B of the mainnet go/no-go (§1 row 1) this pin existed as THREE copies of one literal —
// x402-quote.mjs, x402-vanilla-seller.mjs, _dd-x402.mjs — each with its own error text. Three copies of
// a pin drift exactly like three copies of a value (see version.mjs for the same lesson with the
// protocol version). Now one shape, one sentence, one file.
//
// ═══ ⭐ THIS FILE IS ON THE DD SURFACE (DD_SURFACE_FILES in scripts/stamp-build.mjs) — BY DECISION ══
// _dd-x402.mjs imports it, so dd-analyze reaches it, and the rule is "nothing dd-analyze runs is outside
// the code-identity hash". A change to what the DD service TELLS BUYERS it settles on IS a change to
// the artefact's identity — a buyer's verifier must be able to tell a report sold under one published
// offer from a report sold under another. So an edit here rotates ddTree and opens a refusal window,
// and that is the correct cost: it is the same cost every other buyer-facing DD file already carries.
// [[dd-surface-comments-are-load-bearing]] — including this comment.

export class PublishedOfferError extends Error {
  constructor(message) { super(message); this.name = "PublishedOfferError"; }
}

/** The published offer. Changed WITH the offer (listings, OpenAPI, identity), never with the runtime. */
export const PUBLISHED_OFFER = Object.freeze({
  network: "eip155:5042002",                              // Arc Testnet, CAIP-2
  asset: "0x3600000000000000000000000000000000000000",   // USDC on Arc (FiatTokenV2)
});

const lower = (v) => (v == null ? v : String(v).toLowerCase());

/**
 * Refuse unless the runtime pair EQUALS the published pair. Throws PublishedOfferError naming the caller,
 * every field that differs, and both values. An absent runtime value is a difference, never a pass.
 * Asset compares case-insensitively (a checksummed and a lower-cased address are one token).
 * @param {{ network: string, asset: string, who: string }} p
 */
export function assertPublishedOffer({ network, asset, who } = {}) {
  const diffs = [];
  if (network !== PUBLISHED_OFFER.network) diffs.push(`network=${String(network)} (published ${PUBLISHED_OFFER.network})`);
  if (lower(asset) !== PUBLISHED_OFFER.asset) diffs.push(`asset=${String(asset)} (published ${PUBLISHED_OFFER.asset})`);
  if (diffs.length) {
    throw new PublishedOfferError(
      `${who ?? "seller"}: published chain/asset changed — ${diffs.join("; ")}. ` +
      `The runtime moved but the OFFER did not: update shared/x402/published.mjs WITH the listings, the OpenAPI and the identity, on purpose.`
    );
  }
}
