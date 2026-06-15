// predict-status.mjs — poll the result of an async analysis.
//
// predict-analyze-background.mjs writes its result to the "predict-jobs" Blobs
// store under the job id once it finishes. Until then the key is absent, which
// we report as "pending". Once present we hand back the stored result.
//
// Input (POST body): { jobId }
// Output: { status: "pending" } | { status: "done", result }

import { getStore } from "@netlify/blobs";
import { json, parseBody } from "./_arc.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { jobId } = parseBody(event);
  if (!jobId) return json(400, { error: "Provide 'jobId'" });

  try {
    const store = getStore("predict-jobs");
    const entry = await store.get(jobId, { type: "json" });
    if (!entry) return json(200, { status: "pending" });
    // The background function stores { status: "done", result }; pass it through.
    return json(200, entry);
  } catch (e) {
    return json(500, { error: e.message });
  }
}
