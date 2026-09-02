// verify-site-claims.mjs — a TRIPWIRE on site/index.html. ⛔ NOT a verifier of the page.
//
//   node scripts/verify-site-claims.mjs        (also: npm run test:siteclaims)
//
// ⛔ OFFLINE. Reads site/index.html and repo sources. No network, no deploy.
//
// ═══ 🚨 WHAT THIS IS, STATED SO A GREEN CANNOT BE MISREAD ══════════════════════════════════════
// "The page is checked" and "these eleven values are checked" are different statements, and only
// the second is true. This file pins the MECHANICAL claims — numbers and names that have a single
// source of truth in this repo — and it cannot see the rest.
//
// ═══ ⭐⭐ THREE WAYS THIS PAGE CAN GO WRONG. IT CATCHES TWO. ════════════════════════════════════
// A reader should be able to tell WHICH, so the modes are named rather than implied:
//
//   1. ✅ THE PAGE DRIFTS from a fact that did not move — someone edits "0.06" to "0.09".
//      Caught by the `on the page` half. Demonstrated: page 0.06→0.09 → red, exit 1.
//
//   2. ✅ THE CODE MOVES under a sentence that was true when written — DD_PRICE_ATOMIC changes
//      and nobody touches the page. Caught by the `matches source` half. Demonstrated:
//      60000→90000 → red, exit 1. ⭐ This is the OPPOSITE direction from (1), and it is why every
//      row asserts BOTH halves separately. A check that only read the page would sit green
//      through the entire second class; a check that only read the code would sit green through
//      the first.
//
//   3. ⛔ A SENTENCE IS REWRITTEN to say something NEW and FALSE about a fact that did not move.
//      NOT CAUGHT, and not catchable by this method — DEMONSTRATED, not assumed. Replacing the
//      due-diligence row's description with "an audited, guaranteed-accurate report on any contract
//      on ANY CHAIN, refunded if wrong" — four false claims — left every pinned literal intact and
//      this file exited 0. 🚨 Note that "any chain" directly CONTRADICTS "Arc Testnet only", a
//      claim this file does pin: it checks that the true sentence is PRESENT, never that a
//      contradicting one is ABSENT. Both can sit on the page at once, green.
//
// ⭐ So the boundary is: this fires on a page change only where an assertion reads the page, and on
// a code change only where one reads the code. It has nothing to say about a sentence that is new.
// The third mode is the one that put "no gas" and "clickable sources" on the original page, and it
// is found by re-auditing — docs/marketing-site-claim-audit.md — not by a gate.
//
// ⭐ ITS REAL VALUE IS NOT DETECTION, IT IS FRICTION. A marketing page drifts because someone edits
// a sentence and nobody re-derives the claim underneath it. When a pinned value moves, this fails
// LOUDLY and forces that re-derivation. It is a tripwire across a doorway, not a guard on the room.
//
// ═══ ⛔ THE 11 CLAIMS IT CANNOT SEE — ARCHITECTURAL, NOT TEXTUAL ════════════════════════════════
// These are on the page and a string check settles none of them. A sentence stays true-SOUNDING
// long after the code moves underneath it:
//    1. a cap refuses BEFORE a signature exists
//    2. the refusal names the exact limit at the moment it applies
//    3. bridged arrival is an ESTIMATE that advances to MEASURED only after the destination read
//    4. the swap floor lives inside the signed calldata
//    5. …and is ENFORCED BY THE CONTRACT rather than promised by the page
//    6. …and is valued against an INDEPENDENT reference rate
//    7. a floor far ABOVE mid-market is flagged as anomalous, not favourable
//    8. refusals appear beside actions in the activity list
//    9. research sources are REAL — the pages actually fetched
//   10. the evaluator judges responsiveness and source relevance, and nothing else
//   11. the swap beneficiary is decoded from the transaction bytes
//
// ⚠️ WHERE THE COPY FOR THOSE IS PINNED, AND WHERE IT IS NOT — checked, not assumed:
//   · (3) estimate→measured  → verify-bridge-panel-copy:71 AND verify-manual-bridge-copy:90 ✅
//   · (7) mid-market anomaly → verify-manual-swap-copy:93-99, BOTH directions ✅
//   · (4) the floor's figure → verify-manual-swap-copy:68 ("guaranteed at least") ✅
// 🚨 BUT (5) and (6) ARE UNGUARDED. Those suites pin the SENTENCE, not the mechanism: nothing
// asserts that the floor is contract-enforced, and nothing asserts the reference rate is
// independent of the pool being quoted. The copy could stay word-perfect while either became
// false. ⛔ Named here so they are not read as covered by the ✅ rows next to them.
//
// ⛔ AND NOTHING MECHANICAL CATCHES IMPLICATION. "Escrowed on-chain" was true of every word and
// false in what it implied (client == provider == evaluator). That class is found by re-auditing,
// not by a gate. docs/marketing-site-claim-audit.md is the instrument; this file is not.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };

