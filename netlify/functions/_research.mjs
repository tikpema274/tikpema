// _research.mjs — shared, reusable research engine.
//
// The web-search + pause-turn-resume loop, factored out so multiple endpoints
// can reuse it. The system prompt is a parameter rather than a module constant:
// callers pass the prompt that frames the task. Provides the resume loop, JSON
// extraction, and the { question, model, decision } return shape.
//
// SPENDING. The web-search path is read-only (Claude + web search, no funds
// move). The Exa path, however, can autonomously PURCHASE data mid-research
// (maybeBuyData → payX402): an on-chain x402 USDC spend, gated by the per-job
// budget in _budget.mjs. So this module can move money — under budget control —
// not just read.

import { exaSearch } from "./_exa.mjs";
import { canSpend, recordSpend, recordBlocked } from "./_budget.mjs";
import { payX402 } from "./_x402.mjs";

// Current Anthropic web search server tool (GA — no beta header).
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 3 };

// Anthropic runs its own server-side search loop; on hitting the built-in cap it
// returns stop_reason "pause_turn" with the work so far. We resume by re-sending
// the conversation. Cap the re-sends so a runaway search can't bill unbounded.
const MAX_CONTINUATIONS = 3;

// Pull the JSON decision out of the model's final text, tolerating stray prose
// or ```json fences by falling back to the first {...last } span.
export function extractJson(text) {
  const c = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(c); } catch {}
  const s = c.indexOf("{"), e = c.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(c.slice(s, e + 1)); } catch {} }
  return null;
}

export async function callAnthropic(apiKey, model, messages, systemPrompt, tools = [WEB_SEARCH_TOOL]) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt, tools, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic call failed");
  return data;
}

// ── Autonomous mid-research purchase loop (Phase 2a, Step 2a-3) ───────────────
// After the initial Exa retrieval, the agent decides whether ONE paid dataset
// would materially improve the brief. If so, the budget spine gates it; if
// allowed, we buy it from our own testnet stand-in seller via x402 and fold the
// facts into the grounding. Testnet only, our own seller. Graceful degradation:
// a decline, a budget block, or ANY purchase failure degrades to Exa-only
// grounding — a purchase problem must never fail the research job.

// Where the recorded spend is attributed in the audit trail.
const DATA_SELLER_SOURCE = "x402-quote (testnet stand-in)";

// Fixed stand-in price used for the pre-purchase budget check. Matches the
// seller's price (~0.001 USDC); overridable via DATA_PURCHASE_USDC.
function dataPurchaseUsdc() {
  const n = Number(process.env.DATA_PURCHASE_USDC);
  return Number.isFinite(n) && n > 0 ? n : 0.001;
}

// The purchase-decision system prompt: a binary buy/skip over the ONE available
// stand-in dataset (no seller menu). The model sees the question + the sources
// already retrieved, and buys only if they're insufficient.
const DATA_DECISION_SYSTEM = `You are a research analyst deciding whether to purchase ONE additional paid dataset to improve a client brief. You are given the research question and the sources already retrieved. Exactly one paid dataset is available at a fixed low price: a small, curated, authoritative fact set relevant to the question. Decide whether the already-retrieved sources are INSUFFICIENT and the paid dataset would MATERIALLY improve the brief's accuracy or citations. Respond with ONLY JSON: {"buy": <boolean>, "justification": "<one sentence>"} — no markdown, no fences, no preamble.`;

async function decidePurchase(apiKey, model, question, groundingBlock) {
  const user =
    `Research question:\n${question}\n\n` +
    `Sources already retrieved:\n${groundingBlock || "(none)"}\n\n` +
    `Should we buy the one available paid dataset? Respond with ONLY the JSON.`;
  const data = await callAnthropic(apiKey, model, [{ role: "user", content: user }], DATA_DECISION_SYSTEM, []);
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return extractJson(text);
}

// Run the decision → gate → buy sequence and return the purchased facts (an
// array of { claim, source }), or [] if we didn't buy for any reason. Never
// throws: every failure path logs and returns [] so research proceeds Exa-only.
// `store` is the optional injectable budget store (undefined → Netlify Blobs).
async function maybeBuyData({ apiKey, model, question, groundingBlock, jobId, jobPrice, store, forceDecision }) {
  try {
    // 1. Decision call — buy or not? `forceDecision` is a TEST-ONLY seam that
    // injects the { buy, justification } verdict so the buy-branch mechanics are
    // deterministically provable; production never sets it, so the genuine
    // Claude decision call runs.
    const decision = forceDecision ?? (await decidePurchase(apiKey, model, question, groundingBlock));
    const justification = decision?.justification || "(no justification)";
    if (!decision?.buy) {
      console.log(`[research] purchase decision: SKIP — ${justification}`);
      return [];
    }
    const amountUsdc = dataPurchaseUsdc();
    console.log(`[research] purchase decision: BUY ($${amountUsdc}) — ${justification}`);

    // 2. Budget gate.
    const gate = await canSpend({ jobId, jobPriceUsdc: jobPrice, amountUsdc, store });
    if (!gate.allowed) {
      console.log(`[research] budget BLOCKED: ${gate.reason}`);
      await recordBlocked({ jobId, amountUsdc, source: DATA_SELLER_SOURCE, reason: gate.reason, store });
      return [];
    }
    console.log(`[research] budget ALLOWED — purchasing…`);

    // 3. Purchase (graceful degradation — do NOT record spend until confirmed).
    const res = await payX402({ sellerUrl: process.env.DATA_SELLER_URL, jobContext: { jobId, jobPrice } });
    const facts = res?.body?.sellerBody?.dataset?.facts;
    if (!res?.body?.executed || !Array.isArray(facts) || facts.length === 0) {
      console.warn(
        `[research] purchase yielded no data (NO spend recorded): status=${res?.status} executed=${res?.body?.executed}`
      );
      return [];
    }

    // 4. Record spend ONLY on confirmed success. Record the actual price paid.
    const paidUsdc = res.body.priceUsdc ?? amountUsdc;
    await recordSpend({
      jobId,
      jobPriceUsdc: jobPrice,
      amountUsdc: paidUsdc,
      source: DATA_SELLER_SOURCE,
      justification,
      store,
    });
    console.log(`[research] purchased ${facts.length} facts for $${paidUsdc} — spend recorded`);
    return facts;
  } catch (e) {
    // ANY error degrades to Exa-only. No spend is recorded on the throw path.
    console.warn(`[research] purchase loop error (degrading to Exa-only): ${e.message}`);
    return [];
  }
}

