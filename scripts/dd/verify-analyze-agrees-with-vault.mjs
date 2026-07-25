// verify-analyze-agrees-with-vault.mjs — does the NEW analyzer agree with the DEPLOYED inspector?
//
// ⚠️ WHY THIS EXISTS. Both `netlify/functions/_vault.mjs` (in production, gating real deposits) and
// `shared/onchain-analyze/` (this slice) now derive owner powers from the SAME shared catalogue in
// shared/onchain-facts. If they disagree about the same address at the same block, one of them is
// wrong and the disagreement is the finding. Comparing them against each other is stronger than
// comparing either against a hand-written expectation, because neither side's answer is hardcoded here.
//
// ⚠️ THIS IS READ-ONLY AND TOUCHES NO MONEY. It calls `inspectVault` — the disclosure reader — and
// never `vaultDeposit` / `vaultWithdraw` / `gateDeposit`. Nothing is signed, nothing is submitted.
// (Cf. [[verification-method-must-not-mutate]]: the METHOD must be read-only, not just the intent.)
//
// ⚠️ SCOPE OF THE COMPARISON IS DELIBERATELY THE INTERSECTION. `_vault` scans FOUR power groups by
// frozen choice (emergencyWithdraw, feesSettable, pausable, upgradeable); the analyzer scans all nine
// from the shared union catalogue. Comparing all nine would "fail" on the five `_vault` never claimed
// to check — which is not a disagreement, it is decision (a) of the Step-1 design working as intended.
// So the four shared groups plus owner identity must match EXACTLY; the other five are reported as
// analyzer-only coverage, not as deltas.

import { inspectVault } from "../../netlify/functions/_vault.mjs";
import { analyzeOnArc } from "./analyze-run.mjs";

const XYLO = "0x240Eb85458CD41361bd8C3773253a1D78054f747";

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? `\n       ${detail}` : ""}`); }
};

console.log(`\nCross-checking analyze() against the DEPLOYED inspectVault() on ${XYLO}`);
console.log("(read-only: inspectVault is the disclosure reader; no deposit, no signing)\n");

const [insp, rep] = await Promise.all([inspectVault(XYLO), analyzeOnArc(XYLO)]);

// Map _vault's four scanned groups onto the analyzer's catalogue names.
const PAIRS = [
  ["emergencyWithdraw", insp.ownerPowers.emergencyWithdraw.present],
  ["feesSettable", insp.ownerPowers.settableFees.present],
  ["pausable", insp.ownerPowers.pausable.present],
  ["upgradeable", insp.ownerPowers.upgradeable.present],
];

console.log("── the FOUR power groups both sides scan ──");
for (const [group, vaultSays] of PAIRS) {
  const p = rep.powers.find((x) => x.power === group);
  ok(p !== undefined, `${group}: the analyzer actually checked it`);
  if (!p) continue;
  // _vault's `upgradeable.present` is tri-state (true/false/null) and ALSO folds in the proxy slot;
  // the analyzer separates shape from selectors, so compare the SELECTOR finding on that one.
  const vaultSelector = group === "upgradeable" ? insp.ownerPowers.upgradeable.viaSelector : vaultSays;
  ok(p.present === vaultSelector,
     `${group}: analyzer=${p.present} · _vault=${vaultSelector} — AGREE`,
     `analyzer says ${p.present}, deployed inspector says ${vaultSelector}`);
}

console.log("\n── owner identity ──");
ok(rep.owner.address?.toLowerCase() === (insp.ownerPowers.owner ?? "").toLowerCase(),
   `owner address matches: ${rep.owner.address}`,
   `analyzer=${rep.owner.address} vs _vault=${insp.ownerPowers.owner}`);
ok(rep.owner.kind === insp.ownerPowers.ownerIdentity,
   `owner type matches (canonical string): ${rep.owner.kind}`,
   `analyzer=${rep.owner.kind} vs _vault=${insp.ownerPowers.ownerIdentity}`);

console.log("\n── shape vs _vault's proxy determination ──");
const vaultThinksProxy = insp.ownerPowers.upgradeable.viaProxySlot;
ok(insp.ownerPowers.upgradeable.proxySlotUnreadable === false, "_vault read the proxy slot (not unreadable)");
ok((rep.shape.family === "eip1967") === Boolean(vaultThinksProxy),
   `proxy determination agrees: analyzer shape=${rep.shape.class} · _vault viaProxySlot=${vaultThinksProxy}`);
ok(rep.subject.address === XYLO.toLowerCase(), "both describe the same subject address");

console.log("\n── the FIVE groups only the analyzer scans (decision (a): NOT a disagreement) ──");
const only = rep.powers.filter((p) => !PAIRS.some(([g]) => g === p.power));
for (const p of only) console.log(`  ℹ️  ${p.power.padEnd(18)} analyzer=${String(p.present).padEnd(5)} · _vault: parked in POWER_SIGS_UNSCANNED, never claimed`);
ok(only.length === 5, `exactly five analyzer-only groups (got ${only.length})`);

console.log("\n── coverage manifest honesty ──");
ok(rep.coverage.notChecked.length === 0, `nothing silently skipped on a healthy read (notChecked=${rep.coverage.notChecked.length})`);
const powerEntries = [...rep.coverage.checked, ...rep.coverage.notChecked].filter((e) => e.kind === "power");
ok(powerEntries.length === 9, `all nine catalogue groups accounted for in the manifest (got ${powerEntries.length})`);
ok(rep.refusal === null, "no refusal");
ok(rep.shape.evidence.residual !== undefined, "plain-contract declares itself a RESIDUAL, not a positive identification");
ok(Array.isArray(rep.shape.evidence.shapesNotTestedFor) && rep.shape.evidence.shapesNotTestedFor.length > 0,
   `and states ${rep.shape.evidence.shapesNotTestedFor.length} shapes it did NOT test for`);

console.log("\n── the deployed inspector's own verdict (unchanged by any of this) ──");
console.log(`  level : ${insp.verdict.level}`);
console.log(`  warns : ${insp.verdict.warns.map((w) => w.code).join(", ")}`);
console.log(`  blocks: ${insp.verdict.blocks.map((b) => b.code).join(", ") || "(none)"}`);

console.log(`\n${"═".repeat(92)}`);
console.log(`agreement check: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
