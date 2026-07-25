// schema.mjs — the chain-agnostic response shape, the power SCOPE table, and the validator that
// enforces the completeness invariant.
//
// ⚠️ WHY SEVERITY LIVES HERE AND NOT IN shared/onchain-facts. That module says, in its own header:
// "Do not add a severity, a 'pass', or a digest here." A fact is not a verdict. This module sits ON
// TOP of the primitive and is allowed to classify; the primitive is not. Putting the table here is
// the Step-1 cut line being respected, not an accident of file placement.
//
// ═══ ⭐ SEVERITY IS SCOPE, NOT RECOMMENDATION ═════════════════════════════════════════════════
// `severity` describes WHAT THE POWER CAN REACH — informational, a property of the power CLASS. It
// is NOT a judgement about this contract, NOT a risk score, and NOT a recommendation.
//
// It is enforced structurally, not just documented: the allowed values are NON-ORDINAL scope classes.
// There is no natural order between "funds-movement" and "code-replacement", so ranking them is
// visibly meaningless rather than merely discouraged, and there is nothing to sum. This module
// deliberately exports NO comparator, NO aggregate, NO total, and NO numeric severity anywhere —
// assertReportValid() actively rejects a numeric one.
//
// The reason is the engine's founding constraint (scripts/dd/fact.mjs:3-7): a summable severity is a
// verdict in disguise. "3 highs and a medium" reads as a score, a score reads as advice, and advice
// is the one thing this tool must never ship — its value is that its output is CHECKABLE rather than
// believable. The report is an INVENTORY. The reader decides what it means.

import { POWER_SIGS } from "../onchain-facts/index.mjs";

export const SCHEMA_VERSION = "onchain-analyze/0.1.0";

/** Rides on every report, machine-readable, so no consumer can claim it was not told. */
export const SEVERITY_MEANING =
  "scope-not-rank: describes what the power can reach. Non-ordinal. MUST NOT be summed, ranked, averaged or aggregated into a score.";

/** The closed set of scope classes. Alphabetical — the order carries no meaning. */
export const SCOPE_CLASSES = Object.freeze([
  "access-restriction",
  "code-replacement",
  "funds-movement",
  "ownership-transfer",
  "parameter-change",
]);

/**
 * Power group → scope class. Every group in the shared catalogue must appear here; assertReportValid
 * fails loudly if the catalogue grows and this table does not.
 */
export const POWER_SCOPE = Object.freeze({
  emergencyWithdraw: "funds-movement",
  feesSettable: "parameter-change",
  setStrategy: "funds-movement",       // redirects where deposited capital is deployed
  setFeeRecipient: "parameter-change",
  transferOwnership: "ownership-transfer",
  pausable: "access-restriction",
  upgradeable: "code-replacement",
  denylist: "access-restriction",
  withdrawalDelay: "access-restriction", // can delay your exit; not a fee, a gate
});

/** Human-readable reach, carried alongside the class so the report is readable without this file. */
export const SCOPE_REACH = Object.freeze({
  "funds-movement": "can move or redirect assets held or deployed by the contract",
  "parameter-change": "can change a stored parameter that affects users' economics",
  "access-restriction": "can prevent or delay a user's access to their own position",
  "code-replacement": "can replace the executing logic at this address",
  "ownership-transfer": "can hand these powers to a different holder",
});

/**
 * ⭐ THE COMPLETENESS INVARIANT — what makes the manifest generated rather than hopeful.
 *
 * Every group in the SHARED CATALOGUE must be accounted for in exactly one of checked / notChecked.
 * Add a group to POWER_SIGS and forget to wire it into the enumeration and this REFUSES, rather than
 * quietly reporting a clean bill on a power nobody scanned.
 *
 * Returns the report on success. On violation it returns a REFUSAL REPORT — never throws — because
 * an honest "I cannot assess this" is a valid answer that settles, and a thrown error reads as "the
 * service broke". Exceptions here are reserved for programmer error.
 */
export function assertReportValid(report) {
  const problems = [];
  const cov = report.coverage ?? { checked: [], notChecked: [] };
  const entries = [...cov.checked, ...cov.notChecked].filter((e) => e.kind === "power");
  const seen = new Map();
  for (const e of entries) seen.set(e.group, (seen.get(e.group) ?? 0) + 1);

  for (const group of Object.keys(POWER_SIGS)) {
    const n = seen.get(group) ?? 0;
    if (n === 0) problems.push(`power group "${group}" is in the shared catalogue but appears in neither checked nor notChecked`);
    if (n > 1) problems.push(`power group "${group}" registered ${n} times — a check ran twice or was double-recorded`);
    if (!POWER_SCOPE[group]) problems.push(`power group "${group}" has no scope class in POWER_SCOPE`);
  }
  for (const g of seen.keys()) {
    if (!POWER_SIGS[g]) problems.push(`coverage names "${g}", which is not in the shared catalogue`);
  }
  for (const p of report.powers ?? []) {
    if (typeof p.severity === "number") problems.push(`power "${p.power}" has a NUMERIC severity — severity is a scope class, never a score`);
    if (p.severity && !SCOPE_CLASSES.includes(p.severity)) problems.push(`power "${p.power}" has scope class "${p.severity}", which is not in SCOPE_CLASSES`);
  }

  if (problems.length === 0) return report;
  return {
    ...report,
    powers: [],
    refusal: {
      reason: "coverage-incomplete",
      detail:
        "The coverage manifest does not account for every power group in the shared catalogue, so this report cannot be trusted not to be a false clean bill.",
      problems,
    },
  };
}

/** The empty report skeleton — every field present on every report, including refusals. */
export function baseReport({ address, chainId, chainName, blockNumber }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    severityMeaning: SEVERITY_MEANING,
    subject: { address, chainId, chainName, blockNumber },
    shape: null,
    powers: [],
    coverage: { checked: [], notChecked: [], totals: { checked: 0, notChecked: 0 } },
    reads: [],
    refusal: null,
  };
}
