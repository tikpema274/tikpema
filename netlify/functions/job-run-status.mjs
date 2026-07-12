// GET/POST /api/job-run-status?runId=...  (auth required)  — Sub-brick 2b
//
// Poll a running job by its runId. Merges the "job-runs" record (create/fund
// progress) with the "job-deliverables" record (research → submit → settle,
// keyed by jobId). Ownership: only the run's owner (this session) may read it.
import { connectLambda, getStore } from "@netlify/blobs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";

// Self-heal thresholds. A run stalls at "starting" when Netlify acks the
// job-run-background invocation but never runs it (observed intermittently). We only
// re-fire from "starting" (job-run-background provably never began — nothing created),
// after the run is old enough that "starting" is real and not a stale read, and no more
// than once per cooldown (the browser polls every 5s).
const STALL_MS = 30_000;         // > Blobs read lag + job-run-background cold start
const REFIRE_COOLDOWN_MS = 30_000;

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

  // ── SELF-HEAL — recover a run stranded at "starting" by re-firing job-run-background.
  // Safe because: (1) we re-fire ONLY from "starting" with no jobId — job-run-background
  // never began, so nothing was created; (2) job-run-background's idempotency guard
  // aborts any invocation that finds the run already advanced. The re-fire is idempotent
  // and bounded to once per cooldown via `reFiredAt`. This is a fire-and-forget nudge:
  // if the ack drops, the next poll (post-cooldown) tries again — recovery by repetition.
  if (run.status === "starting" && !run.jobId && run.question && run.walletAddress) {
    const age = Date.now() - Date.parse(run.createdAt || 0);
    const sinceRefire = run.reFiredAt ? Date.now() - Date.parse(run.reFiredAt) : Infinity;
    if (age > STALL_MS && sinceRefire > REFIRE_COOLDOWN_MS) {
      // Stamp reFiredAt FIRST so concurrent polls don't all re-fire.
      await runs.setJSON(`run:${runId}`, { ...run, reFiredAt: new Date().toISOString() });
      const base =
        process.env.DEPLOY_URL ||
        `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
      fetch(`${base}/.netlify/functions/job-run-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
        body: JSON.stringify({
          runId, question: run.question, budgetUsdc: run.budgetUsdc,
          walletAddress: run.walletAddress, owner: run.owner,
        }),
      }).catch(() => {});
      console.log(`[job-run-status] self-heal: re-fired job-run-background for stalled run ${runId} (age ${Math.round(age / 1000)}s)`);
    }
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
    // Proposal loop: the server-authored bridge proposal + the server-PROVEN receipt.
    // Both are read-only projections of what the server wrote; the client never
    // supplies either. `receipt.state` is the ONLY field the UI may branch on, and it
    // must never render "minted" without a `mintTxHash`.
    proposal: deliverable?.proposal,
    // Brick 2. Projected even when the second opinion KILLED the proposal — especially then:
    // "your analysts disagreed, so nothing is proposed" is the most valuable thing this brick
    // produces, and it must be VISIBLE, not merely logged.
    secondOpinion: deliverable?.secondOpinion,
    synthesis: deliverable?.synthesis,
    receipt: deliverable?.receipt,
    verdict: deliverable?.verdict,
    reason: deliverable?.reason ?? run.error,
    settleTx: deliverable?.settleTx,
    settleTxUrl: deliverable?.settleTxUrl,
    error: run.error ?? deliverable?.error,
  });
}
