// verify-nanopay-copy.tsx — A CAPABILITY PAGE, PINNED TO WHAT THE CAPABILITY ACTUALLY DOES.
//
//   npx tsx scripts/verify-nanopay-copy.tsx        (also: npm run test:copy)
//
// ═══ 🚨 WHY THIS EXISTS — AND IT HAS NOW BEEN WRONG IN BOTH DIRECTIONS ══════════════════════
// FIRST: `NanopaymentPanel` described the agent-buys-from-agent flow in PRESENT TENSE for a step
// that had never fired. SECOND, and worse: after the step DID fire (2026-08-20), the page went on
// saying "so far it has not happened" for 20 days — and THIS SUITE REQUIRED that sentence.
// ⚠️ Its own header contradicted itself in nine lines: "already runs server-side" above "when a
// LIVE version lands, this is its spec". Both were quotable in good faith, which is how it survived.
//
// ═══ ⭐⭐ AND THE DIAGNOSIS THAT WAS RECORDED FIRST WAS WRONG ═══════════════════════════════
// The buy side's failure to fire was attributed to "two independent blockers": a seller charging
// 100× our ceiling, on the wrong chain. Both came from reading `accepts[0]` of a 21-entry menu.
// The seller advertises OUR chain at 0.0001 USDC — 100× UNDER the ceiling — and our selector
// matches it. ⭐ THE REAL REASON IS ROUTING: `decidePurchase` returns one of four kinds, and only
// `onchain` costs anything. Six recorded jobs, six free routes.
//
// ⚠️ SO THE COPY MUST STATE THE MECHANISM, NOT A TALLY. "Only a question needing a live on-chain
// reading routes to a paid buy" survives the first purchase; "we have never bought anything" would
// rot in the understating direction the moment it did. This suite pins the mechanism and binds it
// to the code that defines it.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { ALLOWED_ONCHAIN_METHODS } from "../netlify/functions/_cryptodata.mjs";

const NanopaymentPanel = (await import("../src/components/NanopaymentPanel")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const rendered = renderToStaticMarkup(<NanopaymentPanel />)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();
const research = readFileSync("netlify/functions/_research.mjs", "utf8");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  NANOPAYMENT COPY — a capability page vs the capability              ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the page renders at all");
check("⚠️ non-empty render", rendered.length > 400, `${rendered.length} chars`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 NO OVER-CLAIM ABOUT HOW OFTEN THE PAID STEP RUNS");
// ═══ ⭐⭐ A CLASS CHECK, BECAUSE THE ENUMERATED VERSION FAILED SILENTLY ══════════════════════
// This section originally listed three remembered phrases and passed 13/0 — while the page's own
// <h2> still read "A fraction of a cent, PAID AUTOMATICALLY", the most-read line on it, and the
// Dashboard card still said "your agent PAYS a fraction of a cent". Both were present tense for a
// step that has never fired, and both sailed through, because AN ABSENCE CHECK OVER AN ENUMERATED
// LIST IS AN INCLUDE-LIST — and include-lists fail silent. That is the rule this repo wrote into
// mergeJobStatus the same day, violated one file over.
// ⭐ So the check is now a CLASS: any bare present-tense payment verb about the agent. A new
// sentence nobody thought to name fails by default and must be worded deliberately.
// 🚨 2026-09-09 — THIS CHECK GUARDED THE WRONG DIRECTION, AND HAD TO BE INVERTED.
// It forbade any present-tense payment verb, because at the time the paid step had never fired.
// The step HAS fired (measured below), so "it signs a tiny on-chain USDC payment" is now simply
// TRUE, and a check banning it would force the page to keep understating. ⛔ Two of the three
// regression pins below were removed for the same reason — a pin whose justification has expired
// is not a safety net, it is a lock holding the page at a stale claim.
// ⭐ WHAT REMAINS DANGEROUS IS FREQUENCY, NOT EXISTENCE: 3 purchases across 57 classified jobs.
// So the class check now bans "this happens on every job", which is the over-claim still available.
const OVERCLAIMS_FREQUENCY =
  /\b(?:on every (?:research )?job|every time you|always (?:pays|buys|purchases)|runs on every|with each (?:research )?job)\b/i;
check("⭐⭐ no FREQUENCY over-claim survives anywhere on the page",
  !OVERCLAIMS_FREQUENCY.test(rendered),
  rendered.match(OVERCLAIMS_FREQUENCY)?.[0] ?? "");
// ⚠️ The one surviving pin: still false, and for the original reason. It does NOT run on every job.
check('🚨 "This runs automatically when you commission research" is gone — asserted the flow happens on every job',
  !rendered.includes("This runs automatically when you commission research"));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ NO NEVER-CLAIM SURVIVES, AND THE RARE FRAMING IS SAID OUT LOUD");
// 🚨 Deleting the over-claim without replacing it would leave a page that still reads as a live
// feature. The absence checks above are only safe because these presence checks stand beside them.
// 🚨🚨 THESE THREE ASSERTED THE FALSEHOOD AS A REQUIREMENT. They pinned "so far it has not
// happened", "free sources have answered every research job to date" and "This step has not yet
// run for a real job" as MUST-BE-PRESENT — so the suite stayed green for 20 days across the exact
// event it existed to describe, and would have gone RED on the correction. ⭐ A presence check on
// a sentence about the world is only as durable as the fact; pin the MECHANISM, and ban the
// class of claim that can rot.
const NEVER_CLAIM =
  /\b(?:has not|hasn't|have not|haven't|never)\s+(?:yet\s+)?(?:happened|run|been needed|been chosen|bought|purchased|paid)\b|\bnot yet run for a real job\b|\bso far (?:it|they)\b|\bhas not needed to yet\b/i;
check("⭐⭐ no NEVER-claim about the paid step survives, as a CLASS not a list",
  !NEVER_CLAIM.test(rendered), rendered.match(NEVER_CLAIM)?.[0] ?? "");
check("⭐ …and the page still says the paid buy is RARE, which is what is true",
  /In practice this is rare/i.test(rendered));
check("⭐⭐ …and the taxonomy backing that has a `purchased` outcome in the engine",
  /PURCHASED:\s*"purchased"/.test(research), "_research.mjs classifies a real paid outcome");
check("⭐⭐ …while still saying it is BUILT — 'not yet used' is not 'not built'",
  /wired and funded/.test(rendered));
check("⭐ …and that a purchase that does not happen costs the user nothing",
  /not charged for a purchase that does not happen/i.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE MECHANISM IS STATED, AND BOUND TO THE CODE THAT DEFINES IT");
// The durable claim: only a live on-chain reading routes to a paid buy. If the routing widens, the
// page's list is stale — so the list is checked against the enum, not against my memory of it.
const methods = [...ALLOWED_ONCHAIN_METHODS];
check("⭐ the paid route is still exactly three on-chain readings",
  methods.length === 3, methods.join(", "));
check("⭐⭐ …and the page names all three in plain language",
  /block height/.test(rendered) && /gas price/.test(rendered) && /account balance/.test(rendered),
  "eth_blockNumber · eth_gasPrice · eth_getBalance");
check("⭐ …and says free sources are tried FIRST, which is what actually happens",
  /checks whether the free sources/.test(rendered) && /skips buying\s*entirely/.test(rendered));
// ⚠️ The quoted ceiling is a NUMBER on a money page — bind it to the code's default so a change
// there cannot leave the page quoting a figure the engine no longer enforces.
check("⭐⭐ the quoted per-buy ceiling matches the engine's hardcoded default",
  /\$?0\.01/.test(rendered) && /: 0\.01;/.test(research), "$0.01");

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
