// ofac-sdn.2026-09-16.mjs — PINNED OFAC SDN digital-currency (ETH) address snapshot.
//
// ⭐ THIS FILE IS HASHED INTO ddTree (shared/onchain-analyze is a DD surface dir). A signed DD report
// therefore vouches for THIS EXACT list version. Updating the list = replace this snapshot (a code
// change) → ddTree rotates → the canary re-vouches. Do NOT fetch the list at runtime: a live fetch
// would break determinism, ddTree-hashability, and auditor-independence — the whole point of the DD.
//
// 🚨 STARTER SUBSET — `complete: false`. This is a small set of well-known SDN designations to prove
// the mechanism, NOT the full OFAC SDN list. A negative ("not-listed") against `complete: false` is
// NOT a clearance (see ofac.mjs `screenOfac`/`ofacVerdict`). Vendor the full list via
// scripts/vendor-ofac.mjs (tooling, not on the DD surface) before relying on a negative in production.
//
// Addresses are stored LOWERCASED (EVM address equality is case-insensitive; the screener lowercases
// the subject before comparing). Source: OFAC SDN list, "Digital Currency Address - ETH" entries
// (https://sanctions.treasury.gov). The entries below are from the Tornado Cash designation
// (2022-08-08), among the most widely published SDN crypto addresses.
export const OFAC_SDN = Object.freeze({
  list: "OFAC SDN — digital-currency addresses (ETH)",
  source: "https://sanctions.treasury.gov — SDN list, 'Digital Currency Address - ETH'",
  snapshot: "2026-09-16",
  complete: false,
  addresses: Object.freeze(new Set([
    "0x8589427373d6d84e98730d7795d8f6f8731fda16",
    "0x722122df12d4e14e13ac3b6895a86e84145b6967",
    "0xdd4c48c0b24039969fc16d1cdf626eab821d3384",
    "0xd90e2f925da726b50c4ed8d0fb90ad053324f31b",
  ])),
});
