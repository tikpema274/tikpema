// _identity-record.mjs — the pure record-merge rule for the identity record file.
//
// Extracted from register-identity.mjs so it can be tested WITHOUT executing the CLI (importing
// that script runs it: it is a top-to-bottom program, not a module). No I/O, no chain, no Circle —
// pure over two plain objects.
//
// ═══ ⭐ THE INVARIANT: NEVER REPLACE A RICHER RECORD WITH A POORER ONE ════════════════════════
// The original clobber guard protected `agentId` and only `agentId`. That is the field its author
// was thinking about, not the invariant. The gap was real and it fired: running a DRY RUN after
// registration took the ALREADY-REGISTERED branch, which persists `txHash: null, circleTxId: null`
// (it discovered the id rather than minting it), and `writeFile` does not merge — so a read-only
// run silently destroyed the on-chain provenance of a committed record:
//
//     "txHash": "0xd33cb296…"  →  null
//     "circleTxId": "1d4ba798…" →  null
//
// The agentId survived, so every existing guard passed. Generalising from "protect the agentId" to
// "never downgrade a known value to null" is what actually closes the class.
//
// ⚠️ WHY MERGING IS SAFE HERE, AND WHERE IT WOULD NOT BE. Preserving a prior value is only correct
// when both records describe the SAME identity. That precondition is enforced by the caller: the
// agentId clobber guards in persistId() refuse a different agentId and refuse to blank a known one
// BEFORE this runs. Within one identity, its own earlier provenance is still its provenance. This
// function deliberately does not re-implement those guards — it must not become a second place
// where identity equality is decided.

/**
 * Fields whose loss is unrecoverable-by-inspection: they record HOW the identity came to exist and
 * WHICH bytes it points at. Losing one means the on-chain fact still exists but nothing local can
 * find or corroborate it — the archaeology this whole script was written to prevent.
 *
 * `agentId` is deliberately NOT here: it is governed by the caller's dedicated guards, which refuse
 * rather than merge. Two mechanisms for one field would be a duplicate source of truth.
 */
export const PROVENANCE_FIELDS = Object.freeze([
  "txHash",
  "circleTxId",
  "tokenURI",
  "cid",
  "sha256",
  "owner",
]);

/**
 * Merge a new record over a prior one WITHOUT downgrading any provenance field to null/absent.
 *
 * @param {object|null} prior   the record already on disk, or null if there is none
 * @param {object} record       what this run wants to write
 * @returns {{merged: object, preserved: string[]}}
 *          `merged` is what should actually be written; `preserved` names every field that was
 *          rescued, so the caller can SAY SO rather than silently papering over the difference.
 */
export function mergePreservingProvenance(prior, record) {
  if (!record || typeof record !== "object") throw new Error("mergePreservingProvenance(): a record object is required");
  const merged = { ...record };
  const preserved = [];
  if (!prior || typeof prior !== "object") return { merged, preserved };

  for (const f of PROVENANCE_FIELDS) {
    const had = prior[f] !== null && prior[f] !== undefined;
    const losing = record[f] === null || record[f] === undefined;
    if (had && losing) {
      merged[f] = prior[f];
      preserved.push(f);
    }
  }
  return { merged, preserved };
}
