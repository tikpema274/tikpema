// policy.mjs — evaluate a DD report against a user's STANDING RULES. Pure: no I/O, no clock.
//
// ═══ WHAT THIS IS FOR ════════════════════════════════════════════════════════════════════════
// The vault card already discloses owner powers and gates the deposit button behind an
// acknowledgement. A standing policy turns per-deposit acknowledgement into a statement the user
// wrote in advance: "this vault fails your rule — it is upgradeable". One derivation, applied
// identically by the deposit gate now and by discovery later, so the two can never disagree about
// what a rule means.
//
// ═══ ⭐⭐ THE SINGLE MOST IMPORTANT LINE IN THE FILE ══════════════════════════════════════════
// AN UNREADABLE POWER MUST NOT SILENTLY PASS. If a group is in `notChecked`, the report did not
// establish that the power is ABSENT — it established that we could not tell. Against a rule that
// refuses that power, "could not tell" must FAIL.
//
// ⚠️ THE FAILURE MODE THIS PREVENTS IS A CLEARANCE SIGNED BY THE USER'S OWN RULES. A policy that
// treated notChecked as "not present" would hand someone a pass derived from checks that never ran,
// carrying more authority than a plain disclosure precisely because they wrote the rules themselves.
// That is absence-reads-as-safe one layer up, and it is the whole reason this file exists.
//
// ⭐ TWO BUCKETS, NEVER ONE. "This vault is upgradeable" and "we could not establish whether this
// vault is upgradeable" are different findings and need different words. Collapsing them into a
// single `failures[]` would let the UI say the first when only the second is true — and would make
// an override of an unknown look identical to an override of a known power on the receipt.
//
// ═══ ⚠️ NO SCORE, EVER ═══════════════════════════════════════════════════════════════════════
// One accept/refuse per power group, never a number. Every report carries `severityMeaning`:
// "scope-not-rank … MUST NOT be summed, ranked, averaged or aggregated into a score." A policy that
// computed a risk total would violate the machine-readable terms of the artifact it reads.

import { POWER_SIGS } from "../onchain-facts/index.mjs";

/** The closed set of verdicts a rule can carry. Anything else is a malformed policy, not a default. */
export const RULE = Object.freeze({ REFUSE: "refuse", ALLOW: "allow" });