export async function research(
  question,
  systemPrompt,
  userInstruction = "Research this question with web search and respond in the exact JSON format specified.",
  opts = {}
) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
  const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";

  // Phase 2a plumbing (Step 2a-2): the caller may thread job context so a LATER
  // step can compute the per-job data allowance and gate autonomous purchases.
  // We only SURFACE it here — no budget calls, no spending, no decision logic yet.
  // Log so we can confirm the values arrive with the right jobId/jobPrice.
  const { jobId, jobPrice } = opts;
  if (jobId != null || jobPrice != null) {
    console.log(`[research] job context: jobId=${jobId} jobPrice=${jobPrice} USDC`);
  }

  // Opt-in Exa path: ground the brief on real retrieved sources instead of the
  // model's own web search. One Exa call, then a SINGLE Anthropic call with NO
  // web-search tool (so there's no pause_turn loop). On any Exa failure we do
  // NOT fall through to the web-search path below: that path trusts model-written
  // URLs and is structurally fabrication-prone, so the useExa path stays Exa-only
  // — real retrieved sources, or an honest null-decision result that refunds.
  if (opts.useExa === true && process.env.EXA_API_KEY) {
    try {
      const exaResults = await exaSearch(question);

      // Numbered grounding entries the model must rely on exclusively.
      const exaEntries = exaResults.map(
        (r, i) => `[${i + 1}] ${r.title} (${r.url}, ${r.publishedDate})\n${r.text}`
      );

      // ── Autonomous mid-research purchase (Phase 2a) ────────────────────────
      // Only when job context is present (jobId + jobPrice), so the budget gate
      // can compute the per-job allowance. maybeBuyData never throws: on decline,
      // block, or failure it returns [] and we synthesize from Exa alone.
      let purchasedFacts = [];
      if (jobId != null && jobPrice != null) {
        purchasedFacts = await maybeBuyData({
          apiKey,
          model,
          question,
          groundingBlock: exaEntries.join("\n\n"),
          jobId,
          jobPrice,
          store: opts.budgetStore,
          forceDecision: opts.forceDecision, // test-only; undefined in production
        });
      }

      // Merge: fold purchased {claim, source} facts into the grounding block,
      // continuing the numbering after the Exa entries (claim→text, source→url).
      const purchasedEntries = purchasedFacts.map(
        (f, i) => `[${exaResults.length + i + 1}] Purchased data (${f.source})\n${f.claim}`
      );
      const groundingBlock = [...exaEntries, ...purchasedEntries].join("\n\n");

      const exaUser =
        question +
        "\n\nBase your brief ONLY on these sources; do not use any other knowledge or invent URLs:\n" +
        groundingBlock +
        "\n\n" +
        userInstruction;

      const data = await callAnthropic(
        apiKey,
        model,
        [{ role: "user", content: exaUser }],
        systemPrompt,
        [] // no web search — single call, no pause_turn resume needed
      );

      const text = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      const decision = extractJson(text);

      if (decision) {
        // Override sources with EXACTLY what was actually fetched — Exa results
        // PLUS any purchased facts. Merging the purchased sources here (not just
        // the grounding block) is what lets the brief cite them; without it the
        // Exa-only override would silently drop them.
        decision.sources = [
          ...exaResults.map((r) => ({ title: r.title, url: r.url })),
          ...purchasedFacts.map((f) => ({ title: f.claim, url: f.source })),
        ];
        return { question, model, decision, exaUsed: true, purchasedFacts: purchasedFacts.length };
      }
      return { question, model, decision: null, raw: text, warning: "unparseable (exa path)", exaUsed: true };
    } catch (e) {
      console.warn(`[research] Exa retrieval failed (useExa path), refusing web-search fallback: ${e.message}`);
      return { question, model, decision: null, warning: "no verifiable sources found via retrieval", exaUsed: true };
    }
  }

  const user =
    `${question}\n` +
    userInstruction;

  const messages = [{ role: "user", content: user }];
  let data = await callAnthropic(apiKey, model, messages, systemPrompt);

  // Resume across pause_turn boundaries: append the assistant turn verbatim and
  // re-send. Do NOT inject a "continue" message — the API detects the trailing
  // server_tool_use block and resumes on its own. Bail after MAX_CONTINUATIONS.
  let n = 0;
  while (data.stop_reason === "pause_turn" && n < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: data.content });
    data = await callAnthropic(apiKey, model, messages, systemPrompt);
    n++;
  }

  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const decision = extractJson(text);
  return decision
    ? { question, model, decision }
    : { question, model, decision: null, raw: text, warning: "unparseable or search incomplete" };
}
