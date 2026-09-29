// exit-intent.mjs — piece 5 step 4: the EXIT INTENT and its state machine. Pure (the store side is in
// _vault-mandate-store.mjs; beginning an exit is in _vault-mandate-exit.mjs).
// Design: PROGRESS "VAULT MANDATE — PIECE 5" §5 (recovery) + C8, and T's step-4 rules (2026-09-29).
//
// ═══ THE RULES ═══════════════════════════════════════════════════════════════════════════════════
//   1. ONE exit intent per ATTEMPT, CREATE-ONLY, at x/<owner>/<id>/<n> (step 4c, T 2026-09-29). It is written BEFORE
//      anything is submitted, so a crash can never leave a submitted redeem with no record of it. The attempt number n
//      lives on the mandate record (`exit.attempt`), set in the SAME CAS that sets `exiting`: recovery reads exactly
//      x/…/<record.exit.attempt>, never a list.
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

/** x/<owner lowercased>/<id>/<attempt>. ⛔ Throws unless the attempt is a positive integer: a key always names a real attempt. */
export function exitIntentKey(owner, id, attempt) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`exitIntentKey: attempt must be a positive integer (got ${typeof attempt === "bigint" ? `${attempt}n` : JSON.stringify(attempt)})`);
  return `x/${String(owner).toLowerCase()}/${id}/${attempt}`;
}

// ═══ THE RETRY POLICY (step 4c; Claude's proposal, 2026-09-29 — see PROGRESS) ════════════════════════════════
// Attempts are consumed ONLY by real submissions (the order is reads → intent → submit, so a vault the fresh simulated
// redeem refuses costs no attempt and simply retries on a later tick). So a failed attempt means the chain or Circle
// refused a redeem the simulation had just approved: something the reads did not model. Retrying that a few times
// covers the transient (a nonce race, a Circle hiccup, a block moving under us); failing three times is a pattern a
// human must look at. Partial exits are progress, not failures, but a vault that pays out a sliver each time must not
// be chased forever: six real attempts in all. And never back-to-back: at least an hour after the last attempt
// closed (the tick is hourly, so that is "a later tick"), with a fresh check re-deciding the finding each time.
export const EXIT_RETRY_POLICY = Object.freeze({ maxFailedAttempts: 3, maxAttempts: 6, retryAfterMs: 60 * 60 * 1000 });

const isHash = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isText = (v) => typeof v === "string" && v.trim().length > 0;
const DEC = /^(0|[1-9]\d*)$/;

/**
 * The intent for a mandate's exit, in state `submitting`. `limit` is share-limit.mjs's answer; a refused or zero limit
 * builds nothing (an intent is never written for nothing to redeem).
 */
