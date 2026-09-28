// exit-decision.mjs — piece 5: the PURE EXIT DECISION. May this exit go, and if not, why and what happens next.
// Design: PROGRESS "VAULT MANDATE — PIECE 5" §4 (arming) + §7 (the pause gate, the fee sanity gate) and the corrections
// C3 (arming by CHAIN time) and C6 (a null fee cap refuses); T's decisions of 2026-09-27/28. Pure: no chain, no store,
// no clock. The executor (not built) gathers the inputs and acts on the answer.
//
// ═══ THE GATES, IN ORDER ═════════════════════════════════════════════════════════════════════════════════
//   1. EXIT AUTHORITY: the record is consistent, ACKNOWLEDGED against the fingerprint of now, and `active` or
//      `exit-blocked` (a retry). `exiting` refuses: one exit at a time. A deposits pause does NOT block an exit (it is
//      often this very finding that paused them). A stale acknowledgement keeps monitoring, never exit authority.
//   2. THE FINDING, RE-DECIDED from the record's rules and the check (never a passed-in decision): it must be EXIT.
//   3. THE ANCHOR: the finding's anchor is the check's own, and it carries the block's CHAIN timestamp (seconds).
//   4. THE FEE SANITY GATE: the fee at execution (both endpoints agreed) ≤ the baseline cap the user was shown.
//      ⛔ A NULL cap REFUSES (C6): with no cap read at creation, "you may pay up to the cap" was never a bound.
//      Above the cap, the disclosure is false → pause INCONCLUSIVE, never an exit at an undisclosed price.
//   5. THE PAUSE GATE: the exit's OWN pause check (Vault pause, ALL_AGENTS, AGENT_HALT —
//      netlify/functions/_vault-mandate-exit.mjs), passed in as {checked:true, reason}. An UNCHECKED pause refuses.
//      ⛔ Never inherited from executeAction's isReclaim branch, which skips the pause by design (finding C).
//   6. ARMING, LAST, so a disarmed run still says what it WOULD do (the disarmed tick's "WOULD EXIT" receipt):
//      MANDATE_EXIT_ARMED, then MANDATE_EXIT_ARMED_FROM against the anchor's CHAIN timestamp. ⛔ Never wall-clock
//      `anchoredAt`: the one-clock identity guard lives on a non-enumerable function and does not survive storage (C3),
//      and a finding may come back from storage (an exit-blocked retry, a resumed pause, recovery).
//      Only checks anchored STRICTLY AFTER ARMED_FROM may execute: a finding recorded while disarmed never acts
//      retroactively.

import { verifyMandateRecord, MANDATE_STATUS } from "./record.mjs";
import { decideMandateAction, ACTION } from "./decide.mjs";
import { MANDATE_EXIT_ARMED, MANDATE_EXIT_ARMED_FROM } from "./limits.mjs";
import { isChainSeconds } from "./anchor.mjs";

const SHIPPED = Object.freeze({ armed: MANDATE_EXIT_ARMED, armedFrom: MANDATE_EXIT_ARMED_FROM });

export const EXIT_REFUSED = Object.freeze({
  RECORD: "record", NOT_AN_EXIT: "not-an-exit", ANCHOR_MISMATCH: "anchor-mismatch", ANCHOR_TIME: "anchor-time-unknown",
  FEE_CAP_UNKNOWN: "fee-cap-unknown", FEE_UNREAD: "fee-unread", FEE_ABOVE_CAP: "fee-above-cap",
  PAUSE_UNCHECKED: "pause-unchecked", PAUSED: "paused",
  DISARMED: "disarmed", ARMED_FROM_UNSET: "armed-from-unset", BEFORE_ARMED_FROM: "before-armed-from",
});
/** What the caller does next. `retry`: a later check may pass. `exit-due-paused`: the finding stays live and loud. */
export const EXIT_THEN = Object.freeze({ RETRY: "retry", PAUSE_INCONCLUSIVE: "pause-inconclusive", EXIT_DUE_PAUSED: "exit-due-paused", NONE: "none" });

const EXIT_STATUSES = new Set([MANDATE_STATUS.ACTIVE, MANDATE_STATUS.EXIT_BLOCKED]);
const isBps = (v) => Number.isInteger(v) && v >= 0 && v <= 10000;
// A chain timestamp is SECONDS. A value in the millisecond range is a wall-clock time in disguise and is refused.

/**
 * @param {{ record:object,
 *   finding:{ check:{outage, observations, anchor:{blockNumber, blockHash}}, anchor:{blockNumber, blockHash, timestamp:number} },
 *   execution:{ exitFeeBps:number|null },
 *   pause:{ checked:true, reason:string|null } | undefined,
 *   config?:{armed:boolean, armedFrom:number|null} }} a   `config`: ⛔ test seam only (source-guarded).
 * @returns {{go:true, exitFindings, anchor, feeBps, capBps} | {go:false, code, why, then, wouldExit?:boolean}}
 */
