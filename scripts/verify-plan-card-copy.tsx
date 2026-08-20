// verify-plan-card-copy.tsx — the "Plan an action" card, RENDERED and asserted both ways.
//
//   npx tsx scripts/verify-plan-card-copy.tsx      (also: npm run test:copy)
//
// ═══ 🚨 WHY THIS FILE EXISTS ═════════════════════════════════════════════════════════════════
// Until 2026-08-20 NOTHING guarded this card, and it carried a false promise for four deferrals:
//
//   the card promised   "…proposes a concrete plan — WITH LIVE PRICING."
//   the report delivered "fees MAY BE disproportionately large"           (job #181044)
//
// ⚠️ THAT ORDERING IS WHAT MAKES IT A MIS-SALE RATHER THAN A DISAPPOINTMENT: the claim is on the
// card a buyer reads BEFORE paying, the hedge is in the artifact they receive AFTER. The
// unified-balance copy has been wrong five times and has a guard; this card was wrong once, for
// longer, and had none. An unguarded claim is one nobody is required to revisit.
//
// ═══ ⭐ WHAT IS PINNED, AND WHY IT IS A CLAIM ABOUT CONDUCT ══════════════════════════════════
// The underlying situation is ASYMMETRIC and moves: bridges can quote a measured fee from our own
// timestamped table (8c1d1e9); swaps cannot be priced at all while Circle's createSwap returns
// "No route available" for USDC↔EURC on Arc testnet. A card promising pricing flatly is false for
// swaps; one promising none understates bridges; one NAMING the drought rots the day it lifts.
// ⭐ So what is pinned is conduct — measured where measurable, honest where not, NEVER invented.
// That is true on both sides of the outage, which is exactly the shelf-life property the
// unified-balance guard learned the hard way (it enforced a lie twice by pinning a dated claim).
//
// ⚠️ PRESENT AND ABSENT ARE DIFFERENT CHECKS. A new phrase appearing does not mean the old one
// left. Counts are EXACT, never `> 0`.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

const PlanPanel = (await import("../src/components/PlanPanel")).default;

const wallet: any = {
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20),
  usdcBalance: "12.3456",
  busy: false,
  isAuthenticated: true,
  ensureSession: async () => "t",
  refreshAgentWallet: async () => {},
  refreshBalance: async () => {},
};

/** The text a browser paints — tags stripped, entities decoded, whitespace collapsed. ⭐ The
 *  collapse is the point: JSX wrapping is invisible to a reader and fatal to a source pattern. */
const rendered = renderToStaticMarkup(<PlanPanel wallet={wallet} />)
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ")
  .trim();
const n = (re: RegExp) => (rendered.match(re) || []).length;

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  PLAN CARD COPY — RENDERED; present AND absent, exact counts         ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the card renders at all");
check("⚠️ the lead paragraph is present (an empty render would pass every absence check below)",
  /Describe an on-chain action in plain language/.test(rendered), `${rendered.length} chars`);

section("1 — ⭐⭐ THE PRICING CLAIM IS ABOUT CONDUCT, NOT COVERAGE");
check("⭐⭐ a measurable fee is promised as a MEASURED figure, with its timestamp",
  n(/quoted as a measured figure with its timestamp/g) === 1);
check("⭐⭐ …and an unmeasurable one is promised HONESTY, not a number",
  n(/says so rather than inventing a number/g) === 1);
check("⭐ the plan itself is still promised as concrete — the product was not undersold",
  n(/proposes a concrete plan/g) === 1);
check("⭐ …and the sources claim survives (it was never the false half)",
  n(/from cited sources/g) === 1);

section("2 — ⭐⭐ THE APPROVAL GATE — the sentence that makes the card safe to read");
check("⭐⭐ nothing moves without the user, stated on the card itself",
  n(/Nothing moves until you approve it/g) === 1);
check("⭐ the two supported actions are still named, so the card cannot over-promise scope",
  /bridge USDC off Arc/.test(rendered) && /convert between USDC and EURC on Arc/.test(rendered));

section("3 — 🚨 EXPIRED CLAIMS THAT MUST NEVER RETURN");
for (const [phrase, why] of [
  ["with live pricing", "the four-deferral mis-sale — promised a number the swap path cannot produce"],
  ["live pricing", "any bare form of it, wherever it is reworded to"],
  ["guaranteed pricing", "a stronger form of the same overclaim"],
] as [string, string][]) {
  check(`"${phrase}" is gone from the rendered card — ${why}`, !rendered.includes(phrase));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