export function buildExitIntent({ record, limit, now, attempt, retryOf = null }) {
  if (!limit?.ok) return { ok: false, why: `no share limit: ${limit?.why ?? limit?.code ?? "absent"}` };
  if (limit.nothingToRedeem || !DEC.test(String(limit.shares)) || BigInt(limit.shares) <= 0n) return { ok: false, why: "nothing of the mandate's to redeem; no intent is written" };
  if (!Number.isInteger(attempt) || attempt < 1) return { ok: false, why: "no attempt number" };
  const key = exitIntentKey(record.owner, record.id, attempt);
  const at = new Date(now).toISOString();
  return { ok: true, intent: {
    schema: EXIT_INTENT_SCHEMA, key, owner: String(record.owner).toLowerCase(), id: record.id, attempt, retryOf,
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
  if (!Number.isInteger(intent.attempt) || intent.attempt < 1) e.push("no attempt number");
  if (intent.neverSubmitted === true) {
    // settle's tombstone for an attempt that set `exiting` but never wrote its intent: failed, nothing on chain
    if (intent.state !== EXIT_INTENT_STATE.FAILED) e.push("a never-submitted record must be failed");
    if (intent.circleId !== null || intent.txHash !== null) e.push("a never-submitted record carries no Circle id or hash");
    if (!isText(intent.failure)) e.push("a never-submitted record says why");
    return { ok: e.length === 0, errors: e };
  }
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
  const attempt = intent.attempt;
  switch (intent.state) {
    case EXIT_INTENT_STATE.SUBMITTING: return { action: "locate-by-idempotency-key", attempt, idempotencyKey: intent.idempotencyKey, why: "the intent was written; Circle may or may not have accepted the redeem" };
    case EXIT_INTENT_STATE.SUBMITTED: return { action: "read-circle", attempt, circleId: intent.circleId };
    case EXIT_INTENT_STATE.REDEEMED: return { action: "classify", attempt, txHash: intent.txHash, circleId: intent.circleId };
    default: return { action: "close", attempt, state: intent.state, outcome: settledOutcomeOf(intent) };
  }
}

/** The tombstone settle writes (create-only) for an attempt that set `exiting` but never wrote its intent. */
export function buildNeverSubmittedIntent({ record, attempt, now, why }) {
  const key = exitIntentKey(record.owner, record.id, attempt);
  const at = new Date(now).toISOString();
  return { schema: EXIT_INTENT_SCHEMA, key, owner: String(record.owner).toLowerCase(), id: record.id, attempt, retryOf: null,
    walletAddress: record.walletAddress, vault: record.vault?.address ?? null,
    state: EXIT_INTENT_STATE.FAILED, neverSubmitted: true, createdAt: at, history: [{ state: EXIT_INTENT_STATE.FAILED, at }],
    sharesToRedeem: null, idempotencyKey: null, circleId: null, txHash: null, outcome: null,
    failure: why || "the attempt set the mandate exiting but never wrote its intent: nothing was submitted" };
}

/** What a TERMINAL intent settled as: exited | exit-partial | failed | not-submitted. Null for an open one. */
export function settledOutcomeOf(intent) {
  if (intent?.state === EXIT_INTENT_STATE.FAILED) return intent.neverSubmitted === true ? "not-submitted" : "failed";
  if (intent?.state === EXIT_INTENT_STATE.ASSERTED) return intent.outcome?.outcome ?? null;
  return null;
}

/**
 * May a NEW attempt begin, and which number? Pure. `attempts` = the reads of x/…/1..n (n = record.exit.attempt), each
 * {n, read}. EVERY past attempt must be read: unreadable → blocked; a number with no record → inconsistent (settle
 * tombstones every attempt that never wrote an intent, so a gap is not a crash we know how to make).
 * @returns {{ok:true, next:number, kind:"first"|"after-failure"|"after-partial"|"after-not-submitted", failures:number, attempts:number, lastOutcome:string|null}
 *          | {ok:false, code:string, why:string}}
 */
export function retryDecision({ record, attempts = [], now, policy = EXIT_RETRY_POLICY }) {
  const n = record?.exit?.attempt ?? 0;
  if (!Number.isInteger(n) || n < 0) return { ok: false, code: "mandate-inconsistent", why: "the record's exit attempt is not a number" };
  if (n === 0) return { ok: true, next: 1, kind: "first", failures: 0, attempts: 0, lastOutcome: null };
  let failures = 0, real = 0, last = null;
  for (let k = 1; k <= n; k++) {
    const a = attempts.find((x) => x?.n === k);
    if (!a || a.read?.readable !== true) return { ok: false, code: "exit-intent-unreadable", why: `attempt ${k} could not be read; it is never treated as absent` };
    const it = a.read.intent;
    if (!it) return { ok: false, code: "exit-intent-inconsistent", why: `the record names attempt ${n} but attempt ${k} has no record` };
    if (EXIT_INTENT_OPEN.includes(it.state)) return { ok: false, code: "exit-in-flight", why: `attempt ${k} is open (${it.state}): never resubmit while one is open` };
    const v = verifyExitIntent(it);
    if (!v.ok) return { ok: false, code: "exit-intent-malformed", why: `attempt ${k}: ${v.errors.join("; ")}` };
    const o = settledOutcomeOf(it);
    if (o !== "not-submitted") real++;
    if (o === "failed") failures++;
    if (k === n) last = it;
  }
  const lastOutcome = settledOutcomeOf(last);
  if (lastOutcome === "exited") return { ok: false, code: "exited", why: "the last attempt exited: the mandate's shares are gone" };
  if (failures >= policy.maxFailedAttempts) return { ok: false, code: "attempts-exhausted", why: `${failures} attempts failed after their simulation passed: a human must look before another` };
  if (real >= policy.maxAttempts) return { ok: false, code: "attempts-exhausted", why: `${real} real attempts already; the vault is not paying out the remainder` };
  const closedAt = Date.parse(last.history?.[last.history.length - 1]?.at ?? "");
  if (!Number.isFinite(closedAt)) return { ok: false, code: "exit-intent-malformed", why: `attempt ${n} has no closing time` };
  if (now - closedAt < policy.retryAfterMs) return { ok: false, code: "retry-too-soon", why: `attempt ${n} closed ${Math.round((now - closedAt) / 60000)} min ago; a retry waits at least ${policy.retryAfterMs / 60000} min` };
  const kind = lastOutcome === "exit-partial" ? "after-partial" : lastOutcome === "failed" ? "after-failure" : "after-not-submitted";
  return { ok: true, next: n + 1, kind, failures, attempts: real, lastOutcome };
}
