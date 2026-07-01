// _research.mjs — shared, reusable research engine.
//
// The web-search + pause-turn-resume loop, extracted from research-background.mjs
// so multiple endpoints can reuse it. The ONE difference from the original is
// that the system prompt is now a parameter rather than a module constant:
// callers pass the prompt that frames the task. Everything else — the resume
// loop, JSON extraction, and the { question, model, decision } return shape —
// is byte-identical to research-background.mjs's original.
//
// READ ONLY: takes a free-form question string and calls Claude with web search.
// No on-chain read, no wallet, no signing, no transaction.

import { exaSearch } from "./_exa.mjs";

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

      // Numbered grounding block the model must rely on exclusively.
      const groundingBlock = exaResults
        .map(
          (r, i) =>
            `[${i + 1}] ${r.title} (${r.url}, ${r.publishedDate})\n${r.text}`
        )
        .join("\n\n");

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
        // Override sources with EXACTLY what Exa retrieved — the brief can't
        // cite anything that wasn't actually fetched.
        decision.sources = exaResults.map((r) => ({ title: r.title, url: r.url }));
        return { question, model, decision, exaUsed: true };
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
