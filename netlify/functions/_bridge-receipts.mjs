import { getStore } from "@netlify/blobs";

// DIRECT-PATH BRIDGE RECEIPTS — the server's own record that money is in flight.
//
// ── WHY A SERVER-SIDE STORE AND NOT localStorage ──────────────────────────────────
// The direct BridgePanel path used to keep `burnHash` in component useState. A reload
// stranded the user with funds mid-flight and no way to ask about them. localStorage
// would fix the reload and nothing else: under it the SYSTEM never knows funds are
// outstanding, so server-side notification of a stall is impossible to add later.
// Tikpema's differentiator is a verifiable record of what actually happened with the
// money — that record cannot live only in the user's browser.
//
// ── THE KEY IS AN INDEX, NOT A SECOND TRUTH ───────────────────────────────────────
// Key layout `o/<owner>/<burnHash>` makes "list what this owner has open" ONE prefix
// list instead of a scan plus a filter. Both key components are ALSO fields on the
// record, so the key is derivable from the record and is cross-checked on read — it is
// an index over the truth, never a second copy of it. (A separate owner→burnHash index
// blob would be a second copy, and second copies drift.)
//
// ── EVENTUAL CONSISTENCY IS LOAD-BEARING HERE ─────────────────────────────────────
// Blobs reads are eventually consistent (~11s measured elsewhere in this repo). TWO
// seams bite:
//   1. the settler's first read of a receipt the burn handler just wrote
//   2. the client's first list immediately after the burn returns
// Both use readWithRetry / a bounded poll. ⚠️ A 404 IS NOT TERMINAL inside that window
// — concluding "absent" from one miss is exactly the bug that stranded jobs #155262
// and #155315 on the plan path.

export const BRIDGE_RECEIPTS_STORE = "bridge-receipts";

/** Terminal states release the in-flight lease and stop all polling. */
export const TERMINAL_STATES = new Set(["minted", "mint_failed", "mint_unconfirmed", "mint_unverified"]);

/** How long a forwarded mint gets before we stop claiming it is merely "still going".
 *  4 minutes, matching MAX_POLLS×POLL_MS on the plan path, so BOTH flows tell the user
 *  the same story at the same time. */
export const MINT_DEADLINE_MS = 4 * 60 * 1000;

/** Bounded read retry — sized past the ~11s consistency window, same as the plan path. */
const READ_TRIES = 10;
const READ_DELAY_MS = 1500; // 10 × 1.5s = 15s > ~11s

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const norm = (a) => String(a || "").toLowerCase();

/** `o/<owner>/<burnHash>` — see "THE KEY IS AN INDEX" above. */
export function receiptKey(owner, burnHash) {
  return `o/${norm(owner)}/${norm(burnHash)}`;
}

function store() {
  return getStore(BRIDGE_RECEIPTS_STORE);
}

// ══════════════════════════════════════════════════════════════════════════════════
// THE WRITE THAT MUST NEVER THROW
// ══════════════════════════════════════════════════════════════════════════════════
// This runs on the bridge execution path AFTER the Arc burn has already landed. The
// money is GONE by the time we are called. If a Blobs hiccup here propagated, the
// handler would answer "bridge failed" for a bridge that in fact succeeded — the worst
// lie available on this path, because the user would reasonably retry and burn twice.
//
// So: every failure is swallowed and logged. A missing receipt degrades the UI to what
// it did before receipts existed (no durable record, poll-by-hand) — strictly better
// than a false failure. The return value says whether it landed; NO CALLER MAY BRANCH
// ON IT into an error response.
//
// ⚠️ We AWAIT the single setJSON rather than firing it un-awaited: a Netlify function
// can freeze the moment the handler returns, and an un-awaited write may simply never
// happen. Awaiting one small write costs ~100ms. What we must NOT do here is the
// 4-minute poll — that is the settler's job, off this request.
export async function writeReceiptNeverThrows(receipt) {
  try {
    if (!receipt?.owner || !receipt?.burnHash) {
      console.warn("[bridge-receipt] refusing to write a receipt with no owner/burnHash");
      return { written: false, reason: "missing_key_fields" };
    }
    await store().setJSON(receiptKey(receipt.owner, receipt.burnHash), receipt);
    return { written: true };
  } catch (e) {
    // Swallowed ON PURPOSE. See the block comment above.
    console.error(`[bridge-receipt] WRITE FAILED (swallowed) burnHash=${receipt?.burnHash} — ${e?.message}`);
    return { written: false, reason: "write_error", detail: e?.message };
  }
}

