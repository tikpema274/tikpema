// share-limit.mjs — piece 5 step 3: how many shares may the mandate's exit redeem? Pure.
// Design: PROGRESS "FOR THE EXECUTOR PIECE: BEYOND_MANDATE_SHARES" + Finding B (T), 2026-09-28/29.
//
// ═══ THE MANDATE'S SHARES, NEVER THE WALLET'S ═══════════════════════════════════════════════════════
// The limit is min(tracked, live):
//   · tracked (record.progress.sharesTrackedRaw) — what the mandate's own deposits established. It is the mandate's
//     AUTHORITY: no live figure, however large, raises the limit above it. Shares the user deposited by hand are in the
//     wallet but were never the mandate's; they stay.
//   · live (the wallet's balanceOf, read on both endpoints) — what is actually there. Below tracked means some of the
//     mandate's shares are already gone (e.g. the user's manual reclaim); the exit cannot redeem what is not there.
//
// ⭐ 0 IS AN ANSWER, NOT AN ERROR. A mandate that tracks 0 (it never deposited) has nothing of its own to redeem, however
//   many shares the wallet holds. Today's live case: the operator mandate tracks 0 and the wallet holds 1009998 manual
//   shares → the limit is 0, an exit redeems nothing, and `notTheMandates` says why the 1009998 are left alone.
//
// ⛔ A GAP IS NEVER READ AS 0. sharesTrackedGaps counts deposits whose shares could not be established; with any gap the
//   tracked figure is only a LOWER bound and the mandate's true holding is unknown → refused. A missing, non-integer or
//   negative gap count is UNKNOWN, not "no gaps" → refused too. Likewise an unreadable tracked or live figure: refused,
//   never 0. A refusal carries no `shares` field, so nothing downstream can mistake it for a limit.

export const SHARE_LIMIT_REFUSED = Object.freeze({
  TRACKED_UNKNOWN: "tracked-unknown",
  GAPS_UNKNOWN: "gaps-unknown",
  TRACKED_HAS_GAPS: "tracked-has-gaps",
  LIVE_UNKNOWN: "live-unknown",
});

const DEC = /^(0|[1-9]\d*)$/;
/** ⛔ The ONE test of a gap count, shared with exit-outcome.mjs: a non-negative integer, or UNKNOWN (never 0). */
export const isKnownGapCount = (v) => Number.isInteger(v) && v >= 0;
// A refusal must never THROW on the value it refuses (JSON.stringify throws on a bigint). Shared with exit-outcome.mjs.
export const shown = (v) => (typeof v === "bigint" ? `${v}n (a bigint, not the stored decimal string)` : v === undefined ? "absent" : (() => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } })());
const refuse = (code, why) => ({ ok: false, code, why });

/**
 * @param {{sharesTrackedRaw:string, sharesTrackedGaps:number, liveShares:bigint|string}} a
 * @returns {{ok:true, shares:string, tracked:string, live:string, nothingToRedeem:boolean, notTheMandates:string,
 *            trackedNotRedeemable:string} | {ok:false, code:string, why:string}}
 */
export function mandateShareLimit({ sharesTrackedRaw, sharesTrackedGaps, liveShares } = {}) {
  // tracked: the record stores a decimal string; nothing else is accepted (a JS number could already be rounded)
  if (typeof sharesTrackedRaw !== "string" || !DEC.test(sharesTrackedRaw)) {
    return refuse(SHARE_LIMIT_REFUSED.TRACKED_UNKNOWN, `the mandate's tracked shares are not a readable figure (${shown(sharesTrackedRaw)}); nothing may be redeemed against it`);
  }
  if (!isKnownGapCount(sharesTrackedGaps)) {
    return refuse(SHARE_LIMIT_REFUSED.GAPS_UNKNOWN, `the tracked figure's gap count is unknown (${shown(sharesTrackedGaps)}); an unknown count is not zero, so the tracked figure cannot be trusted as exact`);
  }
  if (sharesTrackedGaps > 0) {
    return refuse(SHARE_LIMIT_REFUSED.TRACKED_HAS_GAPS, `${sharesTrackedGaps} of the mandate's deposits could not be established, so ${sharesTrackedRaw} is only a lower bound on its shares; the true figure is unknown`);
  }
  let live = null;
  if (typeof liveShares === "bigint" && liveShares >= 0n) live = liveShares;
  else if (typeof liveShares === "string" && DEC.test(liveShares)) live = BigInt(liveShares);
  if (live === null) {
    return refuse(SHARE_LIMIT_REFUSED.LIVE_UNKNOWN, "the wallet's live share balance could not be read (or both endpoints did not agree); an unread balance is not zero");
  }
  const tracked = BigInt(sharesTrackedRaw);
  const shares = tracked < live ? tracked : live;
  return {
    ok: true,
    shares: shares.toString(),
    tracked: tracked.toString(),
    live: live.toString(),
    nothingToRedeem: shares === 0n,
    // In the wallet but never the mandate's (deposited by hand): left alone by the exit.
    notTheMandates: (live > shares ? live - shares : 0n).toString(),
    // The mandate's shares already gone before the exit (e.g. a manual reclaim).
    trackedNotRedeemable: (tracked > shares ? tracked - shares : 0n).toString(),
  };
}

/** The same limit, read from a stored mandate record's progress. A record without progress refuses (TRACKED_UNKNOWN). */
export function shareLimitForRecord(record, liveShares) {
  const p = record?.progress;
  return mandateShareLimit({ sharesTrackedRaw: p?.sharesTrackedRaw, sharesTrackedGaps: p?.sharesTrackedGaps, liveShares });
}
