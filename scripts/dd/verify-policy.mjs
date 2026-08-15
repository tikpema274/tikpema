#!/usr/bin/env node
// verify-policy.mjs — evaluatePolicy over real reports, and over the shapes that silently clear.
//
//   node scripts/dd/verify-policy.mjs
//
// ═══ WHERE A POLICY EVALUATOR GOES WRONG ═════════════════════════════════════════════════════
// Not on the happy path. It goes wrong by PASSING — by producing a clean verdict from a report that
// established nothing, or from a rule set that evaluated nothing. Every fixture below is a shape
// that a plausible implementation would call a pass:
//
//   · no policy at all                    → "nothing failed"          ✗ nothing was evaluated
//   · an empty rules object               → "every rule satisfied"    ✗ vacuous truth
//   · a report with an empty manifest     → "no powers present"       ✗ no powers were LOOKED at
//   · every refused group notChecked      → "no present power failed" ✗ none could be established
//
// ⭐⭐ THE LAST ONE IS THE OPTIMISATION TRAP. Iterate `coverage.checked` and test the rules that
// apply to it, and a rule whose group was never checked is never visited — so a report that could
// establish NOTHING the user cares about reads as a clean pass. The evaluator iterates the USER'S
// RULES and asks the manifest per rule, precisely so an unchecked group cannot be skipped.
//
// The adversarial reports are built by REAL analyze() runs through the quorum client (disagreement,
// quorum-unmet, all-unreadable), not hand-written JSON — so the fixtures cannot drift from what the
// engine actually emits.

