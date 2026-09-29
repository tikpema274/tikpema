// exit-intent.mjs — piece 5 step 4: the EXIT INTENT and its state machine. Pure (the store side is in
// _vault-mandate-store.mjs; beginning an exit is in _vault-mandate-exit.mjs).
// Design: PROGRESS "VAULT MANDATE — PIECE 5" §5 (recovery) + C8, and T's step-4 rules (2026-09-29).
//
// ═══ THE RULES ═══════════════════════════════════════════════════════════════════════════════════
//   1. ONE exit intent per mandate, CREATE-ONLY, at x/<owner>/<id>. It is written BEFORE anything is submitted, so a
//      crash can never leave a submitted redeem with no record of it.
//   2. submitting → submitted (Circle id) → redeemed (hash) → asserted | failed. Every other move is refused; a
//      terminal intent never moves again; a recorded Circle id or hash is never replaced.
//   3. The mandate is `exiting` BEFORE the intent is written (beginMandateExit), so no deposit can interleave.
//   4. One exit at a time: an OPEN intent (submitting, submitted, redeemed) means never resubmit. A resubmit computed
//      from a stale balance either reverts or redeems a REMAINDER, which changes what the outcome means.
//   5. An open DEPOSIT intent blocks the exit (C8).
//
// ═══ THE IDEMPOTENCY KEY ═════════════════════════════════════════════════════════════════════════
// Derived from the intent key (shared/circle-idempotency.mjs), so recovery can RECOMPUTE it from the key alone: a crash
// between Circle accepting the redeem and the intent recording its id cannot lose the transaction. Whether recovery may
// RE-SEND with it or must only LOOK IT UP waits on the repeated-key measurement (T's step-2 measurement, not yet run).

import { idempotencyKeyFor } from "../circle-idempotency.mjs";

export const EXIT_INTENT_SCHEMA = "vault-mandate-exit/1";
export const EXIT_INTENT_STATE = Object.freeze({
  SUBMITTING: "submitting", SUBMITTED: "submitted", REDEEMED: "redeemed", ASSERTED: "asserted", FAILED: "failed",
});
/** Open = the exit is in flight: never begin another, never resubmit. */
export const EXIT_INTENT_OPEN = Object.freeze([EXIT_INTENT_STATE.SUBMITTING, EXIT_INTENT_STATE.SUBMITTED, EXIT_INTENT_STATE.REDEEMED]);
const KNOWN = new Set(Object.values(EXIT_INTENT_STATE));
const NEXT = Object.freeze({
  submitting: ["submitted", "failed"],
  submitted: ["redeemed", "failed"],
  redeemed: ["asserted", "failed"],
  asserted: [],
  failed: [],
});
// Only the chain's own answers settle an intent (exit-outcome.mjs): exited/partial ASSERT it, failed FAILS it.
// `unconfirmed` is not an answer: the intent stays `redeemed` and is read again.
const ASSERTING_OUTCOMES = new Set(["exited", "exit-partial"]);

export const exitIntentKey = (owner, id) => `x/${String(owner).toLowerCase()}/${id}`;

const isHash = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isText = (v) => typeof v === "string" && v.trim().length > 0;
const DEC = /^(0|[1-9]\d*)$/;

/**
 * The intent for a mandate's exit, in state `submitting`. `limit` is share-limit.mjs's answer; a refused or zero limit
 * builds nothing (an intent is never written for nothing to redeem).
 */
export function buildExitIntent({ record, limit, now }) {
  if (!limit?.ok) return { ok: false, why: `no share limit: ${limit?.why ?? limit?.code ?? "absent"}` };
  if (limit.nothingToRedeem || !DEC.test(String(limit.shares)) || BigInt(limit.shares) <= 0n) return { ok: false, why: "nothing of the mandate's to redeem; no intent is written" };
  const key = exitIntentKey(record.owner, record.id);
  const at = new Date(now).toISOString();
  return { ok: true, intent: {
    schema: EXIT_INTENT_SCHEMA, key, owner: String(record.owner).toLowerCase(), id: record.id,
    walletAddress: record.walletAddress, vault: record.vault?.address ?? null,
    state: EXIT_INTENT_STATE.SUBMITTING, createdAt: at, history: [{ state: EXIT_INTENT_STATE.SUBMITTING, at }],
    // the shares, as the limit set them (step 3): what is submitted, and the tracked figure it came from
    sharesToRedeem: String(limit.shares), sharesTracked: String(limit.tracked), sharesTrackedGaps: 0, liveSharesAtIntent: String(limit.live),
    idempotencyKey: idempotencyKeyFor(key),
    circleId: null, txHash: null, outcome: null, failure: null,
  } };
}

