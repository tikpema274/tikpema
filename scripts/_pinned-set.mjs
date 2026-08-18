// _pinned-set.mjs — THE must-stay-pinned set. One definition, imported by everything that pins,
// measures, or reasons about these CIDs.
//
// ═══ 🚨 WHY THIS FILE EXISTS ═══════════════════════════════════════════════════════════════════
// The set lived in THREE places at once: a comment block in pin-invariants.mjs (prose, so nothing
// could import it), a `PINNED` array in verify-pin-providers.mjs, and `VERSIONS` in
// netlify/functions/dd-identity.mjs. "A claim copied into a second place always drifts" is this
// repo's most-repeated bug, and the copies had already begun to diverge in what they recorded:
// pin-invariants knew each document's bytes and sha256 but not why it mattered; the gate knew why
// it mattered but not what bytes it was, so it could not have re-derived a single CID it checked.
//
// ⭐ EXTRACTED BEFORE THE FOURTH COPY, NOT AFTER. pin-second-operator.mjs needs the same three CIDs
// plus their local bytes. Adding it against three existing copies would have made four, and the
// cheapest moment to collapse a duplicated list is always before the next consumer, never after.
//
// ═══ ⚠️ WHAT IS DELIBERATELY *NOT* IMPORTED FROM HERE ═══════════════════════════════════════════
// netlify/functions/dd-identity.mjs keeps its own VERSIONS. Two reasons, both deliberate:
//   1. It is a DEPLOYED function. Importing a scripts/ module would drag this file into the
//      function bundle and couple a public route's payload to local tooling.
//   2. The companion is a SEPARATE OBSERVATION, and the value of verify-pin-providers.mjs's
//      copy-drift check comes precisely from the two being independent. A drift check between a
//      module and itself proves nothing. So the companion stays a second source, and the gate
//      keeps failing loudly if it ever names a CID this file has not heard of.
// ⭐ That is the distinction: a duplicated DEFINITION is a bug; an independent OBSERVATION that is
// automatically cross-checked is a measurement. Collapsing the second into the first would remove
// the only thing currently able to catch the route drifting.
//
// ═══ 🚨🚨 A PIN HERE IS A PERMANENT OBLIGATION, AND THE SET ONLY GROWS ══════════════════════════
// ⭐ SELLING A REPORT CHANGED WHAT A PIN MEANS. Before 2026-08-11 these CIDs were provenance: nice
// to keep, harmless to drop. On 2026-08-11 the DD service sold TWO REAL REPORTS for USDC (handles
// 397b67b1…, e7e855fb…), each carrying an ERC-1271 attestation. Verifying one runs
// tokenURI(851891) → the identity document → the capability and coverage claims that were LIVE when
// that report was produced.
//
// 🚨 IF THE PIN LAPSES, THE SOLD REPORTS STOP BEING CHECKABLE against the claims they were produced
// under. The signature still verifies — isValidSignature is a chain call and needs no IPFS — but
// WHAT WAS BEING ATTESTED TO becomes unresolvable. A buyer left holding a valid signature over
// claims nobody can retrieve has an artifact they cannot audit, which is precisely the property
// they paid for. That is not a degraded state; it is the product failing after delivery.
//
// ⚠️ MONOTONIC. The document's own supersession_rules require that prior CIDs are not unpinned.
// EVERY supersession APPENDS a row and removes none, effectively forever. Budget for it, and never
// unpin to save quota — the cheap-looking cleanup is the one that silently breaks delivered products.

/**
 * @typedef {object} PinnedDoc
 * @property {string} key       stable identifier; ALSO the --target name for pin-invariants.mjs
 * @property {string} cid       the content address. The thing that must stay announced.
 * @property {string} sha256    of the exact bytes the CID commits to
 * @property {number} bytes     size of those bytes
 * @property {string} rel       repo-relative path to the local copy
 * @property {string} name      filename used when uploading
 * @property {string} agentId   the ERC-8004 identity this document belongs to
 * @property {string} version   document version, or "" where the document is unversioned
 * @property {number} pinOrder  ⭐ REDUNDANCY ORDER, not chronology. See below.
 * @property {string} what      one-line identity, for output
 * @property {string} why       why losing this CID would matter. Never "for completeness".
 */

/**
 * ⭐ pinOrder IS A RANKING BY CONSEQUENCE OF LOSS, and it is data rather than a comment because a
 * script must be able to obey it. v1.0.0 is FIRST despite being superseded: it is the only CID in
 * this set with sold products depending on it. The current pointer (v1.1.0) is second — losing it
 * is loud and immediately fixable by re-pinning. unified is third.
 *
 * ⚠️ A run that adds a second operator must work down this order and STOP on the first failure.
 * Pinning the cheap ones first "to warm up" spends the run's reliability budget on the CIDs whose
 * loss costs least.
 */
