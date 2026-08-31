// verify-research-panel-copy.tsx — WHICH HALF OF A PROMISE IS ACTUALLY GUARANTEED.
//
//   npx tsx scripts/verify-research-panel-copy.tsx        (also: npm run test:copy)
//
// ═══ 🚨 WHAT WRITING THIS FOUND ══════════════════════════════════════════════════════════════
// One sentence carried two promises: "your agent researches and delivers a CITED brief ONLY IF YOU
// APPROVE it." Only one of them is guaranteed.
//
//   ✅ APPROVAL is STRUCTURAL. The commission button lives inside the `{quote && …}` block, so it
//      cannot render before a price exists. Not a policy — a shape.
//   🚨 CITATION is NOT ENFORCED in the current posture. `job-submit-background` refuses an uncited
//      brief only when `RESEARCH_CITATION_ENFORCE === "enforce"`, and the default is deliberately
//      permissive — its own fallback message says "uncited briefs will SHIP. This is fail-OPEN by
//      design." Measured 2026-08-20: the variable is UNSET on production.
//
// ⭐ THE FAIL-OPEN IS DELIBERATE AND DOCUMENTED, so the defect is not the posture — it is the
// SENTENCE, which promised both halves in the same breath. Briefs do cite in practice (six recorded
// jobs, all sourced), which is exactly why this survived: a claim that is usually true reads as a
// guarantee until someone checks what enforces it.
//
// ⚠️ AND THIS SUITE CANNOT READ PROD ENV — it runs offline inside test:all. So it pins the pairing
// it CAN see: while the code's default is permissive, the copy must not phrase citation as a
// guarantee. If the default is ever flipped to enforcing, section 2 says so and the copy may be
// strengthened deliberately.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const ResearchPanel = (await import("../src/components/ResearchPanel")).default;

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
const rendered = renderToStaticMarkup(<ResearchPanel wallet={wallet} />)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();

// ═══ 🚨 SIGNED OUT, THIS PAGE WAS A WALL ═══════════════════════════════════════════════════════
// The precondition here is a CONNECTED WALLET: every action calls `ensureSession()`, which throws
// "Connect a wallet first" when `authContext()` is null. Not an agent wallet, not funds — the same
// fact #/agents and #/unified turn on, which is why this reuses the SAME component they do rather
// than inventing a fourth sentence. ⭐ The facts are identical, so the words are shared; that is the
// same test that said NOT to share the custody sentence or the twin-link cap clause.
// [[verify-facts-before-sharing-words]]
const signedOut = renderToStaticMarkup(<ResearchPanel wallet={{ ...wallet, address: undefined }} />);
check("⭐⭐ signed out → the way in is an ACTION, not a disabled button",
  /<button[^>]*>\s*Connect a wallet\s*<\/button>/.test(signedOut));
