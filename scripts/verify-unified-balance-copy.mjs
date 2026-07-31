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
for (const [label, re, eYM, eUB] of [
  ["control is stated", /Tikpema controls that account/g, 1, 2],
  ["execution is stated UNTESTED", /haven't implemented it or tested that it works end to end/g, 1, 2],
  ["the reason is stated", /not that no path exists/g, 1, 2],
  ["the delay is DERIVED, never fixed", /about seven days/g, 1, 2],
]) {
  const a = n(ym, re), b = n(ub, re);
  check(`⭐ ${label}`, a === eYM && b === eUB, `YourMoney ${a}/${eYM}, UnifiedBalancePanel ${b}/${eUB}`);
}
check("⭐⭐ the BADGE names an absent build, not an impossibility",
  /badge="No withdrawal built"/.test(readFileSync(YM, "utf8")),
  "it read 'Server-released, delayed' — false in the OPTIMISTIC direction — and survived three reviews");

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
]) {
  const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const a = n(ym, re), b = n(ub, re);
  check(`${JSON.stringify(s)} is gone`, a === 0 && b === 0, why);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3 — no phrase is REPEATED within a site");
// "Treat this as one-way" is the skim-line on the deposit card. It also closed the same
// paragraph, so the instruction was preceded by a restatement of itself. Merging the tail
// into the closing instruction drops the count on that site by exactly one.
{
  const cardStart = ub.indexOf("Move USDC from your agent");
  const card = ub.slice(cardStart, cardStart + 800);
  check("⭐⭐ the deposit card carries 'treat this as one-way' EXACTLY ONCE",
    n(card, /treat this as one-way/gi) === 1,
    "once as the skim-line; the closing instruction inherits the reason directly");
  check("  …and closes by inheriting the reason, not restating it",
    /Until then, deposit only what you intend the agent to spend/.test(card));
  // RE-DERIVED, not loosened: card 2→1, bullet keeps its single payoff instance.
  check("⭐ file-level count re-derived after the merge (3 → 2)",
    n(ub, /treat this as one-way/gi) === 2, `got ${n(ub, /treat this as one-way/gi)}`);
  check("  …YourMoney's single instance is the payoff clause, untouched",
    n(ym, /treat this as one-way/gi) === 1);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
