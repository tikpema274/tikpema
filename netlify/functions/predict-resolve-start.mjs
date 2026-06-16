// predict-resolve-start.mjs — kick off an async resolution proposal and hand
// back a job id.
//
// The research runs in predict-resolve-background.mjs, which can take minutes
// (web search + multi-round reasoning). This function just mints a job id,
// fires the background function, and returns immediately so the client never
// blocks. The client then polls predict-status.mjs with the id (the same
// generic poller the analyze flow uses — both write to the "predict-jobs" store).
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
  // runs its body asynchronously, so we don't await the research — only the
  // dispatch. Target the background function on THIS exact deploy: DEPLOY_URL is
  // the unique per-deploy permalink (https://<deploy-id>--site.netlify.app) and
  // is the only URL guaranteed to serve the code currently running — on draft
  // deploys, deploy previews, branch deploys, and production alike. `URL` and
  // `DEPLOY_PRIME_URL` point at the production / branch "prime" URLs, which on a
  // draft deploy resolve to a DIFFERENT deploy that has no predict-resolve-
  // background function yet, so the invocation 404s. Fall back to the request
  // host only for local `netlify dev`, where none of the deploy vars are set.
  const base =
    process.env.DEPLOY_URL ||
    `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;

  try {
    const res = await fetch(`${base}/.netlify/functions/predict-resolve-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketId: Number(marketId), jobId }),
    });
    // Background invocations should answer 202 Accepted. Anything else means the
    // job never started, so don't hand back a job id that will poll forever.
    if (res.status !== 202) {
      const detail = await res.text().catch(() => "");
      return json(502, { error: `Failed to start resolution research (status ${res.status})`, detail });
    }
  } catch (e) {
    return json(502, { error: `Failed to start resolution research: ${e.message}` });
  }

  return json(200, { jobId });
}
