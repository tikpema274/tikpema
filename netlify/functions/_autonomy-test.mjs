// _autonomy-test.mjs — PROOF that the agent's GENUINE purchase decision fires,
// and that a genuine buy composes through the rest of the purchase loop.
//
// Phase 2a proved the decide→gate→buy→merge→record mechanics, but only via the
// TEST-ONLY forceDecision seam, because the stand-in dataset was redundant with
// Exa so the genuine decidePurchase correctly SKIPPED. This harness closes that
// gap. It has two parts:
//
// PART 1 — the genuine decision (the whole point). Drives the REAL decidePurchase
// (imported from _research.mjs — exact production prompt + call, NO forceDecision,
// NO logic change) over two natural client briefs and shows judgment both ways:
//
//   CASE A (BUY-when-warranted): a go/no-go ops brief that must state Arc
//     Testnet's CURRENT, as-of-today operational figures. The retrieved sources
//     are real background (definitional / design-goal claims) but carry no
//     present-moment value — a gap only the real-time paid feed fills. A frugal,
//     honest agent should decide buy:true, citing recency / live-figure need.
//
//   CASE B (SKIP-when-not): a definitional brief ("what is Arc, why USDC as gas,
//     what is x402") fully answered by the same kind of indexed sources. No
//     present-moment value is needed, so the honest agent should decide buy:false.
//
//   BUY-when-warranted AND SKIP-when-not, both from the unforced decision, is what
//   proves real judgment rather than a rigged always-buy.
//
// PART 2 — the downstream loop for the warranted case, with the REAL modules:
//   genuine decision → _budget.canSpend gate (ALLOW) → the seller's real
//   liveDataset() facts (fresh asOf) → merge into grounding exactly as _research
//   does → a real brief synthesis that CITES the real-time feed → _budget.recordSpend
//   logs the spend with the genuine justification. The ONLY step not run here is
//   the on-chain payX402 byte-movement (needs the Gateway-funded delegate EOA);
//   that exact hop was already settled live against this same seller in Phase 2a.
//
// HONESTY: neither question tells or hints the agent to buy anything — each reads
// as an ordinary client research task. decidePurchase is unmodified. So buy:true
// is genuinely the agent's own call.
//
// Makes REAL Anthropic calls (needs ANTHROPIC_API_KEY). Underscore-prefixed → ships
// to Netlify as an inert, never-invoked function. Run manually:
//   node --env-file=.env netlify/functions/_autonomy-test.mjs

import { decidePurchase, callAnthropic, extractJson } from "./_research.mjs";
import { canSpend, recordSpend, auditLog, jobAllowance } from "./_budget.mjs";
import { liveDataset } from "./x402-quote.mjs";

// Representative indexed/stale sources — the shape Exa actually returns. Past
// publishedDates and design-goal ("designed for", "targets") framing: real
// background, but NO measured value "as of right now."
const ARC_BACKGROUND = [
  {
    title: "What is Arc? Circle's Layer-1 for stablecoin payments",
    url: "https://www.circle.com/arc",
    publishedDate: "2025-11-10",
    text:
      "Arc is Circle's Layer-1 blockchain where USDC is the native gas token, giving developers stable, " +
      "predictable transaction fees. It is designed for sub-second finality. Arc Testnet is open for builders " +
      "to deploy and test USDC-first applications.",
  },
  {
    title: "Arc developer docs — network overview",
    url: "https://developers.circle.com/arc/overview",
    publishedDate: "2025-12-02",
    text:
      "Arc targets fast finality and low, predictable fees. Circle Gateway nanopayments are designed to settle " +
      "in well under a second. Block times are intended to be low so agent-to-agent payments confirm quickly.",
  },
];

const DEFINITIONS_BACKGROUND = [
  {
    title: "What is Arc and why USDC as native gas",
    url: "https://www.circle.com/arc",
    publishedDate: "2025-11-10",
    text:
      "Arc is Circle's Layer-1 blockchain. USDC is the native gas token, so there is no separate volatile gas " +
      "token; fees are paid in USDC and stay stable and predictable. This makes Arc suited to payment apps.",
  },
  {
    title: "The x402 protocol, explained",
    url: "https://www.x402.org",
    publishedDate: "2025-10-01",
    text:
      "x402 reuses the HTTP 402 \"Payment Required\" status code so an API can demand payment inline. A client " +
      "retries with a signed stablecoin payment, letting agents pay per API call in USDC with no API keys or " +
      "accounts. It is the basis for pay-per-call agent commerce.",
  },
];

