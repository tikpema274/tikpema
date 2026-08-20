// verify-unified-balance-copy.tsx — the unified-balance disclosure, RENDERED and asserted both ways.
//
//   npx tsx --experimental-test-module-mocks scripts/verify-unified-balance-copy.tsx
//   (also: npm run test:copy)
//
// ═══ WHAT THIS GUARDS ════════════════════════════════════════════════════════════════════════
// The unified-balance copy has been WRONG FIVE TIMES, in both directions:
//   v2  "released by the server, just slowly"      — implied a path we do not operate
//   v3  "not by you, not by us. There is no path"  — denied a path that demonstrably exists
//   badge "Server-released, delayed"               — a v2 survivor sitting above a v3 body
//   v3.5 "we haven't implemented it"               — TRUE when written; false the moment 06d3a94
//                                                    shipped the exit, and this guard REQUIRED it
//   v4  "nobody has taken this route"              — false at 20:49Z on 2026-08-12, and required
// ⭐⭐ TWICE THE GUARD ITSELF BECAME THE FALSEHOOD — a green suite enforcing a lie, because a copy
// guard pins a claim and a claim has a shelf life. That history is why the assertions below pin the
// NARROWEST durable form ("one real run, not a track record" describes the WEIGHT of the evidence,
// not its absence, so it survives the count going from one to ten).
//
// ═══ 🚨 WHY THIS FILE REPLACED THE .mjs SOURCE-SCANNING VERSION ══════════════════════════════
// Its predecessor read SOURCE and said so in its own header: "it cannot see text built from
// variables, text in props of components it does not know about, or a NEW file carrying the
// falsehood. See PROGRESS.md: the guard should render the components and assert on text content."
// That note sat there since the file was written. The bridge panel then proved the cost of the
// approach twice over — five false alarms from text merely MOVING, each answered by loosening the
// pattern, and then a real deletion sailing through the loosened guard.
//
// ⭐ THREE THINGS THIS CAN DO THAT THE SOURCE SCAN COULD NOT:
//   1. `badge="Exit built · about seven days"` is a PROP passed to <Pocket>. Source could only
//      check the literal existed; this proves it REACHES THE OUTPUT.
//   2. The YourMoney disclosure is gated on `gwParked > 0`. A source count of 1 says nothing about
//      whether a user ever SEES it. This asserts BOTH: present when funds are parked, absent when
//      none are — and the absence is correct, not a bug, because there is nothing to disclose.
//   3. The forbidden phrases are checked against the WHOLE RENDERED TREE, including child
//      components (Pocket, AddressDisplay, SignInPrompt) whose files the old scan never opened.
//      That closes "a NEW file carrying the falsehood" for anything these trees render.
//
// ═══ 🚨 MEASURED 2026-08-20 — THIS HEADER NAMED `UbExitStatus` AND THAT WAS FALSE ════════════
// It is imported by UnifiedBalancePanel and IS in the tree, so "covered" looked obviously true.
// It contributes **ZERO CHARACTERS** to the rendered markup: `loading` starts `true` and every
// claim-bearing branch sits behind a `useEffect` fetch of `/api/ub-withdraw`, which SSR never
// runs. Measured by probe — five distinct phrases, including "Nothing arrives in your own wallet
// automatically" (the hop-3 caveat, the most load-bearing line in the component now that hop 2
// works), ALL absent from a 4,152-char render.
//
// ⭐⭐ SO A GUARD DOCUMENTED COVERAGE IT DID NOT HAVE, and the failure is silent BY CONSTRUCTION:
// an absence check over a component that renders nothing PASSES. The same mocking that was applied
// to `useGatewayBalance` (see the note below — SSR does not run effects) was never applied here,
// and the header was written as though it had been.
// ✅ CLOSED 2026-08-20 by `verify-ub-exit-view.tsx`, and NOT the way it was queued. "Mock the fetch"
// cannot work: there is no DOM and no effect pass under SSR, so the request never happens however
// it is stubbed — the seam had to be the RESULT, not the transport. That suite drives the REAL
// `ub-withdraw` GET handler and paints the REAL component with what it returns.
// ⚠️ THIS SUITE STILL DOES NOT COVER `UbExitStatus`. Its forbidden-phrase checks pass over an empty
// contribution here, exactly as before; the coverage lives in the other file. Read this line as a
// pointer, never as a claim about what runs below.
//
// ⚠️ PRESENT AND ABSENT ARE DIFFERENT CHECKS and only both together prove anything — a new phrase
// appearing does not mean the old one left. Counts stay EXACT, never `> 0`: a duplicated phrase and
// a silently-dropped site are both real defects, and `> 0` would pass while either is true.

import { mock } from "node:test";

