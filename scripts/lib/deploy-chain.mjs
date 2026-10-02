// deploy-chain.mjs — the steps deploy:prod:chain RUNS, in order, for the suites that pin its shape.
//
// The chain is an `&&` string, but one step is the deferred-verdict wrapper (scripts/deferred-verdict.mjs), which runs
// a reporting gate and then the steps that must run regardless of it. Splitting on `&&` alone would hide those steps
// inside one string, so an order pin ("stage:ledger runs last") would be comparing against the wrapper, not the order.
// chainSteps expands the wrapper into the `npm run` steps it performs, in the order it performs them.

export const DEFERRED = "node scripts/deferred-verdict.mjs";

export function chainSteps(chain) {
  const out = [];
  for (const raw of String(chain ?? "").split("&&")) {
    const step = raw.trim();
    if (!step.startsWith(`${DEFERRED} `)) { out.push(step); continue; }
    const args = step.slice(DEFERRED.length).trim().split(/\s+/);
    const sep = args.indexOf("--");
    // A malformed wrapper step is kept whole, so a pin compares against it and goes red rather than guessing.
    if (sep !== 1 || args.length < 3) { out.push(step); continue; }
    out.push(`npm run ${args[0]}`, ...args.slice(2).map((s) => `npm run ${s}`));
  }
  return out;
}
