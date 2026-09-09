// deploy-loss-delta.mjs — THE DELTA, as pure functions. No IO, no API, no clock.
//
// ═══ WHY A DELTA AND NOT THE COUNT ═══════════════════════════════════════════════════════════
// scripts/deploy-loss-sweep.mjs exits 1 whenever ANY loss exists. That is right for a census run
// by a human — "here is the standing total" — and wrong for a gate in `deploy:prod`, because 8
// losses are standing by DECISION (cancelling them would convert clean evidence into the same
// ambiguous "Deploy canceled" state that already makes 46 records uncountable). A gate wired to
// the total would therefore fail EVERY deploy, forever, for a condition nobody intends to clear.
//
// ⭐ An alert that fires on routine work is one nobody reads — the same reasoning netlify.toml
// already applies to dd-watch's grace window. So the gate asks the only question that changes:
// **did a loss appear that the last census had not already recorded?**
//
// ═══ ⚠️ THE FAILURE MODE THIS FILE MUST NOT HAVE ═════════════════════════════════════════════
// A delta needs a baseline. If the ledger is missing, empty, or unreadable there IS no baseline —
// and the tempting reading of "no previous losses recorded" is `previous = {}`, which makes every
// standing loss look new (false alarm) or, if inverted, makes the comparison vacuous. Neither is
// a measurement. So `previousCensus` returns an EXPLICIT not-ok, and the caller is required to
// treat it as "could not measure" (exit 2), never as "nothing new" (exit 0).
//
// This is the absence-must-never-read-as-safe family, which this repo keeps re-learning: an
// absence must not be allowed to fill the result slot.

/**
 * The loss ids recorded by the LAST census line in the ledger.
 *
 * ⚠️ STRICTLY THE LAST NON-EMPTY LINE. If it does not parse, this reports not-ok rather than
 * scanning backwards for an older line that does. A silent fallback to a stale baseline would
 * still "work" — it compares against something — and would quietly change what the gate means
 * on exactly the run where the ledger is misbehaving. One corrupt append wedging the gate is
 * loud and fixable; a gate that silently re-baselines is neither.
 *
 * ⚠️ `preserved` records are EXCLUDED, mirroring classifyDeployLosses (`losses = limbo.filter(
 * (r) => !r.preserved)`). The ledger deliberately stores every limbo record including the 23
 * known survivors, so comparing raw `ids` against `result.losses` would report all 23 as
 * "resolved" on the first run and as "appeared" the moment the reporting decision changed.
 *
 * @param {string|null} text  raw ledger contents, or null when the file does not exist
 * @returns {{ok: true, lossIds: Set<string>, observedAt: string|null, lines: number}
 *          |{ok: false, why: string, lines: number}}
 */
export function previousCensus(text) {
  if (text === null || text === undefined) {
    return { ok: false, why: "the ledger does not exist — there is no baseline to compare against", lines: 0 };
  }
  const lines = String(text).split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { ok: false, why: "the ledger is empty — there is no baseline to compare against", lines: 0 };
  }
  let parsed;
  try {
    parsed = JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    return { ok: false, why: `the ledger's last line does not parse as JSON (${e?.message?.split("\n")[0]})`, lines: lines.length };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.ids)) {
    // ⚠️ A line that parses but carries no `ids` array is NOT an empty census. It is a line whose
    // shape this function does not understand, and guessing "then there were no losses" is the
    // absence-as-safety bug in one step.
    return { ok: false, why: "the ledger's last line has no `ids` array — shape not understood", lines: lines.length };
  }
  const lossIds = new Set(
    parsed.ids.filter((r) => r && typeof r.id === "string" && r.preserved !== true).map((r) => r.id)
  );
  return { ok: true, lossIds, observedAt: typeof parsed.observedAt === "string" ? parsed.observedAt : null, lines: lines.length };
}

/**
 * What changed between the recorded baseline and the losses just classified.
 *
 * @param {Set<string>} previousLossIds  from previousCensus().lossIds
 * @param {Array<{id: string}>} currentLosses  classifyDeployLosses(...).losses
 * @returns {{appeared: object[], resolved: string[], carried: object[]}}
 */
