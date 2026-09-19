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
//
// 🚨 ONE HASH, ONE ORDER (2026-09-19). The receipt test binds a transfer to the MERCHANT (from/to/
// amount ≥); it never bound it to THIS order. So, in this order:
//   1. the receipt verifies (incl. mined AFTER `order.createdAtBlock`; an order with none is UNBOUND
//      → 409 code:"unbound", said, never passed);
//   2. `tx:<hash>` is CLAIMED for this order (onlyIfNew) — a hash another order already holds → 409
//      code:"replay" WITH THAT ORDER NAMED (`paidOrderId`); a claim already naming this order = a retry
//      after a crashed transition → proceed;
//   3. the transition. Claim before transition, so a CAS failure at 3 retries cleanly through 2.
// Every 409 carries `code` so the pay surface renders the KIND of refusal, not a generic failure.
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { safeOrderId, readOrder, transitionOrder, claimTxForOrder, writeLateNote, publicOrder, effectiveStatus, STATUS, TX_HASH_RE } from "./_checkout.mjs";
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
  // ⛔ CANCELLED — refused HERE, before the wallet lookup, the RPC and the verifier: no chain read, no
  // verification against a dead order, no claim. If the buyer carries a hash, their transfer may have
  // LANDED: it is in the merchant's wallet and the order is gone. That must not vanish into a generic
  // error — the LATE NOTE records it (reported, NOT verified) for the merchant's listing, and the copy
  // tells the buyer the truth. The hash stays unclaimed (see _checkout.mjs, "CANCEL AND THE PAYMENT THAT
  // LANDED ANYWAY"). `by` is the session login — the SCA has not been resolved yet, on purpose.
  if (status === STATUS.CANCELLED) {
    let lateReported = false;
    if (txHash) {
      const n = await writeLateNote({ merchant: order.merchant, orderId: id, txHash, by: session.address });
      lateReported = !!n.ok;
    }
    return json(409, {
      error: txHash
        ? "not a payment of this order: the seller cancelled it before your payment was recorded — your transfer is not undone; it is in the seller's wallet, and a refund is the seller sending it back"
        : "this order was cancelled by the seller — nothing can be paid on it",
      code: "cancelled",
      lateReported,
      order: publicOrder(order),
    });
  }

  // The buyer's agent wallet — the only `from` the receipt may show. Same wrapping as agent-send:
  // a tagged external failure becomes the shared 503 refusal (retryable, "nothing happened");
  // anything else re-throws unclaimed rather than borrowing a diagnosis it cannot honour; a wallet
  // still provisioning gets the shared provisioning refusal. (verify-provisioning-status)
  let w;
  try { w = await ensureOwnerWallet(session); }
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }
  if (w?.pending) return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  const buyer = w?.walletAddress ?? null;
  if (!buyer) return json(503, { error: "could not resolve your agent wallet — nothing was marked; try again" });

  if (!txHash) {
    // 202 path: submitted, NOT paid.
    const t = await transitionOrder({ id, from: status, to: STATUS.SUBMITTED, patch: { circleId, paidBy: buyer, submittedAt: new Date().toISOString() } });
    if (!t.ok) return json(409, { error: t.reason, order: publicOrder(t.order ?? order) });
    return json(200, { order: publicOrder(t.order), note: "submitted — not yet confirmed on Arc, no transaction hash yet" });
  }

  const got = await fetchReceipt(txHash);
  if (got.unreadable) return json(503, { error: `unverified: ${got.unreadable}`, order: publicOrder(order) });
  if (!got.receipt) return json(503, { error: "unverified: receipt not available yet — the transaction may still be confirming", order: publicOrder(order) });
  const v = verifyDirectPayment({ receipt: got.receipt, merchant: order.merchant, amountUsdc: order.amountUsdc, from: buyer, createdAtBlock: order.createdAtBlock });
  if (!v.paid) return json(409, { error: `not a payment of this order: ${v.reason}`, code: v.code ?? "receipt", order: publicOrder(order) });

  // The receipt pays this order. Now: does this hash already pay ANOTHER one? Claim before transition.
  const claim = await claimTxForOrder({ txHash, orderId: id, merchant: order.merchant, paidBy: buyer });
  if (claim.unreadable) return json(503, { error: `unverified: ${claim.reason}`, order: publicOrder(order) });
  if (!claim.ok) return json(409, { error: `not a payment of this order: ${claim.reason}`, code: "replay", paidOrderId: claim.paidOrderId ?? null, order: publicOrder(order) });

  const t = await transitionOrder({ id, from: status, to: STATUS.PAID, patch: { paidTx: txHash, paidBy: buyer, paidAt: new Date().toISOString(), paidUnits: v.value.toString(), paidAtBlock: v.minedAt } });
  if (!t.ok) return json(409, { error: t.reason, order: publicOrder(t.order ?? order) });
  return json(200, { order: publicOrder(t.order) });
}
