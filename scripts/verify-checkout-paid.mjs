// verify-checkout-paid.mjs — ONE HASH SETTLES AT MOST ONE ORDER, and only an order it post-dates.
//
//   node --experimental-test-module-mocks scripts/verify-checkout-paid.mjs   (npm run test:checkoutpaid)
//
// ═══ THE GAP THIS CLOSES (found read-only 2026-09-19, before any live payment) ═══════════════════
// `verifyDirectPayment` judged a receipt by emitter / from / to / amount ≥ — and NOTHING bound the
// transfer to ONE order. So one 0.15 hash could be posted against every open order of that merchant
// ≤ 0.15 and mark them ALL paid; and a plain #/send made BEFORE an order existed would have settled
// it. Two bindings now sit in front of the transition, and this suite drives them THROUGH THE HANDLER:
//   1. CLAIM — `tx:<hash>` is written onlyIfNew BEFORE the transition. A second order posting the same
//      hash is 409 and the body NAMES the order the hash already paid (`paidOrderId`). The same order
//      retried is idempotent (200, no second write).
//   2. POST-DATE — the receipt's block must be AFTER `order.createdAtBlock`. An order with no
//      createdAtBlock (the two pre-binding orders on prod) is UNBOUND and refused as such — never
//      silently passed. [[absence-must-never-read-as-safe]]
//
// ⚠️ BOUNDARIES MOCKED, SUBJECTS REAL: the session (`_auth`), the Circle wallet lookup
// (`_agent-wallets`), the Blobs store, and the Arc RPC (global fetch). `_checkout.mjs` and
// `_checkout-verify.mjs` are the real modules — the claim, the transition and the verdict are what is
// under test. [[never-mock-the-function-under-test]]
import { mock } from "node:test";

// ── the store: in-memory, onlyIfNew / onlyIfMatch honoured, every write counted ─────────────────
const mem = new Map();
let etagSeq = 0, writes = 0, unreadable = false;
mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {},
    getStore: () => ({
      getWithMetadata: async (k) => {
        if (unreadable) throw new Error("store down");
        const e = mem.get(k);
        return e ? { data: JSON.parse(e.json), etag: e.etag } : null;
      },
      setJSON: async (k, v, opts = {}) => {
        if (unreadable) throw new Error("store down");
        const cur = mem.get(k);
        if (opts.onlyIfNew && cur) return { modified: false };
        if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
        writes++;
        mem.set(k, { json: JSON.stringify(v), etag: `e${++etagSeq}` });
        return { modified: true, etag: `e${etagSeq}` };
      },
    }),
  },
});
const MERCHANT = "0x" + "ab".repeat(20);
const BUYER_LOGIN = "0x" + "77".repeat(20);
const BUYER_SCA = "0x" + "cd".repeat(20);
let sessionAddress = BUYER_LOGIN;
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireSession: () => (sessionAddress ? { address: sessionAddress } : null) } });
const REAL_WALLETS = await import("../netlify/functions/_agent-wallets.mjs");
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: { ...REAL_WALLETS, ensureOwnerWallet: async () => ({ walletAddress: BUYER_SCA }) } });

