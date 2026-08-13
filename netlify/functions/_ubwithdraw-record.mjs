import { getStore } from "@netlify/blobs";

// UB WITHDRAWAL RECORDS — the thing that makes the second half of the exit FINDABLE.
//
// ═══ 🚨 THIS IS NOT BOOKKEEPING. IT IS THE DIFFERENCE BETWEEN (a) AND (c). ═══════════
// The exit is two on-chain calls ~7 days apart. Step 3 is driven by a SWEEPER, and a
// sweeper scans RECORDS, not the chain. So an initiation with no record is a clock
// running that nothing will ever finish — the user believes they are leaving and nobody
// completes it. That is precisely the half-built exit this design exists to avoid, and
// it arrives not by choosing (c) but by writing the record unreliably.
//
// ⭐ THEREFORE: PERSIST BEFORE THE ON-CHAIN CALL, never after. If the process dies between
// the two, the sweeper finds a record whose initiation may or may not have landed and can
// RECONCILE against the chain. The natural order (call, then record) loses exactly the
// case that costs the user their exit. Same inversion _dd-x402 and dd-watch both had to
// learn; this is the third time, so it is written down as a rule rather than a lesson.
//
// ═══ KEY LAYOUT — `o/<owner>/<withdrawalId>` ═════════════════════════════════════════
// One prefix answers "what has this owner got open", and a full list answers "what must
// the sweeper finish". Mirrors _bridge-receipts' `o/<owner>/<burnHash>` for the same
// reason: an owner-scoped read must never be a full-store scan filtered in memory.
//
// ⚠️ COUNTS ARE LOGGED, NOT INFERRED. "No withdrawals" and "the store could not be read"
// look identical from a caller's side, and the bridge work lost hours to exactly that.

export const STORE = "ub-withdrawals";
const store = () => getStore(STORE);

const norm = (a) => String(a || "").trim().toLowerCase();
export const key = (owner, id) => `o/${norm(owner)}/${id}`;

/**
 * Closed set. An unrecognised state is a programming error, never a new "done" case —
 * and never a reason for the sweeper to skip a record.
 */
export const STATE = Object.freeze({
  INITIATING: "initiating",   // record written, on-chain call NOT yet confirmed
  WAITING: "waiting",         // initiation landed; the delay is running
  COMPLETING: "completing",   // sweeper is mid-withdraw
  COMPLETED: "completed",     // funds are in the SCA (NOT yet the user's login wallet)
  FAILED: "failed",           // initiation never landed; nothing is running
});

/** States the sweeper must keep looking at. ⭐ INITIATING is included ON PURPOSE: a record
 *  stuck there is one whose on-chain call may have landed after the process died, and the
 *  only way to know is to ask the chain. Dropping it would strand exactly the case that
 *  persist-before-broadcast exists to preserve. */
export const OPEN_STATES = Object.freeze([STATE.INITIATING, STATE.WAITING, STATE.COMPLETING]);

/**
 * ⭐ WRITTEN BEFORE THE CHAIN CALL. Returns the record so the caller can pass its id into
 * the on-chain step and update it afterwards.
 */
export async function createRecord({ owner, amountUsdc, withdrawalId, now = () => new Date().toISOString() }) {
  if (!owner) throw new Error("createRecord requires an owner");
  if (!withdrawalId) throw new Error("createRecord requires a withdrawalId");
  const rec = {
    schema: "ub-withdrawal/1",
    withdrawalId,
    owner: norm(owner),
    amountUsdc: String(amountUsdc),
    state: STATE.INITIATING,
    createdAt: now(),
    updatedAt: now(),
    initiateTxHash: null,
    completeTxHash: null,
    // ⚠️ Set from the CHAIN's delay at initiation time, never from a constant — the delay is
    // a contract parameter and could change. Recorded so the estimate shown to the user is
    // reproducible after the fact.
    delayBlocks: null,
    approxDelayDays: null,
    // ⭐ WRITTEN, NOT REMEMBERED. The maturity date is the one fact a human needs a week from
    // now, and "derive it from createdAt + delayBlocks" is exactly the sort of thing nobody
    // does at the moment it matters. APPROXIMATE by construction — the delay is in BLOCKS, so
    // this drifts with block time and must never be shown as a precise deadline.
    maturesApprox: null,
    // ⭐ The honest end-state marker. `completed` means the funds reached the SCA; it does
    // NOT mean they reached the user. Anything rendering "your money is back" must consult
    // this, not the state alone.
    landedIn: null,
    stillNeedsAgentWithdraw: true,
    lastError: null,
    // ⭐ ALERT STATE ON THE RECORD, so a transition survives across sweeper ticks and a restart
    // cannot re-page. Same rule as dd-watch: lastAlertedAt advances ONLY on confirmed delivery,
    // so an undelivered alert is retried rather than suppressed by a window it never earned.
    overdueAlerted: false,
    lastAlertedAt: null,
  };
  await store().setJSON(key(owner, withdrawalId), rec);
  return rec;
}

