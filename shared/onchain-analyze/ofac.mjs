// ofac.mjs — DETERMINISTIC OFAC SDN screen for a subject address. Pure: no network, no RPC, no clock.
//
// ⭐ WHY IT FITS THE DD (and Elliptic/TRM do not): the DD's verdict must be deterministic, read by our
// own code, INSIDE ddTree, and auditor-independent. A pinned SDN snapshot (ofac-sdn.<date>.mjs, in this
// surface dir) gives all four — screening is a pure Set membership check, and the signed report vouches
// for the EXACT list version via ddTree. An external paid risk API would break every one of those.
//
// ⭐ FACTS, NOT VERDICTS (schema.mjs's rule): `screenOfac` returns a FACT (listed / not-listed /
// unreadable + which list, which snapshot). The VERDICT is `ofacVerdict`, kept separate.

import { OFAC_SDN } from "./ofac-sdn.2026-09-16.mjs";

const OFAC_STATUS = Object.freeze({ LISTED: "listed", NOT_LISTED: "not-listed", UNREADABLE: "unreadable" });
export { OFAC_STATUS };

const lc = (a) => String(a ?? "").trim().toLowerCase();

/**
 * Screen one address against the pinned OFAC SDN digital-currency (ETH) snapshot. Returns a FACT that
 * is present on every report (never absent — a missing field reads as safe). Tri-state:
 *   listed      — the address is on the pinned SDN snapshot (a legal block).
 *   not-listed  — not on THIS snapshot; wording carries the snapshot date AND whether the list is complete.
 *   unreadable  — the subject was not a well-formed EVM address, so it could not be screened (NOT "not listed").
 */
export function screenOfac(address) {
  const meta = {
    list: OFAC_SDN.list, snapshot: OFAC_SDN.snapshot, source: OFAC_SDN.source,
    count: OFAC_SDN.addresses.size, listComplete: OFAC_SDN.complete === true,
  };
  const a = lc(address);
  if (!/^0x[0-9a-f]{40}$/.test(a)) {
    return { ...meta, status: OFAC_STATUS.UNREADABLE,
      note: "the subject was not a well-formed EVM address, so it could not be screened — this is NOT 'not listed'." };
  }
  if (OFAC_SDN.addresses.has(a)) {
    return { ...meta, status: OFAC_STATUS.LISTED,
      note: `on ${OFAC_SDN.list} (${OFAC_SDN.snapshot}) — a legal block, not a risk score.` };
  }
  return { ...meta, status: OFAC_STATUS.NOT_LISTED,
    note: meta.listComplete
      ? `not present on ${OFAC_SDN.list} as of ${OFAC_SDN.snapshot}. Point-in-time: a later listing would not appear until the snapshot is updated.`
      : `not present in this ${OFAC_SDN.list} snapshot (${OFAC_SDN.snapshot}), which is a PARTIAL SUBSET (listComplete=false) — this is NOT a clearance. Vendor the full SDN list before relying on a negative.` };
}

/**
 * The VERDICT over a sanctions fact — kept OUT of the report (facts, not verdicts). Sanctions is a hard
 * STOP a buyer cannot allow; "could not tell" also stops (not-established is not absent), and a negative
 * against an INCOMPLETE list is INDETERMINATE, never a clearance.
 * @returns {{ stop: boolean, indeterminate: boolean, reason: string }}
 */
export function ofacVerdict(sanctions) {
  const s = sanctions?.status;
  if (s === OFAC_STATUS.LISTED) return { stop: true, indeterminate: false, reason: "subject is on the OFAC SDN snapshot" };
  if (s === OFAC_STATUS.UNREADABLE) return { stop: true, indeterminate: true, reason: "subject could not be screened — could-not-tell must not clear" };
  if (s === OFAC_STATUS.NOT_LISTED && sanctions?.listComplete !== true)
    return { stop: false, indeterminate: true, reason: "not on a PARTIAL SDN snapshot — a negative here is not a clearance" };
  if (s === OFAC_STATUS.NOT_LISTED) return { stop: false, indeterminate: false, reason: "not on the OFAC SDN snapshot" };
  return { stop: true, indeterminate: true, reason: "sanctions fact missing or malformed — refusing to clear" };
}
