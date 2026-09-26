// recovery.mjs — "did this intent's deposit happen?", answered from the chain. Pure: the caller reads.
//
// ═══ RECOVERY READS THE CHAIN, NEVER RESUBMITS ══════════════════════════════════════════════════
// A tick can die between the deposit and its assertion. The intent (create-only, written BEFORE any
// signing) is what survives, and the next tick classifies it before anything else for that mandate:
//   DEPOSITED — ANY ONE positive is enough: Circle reports the deposit tx COMPLETE, or the vault emitted
//               a Deposit event for our SCA after the anchor block, or the SCA's shares are above
//               sharesBefore. → take the hash (if any), run the assertion, commit.
//   NOT-DEPOSITED — ONLY when EVERY instrument answered negative: Circle FAILED or no id recorded, the
//               event scan ran and found none, shares read and not above sharesBefore, AND the intent is
//               older than the deadline (a slow userOp is not a failed one).
//   PENDING   — all negative so far, but Circle still pending or the deadline has not passed.
//   UNREADABLE — an instrument failed. ⛔ NEVER read as "not deposited": that would free the window for a
//               second deposit while the first may have landed. It stays open and blocks the mandate;
//               after RECOVERY_MAX_TRIES the mandate pauses INCONCLUSIVE.
//
// ⚠️ A RESIDUAL, STATED RATHER THAN HIDDEN: a Circle tx created but never recorded (the tick died between
// Circle accepting it and the onSubmitted hook writing its id) is invisible to the Circle leg. If it is
// stuck longer than the deadline and lands later, "not-deposited" was wrong. The window is narrow (the
// hook runs on the line after the create call), the next deposit is ≥ 24 h away (MANDATE_MIN_CADENCE_MS),
// and a later landing would still show in the share balance and the Deposit event at that next check.

/** An intent younger than this is never declared not-deposited. Chosen, not measured (Circle's own wait is 60 s). */
export const RECOVERY_NOT_DEPOSITED_AFTER_MS = 30 * 60 * 1000;
/** Unreadable this many ticks in a row → pause INCONCLUSIVE (the intent still blocks; nothing is guessed). */
export const RECOVERY_MAX_TRIES = 12;

export const RECOVERY_STATE = Object.freeze({
  DEPOSITED: "deposited", NOT_DEPOSITED: "not-deposited", PENDING: "pending", UNREADABLE: "unreadable",
});

const asBig = (v) => (typeof v === "bigint" ? v : typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

/**
 * @param {{intent:object, now:number, facts:{
 *   circle: {state:"COMPLETE"|"FAILED"|"PENDING"|"NONE", txHash?:string}|null,   null = could not be read
 *   event:  {found:boolean, txHash?:string}|null,                                null = the scan failed
 *   shares: bigint|null }}} a                                                     null = could not be read
 */
export function classifyIntent({ intent, facts, now }) {
  const f = facts ?? {};
  const before = asBig(intent?.sharesBefore);
  const circle = f.circle ?? null, event = f.event ?? null;
  const shares = typeof f.shares === "bigint" ? f.shares : null;

  // ── any ONE positive establishes the deposit ──
  if (circle?.state === "COMPLETE") return { state: RECOVERY_STATE.DEPOSITED, txHash: circle.txHash ?? event?.txHash ?? null, by: "circle-complete" };
  if (event?.found === true) return { state: RECOVERY_STATE.DEPOSITED, txHash: event.txHash ?? null, by: "deposit-event" };
  if (shares !== null && before !== null && shares > before) return { state: RECOVERY_STATE.DEPOSITED, txHash: null, by: "share-delta" };

  // ── a negative needs EVERY instrument to have answered ──
  const missing = [];
  if (circle === null || !["FAILED", "NONE", "PENDING"].includes(circle.state)) missing.push("Circle's transaction state");
  if (event === null || event.found !== false) missing.push("the Deposit event scan");
  if (shares === null) missing.push("the share balance");
  if (before === null) missing.push("the intent's sharesBefore");
  if (missing.length) return { state: RECOVERY_STATE.UNREADABLE, why: `could not read ${missing.join(", ")}` };

  const created = Date.parse(intent?.createdAt ?? "");
  if (!Number.isFinite(created)) return { state: RECOVERY_STATE.UNREADABLE, why: "the intent has no creation time" };
  if (circle.state === "PENDING") return { state: RECOVERY_STATE.PENDING, why: "Circle reports the deposit still pending" };
  if (now - created <= RECOVERY_NOT_DEPOSITED_AFTER_MS) return { state: RECOVERY_STATE.PENDING, why: "no deposit seen yet, and the intent is younger than the deadline" };
  return { state: RECOVERY_STATE.NOT_DEPOSITED, by: `Circle ${circle.state}, no Deposit event, no share delta, older than the deadline` };
}
