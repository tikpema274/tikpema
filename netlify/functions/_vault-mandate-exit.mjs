// _vault-mandate-exit.mjs — piece 5's server-side exit module: the exit's OWN pause check, and (step 3) the bounded
// exit submit (min(tracked, live)) and the halt latch's exit side, and (step 4) beginning an exit: `exiting`, then the
// one create-only intent. The executor itself (submit wiring, recovery) is not built; it will live here.
//
// ═══ ⛔ THE EXIT'S PAUSE CHECK IS ITS OWN CALL (finding C, T 2026-09-27) ═══════════════════════════════════
// executeAction's `vault_withdraw` branch is a RECLAIM: `isReclaim` skips the kill switch by design, so a paused Vault
// agent can never trap the user's funds. An autonomous EXIT is the agent acting, and T decided the kill switch stops it.
// So the exit must never route through executeAction (it would inherit the skip): it checks the pause here, explicitly,
// for the VAULT agent — which covers that agent's own pause, ALL_AGENTS and AGENT_HALT, and fails CLOSED on an
// unreadable store (_pause.mjs). The user's manual reclaim (agent-vault-withdraw) stays pause-exempt: pausing never
// traps funds; it only stops the agent acting alone.

import { pauseReason } from "./_pause.mjs";
import { AGENT } from "./_agents.mjs";
import { shareLimitForRecord } from "../../shared/vault-mandate/share-limit.mjs";
import { buildHaltIncident, readHaltLatch } from "../../shared/vault-mandate/halt.mjs";
import { MANDATE_STATUS } from "../../shared/vault-mandate/record.mjs";
import { decideExit } from "../../shared/vault-mandate/exit-decision.mjs";
import { readExitExecution } from "../../shared/vault-mandate/exit-reads.mjs";
import { exitPathGate } from "../../shared/vault-mandate/exit-path.mjs";
import { matchByRefId, resolveSubmitting, resolveSubmitted, resolveRedeemed } from "../../shared/vault-mandate/exit-recovery.mjs";
import { classifyExitOutcome, EXIT_FLAG } from "../../shared/vault-mandate/exit-outcome.mjs";
import { buildExitIntent, advanceExitIntent, exitIntentKey, retryDecision, buildNeverSubmittedIntent, settledOutcomeOf, verifyExitIntent, resolveExitState, EXIT_INTENT_OPEN } from "../../shared/vault-mandate/exit-intent.mjs";

/**
 * The pause input decideExit (shared/vault-mandate/exit-decision.mjs) requires: {checked:true, reason:string|null}.
 * `reason` non-null = stopped (paused, halted, or the switch could not be read).
 */
export async function exitPauseCheck({ walletAddress }) {
  const reason = await pauseReason({ owner: walletAddress, agent: AGENT.VAULT });
  return { checked: true, reason: reason ?? null };
}

// ═══ PIECE 5 STEP 3: THE ONLY EXIT SUBMIT — BOUNDED BY min(tracked, live), BEHIND THE HALT LATCH ═══════════════
// ⛔ There is no share amount to pass. The limit is computed HERE from the record's own progress and the live balance
// (share-limit.mjs), so the executor cannot submit more than min(tracked, live): tracked is the mandate's authority and
// an inflated live figure cannot raise it. A `shares` argument is refused outright. That is what keeps
// BEYOND_MANDATE_SHARES a detector of a DEFECT (the chain burned more than was submitted), never an ordinary outcome.
// ⛔ The halt latch is read FIRST and fails CLOSED: halted, unreadable, malformed, or no reader → nothing submitted.
// ⚠️ NOT WIRED: no production caller yet (the executor is step 6). decideExit (arming, anchor, fee, pause) gates it there;
// this function adds the share bound and the latch, not the arming.
/**
 * @param {{record:object, liveShares:bigint|string, halt:{read:Function}, idempotencyKey?:string,
 *          onSubmitted?:Function, submit?:Function}} args — `submit` is injected by the suite; production loads
 *          submitRedeem from _vault.mjs.
 * @returns {{submitted:false, code:string, why?:string, limit?:object} | {submitted:true, sharesSubmitted:string, limit:object, circleId, redeemHash}}
 */
