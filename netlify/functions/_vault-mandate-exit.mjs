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
import { buildExitIntent, advanceExitIntent, exitIntentKey, EXIT_INTENT_OPEN, EXIT_INTENT_STATE } from "../../shared/vault-mandate/exit-intent.mjs";

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
  const { record, liveShares, halt, idempotencyKey, onSubmitted = null, submit = null } = args ?? {};
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
  const r = await submitRedeem({ walletAddress: record.walletAddress, vault: record.vault, shares: lim.shares, idempotencyKey, onSubmitted });
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
//   2. the exit intent: UNREADABLE blocks (never "absent"); an OPEN one → exit-in-flight (never resubmit); a TERMINAL
//      one → refused (one intent per mandate, one key; there is no second attempt key).
//   3. open DEPOSIT intents (C8): any open, or unreadable → refused.
//   4. the share limit (step 3): refused, or nothing to redeem → refused, NOTHING written.
//   5. the mandate → `exiting` (CAS). Lost → refused, no intent.
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
export async function beginMandateExit({ owner, id, liveShares, deps }) {
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

  const x = await deps.exitIntents.read(owner, id);
  if (!x?.readable) return no("exit-intent-unreadable", x?.why ?? "the exit intent could not be read; it is never treated as absent");
  if (x.intent) {
    if (EXIT_INTENT_OPEN.includes(x.intent.state)) return no("exit-in-flight", `an exit intent is open (${x.intent.state}): never resubmit while one is open`);
    if (x.intent.state === EXIT_INTENT_STATE.ASSERTED || x.intent.state === EXIT_INTENT_STATE.FAILED) {
      return no("exit-intent-exists", `the mandate's one exit intent is already ${x.intent.state}; there is no second intent`);
    }
    return no("exit-intent-malformed", `an exit intent exists in an unknown state ${JSON.stringify(x.intent.state)}`);
  }

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
  const built = buildExitIntent({ record, limit, now: deps.now() });
  if (!built.ok) return no("intent-unbuildable", built.why);

  // 5. `exiting` BEFORE the intent
  const u = await deps.mandates.update({ owner, id, record: { ...record, status: MANDATE_STATUS.EXITING }, etag: r.etag });
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

/** Move the STORED exit intent one step (advanceExitIntent), under CAS. Unreadable, absent or a lost CAS → refused. */
export async function advanceStoredExitIntent({ exitIntents, owner, id, at, ...step }) {
  const x = await exitIntents.read(owner, id);
  if (!x?.readable) return { ok: false, code: "exit-intent-unreadable", why: x?.why ?? "unreadable" };
  if (!x.intent) return { ok: false, code: "no-exit-intent", why: "there is no exit intent to advance" };
  const a = advanceExitIntent(x.intent, { at, ...step });
  if (!a.ok) return { ok: false, code: "refused-move", why: a.why };
  const u = await exitIntents.update(exitIntentKey(owner, id), a.intent, x.etag);
  if (!u?.ok) return { ok: false, code: "conflict", why: "the exit intent changed while it was being advanced" };
  return { ok: true, intent: a.intent };
}
