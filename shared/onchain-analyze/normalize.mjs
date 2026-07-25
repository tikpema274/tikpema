// normalize.mjs — reject junk AT THE GATE rather than passing it to an RPC and interpreting whatever
// comes back. A malformed address is programmer error, not a finding about a chain.
//
// ⚠️ Deliberately NOT imported from scripts/dd/fact.mjs, which has an identical function. shared/
// must not depend on scripts/ — the dependency runs one way only, or this module stops being
// service-consumable and the auditor starts depending on the audit CLI. Four lines is the correct
// price for that; the alternative is an import that inverts the layering.

/** 0x-prefixed 20-byte address, lowercased — or null. */
export function normalizeAddress(a) {
  if (typeof a !== "string") return null;
  const s = a.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}
