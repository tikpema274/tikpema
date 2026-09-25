// decide.mjs — the VAULT MANDATE's decision core. Pure: no chain, no store, no clock.
//
// ═══ THE RULE THIS FILE EXISTS TO ENFORCE (T, 2026-09-25) ════════════════════════════════════
// EXIT ON A FINDING, NEVER ON A FAILURE TO READ.
//   · A check that could not establish something — OUTAGE (our instrument failed; retry) or
//     INCONCLUSIVE (the instrument answered but could not establish it) — blocks further deposits
//     and pauses the mandate. It NEVER withdraws.
//   · A check that SUCCEEDED and found a power or state the user's rule refuses may withdraw, and
//     only if the user chose "exit" for THAT rule rather than "pause".
// The agent carries out the user's standing instruction. It never forms a view: there is no score,
// no price, no market input, and no rule the user did not write.
//
// ⭐ WHY "NOT CLEAR" MUST NEVER MEAN "FOUND". An exit is a withdrawal the vault taxes at a fee it
// sets (up to its cap). A decider that treats every non-clear rule as failed would withdraw on an
// RPC outage — money moved by our own broken instrument, at a price set by the party being exited.
// So a finding needs three things: the whole check was not an outage, the observation says
// `violated` in the closed vocabulary, and it carries the evidence the receipt will show. Anything
// short of that is UNESTABLISHED, and unestablished only ever pauses.
//
// ⭐ AN UNREADABLE SIBLING DOES NOT VETO A REAL FINDING. If rule A is established violated (exit)
// and rule B could not be read, the result is EXIT, flagged with both. The other way round would
// let the party being exited cancel every exit rule by making one unrelated getter revert. The exit
// is justified by `exitFindings` alone; the unreadable rule is reported but never counted as one.
//
// ⚠️ WHAT THIS FILE DOES NOT DO: read the chain, turn a DD report or an inspection into observations
// (that is the adapter, built next), store a mandate, or move money. It returns a decision. The
// executor that acts on EXIT must report a half-completed redemption as partial, never as done.

import { POWER_SIGS } from "../onchain-facts/index.mjs";

/** The user's per-rule choice when that rule is found violated. Closed set, no default here. */
export const ON_FINDING = Object.freeze({ PAUSE: "pause", EXIT: "exit" });
/** What one check established about one rule. Closed set: anything else is our instrument failing. */
export const OBSERVED = Object.freeze({ VIOLATED: "violated", CLEAR: "clear", UNESTABLISHED: "unestablished" });
/** Why a rule is unestablished. OUTAGE = our instrument failed (retry); INCONCLUSIVE = it answered, could not establish. */
export const CAUSE = Object.freeze({ OUTAGE: "outage", INCONCLUSIVE: "inconclusive" });
export const ACTION = Object.freeze({ DEPOSIT: "deposit", PAUSE: "pause", EXIT: "exit" });
export const FLAG = Object.freeze({ OUTAGE: "OUTAGE", INCONCLUSIVE: "INCONCLUSIVE", FINDING: "FINDING", MALFORMED: "MALFORMED" });

/**
 * The STATE rules the scope named (fees vs a limit, owner, redemption). xylo-usdc is not upgradeable,
 * so its powers are fixed and these carry most of the value. Each entry says which extra field it
 * needs and whether "exit" may be chosen for it.
 *
 * ⛔ `redemption-restricted` REFUSES "exit" in v1. The finding IS that exits are partial or blocked,
 * so an exit rule on it is a promise the vault controls: blocked cannot exit at all, partial exits
 * part. Widening it later ("take what is redeemable") is a decision, not a default.
 *
 * ⛔⛔ `vault-cannot-pay` IS PAUSE-ONLY, AND THIS IS WHY (T, 2026-09-25). It fires when the vault
 * holds less USDC than it owes (cash below the counter), or when a simulated redeem of your shares
 * reverts for want of cash. At that point the vault pays FIRST COME, FIRST SERVED. Every mandate on
 * the vault sees the same signal in the same block, so an exit rule would make Tikpema allocate the
 * shortfall between its own users: the order the scheduler processes mandates would decide who gets
 * paid and who is left holding shares the vault cannot honour. That is the platform forming a view,
 * the one thing the mandate forbids. A pause has no such effect (blocking a deposit takes nobody's
 * cash), and it keeps us from depositing into a vault that is already short.
 * On xylo it replaces redemption-restricted in practice: xylo's maxRedeem is just balanceOf, so
 * redemption-restricted can never fire there.
 *
 * ⛔ No price, peg, or market rule exists here, deliberately: the agent holds no view on markets.
 */
