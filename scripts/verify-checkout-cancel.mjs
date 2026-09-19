// verify-checkout-cancel.mjs — a merchant voids an OPEN order; the buyer's real money is never silently swallowed.
//
//   node --experimental-test-module-mocks scripts/verify-checkout-cancel.mjs   (npm run test:checkoutcancel)
//
// ═══ WHY (2026-09-19) ════════════════════════════════════════════════════════════════════════════
// Nine bound orders were payable by any link-holder until 2026-10-02 with no way to stop them. Cancel is
// the merchant's, from the session (the record's `merchant` must equal the token's address — never a
// request field). And the case that must not go wrong: a buyer whose transfer LANDED after the cancel.
//
// ═══ THE PROPERTIES ══════════════════════════════════════════════════════════════════════════════
//   1. checkout-cancel: 401 no session · 404 unknown · 403 a BUYER (any non-merchant session) · 200 open →
//      cancelled · 200 idempotent on cancelled (no write) · 409 submitted (in flight) · 409 paid (never) ·
//      409 expired. The id in the body authorises nothing; a `merchant` field is ignored.
//   2. checkout-paid on a CANCELLED order: 409 code:"cancelled" BEFORE any chain read — fetchReceipt is
//      NOT called (global fetch counted). No claim written. With a txHash present, the LATE NOTE is written
//      late:<merchant>:<orderId> { txHash, by, at, verified:false } — REPORTED, NOT VERIFIED.
//   3. checkout-list surfaces the late note on the cancelled row (`lateReport`), and `cancelledAt`.
//   4. ⛔ KNOWN, DELIBERATE: the refused hash stays UNCLAIMED and CAN settle another pre-dating open order of
//      the same merchant (the merchant received that money once; a tombstone without a chain read would be
//      a griefing vector — order ids and hashes are public). Pinned so it is never implicit.
import { mock } from "node:test";

const mem = new Map();
let etagSeq = 0;
mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {},
    getStore: () => ({
      list: async ({ prefix }) => ({ blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, etag: "e" })) }),
      get: async (k) => { const e = mem.get(k); return e ? JSON.parse(e.json) : null; },
      getWithMetadata: async (k) => { const e = mem.get(k); return e ? { data: JSON.parse(e.json), etag: e.etag } : null; },
      setJSON: async (k, v, opts = {}) => {
        const cur = mem.get(k);
        if (opts.onlyIfNew && cur) return { modified: false };
        if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
        mem.set(k, { json: JSON.stringify(v), etag: `e${++etagSeq}` });
        return { modified: true };
      },
    }),
  },
});
const MERCHANT = "0x" + "ab".repeat(20);
const BUYER_LOGIN = "0x" + "77".repeat(20);
const BUYER_SCA = "0x" + "cd".repeat(20);
let sessionAddress = MERCHANT;
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireSession: () => (sessionAddress ? { address: sessionAddress, method: "passkey" } : null) } });
const REAL_WALLETS = await import("../netlify/functions/_agent-wallets.mjs");
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: { ...REAL_WALLETS, ensureOwnerWallet: async () => ({ walletAddress: BUYER_SCA }) } });

// the RPC — counted, so "no chain read" is asserted, not assumed
const receipts = new Map();
let rpcCalls = 0, head = 100;
globalThis.fetch = async (_u, init) => {
  rpcCalls++;
  const req = JSON.parse(init.body);
  const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: req.id, result }) });
  if (req.method === "eth_getTransactionReceipt") return reply(receipts.get(String(req.params[0]).toLowerCase()) ?? null);
  if (req.method === "eth_blockNumber") return reply("0x" + head.toString(16));
  return reply(null);
};

const { handler: cancel } = await import("../netlify/functions/checkout-cancel.mjs");
const { handler: paid } = await import("../netlify/functions/checkout-paid.mjs");
const { handler: create } = await import("../netlify/functions/checkout-create.mjs");
const { handler: list } = await import("../netlify/functions/checkout-list.mjs");
const { orderKey, txClaimKey, lateKey, STATUS } = await import("../netlify/functions/_checkout.mjs");
const { TRANSFER_TOPIC } = await import("../netlify/functions/_checkout-verify.mjs");
const { CONTRACTS } = await import("../netlify/functions/_arc.mjs");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const post = (h, body, hdr = { authorization: "Bearer t" }) => h({ httpMethod: "POST", headers: hdr, body: JSON.stringify(body) });
const body = (r) => JSON.parse(r.body);
const stored = (id) => JSON.parse(mem.get(orderKey(id)).json);
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const receiptAt = (block, units) => ({ status: "0x1", blockNumber: "0x" + block.toString(16), logs: [{ address: CONTRACTS.USDC, topics: [TRANSFER_TOPIC, pad(BUYER_SCA), pad(MERCHANT)], data: "0x" + units.toString(16) }] });
const H = (n) => "0x" + n.toString(16).padStart(64, "0");
async function newOrder(amountUsdc, description = "Thing") {
  const prev = sessionAddress; sessionAddress = MERCHANT;
  const r = await post(create, { amountUsdc, description });
  sessionAddress = prev;
  if (r.statusCode !== 200) throw new Error(`create failed: ${r.body}`);
  return body(r).order;
}
const reset = () => { mem.clear(); receipts.clear(); rpcCalls = 0; head = 100; sessionAddress = MERCHANT; };

