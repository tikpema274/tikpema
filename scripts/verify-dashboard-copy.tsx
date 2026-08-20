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
const PRESENT_TENSE_PAYMENT =
  /\b(?:it|agent)\s+(?:pays|signs|buys|purchases|settles)\b|\bpaid automatically\.|\bruns automatically when\b/i;
check("🚨🚨 the Nanopayments card makes no bare present-tense payment claim",
  !PRESENT_TENSE_PAYMENT.test(rendered), rendered.match(PRESENT_TENSE_PAYMENT)?.[0] ?? "");
check("⭐ …and it says the capability exists WITHOUT claiming it has been used",
  /can pay a fraction of a cent/.test(rendered) && /has not needed to yet/.test(rendered));

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

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
