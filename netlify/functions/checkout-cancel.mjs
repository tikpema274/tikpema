// checkout-cancel.mjs — the MERCHANT voids an OPEN order they created. Session-authed; the record decides.
//
// ═══ WHO ═════════════════════════════════════════════════════════════════════════════════════════
// The merchant is the address in the VERIFIED session token, compared against the RECORD's `merchant`
// (what checkout-create stored from ITS session). A `merchant` field in the body is ignored; the id
// authorises nothing. Any other session — a buyer, anyone — is 403.
//
// ═══ WHAT (the matrix) ═══════════════════════════════════════════════════════════════════════════
//   open (bound or unbound legacy) → cancelled           200
//   cancelled                      → already cancelled   200, NO write (idempotent)
//   submitted (a circleId: money IN FLIGHT)              409 — let it land or fail; cancelling here
//                                                        maximises "a payment landed on a dead order"
//   paid                                                  409 — never; a refund is the merchant sending it back
//   expired (derived)                                     409 — already unpayable; nothing to write
// The write goes through transitionOrder (CAS): a cancel that loses to a concurrent payment is refused
// with the re-read order ("order is paid, not open") and the payment survives. Nothing here moves money.
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { safeOrderId, readOrder, transitionOrder, publicOrder, effectiveStatus, STATUS } from "./_checkout.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });
  const id = safeOrderId(parseBody(event).id || "");
  if (!id) return json(400, { error: "a well-formed order id is required" });

  const { order, readable } = await readOrder(id);
  if (!readable) return json(503, { error: "order store unreadable — nothing was changed; try again" });
  if (!order) return json(404, { error: "no such order" });
  if (String(order.merchant).toLowerCase() !== String(session.address).toLowerCase()) {
    return json(403, { error: "not your order — only the wallet that created a checkout link can cancel it" });
  }

  const status = effectiveStatus(order);
  if (status === STATUS.CANCELLED) return json(200, { order: publicOrder(order), note: "already cancelled" });
  if (status === STATUS.PAID) return json(409, { error: "this order is paid and cannot be cancelled — if you owe the buyer a refund, that is you sending it back", order: publicOrder(order) });
  if (status === STATUS.SUBMITTED) return json(409, { error: "a payment for this order is in flight (accepted by Circle, not yet on Arc) — it cannot be cancelled until that lands or fails", order: publicOrder(order) });
  if (status === STATUS.EXPIRED) return json(409, { error: "this order has already expired — nobody can pay it", order: publicOrder(order) });

  const now = new Date().toISOString();
  const t = await transitionOrder({ id, from: STATUS.OPEN, to: STATUS.CANCELLED, patch: { cancelledAt: now, cancelledBy: session.address } });
  if (!t.ok) return json(409, { error: `could not cancel: ${t.reason}`, order: publicOrder(t.order ?? order) });
  return json(200, { order: publicOrder(t.order) });
}