export async function submitMandateExitRedeem(args) {
  if (args && Object.prototype.hasOwnProperty.call(args, "shares")) {
    throw new Error("submitMandateExitRedeem takes no share amount: it redeems min(tracked, live), computed from the record");
  }
  const { record, liveShares, halt, idempotencyKey, refId, onSubmitted = null, submit = null } = args ?? {};
  const h = await readHaltLatch(halt);
  if (!h.readable) return { submitted: false, code: "halt-unreadable", why: h.why };
  if (h.halted) return { submitted: false, code: "halted", why: h.why };

  const lim = shareLimitForRecord(record, liveShares);
  if (!lim.ok) return { submitted: false, code: lim.code, why: lim.why };
  if (lim.nothingToRedeem) {
    return { submitted: false, code: "nothing-to-redeem", limit: lim,
      why: `the mandate holds no shares of its own to redeem (tracked ${lim.tracked}); ${lim.notTheMandates} shares in the wallet are not the mandate's and stay` };
  }
  const { submitRedeem } = submit ? { submitRedeem: submit } : await import("./_vault.mjs");
  const r = await submitRedeem({ walletAddress: record.walletAddress, vault: record.vault, shares: lim.shares, idempotencyKey, refId, onSubmitted });
  return { submitted: true, sharesSubmitted: lim.shares, limit: lim, circleId: r?.circleId ?? null, redeemHash: r?.redeemHash ?? null };
}

/**
 * On a classified exit outcome: BEYOND_MANDATE_SHARES → record the incident (create-only) and report halted.
 * ⛔ If the record cannot be written, it STILL reports halted:true (recorded:false): the caller stops regardless.
 * @returns {{halted:boolean, recorded:boolean, incident?:object, why?:string}}
 */
export async function haltIfBeyondMandate({ halt, classified, context, now }) {
  const incident = buildHaltIncident({ classified, context, now });
  if (!incident) return { halted: false, recorded: false };
  try {
    const w = await halt.record(incident);
    return { halted: true, recorded: w?.ok === true || w?.exists === true, incident };
  } catch (e) {
    console.error(`[vault-mandate-exit] HALT incident could not be recorded: ${String(e?.message ?? e)} — ${JSON.stringify(incident)}`);
    return { halted: true, recorded: false, incident, why: `the halt incident could not be recorded: ${String(e?.message ?? e)}` };
  }
}

// ═══ PIECE 5 STEP 4: BEGINNING AN EXIT — `exiting` FIRST, THEN THE ONE INTENT ════════════════════════════════
// Order, and why each refusal comes where it does:
//   0. the halt latch (step 3) — halted or unreadable: nothing starts.
//   1. the mandate: readable, consistent, `active` or `exit-blocked`. `exiting` = an exit in flight → refused.
//   2. every past ATTEMPT, x/…/1..n (n = record.exit.attempt; step 4c), through retryDecision: unreadable blocks
//      (never "absent"), a missing number is inconsistent, an OPEN one → exit-in-flight (never resubmit), the caps
//      (3 failed, 6 real attempts) and the hour after the last closed. Then x/…/<n+1> itself must read absent.
//   3. open DEPOSIT intents (C8): any open, or unreadable → refused.
//   4. the share limit (step 3): refused, or nothing to redeem → refused, NOTHING written.
//   5. the mandate → `exiting` AND exit.attempt = n+1, in ONE CAS. Lost → refused, no intent.
//   6. ⭐ open deposit intents AGAIN. The deposit path works from the record the tick read earlier and does not re-read
//      it before writing its intent, so a deposit that read `active` can still write an intent after step 3. Seen
//      here → the status is handed back (CAS) and the exit refuses; no exit intent. (The deposit side of this race is
//      NOT closed by this: see PROGRESS, step 4.)
//   7. the exit intent, create-only. A throw leaves the mandate `exiting` with no intent: resolveExitState reads that
//      as nothing-submitted (a submit only ever follows a written intent).
// Nothing here submits: the submit is submitMandateExitRedeem, and the executor (step 6) wires the two.
/**
 * @param {{owner:string, id:string, liveShares:bigint|string,
 *          deps:{mandates, depositIntents, exitIntents, halt, now:Function}}} a
 * @returns {{ok:true, key:string, intent:object} | {ok:false, code:string, why:string, mandateExiting?:boolean}}
 */