export function diffLosses(previousLossIds, currentLosses) {
  const prev = previousLossIds instanceof Set ? previousLossIds : new Set(previousLossIds ?? []);
  const now = Array.isArray(currentLosses) ? currentLosses : [];
  const nowIds = new Set(now.map((r) => r?.id).filter((id) => typeof id === "string"));

  const appeared = now.filter((r) => typeof r?.id === "string" && !prev.has(r.id));
  const carried = now.filter((r) => typeof r?.id === "string" && prev.has(r.id));
  // ⭐ RESOLVED IS REPORTED, NEVER FAILED. A loss id that has left the set means somebody cancelled
  // the record (or it finally reached `ready`). That is information — cancelling is what makes a
  // record uncountable ever after — but it is not a regression, and a gate that failed on it would
  // punish the cleanup it exists to inform.
  const resolved = [...prev].filter((id) => !nowIds.has(id));

  return { appeared, resolved, carried };
}

/**
 * ⭐⭐ THE VERDICT, AS A PURE FUNCTION OF WHAT WAS MEASURED.
 *
 * The exit code IS the check — output is a separate channel and the two can disagree completely
 * (measured in this repo on 2026-09-03: nine assertions printing ❌ after a `process.exit`, suite
 * green). So the mapping lives here, where a test can drive every branch without an API, a clock,
 * or a filesystem, instead of being spread across `process.exit` calls no test ever reaches.
 *
 * PRECEDENCE IS LOAD-BEARING and ordered strictest-first:
 *   1. nothing scanned          → 2   a vacuous zero is not a zero
 *   2. paging not exhausted     → 2   the count is a floor, not a total
 *   3. gate mode, no baseline   → 2   a delta with no baseline is nothing measured
 *   4. gate mode                → 1 iff a loss appeared that the ledger had not recorded
 *   5. census mode              → 1 iff any loss stands at all
 *
 * ⚠️ 2 IS NEVER FOLDED INTO 0. A sweep that cannot see is not a sweep that found nothing — the
 * conflation this whole file exists to prevent, and one this repo has shipped before.
 *
 * @returns {0|1|2}
 */
export function verdictFor({ scanned, exhausted, gateNew = false, baselineOk = null, appearedCount = 0, standingLosses = 0 }) {
  if (!Number.isFinite(scanned) || scanned === 0) return 2;
  if (exhausted !== true) return 2;
  if (gateNew) {
    if (baselineOk !== true) return 2;
    return appearedCount > 0 ? 1 : 0;
  }
  return standingLosses > 0 ? 1 : 0;
}

/**
 * The human-readable delta block. Returns lines; the caller prints them.
 * Kept beside the logic so the wording and the verdict cannot drift apart.
 */
export function formatDelta({ appeared, resolved, carried }, { observedAt = null } = {}) {
  const L = [];
  L.push("");
  L.push(`  ── DELTA against the last recorded census${observedAt ? ` (${observedAt})` : ""} ──`);
  if (appeared.length === 0) {
    L.push(`  ✅ 0 NEW losses — every abandoned deploy here was already on the ledger (${carried.length} carried)`);
  } else {
    L.push(`  🚨 ${appeared.length} NEW abandoned deploy(s) since the last census — not previously recorded:`);
    for (const r of appeared) {
      L.push(`     ${r.id}  ${String(r.state ?? "?").padEnd(9)} ${r.created_at ?? "?"}  ${r.context ?? "?"}`);
    }
    L.push(`     ⭐ Each is a deploy somebody started and nobody finished — almost certainly a CLI`);
    L.push(`       killed mid-bundle. Nothing is broken by leaving it, but it is a change believed shipped.`);
  }
  if (resolved.length > 0) {
    L.push("");
    L.push(`  · ${resolved.length} previously-recorded loss(es) are no longer in limbo (cancelled, or reached ready):`);
    for (const id of resolved) L.push(`     ${id}`);
    L.push(`    ⚠️ A cancelled record reads as a deliberate cancel ever after and can never be counted`);
    L.push(`      as a loss again. The ledger line that named it is now the only evidence it existed.`);
  }
  return L;
}