export const STATE_RULES = Object.freeze({
  "exit-fee-above": Object.freeze({ needs: "limitBps", exitAllowed: true }),
  "deposit-fee-above": Object.freeze({ needs: "limitBps", exitAllowed: true }),
  "owner-changed": Object.freeze({ needs: "baselineOwner", exitAllowed: true }),
  "redemption-restricted": Object.freeze({ needs: null, exitAllowed: false,
    exitRefusal: "the finding is that exits are restricted, so an exit cannot be promised" }),
  "vault-cannot-pay": Object.freeze({ needs: null, exitAllowed: false,
    exitRefusal: "an exit here would make Tikpema allocate a shortfall between its own users (the order the scheduler reaches mandates would decide who gets paid), so this rule only pauses" }),
});

/**
 * Rides on EVERY decision, the way POLICY_CEILING rides on every policy result: a DEPOSIT is "nothing
 * your rules refuse was found", never a statement that the vault is safe.
 */
export const MANDATE_CEILING =
  "no-clearance: a deposit going ahead means NOTHING YOUR RULES REFUSE WAS FOUND in this check, never that " +
  "this vault is safe. The rules are yours and cover only what they name; fees and redemption are Tikpema's own " +
  "unsigned reads, and an exit is taxed by the vault at up to its own fee cap.";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Validate a mandate's rule set EXACTLY as the user wrote it. Nothing is defaulted: the mandate
 * creator writes `onFinding: "pause"` explicitly when the user takes the default, so the stored
 * record (and its disclosure) states every choice.
 * @returns {{ok:true, rules:Array} | {ok:false, errors:string[]}}
 */
export function validateMandateRules(rules) {
  if (!Array.isArray(rules)) return { ok: false, errors: ["rules must be an array"] };
  if (rules.length === 0) return { ok: false, errors: ["the mandate has no rules, so a check would evaluate nothing and must not read as a pass"] };
  const errors = [], ids = new Set(), subjects = new Set();
  rules.forEach((r, i) => {
    const at = `rule[${i}]${isObj(r) && typeof r.id === "string" ? ` (${r.id})` : ""}`;
    if (!isObj(r)) { errors.push(`${at}: not an object`); return; }
    if (typeof r.id !== "string" || !r.id) errors.push(`${at}: missing id`);
    else if (ids.has(r.id)) errors.push(`${at}: duplicate id "${r.id}"`);
    else ids.add(r.id);

    if (r.onFinding !== ON_FINDING.PAUSE && r.onFinding !== ON_FINDING.EXIT) {
      errors.push(`${at}: onFinding is ${JSON.stringify(r.onFinding)}; it must be "pause" or "exit", written explicitly`);
    }
    if (r.kind === "power") {
      if (!(r.subject in POWER_SIGS)) errors.push(`${at}: power group "${r.subject}" is not in the catalogue`);
    } else if (r.kind === "state") {
      const spec = STATE_RULES[r.subject];
      if (!spec) errors.push(`${at}: state rule "${r.subject}" is not in the catalogue (${Object.keys(STATE_RULES).join(", ")})`);
      else {
        if (spec.needs === "limitBps" && !(Number.isInteger(r.limitBps) && r.limitBps >= 0 && r.limitBps <= 10000)) {
          errors.push(`${at}: "${r.subject}" needs limitBps, an integer from 0 to 10000 (got ${JSON.stringify(r.limitBps)})`);
        }
        if (spec.needs === "baselineOwner" && !isAddr(r.baselineOwner)) {
          errors.push(`${at}: "${r.subject}" needs baselineOwner, the owner address recorded when the mandate was made`);
        }
        if (!spec.exitAllowed && r.onFinding === ON_FINDING.EXIT) {
          errors.push(`${at}: "${r.subject}" cannot be set to exit: ${spec.exitRefusal}`);
        }
      }
    } else {
      errors.push(`${at}: kind is ${JSON.stringify(r.kind)}; it must be "power" or "state"`);
    }
    const subjectKey = `${r.kind}:${r.subject}`;
    if (subjects.has(subjectKey)) errors.push(`${at}: a second rule on "${r.subject}", so which one applies would not be the user's statement`);
    subjects.add(subjectKey);
  });
  return errors.length ? { ok: false, errors } : { ok: true, rules };
}

