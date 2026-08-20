// verify-job-status-merge.tsx — THE REAL RECORD, THROUGH THE REAL MERGE, RENDERED.
//
//   npx tsx scripts/verify-job-status-merge.tsx        (also: npm run test:copy)
//
// ═══ 🚨 WHAT THIS GUARDS, AND WHY NOTHING CAUGHT IT FOR MONTHS ═══════════════════════════════
// `SecondOpinionCard` — the entire killed-proposal disclosure, all six agreement states — had
// NEVER RENDERED IN PRODUCTION. `job-run-status` projected `synthesis` and `secondOpinion`
// correctly all along; all three client panels rebuilt `TrackedJob` from a hand-written field list
// and named neither, in every commit that ever existed. Job #181281: a buyer paid ~0.25 USDC and
// received a brief with no proposal and no account of why — the exact state the disclosure thread
// exists to prevent.
//
// ⭐⭐ THE TESTS THAT EXISTED COULD NOT HAVE CAUGHT IT, AND THAT IS THE LESSON. `verify-refusal-
// states` renders `jobTimeline` with a job object built BY THE TEST — so it proved the card renders
// when fed, which was true and useless. The defect lived in the FEEDING, one layer up, and a guard
// that constructs its own input can never see it. ⭐ Hence: a REAL payload, through the REAL merge,
// into the REAL component. The only fixture is the recorded server response.
//
// ⚠️ A BINDING CAN ONLY BE TESTED ACROSS WHAT IT BINDS. Server-side, `14c23c8` already fixed this
// exact shape with a declared field list and an assertion at every write site — and it did not
// cover this, because the drop happened in the browser. This suite exists to sit ON that boundary.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { mergeJobStatus, NOT_TRACKED } from "../src/lib/mergeJobStatus";

const { JobTimeline } = await import("../src/components/jobTimeline");

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

/** The ACTUAL server response for job #181281 — a swap refused with `cannot_execute`. */
const RECORD = JSON.parse(readFileSync(new URL("./fixtures/job-run-status-181281.json", import.meta.url), "utf8"));

const text = (job: any) =>
  renderToStaticMarkup(<JobTimeline job={job} />)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  JOB STATUS MERGE — real record → real merge → rendered timeline     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("0 — 🚨 THE FIXTURE MUST STILL EXERCISE THE GATE");
// ⚠️ THIS SECTION IS HERE BECAUSE THE TRAP ALREADY FIRED ONCE. The whole delivered block is gated
// on `status === "completed"`; a probe passing `"settled"` (the record's `evalStatus`) rendered
// nothing, which looked for a minute like a SECOND defect rather than a bad harness. If a future
// fixture loses that status, every assertion below would pass vacuously against an empty render.
check("🚨 the fixture's status is `completed` — the value the render block gates on",
  RECORD.status === "completed", `status=${JSON.stringify(RECORD.status)} evalStatus=${JSON.stringify(RECORD.evalStatus)}`);
check("⭐ …and it really is a REFUSED proposal, or the card would have nothing to say",
  RECORD.synthesis?.agreement === "cannot_execute" && RECORD.synthesis?.proposalSurvives === false,
  RECORD.synthesis?.agreement);
check("⭐ …with the cause typed at the catch site, not re-derived from prose",
  RECORD.secondOpinion?.cause === "cannot-execute");
check("⚠️ …and NO top-level proposal, which is what the card's gate requires",
  RECORD.proposal === undefined || RECORD.proposal === null);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE DEFECT ITSELF: the card must survive the merge");
const polled = mergeJobStatus({ runId: "r1", status: "starting" } as any, RECORD);
check("⭐⭐ `synthesis` SURVIVES the merge (it did not, in any commit, ever)", !!polled.synthesis);
check("⭐ `secondOpinion` survives too — the card reads B's own words from it", !!polled.secondOpinion);

const rendered = text(polled);
for (const [phrase, why] of [
  ["No action taken · this cannot be carried out right now", "the header — an outage, not a disagreement"],
  ["not a disagreement", "the correction that ce58631 shipped"],
  ["not something you did", "the buyer must not read it as their error"],
  ["Nothing has been spent and nothing is stuck", "the money statement"],
] as [string, string][]) {
  check(`⭐ rendered: "${phrase}" — ${why}`, rendered.includes(phrase));
}
check("🚨 …and the DISAGREEMENT copy must NOT appear on an outage (both directions)",
  !rendered.includes("your analysts disagreed") && !rendered.includes("the safeguard working"));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 THE OBSERVED SYMPTOM MUST NOT REPRODUCE");
// What the user actually saw: the sources list running straight into "View settlement".
const i = rendered.indexOf("View settlement");
check("🚨 something stands between the sources and the settlement link",
  i > 0 && /cannot be carried out/.test(rendered.slice(0, i)),
  i > 0 ? "…" + rendered.slice(Math.max(0, i - 60), i).trim() : "no settlement link rendered");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ THE SHAPE: a field nobody has thought of yet must arrive BY DEFAULT");
// ⭐ THIS IS THE ASSERTION THAT GENERALISES. Every previous instance of this bug was a NEW field
// that an include-list did not mention. A guard naming only `synthesis` would pass while the
// fourth field vanished exactly as the first three did.
const future = mergeJobStatus({ runId: "r1" } as any, { status: "completed", aFieldInventedTomorrow: { v: 1 } } as any);
check("⭐⭐ an UNKNOWN projected field survives without anyone adding it here",
  (future as any).aFieldInventedTomorrow?.v === 1);
check("⭐ …and the omit-list still removes what the client must not track",
  Object.keys(mergeJobStatus({ runId: "keep-me" } as any,
    { runId: "overwritten", walletAddress: "0xdead", status: "completed" } as any))
    .includes("walletAddress") === false);
check("⭐⭐ …including identity: a payload can NEVER re-point the tracked run",
  mergeJobStatus({ runId: "keep-me" } as any, { runId: "overwritten", status: "completed" } as any).runId === "keep-me");
check("  …and NOT_TRACKED is short and deliberate, not a second include-list",
  NOT_TRACKED.length <= 4, `${NOT_TRACKED.length} entries: ${NOT_TRACKED.join(", ")}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⚠️ ABSENCE MUST NEVER OVERWRITE A KNOWN VALUE");
// The server sends `jobId: run.jobId ?? null` before the id is known. A plain spread would erase
// an id the client already had — the same absence-reads-as-fact family, pointed at UI state.
const kept = mergeJobStatus({ runId: "r1", jobId: "181281", brief: { answer: "a" } } as any,
  { status: "completed", jobId: null, brief: undefined } as any);
check("⚠️ a null does not erase a known jobId", kept.jobId === "181281");
check("⚠️ an undefined does not erase a known brief", (kept as any).brief?.answer === "a");
check("⭐ …but a real new value DOES replace the old one",
  mergeJobStatus({ status: "starting" } as any, { status: "completed" } as any).status === "completed");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — ⭐ AND THE CARD MUST STAY ABSENT WHEN THERE IS NOTHING TO SAY");
// Present-only checks pass for a component that always renders. Both directions or neither.
const noSynth = mergeJobStatus({ runId: "r1" } as any,
  { ...RECORD, synthesis: undefined, secondOpinion: undefined } as any);
const bare = text(noSynth);
check("⭐ with no synthesis, the card is correctly absent", !bare.includes("cannot be carried out"));
check("  …and the brief still renders, rather than the timeline blanking", bare.length > 200, `${bare.length} chars`);

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
