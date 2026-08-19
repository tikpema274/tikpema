// job-quote.mjs — price a research task before it runs.
//
// Given a research question, ask Claude to assess its research complexity and
// return a suggested USDC budget. A slim, web-search-free call: a single
// synchronous Anthropic call with a small token cap, no tools, returning a
// clamped budget in [0.20, 0.60] USDC.
//
// Input (POST body): { question }
// Output: { budgetUsdc, reasoning }

import { parseBody, json, dateAnchor } from "./_arc.mjs";

// ═══ ⭐ THE BAND — ONE DEFINITION, AND THE PROMPT IS DERIVED FROM IT ═══════════════════════════
// 🚨 The range used to exist TWICE: written into the prompt string AND hardcoded in the clamp. Two
// copies of the same number, and the failure mode is silent — a prompt saying 0.20–0.60 against a
// clamp of 0.20–0.40 wastes every model choice above the ceiling, producing quotes that are
// systematically clamped without anything saying so. Interpolated now, so they cannot disagree.
// ⚠️ Lowering MAX narrows the agent's own data allowance too: allowance = price × 0.30, per-buy cap
// = allowance × 0.50. At 0.40 that is 0.12 / 0.06. See PROGRESS on why that currently buys nothing.
const BUDGET_MIN_USDC = 0.20;
const BUDGET_MAX_USDC = 0.40;
const BUDGET_DEFAULT_USDC = 0.30; // used only when the model returns an unparseable number

const SYSTEM_PROMPT = `You are pricing a research task for an AI research agent.
The agent does FACTUAL and ANALYTICAL research backed by real sources — NOT
personal advice, recommendations, or subjective opinions.

First, CLASSIFY the question:
- ACCEPT it if it has a knowable, sourceable answer — either a factual lookup
  ("who won X", "when is Z", "what is the population of Y") OR an analytical
  synthesis ("what caused Y", "explain the causes of W", "what are the causes of
  inflation", "compare A and B"). Complex, analytical, multi-source synthesis
  questions are ACCEPTED — depth is not a reason to decline.
- DECLINE it ONLY if it asks for personal advice, a recommendation, a subjective
  opinion, or what someone should do ("what should I invest in", "should I buy X",
  "is X a good idea for me", "what's the best phone for me"). These have no
  sourceable factual answer — they're opinion, not research.

Then assess research complexity for ACCEPTED questions: how many sources, how
much synthesis, and how much effort it will take to answer well.

Return ONLY a JSON object, with no markdown, no fences, and no preamble:
- if accepted: {"declined": false, "budgetUsdc": <number between ${BUDGET_MIN_USDC.toFixed(2)} and ${BUDGET_MAX_USDC.toFixed(2)}>, "reasoning": "<one short sentence>"}
- if declined: {"declined": true, "reason": "<one sentence: this is an advice/opinion question, not factual research>"}

You may use up to 2 decimal places for budgetUsdc (e.g. 0.25, 0.40) — do not restrict yourself to whole numbers.`;

async function callAnthropic(apiKey, model, messages) {
  const system = `${SYSTEM_PROMPT}\n\n${dateAnchor()}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 256, system, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic call failed");
  return data;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { question } = parseBody(event);
  if (!question || !String(question).trim()) {
    return json(400, { error: "question required" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(400, { error: "Missing ANTHROPIC_API_KEY (server env)" });
  const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";

  const data = await callAnthropic(apiKey, model, [{ role: "user", content: String(question) }]);

  // The model is instructed to emit bare JSON, but tolerate stray ```json fences.
  const text = (data.content?.[0]?.text || "").replace(/```json|```/g, "").trim();
  let quote;
  try {
    quote = JSON.parse(text);
  } catch {
    // Never throw on a bad model response — fall back to a sane default budget.
    quote = { budgetUsdc: 0.30, reasoning: "default quote" };
  }

  // Advice/opinion question — decline rather than price it. The agent only does
  // factual/analytical research with sources, not personal recommendations.
  if (quote.declined === true) {
    return json(200, {
      declined: true,
      reason: quote.reason || "This is an advice/opinion question, not factual research.",
    });
  }

  // Accepted: validate + clamp to the contracted [0.20, 0.60] range.
  let budgetUsdc = Number(quote.budgetUsdc);
  if (!Number.isFinite(budgetUsdc)) budgetUsdc = 0.30;
  budgetUsdc = Math.min(BUDGET_MAX_USDC, Math.max(BUDGET_MIN_USDC, budgetUsdc));
  // Round to 2 decimals so the on-chain base-unit conversion (x * 1e6) is clean.
  budgetUsdc = Math.round(budgetUsdc * 100) / 100;

  return json(200, { declined: false, budgetUsdc, reasoning: quote.reasoning || "default quote" });
}
