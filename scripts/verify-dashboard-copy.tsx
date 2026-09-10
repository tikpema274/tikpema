// verify-dashboard-copy.tsx — THE DASHBOARD'S CLAIMS, RENDERED, BOTH DIRECTIONS.
//
//   npx tsx scripts/verify-dashboard-copy.tsx        (also: npm run test:copy)
//
// ═══ 🚨 WHAT WRITING THIS FOUND ══════════════════════════════════════════════════════════════
// The Nanopayments card still read "See how your agent PAYS a fraction of a cent for fresh data" —
// present tense for a step that has never fired — an hour after the same claim was corrected on
// `NanopaymentPanel` itself. ⭐⭐ THE PAGE WAS FIXED AND THE CARD WAS NOT, because nobody grepped
// for the second copy. That is this repo's own recorded rule ("a claim copied into a second place
// always drifts; grep for the OTHER copy before declaring it fixed") failing in the hour after it
// was applied elsewhere.
//
// ═══ ⭐ AND ONE CLAIM SURVIVED SCRUTINY, WHICH IS ALSO A RESULT ═══════════════════════════════
// "stop any of them instantly" reads like the adverb class just corrected twice ("cancelling stops
// it immediately", "the exact fee and net arrival"). It is TRUE: `_pause.mjs` reads the flag with
// `consistency: "strong"`, deliberately, with a note explaining that Netlify Blobs default to a
// CDN-cached edge read and a stale "not paused" would silently defeat the switch. ⚠️ SO THE WORD IS
// LOAD-BEARING ON A CONFIG CONSTANT: flip READ_CONSISTENCY to "eventual" and "instantly" becomes
// false with no edit to this page. Section 2 binds them together.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const Dashboard = (await import("../src/components/Dashboard")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const wallet: any = {
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
  ensureSession: async () => "t", refreshAgentWallet: async () => {}, refreshBalance: async () => {},
};
// ⭐ TWO HANDLES ON ONE RENDER, AND THEY ANSWER DIFFERENT QUESTIONS.
// `rendered` is TEXT ONLY — every tag stripped — because almost every check here is about what a
// reader SEES, and asserting against markup is how a copy guard ends up green about a string that
// never reaches the screen.
// ⚠️ `markup` exists for the few checks that are genuinely STRUCTURAL (is this a <details>? is that
// sentence inside the <summary>?). Running those against `rendered` does not fail — it passes
// VACUOUSLY, because a tag regex can never match text with no tags in it. Measured here: the
// "shut by default" check went green against `rendered` before this split.
// ═══ 🚨 WITHOUT THIS STUB, "SHUT BY DEFAULT" IS UNTESTABLE — MEASURED ═══════════════════════
// FoldSection reads its initial open state from localStorage inside a try/catch. Node has no
// localStorage, so the initializer THROWS and the catch returns false — meaning EVERY possible
// default renders shut, and a check on the markup passes no matter what the code intends.
// ⛔ MEASURED 2026-09-10: mutating the default to OPEN left this suite 24/0 GREEN. The assertion
// was pinned to the catch branch, not to the default it names — a check whose failure mode is a
// pass. The stub makes the real branch run, so the default becomes something a test can see.
// ⚠️ An EMPTY store is the honest fixture: it is what a first-time visitor has.
const foldStore = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => foldStore.get(k) ?? null,
  setItem: (k: string, v: string) => { foldStore.set(k, v); },
  removeItem: (k: string) => { foldStore.delete(k); },
};

