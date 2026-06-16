// predict-resolve-background.mjs — the async resolution-proposal plane.
//
// The "-background" filename suffix tells Netlify to run this function
// asynchronously: the invocation returns 202 immediately and the body runs for
// up to 15 minutes (Pro plan), free of the 26s/60s sync ceiling. There is no
// useful HTTP response — callers poll predict-status.mjs instead — so we
// persist the result to Netlify Blobs under the job id and let the function exit.
//
// It runs the SAME resolution research as the sync predict-resolve-propose.mjs
// (the fixed system prompt: undetermined for open deadlines, NO only after the
// deadline/impossibility, sources required), just without the sync timeout.
//
// READ ONLY: reads the market over the public Arc RPC (via _predict.mjs) and
// asks Claude (with web search) to PROPOSE a resolution with cited sources. It
// never signs or sends — committing is a manual `cast send resolveMarket(...)`
// by the oracle-key holder. Nothing here can resolve a market.
//
// Input (POST body): { marketId, jobId }
// Output: written to Blobs store "predict-jobs" under key `jobId` (same store
// and { status, result } shape predict-status.mjs already reads).

import { connectLambda, getStore } from "@netlify/blobs";
import { ARC, CONTRACTS, parseBody } from "./_arc.mjs";
import { publicClient, readMarket } from "./_predict.mjs";

const SYSTEM_PROMPT = `Research what actually happened for this market question. Determine if the YES condition has occurred. Respond ONLY JSON: { outcome: 'yes'|'no'|'undetermined', confidence: <0..1>, reasoning: <2-4 sentences>, sources: [<url>, ...] }

Use web search to find primary, authoritative evidence of the real-world outcome. Prefer the market's stated resolution source. You MUST populate "sources" with the actual URLs you used as evidence — never leave it empty. confidence is a DECIMAL between 0 and 1 (e.g. 0.85, never 85).

Deciding the outcome — apply these rules strictly:
- "yes": ONLY when the YES condition has verifiably occurred according to your evidence.
- "no": ONLY when the deadline/resolution window has already passed without the event happening, OR the event has become impossible (it can no longer occur even with time remaining).
- "undetermined": for a deadline-based question (e.g. "will X happen by end of 2026"), if the deadline is still in the FUTURE and the condition has not yet been met and has not become impossible, the outcome MUST be "undetermined". Do NOT answer "no" merely because the event has not happened yet while time remains. Also use "undetermined" when evidence is insufficient or conflicting.

Compare the question's deadline against the current real-world date you find via search. An unmet-but-still-possible condition before its deadline is "undetermined", never "no".`;

// Current Anthropic web search server tool (GA — no beta header).
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 3 };

// Anthropic runs its own server-side search loop; on hitting the built-in cap it
// returns stop_reason "pause_turn" with the work so far. We resume by re-sending
// the conversation. Cap the re-sends so a runaway search can't bill unbounded.
const MAX_CONTINUATIONS = 3;

// Pull the JSON object out of the model's final text, tolerating stray prose or
// ```json fences by falling back to the first {...last } span.
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
    body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM_PROMPT, tools: [WEB_SEARCH_TOOL], messages }),
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

// Mirrors the result body of the sync predict-resolve-propose.mjs handler so the
// frontend renders an async or sync proposal identically.
async function proposeResolution(marketId) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
  const model = process.env.PREDICT_MODEL || "claude-opus-4-8";

  const snapshot = await readMarket(publicClient(), marketId);
  if (!snapshot) return { error: `Market #${marketId} not found` };

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
  let n = 0;
  while (data.stop_reason === "pause_turn" && n < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: data.content });
    data = await callAnthropic(apiKey, model, messages);
    n++;
  }

  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const parsed = extractJson(text);

  // Advisory flag only — we still produce a proposal if the resolution time
  // hasn't been reached, but we surface that the market isn't due yet.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resolutionTimeReached = nowSeconds >= snapshot.resolutionTime;

  const base = {
    contract: CONTRACTS.TIKPEMA_PREDICTION,
    explorer: `${ARC.explorer}/address/${CONTRACTS.TIKPEMA_PREDICTION}`,
    market: snapshot,
    model,
    resolutionTimeReached,
    ...(resolutionTimeReached ? {} : { resolutionWarning: "resolution time not reached" }),
  };

  if (!parsed) {
    const reason =
      data.stop_reason === "pause_turn"
        ? `web search did not finish within ${MAX_CONTINUATIONS} continuations`
        : "Brain returned unparseable output";
    return { ...base, proposal: null, raw: text, warning: reason };
  }

  // Ensure sources are present: prefer the model's, otherwise backfill from the
  // search tool's own result URLs so the human always has something to verify.
  const modelSources = Array.isArray(parsed.sources) ? parsed.sources.filter(Boolean) : [];
  const sources = modelSources.length ? modelSources : collectSearchUrls(data.content);

  return { ...base, proposal: { ...parsed, sources } };
}

export async function handler(event) {
  // Classic Lambda-signature functions (handler(event)) do NOT get the Blobs
  // context auto-wired the way V2 functions do — and background functions in
  // particular run without it — so getStore() would throw "environment has not
  // been configured to use Netlify Blobs". connectLambda(event) hands the Blobs
  // client the request-scoped siteID + token Netlify injects into event.blobs.
  // Must run before any getStore call. Guard on event.blobs: it's absent under
  // local `netlify dev` (which configures Blobs via the global env), and
  // connectLambda throws on undefined.
  if (event.blobs) connectLambda(event);

  const { marketId, jobId } = parseBody(event);
  if (!jobId) {
    // Without a jobId there is nowhere to write the result — nothing to do.
    return { statusCode: 400, body: "jobId required" };
  }

  const store = getStore("predict-jobs");
  try {
    const result = await proposeResolution(marketId);
    await store.setJSON(jobId, { status: "done", result });
  } catch (e) {
    // Surface the failure to the poller rather than leaving the job "pending".
    await store.setJSON(jobId, { status: "done", result: { error: e.message } });
  }
  // 202 is conventional for an accepted-and-finished background invocation.
  return { statusCode: 202 };
}
