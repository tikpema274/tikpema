// checkout-create.mjs — a signed-in user creates an order: "pay ME this much for THIS".
//
// The merchant IS the session's login wallet (`session.address`) — the same identity Receive shows
// as "your address". Decided 2026-09-18: payTo = login wallet, any signed-in user may sell. The
// amount is refused above the per-transaction send cap HERE, with the cap named, because an order
// nobody can pay is a defect at creation, not at payment. Nothing here moves money.
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody, sendCapUsdc } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { buildOrder, writeNewOrder, publicOrder } from "./_checkout.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { amountUsdc, description } = parseBody(event);
  const built = buildOrder({ merchant: session.address, amountUsdc, description, capUsdc: sendCapUsdc() });
  if (built.error) return json(400, { error: built.error, ...(built.cap != null ? { cap: built.cap } : {}) });

  let w;
  try { w = await writeNewOrder(built.order); }
  catch (e) { return json(503, { error: `order store unavailable: ${e?.message ?? e}` }); }
  if (!w.ok) return json(503, { error: w.reason });

  // The link is a HASH route on whatever origin served the page; the client composes it from
  // window.location.origin. The server returns the path so the two can never disagree on the id.
  return json(200, { order: publicOrder(built.order), path: `/#/pay?order=${built.order.id}` });
}
