// discover-cursor.mjs — where the last COMPLETE discovery scan finished.
//
// ═══ ⭐⭐ WHY A CURSOR AT ALL ══════════════════════════════════════════════════════════════════
// The hand-run scan covers 1.5M blocks in 151 windows and takes minutes, because Arc caps
// eth_getLogs at 10,000 blocks and throttles ("Request exceeds defined limit" — MEASURED as a
// throttle: the failing windows MOVE between runs). Rescanning that every 10 minutes would be
// absurd and would guarantee throttling. With a cursor a tick scans only what is new — a fraction
// of ONE window.
//
// ⚠️ ARC'S BLOCK RATE VARIES — DO NOT DERIVE ANYTHING FROM A SINGLE FIGURE. Measured 2026-09-07
// over four spans ending at block 60,879,952, plus a live 90s wall-clock sample:
//     last 1,000 blocks   0.757 s/block        last 100,000     0.536 s/block
//     last 10,000 blocks  0.650 s/block        last 1,000,000   0.533 s/block
//     live (120 blocks in 90s)                 0.752 s/block
// So a 10-minute tick is roughly 790-1,130 blocks depending on when you ask. ⭐ NOTHING HERE
// DEPENDS ON THE NUMBER: the per-tick window count is a constant, not a derivation, and even the
// slowest observed rate leaves a tick far inside ONE 10,000-block window. The figure is here to
// explain why a cursor makes this cheap, not to be computed with.
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

// ═══ ⭐⭐ ARC CAPS `eth_getLogs` TWICE, AND ONLY ONE OF THEM IS ABOUT BLOCKS ═══════════════════
// Re-measured 2026-09-10, because the figure below was carrying an error code Arc no longer returns.
//
//   1. A RANGE cap  — `-32012 requested range too large` above 10,000 blocks. This is what WINDOW
//      is sized against, and it is unchanged.
//   2. A RESULT cap — `-32602 request exceeded max allowed range: query exceeds max results 20000`.
//      ⚠️ THIS ONE FIRES ON A CORRECTLY-SIZED WINDOW. A 10,000-block request is not automatically
//      safe; it is safe only while its FILTER keeps the match count under 20,000.
//
// ⛔ THE OLD COMMENT SAID `-32614`, AND NOTHING RETURNS THAT ANY MORE. It was repeated in four
// files. Nothing ever branched on it — every use was prose — so no handler went dead, but a reader
// diagnosing a live failure would have been looking for the wrong string, and the single-cap framing
// hid the second cap entirely.
//
// ⭐ MEASURED HEADROOM, so the next reader knows how much room exists rather than guessing:
// the discovery filter (USDC address + Transfer topic0 + `to: BRIDGE_CONTRACT`) returned
// **611 logs** over a 10k window at head and **977** at head-5,000,000 — against a 20,000 cap, so
// ~20-30x. The live query narrows further still by `from: owners`, so the real count is lower.
// ⛔ AND WHAT WOULD CONSUME IT: dropping the `to:` topic. MEASURED on the SAME window, the same
// address query without that constraint returns `-32602`. The selectivity is not incidental — it is
// what keeps a correctly-sized window under the second cap. `from: owners` is an OR-array, so the
// match count also grows with the owner set; that is the slow way to arrive at the same failure.
//
// ⚠️ AND THE FAILURE IS A STALL, NOT AN ERROR ANYONE SEES. `sweepVerdict` correctly refuses to
// advance the cursor on an unreadable tick (above), so a window that can never succeed would be
// retried every tick forever and discovery would silently stop — visible only as `cursorLag`
// growing. That is why the headroom is written down instead of assumed.
//
// ⭐ IF IT EVER DOES FIRE, THE ERROR IS ACTIONABLE: `-32602` names the safe sub-range in its own
// message (`retry with the range 61378356-61380259`). A handler could halve or adopt that range
// rather than stall. NOT BUILT — with 20-30x headroom that would be untested money-path code for a
// condition that cannot currently occur, and an unexercised retry path is its own hazard.

/** Arc's eth_getLogs RANGE cap. Windows are inclusive, so 10,000 blocks is `from + 9999`.
 *  ⚠️ See above: this bounds BLOCKS only. The 20,000-RESULT cap is bounded by the filter. */
export const WINDOW = 10000n;
/** Per tick. 30,000 blocks ≈ 4-6h of Arc at the rates measured above — enough to catch up after an
 *  outage without a long run. ⚠️ A CONSTANT, deliberately, not a figure derived from block time:
 *  deriving it would make tick cost move with chain speed, which is the one thing a bounded tick
 *  exists to prevent. */
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
