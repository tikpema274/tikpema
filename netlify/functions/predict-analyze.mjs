import { ARC, CONTRACTS, json, parseBody } from "./_arc.mjs";
import { publicClient, readMarket } from "./_predict.mjs";

// POST /api/predict-analyze { marketId: number }
//
// READ ONLY. No wallet, no transaction, no signing — this never touches the
// secret plane (_circle.mjs). It reads a TikpemaPrediction market over the
// public Arc RPC, then asks the agent's Claude brain (with web search) for a
// structured YES/NO recommendation. The decision is advisory: placing a bet is
// a separate, explicit call to predict-bet.mjs.

const SYSTEM_PROMPT = `You are Tikpema's prediction-market analyst on Arc Testnet.
You are given one parimutuel market: a yes/no question, its resolution source, the
current YES/NO pool sizes (in USDC), and the market-implied probabilities.

Use web search to gather current, real-world evidence before deciding. Then judge
whether the market's implied probability is MISPRICED versus your own estimate.
In parimutuel betting you profit by backing the side the pool UNDER-prices, which is
not always the likely outcome — a 70%-likely YES priced by the pool at 90% is a NO value bet.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "side": "yes" | "no",
  "confidence": number,            // DECIMAL 0..1 (e.g. 0.62, NEVER 62). Your calibrated probability the CHOSEN side resolves true.
  "edge": number,                  // your YES probability minus the pool's implied YES probability, decimal -1..1
  "reasoning": "2-4 sentences citing the key evidence and the mispricing",
  "suggestedAmountUsdc": number    // stake in USDC. MUST be 0 if no clear edge. Otherwise scale to the edge and pool: never exceed 20% of the current total pool size, and never exceed 10 USDC. Use 0 when the market looks efficient.
}
Hard rules: confidence is a decimal between 0 and 1. suggestedAmountUsdc is at most min(10, 20% of total pool). If your edge is small or evidence is thin, set suggestedAmountUsdc to 0.`;

// Current Anthropic web search server tool (GA — no beta header). Dynamic
// filtering is built into this version and activates automatically.
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 3 };

// Anthropic runs a server-side loop for web search; if it hits the built-in
// 10-iteration cap it returns stop_reason "pause_turn" with the work so far.
// We resume by re-sending the conversation (see analyze()). Cap the re-sends so
// a pathological search loop can't run — or bill — unbounded.
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

async function analyze(snapshot) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
  const model = process.env.PREDICT_MODEL || "claude-opus-4-8";

  const userContent =
    `Market #${snapshot.marketId}\n` +
    `Question: ${snapshot.question}\n` +
    `Category: ${snapshot.category}\n` +
    `Resolution source: ${snapshot.resolutionSource}\n` +
    `Betting deadline (unix): ${snapshot.bettingDeadline}\n` +
    `Status: ${snapshot.status}\n` +
    `Pools: YES ${snapshot.pools.yesUsdc} USDC / NO ${snapshot.pools.noUsdc} USDC ` +
    `(total ${snapshot.pools.totalUsdc} USDC)\n` +
    `Market-implied probability: YES ${snapshot.probabilities.yesPct}% / ` +
    `NO ${snapshot.probabilities.noPct}%`;

  const messages = [{ role: "user", content: userContent }];
  let data = await callAnthropic(apiKey, model, messages);

  // Resume across pause_turn boundaries: append the assistant turn verbatim and
  // re-send. Do NOT inject a "continue" message — the API detects the trailing
  // server_tool_use block and resumes on its own. Bail after MAX_CONTINUATIONS.
  let continuations = 0;
  while (data.stop_reason === "pause_turn" && continuations < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: data.content });
    data = await callAnthropic(apiKey, model, messages);
    continuations++;
  }

  // The response interleaves server_tool_use / web_search_tool_result blocks
  // with text; the final decision is in the text blocks.
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const decision = extractJson(text);
  if (!decision) {
    const reason =
      data.stop_reason === "pause_turn"
        ? `web search did not finish within ${MAX_CONTINUATIONS} continuations`
        : "Brain returned unparseable output";
    return { decision: null, raw: text, error: reason };
  }
  return { decision, model };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { marketId } = parseBody(event);
  if (marketId === undefined || marketId === null || !Number.isInteger(Number(marketId)) || Number(marketId) < 0) {
    return json(400, { error: "Provide a non-negative integer 'marketId'" });
  }

  try {
    const client = publicClient();
    const snapshot = await readMarket(client, marketId);
    if (!snapshot) {
      return json(404, { error: `Market #${marketId} not found` });
    }

    const { decision, model, raw, error } = await analyze(snapshot);

    return json(200, {
      contract: CONTRACTS.TIKPEMA_PREDICTION,
      explorer: `${ARC.explorer}/address/${CONTRACTS.TIKPEMA_PREDICTION}`,
      market: snapshot,
      model,
      decision,        // null if unparseable
      ...(raw ? { raw } : {}),
      ...(error ? { warning: error } : {}),
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