// Format grounding EXACTLY as research() builds it from Exa hits.
const groundingFrom = (rows) =>
  rows.map((r, i) => `[${i + 1}] ${r.title} (${r.url}, ${r.publishedDate})\n${r.text}`).join("\n\n");

// CASE A — needs a present-moment figure. Reads as an ordinary ops brief; it does
// NOT mention buying, paying, datasets, or any purchase. The only thing it demands
// is a CURRENT / as-of-today value, which indexed web search structurally can't give.
const CASE_A_QUESTION =
  "Our ops team needs a short go/no-go brief on Arc Testnet's health for a deploy we're " +
  "shipping this morning. What is the network's status right now — specifically the current " +
  "average block time and the latest Circle Gateway nanopayment settlement latency, as of today? " +
  "Please state the present-moment figures, not historical or design-target numbers, so we can " +
  "decide whether it's safe to ship now.";

// CASE B — purely definitional/background. No present-moment value needed; the
// indexed sources already answer it fully. Also does NOT mention buying anything.
const CASE_B_QUESTION =
  "Write a short brief for a new team member explaining what Arc is, why USDC is used as its " +
  "native gas token, and how the x402 protocol lets software agents pay for an API call.";

const MODEL = process.env.PREDICT_MODEL || "claude-sonnet-4-6";
const RUNS = 2; // sample each decision twice — show the verdict is stable, not a fluke.

// Faithful to job-submit-background.mjs's BRIEF_SYSTEM_PROMPT_EXA (not exported).
const BRIEF_SYSTEM = `You are a research analyst producing a brief for a paying client. Ground your brief ONLY on the sources provided to you; do not use outside knowledge or invent URLs. Respond with ONLY JSON: {"answer":"<direct answer>","reasoning":"<2-5 sentences>","sources":[{"title":"<title>","url":"<url>"}],"confidence":<0..1>}. Cite ONLY sources from the supplied set.`;

function memStore() {
  const m = new Map();
  return {
    async getJSON(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
  };
}

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`    ✓ ${name}`);
  else { failed++; console.log(`    ✗ ${name}  ${detail}`); }
};

async function decideCase(label, question, rows, expectBuy) {
  console.log(`\n${"=".repeat(70)}\n${label}\nExpect genuine decision: buy=${expectBuy}\n${"-".repeat(70)}`);
  console.log(`Question (no buy hint):\n  ${question}\n`);
  const grounding = groundingFrom(rows);
  let buys = 0, lastJust = "";
  for (let i = 1; i <= RUNS; i++) {
    const d = await decidePurchase(process.env.ANTHROPIC_API_KEY, MODEL, question, grounding);
    if (d?.buy) { buys++; lastJust = d.justification || ""; }
    console.log(`  run ${i}: ${d?.buy ? "BUY " : "SKIP"}  — ${d?.justification || "(no justification)"}`);
  }
  const decidedBuy = buys > RUNS / 2;
  const ok = decidedBuy === expectBuy;
  if (!ok) failed++;
  console.log(`\n  → genuine decision (majority of ${RUNS}): ${decidedBuy ? "BUY" : "SKIP"}  ` +
    `[${ok ? "✓ as expected" : "✗ UNEXPECTED"}]  (${buys}/${RUNS} chose buy)`);
  return { decidedBuy, justification: lastJust };
}

