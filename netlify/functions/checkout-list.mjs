// checkout-list.mjs — a signed-in merchant lists THEIR OWN checkout orders. Reads the m:<merchant>:* index.
//
// ═══ THE GAP THIS CLOSES (live, 2026-09-19) ══════════════════════════════════════════════════════
// A merchant who lost the tab had no way to find a link again; ~10 open orders on prod were invisible.
// The index existed from day one (_checkout.mjs writes m:<merchantLower>:<orderId> on every create and
// transition) and nothing read it. This does.
//
// ⛔ WHOSE ORDERS: the prefix is derived from the VERIFIED SESSION's address — the same value
// checkout-create stored as `merchant` — and from nothing else. A `merchant` in the query or body is
// ignored, so a session cannot list anyone else's orders by asking. (verify-checkout-list)
//
// ⚠️ THE LISTING IS EVENTUAL. Blobs `list()` has no strong-consistency option; a link created seconds
// ago may not be listed yet. The response SAYS so (`note`), and the UI must never render an empty list
// as "you have no orders". A store that cannot list is 503 — never an empty list.
// [[absence-must-never-read-as-safe]] Nothing here moves money; nothing here writes.
import { connectBlobs } from "./_blobs.mjs";
import { getStore } from "@netlify/blobs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { CHECKOUT_STORE, merchantPrefix, merchantOrder, readLateNote, STATUS } from "./_checkout.mjs";

export const LIST_CAP = 100;
export const LISTING_NOTE = "this listing can lag by a few seconds — a link made moments ago may not be listed yet; absence of a row is not absence of an order";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "GET only" });
  if (event.blobs) connectBlobs(event);
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  // ⭐ THE ONLY SOURCE OF THE PREFIX. event.queryStringParameters / body are deliberately not read.
  const prefix = merchantPrefix(session.address);
  const store = getStore(CHECKOUT_STORE);
  let keys;
  try {
    const { blobs } = await store.list({ prefix });
    keys = (blobs || []).map((b) => b.key);
  } catch (e) {
    return json(503, { error: `orders unreadable — the store could not be listed (${e?.message ?? e}); try again` });
  }

  // The index carries the record, so one read per row; a row that fails to read is reported, not dropped
  // silently (a dropped row is an absence that reads as safe).
  const now = Date.now();
  const rows = [];
  const unreadable = [];
  for (const k of keys) {
    try {
      const rec = await store.get(k, { type: "json" });
      const row = merchantOrder(rec, now);
      if (!row) { unreadable.push(k.slice(prefix.length)); continue; }
      // A cancelled order may carry a LATE NOTE (a payment reported after the cancel — not verified).
      // Surfaced on the row so the merchant is told; null = readable absence; unreadable stays visible.
      row.lateReport = null;
      if (row.status === STATUS.CANCELLED) {
        const n = await readLateNote(rec.merchant, row.id);
        row.lateReport = n && !n.unreadable ? { txHash: n.txHash, by: n.by, at: n.at, verified: false } : n?.unreadable ? { unreadable: true } : null;
      }
      rows.push(row);
    } catch { unreadable.push(k.slice(prefix.length)); }
  }
  rows.sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  const total = rows.length;
  const truncated = total > LIST_CAP;
  return json(200, {
    orders: truncated ? rows.slice(0, LIST_CAP) : rows,
    total,
    truncated,
    ...(unreadable.length ? { unreadable } : {}),
    listedAt: new Date(now).toISOString(),
    note: LISTING_NOTE,
  });
}