check("⭐ …and it names what THIS page needs",
  /Sign in to run research/i.test(signedOut.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")));
const panelSrc = readFileSync("src/components/ResearchPanel.tsx", "utf8");

// ═══ 🚨 "NOTHING RUNS UNTIL YOU APPROVE" WAS FALSE — THE ASK IS A RUN ═══════════════════════════
// Asking calls `job-quote`, which calls Anthropic (job-quote.mjs:72) to classify and price. A model
// call therefore fires BEFORE approval. What approval actually gates is the research job, the
// escrow funding, and the CHARGE.
// ⚠️ SECOND CORRECTION TO THIS SENTENCE. The comment above it already records the first: the old
// wording "delivers a cited brief only if you approve it" read as a guarantee of BOTH delivery and
// citation, and was fixed to guarantee one. That fix repaired the citation half and left the
// "nothing runs" half wrong — a correction that touched the sentence and did not re-audit it.
// ⛔ AND THE PLAN PATH'S SENTENCE MUST NOT BE COPIED HERE. "Nothing moves until you approve it"
// (PlanPanel:149) is TRUE, because on plan-quote no work happens before approval. On research the
// BRIEF ALREADY EXISTS by then. Same words, opposite verdicts — a real difference in what the two
// products do, not a copy inconsistency. [[verify-facts-before-sharing-words]]
check("⛔ does NOT claim that nothing RUNS before approval — pricing calls a model",
  !/nothing runs until you approve/i.test(rendered));
check("⭐ states what is actually gated: DELIVERY and the CHARGE",
  /nothing is delivered/i.test(rendered) && /nothing is charged/i.test(rendered));
check("⭐ …and discloses that pricing itself runs something",
  /pricing/i.test(rendered));
check("⛔ …without borrowing the PLAN path's true-there/false-here phrasing",
  !/nothing moves until you approve/i.test(rendered));
const submit = readFileSync("netlify/functions/job-submit-background.mjs", "utf8");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  RESEARCH PANEL COPY — guaranteed vs aimed at                        ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the panel renders at all");
check("⚠️ non-empty render", rendered.length > 150, `${rendered.length} chars`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE GUARANTEED HALF: NOTHING IS DELIVERED OR CHARGED BEFORE APPROVAL");
// ═══ 🚨 THIS SECTION USED TO PIN THE FALSE CLAIM ═══════════════════════════════════════════════
// It asserted `/nothing runs until you approve it/`, which is exactly the sentence that was wrong:
// the ask calls job-quote, which calls Anthropic to classify and price, so a model call fires
// BEFORE approval. ⛔ An assertion that pins a false claim is worse than no assertion — it makes
// FIXING the defect turn the suite red, so the pressure runs toward keeping the falsehood. This
// section went red when the copy was corrected, which is how it was found.
// ⭐ The section title moved too: it named the wrong guarantee, so it would have re-seeded the same
// claim for the next person editing this file. [[verify-facts-before-sharing-words]]
check("⭐⭐ the page promises nothing is DELIVERED or CHARGED until approval",
  /nothing is delivered and nothing is charged until you approve/i.test(rendered));
check("⭐ …and is honest that PRICING itself runs, and is free",
  /Pricing your question runs first and costs you nothing/i.test(rendered));
check("⭐ …and the only pre-approval control is a PRICE request, not a commission",
  /Get a price/.test(rendered) && !/Research this|Commission/.test(rendered));
// 🚨 THE PROOF IS BEHAVIOURAL, NOT POSITIONAL — and that is a deliberate second attempt.
// ⚠️ My first version grepped the source for the literal `{quote && (` and asserted the commission
// markup sat after it. That would have failed on a harmless refactor to `{quote !== null && (` —
// a SPURIOUS failure, which is how a gate earns the reputation that gets it loosened. It also
// never actually ran when tested: mutating the gate made React THROW, so the suite failed by crash
// and the assertion proved nothing. A blank result is neither a pass nor a fail.
// ⭐ So: render the panel in its REAL default state — no quote — and require that nothing
// commissionable is on screen. That survives any refactor and tests the property itself.
//
// ⚠️ HONESTLY LABELLED: THIS ASSERTION IS UNPROVEN BY MUTATION. Every attempt to defeat the gate
// made React THROW — the block dereferences quote state throughout, so removing the gate produces
// NO screen rather than a wrong one. The property is currently enforced by the component's own data
// dependency, more strongly than by this check. ⭐ What this check guards is the REALISTIC drift
// path: a null-safe refactor (`quote?.budgetUsdc ?? 0`) would make the block renderable without a
// price, and then only an assertion like this one would notice. Claiming a mutation catch here
// would be claiming a measurement that was never taken.
// ⚠️ AND THE MARKER IS THE PRICE, NOT THE WORD "APPROVE". My first behavioural pattern matched
// /Approve/ — which matches the FIX'S OWN PROSE, "nothing runs until you approve it". The third
// time today an absence check has been defeated by the sentence that states the property. ⭐ The
// commissionable UI is identified by what only IT can render: a price in USDC, and a commit-button
// label. Prose cannot forge either.
check("⭐⭐ …and with NO price yet, nothing commissionable renders — a shape, not a policy",
  !/\bUSDC\b/.test(rendered) && !/Research this|Commission this|Start research/i.test(rendered),
  rendered.match(/\bUSDC\b|Research this|Commission this/i)?.[0] ?? "clean");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 THE UNGUARANTEED HALF MUST NOT BE PHRASED AS A GUARANTEE");
// ⭐ The pairing this suite exists for. Read the ENFORCEMENT POSTURE from the code, then require the
// copy to match it — rather than pinning a sentence and hoping the posture never moves.
const enforceValue = /const CITATION_ENFORCE_VALUE = "enforce"/.test(submit);
const permissiveDefault = /uncited briefs will SHIP/.test(submit);
check("⭐ the citation refusal is still gated on an explicit flag", enforceValue);
check("⚠️ …and the default is still FAIL-OPEN, by its own words", permissiveDefault,
  "uncited briefs will SHIP — this is fail-OPEN by design");
check("🚨🚨 …so the copy must NOT promise a cited brief as a guaranteed deliverable",
  !/delivers a cited brief/i.test(rendered), rendered.match(/cited[^.]{0,40}/i)?.[0] ?? "");
// ⚠️ `cites?` — the corrected sentence reads "does your agent research and cite the sources it
// used", an infinitive after "does". The claim is unchanged; only the inflection moved, and pinning
// one inflection would have forced the copy to be worse to keep a regex green.
check("⭐⭐ …while still saying the agent DOES cite — the practice is real, only the guarantee is not",
  /cites? the sources it used/i.test(rendered));
// ⚠️ If the posture is ever flipped, this suite should be revisited rather than silently passing.
if (permissiveDefault) {
  console.log("     ⚠️ POSTURE: citation enforcement is PERMISSIVE by default and UNSET on prod");
  console.log("        (measured 2026-08-20). ⭐ If RESEARCH_CITATION_ENFORCE is set to \"enforce\",");
  console.log("        the guarantee becomes real and this section should be re-decided — deliberately.");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐ THE SCOPE CLAIM STAYS HONEST ABOUT WHAT IT ANSWERS");
check("⭐ it asks for a FACTUAL, SOURCEABLE question rather than promising to answer anything",
  /factual, sourceable answer/.test(rendered));
check("🚨 …and does not promise an answer to any question at all",
  !/answers? (any|every) question/i.test(rendered));

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
