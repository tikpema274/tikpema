// analyst-server.mjs — standalone analyst service. No Netlify, no timeout.
// Run: node --env-file=.env analyst-server.mjs   (listens on :8787)
import { createServer } from "node:http";
import { publicClient, readMarket } from "./netlify/functions/_predict.mjs";

const PORT = process.env.ANALYST_PORT || 8787;
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";

const SYSTEM_PROMPT = `You are Tikpema's parimutuel prediction-market analyst on Arc Testnet.
Use web search for real evidence, judge whether the pool MISPRICES the outcome
(back the underpriced side, not just the likely one), then respond with ONLY JSON:
{ "side": "yes"|"no", "confidence": <decimal 0..1>, "edge": <decimal -1..1>,
  "reasoning": <2-4 sentences>, "suggestedAmountUsdc": <stake, <= min(10, 20% of total pool), 0 if no edge> }`;

const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 3 };
const MAX_CONTINUATIONS = 3;

function extractJson(text) {
  const c = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(c); } catch {}
  const s = c.indexOf("{"), e = c.lastIndexOf("}");
  if (s !== -1 && e > s) { try { return JSON.parse(c.slice(s, e + 1)); } catch {} }
  return null;
}

async function callAnthropic(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1024, system: SYSTEM_PROMPT, tools: [WEB_SEARCH_TOOL], messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic call failed");
  return data;
}

async function analyze(marketId) {
  const snapshot = await readMarket(publicClient(), marketId);
  if (!snapshot) return { error: `Market #${marketId} not found` };

  const user =
    `Market #${snapshot.marketId}\nQuestion: ${snapshot.question}\n` +
    `Category: ${snapshot.category}\nResolution source: ${snapshot.resolutionSource}\n` +
    `Status: ${snapshot.status}\nPools: YES ${snapshot.pools.yesUsdc} / NO ${snapshot.pools.noUsdc} ` +
    `(total ${snapshot.pools.totalUsdc} USDC)\n` +
    `Market-implied: YES ${snapshot.probabilities.yesPct}% / NO ${snapshot.probabilities.noPct}%`;

  const messages = [{ role: "user", content: user }];
  let data = await callAnthropic(messages);
  let n = 0;
  while (data.stop_reason === "pause_turn" && n < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: data.content });
    data = await callAnthropic(messages);
    n++;
  }
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const decision = extractJson(text);
  return decision
    ? { market: snapshot, model, decision }
    : { market: snapshot, model, decision: null, raw: text, warning: "unparseable or search incomplete" };
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  if (req.method === "POST" && req.url === "/analyze") {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const { marketId } = JSON.parse(body || "{}");
        if (marketId === undefined) { res.writeHead(400, {"Content-Type":"application/json"}).end(JSON.stringify({ error: "marketId required" })); return; }
        const result = await analyze(marketId);
        res.writeHead(200, {"Content-Type":"application/json"}).end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, {"Content-Type":"application/json"}).end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404, {"Content-Type":"application/json"}).end(JSON.stringify({ error: "POST /analyze" }));
});

server.listen(PORT, () => console.log(`Analyst service on http://localhost:${PORT}  (model: ${model})`));
