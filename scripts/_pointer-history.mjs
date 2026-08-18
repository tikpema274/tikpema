// _pointer-history.mjs — the pure record rule for moving an on-chain identity pointer.
//
// Extracted from set-agent-uri.mjs so it can be tested WITHOUT executing the CLI (importing
// that script runs it: it is a top-to-bottom program, not a module) and WITHOUT touching the
// chain. Pure over plain objects. No I/O, no Circle, no RPC. Same reason _identity-record.mjs
// was extracted from register-identity.mjs, and the same shape of bug it exists to prevent.
//
// ═══ 🚨 WHAT THIS PREVENTS ════════════════════════════════════════════════════════════
// mergePreservingProvenance() protects a field only when the INCOMING value is null — "never
// downgrade a known value to null". A supersession's incoming values are all legitimately
// NON-null and DIFFERENT, so that rule never fires and a plain write replaces:
//
//     txHash   0xd33cb296…  the REGISTRATION of 851891   →  the setAgentURI tx
//     cid      bafkreigton…o2af4                         →  bafkreib6vi…momla
//     sha256   d3734acc…                                 →  3eaa33c2…
//
// The registration txHash is the only local record of how the identity came to exist; the
// v1.0.0 CID is load-bearing forever, because two paid reports were produced under that
// document and their attestations resolve through it.
//
// ═══ ⭐ AND THE SECOND-ORDER BUG, WHICH IS THE SUBTLER ONE ════════════════════════════
// Seeding pointerHistory[0] by reading `prior.txHash` and LABELLING it "the original
// registration" is correct only for as long as `prior.txHash` happens to still hold the
// registration hash. That is true on the first supersession and false forever after — and
// it is true by TIMING, not by construction. A seed that runs a moment later, or against a
// record some other run already touched, would stamp `how: "register(string) — the original
// registration"` onto whatever transaction happened to be in that field.
//
// That is the same defect class as the one above wearing a label: a value that is right by
// coincidence, in a field whose whole job is to be right permanently. So the expected
// registration txHash is passed in EXPLICITLY and asserted. If the record does not hold it,
// this refuses rather than mislabelling. ⭐ The check is against the value, not the shape:
// "looks like a txHash" would pass for the setAgentURI hash too, which is exactly the value
// it must not accept.

/**
 * Fields that describe WHICH BYTES a pointer named, and how it got there. Every one of them
 * is replaced by a supersession, and every one is unrecoverable-by-inspection once gone.
 */
export const POINTER_FIELDS = Object.freeze(["tokenURI", "cid", "sha256", "txHash", "circleTxId"]);

export class PointerHistoryError extends Error {
  constructor(msg) { super(msg); this.name = "PointerHistoryError"; }
}

/**
 * Append a pointer move to an identity record, seeding the history with the original
 * registration the first time it runs.
 *
 * @param {object} prior         the record already on disk. Required — see below.
 * @param {object} entry         the move being recorded {version,cid,sha256,tokenURI,txHash,circleTxId,at,how,note}
 * @param {object} expect        {agentId, registrationTxHash, supersedesVersion, supersedesCid}
 * @returns {{merged: object, seeded: boolean}}
 *
 * Throws PointerHistoryError rather than returning a partial record: a refusal that the
 * caller must handle cannot be mistaken for a successful write, whereas a returned
 * best-effort object can.
 */
export function appendPointerMove(prior, entry, expect) {
  // 🚨 A MISSING RECORD IS NOT AN EMPTY ONE. Writing a fresh record over an absence would
  // manufacture a history whose entry 0 is invented, and it would look exactly like a real
  // one. The record holds provenance that exists nowhere else; refuse.
  if (!prior || typeof prior !== "object") {
    throw new PointerHistoryError("no prior record — refusing to write a fresh one over an absence. It holds provenance that exists nowhere else.");
  }
  if (!entry || typeof entry !== "object") throw new PointerHistoryError("an entry object is required");
  if (!expect?.registrationTxHash) throw new PointerHistoryError("expect.registrationTxHash is required — the seed must be asserted, not inferred");

  if (String(prior.agentId) !== String(expect.agentId)) {
    throw new PointerHistoryError(`record holds agentId ${prior.agentId}, expected ${expect.agentId}`);
  }

  const history = Array.isArray(prior.pointerHistory) ? [...prior.pointerHistory] : [];
  let seeded = false;

  if (history.length === 0) {
    // ⭐ THE ASSERTION THAT MAKES THE SEED CORRECT BY CONSTRUCTION RATHER THAN BY TIMING.
    if (!prior.txHash) {
      throw new PointerHistoryError("record has no txHash to seed the history from — the registration provenance is already missing. Reconcile it by hand before moving the pointer.");
    }
    if (prior.txHash.toLowerCase() !== expect.registrationTxHash.toLowerCase()) {
      throw new PointerHistoryError(
        `record.txHash is ${prior.txHash}\n   expected the REGISTRATION tx ${expect.registrationTxHash}\n` +
        `   Seeding pointerHistory[0] from this value would label the wrong transaction "the original\n` +
        `   registration" — permanently, in the only local record of how agentId ${expect.agentId} came to exist.`
      );
    }
    // The CID being superseded must also be the one the record actually names. A history
    // whose entry 0 names bytes the record never pointed at is fiction.
    if (expect.supersedesCid && prior.cid !== expect.supersedesCid) {
      throw new PointerHistoryError(`record.cid is ${prior.cid}, expected ${expect.supersedesCid} — the record does not describe the pointer this run means to replace.`);
    }
    history.push({
      version: expect.supersedesVersion ?? null,
      cid: prior.cid ?? null,
      sha256: prior.sha256 ?? null,
      tokenURI: prior.tokenURI ?? null,
      txHash: prior.txHash,
      circleTxId: prior.circleTxId ?? null,
      at: prior.writtenAt ?? null,
      how: "register(string) — the original registration",
      note: "⭐ STAYS PINNED FOREVER: paid reports were produced under this document and their attestations resolve through it.",
    });
    seeded = true;
  }

  history.push({ ...entry });

  // ⚠️ APPEND-ONLY, ASSERTED. A bug that shortened the history would otherwise be silent.
  const priorLen = Array.isArray(prior.pointerHistory) ? prior.pointerHistory.length : 0;
  if (history.length < priorLen + 1) throw new PointerHistoryError("history would shrink — refusing");

  const registrationTxHash = prior.registrationTxHash ?? history[0].txHash;
  if (!registrationTxHash) throw new PointerHistoryError("refusing to write a record with no registrationTxHash");
  if (registrationTxHash.toLowerCase() !== expect.registrationTxHash.toLowerCase()) {
    throw new PointerHistoryError(`registrationTxHash would be ${registrationTxHash}, expected ${expect.registrationTxHash}`);
  }

  const merged = {
    ...prior,
    registrationTxHash,
    currentVersion: entry.version ?? prior.currentVersion ?? null,
    pointerHistory: history,
  };
  // The top-level pointer fields track the LATEST move, but never blank a known value.
  for (const f of POINTER_FIELDS) {
    if (entry[f] !== null && entry[f] !== undefined) merged[f] = entry[f];
  }
  return { merged, seeded };
}
