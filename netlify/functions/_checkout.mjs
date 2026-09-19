// _checkout.mjs — the CHECKOUT ORDER record: a merchant's request to be paid, and what happened to it.
//
// ═══ WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ═══════════════════════════════════════════════
// v1 is DIRECT settlement only (decided 2026-09-18): the buyer pays the merchant's login wallet from
// the buyer's agent wallet through the EXISTING /api/agent-send path — same caps, same ledger, same
// receipt shapes. Nothing in this module moves money. It records an order and the evidence that it
// was paid. The `settlement` field exists so escrow (ERC-8183) can be added later WITHOUT a migration;
// it is always "direct" today and nothing here branches on it.
//
// ⛔ A DIRECT PAYMENT CANNOT BE REVERSED by Tikpema. The pay surface says so BEFORE the seal; this
// module has no refund path because there is none — a refund is the merchant sending it back.
//
// ═══ STATUS MACHINE — one write per transition, CAS-guarded, never re-opened ════════════════════
//   open ──(txHash VERIFIED on chain)──▶ paid
//   open ──(202: circleId, no hash)────▶ submitted ──(txHash verified later)──▶ paid
//   open ──(the MERCHANT voids it)──────▶ cancelled                                  (2026-09-19)
//   open / submitted ──(expiresAt passed, read-time)──▶ expired   (derived, never written)
// `paid` and `cancelled` are terminal. A second "paid" is refused, not overwritten: the first hash is the
// receipt and a later one would be a different payment for the same order — a fact to surface, not to
// absorb. `submitted` is NOT cancellable: a circleId means money is in flight; let it land or fail.
// [[absence-must-never-read-as-safe]] — `submitted` is NOT paid: the panel says so.
//
// ═══ CANCEL AND THE PAYMENT THAT LANDED ANYWAY (2026-09-19) ═══════════════════════════════════════
// The CAS on `transitionOrder` makes cancel safe against a concurrent payment in BOTH directions: a cancel
// that loses to a `paid` is refused ("order is paid, not open") and the payment survives; a `paid` that
// loses to a cancel is refused ("order is cancelled, not open") and nothing is written. What the CAS
// cannot help is the buyer whose transfer LANDED after the cancel — the money is in the merchant's wallet
// and the order is dead. checkout-paid refuses that hash (409 cancelled) BEFORE any chain read, and writes
// the LATE NOTE `late:<merchantLower>:<orderId>` { txHash, by, at, verified:false } — REPORTED, NOT
// VERIFIED — which the merchant listing surfaces: "a payment was reported after cancel; check your wallet".
// ⛔ THE REFUSED HASH STAYS UNCLAIMED, DELIBERATELY. A claim written without a chain read would let anyone
// strand another buyer's real payment (order ids and hashes are public) by posting it against a cancelled
// order first; a claim written WITH a chain read would be verification against a dead order. So the hash
// can still settle another pre-dating open order of the same merchant — the merchant received that money
// once, and that settlement is a legitimate purchase. The late note and the other order's paidTx then name
// the same hash: coherent, not hidden. (verify-checkout-cancel §4 pins this.)
//
// ═══ KEYS ══════════════════════════════════════════════════════════════════════════════════════
//   id:<orderId>                    the record (the truth)
//   m:<merchantLower>:<orderId>     an INDEX for the merchant's own listing (v1 writes it, lists nothing)
//   tx:<hashLower>                  the CLAIM: which order this transaction paid (2026-09-19, below)
// Record and index carry the same record. The index is a copy by design — a merchant listing must
// never scan the whole store — and every write goes to the record FIRST; an index that lags is a stale
// listing, an index that leads is a phantom order.
//
// ═══ 🚨 BINDING A PAYMENT TO ONE ORDER (2026-09-19, found read-only before any live payment) ═══════
// The receipt test (`_checkout-verify.mjs`) judges emitter / from / to / amount ≥. On its own that
// binds a transfer to a MERCHANT, not to an ORDER: one 0.15 hash posted against every open order of
// that merchant ≤ 0.15 would have marked them ALL paid, and a plain #/send made before an order existed
// would have settled it. Two bindings now sit in front of the transition:
//   1. THE CLAIM — `tx:<hash>` → { orderId } written onlyIfNew BEFORE `transitionOrder`. A hash settles
//      at most one order; a second order posting it is refused WITH THE FIRST ORDER NAMED. Claim first,
//      then transition: if the process dies between the two writes, the retry finds a claim naming its
//      own order and proceeds — the claim is idempotent for its owner, exclusive for everyone else.
//   2. `createdAtBlock` — the chain head when the order was minted; the receipt's block must be AFTER
//      it (`verifyDirectPayment`). An order WITHOUT it is UNBOUND and refused as such, never passed.
// ⛔ What this does NOT bind: two same-merchant, same-buyer, same-amount orders created before one
// payment still collapse to whichever posts first — only the order id ON CHAIN settles that, and that
// changes agent-send (the money path). Recorded in PROGRESS.md as the remaining gap; not built here.
//
// ⚠️ READS ON THE PAY PATH ARE STRONG (per call, never store-level — a store-level option leaks into
// writes). A cached `open` beside a fresh `paid` is a double payment invited. The handler must have
// called connectBlobs(event) first (_blobs.mjs) or the strong read throws.
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { USDC_DECIMALS } from "./_amount-floor.mjs";

