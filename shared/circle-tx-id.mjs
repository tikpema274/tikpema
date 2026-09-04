// circle-tx-id.mjs — ⛔ CAN CIRCLE BE ASKED ABOUT THIS TRANSACTION AT ALL?
//
// ═══ 🚨 THE DEFECT THIS CLOSES (recorded 14d8b8a) ═════════════════════════════════════════════
// `_bridge-receipts.mjs` selected EVERY non-terminal provisional into `reconcilable`, and
// `bridge-mint-sweep` posted each to a job that calls `circle().getTransaction({ id: txId })`.
// A user-signed record's txId is LOCALLY MINTED (`user-mtlru386-qxx7xy`) — that path is signed by
// the browser EOA and lands on Arc directly, so Circle has no record of it and never will. Circle
// rejected every one at URL parsing:
//
//     "circle_error: Fail to parse id as UUID in url."   — identically, on all nine records
//
// ⭐ ~146 GUARANTEED-FUTILE CALLS PER ABANDONED INTENT, bounded only by the 24h age cap. The cap
// worked and bounded the wrong thing: how long we ask, not whether the question can be answered.
//
// ═══ ⛔⛔ WHY THIS IS NOT `origin !== "user-signed"` ═══════════════════════════════════════════
// The rule is NOT "exclude user-signed". It is: **a record may only be reconciled against Circle if
// its txId is an id CIRCLE ISSUED.** `origin` is a proxy for that, and a bad one on three counts:
//
//   1. IT LABELS WHO MADE THE RECORD, NOT WHETHER THE LOOKUP CAN SUCCEED. A future path that also
//      mints its own id is admitted unless somebody remembers to add it to a list. Nobody will.
//   2. IT IS HISTORICALLY UNRELIABLE. `promoteUserBridge` DROPPED it — which is exactly why every
//      self-signed DURABLE receipt in the store is indistinguishable from an agent one, recorded in
//      `_bridge-record.mjs`. A discriminator that can be dropped in transit is not one.
//   3. `origin !== "user-signed"` IS A BLACKLIST, and a blacklist admits anything new by default.
//      Same lesson as the receipts collapse: the failing direction must be "excluded for no reason",
//      never "included for no reason".
//
// ⭐⭐ SO THE TEST IS THE SHAPE OF THE ID ITSELF — the actual precondition, and the one Circle
// applies. Its own error names it: it parses the id AS A UUID before it looks anything up. Testing
// the UUID shape is therefore not a heuristic about provenance; it is the same check the remote
// system performs, made locally and for free.
//
// ⭐ AND IT IS A WHITELIST. Only a well-formed UUID may be sent. A `user-…` id, an empty string, a
// null, a truncated id, or any scheme invented later is excluded WITHOUT ANYONE EDITING THIS FILE.

/** 8-4-4-4-12 hex. Circle parses the path id as a UUID; anything else 400s before any lookup. */
export const CIRCLE_TX_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this an id Circle could resolve? ⭐ A WHITELIST: true only for a well-formed UUID.
 * @param {unknown} txId
 * @returns {boolean}
 */
export function isCircleTransactionId(txId) {
  return typeof txId === "string" && CIRCLE_TX_ID_RE.test(txId.trim());
}

/**
 * ⭐⭐ THE ONE PREDICATE THE SELECTION AND THE COPY BOTH READ.
 *
 * `_bridge-receipts.mjs` uses it to decide whether a record may enter `reconcilable`; the panel uses
 * it to decide what the row may CLAIM. One function, so the sentence and the selection cannot
 * disagree — a row we refuse to send to Circle can never also say "we keep re-checking with Circle".
 *
 * ⚠️ A record with no txId at all is NOT askable. That is the safe direction: not asking is free,
 * and asking about `undefined` is the same 400 with a different message.
 */
export function circleCanBeAsked(record) {
  return isCircleTransactionId(record?.txId);
}