import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { quorumClient } from "../../shared/onchain-analyze/quorum.mjs";
import { evaluatePolicy, RULE, POLICY_REASON, POLICY_CEILING } from "../../shared/onchain-analyze/policy.mjs";
import { POWER_SIGS, EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
// ⭐ THE SHARED HARNESS, NOT A SECOND COPY. A hand-rolled client that looks plausible produces a
// `chain-unreachable` REFUSAL rather than an error — so a wrong mock silently tests refusals instead
// of reports, and every fixture below would assert against the wrong thing while passing.
import { SUBJ, OWNER, ZERO_WORD, word, codeWith, mockClient, transientThrow, mkc } from "./_mock-chain.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  \u2705 ${label}${extra ? ` \u2014 ${extra}` : ""}`); }
  else { fail++; console.log(`  \u274c ${label}${extra ? ` \u2014 ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n\u2500\u2500 ${t} ${"\u2500".repeat(Math.max(0, 60 - t.length))}`);

const A = "https://a.example", B = "https://b.example";
const base = (code) => ({
  [`code@${SUBJ}`]: code,
  [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
  ["call@0x8da5cb5b"]: word(OWNER),
  [`code@${OWNER}`]: "0x",
});

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  POLICY — the shapes a policy evaluator silently clears              ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// A clean report: readable, and the only power present is `pausable`.
const cleanReport = await analyze(SUBJ, { client: mockClient(base(codeWith(["pause()"]))) });
const REFUSE_UPGRADEABLE = { rules: { upgradeable: RULE.REFUSE } };

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE FOUR SHAPES THAT MUST NOT PASS");
{
  const noPolicy = evaluatePolicy(cleanReport, null);
  ok("⭐⭐ ABSENT policy does NOT pass — 'no rules set' is not 'every rule satisfied'",
    noPolicy.passes === false && noPolicy.reason === POLICY_REASON.NO_POLICY, noPolicy.detail);
  ok("  …and it says so in words a UI cannot render as a green tick",
    /not a pass/i.test(noPolicy.detail));
  ok("  undefined is treated the same as null", evaluatePolicy(cleanReport, undefined).passes === false);

  const empty = evaluatePolicy(cleanReport, { rules: {} });
  ok("⭐⭐ an EMPTY rules object does NOT pass — vacuous truth is how everything gets cleared",
    empty.passes === false && empty.reason === POLICY_REASON.MALFORMED_POLICY, empty.detail);

  // A report whose manifest accounts for nothing. Built by hand ON PURPOSE: the engine's
  // completeness invariant refuses to emit one, which is exactly why the evaluator must also refuse
  // if it ever receives one (an older deploy, a hand-rolled caller, a truncated payload).
  const emptyManifest = { ...cleanReport, coverage: { checked: [], notChecked: [] }, powersPresent: [] };
  const em = evaluatePolicy(emptyManifest, REFUSE_UPGRADEABLE);
  ok("⭐⭐ an EMPTY manifest (0 checked AND 0 notChecked) does NOT pass — nothing was looked at",
    em.passes === false && em.reason === POLICY_REASON.REPORT_UNUSABLE, em.detail);
  ok("  …and a refusal report does not pass either",
    evaluatePolicy({ ...cleanReport, refusal: { reason: "chain-unreachable" } }, REFUSE_UPGRADEABLE).passes === false);

  // ⭐⭐ THE OPTIMISATION TRAP: every group the user REFUSES is unreadable, every group that WAS
  // checked is one they allow. An evaluator iterating `checked` finds nothing to fail against and
  // reports a clean pass.
  //
  // ⚠️ THIS SHAPE IS HAND-BUILT FROM A REAL REPORT, AND THE REASON IS ITSELF A FINDING: the engine
  // CANNOT currently emit it. All nine power groups derive from the ONE bytecode read, so they are
  // all-or-nothing — knock that read out and the SHAPE becomes unclassifiable, the report becomes a
  // refusal, and all nine land in notChecked together (verified: 9 checked / 0 notChecked on a
  // healthy read; the quorum-unmet case refuses outright). So today the trap is defended by a
  // different branch — REPORT_UNUSABLE — and this fixture pins the per-rule branch that would carry
  // it the moment any group gains its own read. ⭐ A branch that is unreachable today and load-
  // bearing tomorrow is exactly the kind that ships broken.
  const mixed = (() => {
    const move = new Set(["upgradeable", "emergencyWithdraw"]);
    const checked = cleanReport.coverage.checked.filter((e) => !(e.kind === "power" && move.has(e.group)));
    const moved = cleanReport.coverage.checked
      .filter((e) => e.kind === "power" && move.has(e.group))
      .map((e) => ({ id: e.id, kind: "power", group: e.group, reason: "rpc-unreadable" }));
    return { ...cleanReport,
      coverage: { ...cleanReport.coverage, checked, notChecked: [...cleanReport.coverage.notChecked, ...moved] },
      powersPresent: (cleanReport.powersPresent ?? []).filter((g) => !move.has(g)) };
  })();
  const trap = evaluatePolicy(mixed, { rules: { upgradeable: RULE.REFUSE, emergencyWithdraw: RULE.REFUSE } });
  ok("⭐⭐ every REFUSED group unreadable ⇒ lands WHOLLY in unreadableFailures, never a pass",
    trap.passes === false && trap.unreadableFailures.length === 2 && trap.failures.length === 0,
    `failures=${trap.failures.length} unreadable=${trap.unreadableFailures.length}`);
  ok("  …and each names WHY it could not be established",
    trap.unreadableFailures.every((u) => typeof u.why === "string" && u.why.length > 0),
    trap.unreadableFailures.map((u) => `${u.group}:${u.why}`).join(" "));
  ok("⭐ …with wording that distinguishes 'not established' from 'absent'",
    /not established is not absent/i.test(trap.unreadableFailures[0]?.detail ?? ""));
  // ⭐ AND THE SAME REPORT WITH THOSE RULES SET TO ALLOW PASSES — proving the refusal comes from the
  // rules meeting unreadable coverage, not from the report being damaged.
  ok("⭐⭐ …while ALLOWing those same unreadable groups passes — the unreadability alone is not the failure",
    evaluatePolicy(mixed, { rules: { upgradeable: RULE.ALLOW, emergencyWithdraw: RULE.ALLOW } }).passes === true);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — TWO BUCKETS, NEVER ONE");
{
  const upgradeableReport = await analyze(SUBJ, { client: mockClient(base(codeWith(["upgradeTo(address)"]))) });
  const present = evaluatePolicy(upgradeableReport, REFUSE_UPGRADEABLE);
  ok("⭐⭐ a PRESENT refused power lands in failures[], not unreadableFailures[]",
    present.passes === false && present.failures.length === 1 && present.unreadableFailures.length === 0);
  ok("  …reason `power-present`", present.failures[0]?.reason === POLICY_REASON.POWER_PRESENT);
  ok("⭐ …and the sentence states the finding, not a doubt", /this contract has it/i.test(present.failures[0]?.detail ?? ""));
  ok("⭐ …carrying the scope class so a UI can say WHAT it reaches",
    present.failures[0]?.scope === "code-replacement", String(present.failures[0]?.scope));

  ok("⭐⭐ an ESTABLISHED-ABSENT refused power passes — a real observation clears the rule",
    evaluatePolicy(cleanReport, REFUSE_UPGRADEABLE).passes === true);
  ok("  …and an ALLOWED power that is present does not fail",
    evaluatePolicy(cleanReport, { rules: { pausable: RULE.ALLOW } }).passes === true);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — THE COVERAGE THRESHOLD");
{
  const nine = Object.keys(POWER_SIGS).length;
  ok(`the catalogue has ${nine} groups and a full report checks them all`,
    evaluatePolicy(cleanReport, { rules: { pausable: RULE.ALLOW }, coverageThreshold: nine }).coverage.checked === nine);
  ok("⭐⭐ a threshold ABOVE what was checked refuses, even when every rule is satisfied",
    evaluatePolicy(cleanReport, { rules: { pausable: RULE.ALLOW }, coverageThreshold: nine + 0 }).passes === true &&
    evaluatePolicy({ ...cleanReport, coverage: { ...cleanReport.coverage, checked: cleanReport.coverage.checked.slice(0, 3) } },
      { rules: { pausable: RULE.ALLOW }, coverageThreshold: 5 }).passes === false);
  const thin = evaluatePolicy({ ...cleanReport, coverage: { ...cleanReport.coverage, checked: cleanReport.coverage.checked.slice(0, 3) } },
    { rules: { pausable: RULE.ALLOW }, coverageThreshold: 5 });
  ok("  …with reason `coverage-below-threshold`, distinct from a power failure",
    thin.reason === POLICY_REASON.COVERAGE_BELOW_THRESHOLD, thin.detail);
  ok("⭐ …which is the case per-group rules CANNOT catch: everything read passed, little was read",
    thin.failures.length === 0 && thin.unreadableFailures.length === 0);
  ok("  a threshold is optional — omitting it leaves meets=null, not false",
    evaluatePolicy(cleanReport, { rules: { pausable: RULE.ALLOW } }).coverage.meets === null);
  ok("  a nonsense threshold is malformed, not ignored",
    evaluatePolicy(cleanReport, { rules: { pausable: RULE.ALLOW }, coverageThreshold: 99 }).reason === POLICY_REASON.MALFORMED_POLICY);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ADVERSARIAL REPORTS FROM REAL QUORUM RUNS");
{
  const codeU = codeWith(["upgradeTo(address)"]);
  // DISAGREEMENT on the impl slot → the whole shape is unknown → the engine emits a refusal.
  const dis = await analyze(SUBJ, { client: quorumClient([
    mkc(A, { ...base(codeU), [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD }),
    mkc(B, { ...base(codeU), [`slot@${EIP1967_IMPL_SLOT}`]: word("0x" + "99".repeat(20)) }),
  ]) });
  const d = evaluatePolicy(dis, REFUSE_UPGRADEABLE);
  ok("⭐⭐ a report built on a provider DISAGREEMENT never passes",
    d.passes === false, `${d.reason}: ${d.detail}`);

  // ALL ENDPOINTS DOWN → nothing readable at all.
  const allDown = await analyze(SUBJ, { client: quorumClient([
    mkc(A, { [`code@${SUBJ}`]: transientThrow }), mkc(B, { [`code@${SUBJ}`]: transientThrow }),
  ]) });
  const ad = evaluatePolicy(allDown, REFUSE_UPGRADEABLE);
  ok("⭐⭐ an ALL-UNREADABLE report never passes", ad.passes === false, `${ad.reason}: ${ad.detail}`);
  ok("  …and it does not pass for an ALLOW-only policy either — coverage still governs",
    evaluatePolicy(allDown, { rules: { upgradeable: RULE.ALLOW }, coverageThreshold: 5 }).passes === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — THE POLICY ITSELF MUST BE WELL-FORMED");
{
  ok("a rule naming a group outside the catalogue is malformed, never skipped",
    evaluatePolicy(cleanReport, { rules: { notARealPower: RULE.REFUSE } }).reason === POLICY_REASON.MALFORMED_POLICY);
  ok("⭐ …because a typo'd rule silently ignored is a rule the user believes protects them",
    evaluatePolicy(cleanReport, { rules: { upgradable: RULE.REFUSE } }).passes === false);
  ok("a rule whose verdict is not refuse/allow is malformed",
    evaluatePolicy(cleanReport, { rules: { upgradeable: "maybe" } }).reason === POLICY_REASON.MALFORMED_POLICY);
  ok("a policy that is not an object is malformed",
    evaluatePolicy(cleanReport, "refuse everything").reason === POLICY_REASON.MALFORMED_POLICY);
  ok("⭐ NO SCORE is produced anywhere in the result",
    !("score" in evaluatePolicy(cleanReport, REFUSE_UPGRADEABLE)) &&
    !("severity" in evaluatePolicy(cleanReport, REFUSE_UPGRADEABLE)));
  ok("⭐ the function is PURE — the same inputs give an identical result",
    JSON.stringify(evaluatePolicy(cleanReport, REFUSE_UPGRADEABLE)) === JSON.stringify(evaluatePolicy(cleanReport, REFUSE_UPGRADEABLE)));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ THE CEILING RIDES ON EVERY RESULT");
// A policy gate can never say "safe" — only "nothing found against your rules". That sentence is
// written BEFORE the copy exists, and it is machine-readable on every return for the same reason
// `severityMeaning` rides on every report: so no consumer can claim it was not told. A UI that
// renders a green tick and the word "safe" is contradicting a string handed to it in the same object.
{
  const results = [
    evaluatePolicy(cleanReport, null),
    evaluatePolicy(cleanReport, { rules: {} }),
    evaluatePolicy(cleanReport, REFUSE_UPGRADEABLE),                       // a PASS
    evaluatePolicy(cleanReport, { rules: { pausable: RULE.REFUSE } }),     // a FAIL
    evaluatePolicy(cleanReport, "nonsense"),
  ];
  ok("⭐⭐ every result carries the ceiling — pass, fail, malformed and no-policy alike",
    results.every((r) => typeof r.ceiling === "string" && r.ceiling.length > 40),
    `${results.filter((r) => r.ceiling).length}/${results.length}`);
  ok("⭐⭐ …and the PASS result carries it too — that is the case it exists for",
    results[2].passes === true && /NOTHING WAS FOUND AGAINST YOUR RULES/.test(results[2].ceiling));
  ok("⭐ …it says a pass is never a claim of safety", /never that this contract is safe/i.test(POLICY_CEILING));
  ok("⭐ …and names the selector limit, so the UI cannot claim more than the evidence supports",
    /absence of a selector is not proof/i.test(POLICY_CEILING));
  ok("  the word 'safe' never appears as a verdict anywhere in a result",
    !results.some((r) => /\bis safe\b/i.test(JSON.stringify({ ...r, ceiling: "" }))));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
