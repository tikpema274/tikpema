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
    // ⭐ The honest end-state marker. `completed` means the funds reached the SCA; it does
    // NOT mean they reached the user. Anything rendering "your money is back" must consult
    // this, not the state alone.
    landedIn: null,
    stillNeedsAgentWithdraw: true,
    lastError: null,
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