export const CHECKOUT_STORE = "checkout-orders";
export const ORDER_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DESCRIPTION_MAX = 140;
export const SETTLEMENT = Object.freeze({ DIRECT: "direct" });
export const STATUS = Object.freeze({ OPEN: "open", SUBMITTED: "submitted", PAID: "paid", EXPIRED: "expired", CANCELLED: "cancelled" });
const READ_CONSISTENCY = "strong";

const norm = (a) => String(a || "").toLowerCase();
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Mint an order identifier. `o_` prefix + base36 time + 16 hex: unmistakable beside the repo's other
 * id spaces (24-hex deploy ids, 40-hex commits, `q_` quotes), roughly sortable by eye.
 */
export function mintOrderId(now = Date.now()) {
  return `o_${now.toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
}
export const ORDER_ID_RE = /^o_[0-9a-z]{1,12}_[0-9a-f]{16}$/;
/** A client-echoed id is either well-formed or null. Never throws. An id authorizes nothing. */
export function safeOrderId(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return ORDER_ID_RE.test(s) ? s : null;
}

export const orderKey = (id) => `id:${id}`;
export const merchantKey = (merchant, id) => `m:${norm(merchant)}:${id}`;
/** The listing prefix for ONE merchant — derived from a verified session address, never from a request field. */
export const merchantPrefix = (merchant) => `m:${norm(merchant)}:`;
export const txClaimKey = (txHash) => `tx:${norm(txHash)}`;
/** A payment REPORTED against a cancelled order — never verified by us. One per order; the first report survives. */
export const lateKey = (merchant, id) => `late:${norm(merchant)}:${id}`;

/** A block height as stored on an order: a non-negative safe integer NUMBER, nothing else. */
export const isBlockHeight = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Build a new order record, or return `{ error }`. Pure: no store, no clock beyond `now`.
 * - amount: parsed EXACTLY as a decimal string, at most 6 places, stored as a 6dp STRING. More than
 *   6 places is REFUSED, not rounded: a typed price silently changed in either direction is a price
 *   the merchant did not name (round up: the buyer pays more; floor: the merchant gets less). The
 *   executors' Math.round (`_amount-floor.mjs`) judges what the CHAIN will see; a price is what a
 *   person typed. Never a float on this path.
 * - cap: an order nobody can pay is a defect at CREATE time, so the per-transaction send cap is
 *   enforced here with the cap named, exactly as agent-send names it at pay time.
 * - description: plain text, trimmed, bounded. Rendered as text, never HTML.
 * - createdAtBlock: the Arc head at creation, REQUIRED. An order without it can never be shown to
 *   pre-date a transfer, so no transfer can pay it — an unbound order is one nobody could pay, and
 *   that is a defect at creation, refused here exactly like an amount over the cap.
 */
export function buildOrder({ merchant, amountUsdc, description, capUsdc, createdAtBlock, now = Date.now() }) {
  if (!ADDRESS_RE.test(merchant || "")) return { error: "merchant address is not a valid address" };
  if (!isBlockHeight(createdAtBlock)) return { error: "createdAtBlock unreadable — refusing to create an order no transfer could be bound to" };
  const units = parseUnits6(amountUsdc);
  if (units === null) return { error: `amountUsdc must be a decimal number with at most ${USDC_DECIMALS} decimal places` };
  if (units === 0n) return { error: "amountUsdc must be greater than zero" };
  const cap = Number(capUsdc);
  if (!Number.isFinite(cap)) return { error: "send cap unreadable — refusing to create an order" };
  const amountStr = formatUnits6(units);
  if (Number(amountStr) > cap) return { error: `amountUsdc exceeds the per-transaction send limit of ${cap} USDC — a link nobody can pay`, cap };
  const desc = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!desc) return { error: "description is required — the buyer must be told what they are paying for" };
  if (desc.length > DESCRIPTION_MAX) return { error: `description must be at most ${DESCRIPTION_MAX} characters` };
  const id = mintOrderId(now);
  return {
    order: {
      id,
      merchant,
      amountUsdc: amountStr,
      description: desc,
      settlement: SETTLEMENT.DIRECT,
      status: STATUS.OPEN,
      createdAt: new Date(now).toISOString(),
      createdAtBlock,
      expiresAt: new Date(now + ORDER_TTL_MS).toISOString(),
    },
  };
}

/** Exact decimal-string → minor units. "1.5" → 1500000n; "1.2345678" → null (7 places); "1e-7",
 *  "-1", "abc", "" → null. Numbers are stringified first so a typed number still parses exactly. */
export function parseUnits6(v) {
  const s = (typeof v === "number" ? String(v) : String(v ?? "")).trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return null;
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  return whole * 10n ** BigInt(USDC_DECIMALS) + frac;
}

/** 6dp string from minor units — `1500000n` → "1.500000". Exact; no float. */
export function formatUnits6(units) {
  const s = units.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

/** The status a READER should show: `expired` is derived from the clock, never written. */
export function effectiveStatus(order, now = Date.now()) {
  if (!order) return null;
  if (order.status === STATUS.PAID) return STATUS.PAID;
  if (order.status === STATUS.CANCELLED) return STATUS.CANCELLED; // terminal: never flips to expired
  if (order.expiresAt && Date.parse(order.expiresAt) <= now) return STATUS.EXPIRED;
  return order.status;
}

/**
 * The public view of an order — what a buyer (possibly signed out) may see. The merchant address IS
 * shown: it is the payee, and naming the payee is the disclosure the pay surface exists to make.
 * `createdAtBlock` is exposed (null when the record predates binding) so the pay surface can decline
 * to offer a seal on an order the server would refuse as unbound — BEFORE the money moves.
 */
export function publicOrder(order, now = Date.now()) {
  if (!order) return null;
  const { id, merchant, amountUsdc, description, settlement, createdAt, expiresAt, paidTx, paidAt, circleId, createdAtBlock, cancelledAt } = order;
  return {
    id, merchant, amountUsdc, description, settlement, createdAt, expiresAt, status: effectiveStatus(order, now),
    paidTx: paidTx ?? null, paidAt: paidAt ?? null, circleId: circleId ?? null,
    createdAtBlock: isBlockHeight(createdAtBlock) ? createdAtBlock : null,
    cancelledAt: cancelledAt ?? null,
  };
}

/**
 * The MERCHANT's view of their own order: the public view plus the fields that are theirs to see —
 * who paid, how many units, at which block. Served only by checkout-list, behind the session.
 */
export function merchantOrder(order, now = Date.now()) {
  const pub = publicOrder(order, now);
  if (!pub) return null;
  return { ...pub, paidBy: order.paidBy ?? null, paidUnits: order.paidUnits ?? null, paidAtBlock: isBlockHeight(order.paidAtBlock) ? order.paidAtBlock : null };
}

function store(s) { return s ?? getStore(CHECKOUT_STORE); }

/** Strong read of the record. Returns { order, etag, readable }. `readable:false` ≠ absent. */
export async function readOrder(id, s) {
  try {
    const res = await store(s).getWithMetadata(orderKey(id), { type: "json", consistency: READ_CONSISTENCY });
    return { order: res?.data ?? null, etag: res?.etag ?? null, readable: true };
  } catch {
    return { order: null, etag: null, readable: false };
  }
}

/** Write a NEW order: record first, then the merchant index. Refuses to overwrite an existing id. */
export async function writeNewOrder(order, s) {
  const st = store(s);
  const res = await st.setJSON(orderKey(order.id), order, { onlyIfNew: true });
  if (res?.modified === false) return { ok: false, reason: "order id already exists" };
  await st.setJSON(merchantKey(order.merchant, order.id), order);
  return { ok: true };
}

/**
 * The late-payment note: a hash REPORTED against a cancelled order. onlyIfNew — the first report survives
 * (a second is { ok, prior:true }). No chain read happens here or anywhere on this path: `verified:false`
 * is part of the record so no reader can mistake it for a settlement.
 */
export async function writeLateNote({ merchant, orderId, txHash, by, now = Date.now() }, s) {
  if (!TX_HASH_RE.test(txHash || "")) return { ok: false, reason: "malformed transaction hash" };
  const st = store(s);
  const note = { txHash: norm(txHash), orderId, merchant: norm(merchant), by: norm(by), at: new Date(now).toISOString(), verified: false };
  try {
    const res = await st.setJSON(lateKey(merchant, orderId), note, { onlyIfNew: true });
    return res?.modified === false ? { ok: true, prior: true } : { ok: true };
  } catch (e) { return { ok: false, unreadable: true, reason: `late note write failed: ${e?.message ?? e}` }; }
}
/** { txHash, by, at, verified:false } · null (readable, absent) · { unreadable:true } (the store could not say). */
export async function readLateNote(merchant, orderId, s) {
  try {
    const res = await store(s).getWithMetadata(lateKey(merchant, orderId), { type: "json", consistency: READ_CONSISTENCY });
    return res?.data ?? null;
  } catch { return { unreadable: true }; }
}

/**
 * ⭐ CLAIM A TRANSACTION FOR ONE ORDER. `tx:<hash>` is written onlyIfNew — the same primitive that
 * keeps `writeNewOrder` from overwriting an id. Called AFTER the receipt verified and BEFORE the
 * transition (a hash that did not pay must never squat a claim; a claim without a transition must
 * be re-enterable by its owner). Returns:
 *   { ok: true }                       claimed now
 *   { ok: true, prior: true }          already claimed BY THIS ORDER (retry after a crashed transition)
 *   { ok: false, paidOrderId, reason } already claimed by ANOTHER order — the reason names it
 *   { ok: false, unreadable: true }    the store could not say — never mistaken for either of the above
 */
export async function claimTxForOrder({ txHash, orderId, merchant, paidBy, now = Date.now() }, s) {
  if (!TX_HASH_RE.test(txHash || "")) return { ok: false, reason: "malformed transaction hash" };
  const st = store(s);
  const key = txClaimKey(txHash);
  const claim = { txHash: norm(txHash), orderId, merchant, paidBy, claimedAt: new Date(now).toISOString() };
  let res;
  try { res = await st.setJSON(key, claim, { onlyIfNew: true }); }
  catch (e) { return { ok: false, unreadable: true, reason: `claim write failed: ${e?.message ?? e}` }; }
  if (res?.modified !== false) return { ok: true };
  // Someone holds it. Read WHO — strongly — and only a claim naming THIS order lets the caller through.
  let prior;
  try { prior = await st.getWithMetadata(key, { type: "json", consistency: READ_CONSISTENCY }); }
  catch (e) { return { ok: false, unreadable: true, reason: `claim exists but could not be read: ${e?.message ?? e}` }; }
  const holder = prior?.data?.orderId;
  if (typeof holder !== "string" || !holder) return { ok: false, unreadable: true, reason: "claim exists but names no order — refusing to guess" };
  if (holder === orderId) return { ok: true, prior: true };
  return { ok: false, paidOrderId: holder, reason: `this transaction already paid order ${holder}` };
}

/**
 * ⭐ THE ONLY STATUS TRANSITION WRITER. CAS on the etag of the record just read, so two buyers (or one
 * buyer twice) cannot both mark the same order. Allowed: open→submitted, open→paid, open→cancelled,
 * submitted→paid.
 * Everything else is refused with the reason named — including paid→paid (a second payment is a
 * fact to surface, not to absorb) and any transition on an expired order.
 */
export async function transitionOrder({ id, from, to, patch, now = Date.now() }, s) {
  const st = store(s);
  const { order, etag, readable } = await readOrder(id, s);
  if (!readable) return { ok: false, reason: "order store unreadable" };
  if (!order) return { ok: false, reason: "no such order" };
  const eff = effectiveStatus(order, now);
  if (eff !== from) return { ok: false, reason: `order is ${eff}, not ${from}`, status: eff, order };
  const legal = (from === STATUS.OPEN && (to === STATUS.SUBMITTED || to === STATUS.PAID || to === STATUS.CANCELLED)) ||
                (from === STATUS.SUBMITTED && to === STATUS.PAID);
  if (!legal) return { ok: false, reason: `transition ${from} → ${to} is not allowed`, status: eff, order };
  const next = { ...order, ...patch, status: to, updatedAt: new Date(now).toISOString() };
  try {
    const res = etag
      ? await st.setJSON(orderKey(id), next, { onlyIfMatch: etag })
      : await st.setJSON(orderKey(id), next, { onlyIfNew: true });
    if (res?.modified === false) return { ok: false, reason: "order changed under us — re-read", status: eff, order };
  } catch (e) {
    return { ok: false, reason: `order write failed: ${e?.message ?? e}` };
  }
  // Index second, best-effort: a lagging index is a stale listing, never a phantom or a lost payment.
  try { await st.setJSON(merchantKey(order.merchant, id), next); } catch { /* record is the truth */ }
  return { ok: true, order: next };
}