export async function beginMandateExit({ owner, id, liveShares, expectShares = undefined, deps }) {
  const no = (code, why, extra = {}) => ({ ok: false, code, why, ...extra });
  const h = await readHaltLatch(deps?.halt);
  if (!h.readable) return no("halt-unreadable", h.why);
  if (h.halted) return no("halted", h.why);

  const r = await deps.mandates.read({ owner, id });
  if (!r?.readable) return no("mandate-unreadable", (r?.errors ?? []).join("; ") || "the mandate could not be read");
  if (!r.record) return no("no-mandate", "no such mandate");
  if (!r.verdict?.ok) return no("mandate-inconsistent", (r.verdict?.errors ?? []).join("; "));
  const record = r.record;
  if (record.status === MANDATE_STATUS.EXITING) return no("exit-in-flight", "the mandate is already exiting: one exit at a time");
  if (record.status !== MANDATE_STATUS.ACTIVE && record.status !== MANDATE_STATUS.EXIT_BLOCKED) {
    return no("status-may-not-exit", `status ${JSON.stringify(record.status)} may not begin an exit`);
  }

  // 2. every past attempt, by number (strong GETs; never a list)
  const n = record.exit?.attempt ?? 0;
  const attempts = [];
  for (let k = 1; k <= n; k++) attempts.push({ n: k, read: await deps.exitIntents.read(owner, id, k) });
  const rd = retryDecision({ record, attempts, now: deps.now() });
  if (!rd.ok) return no(rd.code, rd.why);
  const next = rd.next;
  const nx = await deps.exitIntents.read(owner, id, next);
  if (!nx?.readable) return no("exit-intent-unreadable", nx?.why ?? `attempt ${next}'s key could not be read; it is never treated as absent`);
  if (nx.intent) return no("exit-intent-exists", `attempt ${next} already has a record the mandate does not name`);

  const openDeposits = async () => {
    const d = await deps.depositIntents.listOpen(owner, id);
    if (!d?.readable) return no("deposit-intents-unreadable", d?.why ?? "the deposit intents could not be read; never read as none open");
    if ((d.intents ?? []).length) return no("open-deposit-intent", `an open deposit intent (${d.intents.map((i) => i.key).join(", ")}) blocks the exit (C8)`);
    return null;
  };
  const d1 = await openDeposits();
  if (d1) return d1;

  const limit = shareLimitForRecord(record, liveShares);
  if (!limit.ok) return no(limit.code, limit.why);
  if (limit.nothingToRedeem) return no("nothing-to-redeem", `the mandate holds no shares of its own (tracked ${limit.tracked}); ${limit.notTheMandates} in the wallet are not the mandate's`);
  // step 5: the fresh reads SIMULATED a redeem of `expectShares`. If the limit moved since (the record changed), that
  // simulation was of another amount: refused BEFORE anything is written, and a later tick reads again.
  if (expectShares !== undefined && String(expectShares) !== limit.shares) {
    return no("limit-moved", `the reads simulated ${expectShares} shares but the limit is now ${limit.shares}: the simulation no longer covers this exit`);
  }
  const built = buildExitIntent({ record, limit, now: deps.now(), attempt: next,
    retryOf: n > 0 ? { attempt: n, lastOutcome: rd.lastOutcome, kind: rd.kind } : null });
  if (!built.ok) return no("intent-unbuildable", built.why);

  // 5. `exiting` BEFORE the intent
  const u = await deps.mandates.update({ owner, id, etag: r.etag,
    record: { ...record, status: MANDATE_STATUS.EXITING, exit: { attempt: next, fromStatus: record.status } } });
  if (!u?.ok) return no("status-write-failed", (u?.errors ?? []).join("; ") || "the mandate could not be set exiting; no intent written");

  // 6. the re-check, now that no NEW deposit can start from a fresh read
  const d2 = await openDeposits();
  if (d2) {
    const back = await deps.mandates.update({ owner, id, record, etag: u.etag }).catch(() => null);
    return { ...d2, mandateExiting: back?.ok !== true, why: `${d2.why}; seen after the mandate was set exiting, so the exit stops here` +
      (back?.ok ? " and the mandate is handed back its prior status" : " and the mandate could NOT be handed back: it stays exiting with no intent (resolvable: nothing submitted)") };
  }

  // 7. the one intent, create-only
  let c;
  try { c = await deps.exitIntents.create(built.intent.key, built.intent); }
  catch (e) { return no("exit-intent-unwritten", `the exit intent could not be written (${String(e?.message ?? e)}); the mandate is exiting with nothing submitted`, { mandateExiting: true }); }
  if (c?.exists) return no("exit-intent-exists", "another writer created the exit intent first; it governs", { mandateExiting: true });
  if (!c?.ok) return no("exit-intent-unwritten", "the exit intent could not be written; the mandate is exiting with nothing submitted", { mandateExiting: true });
  return { ok: true, key: built.intent.key, intent: built.intent };
}

