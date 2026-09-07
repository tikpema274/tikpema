// discover-cursor.mjs — where the last COMPLETE discovery scan finished.
//
// ═══ ⭐⭐ WHY A CURSOR AT ALL ══════════════════════════════════════════════════════════════════
// The hand-run scan covers 1.5M blocks in 151 windows and takes minutes, because Arc caps
// eth_getLogs at 10,000 blocks and throttles ("Request exceeds defined limit" — MEASURED as a
// throttle: the failing windows MOVE between runs). Rescanning that every 10 minutes would be
// absurd and would guarantee throttling. With a cursor a tick scans only what is new: at 0.514s
// blocks a 10-minute interval is ~1,167 blocks — a fraction of ONE window.
//
// ═══ ⛔⛔ AN UNREADABLE TICK MUST NOT ADVANCE THE CURSOR ═══════════════════════════════════════
// This is not a new rule and it is not reinvented here: `sweepVerdict` already decides it, and this
// module consumes that decision. A partial scan that advanced would skip blocks NOBODY EVER READ,
// permanently and silently — the absence-reads-as-safe failure with persistence attached. The
// backlog growing is the correct behaviour when the chain cannot be read; it is visible as lag.
//
// ⚠️ AND A STUCK CURSOR IS AN ALARM, NOT A STEADY STATE. If reads keep failing the cursor stops and
// the lag grows without bound. `cursorLag` is reported on every tick precisely so "we are not
// scanning" cannot look like "there is nothing to scan".

/** Arc's eth_getLogs cap. Windows are inclusive, so 10,000 blocks is `from + 9999`. */
export const WINDOW = 10000n;
/** Per tick. ~4.3h of Arc at 0.514s/block — enough to catch up after an outage without a long run. */
export const MAX_WINDOWS_PER_TICK = 3;
/** ⛔ A COLD START DOES NOT CLAIM HISTORY. With no cursor there is no honest way to say how far back
 *  we have looked, so it scans ONE window and says so. Backfilling history is a deliberate, bounded
 *  operation (scripts/bridge-discover-run.mjs), never something a cron quietly asserts it has done. */
export const COLD_START_WINDOWS = 1;

export const CURSOR_KEY = "bridge-discover/cursor";

/**
 * What this tick should scan.
 * @returns {{from: bigint, to: bigint, coldStart: boolean, nothingToDo: boolean, lag: bigint}}
 */
export function nextScanRange({ cursor, head, maxWindows = MAX_WINDOWS_PER_TICK,
                                coldStartWindows = COLD_START_WINDOWS } = {}) {
  const h = BigInt(head);
  const span = WINDOW * BigInt(maxWindows);
  const parsed = cursor == null || cursor === "" ? null : BigInt(cursor);
  if (parsed == null) {
    const from = h - WINDOW * BigInt(coldStartWindows) + 1n;
    return { from: from < 0n ? 0n : from, to: h, coldStart: true, nothingToDo: false, lag: 0n };
  }
  const from = parsed + 1n;
  if (from > h) return { from, to: h, coldStart: false, nothingToDo: true, lag: 0n };
  const to = from + span - 1n > h ? h : from + span - 1n;
  return { from, to, coldStart: false, nothingToDo: false, lag: h - parsed };
}

/**
 * ⭐ THE ADVANCE IS THE VERDICT'S DECISION, NOT A SECOND JUDGEMENT. Pass `sweepVerdict`'s output
 * straight in. The cursor moves to the last block of a FULLY served range and nowhere else.
 * ⚠️ It never moves BACKWARD: a stale or re-run tick must not un-scan blocks already covered.
 */
export function nextCursor({ current, scannedTo, advanceCursor }) {
  if (!advanceCursor) return { cursor: current ?? null, moved: false, reason: "tick was not complete" };
  const to = BigInt(scannedTo);
  if (current != null && BigInt(current) >= to) {
    return { cursor: String(current), moved: false, reason: "cursor is already at or beyond this range" };
  }
  return { cursor: String(to), moved: true, reason: null };
}