/** Save from the settler. MAY throw — the settler is a background function with no user
 *  waiting on it, so a failed write there should surface, not hide. */
export async function saveReceipt(receipt) {
  await store().setJSON(receiptKey(receipt.owner, receipt.burnHash), receipt);
}

/** Single read, no retry. Returns null on miss OR on store error — callers that care
 *  about the difference should use readWithRetry and check `storeError`. */
export async function readReceipt(owner, burnHash) {
  try {
    return await store().get(receiptKey(owner, burnHash), { type: "json" });
  } catch {
    return null;
  }
}

/** Bounded poll for a receipt that may not be visible yet. A 404 inside the window is
 *  NOT terminal. Returns { receipt, attempts, waitedMs, marginMs } — receipt null if it
 *  never appeared. */
export async function readWithRetry(owner, burnHash) {
  const t0 = Date.now();
  for (let i = 0; i < READ_TRIES; i++) {
    if (i) await sleep(READ_DELAY_MS);
    const r = await readReceipt(owner, burnHash);
    if (r) {
      const waitedMs = Date.now() - t0;
      const marginMs = READ_TRIES * READ_DELAY_MS - waitedMs;
      if (marginMs < 3000) {
        console.warn(`[bridge-receipt] ⚠️ NARROW MARGIN burnHash=${burnHash} — only ${marginMs}ms of retry window left`);
      }
      return { receipt: r, attempts: i + 1, waitedMs, marginMs };
    }
  }
  const waitedMs = Date.now() - t0;
  console.warn(`[bridge-receipt] READ GAVE UP burnHash=${burnHash} after ${READ_TRIES} attempts / ${waitedMs}ms`);
  return { receipt: null, attempts: READ_TRIES, waitedMs, marginMs: 0 };
}

/** Every receipt for one owner, newest first. Prefix list — never a full-store scan.
 *  Fails SOFT (returns []) because this feeds a read-only panel: a listing error must
 *  not take the bridge UI down. `degraded` distinguishes "you have none" from "we could
 *  not look" so the caller can say so rather than render an empty list as certainty. */
export async function listByOwner(owner) {
  try {
    const { blobs } = await store().list({ prefix: `o/${norm(owner)}/` });
    const out = [];
    for (const b of blobs || []) {
      try {
        const r = await store().get(b.key, { type: "json" });
        // Cross-check the index against the truth it indexes.
        if (r && norm(r.owner) === norm(owner)) out.push(r);
      } catch {
        /* one unreadable blob must not sink the list */
      }
    }
    out.sort((a, b) => String(b.burnedAt || "").localeCompare(String(a.burnedAt || "")));
    return { receipts: out, degraded: false };
  } catch (e) {
    console.error(`[bridge-receipt] LIST FAILED owner=${owner} — ${e?.message}`);
    return { receipts: [], degraded: true };
  }
}

/** Has this receipt outlived its mint deadline? Pure, so the fault-injection suite can
 *  drive it without waiting 4 real minutes. */
export function isPastDeadline(receipt, now = Date.now()) {
  const burnedAt = Date.parse(receipt?.burnedAt || "");
  if (!Number.isFinite(burnedAt)) return false; // unknown burn time ⇒ never auto-escalate
  return now - burnedAt >= MINT_DEADLINE_MS;
}
