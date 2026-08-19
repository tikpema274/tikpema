// verify-activity-fallback.tsx — AN ENTRY WITH NO ACTION TYPE MUST SAY SO, NOT LOOK ORDINARY.
//
//   npx tsx scripts/verify-activity-fallback.tsx      (also: npm run test:activityfallback)
//
// ═══ ⭐ WHY THIS BRANCH NEEDS A TEST AT ALL ═════════════════════════════════════════════════════
// It is a FALLBACK. Every audit row written by recordAgentSpend carries a `source`, so in normal
// operation this branch never fires — which is exactly the condition under which a wrong rendering
// survives indefinitely. The first time it matters is the first time something wrote a row without
// one, and that is the worst moment to discover the label was reassuring.
//
// 🚨 THE DEFECT IT REPLACES: `{e.source ?? "action"}`. A row with no recorded type rendered as the
// word "action" — plausible, generic, and read as a FACT. A user auditing their own money movements
// would take it as a recorded action of an unremarkable kind, when the truth is we do not know what
// it was. ⭐ Raw looks like a gap; a plausible label looks like a fact. The second is worse, and it
// is the same rule as unclassified-vs-unwired and NOT-YET-vs-SUPERSEDED.
//
// ⚠️ BOTH DIRECTIONS: a row WITH a source must render that source verbatim and NOT the warning —
// otherwise a fix that warns on everything would pass a presence-only test.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityList } from "../src/components/AgentsPanel";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  ACTIVITY ROW — a missing action type must not look ordinary        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

console.log("\n── a row WITH a source renders it verbatim ─────────────────────────");
{
  const t = strip(renderToStaticMarkup(
    <ActivityList showAgent entries={[{ at: "2026-08-19T21:00:00Z", agent: "executor", source: "swap_tokens", amountUsdc: 5, allowed: true } as any]} />
  ));
  check("the real source appears", t.includes("swap_tokens"));
  check("the warning does NOT appear", !/no action type recorded/i.test(t));
  check("the acting agent is shown", t.includes("executor"));
}

console.log("\n── a row with NO source says so, and is still shown ────────────────");
{
  const t = strip(renderToStaticMarkup(
    <ActivityList showAgent entries={[{ at: "2026-08-19T21:00:00Z", agent: "executor", amountUsdc: 5, allowed: true } as any]} />
  ));
  // 🚨 THE OLD BEHAVIOUR, ASSERTED GONE: the generic word must not stand in for the unknown one.
  check("🚨 it does NOT render the bare word 'action' as the type", !/\baction\b(?!\s*type)/i.test(t), t.slice(0, 70));
  check("⭐ it states that no action type was recorded", /no action type recorded/i.test(t));
  check("the row is still SHOWN, not hidden", t.includes("executor"), "hiding it would be a worse absence");
}

console.log("\n── a refused row keeps its refusal marker either way ───────────────");
{
  const t = strip(renderToStaticMarkup(
    <ActivityList entries={[{ at: "2026-08-19T21:00:00Z", agent: "executor", amountUsdc: 5, allowed: false, reason: "day ceiling" } as any]} />
  ));
  check("refusal is still marked", /refused/i.test(t));
  check("…and the missing type is still called out", /no action type recorded/i.test(t));
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ A gap renders as a gap, and a real source renders as itself.\n");
