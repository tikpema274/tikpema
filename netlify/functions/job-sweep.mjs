import { connectLambda, getStore } from "@netlify/blobs";
import { internalToken } from "./_auth.mjs";

// job-sweep.mjs — SCHEDULED sweep that recovers runs stranded at "starting".
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────
// Netlify intermittently ACKs a `*-background` invocation without running it, so
// `job-run → job-run-background` occasionally drops and a run sticks at "starting"
// (no on-chain job, no fee, no deliverable). The poll-driven self-heal in
// job-run-status only fires WHILE the browser is polling — if the user navigates away,
// nothing recovers the run (observed live: job-run-status had 0 invocations, self-heal
// never engaged). This cron sweep is the AUTONOMOUS recovery: it runs regardless of any
// browser and re-fires the dropped stage.
//
// ── SAFETY (identical discipline to the poll-driven self-heal) ───────────────────
//   • Re-fire ONLY runs at status "starting" with no jobId — job-run-background provably
//     never began, so nothing was created. Anything advanced (creating/funding/funded,
//     or a jobId) is skipped.
//   • job-run-background's own IDEMPOTENCY GUARD aborts any invocation that finds the run
//     already advanced — so even a racing re-fire can't create a second on-chain job.
//   • `reFiredAt` cooldown bounds re-fires to once per COOLDOWN_MS per run.
//   • AGE CAP: a run stuck past MAX_AGE_MS is marked failed, not re-fired forever — an
//     ancient stuck run (browser long gone) shouldn't be nudged indefinitely.
//
// ⚠️ PLATFORM UNKNOWN (deploy-only): whether a SCHEDULED function receives Blobs access.
// Locally getStore throws "environment not configured". In the deployed runtime Netlify
// configures Blobs for functions; scheduled functions included. We connectLambda when a
// context is present and otherwise rely on the deployed env — and wrap the whole sweep so
// a Blobs-access failure NO-OPS loudly rather than crashing the schedule.
export const config = { schedule: "* * * * *" }; // every minute

const STALL_MS = 45_000;      // > Blobs lag + a cold start; "starting" this old is real
const COOLDOWN_MS = 60_000;   // at most one re-fire per run per minute
const MAX_AGE_MS = 60 * 60_000; // 1h — beyond this, stop nudging and mark failed

export async function handler(event) {
  if (event?.blobs) connectLambda(event);

  let runs;
  try {
    runs = getStore("job-runs");
  } catch (e) {
    console.warn(`[job-sweep] Blobs unavailable in scheduled context — sweep skipped: ${e.message}`);
    return { statusCode: 200, body: "blobs-unavailable" };
  }

  const base = process.env.URL || process.env.DEPLOY_URL;
  if (!base) {
    console.warn("[job-sweep] no site URL (process.env.URL) — cannot re-fire; sweep skipped");
    return { statusCode: 200, body: "no-base-url" };
  }

  let listed = 0, reFired = 0, agedOut = 0;
  try {
    // list() paginates; iterate all run:* keys.
    const { blobs } = await runs.list({ prefix: "run:" });
    for (const { key } of blobs) {
      listed++;
      const run = await runs.get(key, { type: "json" }).catch(() => null);
      if (!run) continue;

      // Only stalled STARTS are recoverable. Anything advanced is left alone.
      if (run.status !== "starting" || run.jobId) continue;
      if (!run.question || !run.walletAddress) continue; // can't reconstruct the re-fire

      const age = Date.now() - Date.parse(run.createdAt || 0);
      if (!(age > STALL_MS)) continue; // too young — "starting" might be a stale read

      // Age cap — stop nudging a run the user long abandoned.
      if (age > MAX_AGE_MS) {
        await runs.setJSON(key, { ...run, status: "failed", error: "provisioning never completed (aged out of sweep)" });
        agedOut++;
        continue;
      }

      const sinceRefire = run.reFiredAt ? Date.now() - Date.parse(run.reFiredAt) : Infinity;
      if (!(sinceRefire > COOLDOWN_MS)) continue; // re-fired recently — wait

      // Stamp FIRST (so a concurrent sweep tick doesn't double-fire), then re-fire.
      await runs.setJSON(key, { ...run, reFiredAt: new Date().toISOString() });
      fetch(`${base}/.netlify/functions/job-run-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
        body: JSON.stringify({
          runId: run.runId, question: run.question, budgetUsdc: run.budgetUsdc,
          walletAddress: run.walletAddress, owner: run.owner,
        }),
      }).catch(() => {});
      reFired++;
    }
  } catch (e) {
    console.warn(`[job-sweep] sweep error (partial): ${e.message}`);
  }

  if (reFired || agedOut) console.log(`[job-sweep] listed=${listed} reFired=${reFired} agedOut=${agedOut}`);
  return { statusCode: 200, body: `listed=${listed} reFired=${reFired} agedOut=${agedOut}` };
}
