// predict-analyze-background.mjs — the async analyst plane.
//
// The "-background" filename suffix tells Netlify to run this function
// asynchronously: the invocation returns 202 immediately and the body runs for
// up to 15 minutes (Pro plan), free of the 26s/60s sync ceiling that forced the
// standalone analyst-server.mjs in the first place. There is no useful HTTP
// response — callers poll predict-status.mjs instead — so we persist the result
// to Netlify Blobs under the job id and let the function exit.
//
// READ ONLY on-chain: reads the market over the public Arc RPC (via _predict.mjs)
// and calls the agent's Claude brain with web search. No wallet, no signing, no
// transaction — placing a bet stays an explicit, separate call to predict-bet.mjs.
//
// Input (POST body): { marketId, jobId }
// Output: written to Blobs store "predict-jobs" under key `jobId`.

import { connectLambda, getStore } from "@netlify/blobs";
import { parseBody, dateAnchor } from "./_arc.mjs";
import { publicClient, readMarket } from "./_predict.mjs";

const SYSTEM_PROMPT = `You are Tikpema's parimutuel prediction-market analyst on Arc Testnet.
Use web search for real evidence, judge whether the pool MISPRICES the outcome
(back the underpriced side, not just the likely one), then respond with ONLY JSON:
{ "side": "yes"|"no", "confidence": <decimal 0..1>, "edge": <decimal -1..1>,
  "reasoning": <2-4 sentences>, "suggestedAmountUsdc": <stake, <= min(10, 20% of total pool), 0 if no edge> }`;

// Current Anthropic web search server tool (GA — no beta header).
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 3 };

// Anthropic runs its own server-side search loop; on hitting the built-in cap it
// returns stop_reason "pause_turn" with the work so far. We resume by re-sending
// the conversation. Cap the re-sends so a runaway search can't bill unbounded.
const MAX_CONTINUATIONS = 3;

// Pull the JSON decision out of the model's final text, tolerating stray prose
// or ```json fences by falling back to the first {...last } span.
function extractJson(text) {
  const c = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(c); } catch {}
  const s = c.indexOf("{"), e = c.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(c.slice(s, e + 1)); } catch {} }
  return null;
}

async function callAnthropic(apiKey, model, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1024, system: `${SYSTEM_PROMPT}\n\n${dateAnchor()}`, tools: [WEB_SEARCH_TOOL], messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic call failed");
  return data;
}

async function analyze(marketId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
  const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";

  const snapshot = await readMarket(publicClient(), marketId);
  if (!snapshot) return { error: `Market #${marketId} not found` };

  const user =
    `Market #${snapshot.marketId}\nQuestion: ${snapshot.question}\n` +
    `Category: ${snapshot.category}\nResolution source: ${snapshot.resolutionSource}\n` +
    `Status: ${snapshot.status}\nPools: YES ${snapshot.pools.yesUsdc} / NO ${snapshot.pools.noUsdc} ` +
    `(total ${snapshot.pools.totalUsdc} USDC)\n` +
    `Market-implied: YES ${snapshot.probabilities.yesPct}% / NO ${snapshot.probabilities.noPct}%`;

  const messages = [{ role: "user", content: user }];
  let data = await callAnthropic(apiKey, model, messages);

  // Resume across pause_turn boundaries: append the assistant turn verbatim and
  // re-send. Do NOT inject a "continue" message — the API detects the trailing
  // server_tool_use block and resumes on its own. Bail after MAX_CONTINUATIONS.
  let n = 0;
  while (data.stop_reason === "pause_turn" && n < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: data.content });
    data = await callAnthropic(apiKey, model, messages);
    n++;
  }

  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const decision = extractJson(text);
  return decision
    ? { market: snapshot, model, decision }
    : { market: snapshot, model, decision: null, raw: text, warning: "unparseable or search incomplete" };
}

export async function handler(event) {
  // Classic Lambda-signature functions (handler(event)) do NOT get the Blobs
  // context auto-wired into the global env the way V2 functions do — and
  // background functions in particular run without it — so getStore() would
  // throw "environment has not been configured to use Netlify Blobs". Feeding
  // connectLambda the event hands the Blobs client the request-scoped siteID +
  // token Netlify injects into event.blobs. Must run before any getStore call.
  // Guard on event.blobs: it is absent under local `netlify dev` (which already
  // configures Blobs via the global env), and connectLambda throws on undefined.
  if (event.blobs) connectLambda(event);

  // Background functions are invoked asynchronously; the only meaningful work is
  // to compute the result and stash it in Blobs. There is no HTTP consumer.
  const { marketId, jobId } = parseBody(event);
  if (!jobId) {
    // Without a jobId there is nowhere to write the result — nothing to do.
    return { statusCode: 400, body: "jobId required" };
  }

  const store = getStore("predict-jobs");
  try {
    const result = await analyze(marketId);
    await store.setJSON(jobId, { status: "done", result });
  } catch (e) {
    // Surface the failure to the poller rather than leaving the job "pending"
    // forever.
    await store.setJSON(jobId, { status: "done", result: { error: e.message } });
  }
  // 202 is conventional for an accepted-and-finished background invocation.
  return { statusCode: 202 };
}