/** Move the STORED exit intent of one attempt one step (advanceExitIntent), under CAS. Unreadable, absent or a lost CAS → refused. */
export async function advanceStoredExitIntent({ exitIntents, owner, id, attempt, at, ...step }) {
  const x = await exitIntents.read(owner, id, attempt);
  if (!x?.readable) return { ok: false, code: "exit-intent-unreadable", why: x?.why ?? "unreadable" };
  if (!x.intent) return { ok: false, code: "no-exit-intent", why: "there is no exit intent to advance" };
  const a = advanceExitIntent(x.intent, { at, ...step });
  if (!a.ok) return { ok: false, code: "refused-move", why: a.why };
  const u = await exitIntents.update(exitIntentKey(owner, id, attempt), a.intent, x.etag);
  if (!u?.ok) return { ok: false, code: "conflict", why: "the exit intent changed while it was being advanced" };
  return { ok: true, intent: a.intent };
}

// ═══ PIECE 5 STEP 4c: SETTLING AN ATTEMPT — the mandate leaves `exiting` ═════════════════════════════════════
// Reads the attempt the RECORD names (x/…/<exit.attempt>) and moves the mandate, in ONE CAS:
//   exited        → `closed`, tracked shares 0 (the mandate's shares are gone)
//   exit-partial  → `exit-blocked`, tracked shares − the shares the attempt redeemed. ⛔ Without this a retry would
//                   compute min(OLD tracked, live), and live includes hand-deposited shares: the retry could take them.
//   failed        → `exit-blocked`, tracked unchanged
//   no intent     → a create-only NEVER-SUBMITTED record at that number (so every number ≤ n has a record), then the
//                   status the attempt started from. If an intent lands first, the tombstone is refused and nothing moves.
//   open          → refused: the attempt is in flight (recovery reads Circle / the chain first).
// Unreadable, not exiting, or a lost CAS → refused, nothing written.
export async function settleExitAttempt({ owner, id, deps }) {
  const no = (code, why) => ({ ok: false, code, why });
  const r = await deps.mandates.read({ owner, id });
  if (!r?.readable) return no("mandate-unreadable", (r?.errors ?? []).join("; ") || "unreadable");
  if (!r.record || !r.verdict?.ok) return no("mandate-inconsistent", (r?.verdict?.errors ?? ["no mandate"]).join("; "));
  const record = r.record;
  if (record.status !== MANDATE_STATUS.EXITING) return no("not-exiting", `status ${JSON.stringify(record.status)}: nothing to settle`);
  const n = record.exit.attempt;
  const x = await deps.exitIntents.read(owner, id, n);
  if (!x?.readable) return no("exit-intent-unreadable", x?.why ?? `attempt ${n} could not be read; it is never treated as absent`);
  const back = (lastOutcome, status, progress = record.progress) => ({ ...record, status, progress,
    exit: { attempt: n, fromStatus: record.exit.fromStatus, lastOutcome } });
  let next;
  if (!x.intent) {
    const tomb = buildNeverSubmittedIntent({ record, attempt: n, now: deps.now() });
    let c;
    try { c = await deps.exitIntents.create(tomb.key, tomb); } catch (e) { return no("tombstone-unwritten", `the never-submitted record could not be written (${String(e?.message ?? e)})`); }
    if (c?.exists) return no("intent-appeared", `attempt ${n}'s intent appeared before its never-submitted record: re-read and settle again`);
    if (!c?.ok) return no("tombstone-unwritten", "the never-submitted record could not be written");
    next = back("not-submitted", record.exit.fromStatus);
  } else {
    if (EXIT_INTENT_OPEN.includes(x.intent.state)) return no("attempt-in-flight", `attempt ${n} is ${x.intent.state}: it resolves first`);
    const v = verifyExitIntent(x.intent);
    if (!v.ok) return no("exit-intent-malformed", v.errors.join("; "));
    const outcome = settledOutcomeOf(x.intent);
    if (outcome === "exited") next = back("exited", MANDATE_STATUS.CLOSED, { ...record.progress, sharesTrackedRaw: "0" });
    else if (outcome === "exit-partial") {
      const redeemed = x.intent.outcome?.mandateSharesRedeemed, tracked = record.progress.sharesTrackedRaw;
      if (!/^\d+$/.test(String(redeemed ?? "")) || BigInt(redeemed) > BigInt(tracked)) {
        return no("outcome-inconsistent", `the partial outcome's redeemed shares (${JSON.stringify(redeemed)}) do not fit the tracked ${tracked}`);
      }
      next = back("exit-partial", MANDATE_STATUS.EXIT_BLOCKED, { ...record.progress, sharesTrackedRaw: (BigInt(tracked) - BigInt(redeemed)).toString() });
    } else if (outcome === "failed" || outcome === "not-submitted") next = back(outcome, outcome === "failed" ? MANDATE_STATUS.EXIT_BLOCKED : record.exit.fromStatus);
    else return no("exit-intent-malformed", `attempt ${n} settled as ${JSON.stringify(outcome)}`);
  }
  const u = await deps.mandates.update({ owner, id, record: next, etag: r.etag });
  if (!u?.ok) return no("status-write-failed", (u?.errors ?? []).join("; ") || "the mandate changed while it was being settled");
  return { ok: true, attempt: n, status: next.status, lastOutcome: next.exit.lastOutcome, sharesTrackedRaw: next.progress.sharesTrackedRaw };
}