// ── the gateway balance, chosen per scenario ────────────────────────────────────────────────
// ⚠️ MOCKED BECAUSE SSR DOES NOT RUN EFFECTS. `useGatewayBalance` loads in a useEffect, so under
// renderToStaticMarkup it would sit at `loading` forever and the parked-funds branch — the one
// carrying the disclosure — could never be reached. Mocking the DATA lets us render the real
// component in the real state a user with parked funds actually sees.
let gateway: any = { status: "ready", total: "7.5000", perChain: [] };
mock.module("../src/lib/useGatewayBalance", {
  namedExports: { useGatewayBalance: () => gateway },
});

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const UnifiedBalancePanel = (await import("../src/components/UnifiedBalancePanel")).default;
const YourMoney = (await import("../src/components/YourMoney")).default;

const wallet: any = {
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20),
  usdcBalance: "12.3456",
  busy: false,
  isAuthenticated: true,
  ensureSession: async () => "t",
  fundAgentWallet: async () => {},
  refreshAgentWallet: async () => {},
  refreshBalance: async () => {},
};

/** The text a browser paints — tags stripped, entities decoded, whitespace collapsed. ⭐ The
 *  collapse is the point: JSX wrapping is invisible to a reader and fatal to a source pattern. */
const render = (C: any) =>
  renderToStaticMarkup(<C wallet={wallet} />)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
/** Raw markup — for claims about ATTRIBUTES rather than body text. */
const markup = (C: any) => renderToStaticMarkup(<C wallet={wallet} />);
const n = (s: string, re: RegExp) => (s.match(re) || []).length;

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  UNIFIED BALANCE COPY — RENDERED; present AND absent, exact counts   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// with funds parked — the state the disclosure exists for
gateway = { status: "ready", total: "7.5000", perChain: [] };
const ubParked = render(UnifiedBalancePanel);
const ymParked = render(YourMoney);
const ymMarkup = markup(YourMoney);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the disclosure is PRESENT at all three body sites, AS RENDERED");
// UnifiedBalancePanel carries TWO body sites (the "what you can get back" bullet and the "fund the
// unified balance" card); YourMoney carries ONE (the amber line by Withdraw).
// ⚠️ These counts are now what a BROWSER SHOWS, not what the file contains. A site that exists in
// source but is unreachable — behind a condition nobody satisfies — used to pass and now fails.
for (const [label, re, eYM, eUB] of [
  ["control is stated", /Tikpema controls that account/g, 1, 2],
  ["⭐ the exit is stated as BUILT", /It is built now:/g, 1, 2],
  ["⭐⭐ the user is told they need NOT return (this is what makes it an exit)", /you do not have to come back/g, 1, 2],
  ["⭐⭐ …and that the evidence is THIN — one run, not a track record", /one real run, not a track record/g, 1, 2],
  // ⭐⭐ ADDED 2026-08-20, THE DAY HOP 2 FIRST RAN. Until then the page said the exit had been
  // "done once" directly after "we finish it automatically" — and the automatic finish had NEVER
  // happened. The sentence read as evidence for a claim nothing supported. What must now be
  // stated is that the run COMPLETED, not merely that it started.
  // ⚠️ "end to end" is the NARROWEST DURABLE form, deliberately: it survives the count going
  // from one to ten, where a date or a tally would rot. Same rule that saved the line above.
  ["⭐⭐ …and that the one run went ALL THE WAY — completed, not merely started", /end to end/g, 1, 2],
  // ⚠️ The reason changed but the requirement did not. This used to hold because hop 2 was
  // unproven; it now holds because the single MEASURED run took 7d4h against a 7.1-day estimate,
  // and maturity itself arrived 80 minutes late. The floor is no longer precautionary.
  ["⭐ …and the wait is still a FLOOR — the one measured run overran the estimate", /floor/g, 1, 2],
  ["the delay is DERIVED, never fixed", /about seven days/g, 2, 3],
] as [string, RegExp, number, number][]) {
  const a = n(ymParked, re), b = n(ubParked, re);
  check(`⭐ ${label}`, a === eYM && b === eUB, `YourMoney ${a}/${eYM}, UnifiedBalancePanel ${b}/${eUB}`);
}

// ⭐⭐ THE BADGE IS A PROP, AND THIS IS THE CHECK THE SOURCE SCAN COULD NOT MAKE. It is handed to
// <Pocket>, a component the old guard never opened — so "the literal exists in the file" was the
// most it could ever say. Four words next to a number get read more than the paragraph under them,
// and this badge has been wrong twice: "Server-released, delayed" (false, optimistic) and
// "No withdrawal built" (true until 06d3a94, false the instant the exit shipped).
check("⭐⭐ the BADGE names the exit AND its cost, and actually REACHES THE RENDERED OUTPUT",
  n(ymParked, /Exit built · about seven days/g) === 1,
  `rendered ${n(ymParked, /Exit built · about seven days/g)}×`);
