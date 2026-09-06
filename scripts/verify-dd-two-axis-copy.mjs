// verify-dd-two-axis-copy.mjs — the 402 sentence must NAME BOTH AXES, and DERIVE both.
//
// ═══ ⛔ WHAT THIS EXISTS TO STOP ══════════════════════════════════════════════════════════════
// SETTLEMENT chain (what you pay on) and SUBJECT chain (what we analyse) are INDEPENDENT axes that
// happen to coincide today. The published description used to name the subject only — safe purely
// because there was nothing else to be confused with. That is ACCIDENTAL unambiguity, and it turns
// into a misleading claim the day a second settlement network is published.
//
// ⭐ THE CHECK IS NOT "does the sentence look right". It is "is the sentence a FUNCTION of the two
// arrays" — because only that survives someone adding a network. A guard that asserted today's
// exact string would pass forever while the sentence silently stopped describing reality.
// [[flow-is-not-meaning]] · [[duplicate-source-of-truth-is-the-recurring-bug]]
//
// ⚠️ MUTATION-PROVEN IN BOTH DIRECTIONS, because one direction is not a coupling:
//   ADD a network   -> the sentence MUST change and MUST name it   (catches a hardcoded string)
//   REMOVE one      -> the sentence MUST stop naming it            (catches an append-only sentence)
// A sentence that only ever grows would pass the first test while being just as wrong.

import {
  ddDescription, subjectClause, settlementClause,
  assertAcceptsDescribed, DD_SETTLEMENT_NETWORKS, ddPaymentRequirements,
} from "../netlify/functions/_dd-x402.mjs";
import { SUPPORTED_CHAINS } from "../netlify/functions/_dd-descriptor.mjs";

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ""}`); }
};

const ARC = "eip155:5042002";
const BASE = "eip155:84532";

console.log("\n── 1. TODAY'S SENTENCE NAMES BOTH AXES ────────────────────────────────");
const today = ddDescription();
check("it names the SUBJECT axis explicitly", /Analyses Arc Testnet only/.test(today), today);
check("it names the SETTLEMENT axis explicitly", /payment accepted on Arc Testnet/.test(today), today);
check("⭐ it no longer says 'on any Arc Testnet address' (the conflating phrase)",
  !/report on any Arc Testnet address/.test(today), today);
check("no raw CAIP-2 id leaks to a buyer", !/eip155:/.test(today), today);
check("no raw API slug leaks to a buyer", !/arc-testnet/.test(today), today);

console.log("\n── 2. ⭐ ADD A NETWORK -> THE SENTENCE MUST CHANGE AND NAME IT ─────────");
const withBase = ddDescription([ARC, BASE]);
check("🚨 adding a settlement network CHANGES the sentence", withBase !== today);
check("   …and the new network is NAMED", /Base Sepolia/.test(withBase), withBase);
check("   …and the original is still named", /Arc Testnet/.test(withBase));
check("   …joined as a real disjunction, not a list artefact",
  /payment accepted on Arc Testnet or Base Sepolia/.test(withBase), withBase);

console.log("\n── 3. ⭐ REMOVE A NETWORK -> THE SENTENCE MUST STOP NAMING IT ──────────");
// ⚠️ THE DIRECTION THAT CATCHES AN APPEND-ONLY SENTENCE. A description built by concatenating
// every network ever seen would pass section 2 and still misdescribe what is on offer.
const baseOnly = ddDescription([BASE]);
check("🚨 dropping Arc REMOVES it from the sentence", !/payment accepted on Arc Testnet/.test(baseOnly), baseOnly);
check("   …and names only what is actually offered", /payment accepted on Base Sepolia/.test(baseOnly), baseOnly);

console.log("\n── 4. THE SUBJECT CLAUSE DERIVES TOO ──────────────────────────────────");
check("subject clause reads SUPPORTED_CHAINS", subjectClause() === "Analyses Arc Testnet only", subjectClause());
const twoSubjects = subjectClause(["arc-testnet", "arc-testnet"]);
check("⭐ it is a function of its argument, not a constant",
  twoSubjects !== subjectClause(["arc-testnet"]), twoSubjects);
check("settlement clause is independent of the subject clause",
  settlementClause([BASE]) === "payment accepted on Base Sepolia", settlementClause([BASE]));

console.log("\n── 5. 🚨 THE INVARIANT AT THE EMISSION POINT ──────────────────────────");
// A hand-written description, or an accepts[] entry added without regenerating the sentence, must
// THROW rather than ship a challenge that misdescribes what it is offering.
const good = ddPaymentRequirements({ resource: "https://x/y", payTo: "0x" + "11".repeat(20) });
check("a well-formed accepts[] passes the invariant", (() => {
  try { assertAcceptsDescribed([good]); return true; } catch { return false; }
})());
check("🚨 a HARDCODED description is REJECTED", (() => {
  try { assertAcceptsDescribed([{ ...good, description: "Contract safety check — 0.06 USDC" }]); return false; }
  catch { return true; }
})());
check("🚨 an entry added WITHOUT regenerating the sentence is REJECTED", (() => {
  try { assertAcceptsDescribed([good, { ...good, network: BASE }]); return false; }
  catch { return true; }
})());
check("⭐ …and it is rejected because the SENTENCE disagrees, not because the count changed", (() => {
  // Both entries carry the two-network sentence -> accepted. Proves the check reads the SENTENCE,
  // not the array length, so it cannot pass vacuously on a one-element array.
  const d = ddDescription([ARC, BASE]);
  try { assertAcceptsDescribed([{ ...good, description: d }, { ...good, network: BASE, description: d }]); return true; }
  catch { return false; }
})());

console.log("\n── 6. THE SHIPPED ARRAY IS THE ONE THE SENTENCE DESCRIBES ─────────────");
check("DD_SETTLEMENT_NETWORKS is non-empty", DD_SETTLEMENT_NETWORKS.length > 0);
check("SUPPORTED_CHAINS is non-empty", SUPPORTED_CHAINS.length > 0);
check("the live requirements' description equals the derived one", good.description === ddDescription());
check("⭐ and it is derived from the SHIPPED array, not a copy",
  good.description === ddDescription(DD_SETTLEMENT_NETWORKS, SUPPORTED_CHAINS));

console.log(`\n${"═".repeat(72)}`);
console.log(`${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