/** Shape check for a stored intent. A state's required fields must be present; unknown state → malformed. */
export function verifyExitIntent(intent) {
  const e = [];
  if (!intent || typeof intent !== "object") return { ok: false, errors: ["no intent"] };
  if (intent.schema !== EXIT_INTENT_SCHEMA) e.push(`unknown schema ${JSON.stringify(intent.schema)}`);
  if (!KNOWN.has(intent.state)) e.push(`unknown state ${JSON.stringify(intent.state)}`);
  if (!DEC.test(String(intent.sharesToRedeem ?? "")) || intent.sharesToRedeem === "0") e.push("no shares to redeem");
  if (typeof intent.idempotencyKey !== "string") e.push("no idempotency key");
  const past = (s) => intent.history?.some?.((h) => h.state === s);
  if ([EXIT_INTENT_STATE.SUBMITTED, EXIT_INTENT_STATE.REDEEMED, EXIT_INTENT_STATE.ASSERTED].includes(intent.state) && !isText(intent.circleId)) e.push(`${intent.state} with no Circle id`);
  if ([EXIT_INTENT_STATE.REDEEMED, EXIT_INTENT_STATE.ASSERTED].includes(intent.state) && !isHash(intent.txHash)) e.push(`${intent.state} with no transaction hash`);
  if (intent.state === EXIT_INTENT_STATE.ASSERTED && !ASSERTING_OUTCOMES.has(intent.outcome?.outcome)) e.push("asserted with no asserting outcome");
  if (intent.state === EXIT_INTENT_STATE.FAILED && !isText(intent.failure) && intent.outcome?.outcome !== "failed") e.push("failed with no reason");
  if (intent.state === EXIT_INTENT_STATE.FAILED && past(EXIT_INTENT_STATE.REDEEMED) && !isHash(intent.txHash)) e.push("failed after redeemed with no hash");
  return { ok: e.length === 0, errors: e };
}

/**
 * Move an intent one step. Pure: returns a new intent. Refused (with why) on any move the machine does not allow, a
 * missing required field, or an attempt to replace a recorded Circle id or hash.
 * @param {object} intent
 * @param {{to:string, at:number, circleId?:string, txHash?:string, outcome?:object, reason?:string}} e
 */
export function advanceExitIntent(intent, { to, at, circleId, txHash, outcome, reason } = {}) {
  const v = verifyExitIntent(intent);
  if (!v.ok) return { ok: false, why: `the stored intent is malformed: ${v.errors.join("; ")}` };
  if (!KNOWN.has(to)) return { ok: false, why: `unknown state ${JSON.stringify(to)}` };
  if (!NEXT[intent.state].includes(to)) {
    return { ok: false, why: NEXT[intent.state].length === 0 ? `the intent is ${intent.state}: terminal, it never moves again` : `${intent.state} → ${to} is not a move the exit makes (next: ${NEXT[intent.state].join(" | ")})` };
  }
  const next = { ...intent, history: [...intent.history, { state: to, at: new Date(at).toISOString() }], state: to };
  if (to === EXIT_INTENT_STATE.SUBMITTED) {
    if (!isText(circleId)) return { ok: false, why: "submitted needs the Circle id" };
    next.circleId = circleId;
  }
  if (to === EXIT_INTENT_STATE.REDEEMED) {
    if (!isHash(txHash)) return { ok: false, why: "redeemed needs the transaction hash (0x + 64 hex)" };
    next.txHash = txHash;
  }
  if (to === EXIT_INTENT_STATE.ASSERTED) {
    if (!ASSERTING_OUTCOMES.has(outcome?.outcome)) return { ok: false, why: `asserted needs an outcome the chain established (exited or exit-partial), not ${JSON.stringify(outcome?.outcome ?? null)}` };
    next.outcome = outcome;
  }
  if (to === EXIT_INTENT_STATE.FAILED) {
    if (!isText(reason) && outcome?.outcome !== "failed") return { ok: false, why: "failed needs a reason, or the chain's `failed` outcome" };
    next.failure = isText(reason) ? reason : (outcome.why ?? "failed");
    if (outcome) next.outcome = outcome;
  }
  return { ok: true, intent: next };
}

/**
 * After a crash (or on any tick): given the mandate and the READ of its exit intent, what must happen next. Pure.
 * ⛔ An unreadable intent BLOCKS; it is never "no intent".
 * @param {{record:object, read:{readable:boolean, intent?:object|null, why?:string}}} a
 */
export function resolveExitState({ record, read }) {
  if (!read || read.readable !== true) return { action: "blocked", code: "exit-intent-unreadable", why: read?.why ?? "the exit intent could not be read; it is never treated as absent" };
  const exiting = record?.status === "exiting";
  const intent = read.intent ?? null;
  if (!intent) {
    // A submit only ever follows a WRITTEN intent (beginMandateExit), so `exiting` with none means nothing was sent.
    return exiting ? { action: "nothing-submitted", why: "the mandate is exiting but no intent was written, so nothing was submitted" } : { action: "none" };
  }
  const v = verifyExitIntent(intent);
  if (!v.ok) return { action: "blocked", code: "exit-intent-malformed", why: v.errors.join("; ") };
  if (EXIT_INTENT_OPEN.includes(intent.state) && !exiting) {
    return { action: "blocked", code: "inconsistent", why: `an open exit intent (${intent.state}) but the mandate is ${JSON.stringify(record?.status)}, not exiting: a deposit could interleave` };
  }
  switch (intent.state) {
    case EXIT_INTENT_STATE.SUBMITTING: return { action: "locate-by-idempotency-key", idempotencyKey: intent.idempotencyKey, why: "the intent was written; Circle may or may not have accepted the redeem" };
    case EXIT_INTENT_STATE.SUBMITTED: return { action: "read-circle", circleId: intent.circleId };
    case EXIT_INTENT_STATE.REDEEMED: return { action: "classify", txHash: intent.txHash, circleId: intent.circleId };
    default: return { action: "close", state: intent.state };
  }
}