// ═══ PIECE 5 STEP 5: THE EXIT SEQUENCE — READS → INTENT → SUBMIT (T, 2026-09-29) ═══════════════════════════════
// The order IS the safety property, so it is one function, in this order:
//   1. READS     readExitExecution: a fresh anchor, the live shares → the limit, the exit fee, the exit path, a
//                SIMULATED redeem of exactly the limit — on both endpoints, agreed. Nothing written.
//   2. GATES     exitPathGate (blocker 3: the exit path the finding check recorded vs now; unknown REFUSES) and
//                decideExit (authority, the finding re-decided, the anchor's chain time, the fee at execution, the pause,
//                arming). Nothing written.
//   3. INTENT    beginMandateExit, told the amount the reads simulated (`expectShares`): `exiting` + the attempt, then
//                the create-only intent. The first write of the exit.
//   4. SUBMIT    submitMandateExitRedeem (the step-3 bound + the halt latch), with the intent's idempotency key; the
//                intent advances submitted (Circle id, via onSubmitted) → redeemed (hash).
// ⛔ Every refusal in 1–2 writes NOTHING, so it burns no attempt: a vault short of cash is refused by the simulation and
//    retried on a later tick. ⛔ A submit that THROWS leaves the intent OPEN (outcome unknown → recovery), never failed.
// ⛔ `decide` defaults to decideExit with NO config: the shipped arming (MANDATE_EXIT_ARMED = false) applies, so in
//    production this stops at step 2, disarmed. Tests inject an armed decider; no production code passes `config`.
// ⚠️ NOT WIRED: no production caller (step 6: the background executor + recovery, which also classifies and settles).
/**
 * @param {{owner, id, finding:{check, anchor, exitPath}, deps:{mandates, depositIntents, exitIntents, halt, now, readers,
 *          decide?, pauseCheck?, submit?}}} a
 */
