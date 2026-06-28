// job-deliverable.mjs — read the stored deliverable for an ERC-8183 job.
//
// job-submit-background.mjs writes the research brief + canonical bytes + hash
// (and, once submitted, the tx) to the "job-deliverables" Blobs store under the
// jobId. This function reads that record back so the evaluator (C2) can fetch
// the exact bytes to re-hash, and the user can read the brief. Until the
// background function has written anything, the key is absent → "not_found".
//
// READ ONLY: no wallet, no signing, no transaction — just a Blobs read.
//
// Input: { jobId } as a GET query param or a POST body.
// Output: the stored record (status, deliverableHash, canonicalReport, brief,
//   txHash — whatever's persisted) | { status: "not_found" }.

import { connectLambda, getStore } from "@netlify/blobs";
import { json, parseBody } from "./_arc.mjs";

export async function handler(event) {
  // Classic Lambda-signature functions must hand the Blobs client their context
  // explicitly — see the longer note in job-submit-background.mjs — or
  // getStore() throws "environment has not been configured to use Netlify
  // Blobs". connectLambda reads the request-scoped siteID + token from
  // event.blobs; must run before getStore. Guard on event.blobs: it's absent
  // under local `netlify dev`, and connectLambda throws on undefined.
  if (event.blobs) connectLambda(event);

  // Accept jobId from the query string (GET) or the JSON body (POST).
  const jobId = event.queryStringParameters?.jobId || parseBody(event).jobId;
  if (!jobId) return json(400, { error: "Provide 'jobId'" });

  try {
    const store = getStore("job-deliverables");
    const entry = await store.get(jobId, { type: "json" });
    // Nothing written yet (background function still running or never ran).
    if (!entry) return json(200, { status: "not_found" });
    // Pass the persisted record through verbatim — status, deliverableHash,
    // canonicalReport, brief, txHash, etc., exactly as the writer stored it.
    return json(200, entry);
  } catch (e) {
    return json(500, { error: e.message });
  }
}
