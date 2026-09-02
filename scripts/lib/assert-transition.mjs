// assert-transition.mjs — ⛔ A CHECK MUST ASSERT A STATE **CHANGED**, NOT THAT A STATE **HOLDS**.
//
// ═══ 🚨 THE RULE, AND WHY IT IS WRITTEN HERE ══════════════════════════════
// A check that asserts a state HOLDS passes for two different reasons, and cannot tell them apart:
// because the thing worked, or because nothing ever happened. The second is the dangerous one, and
// in a log it is indistinguishable from success.
//
// ⛔ FOUR VACUOUS PASSES IN A SINGLE RUN, 2026-09-02, all the same shape:
//
//   1. `git checkout <path>` to undo a bad file — restores from the INDEX, and the file had already
//      been `git add`-ed. A NO-OP that printed "Updated 1 path from the index".
//   2. `git push` printed "Everything up-to-date" — because the commit before it had been REFUSED
//      by a hook. Reads exactly like a successful push of nothing.
//   3. `git merge-base --is-ancestor HEAD origin/main` → true. Trivially: HEAD never moved, so it
//      was already an ancestor. The assertion could not fail while nothing was committed.
//   4. `until ! pgrep -f "run-suites.mjs"` — the monitor's OWN command line contains that string,
//      so pgrep matched itself and the loop waited on its own existence, forever.
//
// ⭐⭐ NONE OF THEM LOOKED WRONG IN A LOG. Each printed the words a working system prints. What they
// had in common is that no baseline was taken, so "after" had nothing to be different from.
//
// ⭐ THE DISCIPLINE, which this repo already applies to a served bundle: record the BEFORE, act,
// record the AFTER, and assert the TRANSITION — the 0 → 1 on a probe string, not the 1.
// [[success-message-is-not-evidence-of-effect]] · [[equality-passes-vacuously-on-empty]]
//
//   const before = read();
//   act();
//   assertChanged(before, read(), "the thing I claim I did");
//
// ⚠️ AND A SELF-MATCHING PREDICATE IS THE SAME BUG IN A PREDICATE. Before trusting a check that
// searches (pgrep, grep over your own output, a store query built from the value you just wrote),
// ask what it matches when the answer should be "nothing".

/**
 * Assert an observation actually MOVED. Throws with both readings when it did not.
 * ⭐ Takes the before and after as VALUES, not a predicate — a predicate can be satisfied by a state
 * that never changed, which is the failure this exists to prevent.
 */
export function assertChanged(before, after, what) {
  const b = typeof before === "object" ? JSON.stringify(before) : String(before);
  const a = typeof after === "object" ? JSON.stringify(after) : String(after);
  if (b === a) {
    throw new Error(
      `NO CHANGE — ${what} did not happen. before === after === ${b.slice(0, 120)}\n` +
      `  A check that asserts a state HOLDS cannot tell "it worked" from "nothing ran".`
    );
  }
  return { before: b, after: a };
}

/**
 * The transition form for a probe count: it must go from `from` to `to`, and a CONTROL that should
 * not move must not move. ⭐ The control is what proves the measurement itself was taken —
 * without it, "0 → 0" and "the fetch failed" are the same reading.
 */
export function assertTransition({ label, before, after, from, to, control }) {
  if (before !== from) throw new Error(`BASELINE WRONG — ${label}: expected ${from} before, saw ${before}`);
  if (after !== to) throw new Error(`NO TRANSITION — ${label}: expected ${from} → ${to}, saw ${before} → ${after}`);
  if (control && control.before !== control.after)
    throw new Error(`CONTROL MOVED — ${control.label}: ${control.before} → ${control.after}. The measurement is not trustworthy.`);
  return true;
}