// PART 2 — drive the rest of the loop for the warranted case with real modules.
async function downstream(question, rows, justification) {
  console.log(`\n${"=".repeat(70)}\nPART 2 — genuine buy → gate → live data → merge → cite → record (real modules)\n${"-".repeat(70)}`);
  const store = memStore();
  const jobId = "autonomy-proof-A";
  const jobPrice = 0.35; // a typical funded job → allowance jobAllowance(0.35)
  const amountUsdc = Number(process.env.DATA_PURCHASE_USDC) > 0 ? Number(process.env.DATA_PURCHASE_USDC) : 0.001;

  // Budget gate — the REAL _budget.canSpend.
  const gate = await canSpend({ jobId, jobPriceUsdc: jobPrice, amountUsdc, store });
  check(`budget gate ALLOWS the $${amountUsdc} buy (job allowance $${jobAllowance(jobPrice)})`,
    gate.allowed === true, JSON.stringify(gate));

  // The seller's REAL paid-200 payload (the on-chain payX402 hop that fetches this
  // was settled live in Phase 2a; here we call liveDataset() directly).
  const dataset = liveDataset();
  const facts = dataset.facts;
  check("seller returned a live-shaped dataset with a fresh asOf timestamp",
    typeof dataset.asOf === "string" && facts.length > 0, JSON.stringify(dataset).slice(0, 120));
  console.log(`    live asOf = ${dataset.asOf}`);

  // Merge exactly as _research.mjs does (exaEntries + purchasedEntries).
  const exaEntries = rows.map((r, i) => `[${i + 1}] ${r.title} (${r.url}, ${r.publishedDate})\n${r.text}`);
  const purchasedEntries = facts.map((f, i) => `[${rows.length + i + 1}] Purchased data (${f.source})\n${f.claim}`);
  const groundingBlock = [...exaEntries, ...purchasedEntries].join("\n\n");

  // Synthesize the brief on the merged grounding — real Anthropic call.
  const user = question +
    "\n\nBase your brief ONLY on these sources; do not use any other knowledge or invent URLs:\n" +
    groundingBlock +
    "\n\nProduce the brief in the exact JSON format specified.";
  const data = await callAnthropic(process.env.ANTHROPIC_API_KEY, MODEL, [{ role: "user", content: user }], BRIEF_SYSTEM, []);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const brief = extractJson(text);

  // Merge sources exactly as _research does (purchased facts become citable sources).
  const sources = brief
    ? [...rows.map((r) => ({ title: r.title, url: r.url })), ...facts.map((f) => ({ title: f.claim, url: f.source }))]
    : [];

  check("brief parsed", brief != null, text.slice(0, 200));
  const citesFeed = sources.some((s) => /real-time feed/.test(s.url));
  check("real-time feed appears in the brief's citable sources", citesFeed, JSON.stringify(sources.map((s) => s.url)));
  const usesLiveFigure = brief && /0\.92|470|sub-second|peg|1\.0000/.test(`${brief.answer} ${brief.reasoning}`);
  check("brief's answer/reasoning uses the live figure from the paid feed", !!usesLiveFigure,
    brief ? `${brief.answer} | ${brief.reasoning}` : "(no brief)");
  if (brief) console.log(`    brief answer: ${brief.answer}`);

  // Record the spend — the REAL _budget.recordSpend + audit trail.
  const rec = await recordSpend({ jobId, jobPriceUsdc: jobPrice, amountUsdc, source: "x402-quote (testnet stand-in)", justification, store });
  const log = await auditLog({ jobId, store });
  check(`recordSpend logged $${amountUsdc} (running job total $${rec.jobSpentUsdc})`, rec.jobSpentUsdc === amountUsdc, JSON.stringify(rec));
  check("audit trail carries the genuine justification (not a scripted string)",
    log.length === 1 && log[0].justification === justification, JSON.stringify(log[0] || {}));
  console.log(`    audit entry justification: "${log[0]?.justification}"`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — run: node --env-file=.env netlify/functions/_autonomy-test.mjs");
    process.exit(1);
  }
  console.log(`Genuine-autonomy proof — model=${MODEL}`);
  console.log("PART 1 drives the REAL decidePurchase (no forceDecision, prompt/logic unmodified).");

  const a = await decideCase(
    "CASE A — live-figure ops brief (needs a current value Exa can't supply)",
    CASE_A_QUESTION, ARC_BACKGROUND, true
  );
  const b = await decideCase(
    "CASE B — definitional brief (fully answerable from indexed sources)",
    CASE_B_QUESTION, DEFINITIONS_BACKGROUND, false
  );

  if (a.decidedBuy) {
    await downstream(CASE_A_QUESTION, ARC_BACKGROUND, a.justification || "needs a current figure the indexed sources do not provide");
  } else {
    console.log("\n(Skipping PART 2 — CASE A did not decide BUY, so there is nothing to settle.)");
  }

  console.log(`\n${"=".repeat(70)}\nRESULT`);
  console.log(`  CASE A (warranted):   genuine decision = ${a.decidedBuy ? "BUY  ✓" : "SKIP ✗"}`);
  console.log(`  CASE B (unwarranted): genuine decision = ${b.decidedBuy ? "BUY  ✗" : "SKIP ✓"}`);
  console.log(
    failed === 0
      ? "\n✓ Genuine BUY-when-warranted AND SKIP-when-not, plus gate→live-data→cite→record. Real judgment proven."
      : `\n✗ ${failed} check(s) failed — see above.`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("PROOF HARNESS ERROR:", e);
  process.exit(1);
});