/** Why a policy evaluation refused. Closed set — an unrecognised reason must never mean "fine". */
export const POLICY_REASON = Object.freeze({
  NO_POLICY: "no-policy",
  MALFORMED_POLICY: "malformed-policy",
  REPORT_UNUSABLE: "report-unusable",
  POWER_PRESENT: "power-present",
  POWER_UNREADABLE: "power-unreadable",
  COVERAGE_BELOW_THRESHOLD: "coverage-below-threshold",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {object|null} report  a DD report (schema.mjs shape)
 * @param {object|null} policy  { rules: {<group>: "refuse"|"allow"}, coverageThreshold?: number }
 * @returns {{passes:boolean, reason:string|null, failures:Array, unreadableFailures:Array,
 *            coverage:{checked:number,total:number,threshold:number|null,meets:boolean|null},
 *            evaluated:string[], detail:string}}
 */
export function evaluatePolicy(report, policy) {
  const no = (reason, detail, extra = {}) => ({
    passes: false, reason, failures: [], unreadableFailures: [],
    coverage: { checked: 0, total: Object.keys(POWER_SIGS).length, threshold: null, meets: null },
    evaluated: [], detail, ...extra,
  });

  // ⚠️ ABSENT POLICY IS A FIRST-CLASS STATE AND IT IS NOT "PASSES". "No rules set" is not "every
  // rule satisfied" — reporting `passes: true` here would let a UI render a green tick for a user
  // who has never expressed a preference, which is a clearance nobody asked for and nobody granted.
  if (policy === null || policy === undefined) {
    return no(POLICY_REASON.NO_POLICY, "no policy is set, so nothing has been evaluated — this is not a pass");
  }
  if (!isObj(policy) || !isObj(policy.rules)) {
    return no(POLICY_REASON.MALFORMED_POLICY, "the policy is malformed (missing a `rules` object) — refusing rather than assuming an empty one");
  }

  // ⚠️ AN EMPTY RULES OBJECT IS ALSO NOT A PASS. `{}` is indistinguishable from "the user deleted
  // every rule" and from a serialisation bug that dropped them. Vacuous truth is exactly how a
  // policy evaluator silently clears everything it was installed to check.
  const ruleGroups = Object.keys(policy.rules);
  if (ruleGroups.length === 0) {
    return no(POLICY_REASON.MALFORMED_POLICY, "the policy contains no rules — an empty rule set evaluates nothing and must not read as a pass");
  }
  const unknownGroups = ruleGroups.filter((g) => !(g in POWER_SIGS));
  if (unknownGroups.length > 0) {
    // A rule naming a group the catalogue does not have cannot be evaluated. Refusing beats
    // ignoring it: a typo'd rule that is silently skipped is a rule the user believes is protecting them.
    return no(POLICY_REASON.MALFORMED_POLICY,
      `the policy names power group(s) that are not in the catalogue: ${unknownGroups.join(", ")}`);
  }

  // ⚠️ THE REPORT MUST BE USABLE. A refusal report, or one whose manifest does not account for the
  // catalogue, cannot support ANY conclusion about a power — including a negative one. The engine's
  // own completeness invariant already refuses such a report; this refuses to evaluate over it.
  const cov = report?.coverage;
  if (!isObj(report) || !isObj(cov) || !Array.isArray(cov.checked) || !Array.isArray(cov.notChecked)) {
    return no(POLICY_REASON.REPORT_UNUSABLE, "the report has no usable coverage manifest, so no power can be established either way");
  }
  if (report.refusal) {
    return no(POLICY_REASON.REPORT_UNUSABLE, `the report is a refusal (${report.refusal.reason}) — nothing was established about this subject`);
  }
  if (cov.checked.length === 0 && cov.notChecked.length === 0) {
    // ⭐ THE EMPTY MANIFEST. Zero checked AND zero notChecked violates the completeness invariant:
    // every catalogue group must appear in exactly one list. An empty manifest is the shape a
    // `chain-unreachable` report carries, and it is the one a naive evaluator would call a pass —
    // there are no present powers to fail against, because there is nothing at all.
    return no(POLICY_REASON.REPORT_UNUSABLE, "the coverage manifest is empty — the report accounts for no power group at all, so it cannot clear anything");
  }

  // ── the per-group verdicts ──────────────────────────────────────────────────────────────────
  // ⭐ ITERATE THE USER'S RULES, AND FOR EACH ONE ASK THE MANIFEST FIRST. Deliberately NOT
  // "iterate the checked groups and test the rules that apply" — that inversion is the optimisation
  // that turns a wholly-unreadable refused set into a silent pass, because a rule whose group was
  // never checked simply never gets visited.
  const groupOf = (e) => e?.group ?? (typeof e?.id === "string" && e.id.startsWith("power:") ? e.id.slice(6) : null);
  const checkedByGroup = new Map();
  for (const e of cov.checked) { const g = groupOf(e); if (g) checkedByGroup.set(g, e); }
  const notCheckedByGroup = new Map();
  for (const e of cov.notChecked) { const g = groupOf(e); if (g) notCheckedByGroup.set(g, e); }
  // ⚠️ THE FIELD IS `severity`, AND IT HOLDS A SCOPE CLASS. The report's own `severityMeaning`
  // says "scope-not-rank … non-ordinal", so the name is historical and the VALUE is a class like
  // "code-replacement". Read through a helper so a rename upstream breaks in one place.
  const scopeOf = (g) => report.powers?.find?.((p) => p.power === g)?.severity ?? null;
  const presentSet = new Set(Array.isArray(report.powersPresent) ? report.powersPresent : []);

  const failures = [], unreadableFailures = [], evaluated = [];
  for (const group of ruleGroups) {
    const verdict = policy.rules[group];
    if (verdict !== RULE.REFUSE && verdict !== RULE.ALLOW) {
      return no(POLICY_REASON.MALFORMED_POLICY,
        `rule for "${group}" is ${JSON.stringify(verdict)}, which is not "${RULE.REFUSE}" or "${RULE.ALLOW}"`);
    }
    evaluated.push(group);
    if (verdict === RULE.ALLOW) continue; // the user permits this power; nothing to establish

    // ⚠️ NOT-CHECKED IS TESTED BEFORE PRESENT. A group can only be "absent" if it was actually
    // looked at; asking `presentSet.has(group)` first would let an unchecked group fall through to
    // "not present" — the exact silent pass this file exists to prevent.
    if (notCheckedByGroup.has(group)) {
      const e = notCheckedByGroup.get(group);
      unreadableFailures.push({
        group, scope: scopeOf(group),
        reason: POLICY_REASON.POWER_UNREADABLE, why: e.reason ?? "not checked",
        detail: `your rule refuses "${group}", and this report could not establish whether the power is present (${e.reason ?? "not checked"}). Not established is not absent.`,
      });
      continue;
    }
    if (!checkedByGroup.has(group)) {
      // The manifest accounts for neither — the completeness invariant is violated for this group.
      // Refuse the whole evaluation rather than skip the rule.
      return no(POLICY_REASON.REPORT_UNUSABLE,
        `power group "${group}" appears in neither checked nor notChecked — the manifest is incomplete and cannot clear this rule`);
    }
    // ⚠️⚠️ AND HERE IS THE LIMIT OF WHAT A PASS CAN MEAN. Every power entry carries the engine's own
    // note: "presence of a selector is evidence of the power; ABSENCE is not proof of its absence (a
    // power may be reachable via fallback/delegatecall with no selector)". So `present: false` is
    // "no selector found", NOT "the contract cannot do this".
    // ⭐ WE STILL PASS ON IT, DELIBERATELY: refusing on "not proven absent" would fail every refuse
    // rule against every contract forever, which is a lockout, not a safety property. What must not
    // happen is the WORDING overclaiming — so `detail` on a pass says exactly what was established.
    if (presentSet.has(group)) {
      failures.push({
        group, scope: scopeOf(group),
        reason: POLICY_REASON.POWER_PRESENT,
        detail: `your rule refuses "${group}", and this contract has it.`,
      });
    }
  }

  // ── the coverage threshold ──────────────────────────────────────────────────────────────────
  // ⭐ THIS IS WHAT TURNS THE MANIFEST FROM DISCLOSURE INTO A GATE THE USER CONTROLS, and it catches
  // the case the per-group rules cannot: a report where almost nothing could be read, but the few
  // groups that WERE read happen to satisfy every rule.
  const total = Object.keys(POWER_SIGS).length;
  const checkedCount = cov.checked.filter((e) => groupOf(e) && POWER_SIGS[groupOf(e)]).length;
  let threshold = null, meets = null;
  if (policy.coverageThreshold !== undefined && policy.coverageThreshold !== null) {
    if (!Number.isInteger(policy.coverageThreshold) || policy.coverageThreshold < 0 || policy.coverageThreshold > total) {
      return no(POLICY_REASON.MALFORMED_POLICY,
        `coverageThreshold must be an integer between 0 and ${total} (got ${JSON.stringify(policy.coverageThreshold)})`);
    }
    threshold = policy.coverageThreshold;
    meets = checkedCount >= threshold;
  }

  const coverage = { checked: checkedCount, total, threshold, meets };
  const belowThreshold = meets === false;
  const passes = failures.length === 0 && unreadableFailures.length === 0 && !belowThreshold;

  return {
    passes,
    reason: passes ? null
      : failures.length ? POLICY_REASON.POWER_PRESENT
      : unreadableFailures.length ? POLICY_REASON.POWER_UNREADABLE
      : POLICY_REASON.COVERAGE_BELOW_THRESHOLD,
    failures, unreadableFailures, coverage, evaluated,
    detail: passes
      ? `every rule you set was evaluated against an established observation, and ${checkedCount} of ${total} power groups were checked. ` +
        `Note: a power is detected by finding its selector in the bytecode, and the report states that ABSENCE of a selector is not proof the power is absent — it may be reachable via fallback or delegatecall. A pass means no selector was found, not that the power cannot exist.`
      : [
          failures.length ? `${failures.length} power(s) you refuse are present` : null,
          unreadableFailures.length ? `${unreadableFailures.length} power(s) you refuse could not be established` : null,
          belowThreshold ? `only ${checkedCount} of ${total} groups were checked, below your threshold of ${threshold}` : null,
        ].filter(Boolean).join("; "),
  };
}
