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
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const UnifiedBalancePanel = (await import("../src/components/UnifiedBalancePanel")).default;
const YourMoney = (await import("../src/components/YourMoney")).default;
const UbExitStatus = (await import("../src/components/UbExitStatus")).default;

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
// ═══ 🚨 THE EXPECTED COUNTS WERE 2 FOR UnifiedBalancePanel, AND THAT PINNED THE DUPLICATION ═══
// Until 2026-09-04 this table required TWO rendered copies of the custody/mechanism/evidence block
// on that page — one in the balance bullet, one in the deposit card. That is not a property anyone
// chose; it is the count that happened to exist when the table was written, frozen into a
// requirement. When the page was deduplicated into state / action / collapsed-explanation, eight
// assertions went red reading `1/2` — red for the WRONG REASON, and the ordering and card
// assertions (the ones that pin actual properties) all stayed green throughout.
//
// ⭐⭐ A GUARD THAT PINS A CLAIM KEEPS IT TRUE OR KEEPS IT FROZEN. This one froze a LAYOUT. Third
// instance in this repo on one day, after verify-bridge-batch-atomicity pinned an atomicity
// overclaim and a "no batched burn has landed" line that two runs had already falsified.
// ⚠️ THE COUNTS STAY EXACT rather than becoming `>= 1`: exactness is this file's stated discipline,
// and an exact 1 also catches a future RE-duplication, which `>= 1` would wave through.
for (const [label, re, eYM, eUB] of [
  ["control is stated", /Tikpema controls that account/g, 1, 1],
  ["⭐ the exit is stated as BUILT", /It is built now:/g, 1, 1],
  ["⭐⭐ the user is told they need NOT return (this is what makes it an exit)", /you do not have to come back/g, 1, 1],
  ["⭐⭐ …and that the evidence is THIN — one run, not a track record", /one real run, not a track record/g, 1, 1],
  // ⭐⭐ ADDED 2026-08-20, THE DAY HOP 2 FIRST RAN. Until then the page said the exit had been
  // "done once" directly after "we finish it automatically" — and the automatic finish had NEVER
  // happened. The sentence read as evidence for a claim nothing supported. What must now be
  // stated is that the run COMPLETED, not merely that it started.
  // ⚠️ "end to end" is the NARROWEST DURABLE form, deliberately: it survives the count going
  // from one to ten, where a date or a tally would rot. Same rule that saved the line above.
  ["⭐⭐ …and that the one run went ALL THE WAY — completed, not merely started", /end to end/g, 1, 1],
  // ⚠️ The reason changed but the requirement did not. This used to hold because hop 2 was
  // unproven; it now holds because the single MEASURED run took 7d4h against a 7.1-day estimate,
  // and maturity itself arrived 80 minutes late. The floor is no longer precautionary.
  ["⭐ …and the wait is still a FLOOR — the one measured run overran the estimate", /floor/g, 1, 1],
  // ⚠️ UB 2 -> 1: the deposit card's copy of "about seven days" was cut (it renders 3× in the
  // How-this-works card and 2× in the withdraw block). The property is that the phrase stays
  // APPROXIMATE PROSE — never a hardened number — and one occurrence satisfies it exactly as two did.
  ["the delay is DERIVED, never fixed", /about seven days/g, 2, 1],
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
  // 🚨 THIS PINNED THE SENTENCE, NOT THE PROPERTY — the fourth guard-freeze of this kind.
  // It required the exact string "Money goes in instantly and takes about seven days to come back
  // out". Splitting that into two sentences ("Money goes in instantly." / "Getting it out takes
  // about seven days.") preserves every property it exists to defend and still turned it red.
  // ⭐ It now asserts the TWO FACTS and their ORDER, which is what "names the WAIT in its lead,
  // before any mechanism" actually means. Wording is free to improve; the ordering is not.
  // ═══ 🚨 CHANGED 2026-09-05, AND NOT BECAUSE THE GUARD WAS WRONG ══════════════════════════
  // These pinned "the deposit card names the WAIT in its lead". The seven-day claim has been
  // REMOVED from this card by decision: it renders 3× in the How-this-works card, 2× in the
  // withdraw block directly beneath, and once in the ladder — measured before cutting.
  // ⛔ WHAT MUST STILL HOLD IS THE ASYMMETRY. The lead's job was never the number as such; it was
  // to stop the card reading as a free, symmetric action. So the assertion now requires BOTH
  // halves — instant IN, through-us OUT — which is what makes it a disclosure rather than an
  // invitation, and is the property 06d3a94 actually restored.
  const lead = card.slice(0, 260);
  check("⭐⭐ the deposit card states the ASYMMETRY in its lead — instant in, through us out",
    /Money goes in instantly/.test(lead) && /runs through us/.test(lead), lead.slice(0, 120));
  check("  …and the cheap half never stands alone",
    card.indexOf("Money goes in instantly") < card.indexOf("runs through us"));
  // ⚠️⚠️ THIS ONE CAUGHT ME THIS MORNING AND IT WAS RIGHT THEN. Stripping "It is built now" and
  // "you do not have to come back" left the deposit card saying only the ALARMING half. Both were
  // restored. They have now been removed AGAIN, deliberately: the withdraw block sits directly
  // below and says "We finish this automatically — you do not have to come back", so the
  // reassurance is one section away and needs no press.
  // ⛔ THE COST IS REAL AND IS RECORDED RATHER THAN ARGUED AWAY: at the moment of pressing Deposit
  // the card states the constraint without the thing that makes it bearable. If that reads badly
  // in use, this is the assertion to restore, and the eight words to put back.
  check("⭐ the reassurance is reachable without a press — from the withdraw block below",
    /you do not have to come back/.test(ubParked));
  // ⚠️ THE EVIDENCE MOVED OUT OF THE DEPOSIT CARD with the seven-day claim it supports — it now
  // sits behind the affordance in "How this works". This asserted it inside a 900-char window from
  // the deposit lead, and the evidence now falls 934 chars in: red for a WINDOW, not for a missing
  // claim. Asserted against the whole page instead, where the property actually lives.
  check("⭐ …and the page still says how little has been proven — one run, not a track record",
    /one real run, not a track record/.test(ubParked));
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
    n(ubEmpty, /one real run, not a track record/g) === 1 && n(ubOut, /one real run, not a track record/g) === 1);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⛔ THE ZONES: custody sits with the ACTION, evidence hangs off the NUMBER");
// ⭐ ADDED 2026-09-04 with the state / action / explanation split. Neither property was pinned
// before, so the dedupe could have satisfied every existing assertion while quietly moving the
// custody sentence into a collapsed block nobody opens.
{
  const mk = markup(UnifiedBalancePanel);
  const i = ubParked.indexOf("Move USDC from your agent");
  const card = ubParked.slice(i, i + 900);

  // ── (a) CUSTODY STAYS WITH THE ACTION ──────────────────────────────────────────────────────
  // ⛔ A user pressing Deposit must be told the exit runs through us AT THE MOMENT THEY PRESS.
  // This file already records the relocation defect once; the guard is what stops a third time.
  check("⛔⛔ the custody sentence is INSIDE the deposit card, not in an explanation elsewhere",
    /Tikpema controls that account/.test(card));
  check("  …and it is NOT inside the collapsed evidence region",
    !/Tikpema controls that account/.test(
      (mk.match(/id="ub-exit-evidence"[^>]*>([\s\S]*?)<\/span>/) || ["", ""])[1]));

  // ── (b) THE EVIDENCE HANGS OFF THE NUMBER ──────────────────────────────────────────────────
  // ⭐ "about seven days" IS the control. A detached "Learn more" would satisfy a presence check
  // and fail the constraint, so the BINDING is asserted, not the presence.
  const btn = (mk.match(/<button[^>]*aria-controls="([^"]+)"[^>]*>\s*about seven days\s*<\/button>/) || [])[1];
  check("⭐⭐ the affordance IS the seven-day claim — a button whose label is the number",
    !!btn, btn ? `aria-controls=${btn}` : "no button labelled 'about seven days'");
  check("⭐⭐ …and it CONTROLS the evidence region — the binding, not merely a nearby link",
    !!btn && new RegExp(`id="${btn}"`).test(mk));
  const region = (mk.match(/id="ub-exit-evidence"[^>]*>([\s\S]*?)<\/span>/) || ["", ""])[1];
  check("⭐ …and the evidence actually lives in that region",
    /one real run, not a track record/.test(region) && /2026-08-12/.test(region));

  // ── COLLAPSED, NEVER OMITTED ───────────────────────────────────────────────────────────────
  // ⚠️ `hidden` keeps the node in the DOM. A conditional that omits it would hide the claim from
  // the reader who opens it AND from every guard that reads rendered output.
  check("⭐ the region is COLLAPSED BY DEFAULT (hidden), not omitted",
    /id="ub-exit-evidence"[^>]*hidden/.test(mk) || /hidden[^>]*id="ub-exit-evidence"/.test(mk));
  check("  …and its text is still in the rendered output despite being hidden",
    /one real run, not a track record/.test(ubParked));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐ THE JUNE SHAPE: header → balance → action → explanation, in that ORDER");
// ⭐ Restored from the June single-file design, which already had the shape this page had drifted
// away from. Order is asserted by INDEX in the rendered text, because "the card exists" says
// nothing about whether a reader meets it before or after the thing it explains.
{
  // ⚠️ `markup()` RE-RENDERS WITH WHATEVER `gateway` WAS LAST SET TO, and earlier sections change
  // it to empty/signed-out. The tab strip is gated on `bal.status === "ready"`, so without this
  // reset the markup has no tabs and every check below reads -1 — a fixture fault that looks
  // exactly like a missing feature. Reset to the parked state `ubParked` was captured under.
  gateway = { status: "ready", total: "7.5000", perChain: [], depositor: "0x" + "ab".repeat(20) };
  const mk    = markup(UnifiedBalancePanel);
  const iBal  = ubParked.indexOf("Your unified balance · across chains");
  const iDep  = ubParked.indexOf("Move USDC from your agent");
  const iHow  = ubParked.indexOf("How this works");
  check("the zones render", [iBal, iDep, iHow].every((i) => i >= 0),
    `balance ${iBal} · deposit ${iDep} · how ${iHow}`);
  check("⭐⭐ the BALANCE leads — the number before any action", iBal < iDep);

  // ═══ ⛔⛔ THE TABS, AND THE ONE PROPERTY THAT MATTERS MOST ══════════════════════════════════
  // The labelled "Withdraw from Unified Balance…" heading is GONE — replaced by a tab strip, which
  // is the last piece of the June shape. Those assertions were obsolete by decision, not wrong.
  const iStatus = mk.indexOf("Checking your exit");
  const iTabs   = mk.indexOf("aria-pressed");
  check("⭐ the tab strip renders, with Deposit selected by default",
    /aria-pressed="true"[^>]*>\s*Deposit|Deposit[\s\S]{0,40}aria-pressed="true"/.test(mk) ||
    (iTabs >= 0 && mk.slice(iTabs, iTabs + 400).includes("Deposit")));
  check("⭐ both tabs exist", />\s*Deposit\s*</.test(mk) && />\s*Withdraw\s*</.test(mk));
  // ⛔⛔ THE DEFECT THIS SLICE EXISTS TO AVOID. A pending withdrawal behind an unselected tab is
  // "a live withdrawal NOBODY COULD SEE IN THE APP" with a click added. The STATUS half must render
  // ABOVE the tab strip, never inside it. Asserted by position in MARKUP, so moving it in fails.
  // 🚨 MY FIRST VERSION OF THIS COULD NOT FAIL. It anchored on "Checking your exit…", which is an
  // EARLY RETURN in UbExitStatus that fires before the `section` gating — so under SSR both halves
  // render the identical placeholder and swapping section="status" to section="action" was NOT
  // CAUGHT. It measured that *an* instance sits above the tabs, never that it is the STATUS one.
  // ⭐ Split into a BEHAVIOURAL proof that the prop works, and a POSITIONAL one that the panel
  // wires it the right way round.
  check("⭐ an exit instance renders above the tab strip", iStatus >= 0 && iTabs >= 0 && iStatus < iTabs,
    `instance ${iStatus} · tabs ${iTabs}`);
  {
    const seeded = { data: { owner: "0x" + "ab".repeat(20),
      balance: { readable: true, availableUsdc: "7.5000", withdrawableUsdc: "0" },
      withdrawals: [], disclosure: { approxDelayDays: 7.1 } } } as any;
    const txt = (el: any) => renderToStaticMarkup(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const st = txt(<UbExitStatus token={async () => "t"} initial={seeded} section="status" />);
    const ac = txt(<UbExitStatus token={async () => "t"} initial={seeded} section="action" />);
    check("⭐⭐ section=\"status\" shows the rows and NOT the form",
      /Getting money out/.test(st) && !/Start withdrawal/.test(st));
    check("⭐⭐ section=\"action\" shows the form and NOT the rows",
      /Start withdrawal/.test(ac) && !/Getting money out/.test(ac));
  }
  // ⛔⛔ AND THE PANEL MUST WIRE THE ABOVE-TABS INSTANCE TO THE STATUS HALF. Source, deliberately:
  // the halves are indistinguishable in SSR output because of the early return above.
  const panelSrc = readFileSync("src/components/UnifiedBalancePanel.tsx", "utf8");
  const iSrcStatus = panelSrc.indexOf('section="status"');
  const iSrcTabs   = panelSrc.indexOf("aria-pressed");
  check("⛔⛔ pending withdrawals are the STATUS half, wired ABOVE the tabs",
    iSrcStatus >= 0 && iSrcTabs >= 0 && iSrcStatus < iSrcTabs, `status@${iSrcStatus} tabs@${iSrcTabs}`);
  // ⭐ `hidden`, not omitted — so the custody disclosure survives for any guard reading output.
  // ⚠️ /hidden/ alone matched the evidence span and could not fail; bound to the tab expression.
  check("⭐ the deposit card is HIDDEN when unselected, not omitted",
    /hidden=\{bal\.status === "ready" && tab !== "deposit"\}/.test(panelSrc));
  check("⭐⭐ the explanation card is LAST — after the action it explains", iDep < iHow);
  // ⛔⛔ FUNDING BEFORE WITHDRAWAL. The exit used to render inside the balance card, which put
  // WITHDRAW above DEPOSIT — backwards on a page whose first job is funding.
  //
  // 🚨 THE FIRST DRAFT OF THIS ASSERTION PASSED VACUOUSLY. It looked for "Getting money out" and
  // guarded with `iWd < 0 || …` — and "Getting money out" is behind UbExitStatus's LOADED state,
  // which SSR never reaches, so the escape hatch fired on every run. An assertion that cannot
  // fail is not an assertion. [[a-check-whose-failure-mode-is-a-pass]]
  // ⭐ It now anchors on "Checking your exit…", which is what the component ACTUALLY emits under
  // renderToStaticMarkup — verified by rendering it, not by reading the source for a likely
  // string — and the presence of that anchor is asserted BEFORE its position is compared.
  // ⛔ SUPERSEDED BY THE TABS. "Deposit before withdrawal" was about two stacked SECTIONS; the two
  // actions are now tabs (Deposit selected by default) and the exit STATUS half deliberately sits
  // ABOVE both. Order between them is asserted above, in markup, against the tab strip.

  // ⭐ Each depth exactly once, in its own zone.
  check("⭐⭐ the MECHANISM lives in the explanation card, not in the deposit card",
    iHow < ubParked.indexOf("Arc's Gateway holds the funds for a delay"));
  // ⚠️ NARROWED with the same decision: the qualifiers moved out of the deposit card. What must
  // still be true is that CUSTODY ITSELF is at the press — that is the claim with no other home.
  check("⛔⛔ custody is stated at the press, and it is the ONLY place it appears",
    /Tikpema controls that account/.test(ubParked.slice(iDep, iDep + 900)) &&
    (ubParked.match(/Tikpema controls that account/g) || []).length === 1);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
