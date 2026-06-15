import { publicClient, readMarket } from "./netlify/functions/_predict.mjs";

const marketId = process.argv[2] ?? "0";
const client = publicClient();
const snapshot = await readMarket(client, marketId);
console.log("MARKET SNAPSHOT:\n", JSON.stringify(snapshot, null, 2));

if (!snapshot) { console.log("Market not found"); process.exit(1); }

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";
const t0 = Date.now();

const res = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  body: JSON.stringify({
    model, max_tokens: 1024,
    system: "You are a parimutuel prediction-market analyst. Use web search for real evidence, judge if the pool MISPRICES the outcome (back the underpriced side, not just the likely one), then respond with ONLY JSON: {side:'yes'|'no', confidence:DECIMAL 0..1 like 0.62, edge:number, reasoning:string, suggestedAmountUsdc:number capped at min(10, 20% of total pool), 0 if no edge}",
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: `Question: ${snapshot.question}\nPools: YES ${snapshot.pools?.yesUsdc} / NO ${snapshot.pools?.noUsdc}` }],
  }),
});
const data = await res.json();
console.log(`\n(took ${((Date.now()-t0)/1000).toFixed(1)}s)`);
const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("");
console.log("\nAGENT DECISION:\n", text);
