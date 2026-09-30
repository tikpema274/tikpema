// refid-verdict.mjs — the refId round-trip spike's VERDICT, pure (tested: scripts/verify-refid-verdict.mjs).
// Helper to spike-idempotency-key-repeat.mjs --refid.
//
// ⛔ A FAILED READ IS NEVER A FINDING (T, 2026-09-30). The first --refid run said DOES-NOT-ROUND-TRIP when both listings
// had ERRORED (our own malformed call: Circle 400, code 2). Only READABLE reads that all lack the refId can say it does
// not round-trip; any unreadable read with no positive → INCONCLUSIVE.
//
// @param {{sentOk:boolean, reads:Array<{readable:boolean, found?:boolean}>}} a — one entry per lookup, in order
// @returns "SEND-REFUSED" | "ROUND-TRIPS" | "ROUND-TRIPS-LATE" | "DOES-NOT-ROUND-TRIP" | "INCONCLUSIVE"
export function refidVerdict({ sentOk, reads }) {
  if (sentOk !== true) return "SEND-REFUSED";
  const rs = Array.isArray(reads) ? reads : [];
  const readable = rs.filter((r) => r?.readable === true);
  const positives = readable.filter((r) => r.found === true);
  if (positives.length) return positives.length === rs.length ? "ROUND-TRIPS" : "ROUND-TRIPS-LATE";
  if (rs.length === 0 || readable.length !== rs.length) return "INCONCLUSIVE";
  return readable.every((r) => r.found === false) ? "DOES-NOT-ROUND-TRIP" : "INCONCLUSIVE";
}