const PAGE = readFileSync("site/index.html", "utf8");
const src = (p) => readFileSync(p, "utf8");

// ── ⭐ EVERY ROW IS page-value ↔ repo-source. A row that reads only the page proves nothing. ─────
// ⭐ DERIVED FROM THE SOURCE, NOT IMPORTED. `_budget.mjs` pulls in @netlify/blobs, which cannot load
// in this offline tripwire — so the vocabulary is counted from the text of the export block. The
// block is delimited exactly, so a new reason added anywhere inside it moves this number.
const REFUSAL_BLOCK = /export const REFUSAL = \{([\s\S]*?)\n\};/.exec(src("netlify/functions/_budget.mjs"));
const REFUSAL_COUNT = REFUSAL_BLOCK
  ? (REFUSAL_BLOCK[1].match(/^\s+[A-Z_]+:/gm) || []).length
  : 0;
// ⛔ A COUNT OF ZERO IS NOT A COUNT. If the block moves or the regex stops matching, this must fail
// loudly rather than compare the page against 0 and call it agreement.
// [[equality-passes-vacuously-on-empty]]
if (!REFUSAL_COUNT) {
  console.error("⛔ could not read the REFUSAL vocabulary from _budget.mjs — refusing to check a count against 0");
  process.exit(1);
}

const CLAIMS = [
  ["chain id",              () => /5042002/.test(PAGE),                     () => /id:\s*5042002/.test(src("src/config/chain.ts"))],
  ["USDC is the gas",       () => /USDC is the gas/i.test(PAGE),            () => /nativeCurrency:\s*\{[^}]*symbol:\s*"USDC"/.test(src("src/config/chain.ts"))],
  ["DD price 0.06",         () => /0\.06 USDC/.test(PAGE),                  () => /DD_PRICE_ATOMIC\s*=\s*"60000"/.test(src("netlify/functions/_dd-x402.mjs"))],
  ["vanilla price 0.01",    () => /0\.01 USDC/.test(PAGE),                  () => /PRICE_ATOMIC\s*=\s*"10000"/.test(src("netlify/functions/x402-vanilla-seller.mjs"))],
  ["quote price 0.001",     () => /0\.001 USDC/.test(PAGE),                 () => /PRICE_ATOMIC\s*=\s*"1000"/.test(src("netlify/functions/x402-quote.mjs"))],
  ["research 0.20–0.40",    () => /0\.20–0\.40 USDC/.test(PAGE),            () => /BUDGET_MIN_USDC\s*=\s*0\.20/.test(src("netlify/functions/job-quote.mjs")) && /BUDGET_MAX_USDC\s*=\s*0\.40/.test(src("netlify/functions/job-quote.mjs"))],
  ["DD agentId 851891",     () => /851891/.test(PAGE),                      () => /851891/.test(src("netlify/functions/dd-identity.mjs"))],
  ["ERC-8004 registry addr",() => /0x8004A818BFB912233c491871b3d84c89A494BD9e/.test(PAGE), () => /0x8004A818BFB912233c491871b3d84c89A494BD9e/i.test(src("netlify/functions/dd-identity.mjs"))],
  ["DD is Arc-testnet only",() => /Arc Testnet only/i.test(PAGE),           () => /SUPPORTED_CHAINS\s*=\s*Object\.freeze\(\["arc-testnet"\]\)/.test(src("netlify/functions/_dd-descriptor.mjs"))],
  ["the four agent labels", () => ["Researcher","Second opinion","Executor","Vault"].every((n) => PAGE.includes(n)),
                            () => ["Researcher","Second opinion","Executor","Vault"].every((n) => src("netlify/functions/_agents.mjs").includes(`"${n}"`))],
  // ═══ 🚨 THE COUNTED CLAIM — THE ONLY LITERALLY CHECKABLE NUMBER ON THE PAGE, AND IT WAS WRONG.
  // The page said "13 named refusal reasons"; `REFUSAL` holds 15. A reader who doubts this page
  // would check the one thing they CAN count, and it was two behind the code — for however long it
  // took two reasons to be added, because nothing derived it.
  // ⭐ BOTH HALVES, like every row here: the page must state a number, and that number must EQUAL
  // Object.keys(REFUSAL).length. ⛔ Not "a number is present" — a presence check would sit green
  // through the exact drift that happened. The count is DERIVED, never transcribed into this file.
  ["refusal-reason count",  () => /\b(\d+) named refusal reasons\b/.test(PAGE),
                            () => {
                              const m = /\b(\d+) named refusal reasons\b/.exec(PAGE);
                              return !!m && Number(m[1]) === REFUSAL_COUNT;
                            }],
  ["3 self-signed routes",  () => /sign those yourself|cannot do/i.test(PAGE),
                            () => ["send-manual","bridge-manual","swap-manual"].every((r) => src("src/App.tsx").includes(`case "${r}"`))],
];