/**
 * @param {{rules:Array, check:{outage?:{reason:string}|null, observations:Object<string,{status,cause?,evidence?}>}}} input
 * @returns {{action, depositAllowed:boolean, flags:string[], findings:Array, exitFindings:Array,
 *            unestablished:Array, errors?:string[], ceiling:string}}
 */
export function decideMandateAction({ rules, check } = {}) {
  const result = (action, flags, extra = {}) => ({
    action, depositAllowed: action === ACTION.DEPOSIT, flags,
    findings: [], exitFindings: [], unestablished: [], ceiling: MANDATE_CEILING, ...extra,
  });

  const v = validateMandateRules(rules);
  if (!v.ok) return result(ACTION.PAUSE, [FLAG.MALFORMED], { errors: v.errors });

  // ⭐ A WHOLE-CHECK OUTAGE ESTABLISHES NOTHING, whatever the observations beside it claim.
  const outage = isObj(check) && check.outage ? check.outage : null;
  const observations = isObj(check) && isObj(check.observations) ? check.observations : null;
  if (outage || !observations) {
    const why = outage ? `the check failed: ${outage.reason ?? "unspecified"}` : "the check produced no observations";
    return result(ACTION.PAUSE, [FLAG.OUTAGE], {
      unestablished: v.rules.map((r) => ({ ruleId: r.id, subject: r.subject, cause: CAUSE.OUTAGE, why })),
    });
  }

  const findings = [], unestablished = [];
  // ⭐ ITERATE THE USER'S RULES, never the observations: a rule with no observation must surface as
  // unestablished, not be skipped (the same inversion evaluatePolicy guards against).
  for (const r of v.rules) {
    const o = observations[r.id];
    const miss = (cause, why) => unestablished.push({ ruleId: r.id, subject: r.subject, cause, why });
    if (!isObj(o)) { miss(CAUSE.OUTAGE, "no observation was produced for this rule"); continue; }
    if (o.status === OBSERVED.CLEAR) continue;
    if (o.status === OBSERVED.VIOLATED) {
      // A finding must carry what was found. Without evidence there is nothing to show the user and
      // nothing to justify an exit, so it is our instrument failing, not a finding.
      if (!isObj(o.evidence)) { miss(CAUSE.OUTAGE, "a violation was reported without evidence"); continue; }
      findings.push({ ruleId: r.id, kind: r.kind, subject: r.subject, onFinding: r.onFinding, evidence: o.evidence });
      continue;
    }
    if (o.status === OBSERVED.UNESTABLISHED) {
      miss(o.cause === CAUSE.INCONCLUSIVE ? CAUSE.INCONCLUSIVE : CAUSE.OUTAGE,
        o.cause === CAUSE.INCONCLUSIVE ? (o.why ?? "the check answered but could not establish this")
          : (o.why ?? "our instrument could not read this"));
      continue;
    }
    miss(CAUSE.OUTAGE, `unrecognised observation status ${JSON.stringify(o.status)}`);
  }

  const exitFindings = findings.filter((f) => f.onFinding === ON_FINDING.EXIT);
  const flags = [];
  if (findings.length) flags.push(FLAG.FINDING);
  if (unestablished.some((u) => u.cause === CAUSE.INCONCLUSIVE)) flags.push(FLAG.INCONCLUSIVE);
  if (unestablished.some((u) => u.cause === CAUSE.OUTAGE)) flags.push(FLAG.OUTAGE);

  const action = exitFindings.length ? ACTION.EXIT
    : findings.length || unestablished.length ? ACTION.PAUSE
    : ACTION.DEPOSIT;
  return result(action, flags, { findings, exitFindings, unestablished });
}
