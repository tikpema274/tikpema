// resource.mjs — the v2 top-level `resource` object, DERIVED FROM THE REQUIREMENTS, never restated.
//
// ═══ ⭐⭐ WHY IT IS DERIVED FROM `requirements` AND NOT FROM DD_RESOURCE_URL ═════════════════════
// There are TWO URLs in this codebase that both look like "the resource URL", and they agree today:
//
//   1. `requirements.resource` — built PER REQUEST from proto + host + event.path
//      (dd-analyze.mjs, x402-quote.mjs). ⭐ THIS IS THE ONE THE PAYMENT SIGNATURE IS BOUND TO:
//      the buyer signs an authorization against the resource named in `accepts[0]`, and the
//      facilitator binds the payment to it.
//   2. `DD_RESOURCE_URL` — a constant in _dd-descriptor.mjs, used by the 400-path payment terms.
//
// 🚨 PUBLISHING (2) AT THE TOP LEVEL WOULD LET US ADVERTISE A RESOURCE THE AUTHORIZATION DOES NOT
// MATCH. Any host the constant does not anticipate — a branch deploy, a preview URL, a renamed
// domain, a direct /.netlify/functions/ path — makes the advertised resource and the signed one
// disagree, and the failure would surface as an unexplained settlement rejection rather than as a
// mismatch anyone could see.
//
// ⚠️ THE NEXT READER WILL SEE TWO SOURCES THAT AGREE AND WONDER WHY ONE WAS CHOSEN. This is the
// reason: they agree by coincidence of deployment, not by construction. Derivation keeps the
// advertised resource and the signable resource the SAME OBJECT, so they cannot drift apart.
//
// ═══ ⚠️ THE v1 PER-ENTRY FIELDS ARE KEPT ON PURPOSE — THIS IS A DECISION, NOT AN OVERSIGHT ══════
// `accepts[0]` still carries `resource`, `description` and `mimeType` (v1 placement) while this adds
// them at the top level (v2 placement). The challenge therefore states them TWICE, and that is
// deliberate: v1-shaped readers look per-entry, v2-shaped readers look top-level, and we do not know
// who is reading. We have exactly one measured data point about external readers — Coinbase's
// Bazaar Validator — and none at all about the rest.
// 🚨 DO NOT "TIDY" THE PER-ENTRY COPIES OUT. Removing them is a separate decision requiring evidence
// about who reads them, and it cannot be made from inside a formatting cleanup. They are not
// duplicated STATE — both placements are derived from the same `requirements` object here and in
// ddPaymentRequirements, so they cannot disagree.

/**
 * Build the v2 `PaymentRequired.resource` object from the requirements a buyer will sign against.
 * @param {{resource?: string, description?: string, mimeType?: string}} requirements
 */
export function resourceObject(requirements) {
  return {
    url: requirements?.resource,
    description: requirements?.description,
    mimeType: requirements?.mimeType,
  };
}
