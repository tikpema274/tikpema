// verify-refusal-states.tsx — AN OUTAGE MUST NOT BE PRESENTED AS A DISAGREEMENT.
//
//   npx tsx scripts/verify-refusal-states.tsx      (also: npm run test:refusalstates)
//
// ═══ 🚨 THE DEFECT, MEASURED ON FIVE CONSECUTIVE JOBS ══════════════════════════════════════════
// Every swap since ~2026-08-14 was refused by Analyst B with the same reason:
//   "Stablecoin Service createSwap failed: Route or resource not found. No route available."
// That is B reporting an OUTAGE, not disagreeing. But it returned verdict:"refuse", which mapped to
// agreement:"hard_disagree", and the panel told the buyer:
//   "No action proposed · your analysts disagreed"
//   "this is the safeguard working, not a failure"
// ⭐ BOTH SENTENCES ARE FALSE FOR AN OUTAGE. Nobody disagreed — A wanted the trade and B said the
// venue was down. And something IS failing; just not us and not the user. A buyer reads "your
// analysts disagreed" and concludes the action was DEBATABLE, when it was IMPOSSIBLE.
//
// ⚠️ THE STATE COMES FROM A TYPED `cause`, NEVER FROM MATCHING B'S PROSE. A test that asserted on
// the sentence would pass while the classifier read the sentence too — both wrong together. So the
// fixture sets `cause` and the assertions read the rendered OUTPUT.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SecondOpinionCard } from "../src/components/jobTimeline";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const render = (agreement: string, headline: string) =>
  strip(renderToStaticMarkup(
    <SecondOpinionCard
      synthesis={{ agreement, proposalSurvives: false, headline, detail: "d" } as any}
      secondOpinion={{ verdict: "refuse", headline: "B said so", facts: [] } as any}
      analystAReasoning="A argued for it"
    />
  ));

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  REFUSAL STATES — an outage is not a disagreement                   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

console.log("\n── cannot_execute: the venue is down ───────────────────────────────");
{
  const t = render("cannot_execute", "This action cannot be carried out right now — the venue is unavailable.");
  // 🚨 THE TWO FALSE SENTENCES, ASSERTED ABSENT.
  check("🚨 does NOT say the analysts disagreed", !/analysts disagreed/i.test(t));
  check("🚨 does NOT claim 'the safeguard working, not a failure'", !/safeguard working/i.test(t));
  check("⭐ says it cannot be carried out right now", /cannot be carried out right now/i.test(t));
  check("⭐ says it is NOT a disagreement", /not a disagreement/i.test(t));
  check("⭐ says it is not the user's doing", /not something you did/i.test(t));
  check("⭐ reassures that nothing was spent or stuck", /nothing has been spent and nothing is stuck/i.test(t));
  check("says it is usually temporary", /usually temporary/i.test(t));
}

console.log("\n── hard_disagree: a genuine disagreement, copy UNCHANGED ───────────");
{
  const t = render("hard_disagree", "Your two analysts disagree — so nothing is proposed.");
  check("⭐ still says the analysts disagreed", /analysts disagree/i.test(t));
  check("⭐ still says the safeguard is working", /safeguard working/i.test(t));
  // ⚠️ The outage copy must NOT leak into a real disagreement — a fix that showed both would be
  // just as misleading in the other direction.
  check("🚨 does NOT show the outage copy", !/venue.*not currently accepting|nothing is stuck/i.test(t));
}

console.log("\n── not_actionable: nothing to price ────────────────────────────────");
{
  const t = render("not_actionable", "The proposed action was not well-formed, so there was nothing to price.");
  check("says there was nothing to price", /nothing to price/i.test(t));
  check("⭐ says NO JUDGEMENT was made", /no judgement was made/i.test(t));
  check("does NOT say the analysts disagreed", !/analysts disagreed/i.test(t));
  check("does NOT show the outage copy", !/nothing is stuck/i.test(t));
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ Each refusal state says what actually happened, and none borrows another's words.\n");