export async function runMandateExit({ owner, id, finding, deps }) {
  const stop = (stage, r) => ({ ok: false, stage, code: r.code, why: r.why, then: r.then ?? "none", ...(r.wouldExit ? { wouldExit: true } : {}) });
  const h = await readHaltLatch(deps.halt);
  if (!h.readable) return stop("halt", { code: "halt-unreadable", why: h.why });
  if (h.halted) return stop("halt", { code: "halted", why: h.why });
  const r = await deps.mandates.read({ owner, id });
  if (!r?.readable || !r.record) return stop("mandate", { code: "mandate-unreadable", why: (r?.errors ?? []).join("; ") || "no mandate", then: "retry" });
  const record = r.record;

  // 1. READS
  const reads = await readExitExecution({ record, readers: deps.readers });
  if (!reads.ok) return stop("reads", reads);

  // 2. GATES
  const path = exitPathGate({ recorded: finding?.exitPath, fresh: reads.exitPath });
  if (!path.ok) return stop("exit-path", path);
  const pause = await (deps.pauseCheck ?? exitPauseCheck)({ walletAddress: record.walletAddress });
  const decide = deps.decide ?? ((a) => decideExit(a));
  const d = await decide({ record, finding, execution: { exitFeeBps: reads.exitFeeBps }, pause });
  if (!d?.go) return stop("decide", d ?? { code: "no-decision", why: "the decision returned nothing" });

  // 3. INTENT
  const b = await beginMandateExit({ owner, id, liveShares: reads.liveShares, expectShares: reads.limit.shares, deps });
  if (!b.ok) return stop("intent", b);
  const attempt = b.intent.attempt;

  // 4. SUBMIT
  let s;
  try {
    s = await submitMandateExitRedeem({ record, liveShares: reads.liveShares, halt: deps.halt, idempotencyKey: b.intent.idempotencyKey, refId: b.intent.key, submit: deps.submit,
      onSubmitted: async ({ circleId }) => { await advanceStoredExitIntent({ exitIntents: deps.exitIntents, owner, id, attempt, to: "submitted", circleId, at: deps.now() }); } });
  } catch (e) {
    return { ok: false, stage: "submit", code: "submit-outcome-unknown", attempt, then: "recover",
      why: `the submit threw (${String(e?.message ?? e)}); the intent stays open and recovery reads Circle and the chain — never marked failed on an exception` };
  }
  if (!s.submitted) return { ok: false, stage: "submit", code: s.code, why: s.why, attempt, then: "recover" };
  const adv = await advanceStoredExitIntent({ exitIntents: deps.exitIntents, owner, id, attempt, to: "redeemed", txHash: s.redeemHash, at: deps.now() });
  return { ok: true, attempt, circleId: s.circleId, redeemHash: s.redeemHash, sharesSubmitted: s.sharesSubmitted,
    reads: { anchor: reads.anchor, exitFeeBps: reads.exitFeeBps, measuredExitBps: reads.measuredExitBps, simulation: reads.simulation, exitPath: reads.exitPath },
    ...(adv.ok ? {} : { warning: `the redeemed hash could not be recorded on the intent (${adv.why}); recovery finds it by the Circle id` }) };
}

// ═══ PIECE 5 STEP 6: RECOVERY — LOOK UP, CLASSIFY FROM THE CHAIN, SETTLE; NEVER RE-SEND ═════════════════════════
// Runs every tick for an `exiting` mandate (and from the background executor). One pass moves the attempt the record
// names as far as its instruments allow, then stops at the first `wait` / `stuck` / blocked:
//   no intent   → settle (a never-submitted record, the prior status)
//   submitting  → the wallet's Circle transactions, matched by refId (= the intent key) → submitted | STUCK (not found is
//                 never "not submitted") | wait
//   submitted   → Circle's state → redeemed | failed (no hash: never broadcast) | wait
//   redeemed    → the CHAIN via classifyExitOutcome → asserted | failed | wait (unconfirmed)
//   terminal    → settle (closed / exit-blocked, tracked adjusted — 4c)
// ⛔ BEYOND_MANDATE_SHARES → the HALT incident is recorded FIRST; if it cannot be recorded, nothing further is written.
// ⛔ It NEVER submits: the key's retention was measured only to 32 s (2026-09-30), so a re-send on a later tick could
//    create a second redeem. It reads and records only, so it runs even while the agent is paused or halted.
/**
 * @param {{owner, id, deps:{mandates, exitIntents, halt, now, circleTxsForWallet, circleState, exitFacts, usdcAddress}}} a
 */