// ── the RPC: receipts by hash; eth_blockNumber for checkout-create ───────────────────────────────
const receipts = new Map();
let head = 100;
const realFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  const req = JSON.parse(init.body);
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: req.id, result }) });
  if (req.method === "eth_getTransactionReceipt") return reply(receipts.get(String(req.params[0]).toLowerCase()) ?? null);
  if (req.method === "eth_blockNumber") return reply("0x" + head.toString(16));
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unexpected ${req.method}` } }) };
};

const { handler: paid } = await import("../netlify/functions/checkout-paid.mjs");
const { handler: create } = await import("../netlify/functions/checkout-create.mjs");
const { orderKey, txClaimKey, readOrder } = await import("../netlify/functions/_checkout.mjs");
const { TRANSFER_TOPIC } = await import("../netlify/functions/_checkout-verify.mjs");
const { CONTRACTS } = await import("../netlify/functions/_arc.mjs");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const transferLog = (from, to, units) => ({ address: CONTRACTS.USDC, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: "0x" + units.toString(16) });
const receiptAt = (block, units, from = BUYER_SCA, to = MERCHANT) => ({ status: "0x1", blockNumber: "0x" + block.toString(16), logs: [transferLog(from, to, units)] });
const post = (h, body) => h({ httpMethod: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) });
const body = (r) => JSON.parse(r.body);
const stored = (id) => JSON.parse(mem.get(orderKey(id)).json);
const H = (n) => "0x" + n.toString(16).padStart(64, "0");

async function newOrder(amountUsdc, description = "Thing") {
  const prev = sessionAddress; sessionAddress = MERCHANT;
  const r = await post(create, { amountUsdc, description });
  sessionAddress = prev;
  if (r.statusCode !== 200) throw new Error(`create failed: ${r.body}`);
  return body(r).order;
}
const reset = () => { mem.clear(); receipts.clear(); writes = 0; unreadable = false; head = 100; sessionAddress = BUYER_LOGIN; };

console.log("\nverify-checkout-paid — one hash, one order; the transfer must post-date the order\n");

section("1 — checkout-create records the chain head as createdAtBlock");
{
  reset();
  head = 62816113;
  const o = await newOrder("0.15");
  check("⭐ the stored order carries createdAtBlock = the head at creation", stored(o.id).createdAtBlock === 62816113, JSON.stringify(stored(o.id).createdAtBlock));
  check("…and the public view exposes it (the pay surface refuses to offer a seal on an unbound order)", o.createdAtBlock === 62816113);
}

section("2 — 🚨 REPLAY: the same hash against a second order is 409 and NAMES the first order");
{
  reset();
  const a = await newOrder("0.15", "A");
  const b = await newOrder("0.11", "B");
  const hash = H(1);
  receipts.set(hash, receiptAt(150, 150_000n)); // 0.15 USDC, mined after both orders
  const r1 = await post(paid, { id: a.id, txHash: hash });
  check("order A: 200 paid", r1.statusCode === 200 && body(r1).order.status === "paid", r1.body);
  check("⭐ the claim key tx:<hash> names order A", JSON.parse(mem.get(txClaimKey(hash))?.json ?? "null")?.orderId === a.id);
  const r2 = await post(paid, { id: b.id, txHash: hash });
  check("🚨 order B with the SAME hash: 409", r2.statusCode === 409, `${r2.statusCode} ${r2.body}`);
  check("🚨 …the error NAMES the order the hash already paid", body(r2).error.includes(a.id), body(r2).error);
  check("…and carries it as `paidOrderId` + code:\"replay\" so the UI can link it, not regex it", body(r2).paidOrderId === a.id && body(r2).code === "replay");
  check("…order B is STILL OPEN in the store (nothing was marked)", stored(b.id).status === "open" && !stored(b.id).paidTx);
  check("…order A's record is untouched (still names the hash)", stored(a.id).status === "paid" && stored(a.id).paidTx === hash);
  const upper = "0x" + hash.slice(2).toUpperCase();
  const r3 = await post(paid, { id: b.id, txHash: upper });
  check("🚨 the same hash in UPPER-CASE hex is the same claim (409, names A)", r3.statusCode === 409 && body(r3).paidOrderId === a.id, r3.body);
}

section("3 — ⭐ IDEMPOTENT: the same hash against the SAME order again is 200 with no second write");
{
  reset();
  const a = await newOrder("0.15", "A");
  const hash = H(2);
  receipts.set(hash, receiptAt(150, 150_000n));
  const r1 = await post(paid, { id: a.id, txHash: hash });
  check("first: 200 paid", r1.statusCode === 200 && body(r1).order.status === "paid");
  const w = writes;
  const r2 = await post(paid, { id: a.id, txHash: hash });
  check("⭐ retry: 200, 'already paid', same hash", r2.statusCode === 200 && /already paid/.test(body(r2).note || "") && body(r2).order.paidTx === hash, r2.body);
  check("🚨 …and ZERO further writes (no double write of record, index, or claim)", writes === w, `writes ${w} → ${writes}`);

  // Crashed-transition shape: the claim landed, the transition did not (process died between the
  // two writes). The retry must go through, because the claim names THIS order.
  const c = await newOrder("0.20", "C");
  const hash2 = H(3);
  receipts.set(hash2, receiptAt(160, 200_000n));
  mem.set(txClaimKey(hash2), { json: JSON.stringify({ orderId: c.id, merchant: MERCHANT, paidBy: BUYER_SCA, claimedAt: "2026-09-19T00:00:00.000Z" }), etag: "pre" });
  const r3 = await post(paid, { id: c.id, txHash: hash2 });
  check("⭐ claim already names THIS order (crashed transition) → retry proceeds to paid", r3.statusCode === 200 && body(r3).order.status === "paid", r3.body);
  check("…the pre-existing claim was not rewritten", mem.get(txClaimKey(hash2)).etag === "pre");
}

section("4 — 🚨 POST-DATE: a transfer mined BEFORE the order was created does not pay it");
{
  reset();
  head = 100;
  const a = await newOrder("0.11", "A");
  const before = H(4);
  receipts.set(before, receiptAt(99, 130_000n)); // the prod shape: an unrelated 0.13 #/send before the order
  const r1 = await post(paid, { id: a.id, txHash: before });
  check("🚨 mined at block 99, order created at 100 → 409", r1.statusCode === 409, `${r1.statusCode} ${r1.body}`);
  check("…the reason names BOTH blocks and says the order came later", /99/.test(body(r1).error) && /100/.test(body(r1).error) && /before/i.test(body(r1).error), body(r1).error);
  check("…code:\"predates\"", body(r1).code === "predates");
  check("🚨 …and NO claim was written for a hash that did not pay (a refused hash must not squat)", !mem.has(txClaimKey(before)));
  check("…order still open", stored(a.id).status === "open");
  const same = H(5);
  receipts.set(same, receiptAt(100, 130_000n));
  const r2 = await post(paid, { id: a.id, txHash: same });
  check("🚨 mined IN the creation block (already mined when the head was read) → 409", r2.statusCode === 409 && body(r2).code === "predates", r2.body);
  const after = H(6);
  receipts.set(after, receiptAt(101, 130_000n));
  const r3 = await post(paid, { id: a.id, txHash: after });
  check("⭐ mined one block after creation → 200 paid (overpayment 0.13 ≥ 0.11 still the buyer's choice)", r3.statusCode === 200 && body(r3).order.status === "paid", r3.body);
}

section("5 — 🚨 UNBOUND: an order with NO createdAtBlock (the two pre-binding prod orders) is refused as such");
{
  reset();
  const a = await newOrder("0.11", "A");
  const rec = stored(a.id); delete rec.createdAtBlock;
  mem.set(orderKey(a.id), { json: JSON.stringify(rec), etag: "legacy" });
  const hash = H(7);
  receipts.set(hash, receiptAt(500, 110_000n)); // a PERFECT receipt otherwise
  const r = await post(paid, { id: a.id, txHash: hash });
  check("🚨 a perfect receipt against an unbound order → 409, never paid", r.statusCode === 409, `${r.statusCode} ${r.body}`);
  check("…the reason SAYS unbound and names createdAtBlock (explicit, not a generic 'not a payment')", /unbound/i.test(body(r).error) && /createdAtBlock/.test(body(r).error), body(r).error);
  check("…code:\"unbound\"", body(r).code === "unbound");
  check("…no claim written, order still open", !mem.has(txClaimKey(hash)) && stored(a.id).status === "open");
  const pub = await post(paid, { id: a.id, circleId: "circle-1" });
  check("(202 path is unaffected by binding: unbound order → submitted, still NOT paid)", pub.statusCode === 200 && body(pub).order.status === "submitted");
}

section("6 — the claim is written ONLY after the receipt verifies, and an unreadable claim read is 503 not 409");
{
  reset();
  const a = await newOrder("0.15", "A");
  const bad = H(8);
  receipts.set(bad, receiptAt(150, 1n)); // one unit — not a payment
  const r1 = await post(paid, { id: a.id, txHash: bad });
  check("short transfer → 409 (a verdict), no claim", r1.statusCode === 409 && !mem.has(txClaimKey(bad)), r1.body);
  const none = H(9);
  const r2 = await post(paid, { id: a.id, txHash: none });
  check("receipt absent → 503 unverified (not a verdict), no claim", r2.statusCode === 503 && !mem.has(txClaimKey(none)), r2.body);
  check("…order still open after both", stored(a.id).status === "open");
}

section("7 — checkout-create refuses to mint an order it cannot bind");
{
  reset();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  sessionAddress = MERCHANT;
  const r = await post(create, { amountUsdc: "1", description: "x" });
  globalThis.fetch = prevFetch;
  check("🚨 head unreadable → 503, the order is NOT written (an unbound order is one nobody could pay)", r.statusCode === 503 && /block/i.test(body(r).error) && mem.size === 0, `${r.statusCode} ${r.body}`);
}

globalThis.fetch = realFetch;
console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
