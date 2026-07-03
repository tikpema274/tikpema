// GET/POST /api/job-run-status?runId=...  (auth required)  — Sub-brick 2b
//
// Poll a running job by its runId. Merges the "job-runs" record (create/fund
// progress) with the "job-deliverables" record (research → submit → settle,
// keyed by jobId). Ownership: only the run's owner (this session) may read it.
import { connectLambda, getStore } from "@netlify/blobs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";

export async function handler(event) {
  if (event.blobs) connectLambda(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const runId = event.queryStringParameters?.runId || parseBody(event).runId;
  if (!runId) return json(400, { error: "runId required" });

  const runs = getStore("job-runs");
  const run = await runs.get(`run:${runId}`, { type: "json" }).catch(() => null);
  // Not written yet (eventual consistency right after job-run) — keep polling.
  if (!run) return json(200, { runId, status: "starting" });

  // Ownership: a session can only read ITS OWN runs.
  if (run.owner?.toLowerCase() !== session.address.toLowerCase()) {
    return json(403, { error: "not your job" });
  }

  // Merge in the deliverable record (research/submit/settle) once we have a jobId.
  let deliverable = null;
  if (run.jobId) {
    const store = getStore("job-deliverables");
    deliverable = await store.get(run.jobId, { type: "json" }).catch(() => null);
  }
  const dStatus = deliverable?.status;
  const status = dStatus && dStatus !== "not_found" ? dStatus : run.status;

  return json(200, {
    runId,
    jobId: run.jobId ?? null,
    walletAddress: run.walletAddress,
    status,
    brief: deliverable?.brief,
    verdict: deliverable?.verdict,
    reason: deliverable?.reason ?? run.error,
    settleTx: deliverable?.settleTx,
    settleTxUrl: deliverable?.settleTxUrl,
    error: run.error ?? deliverable?.error,
  });
}