console.log("\nverify-checkout-cancel — the merchant voids an open order; a landed payment is never swallowed\n");

section("1 — who may cancel, and what: the matrix");
{
  reset();
  const o = await newOrder("0.10", "A");
  sessionAddress = null;
  check("🚨 no session → 401", (await post(cancel, { id: o.id }, {})).statusCode === 401);
  sessionAddress = MERCHANT;
  check("unknown id → 404", (await post(cancel, { id: "o_zzzzzzzz_0000000000000000" })).statusCode === 404);
  check("malformed id → 400", (await post(cancel, { id: "nope" })).statusCode === 400);
  sessionAddress = BUYER_LOGIN;
  const rb = await post(cancel, { id: o.id });
  check("🚨 a BUYER (any session that is not the record's merchant) → 403, order untouched", rb.statusCode === 403 && stored(o.id).status === "open", rb.body);
  const rs = await post(cancel, { id: o.id, merchant: MERCHANT });
  check("🚨 …and a `merchant` field in the body changes nothing (403 again — the record decides)", rs.statusCode === 403 && stored(o.id).status === "open");
  sessionAddress = MERCHANT.toUpperCase().replace("0X", "0x");
  const rm = await post(cancel, { id: o.id });
  check("⭐ the MERCHANT (matched on the record, case-insensitively) → 200, status cancelled, cancelledAt + cancelledBy", rm.statusCode === 200 && body(rm).order.status === "cancelled" && stored(o.id).cancelledAt && stored(o.id).cancelledBy?.toLowerCase() === MERCHANT, rm.body);
  const e1 = mem.get(orderKey(o.id)).etag;
  const ra = await post(cancel, { id: o.id });
  check("⭐ cancelling a cancelled order → 200 'already cancelled', NO write (etag unchanged)", ra.statusCode === 200 && /already cancelled/.test(body(ra).note || "") && mem.get(orderKey(o.id)).etag === e1, ra.body);
  check("the public view of a cancelled order says cancelled and carries cancelledAt", body(ra).order.status === "cancelled" && !!body(ra).order.cancelledAt);

  const p = await newOrder("0.10", "P");
  sessionAddress = BUYER_LOGIN; receipts.set(H(1), receiptAt(150, 100_000n));
  await post(paid, { id: p.id, txHash: H(1) });
  sessionAddress = MERCHANT;
  const rp = await post(cancel, { id: p.id });
  check("🚨 PAID is never cancellable → 409, names paid, points at refund-by-sending-back", rp.statusCode === 409 && /paid/.test(body(rp).error) && /refund|send/i.test(body(rp).error) && stored(p.id).status === "paid", rp.body);

  const s = await newOrder("0.10", "S");
  sessionAddress = BUYER_LOGIN; await post(paid, { id: s.id, circleId: "circle-1" });
  sessionAddress = MERCHANT;
  const rsub = await post(cancel, { id: s.id });
  check("🚨 SUBMITTED (a circleId, money in flight) → 409 'in flight', still submitted", rsub.statusCode === 409 && /in flight|submitted/i.test(body(rsub).error) && stored(s.id).status === "submitted", rsub.body);

  const x = await newOrder("0.10", "X");
  const rec = stored(x.id); rec.expiresAt = new Date(Date.now() - 1000).toISOString(); mem.set(orderKey(x.id), { json: JSON.stringify(rec), etag: "exp" });
  const rx = await post(cancel, { id: x.id });
  check("EXPIRED → 409 'already expired', nothing written", rx.statusCode === 409 && /expired/.test(body(rx).error) && mem.get(orderKey(x.id)).etag === "exp");

  const u = await newOrder("0.10", "U");
  const ru = stored(u.id); delete ru.createdAtBlock; mem.set(orderKey(u.id), { json: JSON.stringify(ru), etag: "legacy" });
  const rul = await post(cancel, { id: u.id });
  check("an UNBOUND legacy order (open) CAN be cancelled (cleanup)", rul.statusCode === 200 && stored(u.id).status === "cancelled");
}