check("  …and it is emitted as a real attribute, not swallowed by the child",
  /Exit built · about seven days/.test(ymMarkup));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — every prior falsehood is ABSENT from the RENDERED TREE");
// ⭐ Checked across BOTH panels in BOTH balance states, so a falsehood cannot hide in a branch that
// happens not to render in one scenario — and, because this is the rendered tree, it also cannot
// hide in a CHILD COMPONENT whose file the old source scan never opened.
gateway = { status: "ready", total: "0", perChain: [] };
const ubEmpty = render(UnifiedBalancePanel);
const ymEmpty = render(YourMoney);
gateway = { status: "signed-out" };
const ubOut = render(UnifiedBalancePanel);
const ymOut = render(YourMoney);
const everything = [ubParked, ymParked, ubEmpty, ymEmpty, ubOut, ymOut].join(" ⋯ ");

for (const [s, why] of [
  ["not by you, not by us", "v3 — denied a path that exists"],
  ["There is no path that returns it", "v3"],
  ["Server-released, delayed", "v2 — the badge"],
  ["no way out", "v3"],
  ["nothing can return it", "v3"],
  ["cannot be withdrawn", "v3"],
  ["cannot be returned to you", "v3"],
  ["we drive that account", "superseded wording"],
  ["haven't implemented it or tested that it works end to end", "v3.5 — denied a built exit"],
  ["not that no path exists", "v3.5 — the reason clause, now moot"],
  ["what stops a withdrawal today", "v3.5"],
  ["No withdrawal built", "v3.5 — the badge"],
  ["treat this as one-way", "v3.5 — there is a way back now"],
  // ⭐ v5's expired claim, now forbidden rather than merely not-required: a real run happened at
  // 20:49Z on 2026-08-12, so this sentence is false and must never come back.
  ["nobody has taken this route", "v4 — expired 2026-08-12"],
] as [string, string][]) {
  const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  check(`${JSON.stringify(s)} is gone from every rendered state`, n(everything, re) === 0, why);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE BEFORE-DEPOSIT DISCLOSURE — the sentence read before committing funds");
{
  // ⚠️ THE SKIM-LINE IS THE DISCLOSURE. Until 06d3a94 this card LED with "Treat this as one-way",
  // contradicting the paragraph beneath it the moment the exit shipped — and the lead is what gets
  // read. A correct paragraph under a wrong skim-line is a wrong card.
  const i = ubParked.indexOf("Move USDC from your agent");
  check("the deposit card renders at all", i >= 0);
  const card = ubParked.slice(i, i + 900);
  check("⭐⭐ the deposit card names the WAIT in its lead sentence, before any mechanism",
    /Money goes in instantly and takes about seven days to come back out/.test(card));
  check("  …and it precedes the explanation of WHY (cost first, mechanism second)",
    card.indexOf("about seven days") < card.indexOf("belongs to"));
  check("⭐ the card still says the exit is automatic", /you do not have to come back/.test(card));
  check("⭐ …and still says how little has been proven — one run, not a track record",
    /one real run, not a track record/.test(card));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ THE DISCLOSURE IS CONDITIONAL, AND THE CONDITION IS CORRECT");
// ⭐ ONLY RENDERING CAN STATE THIS. The old suite counted one occurrence in YourMoney's source and
// was silent on whether a user ever reaches it. The block is gated on `gwParked > 0` — and that is
// RIGHT, not a bug: it discloses money that IS parked, so with nothing parked there is nothing to
// disclose. Asserting it in both directions pins the gate itself, so neither a user with funds
// losing the warning nor an empty account growing a spurious one can happen unnoticed.
{
  check("⭐⭐ with funds parked, the user IS warned", /Tikpema controls that account/.test(ymParked));
  check("⭐⭐ with NOTHING parked, the warning is correctly absent — nothing is at stake to disclose",
    !/Tikpema controls that account/.test(ymEmpty));
  check("⭐ …and the panel still renders normally in that state, rather than blanking",
    ymEmpty.length > 200, `${ymEmpty.length} chars`);
  check("⭐ signed out, no false claim about the balance appears",
    !/Tikpema controls that account/.test(ymOut) && !/one real run/.test(ymOut));
  // UnifiedBalancePanel's disclosure is NOT balance-gated — it is the page you read BEFORE
  // depositing, so it must speak whether or not anything is parked yet.
  check("⭐⭐ the BEFORE-DEPOSIT disclosure is NOT balance-gated — it must be read before there is a balance",
    n(ubEmpty, /one real run, not a track record/g) === 2 && n(ubOut, /one real run, not a track record/g) === 2);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