const markup = renderToStaticMarkup(<Dashboard wallet={wallet} />);
const rendered = renderToStaticMarkup(<Dashboard wallet={wallet} />)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();
const pause = readFileSync("netlify/functions/_pause.mjs", "utf8");
const arc = readFileSync("netlify/functions/_arc.mjs", "utf8");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DASHBOARD COPY — the front door's claims                            ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the page renders at all");
check("⚠️ non-empty render", rendered.length > 800, `${rendered.length} chars`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 NO SECOND COPY OF A CLAIM CORRECTED ELSEWHERE");
// ⭐ THE SAME CLASS PATTERN `verify-nanopay-copy` uses, applied here on purpose: the two surfaces
// carry one claim between them, so they must be checked the same way or the copy drifts again.
// 🚨 2026-09-09 — INVERTED, IN STEP WITH `verify-nanopay-copy`. The card said "and why it has not
// needed to yet" and this suite REQUIRED that sentence — while the buy side had fired three times
// since 2026-08-20. ⛔ Both surfaces were wrong, both guards were green, and the guards were green
// BECAUSE they pinned each other's wording rather than the fact underneath.
const OVERCLAIMS_FREQUENCY =
  /\b(?:on every (?:research )?job|every time you|always (?:pays|buys|purchases)|runs on every)\b/i;
check("🚨🚨 the Nanopayments card makes no FREQUENCY over-claim",
  !OVERCLAIMS_FREQUENCY.test(rendered), rendered.match(OVERCLAIMS_FREQUENCY)?.[0] ?? "");
const NEVER_CLAIM = /\bhas not needed to yet\b|\b(?:has not|hasn't|never)\s+(?:yet\s+)?(?:happened|run|been needed|been used)\b/i;
check("⭐⭐ …and no NEVER-claim survives on the card either",
  !NEVER_CLAIM.test(rendered), rendered.match(NEVER_CLAIM)?.[0] ?? "");
check("⭐ …while still framing the paid buy as RARE, which is what is true",
  /can pay a fraction of a cent/.test(rendered) && /rarely needs to/.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ 'INSTANTLY' IS BOUND TO THE READ THAT MAKES IT TRUE");
check("⭐ the page claims agents can be stopped instantly", /stop any of them instantly/.test(rendered));
// 🚨 The binding. A cached read of the pause flag would let an agent act AFTER the user hit stop,
// and nothing on this page would change. The claim's truth lives in a constant in another file.
check("⭐⭐ …and the pause flag is read with STRONG consistency, so a stop is seen immediately",
  /const READ_CONSISTENCY = "strong"/.test(pause));
check("⭐ …with both pause keys read that way, not just one",
  (pause.match(/consistency: READ_CONSISTENCY/g) || []).length >= 2,
  `${(pause.match(/consistency: READ_CONSISTENCY/g) || []).length} reads`);
check("⭐ …and an UNREADABLE pause flag refuses rather than assuming 'running'",
  /could not be read/i.test(pause) || /UNREADABLE/.test(pause));
check("⭐ the page also promises each agent declares whether it can move money",
  /says whether it can move your money/.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE THREE MONEY CATEGORIES, AND THEIR BOUNDARIES");
// Same taxonomy as MyAgentPanel, so the same rule: presence is not enough, position decides which
// action a warning describes.
check("⭐ internal moves are marked as staying with the user", /Nothing leaves you/.test(rendered));
check("⭐ outward moves are marked as leaving", /This leaves you/.test(rendered));
check("⭐⭐ SEND still carries the irreversibility warning",
  /Goes to someone else\. Gone — there is no undo/.test(rendered));
check("⭐ VAULT is marked third-party, with its owner powers flagged BEFORE depositing",
  /Into a third-party vault/.test(rendered) && /read the owner's powers first/.test(rendered));
const insideAt = rendered.indexOf("Nothing leaves you");
const outAt = rendered.indexOf("This leaves you");
const undoAt = rendered.indexOf("there is no undo");
check("⭐⭐ …and 'there is no undo' sits in the LEAVING half, not beside the internal moves",
  insideAt > 0 && outAt > insideAt && undoAt > outAt,
  `internal@${insideAt} leaving@${outAt} undo@${undoAt}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐ THE UNIFIED BALANCE IS STILL THE ONE POCKET WITH A MEDIATED EXIT");
// ⚠️ Checked AFTER hop 2 completed: the exit is now proven end to end, and this claim is still
// true — an exit that RUNS THROUGH US is not an exit the user can take alone. Proving the exit
// works did not make the page's warning stale, and softening it would be the wrong lesson.
check("⭐⭐ 'the one pocket you can't pull back alone' still stands",
  /the one pocket you can't pull back alone/i.test(rendered));
check("⭐ …and the delay and the mediation are both named",
  /releasing it is delayed and goes through us/i.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐ THE CAPS NAMED ON THE FRONT DOOR HAVE ENFORCEMENT BEHIND THEM");
check("⭐ the lead names per-transaction and daily caps",
  /per-transaction and daily spending caps/.test(rendered));
check("⭐⭐ …and both have a real enforcement point, which fails CLOSED when misconfigured",
  /AGENT_MAX_SPEND_USDC/.test(arc) && /refusing to spend/.test(arc));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ THE FOLD MUST NOT SWALLOW THE CONSEQUENCE");
// The money/agent groups collapse so the page is a short list rather than twelve cards. That is a
// layout choice with a SAFETY EDGE: "This leaves you." and "Nothing leaves you." are the whole
// reason the grouping exists (§3), and folding them away would hide the one sentence this page is
// built to put in front of a click. So they must live in the ALWAYS-VISIBLE <summary>, never in
// the collapsible body — and presence alone cannot tell the difference, which is why this section
// asks WHERE, exactly as §3 does for ordering.
{
  const summaries = [...markup.matchAll(/<summary\b[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
  const inASummary = (phrase: string) => summaries.some((b) => b.includes(phrase));

  check("⭐ the groups render as native <details>, not a JS-only widget",
    (markup.match(/<details\b/g) ?? []).length === 3,
    `${(markup.match(/<details\b/g) ?? []).length} folds — native gives keyboard and SR behaviour free`);
  check("⭐ …each with a summary to click", summaries.length === 3, `${summaries.length} summaries`);

  check("⭐⭐ 'Nothing leaves you' is in the ALWAYS-VISIBLE summary", inASummary("Nothing leaves you"));
  check("⭐⭐ 'This leaves you' is in the ALWAYS-VISIBLE summary", inASummary("This leaves you"),
    "shut, this is the only thing standing between the reader and a card that moves money out");

  // ⛔⛔ THE CARDS MUST STAY IN THE DOM WHEN SHUT. Conditional rendering would remove them, and §3
  // decides the money boundaries BY DOCUMENT ORDER — a shut section would break a guard about copy
  // the reader can still reach in one click. <details> hides visually and keeps the markup.
  check("⛔⛔ the card bodies are present even though the sections default SHUT",
    /there is no undo/.test(rendered) && /Into a third-party vault/.test(rendered),
    "conditional rendering here would silently gut §3");
  // ═══ 🚨 THE COUNT IS A SECOND COPY OF A FACT THE CONTENT ALREADY HOLDS ═══════════════════════
  // Each fold states how many items are behind it. That number is HAND-WRITTEN and the items are
  // right there — two sources for one fact, which in this repo has never not drifted.
  // ⛔ IT DRIFTED IMMEDIATELY. "Ask your agent" shipped declaring 6 with SEVEN inside, and went to
  // production that way: the "What else is built →" link is a `quick-card` in the same grid and is
  // indistinguishable from a ConsequenceCard to a reader. Shut, the summary stated a false number —
  // on the one line a reader sees before deciding whether to open the section.
  // ⭐ Derived from the SOURCE and compared, so adding a card without bumping the count is red, not
  // a quiet lie. That is the case that matters: the next card added here is #/dca's.
  {
    const src = readFileSync(new URL("../src/components/Dashboard.tsx", import.meta.url), "utf8");
    const folds = src.split("<FoldSection").slice(1);
    check("⭐ every fold is found in source — the check has something to be about", folds.length === 3,
      `${folds.length} FoldSection blocks`);
    for (const f of folds) {
      const id = /id="([^"]+)"/.exec(f)?.[1] ?? "?";
      const declared = Number(/count=\{(\d+)\}/.exec(f)?.[1] ?? NaN);
      const body = f.split("</FoldSection>")[0];
      const actual = (body.match(/<ConsequenceCard\b/g) ?? []).length
                   + (body.match(/className="quick-card"/g) ?? []).length;
      check(`⭐⭐ fold "${id}" states the number of items it actually contains`,
        declared === actual, `declares ${declared}, contains ${actual}`);
    }
  }

  check("⭐ …and the fold is genuinely shut by default — the page is short on arrival",
    !/<details[^>]*\sopen\b/.test(markup),
    "if this flips to open, the shorter page was lost and nobody would see a red");
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
