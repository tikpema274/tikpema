// checkout-paid.mjs — the BUYER reports the outcome of /api/agent-send; the SERVER decides what it means.
//
// Body: { id, txHash }   → we read the receipt from the Arc RPC and mark `paid` ONLY if it shows a
//                          USDC transfer ≥ the order amount, from THIS buyer's agent wallet, to the
//                          merchant (`_checkout-verify.mjs`). A hash we cannot verify marks nothing.
//       { id, circleId } → agent-send answered 202 (accepted, not confirmed, no hash yet): the order
//                          becomes `submitted` — which is NOT paid, and the panel says so. It
//                          becomes `paid` only when a later call carries a hash that verifies.
//
// ⚠️ The buyer's identity is the SESSION; the sender the receipt must show is the session's agent
// wallet (`ensureOwnerWallet`). So a buyer cannot mark an order paid with someone else's transfer,
// and cannot mark it paid with a transfer to someone other than the merchant.
// ⚠️ 503 "unverified" (RPC unreachable / receipt not yet available) is NOT a refusal: the order stays
// as it was and the client may retry. 409 "not a payment of this order" IS a verdict from a receipt
// we read. The two are never the same branch. [[absence-must-never-read-as-safe]]
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { safeOrderId, readOrder, transitionOrder, publicOrder, effectiveStatus, STATUS, TX_HASH_RE } from "./_checkout.mjs";
import { fetchReceipt, verifyDirectPayment } from "./_checkout-verify.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const body = parseBody(event);
  const id = safeOrderId(body.id || "");
  if (!id) return json(400, { error: "a well-formed order id is required" });
  const txHash = typeof body.txHash === "string" ? body.txHash.trim() : "";
  const circleId = typeof body.circleId === "string" ? body.circleId.trim().slice(0, 80) : "";
  if (!txHash && !circleId) return json(400, { error: "txHash or circleId required" });
  if (txHash && !TX_HASH_RE.test(txHash)) return json(400, { error: "malformed txHash" });

  const { order, readable } = await readOrder(id);
  if (!readable) return json(503, { error: "order store unreadable — try again" });
  if (!order) return json(404, { error: "no such order" });
  const status = effectiveStatus(order);
  if (status === STATUS.PAID) return json(200, { order: publicOrder(order), note: "already paid" });
  if (status === STATUS.EXPIRED) return json(409, { error: "order expired", order: publicOrder(order) });

  // The buyer's agent wallet — the only `from` the receipt may show.
  let buyer;
  try { buyer = (await ensureOwnerWallet(session))?.walletAddress ?? null; } catch { buyer = null; }
  if (!buyer) return json(503, { error: "could not resolve your agent wallet — try again" });

  if (!txHash) {
    // 202 path: submitted, NOT paid.
    const t = await transitionOrder({ id, from: status, to: STATUS.SUBMITTED, patch: { circleId, paidBy: buyer, submittedAt: new Date().toISOString() } });
    if (!t.ok) return json(409, { error: t.reason, order: publicOrder(t.order ?? order) });
    return json(200, { order: publicOrder(t.order), note: "submitted — not yet confirmed on Arc, no transaction hash yet" });
  }

  const got = await fetchReceipt(txHash);
  if (got.unreadable) return json(503, { error: `unverified: ${got.unreadable}`, order: publicOrder(order) });
  if (!got.receipt) return json(503, { error: "unverified: receipt not available yet — the transaction may still be confirming", order: publicOrder(order) });
  const v = verifyDirectPayment({ receipt: got.receipt, merchant: order.merchant, amountUsdc: order.amountUsdc, from: buyer });
  if (!v.paid) return json(409, { error: `not a payment of this order: ${v.reason}`, order: publicOrder(order) });

  const t = await transitionOrder({ id, from: status, to: STATUS.PAID, patch: { paidTx: txHash, paidBy: buyer, paidAt: new Date().toISOString(), paidUnits: v.value.toString() } });
  if (!t.ok) return json(409, { error: t.reason, order: publicOrder(t.order ?? order) });
  return json(200, { order: publicOrder(t.order) });
}