section("2 — 🚨 checkout-paid on a cancelled order: refused BEFORE any chain read; the late note is written");
{
  reset();
  const o = await newOrder("0.10", "C");
  await post(cancel, { id: o.id });
  sessionAddress = BUYER_LOGIN;
  rpcCalls = 0;
  const hash = H(7);
  receipts.set(hash, receiptAt(150, 100_000n)); // a PERFECT receipt exists on chain
  const r = await post(paid, { id: o.id, txHash: hash });
  check("🚨 409 code:\"cancelled\"", r.statusCode === 409 && body(r).code === "cancelled", r.body);
  check("🚨 fetchReceipt was NOT called — zero RPC calls (no verification against a dead order)", rpcCalls === 0, `rpcCalls=${rpcCalls}`);
  check("🚨 no tx: claim written", !mem.has(txClaimKey(hash)));
  check("…the order stays cancelled, untouched", stored(o.id).status === "cancelled" && !stored(o.id).paidTx);
  const note = mem.get(lateKey(MERCHANT, o.id)) && JSON.parse(mem.get(lateKey(MERCHANT, o.id)).json);
  check("⭐ the LATE NOTE was written: late:<merchant>:<orderId> { txHash, by (the session login), at, verified:false }", !!note && note.txHash === hash && note.by?.toLowerCase() === BUYER_LOGIN && !!note.at && note.verified === false, JSON.stringify(note));
  check("⭐ the error tells the buyer the truth: cancelled by the seller, the transfer is NOT undone, refund = the seller", /cancelled/.test(body(r).error) && /seller/i.test(body(r).error) && /refund|send it back/i.test(body(r).error), body(r).error);
  check("…and the response carries lateReported:true so the page can say it was recorded", body(r).lateReported === true);
  const r2 = await post(paid, { id: o.id, txHash: H(8) });
  check("a second report → 409 again, first note SURVIVES (onlyIfNew)", r2.statusCode === 409 && JSON.parse(mem.get(lateKey(MERCHANT, o.id)).json).txHash === hash);
  const r3 = await post(paid, { id: o.id, circleId: "circle-9" });
  check("202-path (circleId, no hash) on a cancelled order → 409 cancelled, NO late note key change, no submitted transition", r3.statusCode === 409 && body(r3).code === "cancelled" && stored(o.id).status === "cancelled");
}

section("3 — the merchant listing surfaces the cancelled row WITH the late report");
{
  reset();
  const o = await newOrder("0.10", "L");
  const keep = await newOrder("0.20", "K");
  await post(cancel, { id: o.id });
  sessionAddress = BUYER_LOGIN; await post(paid, { id: o.id, txHash: H(3) });
  sessionAddress = MERCHANT;
  const r = await list({ httpMethod: "GET", headers: { authorization: "Bearer t" }, queryStringParameters: null });
  const rows = Object.fromEntries(body(r).orders.map((x) => [x.id, x]));
  check("⭐ cancelled row: status cancelled, cancelledAt, and lateReport { txHash, by, at, verified:false }", rows[o.id].status === "cancelled" && !!rows[o.id].cancelledAt && rows[o.id].lateReport?.txHash === H(3) && rows[o.id].lateReport.verified === false, JSON.stringify(rows[o.id]));
  check("an open row carries lateReport:null (readable absence), never undefined", rows[keep.id].lateReport === null);
}

section("4 — ⛔ KNOWN, DELIBERATE: the refused hash stays unclaimed and can settle another pre-dating open order");
{
  reset();
  head = 100;
  const cancelled = await newOrder("0.10", "cancelled one");
  const other = await newOrder("0.10", "the other, pre-dating the tx");
  await post(cancel, { id: cancelled.id });
  sessionAddress = BUYER_LOGIN;
  const hash = H(5); receipts.set(hash, receiptAt(150, 100_000n));
  const r1 = await post(paid, { id: cancelled.id, txHash: hash });
  check("refused against the cancelled order (409 cancelled), hash NOT claimed", r1.statusCode === 409 && !mem.has(txClaimKey(hash)));
  const r2 = await post(paid, { id: other.id, txHash: hash });
  check("⛔ the SAME hash then settles the other pre-dating open order — 200 paid (the merchant received that money once; a claim without a chain read would be a griefing vector)", r2.statusCode === 200 && body(r2).order.status === "paid" && stored(other.id).paidTx === hash, r2.body);
  const note = JSON.parse(mem.get(lateKey(MERCHANT, cancelled.id)).json);
  check("⭐ …and the ledger is COHERENT: the cancelled order's late note and the other order's paidTx name the SAME hash", note.txHash === hash && stored(other.id).paidTx === note.txHash);
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
