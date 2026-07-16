// batch.mjs — run one check over many {address, chain} entries. Returns an array of facts.
//
// ⚠️ FAIL-CLOSED PER ENTRY, NOT PER RUN. One address that errors — bad hex, dead RPC, rate limit —
// must produce an ERROR fact and let the batch continue. If a single bad entry aborted the run, a
// 20-address audit would return 6 facts and no indication that 14 were never asked, and the reader
// would draw conclusions from a silently truncated set. That is the same class of bug as a summary
// that says "3 checks, 1 problem" while quietly dropping the checks it could not run. Every entry in
// goes to exactly one fact out — the array length is a promise.
//
// SEQUENTIAL BY DEFAULT, deliberately. Arc's public RPC answered "request limit reached" at a few
// calls per second during this session's recon. Parallelising would convert a real audit into a wall
// of rate-limit ERROR facts — indistinguishable at a glance from findings. Slower and honest beats
// fast and noisy. The client pool already removed the 3x overhead that mattered.

import { failed } from "./fact.mjs";
import { clientPool } from "./client.mjs";

/**
 * @param {Array<{address:string, chain:string}>} entries
 * @param {object} opts
 * @param {{id:string, run:Function}} opts.check
 * @param {number} [opts.block] - pin every chain at this block (else resolved per chain, once)
 * @param {number} [opts.delayMs] - pause between entries. Arc's RPC rate-limits at a few calls/sec,
 *   which the first run of check 2 hit immediately; rpc.mjs retries with backoff, and this keeps us
 *   under the limit in the first place so the retries stay a safety net rather than the main path.
 * @param {(fact:object, i:number, total:number)=>void} [opts.onFact] - progress, for long runs
 * @returns {Promise<object[]>} one fact per entry, in input order
 */
export async function runBatch(entries, { check, block, onFact, delayMs = 120 } = {}) {
  const pool = clientPool({ block });
  const facts = [];

  for (const [i, entry] of entries.entries()) {
    if (i > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    let fact;
    try {
      // The pool hands the same client to every entry on a given chain, so the guard + pin resolve
      // once. A client that cannot be built (unknown chain) throws here and is caught below.
      const client = pool.for(entry.chain);
      fact = await check.run({ ...entry, client });
    } catch (e) {
      // Belt and braces: check.run() already returns failed() for its own errors. This catches an
      // UNEXPECTED throw (a bug in a check, an unknown chain) so it degrades to one error fact
      // rather than killing the other 19 entries.
      fact = failed({ check: check.id, input: entry, error: e });
    }
    facts.push(fact);
    onFact?.(fact, i, entries.length);
  }
  return facts;
}

/** Counts for a run header. Deliberately NOT a verdict — how many we could ASK, not what we found. */
export function batchStats(facts) {
  return {
    entries: facts.length,
    observed: facts.filter((f) => f.status === "observed").length,
    errored: facts.filter((f) => f.status === "error").length,
  };
}
