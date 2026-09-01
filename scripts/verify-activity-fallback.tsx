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

// ═══ 🚨 BOOKKEEPING ROWS — THE SWEEPER'S TWO SHAPES, RENDERED ═════════════════════════════════
// `agentBreakdown` excludes both from the totals ON PURPOSE. The view did not, so the trail
// rendered them as exactly the two things the totals refuse to call them. Fed the REAL production
// shapes, not hand-flattered ones.

console.log("\n── a RESOLUTION marker is bookkeeping, not a refusal ───────────────");
{
  // ⭐ The literal production row: data-budget, 2026-08-22, resolution-620e455e-…
  const t = strip(renderToStaticMarkup(
    <ActivityList entries={[{
      agent: "executor", kind: "resolution", resolves: "620e455e-70fa-52bb-a6df-bca66827173a",
      outcome: "COMPLETE", justification: "landed on-chain", amountUsdc: 0, allowed: false,
      timestamp: "2026-08-22T21:13:20.996Z",
    } as any]} />
  ));
  // 🚨 THE DEFECT, ASSERTED GONE. `allowed:false` made this render as a guard refusal.
  check("🚨 it does NOT claim anything was refused", !/refused/i.test(t), t.slice(0, 80));
  // 🚨 …AND THE SECOND FALSE CLAIM. It HAS a recorded type; it just is not a `source`.
  check("🚨 it does NOT claim the action type went unrecorded", !/no action type recorded/i.test(t));
  check("⭐ it says what it actually is", /charge retired/i.test(t));
  check("the observed outcome is carried, not dropped", t.includes("COMPLETE"));
  check("⭐ the justification reaches a reader at last", /landed on-chain/i.test(t));
  // ⭐ 0.0000 USDC would assert a zero-value transfer happened. Nothing moved.
  check("⭐ it asserts no transfer, rather than a zero one", /no money moved/i.test(t) && !/0\.0000/.test(t), t.slice(0, 90));
}

console.log("\n── a REVERSAL is not a second spend ────────────────────────────────");
{
  const html = renderToStaticMarkup(
    <ActivityList entries={[{
      agent: "executor", kind: "reversal", source: "agent-send", justification: "charge did not land",
      amountUsdc: 5, allowed: true, timestamp: "2026-08-22T21:13:20.996Z",
    } as any]} />
  );
  const t = strip(html);
  // 🚨 THE DEFECT: allowed:true + the charge's own source rendered it identically to the charge.
  check("🚨 it is NOT rendered as an ordinary spend", /reversed/i.test(t), t.slice(0, 80));
  check("⭐ the amount reads as a CREDIT, not a second debit", t.includes("−5.00") && !/(?<!−)\b5\.00/.test(t), t.slice(0, 90));
  check("it still names the action it undoes", t.includes("agent-send"));
  check("its grounds are shown", /charge did not land/i.test(t));
  // Colour, asserted on the MARKUP: neither the red of a refusal nor the plain white of a spend.
  // ⚠️ THE TOKEN, NOT THE LITERAL. This read /e5484d/ back when every call site spelled the hex
  // inline as `var(--danger, #e5484d)`. The moment --danger became a real token in styles.css the
  // literal left the markup entirely — and this assertion would have passed VACUOUSLY, green no
  // matter how the row was painted, while reading exactly as it does now.
  // [[equality-passes-vacuously-on-empty]] · [[check-whose-failure-mode-is-a-pass]]
  check("it is not painted as a refusal", !/var\(--danger\)/.test(html));
  check("it is not painted as a spend", !/var\(--paper\)/.test(html));

  // ⭐⭐ THE POSITIVE CONTROL THIS PAIR NEVER HAD. Both negatives can hold simply because the
  // markup stopped containing either token — the failure mode of an absence check is a PASS. So
  // render the row this one is supposed to DIFFER from, and require the marker to be genuinely
  // detectable there. A negative is evidence only once the thing it denies is known to show up.
  // [[collapse-needs-pairwise-inequality]] · [[absence-must-never-read-as-safe]]
  const refusedHtml = renderToStaticMarkup(
    <ActivityList entries={[{
      agent: "executor", source: "agent-send", reason: "day ceiling",
      amountUsdc: 5, allowed: false, timestamp: "2026-08-22T21:13:20.996Z",
    } as any]} />
  );
  check("⭐ CONTROL: a REFUSAL *is* painted with --danger, so the negative above CAN fail",
    /var\(--danger\)/.test(refusedHtml));
  check("⭐⭐ …and the two rows therefore differ in paint, not merely in wording",
    /var\(--danger\)/.test(refusedHtml) !== /var\(--danger\)/.test(html));
}

console.log("\n── BOTH DIRECTIONS: an ordinary row is untouched by the branch ─────");
{
  const t = strip(renderToStaticMarkup(
    <ActivityList entries={[{ agent: "executor", source: "agent-send", amountUsdc: 5, allowed: true, timestamp: "2026-08-22T21:13:20.996Z" } as any]} />
  ));
  // ⚠️ A fix that labelled EVERYTHING bookkeeping would pass every assertion above.
  check("⚠️ a real spend is NOT called bookkeeping", !/bookkeeping/i.test(t), t.slice(0, 80));
  check("…and its amount is still a debit", t.includes("5.00") && !t.includes("−5.00"));
}

console.log("\n── an UNRECOGNISED kind falls through, it does not vanish ──────────");
{
  const t = strip(renderToStaticMarkup(
    <ActivityList entries={[{ agent: "executor", kind: "something-new", amountUsdc: 5, allowed: false, reason: "day ceiling", timestamp: "2026-08-22T21:13:20.996Z" } as any]} />
  ));
  // ⭐ A closed set, read the safe way: only the two known kinds are reclassified. A future kind
  // is shown by the ordinary branches — which already state a gap rather than inventing a label.
  check("⭐ an unknown kind is still SHOWN", t.includes("executor") || /day ceiling/i.test(t), t.slice(0, 80));
  check("…and is not silently called bookkeeping", !/bookkeeping/i.test(t));
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ A gap renders as a gap, a real source as itself, and bookkeeping as neither a spend nor a refusal.\n");
