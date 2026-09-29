// _vault-mandate-exit.mjs — piece 5's server-side exit module: the exit's OWN pause check, and (step 3) the bounded
// exit submit (min(tracked, live)) and the halt latch's exit side. The executor itself (intent, state machine,
// recovery) is not built; it will live here.
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
