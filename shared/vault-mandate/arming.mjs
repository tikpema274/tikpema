// arming.mjs — WHICH arming constant governs THIS mandate. One rule, for the deposit side and the exit side.
//
// ═══ DECISION (T, 2026-09-27 deposits; 2026-09-28 exits; built 2026-10-01 for the piece 5 live exit) ═══════════════
// Operator mandates are armed by their OWN constants, so the first real deposit and exit land on T's wallet alone:
//   deposits: MANDATE_DEPOSIT_ARMED (user) · MANDATE_DEPOSIT_ARMED_OPERATOR (operator)      — _vault-mandate-deposit.mjs
//   exits:    MANDATE_EXIT_ARMED (user)    · MANDATE_EXIT_ARMED_OPERATOR (operator)         — limits.mjs
// each with its own ARMED_FROM. ⛔ NEVER ONE CONSTANT SERVING BOTH: the user constant arms user-origin mandates ONLY,
// the operator constant arms operator-origin mandates ONLY. Before 2026-10-01 the single user constant would have armed
// every mandate, operator ones included (test:mandatedeposit §6b and test:mandateexitdecide §8 recorded that red).
// An operator-origin record is re-checked against OPERATOR_MANDATE_OWNERS here too (record.mjs already refuses it on
// every read): a record relabelled "operator" by a user cannot borrow the operator constant.
//
// Pure: the caller passes its config ({armed, armedFrom, armedOperator, armedFromOperator}); the shipped constants live
// where they always did. Unknown origin → not armed by anything.

import { MANDATE_ORIGIN } from "./record.mjs";
import { isOperatorOwner } from "./operators.mjs";

/**
 * @param {object} record  the mandate record (origin, owner)
 * @param {{armed?:boolean, armedFrom?:number|null, armedOperator?:boolean, armedFromOperator?:number|null}} config
 * @returns {{armed:boolean, armedFrom:number|null, scope:"user"|"operator"|null, constant:string|null, why?:string}}
 */
export function armingFor(record, config) {
  const origin = record?.origin;
  if (origin === MANDATE_ORIGIN.OPERATOR) {
    if (!isOperatorOwner(record?.owner)) {
      return { armed: false, armedFrom: null, scope: "operator", constant: null, why: "an operator-origin record whose owner is not in OPERATOR_MANDATE_OWNERS is armed by nothing" };
    }
    return { armed: config?.armedOperator === true, armedFrom: config?.armedFromOperator ?? null, scope: "operator", constant: "operator" };
  }
  if (origin === MANDATE_ORIGIN.USER) {
    return { armed: config?.armed === true, armedFrom: config?.armedFrom ?? null, scope: "user", constant: "user" };
  }
  return { armed: false, armedFrom: null, scope: null, constant: null, why: `origin ${JSON.stringify(origin)} is armed by nothing` };
}
