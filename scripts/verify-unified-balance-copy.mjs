// verify-unified-balance-copy.mjs — the unified-balance disclosure, asserted both ways.
//
//   node scripts/verify-unified-balance-copy.mjs      (also: npm run test:copy)
//
// ═══ WHAT THIS GUARDS ════════════════════════════════════════════════════════════════════════
// The unified-balance copy has been WRONG THREE TIMES, in both directions:
//   v2  "released by the server, just slowly"      — implied a path we do not operate
//   v3  "not by you, not by us. There is no path"  — denied a path that demonstrably exists
//   badge "Server-released, delayed"               — a v2 survivor sitting above a v3 body
// The fourth false claim is now the EASY one: implying a WORKING recovery. Account model is
// MEASURED (we control the SCA, nothing restricts the call); end-to-end EXECUTION is NOT.
//
// PRESENT and ABSENT are different checks and only both together prove anything — a new
// phrase appearing does not mean the old one left. Counts are EXACT, never `> 0`: a wrong
// count is a real defect (a duplicated phrase, or a site that silently lost the disclosure),
// and `> 0` would pass while either is true.
//
// 🚧 KNOWN LIMITATION — this reads SOURCE, not rendered output. It cannot see text built from
// variables, text in props of components it does not know about, or a NEW file carrying the
// falsehood. See PROGRESS.md: the guard should render the components and assert on text
// content. Until then this is a partial guard and should be read as one.
//
// ⚠️ Comments are STRIPPED before matching. A comment QUOTING an old falsehood is not an
// occurrence of it — counting raw source makes this suite fail on its own rationale.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  UNIFIED BALANCE COPY — present AND absent, exact counts             ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const UB = "src/components/UnifiedBalancePanel.tsx";
const YM = "src/components/YourMoney.tsx";
const live = (f) =>
  readFileSync(f, "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\{" "\}/g, " ")
    .replace(/<\/?b>/g, "")
    .replace(/\s+/g, " ");
const ub = live(UB), ym = live(YM);
const n = (s, re) => (s.match(re) || []).length;

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the disclosure is PRESENT at all three body sites");
// UnifiedBalancePanel carries TWO body sites (the "what you can get back" bullet and the
// "fund the unified balance" card); YourMoney carries ONE (the amber line by Withdraw).
// ═══ 🚨 v4 — AND THE MOMENT THIS GUARD ITSELF BECAME THE FALSEHOOD ═══════════════════════════
// This block used to REQUIRE "we haven't implemented it or tested that it works end to end" and
// "not that no path exists". Both were true and load-bearing when written. On 2026-08-12 the exit
// was BUILT (06d3a94), and at that instant the guard against a falsehood became the thing
// ENFORCING one: it would have failed the build for telling users the truth.
//
// ⭐ THE MECHANISM WAS NEVER WRONG — IT OUTLIVED THE FACT IT PROTECTED. A copy guard pins a claim,
// and a claim has a shelf life. That is the fourth distinct way this one paragraph has been wrong,
// and the only one where the guard was the problem rather than the catch.
//
// ⚠️ v4 IS NOT "YOU CAN GET YOUR MONEY BACK". The path is built and had NEVER been run end to end
// with real funds. Saying more than that repeats v2's error — implying a working release path
// because the code exists. So the required strings below assert BOTH halves: the exit is built and
// automatic, AND the user is told how little has actually been proven.
//
// ═══ ⭐⭐ v5 — 2026-08-12: THE "UNEXERCISED" CLAIM EXPIRED THE WAY v4's PREDECESSOR DID ════════
// At 20:49Z a real 1 USDC withdrawal was initiated (16be509f, chain-verified). "Nobody has taken
// this route with real funds yet" became FALSE, and this guard was REQUIRING it — so a green suite
// was enforcing a lie. That is the SECOND time this file has pinned a claim past its shelf life,
// and the fifth distinct way this one paragraph has been wrong.
//
// ⭐ THE FIX IS NOT TO DROP THE HONESTY, IT IS TO MOVE IT. The replacement claim is narrower and
// harder to outgrow: ONE run is not a track record. It stays true whether the count is one or ten,
// because it describes the WEIGHT of the evidence rather than its absence.
// ⚠️ HOP 2 HAS STILL NEVER RUN. The withdrawal completes ~2026-08-19; until a sweeper tick moves
// real funds, "we finish it automatically" remains unproven and the floor-not-ceiling line must
// stay. Do not soften it when the first completion lands — soften it when several have.
for (const [label, re, eYM, eUB] of [
  ["control is stated", /Tikpema controls that account/g, 1, 2],
  ["⭐ the exit is stated as BUILT", /It is built\s*\n?\s*now:/g, 1, 2],
  ["⭐⭐ the user is told they need NOT return (this is what makes it an exit)", /you do not have to come back/g, 1, 2],
  // ⭐ v5: the claim is now ONE RUN, NOT NONE. Pinned on "not a track record" because that is the
  // load-bearing half — a single success is the easiest thing in this whole surface to over-read.
  ["⭐⭐ …and that the evidence is THIN — one run, not a track record", /one real run, not a track record/g, 1, 2],
  ["⭐ …and the wait is still a FLOOR, because hop 2 has never run", /floor/g, 1, 2],
  ["the delay is DERIVED, never fixed", /about seven days/g, 2, 3],
]) {
  const a = n(ym, re), b = n(ub, re);
  check(`⭐ ${label}`, a === eYM && b === eUB, `YourMoney ${a}/${eYM}, UnifiedBalancePanel ${b}/${eUB}`);
}
// The badge has now been wrong twice and right twice. "Server-released, delayed" was false in the
// OPTIMISTIC direction; "No withdrawal built" was true until the exit shipped and false the moment
// it did. ⭐ Four words next to a number get read more than the paragraph under it.
check("⭐⭐ the BADGE names the exit AND its cost",
  /badge="Exit built · about seven days"/.test(readFileSync(YM, "utf8")),
  "it read 'No withdrawal built' — true until 06d3a94, false the instant the exit shipped");

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("2 — every prior falsehood is ABSENT (present-only would not prove this)");
for (const [s, why] of [
  ["not by you, not by us", "v3 — denied a path that exists"],
  ["There is no path that returns it", "v3"],
  ["Server-released, delayed", "v2 — the badge"],
  ["no way out", "v3"],
  ["nothing can return it", "v3"],
  ["cannot be withdrawn", "v3"],
  ["cannot be returned to you", "v3"],
  ["we drive that account", "superseded wording"],
  // 🚨 v3.5 — TRUE WHEN WRITTEN, FALSE SINCE 06d3a94. Forbidden for the same reason as every
  // line above it: a claim that has stopped being true is a falsehood regardless of how it got
  // there. This guard REQUIRED these strings until today.
  ["haven't implemented it or tested that it works end to end", "v3.5 — denied a built exit"],
  ["not that no path exists", "v3.5 — the reason clause, now moot"],
  ["what stops a withdrawal today", "v3.5"],
  ["No withdrawal built", "v3.5 — the badge"],
  // ⚠️ "one-way" was accurate for v1–v3.5 and is now simply wrong: there is a way back.
  ["treat this as one-way", "v3.5 — there is a way back now"],
]) {
  const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const a = n(ym, re), b = n(ub, re);
  check(`${JSON.stringify(s)} is gone`, a === 0 && b === 0, why);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE BEFORE-DEPOSIT DISCLOSURE — the sentence read before committing funds");
{
  const cardStart = ub.indexOf("Move USDC from your agent");
  const card = ub.slice(cardStart, cardStart + 900);
  // ⚠️ THE SKIM-LINE IS THE DISCLOSURE. Until 06d3a94 this card LED with "Treat this as one-way",
  // which contradicted the paragraph beneath it the moment the exit shipped — and the lead is what
  // gets read. A correct paragraph under a wrong skim-line is a wrong card.
  check("⭐⭐ the deposit card names the WAIT in its lead sentence, before any mechanism",
    /Money goes in instantly and takes about seven days to come back out/.test(card));
  check("  …and it precedes the explanation of WHY (cost first, mechanism second)",
    card.indexOf("about seven days") < card.indexOf("belongs to"));
  check("⭐ the card still says the exit is automatic", /you do not have to come back/.test(card));
  // ⭐ v5: not "nobody has used it" — that expired at 20:49Z on 2026-08-12. The deposit card must
  // still convey how THIN the evidence is, because this is the lead a depositor reads.
  check("⭐ …and still says how little has been proven — one run, not a track record",
    /one real run, not a track record/.test(card));
}

section("3b — the repeated-phrase check RETIRED with the phrase it counted");
// It counted "treat this as one-way" per site. That phrase is now FORBIDDEN outright (there is a
// way back), so counting its occurrences would be asserting on something that must not exist.
// ⭐ Deleted rather than loosened: a check kept alive past its subject is how a suite starts
// passing for reasons nobody remembers.

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
