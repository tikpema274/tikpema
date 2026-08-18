// _operator-count.mjs — the pure rule that turns a set of announcing peers into a verdict.
//
// Extracted from verify-pin-providers.mjs so every branch can be exercised without the routing
// APIs. ⭐ THAT IS NOT TIDINESS: the AMBER branch below cannot occur against today's real data
// (all three CIDs announce under exactly one named operator and zero unnamed peers), so the only
// way to see it work is to hand it a peer set that produces it. A branch whose first execution
// is the day it decides something is a branch nobody has tested.
//
// Same pattern as _identity-record.mjs and _pointer-history.mjs, for the same reason: those
// scripts are top-to-bottom programs and importing one runs it.
//
// ═══ 🚨 WHY NAMED OPERATORS ARE THE UNIT ═══════════════════════════════════════════════════════
// A peer announcing no DNS name is keyed `unknown:<peerId>`. Keeping it separate is deliberate —
// folding it into a known operator would HIDE a genuine second custodian. But counting it AS one
// is the opposite error, and the more dangerous one here:
//
//   old rule (operators.size >= 2)   {pinata.cloud, unknown:QmA}        → PASS
//   old rule                         {unknown:QmA, unknown:QmB}         → PASS, nothing named
//
// Both are "two operators" only in the sense that two map keys exist. Neither shows that the
// bytes are held by two parties who could fail independently, which is the entire property the
// gate exists to assert.
//
// ⭐ THE STAKES CHANGED WHEN THE GATE DID. While this was a DESCRIPTION of the pin landscape,
// generosity toward unknowns cost nothing. The moment it became the SUCCESS CRITERION for adding
// a second pinning operator, the generous reading became precisely the false pass the work is
// meant to eliminate: a nameless peer would announce "done" for work not done. A check that
// decides must be stricter than a check that describes, even when the underlying question is
// identical.

export const MIN_NAMED_OPERATORS = 2;

/**
 * Classify the operators announcing one CID.
 *
 * @param {Map<string, Set<string>>} operators  operator key -> set of peer ids. Keys that start
 *        with "unknown:" are peers whose registrable domain could not be resolved.
 * @param {boolean} anyInstrumentAnswered  false when NO routing instrument answered at all.
 * @returns {{verdict: string, namedOps: string[], unnamedKeys: string[], unnamedPeers: number,
 *            peerCount: number, oldRuleCount: number, isFailure: boolean}}
 *
 * verdict is one of:
 *   UNRESOLVED  — no instrument answered. NOT a measurement of zero, NOT a pass.
 *   NONE        — instruments answered and named nobody. Never pinned, or the pin LAPSED.
 *   SINGLE      — exactly one named operator, no unnamed peers.
 *   AMBER       — unnamed peers present and fewer than MIN_NAMED_OPERATORS named ones.
 *   OK          — at least MIN_NAMED_OPERATORS named operators.
 */
export function classifyOperators(operators, anyInstrumentAnswered) {
  const opNames = [...operators.keys()].sort();
  const peerCount = [...operators.values()].reduce((n, s) => n + s.size, 0);
  const namedOps = opNames.filter((o) => !o.startsWith("unknown:"));
  const unnamedKeys = opNames.filter((o) => o.startsWith("unknown:"));
  // ⭐ What the PREVIOUS rule would have reported. Carried so the verdict can print it: a
  // tightening that silently corrects a number teaches the next reader nothing, and leaves them
  // to wonder why a run that used to pass no longer does.
  const oldRuleCount = opNames.length;

  const base = { namedOps, unnamedKeys, unnamedPeers: unnamedKeys.length, peerCount, oldRuleCount };

  // 🚨 UNRESOLVED IS CHECKED FIRST AND IS NOT ZERO. An all-instruments-down run must never produce
  // a crisp verdict about custody; absence of an answer is not an answer in either direction.
  if (!anyInstrumentAnswered) return { ...base, verdict: "UNRESOLVED", isFailure: false };
  if (namedOps.length >= MIN_NAMED_OPERATORS) return { ...base, verdict: "OK", isFailure: false };
  if (unnamedKeys.length > 0) return { ...base, verdict: "AMBER", isFailure: true };
  if (opNames.length === 0) return { ...base, verdict: "NONE", isFailure: true };
  return { ...base, verdict: "SINGLE", isFailure: true };
}

/** Render the verdict as the lines the gate prints. Kept beside the rule so the two cannot drift. */
export function verdictLines(c) {
  switch (c.verdict) {
    case "OK":
      return [`   ✅ ${c.namedOps.length} independent operators — the pin survives losing any one.`];
    case "AMBER":
      return [
        `   ⚠️  ${c.namedOps.length} named operator(s)${c.namedOps.length ? ` (${c.namedOps.join(", ")})` : ""} + ${c.unnamedPeers} unnamed peer(s)`,
        `      → the previous rule counted every distinct key as an operator and would have`,
        `        called this ${c.oldRuleCount}. It is ${c.namedOps.length}: a peer announcing no DNS name cannot be`,
        `        shown to be a DIFFERENT custodian from the one already counted.`,
        `      Unnamed peer(s): ${c.unnamedKeys.map((o) => o.slice(8, 24) + "…").join(", ")}`,
        `      Not a pass. Identify them, or add an operator that announces a DNS name.`,
      ];
    case "NONE":
      return [
        `   ❌ NOT ANNOUNCED BY ANYONE. The instruments answered and named zero providers.`,
        `      Either this CID was never pinned, or the pin has LAPSED. If a report was sold`,
        `      under it, that report is no longer checkable against the claims it was produced under.`,
        `      (An unpinned CID reads this way too — expected for a version awaiting its pin.)`,
      ];
    case "SINGLE":
      return [
        `   ❌ SINGLE OPERATOR (${c.namedOps[0]}). ${c.peerCount} peer(s) here are transport redundancy,`,
        `      not custody redundancy: one lapsed account removes all of them at once.`,
      ];
    case "UNRESOLVED":
      return [
        `   ⚠️ UNRESOLVED — no instrument answered. This is NOT a measurement of zero providers,`,
        `      and it is NOT a pass. Re-run; if it persists the routing APIs are down, not the pin.`,
      ];
    default:
      return [`   ❌ unknown verdict ${c.verdict}`];
  }
}