export function decideExit({ record, finding, execution, pause, config = SHIPPED } = {}) {
  const no = (code, why, then, extra = {}) => ({ go: false, code, why, then, ...extra });

  // 1. EXIT AUTHORITY
  const v = verifyMandateRecord(record);
  if (!v.ok) return no(EXIT_REFUSED.RECORD, `the mandate record is inconsistent: ${v.errors.join("; ")}`, EXIT_THEN.NONE);
  if (!EXIT_STATUSES.has(record.status)) {
    return no(EXIT_REFUSED.RECORD, record.status === MANDATE_STATUS.EXITING
      ? "an exit is already in flight for this mandate; one exit at a time"
      : `a mandate that is ${record.status} has no exit authority`, EXIT_THEN.NONE);
  }
  if (!record.ack || record.ack.fingerprint !== v.fingerprint) {
    return no(EXIT_REFUSED.RECORD, "stale acknowledgement: the user acknowledged a different set of rules; monitoring continues, exit authority does not", EXIT_THEN.NONE);
  }

  // 2. THE FINDING, RE-DECIDED
  const decision = decideMandateAction({ rules: record.rules, check: finding?.check });
  if (decision.action !== ACTION.EXIT) {
    return no(EXIT_REFUSED.NOT_AN_EXIT, `the check decides ${decision.action}, not exit (${decision.flags.join(", ") || "no flags"})`, EXIT_THEN.NONE);
  }

  // 3. THE ANCHOR: the check's own, with the block's CHAIN time
  const a = finding?.anchor, ca = finding?.check?.anchor;
  if (!a || !ca || a.blockNumber !== ca.blockNumber || String(a.blockHash).toLowerCase() !== String(ca.blockHash).toLowerCase()) {
    return no(EXIT_REFUSED.ANCHOR_MISMATCH, "the finding's anchor is not the anchor of the check that found it", EXIT_THEN.NONE);
  }
  if (!isChainSeconds(a.timestamp)) {
    return no(EXIT_REFUSED.ANCHOR_TIME, "the anchor block's CHAIN timestamp (seconds) is missing or malformed; wall-clock time is not accepted", EXIT_THEN.RETRY);
  }

  // 4. THE FEE SANITY GATE
  const cap = record.baseline?.maxFeeBps;
  if (!isBps(cap)) {
    return no(EXIT_REFUSED.FEE_CAP_UNKNOWN, "the vault's fee cap could not be read when this mandate was made, so no fee at execution can be shown to be within what the user was told", EXIT_THEN.PAUSE_INCONCLUSIVE);
  }
  const fee = execution?.exitFeeBps;
  if (!isBps(fee)) return no(EXIT_REFUSED.FEE_UNREAD, "the exit fee at execution could not be read on both endpoints alike", EXIT_THEN.RETRY);
  if (fee > cap) {
    return no(EXIT_REFUSED.FEE_ABOVE_CAP, `the exit fee at execution (${fee} bps) is above the cap the user was shown (${cap} bps): the disclosure is no longer true`, EXIT_THEN.PAUSE_INCONCLUSIVE);
  }

  // 5. THE PAUSE GATE
  if (!pause || pause.checked !== true) return no(EXIT_REFUSED.PAUSE_UNCHECKED, "the pause switch was not checked for this exit; never assumed running", EXIT_THEN.RETRY);
  if (pause.reason) return no(EXIT_REFUSED.PAUSED, `the exit is due but the agent is stopped: ${pause.reason}`, EXIT_THEN.EXIT_DUE_PAUSED);

  // 6. ARMING, LAST
  if (config?.armed !== true) {
    return no(EXIT_REFUSED.DISARMED, "the exit path is disarmed (MANDATE_EXIT_ARMED = false): nothing is submitted", EXIT_THEN.NONE, { wouldExit: true });
  }
  if (!Number.isFinite(config.armedFrom)) return no(EXIT_REFUSED.ARMED_FROM_UNSET, "armed with no MANDATE_EXIT_ARMED_FROM: the two are set together", EXIT_THEN.NONE);
  if (!(a.timestamp * 1000 > config.armedFrom)) {
    return no(EXIT_REFUSED.BEFORE_ARMED_FROM, "this finding's check was anchored before exits were armed; a finding recorded while disarmed is never acted on retroactively (a later check must find it again)", EXIT_THEN.NONE);
  }
  return { go: true, exitFindings: decision.exitFindings, anchor: a, feeBps: fee, capBps: cap };
}
