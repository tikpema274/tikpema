import { ARC, CONTRACTS, json, parseBody } from "./_arc.mjs";
import { publicClient, readMarket } from "./_predict.mjs";

// POST /api/predict-resolve-propose { marketId: number }
//
// READ ONLY. No wallet, no transaction, no signing — this never touches the
// secret plane (_circle.mjs) and never imports a key. It reads a
// TikpemaPrediction market over the public Arc RPC, then asks Claude (with web
// search) to research what ACTUALLY happened and PROPOSE a resolution with
// cited sources. The proposal is advisory only: committing it on-chain is a
// separate, manual `cast send resolveMarket(...)` run by the human who holds
// the oracle key (which lives in the contracts repo, not in this app). Nothing
// here can resolve a market.

const SYSTEM_PROMPT = `Research what actually happened for this market question. Determine if the YES condition has occurred. Respond ONLY JSON: { outcome: 'yes'|'no'|'undetermined', confidence: <0..1>, reasoning: <2-4 sentences>, sources: [<url>, ...] }

Use web search to find primary, authoritative evidence of the real-world outcome. Prefer the market's stated resolution source. You MUST populate "sources" with the actual URLs you used as evidence — never leave it empty. Use "undetermined" when the outcome is genuinely not yet decided or evidence is insufficient. confidence is a DECIMAL between 0 and 1 (e.g. 0.85, never 85).`;

// Current Anthropic web search server tool (GA — no beta header), same pattern
// and cap as analyst-server.mjs / predict-analyze.mjs.
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 3 };

// Anthropic runs a server-side loop for web search; if it hits the built-in
// iteration cap it returns stop_reason "pause_turn" with the work so far. We
// resume by re-sending the conversation. Cap the re-sends so a pathological
// search loop can't run — or bill — unbounded.
const MAX_CONTINUATIONS = 3;

// Pull the JSON object out of the model's final text. Tolerates stray prose or
// fences by falling back to the first {...last } span.
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

async function callAnthropic(apiKey, model, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [WEB_SEARCH_TOOL],
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic call failed");
  return data;
}

// Collect any citation/source URLs the web_search tool actually returned, so we
// can backfill "sources" if the model forgets to echo them in its JSON.
function collectSearchUrls(content) {
  const urls = new Set();
  for (const block of content || []) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r?.url) urls.add(r.url);
    }
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) if (c?.url) urls.add(c.url);
    }
  }
  return [...urls];
}

async function propose(snapshot) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
  const model = process.env.PREDICT_MODEL || "claude-opus-4-8";

  const userContent =
    `Market #${snapshot.marketId}\n` +
    `Question: ${snapshot.question}\n` +
    `Category: ${snapshot.category}\n` +
    `Resolution source: ${snapshot.resolutionSource}\n` +
    `Resolution time (unix): ${snapshot.resolutionTime}\n` +
    `Status: ${snapshot.status}\n` +
    `Determine whether the YES condition has occurred, and cite your sources.`;

  const messages = [{ role: "user", content: userContent }];
  let data = await callAnthropic(apiKey, model, messages);

  // Resume across pause_turn boundaries: append the assistant turn verbatim and
  // re-send. Do NOT inject a "continue" message — the API resumes on its own.
  let continuations = 0;
  while (data.stop_reason === "pause_turn" && continuations < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: data.content });
    data = await callAnthropic(apiKey, model, messages);
    continuations++;
  }

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const parsed = extractJson(text);
  if (!parsed) {
    const reason =
      data.stop_reason === "pause_turn"
        ? `web search did not finish within ${MAX_CONTINUATIONS} continuations`
        : "Brain returned unparseable output";
    return { proposal: null, raw: text, error: reason, model };
  }

  // Ensure sources are present: prefer the model's, otherwise backfill from the
  // search tool's own result URLs so the human always has something to verify.
  const modelSources = Array.isArray(parsed.sources) ? parsed.sources.filter(Boolean) : [];
  const sources = modelSources.length ? modelSources : collectSearchUrls(data.content);

  return { proposal: { ...parsed, sources }, model };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { marketId } = parseBody(event);
  if (
    marketId === undefined ||
    marketId === null ||
    !Number.isInteger(Number(marketId)) ||
    Number(marketId) < 0
  ) {
    return json(400, { error: "Provide a non-negative integer 'marketId'" });
  }

  try {
    const client = publicClient();
    const snapshot = await readMarket(client, marketId);
    if (!snapshot) {
      return json(404, { error: `Market #${marketId} not found` });
    }

    // Advisory flag only — we still produce a proposal if the resolution time
    // hasn't been reached, but we surface that the market isn't due yet.
    const nowSeconds = Math.floor(Date.now() / 1000);
    const resolutionTimeReached = nowSeconds >= snapshot.resolutionTime;

    const { proposal, model, raw, error } = await propose(snapshot);

    return json(200, {
      contract: CONTRACTS.TIKPEMA_PREDICTION,
      explorer: `${ARC.explorer}/address/${CONTRACTS.TIKPEMA_PREDICTION}`,
      market: snapshot,
      model,
      resolutionTimeReached,
      ...(resolutionTimeReached
        ? {}
        : { resolutionWarning: "resolution time not reached" }),
      proposal, // null if unparseable
      ...(raw ? { raw } : {}),
      ...(error ? { warning: error } : {}),
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
