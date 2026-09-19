// checkout-create.mjs — a signed-in user creates an order: "pay ME this much for THIS".
//
// The merchant IS the session's login wallet (`session.address`) — the same identity Receive shows
// as "your address". Decided 2026-09-18: payTo = login wallet, any signed-in user may sell. The
// amount is refused above the per-transaction send cap HERE, with the cap named, because an order
// nobody can pay is a defect at creation, not at payment. Nothing here moves money.
//
// ⭐ `createdAtBlock` (2026-09-19): the Arc head at creation is recorded on the order, and a payment
// must be mined AFTER it (`_checkout-verify.mjs`). If the head cannot be read the order is NOT created:
// an order without a block is one no transfer could ever be bound to — the same "defect at creation"
// as an amount over the cap, and a 503 here costs nobody anything. [[absence-must-never-read-as-safe]]
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody, sendCapUsdc } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { buildOrder, writeNewOrder, publicOrder } from "./_checkout.mjs";
import { fetchBlockNumber } from "./_checkout-verify.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { amountUsdc, description } = parseBody(event);
  const head = await fetchBlockNumber();
  if (head.unreadable) return json(503, { error: `could not read Arc's block height (${head.unreadable}) — refusing to create an order no payment could be bound to; try again` });
  const built = buildOrder({ merchant: session.address, amountUsdc, description, capUsdc: sendCapUsdc(), createdAtBlock: head.blockNumber });
  if (built.error) return json(400, { error: built.error, ...(built.cap != null ? { cap: built.cap } : {}) });

  let w;
  try { w = await writeNewOrder(built.order); }
  catch (e) { return json(503, { error: `order store unavailable: ${e?.message ?? e}` }); }
  if (!w.ok) return json(503, { error: w.reason });

  // The link is a HASH route on whatever origin served the page; the client composes it from
  // window.location.origin. The server returns the path so the two can never disagree on the id.
  return json(200, { order: publicOrder(built.order), path: `/#/pay?order=${built.order.id}` });
}