export async function recoverMandateExit({ owner, id, deps }) {
  const steps = []; let halted = false;
  const no = (code, why, extra = {}) => ({ ok: false, code, why, steps, ...(halted ? { halted: true } : {}), ...extra });
  const recordHalt = async (classified, record, intent) => {
    const h = await haltIfBeyondMandate({ halt: deps.halt, classified, now: deps.now(),
      context: { owner, id, walletAddress: record.walletAddress, vault: record.vault?.address ?? null, sharesToRedeem: intent.sharesToRedeem, sharesTracked: intent.sharesTracked, sharesTrackedGaps: intent.sharesTrackedGaps } });
    if (h.halted) halted = true;
    return h;
  };
  for (let pass = 0; pass < 8; pass++) {
    const r = await deps.mandates.read({ owner, id });
    if (!r?.readable) return no("mandate-unreadable", (r?.errors ?? []).join("; ") || "unreadable");
    if (!r.record) return no("no-mandate", "no such mandate");
    const record = r.record;
    if (record.status !== MANDATE_STATUS.EXITING) {
      return { ok: true, code: steps.length ? "settled" : "not-exiting", status: record.status, steps, ...(halted ? { halted: true } : {}) };
    }
    const n = record.exit?.attempt;
    const x = await deps.exitIntents.read(owner, id, n);
    const res = resolveExitState({ record, read: x });
    const advance = async (to, extra) => {
      const a = await advanceStoredExitIntent({ exitIntents: deps.exitIntents, owner, id, attempt: n, to, at: deps.now(), ...extra });
      steps.push({ attempt: n, to, ok: a.ok, ...(a.ok ? {} : { why: a.why }) });
      return a;
    };

    if (res.action === "blocked") return no(res.code, res.why);
    if (res.action === "nothing-submitted" || res.action === "close") {
      if (res.action === "close" && x.intent?.outcome?.flags?.includes?.(EXIT_FLAG.BEYOND_MANDATE_SHARES)) {
        const h = await recordHalt(x.intent.outcome, record, x.intent); // idempotent: create-only, an existing record counts
        if (!h.recorded) return no("halt-unrecorded", h.why ?? "the BEYOND_MANDATE_SHARES incident could not be recorded; nothing is settled");
      }
      const st = await settleExitAttempt({ owner, id, deps });
      steps.push({ attempt: n, settle: st.ok ? st.status : st.code });
      if (!st.ok) return no(st.code, st.why);
      continue;
    }
    if (res.action === "locate-by-idempotency-key") {
      let lookup;
      try { lookup = await deps.circleTxsForWallet({ walletAddress: record.walletAddress, since: x.intent.createdAt }); } catch { lookup = null; }
      const readable = lookup?.readable === true;
      const d = resolveSubmitting({ intent: x.intent, lookup: { readable, match: readable ? matchByRefId({ intent: x.intent, txs: lookup.txs }) : undefined } });
      if (!d.to) return no(d.action === "wait" ? "wait" : d.code, d.why);
      const a = await advance("submitted", { circleId: d.circleId });
      if (!a.ok) return no(a.code, a.why);
      continue;
    }
    if (res.action === "read-circle") {
      let circle;
      try { circle = await deps.circleState(res.circleId); } catch { circle = null; }
      const d = resolveSubmitted({ intent: x.intent, circle });
      if (!d.to) return no("wait", d.why);
      const a = await advance(d.to, d.to === "redeemed" ? { txHash: d.txHash } : { reason: d.reason });
      if (!a.ok) return no(a.code, a.why);
      continue;
    }
    if (res.action === "classify") {
      let facts;
      try { facts = await deps.exitFacts({ intent: x.intent, record }); } catch { facts = null; }
      const classified = classifyExitOutcome({ config: { vault: record.vault?.address, usdc: deps.usdcAddress, wallet: record.walletAddress },
        intent: { sharesToRedeem: x.intent.sharesToRedeem, sharesTracked: x.intent.sharesTracked, sharesTrackedGaps: x.intent.sharesTrackedGaps }, facts: facts ?? {} });
      if (classified.flags?.includes?.(EXIT_FLAG.BEYOND_MANDATE_SHARES)) {
        const h = await recordHalt(classified, record, x.intent);
        if (!h.recorded) return no("halt-unrecorded", h.why ?? "the BEYOND_MANDATE_SHARES incident could not be recorded; nothing is settled");
      }
      const d = resolveRedeemed({ classified });
      if (!d.to) return no("wait", d.why, { classified: { outcome: classified.outcome, why: classified.why } });
      const a = await advance(d.to, { outcome: d.outcome });
      if (!a.ok) return no(a.code, a.why);
      continue;
    }
    return no("unhandled", `no recovery for ${JSON.stringify(res.action)}`);
  }
  return no("recovery-bound", "recovery did not settle within its pass bound; read again next tick");
}