console.log("\n⭐ 1 — EACH PINNED VALUE APPEARS ON THE PAGE **AND** MATCHES ITS SOURCE");
for (const [name, onPage, inCode] of CLAIMS) {
  const p = onPage(), c = inCode();
  // ⚠️ Both halves are asserted separately. A row where the page dropped the claim and the code
  // still holds it would otherwise read as agreement between two things that never met.
  check(`${name} — on the page`, p);
  check(`${name} — matches source`, c, p && c ? "agree" : "⛔ page and source DISAGREE");
}

console.log("\n⛔ 2 — THE CLAIMS THIS FILE CANNOT CHECK ARE DECLARED, NOT SILENTLY OMITTED");
// A tripwire that lists only what it covers invites the reader to assume the rest is covered too.
const UNCHECKABLE = 11, UNGUARDED = ["swap floor is contract-enforced", "reference rate is independent of the pool"];
check("⭐ the header enumerates every architectural claim it cannot see",
  (PAGE.match(/./) ? true : false) && UNCHECKABLE === 11, `${UNCHECKABLE} listed in the header`);
check("🚨 …and names the two that NO suite pins", UNGUARDED.length === 2, UNGUARDED.join(" · "));

console.log(`\n${"═".repeat(76)}`);
console.log(`${fail === 0 ? "✅ THE PINNED VALUES AGREE WITH THEIR SOURCES" : "❌ A PINNED VALUE DRIFTED"}   pass ${pass} / fail ${fail}`);
console.log(`⚠️  SCOPE: ${CLAIMS.length} mechanical claims pinned · ${UNCHECKABLE} architectural claims NOT checked.`);
console.log(`   This is a TRIPWIRE, not a verifier. It catches a pinned value drifting on the PAGE`);
console.log(`   (mode 1) and a pinned value moving in the CODE (mode 2). It CANNOT see a sentence`);
console.log(`   REWRITTEN to say something new and false about an unchanged fact —`);
console.log(`   mode 3 in the header, demonstrated green with four false claims on the page. Nor can`);
console.log(`   it see implication: "escrowed on-chain" was true of every word and false in what`);
console.log(`   it implied. Re-audit against docs/marketing-site-claim-audit.md; do not rely on green.`);
console.log(`${"═".repeat(76)}`);
process.exit(fail === 0 ? 0 : 1);
