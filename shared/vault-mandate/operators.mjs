// operators.mjs — WHO may create a vault mandate through the operator-only path (netlify/functions/
// vault-mandate-operator.mjs). A pure code constant: no env var, no import beyond node:crypto, off the DD surface
// (the limits.mjs rule — changing it costs a commit and a review, never a dashboard click).
//
// ═══ DECISION (T, 2026-09-27): T's LOGIN ADDRESS ONLY ═══════════════════════════════════════════════
// The full address lives HERE and nowhere else in the repo's records (PROGRESS writes it truncated).
// It is the SESSION address (`session.address`, lowercased by _auth.mjs), i.e. the owner key a mandate is
// stored under — not the agent wallet.
//
// ═══ ⭐ WHY THE CHECK DOES CONSTANT WORK ════════════════════════════════════════════════════════════
// The operator function is publicly reachable at /.netlify/functions/vault-mandate-operator whether or not
// anything links to it; the session gate IS the boundary. A caller not on this list must learn NOTHING about
// it — the same 403 as no session at all, and no timing difference. So `operatorMatch` compares against EVERY
// entry, with a same-length timing-safe compare, whatever it is given (a member, a stranger, null, garbage):
// no early return on a hit, none on a malformed input. A caller can only ever present their OWN session's
// address, so this is belt and braces — but it is cheap, and it makes the property checkable
// (`compared` is always the list length; test:mandateoperator asserts it).
// ⭐ Membership is ALSO re-checked on every read of a record (record.mjs): an operator-origin record whose
// owner is not on this list is inconsistent and cannot act, and removing an address stops that operator's
// mandates.

import { timingSafeEqual } from "node:crypto";

/** Lowercase, frozen. ⛔ One entry by decision; adding one is a decision, not a fix. */
export const OPERATOR_MANDATE_OWNERS = Object.freeze(["0x74b7b561fd71c68eb1da6b96a7a87033904b24e5"]);

// Same length as every entry, and never an entry itself: what a malformed input is compared as.
const PAD = Buffer.from("0x" + "0".repeat(40), "utf8");
const ENTRIES = OPERATOR_MANDATE_OWNERS.map((a) => Buffer.from(a, "utf8"));

/** @returns {{match:boolean, compared:number}} — `compared` is always the list length (constant work). */
export function operatorMatch(address) {
  const wellFormed = typeof address === "string" && /^0x[0-9a-fA-F]{40}$/.test(address);
  const probe = wellFormed ? Buffer.from(address.toLowerCase(), "utf8") : PAD;
  let hits = 0, compared = 0;
  for (const entry of ENTRIES) {
    // Every entry is compared: `|=` accumulates, so a hit does not skip the rest.
    hits |= timingSafeEqual(probe, entry) ? 1 : 0;
    compared++;
  }
  return { match: wellFormed && hits === 1, compared };
}

export const isOperatorOwner = (address) => operatorMatch(address).match;
