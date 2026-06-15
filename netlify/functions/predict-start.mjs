// predict-start.mjs — kick off an async analysis and hand back a job id.
//
// The analyst runs in predict-analyze-background.mjs, which can take minutes
// (web search + multi-round reasoning). This function just mints a job id,
// fires the background function, and returns immediately so the client never
// blocks on the analysis. The client then polls predict-status.mjs with the id.
//
// Input (POST body): { marketId }
// Output: { jobId }

import { randomUUID } from "node:crypto";
import { json, parseBody } from "./_arc.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { marketId } = parseBody(event);
  if (marketId === undefined || marketId === null || !Number.isInteger(Number(marketId)) || Number(marketId) < 0) {
    return json(400, { error: "Provide a non-negative integer 'marketId'" });
  }

  const jobId = randomUUID();

  // Invoke the background function over HTTP. Netlify returns 202 right away and
  // runs its body asynchronously, so we don't await the analysis — only the
  // dispatch. Build the base URL from the Netlify-provided site URL, falling
  // back to the incoming request's host (covers `netlify dev` and deploys alike).
  const base =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;

  try {
    const res = await fetch(`${base}/.netlify/functions/predict-analyze-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: Number(marketId), jobId }),
    });
    // Background invocations should answer 202 Accepted. Anything else means the
    // job never started, so don't hand back a job id that will poll forever.
    if (res.status !== 202) {
      const detail = await res.text().catch(() => "");
      return json(502, { error: `Failed to start analysis (status ${res.status})`, detail });
    }
  } catch (e) {
    return json(502, { error: `Failed to start analysis: ${e.message}` });
  }

  return json(200, { jobId });
}