export const PINNED_SET = Object.freeze([
  Object.freeze({
    key: "dd-service",
    pinOrder: 1,
    cid: "bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4",
    sha256: "d3734accb6390a361df2daf87b49c41d4a44d30bfc9285f47be3c3284dbb402f",
    bytes: 28628,
    rel: "agent-metadata/dd-service.json",
    name: "dd-service.json",
    agentId: "851891",
    version: "1.0.0",
    what: "dd-service.json v1.0.0 — agentId 851891",
    why: "TWO PAID REPORTS were produced under this document; their attestations resolve through it",
  }),
  Object.freeze({
    key: "dd-service-v1.1.0",
    pinOrder: 2,
    cid: "bafkreib6viz4fqa4oqrrgxfecwcttxyda6ilm5nmzr7yplznqeahqmomla",
    sha256: "3eaa33c2c01c7423135ca4158539df030790b675accc7f87af2d81007831cc58",
    bytes: 18756,
    // ⚠️ STILL NAMED .DRAFT.json ON PURPOSE. Renaming changes nothing about the bytes but invites
    // a re-save, and a re-save changes the CID. The filename stopped mattering the moment it was
    // pinned — the CID is the address.
    rel: "agent-metadata/dd-service.v1.1.0.DRAFT.json",
    name: "dd-service.v1.1.0.json",
    agentId: "851891",
    version: "1.1.0",
    what: "dd-service.json v1.1.0 — agentId 851891",
    why: "supersedes v1.0.0; the document tokenURI(851891) points at once setAgentURI lands",
  }),
  Object.freeze({
    key: "unified",
    pinOrder: 3,
    cid: "bafkreidoeond3akvswce3e425o5grfygsvrfyleqkwathio4ae6y6vujae",
    sha256: "6e239a3d815595844d939aebba68970695625c2c90558133a1dc013d8f568901",
    bytes: 13656,
    rel: "agent-metadata/unified.json",
    name: "unified.json",
    agentId: "851823",
    version: "",
    what: "unified.json — agentId 851823",
    why: "the Tikpema Agent identity document; tokenURI(851823) points here",
  }),
]);

/** Documents in REDUNDANCY order — the order a pinning run must follow. */
export const byPinOrder = () => [...PINNED_SET].sort((a, b) => a.pinOrder - b.pinOrder);

/** Look up by key (the --target name). Returns undefined for unknown keys — callers must fail closed. */
export const byKey = (k) => PINNED_SET.find((d) => d.key === k);

/** Every CID in the set, for membership checks. */
export const allCids = () => PINNED_SET.map((d) => d.cid);

// ═══ SELF-CHECK — runs at import, because a duplicated field is what this file exists to end ═════
// 🚨 Collapsing three copies into one removes DRIFT but not TYPOS: with three copies a mistyped CID
// disagreed with the others and was findable; with one copy it is simply the truth. So the shape is
// asserted at load — uniqueness across every identifying field, and a contiguous pinOrder with no
// ties, since a tie would make "work down the order and stop on failure" ambiguous.
{
  const seen = new Map();
  for (const d of PINNED_SET) {
    for (const f of ["key", "cid", "sha256", "rel", "name", "pinOrder"]) {
      const k = `${f}:${d[f]}`;
      if (seen.has(k)) throw new Error(`_pinned-set.mjs: "${seen.get(k)}" and "${d.key}" share ${f} = ${d[f]}`);
      seen.set(k, d.key);
    }
    if (!/^bafkrei[a-z2-7]{52}$/.test(d.cid)) throw new Error(`_pinned-set.mjs: ${d.key} cid is not a CIDv1 raw sha256 base32: ${d.cid}`);
    if (!/^[0-9a-f]{64}$/.test(d.sha256)) throw new Error(`_pinned-set.mjs: ${d.key} sha256 is malformed`);
    if (!Number.isInteger(d.bytes) || d.bytes <= 0) throw new Error(`_pinned-set.mjs: ${d.key} bytes is not a positive integer`);
  }
  const orders = PINNED_SET.map((d) => d.pinOrder).sort((a, b) => a - b);
  if (orders.some((o, i) => o !== i + 1)) throw new Error(`_pinned-set.mjs: pinOrder must be 1..n with no gaps or ties, got ${orders.join(",")}`);
}
