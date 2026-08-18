#!/usr/bin/env node
// verify-operator-count.mjs — exercise EVERY branch of the pin-redundancy verdict, including the
// ones that cannot occur against today's real data.
//
//   node scripts/verify-operator-count.mjs
//
// ⭐ WHY THIS EXISTS. All three must-stay-pinned CIDs currently announce under exactly one named
// operator (pinata.cloud) with zero unnamed peers. So a live run of verify-pin-providers.mjs
// exercises exactly ONE branch — SINGLE — and leaves OK, AMBER, NONE and UNRESOLVED untested.
// AMBER is the branch that decides whether the second-operator work is finished, and its first
// real execution would otherwise be the moment it makes that call.
//
// 🚨 AMBER IS ALSO THE BRANCH THAT DID NOT EXIST UNTIL THIS GATE BECAME A SUCCESS CRITERION.
// Under the old rule a nameless peer beside pinata.cloud counted as a second operator and the gate
// went GREEN — announcing the work done because something unidentifiable was announcing the bytes.
// The regression test for that is `oldRuleWouldHaveSaid`, asserted explicitly below: it is not
// enough that the new rule says 1, it must also still be able to SAY that the old rule said 2.
//
// READ-ONLY, no network, no credential, pure functions only.

import { classifyOperators, verdictLines, MIN_NAMED_OPERATORS } from "./_operator-count.mjs";

const peers = (...ids) => new Set(ids);
/** Build the operator map the gate builds: operator key -> set of peer ids. */
const ops = (obj) => new Map(Object.entries(obj).map(([k, v]) => [k, peers(...v)]));

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

function scenario(title, operators, answered, expect) {
  console.log(`\n── ${title}`);
  const c = classifyOperators(operators, answered);
  console.log(`   verdict=${c.verdict}  named=${c.namedOps.length}  unnamed=${c.unnamedPeers}  oldRuleWouldHaveSaid=${c.oldRuleCount}`);
  check(`verdict is ${expect.verdict}`, c.verdict === expect.verdict, c.verdict);
  check(`isFailure is ${expect.isFailure}`, c.isFailure === expect.isFailure);
  if (expect.named !== undefined) check(`named operators = ${expect.named}`, c.namedOps.length === expect.named, String(c.namedOps.length));
  if (expect.oldRule !== undefined) check(`old rule would have said ${expect.oldRule}`, c.oldRuleCount === expect.oldRule, String(c.oldRuleCount));
  const lines = verdictLines(c);
  check("renders at least one line", lines.length >= 1);
  if (expect.mentions) for (const m of expect.mentions) {
    check(`output mentions "${m}"`, lines.join("\n").includes(m));
  }
  return { c, lines };
}

console.log(`\n╔══════════════════════════════════════════════════════════════════════╗`);
console.log(`║  PIN-REDUNDANCY VERDICT — every branch, no network                   ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════╝`);
console.log(`\n   requirement: ${MIN_NAMED_OPERATORS} named operators`);

// ── the state today ────────────────────────────────────────────────────────────────────────────
scenario("SINGLE — today's real shape: 2 Pinata peers, 1 named operator",
  ops({ "pinata.cloud": ["Qmdv6yNikmUWUWXu", "QmaSDHYKwuUKTvns"] }), true,
  { verdict: "SINGLE", isFailure: true, named: 1, oldRule: 1, mentions: ["transport redundancy"] });

// ── 🚨 THE REGRESSION THE TIGHTENING EXISTS FOR ────────────────────────────────────────────────
const amber = scenario("🚨 AMBER — pinata + ONE nameless peer (the old rule called this a PASS)",
  ops({ "pinata.cloud": ["Qmdv6yNikmUWUWXu"], "unknown:QmNameless111111": ["QmNameless111111"] }), true,
  { verdict: "AMBER", isFailure: true, named: 1, oldRule: 2,
    mentions: ["would have", "Not a pass"] });
// ⭐ The self-documenting line T asked for: the amber output must SAY the old count, not just be
// silently right. A tightening that erases the number it changed teaches the next reader nothing.
check("⭐ amber output states the old rule's count out loud",
  amber.lines.join("\n").includes("would have") && amber.lines.join("\n").includes("called this 2"));

scenario("🚨 AMBER — TWO nameless peers and nothing named (old rule: a clean PASS)",
  ops({ "unknown:QmA0000000000000": ["QmA0000000000000"], "unknown:QmB0000000000000": ["QmB0000000000000"] }), true,
  { verdict: "AMBER", isFailure: true, named: 0, oldRule: 2, mentions: ["called this 2", "Not a pass"] });

// ── the outcome the work is aiming at ──────────────────────────────────────────────────────────
scenario("OK — pinata + a second NAMED operator (the success criterion)",
  ops({ "pinata.cloud": ["Qmdv6yNikmUWUWXu"], "filebase.io": ["QmFilebase111111"] }), true,
  { verdict: "OK", isFailure: false, named: 2, oldRule: 2, mentions: ["survives losing any one"] });

scenario("OK — a named second operator ALONGSIDE unnamed noise still passes",
  ops({ "pinata.cloud": ["Qm1"], "storacha.network": ["Qm2"], "unknown:Qm3": ["Qm3"] }), true,
  { verdict: "OK", isFailure: false, named: 2, oldRule: 3 });

// ⚠️ THE CASE DESIGN POINT 1 CALLS OUT: if the second provider somehow announces under the SAME
// registrable domain, it is not a second operator and the gate must not be fooled by two peer ids.
scenario("⚠️ SINGLE — two peers, same registrable domain (gateway-v3 + bitswap-v3)",
  ops({ "pinata.cloud": ["QmBitswap", "QmGateway"] }), true,
  { verdict: "SINGLE", isFailure: true, named: 1, oldRule: 1 });

// ── the two absences, which must stay distinguishable ──────────────────────────────────────────
scenario("NONE — instruments answered and named nobody (never pinned, or LAPSED)",
  ops({}), true,
  { verdict: "NONE", isFailure: true, named: 0, oldRule: 0, mentions: ["LAPSED"] });

scenario("UNRESOLVED — no instrument answered (NOT zero, NOT a pass)",
  ops({}), false,
  { verdict: "UNRESOLVED", isFailure: false, named: 0, oldRule: 0, mentions: ["NOT a measurement of zero"] });

// 🚨 The two above are BOTH "we saw no operator" and must never collapse into one another: NONE is
// a fact about the pin, UNRESOLVED is a fact about the instruments.
{
  const none = classifyOperators(ops({}), true);
  const unres = classifyOperators(ops({}), false);
  console.log("\n── the two absences are distinguishable");
  check("NONE ≠ UNRESOLVED", none.verdict !== unres.verdict);
  check("NONE counts as a failure", none.isFailure === true);
  check("UNRESOLVED does NOT count as a failure (it drives the unresolved counter instead)", unres.isFailure === false);
  check("their rendered text differs", verdictLines(none).join() !== verdictLines(unres).join());
}

console.log("\n════════════════════════════════════════════════════════════════════════");
if (failures) { console.log(`❌ ${failures} check(s) failed.`); process.exit(1); }
console.log(`✅ ALL BRANCHES EXERCISED — OK, AMBER (×2), SINGLE (×2), NONE, UNRESOLVED.`);
console.log(`   ⭐ AMBER is the one that cannot occur against real data today, and it is the one`);
console.log(`      that decides whether the second-operator work is done.\n`);
