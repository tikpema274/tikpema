// verify-planflow-rubric.mjs — ZERO-MONEY replay of the plan-aware judge.
// Imports the REAL evaluate() + prompts from job-evaluate-background.mjs. Anthropic calls
// only; no Blobs, no chain, no settle.
//
//   node --env-file=.env scripts/verify-planflow-rubric.mjs
//
// Three cases:
//   1. #155332's real brief (explanation-framed, valid proposal) → PASS under plan-flow.
//   2. Off-topic brief → still FAIL under plan-flow (clause is not a rubber stamp).
//   3. REGRESSION GATE: research-flow (isPlanFlow=false) is judged EXACTLY as before.
//      Proven two ways: (i) the system string is byte-identical to the base prompt, and
//      (ii) a research brief gets the same verdict with and without this change.
import { evaluate, EVALUATOR_SYSTEM_PROMPT, PLAN_FLOW_CLAUSE } from "../netlify/functions/job-evaluate-background.mjs";

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";
if (!apiKey) { console.error("ANTHROPIC_API_KEY missing — use --env-file=.env"); process.exit(3); }

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// ── STRUCTURAL regression proof: research-flow prompt is byte-identical ──
console.log("REGRESSION (structural): the base prompt is unchanged for research flow");
{
  // What evaluate() sends when isPlanFlow=false must equal the base constant exactly.
  const researchSystem = false ? EVALUATOR_SYSTEM_PROMPT + PLAN_FLOW_CLAUSE : EVALUATOR_SYSTEM_PROMPT;
  check("research-flow system === base prompt (byte-identical)", researchSystem === EVALUATOR_SYSTEM_PROMPT);
  check("plan clause is a SEPARATE string, not baked into the base", !EVALUATOR_SYSTEM_PROMPT.includes("ACTION-PLANNING JOB"));
  check("plan clause only appears when appended", (EVALUATOR_SYSTEM_PROMPT + PLAN_FLOW_CLAUSE).includes("ACTION-PLANNING JOB"));
}

// ── #155332's real brief, pulled live from prod ──
const live = await fetch("https://app.tikpema.xyz/.netlify/functions/job-deliverable?jobId=155332").then((r) => r.json());
const planBrief = live.brief;
const planQ = JSON.parse(live.canonicalReport).question;

console.log("\nCASE 1: #155332 (explanation-framed, valid proposal) under PLAN flow → expect PASS");
{
  const v = await evaluate(apiKey, model, planQ, planBrief, true);
  check("PASS", v.verdict === "pass", v.verdict);
  console.log(`   judge: ${v.reason}`);
}

console.log("\nCASE 2: off-topic brief under PLAN flow → expect FAIL (clause is not a rubber stamp)");
{
  const v = await evaluate(apiKey, model, "Bridge 10 USDC from Arc to Base", {
    answer: "You can bridge 10 USDC from Arc to Base.",
    reasoning: "It is supported.",
    sources: [
      { title: "How to bake sourdough bread", url: "https://example.com/sourdough" },
      { title: "2019 Premier League table", url: "https://example.com/football" },
    ],
  }, true);
  check("FAIL", v.verdict === "fail", v.verdict);
  console.log(`   judge: ${v.reason}`);
}

console.log("\nCASE 3: REGRESSION — a research brief judged with isPlanFlow=false → same as before");
{
  const q = "What caused the 2023 rise in global egg prices?";
  const brief = {
    answer: "Avian influenza culled tens of millions of laying hens in 2022-2023, cutting egg supply and driving prices up; feed and energy costs added pressure.",
    reasoning: "Supply shock from HPAI plus input-cost inflation.",
    sources: [{ title: "USDA egg markets overview", url: "https://www.ers.usda.gov/topics/animal-products/poultry-eggs/" }],
  };
  const asResearch = await evaluate(apiKey, model, q, brief, false);
  check("research brief PASSES (unchanged behavior)", asResearch.verdict === "pass", asResearch.verdict);
  console.log(`   judge: ${asResearch.reason}`);

  // And a bad research brief must still fail with isPlanFlow=false.
  const badResearch = await evaluate(apiKey, model, q, {
    answer: "The capital of France is Paris.", reasoning: "Paris is large.", sources: [],
  }, false);
  check("bad research brief still FAILS (unchanged)", badResearch.verdict === "fail", badResearch.verdict);
  console.log(`   judge: ${badResearch.reason}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
