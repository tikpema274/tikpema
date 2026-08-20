// verify-nanopay-copy.tsx — A CAPABILITY PAGE, PINNED TO WHAT THE CAPABILITY ACTUALLY DOES.
//
//   npx tsx scripts/verify-nanopay-copy.tsx        (also: npm run test:copy)
//
// ═══ 🚨 WHY THIS EXISTS ══════════════════════════════════════════════════════════════════════
// `NanopaymentPanel` described the agent-buys-from-agent flow in PRESENT TENSE — "It signs a tiny
// on-chain USDC payment", "Only a confirmed settlement counts as a purchase", "This runs
// automatically when you commission research" — for a step that has never fired in production.
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
section("1 — 🚨 NO PRESENT-TENSE CLAIM ABOUT A STEP THAT HAS NOT RUN");
for (const [phrase, why] of [
  ["This runs automatically when you commission research", "asserted the flow happens on every job"],
  ["It signs a tiny on-chain USDC payment", "present tense for a signature never made in production"],
  ["Only a confirmed settlement counts as a purchase", "a rule about settlements that have not occurred"],
] as [string, string][]) {
  check(`🚨 "${phrase}" is gone — ${why}`, !rendered.includes(phrase));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE HONEST STATE IS SAID, NOT IMPLIED BY OMISSION");
// 🚨 Deleting the over-claim without replacing it would leave a page that still reads as a live
// feature. The absence checks above are only safe because these presence checks stand beside them.
check("⭐⭐ the page says the paid step has NOT yet happened",
  /so far it has not happened/i.test(rendered));
check("⭐ …and that free sources answered every job to date",
  /free sources have answered every research job to date/i.test(rendered));
check("⭐ …and step 3 marks itself as not yet run for a real job",
  /This step has not yet run for a real job/.test(rendered));
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
