// guard-staleness.mjs — IS A DELIBERATELY-UNWIRED GUARD OWED A RUN? Pure functions, no IO.
//
// ═══ THE GAP THIS CLOSES ═════════════════════════════════════════════════════════════════════
// Eight guards sit outside `test:all` by decision, each declared in UNWIRED_OK with a reason and a
// PROSE run-trigger: "run it after any deploy touching ManualSwapPanel", "run it when the
// upfront-fee migration lands, and periodically after". `gate:registry` proves each is DECLARED.
// Nothing proved any had ever been RUN — the triggers were sentences, addressed to whoever
// remembered to read them.
//
// ⭐⭐ AND THE REGISTRY STRUCTURALLY CANNOT CLOSE IT. It asserts an unwired guard is declared; it
// cannot assert the declared reason or trigger was HONOURED, because both are prose. That is the
// same shape as the `test:ddwatch` exemption whose stated reason was simply untrue for two months:
// an exemption registry makes omissions impossible and false justifications invisible.
//
// ═══ ⭐⭐ TWO KINDS OF TRIGGER, BECAUSE THE SUBJECTS DIFFER ═══════════════════════════════════
// This is the distinction that makes the check honest rather than a nag:
//
//   · `onDeployTouching` — the guard watches OUR OWN files. A commit of ours is what can invalidate
//     it, so the trigger is a real change to a named path. ⚠️ A **DEPLOY**, not a commit: every one
//     of these guards asserts something about the SERVED artifact, so editing the file locally
//     cannot discharge it and must not raise it either. Raising it at commit time would put the
//     tree red for the whole of development, unable to be cleared — an alert that fires on routine
//     work is one nobody reads.
//
//   · `everyDays` — the guard watches a THIRD PARTY: a live contract we do not own, an IPFS
//     gateway, the deployed token. **Nothing in this repo moves when their answer changes**, so no
//     path-based trigger can ever fire and a clock is the only instrument left. This is why
//     `test:feemanagerlive`'s own declaration says "and periodically after" — periodically is not
//     laziness there, it is the only correct trigger for an off-repo subject.
//
// ⚠️ NEVER-RUN IS OWED, NOT CLEAN. A guard with no recorded run has not been verified, and the
// tempting reading — "no record, nothing wrong" — is the absence-reads-as-safe family this repo
// keeps re-learning. It is reported as owed with that reason, and so is a run whose commit cannot
// be reached, because "I could not tell what changed" is not "nothing changed".

/** Reasons a guard is owed. A closed set, so a caller can branch without string-matching prose. */
export const OWED = Object.freeze({
  NEVER_RUN: "never-run",
  DEPLOY_TOUCHED: "deploy-touched",
  AGE: "age",
  UNDETERMINED: "undetermined",
});

/**
 * The most recent recorded run per guard, from the JSONL ledger.
 *
 * ⚠️ Returns an explicit not-ok rather than an empty map when the ledger cannot be read. An empty
 * map and an unreadable ledger produce the SAME verdict downstream (everything never-run), but they
 * are different facts and the caller is told which — the report says "no ledger" instead of
 * silently claiming eight guards were never run.
 *
 * @param {string|null} text  raw ledger contents, or null when the file does not exist
 * @returns {{ok: true, runs: Map<string,{at:string,commit:string|null}>, lines: number, skipped: number}
 *          |{ok: false, why: string}}
 */
export function parseRunLog(text) {
  if (text === null || text === undefined) {
    return { ok: false, why: "the run ledger does not exist — no guard has a recorded run" };
  }
  const lines = String(text).split("\n").filter((l) => l.trim().length > 0);
  const runs = new Map();
  let skipped = 0;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { skipped++; continue; }
    if (!r || typeof r.name !== "string" || typeof r.at !== "string") { skipped++; continue; }
    const prev = runs.get(r.name);
    // ⭐ LAST BY TIMESTAMP, not by file order. Appends are chronological in practice, but a verdict
    // that silently depends on that would break the first time two machines interleave.
    if (!prev || Date.parse(r.at) > Date.parse(prev.at)) {
      runs.set(r.name, { at: r.at, commit: typeof r.commit === "string" ? r.commit : null });
    }
  }
  return { ok: true, runs, lines: lines.length, skipped };
}

/**
 * Is one guard owed a run?
 *
 * @param {object}   trigger       from UNWIRED_TRIGGERS — { onDeployTouching?: string[], everyDays?: number }
 * @param {object?}  lastRun       { at, commit } or null/undefined
 * @param {string[]|null} changedPaths  paths a DEPLOY changed since lastRun.commit; null = could not determine
 * @param {number}   now           ms
 * @returns {{owed: boolean, reason: string|null, detail: string}}
 */
export function owedFor({ trigger, lastRun, changedPaths, now }) {
  if (!lastRun) {
    return { owed: true, reason: OWED.NEVER_RUN, detail: "no recorded run — never verified" };
  }

  const paths = Array.isArray(trigger?.onDeployTouching) ? trigger.onDeployTouching : [];
  if (paths.length > 0) {
    // ⚠️ FAIL-CLOSED ON AN UNKNOWN DIFF. `null` means the commit range could not be resolved (an
    // unrecorded commit, a rewritten history, a shallow clone). "Could not tell what changed" is
    // not "nothing changed", and letting it fall through to the clock would answer a question
    // nobody asked.
    if (changedPaths === null || changedPaths === undefined) {
      return {
        owed: true, reason: OWED.UNDETERMINED,
        detail: `cannot resolve what changed since ${lastRun.commit ?? "an unrecorded commit"}`,
      };
    }
    const hits = paths.filter((p) => changedPaths.some((c) => c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`)));
    if (hits.length > 0) {
      return {
        owed: true, reason: OWED.DEPLOY_TOUCHED,
        detail: `a deploy changed ${hits.join(", ")} since the last run`,
      };
    }
  }

  const days = Number(trigger?.everyDays);
  if (Number.isFinite(days) && days > 0) {
    const ageMs = now - Date.parse(lastRun.at);
    if (!Number.isFinite(ageMs)) {
      return { owed: true, reason: OWED.UNDETERMINED, detail: `unparseable run timestamp ${lastRun.at}` };
    }
    const ageDays = ageMs / 86_400_000;
    if (ageDays > days) {
      return { owed: true, reason: OWED.AGE, detail: `last run ${ageDays.toFixed(1)}d ago, horizon ${days}d` };
    }
  }

  return { owed: false, reason: null, detail: `last run ${lastRun.at}` };
}

/**
 * ⚠️ A guard whose trigger declares NEITHER mechanism can never be owed by anything but never-run —
 * it would go permanently clean after one run, which is an exemption wearing a check's clothes.
 * `gate:registry` asserts every declared trigger carries at least one; this is the same rule as a
 * pure predicate so a test can drive it.
 */
export function triggerIsActionable(trigger) {
  const paths = Array.isArray(trigger?.onDeployTouching) ? trigger.onDeployTouching : [];
  const days = Number(trigger?.everyDays);
  return paths.length > 0 || (Number.isFinite(days) && days > 0);
}