/** Merge-update. Never blind-overwrites: a concurrent sweeper tick must not erase a field
 *  it did not set. Returns the merged record, or null if the record vanished. */
export async function patchRecord({ owner, withdrawalId, fields, now = () => new Date().toISOString() }) {
  const k = key(owner, withdrawalId);
  const prev = await store().get(k, { type: "json" }).catch(() => null);
  if (!prev) return null;
  const next = { ...prev, ...fields, updatedAt: now() };
  await store().setJSON(k, next);
  return next;
}

export async function readRecord({ owner, withdrawalId }) {
  return store().get(key(owner, withdrawalId), { type: "json" }).catch(() => null);
}

/**
 * Everything this owner has, newest first. ⭐ Returns COUNTS alongside the rows because
 * "you have no withdrawals" and "the store could not be read" are different answers to a
 * user asking where their money is, and only one of them is safe to render.
 */
export async function listByOwner({ owner }) {
  const prefix = `o/${norm(owner)}/`;
  try {
    const { blobs } = await store().list({ prefix });
    const rows = [];
    let skipped = 0;
    for (const b of blobs || []) {
      const r = await store().get(b.key, { type: "json" }).catch(() => null);
      if (r) rows.push(r); else skipped++;
    }
    rows.sort((a, z) => String(z.createdAt).localeCompare(String(a.createdAt)));
    return { readable: true, rows, matchedKeys: (blobs || []).length, returned: rows.length, skipped };
  } catch (e) {
    // ⭐ UNREADABLE ≠ EMPTY. The caller must not render this as "no withdrawals".
    return { readable: false, rows: [], matchedKeys: null, returned: 0, skipped: 0,
      error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * What the SWEEPER must act on: every open record across ALL owners.
 *
 * 🚨 AN UNREADABLE STORE IS NOT "NOTHING OPEN". It returns readable:false so the sweeper can
 * say so loudly instead of reporting a clean tick — a sweeper that treats a read failure as
 * an empty queue silently stops being a sweeper, and looks healthy while doing it.
 *
 * ⚠️ `limit` bounds one tick, and the REMAINDER IS REPORTED rather than dropped silently.
 * A cap that hides its own truncation reads as "we covered everything".
 */
export async function listAllOpen({ limit = 50 } = {}) {
  try {
    const { blobs } = await store().list({ prefix: "o/" });
    const all = blobs || [];
    const open = [];
    let scanned = 0, unreadable = 0;
    for (const b of all) {
      if (open.length >= limit) break;
      scanned++;
      const r = await store().get(b.key, { type: "json" }).catch(() => null);
      if (!r) { unreadable++; continue; }
      if (OPEN_STATES.includes(r.state)) open.push(r);
    }
    return {
      readable: true, open, scanned, unreadable,
      totalKeys: all.length,
      remaining: Math.max(0, all.length - scanned),
    };
  } catch (e) {
    return { readable: false, open: [], scanned: 0, unreadable: 0, totalKeys: null, remaining: null,
      error: String(e?.message ?? e).slice(0, 200) };
  }
}

/**
 * ═══ 🚨 DOES THIS RECORD BLOCK A NEW WITHDRAWAL? ════════════════════════════════════════════
 *
 * ⭐⭐ NOT THE SAME QUESTION AS `OPEN_STATES`, AND CONFLATING THEM LOCKS THE USER OUT.
 * `OPEN_STATES` answers "must the SWEEPER keep watching this?" — deliberately generous, because a
 * record it stops watching is a withdrawal nobody finishes. This answers "could this record be
 * running a CLOCK right now?" — and it must be narrower, because a false yes denies the exit
 * entirely.
 *
 * 🚨 THE COMPOSITION THAT PRODUCED THIS FUNCTION. The sweeper leaves an unconfirmable `initiating`
 * record in that state FOREVER, on purpose ("we cannot see it yet is not it did not happen"). The
 * 409 guard counted every OPEN_STATE as blocking. Each is correct alone; together, one stuck record
 * would block every future withdrawal, trip the overdue alert, and never clear — with no
 * user-facing way out. TWO CORRECT FEATURES COMPOSING INTO A DENIAL OF THE FEATURE, which is the
 * original "a pocket with no exit" rebuilt by the safety guard meant to protect it.
 *
 * ⭐ THE TRADE, STATED: a false NO risks two clocks (both usually complete; the bad case needs them
 * maturing in the same tick). A false YES is a PERMANENT LOCKOUT with no recourse. The lockout is
 * strictly worse, so this errs toward letting the user act.
 *
 * ⚠️ NOTHING IS DELETED OR MARKED FAILED HERE. The sweeper keeps watching a record this function
 * ignores — it stops holding the user hostage, it does not stop being reconciled.
 */
export const INITIATING_BLOCKS_MS = 60 * 60 * 1000; // 2 × the sweeper's 30-min period

export function blocksNewWithdrawal(rec, now = Date.now()) {
  if (!rec) return false;
  if (rec.state === STATE.WAITING || rec.state === STATE.COMPLETING) return true;
  if (rec.state !== STATE.INITIATING) return false;

  // ⭐⭐ PROVABLY NEVER BROADCAST — TWO INDEPENDENT REASONS, both certainties rather than heuristics:
  //   · ZERO units: `ubInitiateWithdrawal` throws on `units > 0n` BEFORE calling the chain, so a
  //     sub-atomic record (`Math.round(0.0000001 * 1e6) === 0`) cannot have started anything.
  //   · ABSENT units: ub-withdraw.mjs writes `amountAtomic` (line ~193) BEFORE the chain call
  //     (~200), so a record still carrying `null` died in between — the call had not been made.
  // ⚠️ This ordering is load-bearing. If a future edit moves the chain call ahead of the amount
  // patch, an absent amountAtomic would stop proving anything and this must change with it.
  let units = null;
  try { units = BigInt(rec.amountAtomic ?? "0"); } catch { units = 0n; }
  if (units <= 0n) return false;

  // ⚠️ A FRESH `initiating` DOES block: the chain call may have landed and the sweeper has not yet
  // had a tick to reconcile it. Bounded at 2× the sweeper period — past that, the sweeper has
  // looked at least twice and found nothing, so continuing to block is a lockout rather than
  // caution.
  const started = Date.parse(rec.createdAt ?? "");
  if (!Number.isFinite(started)) return true; // unknown age ⇒ assume fresh, the cautious side
  return now - started < INITIATING_BLOCKS_MS;
}

/**
 * ⭐⭐ IS THIS RECORD OVERDUE? — the alert discriminator.
 *
 * 🚨 NOT "did completion fail". A single failed tick is normal: RPC blips, Circle 500s, and the
 * contract itself refuses a premature withdraw. Alerting on that would page every 30 minutes
 * through a perfectly healthy week and train everyone to ignore it — the ack-gate failure, and
 * the same reason dd-watch keys on REASON + DURATION rather than on the refusal itself.
 *
 * ⭐ THE REAL SIGNAL IS TIME PAST MATURITY. A withdrawal that should have completed and has not
 * is a user's money behind an expired clock — and the product told them it completes
 * automatically. That is the worst state this feature has, so it is the one that pages.
 *
 * ⚠️ GRACE EXISTS BECAUSE MATURITY IS APPROXIMATE. `maturesApprox` is derived from a BLOCK count
 * at a measured block time; real maturity drifts. A grace shorter than that drift would page on
 * arithmetic rather than on a problem.
 */
export const OVERDUE_GRACE_MS = 6 * 60 * 60 * 1000; // 6h against a ~7-day delay

export function isOverdue(rec, now = Date.now()) {
  if (!rec || rec.state === STATE.COMPLETED || rec.state === STATE.FAILED) return false;
  const m = Date.parse(rec.maturesApprox ?? "");
  // ⭐ NO maturesApprox ⇒ NOT overdue. An unknown maturity is not an expired one, and guessing
  // here would page on every legacy record ever written.
  if (!Number.isFinite(m)) return false;
  return now > m + OVERDUE_GRACE_MS;
}

/** The sweeper's own liveness marker. ⭐ Written EVERY tick, including clean ones, so that its
 *  ABSENCE is detectable by something other than itself — an alarm inside the thing that goes
 *  quiet inherits the silence it is supposed to break. */
export async function writeHeartbeat(fields = {}) {
  await store().setJSON("heartbeat", { at: new Date().toISOString(), ...fields }).catch(() => {});
}
export async function readHeartbeat() {
  return store().get("heartbeat", { type: "json" }).catch(() => null);
}
