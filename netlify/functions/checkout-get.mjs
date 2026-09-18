// checkout-get.mjs — PUBLIC read of one order by id. The buyer may not be signed in yet; a checkout
// link must be readable before the wallet exists ("door, not wall"). The public view names the payee
// (that is the disclosure), the amount, the description, and the status — including `submitted`,
// which is NOT paid, and `expired`, derived from the clock.
//
// STRONG read: a cached `open` beside a fresh `paid` is a double payment invited. `connectBlobs`
// first or the strong read throws. An unreadable store is 503, never 404 — absence is not safe.
import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { safeOrderId, readOrder, publicOrder } from "./_checkout.mjs";

export async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "GET only" });
  if (event.blobs) connectBlobs(event);
  const id = safeOrderId(event.queryStringParameters?.id || "");
  if (!id) return json(400, { error: "a well-formed order id is required" });
  const { order, readable } = await readOrder(id);
  if (!readable) return json(503, { error: "order store unreadable — try again" });
  if (!order) return json(404, { error: "no such order" });
  return json(200, { order: publicOrder(order) });
}
