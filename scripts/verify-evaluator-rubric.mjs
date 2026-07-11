// verify-evaluator-rubric.mjs — ZERO-MONEY replay of the hardened judge.
// Imports the REAL evaluate() + EVALUATOR_SYSTEM_PROMPT from job-evaluate-background.mjs.
// No Blobs, no chain, no settle — only Anthropic calls. Nothing is persisted.
//
//   node --env-file=.env scripts/verify-evaluator-rubric.mjs
//
// Proves the fix stops the FALSE NEGATIVE without losing the TRUE POSITIVE:
//   • #155217's real brief (correct proposal, real sources) must now PASS
//   • genuinely bad briefs (off-topic sources, non-responsive, empty sources) must FAIL
//   • a brief that declines to recommend must PASS (responsive ≠ actionable)
import { evaluate } from "../netlify/functions/job-evaluate-background.mjs";

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";
if (!apiKey) { console.error("ANTHROPIC_API_KEY missing — use --env-file=.env"); process.exit(3); }

// The REAL brief the judge wrongly refunded.
const live = await fetch("https://app.tikpema.xyz/.netlify/functions/job-deliverable?jobId=155217").then((r) => r.json());
const realBrief = live.brief;
const realQuestion = JSON.parse(live.canonicalReport).question;

const cases = [
  {
    n: "#155217 — the REAL brief the judge wrongly refunded",
    q: realQuestion,
    brief: realBrief,
    want: "pass",
    why: "responsive + real, relevant sources (Arc docs, CCTP repos)",
  },
  {
    n: "plan brief that DECLINES to recommend",
    q: "Should I bridge USDC to Base, and how much?",
    brief: {
      answer: "On current fees the bridge is not worth it for small amounts: the flat forwarder fee is ~0.20 USDC, so anything under ~4 USDC loses over 5% to fees. I do not recommend bridging right now.",
      reasoning: "Fee is flat, not proportional; the economics only work at larger amounts.",
      sources: [{ title: "Circle CCTP fees", url: "https://developers.circle.com/stablecoins/cctp-getting-started" }],
    },
    want: "pass",
    why: "responsive even though it recommends NO action and executes nothing",
  },
  {
    n: "BAD: sources plainly off-topic",
    q: "Bridge 10 USDC from Arc to Base",
    brief: {
      answer: "You can bridge 10 USDC from Arc to Base using CCTP.",
      reasoning: "Burn and mint.",
      sources: [
        { title: "How to bake sourdough bread", url: "https://example.com/sourdough" },
        { title: "2019 Premier League table", url: "https://example.com/football" },
      ],
    },
    want: "fail",
    why: "(b) sources bear no relation to the question",
  },
  {
    n: "BAD: non-responsive (answers a different question)",
    q: "Bridge 10 USDC from Arc to Base",
    brief: {
      answer: "The capital of France is Paris, and it has a population of about 2.1 million.",
      reasoning: "Paris is the largest city in France.",
      sources: [{ title: "Arc docs — CCTP bridging", url: "https://docs.arc.io/integrate/exchanges/cctp-bridging" }],
    },
    want: "fail",
    why: "(a) answers a different question",
  },
  {
    n: "BAD: empty source list",
    q: "Bridge 10 USDC from Arc to Base",
    brief: { answer: "Bridging is supported via CCTP.", reasoning: "It just is.", sources: [] },
    want: "fail",
    why: "(b) no sources at all",
  },
  {
    n: "GOOD: unfamiliar-but-real sources + a provenance label",
    q: "What is the current Arc Testnet gas price?",
    brief: {
      answer: "Arc Testnet gas price is 0.001 gwei as of the latest block.",
      reasoning: "Read directly from the chain.",
      sources: [
        { title: "Arc Testnet gas price: 0.001 gwei", url: "Arc Testnet RPC (QuickNode)" },
        { title: "Arc docs", url: "https://docs.arc.io/some/deep/page-the-model-has-never-seen" },
      ],
    },
    want: "pass",
    why: "must NOT fail for 'cannot verify' — provenance labels + unseen URLs are legitimate",
  },
];

let pass = 0, fail = 0;
console.log("── Hardened judge, replayed (zero money; Anthropic calls only) ──\n");
for (const c of cases) {
  const v = await evaluate(apiKey, model, c.q, c.brief);
  const got = v?.verdict;
  const ok = got === c.want;
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${c.n}`);
  console.log(`   want ${c.want.toUpperCase()} · got ${String(got).toUpperCase()}   (${c.why})`);
  console.log(`   judge: ${v?.reason}\n`);
}
console.log(`${fail === 0 ? "✅ RUBRIC HOLDS" : "❌ RUBRIC FAILURE"} — ${pass}/${cases.length}. False-negative fixed, true-positive retained.`);
process.exit(fail === 0 ? 0 : 1);
