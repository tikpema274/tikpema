// mergeJobStatus — the ONE place a polled job payload becomes tracked UI state.
//
// ═══ 🚨 WHY THIS EXISTS: AN INCLUDE-LIST FAILS SILENT ════════════════════════════════════════
// Three panels each rebuilt `TrackedJob` field-by-field from the poll payload:
//
//     brief: data.brief ?? prev.brief,  proposal: data.proposal ?? prev.proposal,  …
//
// Every field the server learns to project is therefore INVISIBLE until somebody remembers to add
// a line here. Nobody remembered, three times:
//
//   1. `brief.dataDisclosure` — enriched at one site, missing at another
//   2. `dataPurchase` (#181056, `14c23c8`) — written at ONE store write, dropped by the evaluate
//      rebuild. Fixed SERVER-side with a declared field list + an assertion on the payload.
//   3. ⭐ `synthesis` / `secondOpinion` — this one. `job-run-status` has always projected both,
//      under a comment reading *"Projected even when the second opinion KILLED the proposal —
//      especially then"*. No client merge ever named them, in ANY commit, so `SecondOpinionCard`
//      — the whole killed-proposal disclosure, in all six of its states — **had never rendered in
//      production**. A buyer paid for job #181281, got a brief with no proposal, and no account of
//      why. The comment explaining that this must never happen sits directly above the branch.
//
// ⭐⭐ SO THE DIRECTION IS INVERTED: SPREAD BY DEFAULT, OMIT DELIBERATELY. A newly projected field
// now arrives on its own and must be REMOVED on purpose, which is a decision someone makes rather
// than one they forget. Same principle as `UNWIRED` being the default outcome rather than a branch
// somebody has to write — the safe state is the one you get by doing nothing.
//
// ⚠️ AND THE LIST IS NOT DUPLICATED CLIENT-SIDE. There is deliberately no hand-written roster of
// "fields a job carries" here; that would be the same bug with two places to forget, and the
// server/client boundary is exactly where nothing checks. What the server projects IS the list.

/**
 * Fields a payload may carry that the client must NOT track.
 * ⚠️ Keep this SHORT and justified per entry. Anything omitted for tidiness rather than for a
 * reason re-creates the include-list one name at a time.
 */
export const NOT_TRACKED: readonly string[] = Object.freeze([
  // Identity is the CLIENT's. The poll is already guarded by `prev.runId === runId`; letting a
  // payload rewrite it would let a late response from one run re-point the panel at another.
  "runId",
  // An owner identity the timeline never renders. Identities spread by default are how they end
  // up somewhere they were never meant to be.
  "walletAddress",
]);

/**
 * Merge a poll payload into the tracked job.
 *
 * ⚠️ ABSENCE NEVER OVERWRITES. `null`/`undefined` values are dropped rather than assigned, which
 * preserves the `data.x ?? prev.x` semantics the hand-written merges had. This matters: the server
 * sends `jobId: run.jobId ?? null` before the job id is known, and a plain spread would erase an id
 * the client already had. An absence must never replace a known value.
 */
export function mergeJobStatus<T extends Record<string, any>>(prev: T, data: Record<string, any>): T {
  const next: Record<string, any> = { ...prev };
  for (const [k, v] of Object.entries(data ?? {})) {
    if (NOT_TRACKED.includes(k)) continue;
    if (v === null || v === undefined) continue;
    next[k] = v;
  }
  return next as T;
}
