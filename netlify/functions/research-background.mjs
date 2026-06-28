// research-background.mjs — the async analyst plane.
//
// The "-background" filename suffix tells Netlify to run this function
// asynchronously: the invocation returns 202 immediately and the body runs for
// up to 15 minutes (Pro plan), free of the 26s/60s sync ceiling that forced the
// standalone analyst-server.mjs in the first place. There is no useful HTTP
// response — callers poll predict-status.mjs instead — so we persist the result
// to Netlify Blobs under the job id and let the function exit.
//
// READ ONLY: takes a free-form question string and calls the agent's Claude
// brain with web search. No on-chain read, no wallet, no signing, no
// transaction — this endpoint only researches and returns a JSON decision.
//
// Input (POST body): { question, jobId }
// Output: written to Blobs store "predict-jobs" under key `jobId`.

import { connectLambda, getStore } from "@netlify/blobs";
import { parseBody } from "./_arc.mjs";
import { research } from "./_research.mjs";

const SYSTEM_PROMPT = `You are Tikpema's parimutuel prediction-market analyst on Arc Testnet.
Use web search for real evidence, judge whether the pool MISPRICES the outcome
(back the underpriced side, not just the likely one), then respond with ONLY JSON:
{ "side": "yes"|"no", "confidence": <decimal 0..1>, "edge": <decimal -1..1>,
  "reasoning": <2-4 sentences>, "suggestedAmountUsdc": <stake, <= min(10, 20% of total pool), 0 if no edge> }`;

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
  const { question, jobId } = parseBody(event);
  if (!jobId) {
    // Without a jobId there is nowhere to write the result — nothing to do.
    return { statusCode: 400, body: "jobId required" };
  }

  const store = getStore("predict-jobs");
  try {
    const result = await research(question, SYSTEM_PROMPT);
    await store.setJSON(jobId, { status: "done", result });
  } catch (e) {
    // Surface the failure to the poller rather than leaving the job "pending"
    // forever.
    await store.setJSON(jobId, { status: "done", result: { error: e.message } });
  }
  // 202 is conventional for an accepted-and-finished background invocation.
  return { statusCode: 202 };
}
