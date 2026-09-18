// verify-checkout-store.mjs — the order record: ids, keys, building, and the ONE transition writer.
//
//   node --experimental-test-module-mocks scripts/verify-checkout-store.mjs   (npm run test:checkoutstore)
//
// ═══ THE PROPERTIES ══════════════════════════════════════════════════════════════════════════════
//   1. An order is built with an EXACT 6dp amount (>6 places REFUSED, never rounded), refused above the per-tx cap WITH THE CAP NAMED,
//      refused without a description, and always `settlement:"direct"` + `status:"open"`.
//   2. `paid` is TERMINAL: open→paid once; a second paid is REFUSED, the first hash survives.
//   3. `submitted` (202, no hash) is NOT paid and can still become paid; nothing goes backwards.
//   4. `expired` is DERIVED from the clock at read time and blocks every transition.
//   5. An UNREADABLE store is refused as unreadable — never treated as "no such order" (absence ≠ safe).
//   6. CAS: a record changed between read and write is refused, not overwritten.
import { mock } from "node:test";
const mem = new Map();            // key -> { json, etag }
let etagSeq = 0, unreadable = false, changeUnderUs = null;
mock.module("@netlify/blobs", {
  namedExports: {
    getStore: () => ({
      getWithMetadata: async (k) => {
        if (unreadable) throw new Error("store down");
        const e = mem.get(k);
        return e ? { data: JSON.parse(e.json), etag: e.etag } : null;
      },
      setJSON: async (k, v, opts = {}) => {
        const cur = mem.get(k);
        if (opts.onlyIfNew && cur) return { modified: false };
        if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
        if (changeUnderUs && k === changeUnderUs) { changeUnderUs = null; return { modified: false }; }
        mem.set(k, { json: JSON.stringify(v), etag: `e${++etagSeq}` });
        return { modified: true, etag: `e${etagSeq}` };
      },
    }),
  },
});
const C = await import("../netlify/functions/_checkout.mjs");
const {
  buildOrder, mintOrderId, safeOrderId, ORDER_ID_RE, orderKey, merchantKey, formatUnits6,
  effectiveStatus, publicOrder, readOrder, writeNewOrder, transitionOrder, STATUS, SETTLEMENT, ORDER_TTL_MS,
} = C;

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const MERCHANT = "0x" + "ab".repeat(20);
const BUYER_SCA = "0x" + "cd".repeat(20);
const HASH1 = "0x" + "11".repeat(32), HASH2 = "0x" + "22".repeat(32);
const NOW = Date.parse("2026-09-18T20:00:00.000Z");
const reset = () => { mem.clear(); unreadable = false; changeUnderUs = null; };

console.log("\nverify-checkout-store — the order record and its one transition writer\n");

section("1 — ids and keys");
{
  const id = mintOrderId(NOW);
  check("minted id matches ORDER_ID_RE", ORDER_ID_RE.test(id), id);
  check("safeOrderId accepts it and rejects junk", safeOrderId(` ${id} `) === id && safeOrderId("id:x") === null && safeOrderId(42) === null);
  check("keys: record `id:<id>`, index `m:<merchantLower>:<id>`", orderKey(id) === `id:${id}` && merchantKey(MERCHANT.toUpperCase(), id) === `m:${MERCHANT.toLowerCase()}:${id}`);
  check("formatUnits6 is exact", formatUnits6(1500000n) === "1.500000" && formatUnits6(1n) === "0.000001" && formatUnits6(0n) === "0.000000");
}

section("2 — buildOrder: exact amount, cap named, description required, direct+open");
{
  const r = buildOrder({ merchant: MERCHANT, amountUsdc: "1.234567", description: "  Two   coffees ", capUsdc: 5, now: NOW });
  check("builds", !!r.order, r.error);
  check("⭐ amount stored EXACTLY as a 6dp string (1.234567 → \"1.234567\"; 1.5 → \"1.500000\")",
    r.order?.amountUsdc === "1.234567" && buildOrder({ merchant: MERCHANT, amountUsdc: 1.5, description: "x", capUsdc: 5 }).order?.amountUsdc === "1.500000", r.order?.amountUsdc);
  const seven = buildOrder({ merchant: MERCHANT, amountUsdc: "1.2345678", description: "x", capUsdc: 5, now: NOW });
  check("🚨 MORE than 6 places is REFUSED, never rounded or floored (a typed price is not ours to change)",
    !!seven.error && /6 decimal/.test(seven.error), seven.error);
  check("description trimmed + whitespace collapsed", r.order?.description === "Two coffees");
  check("settlement is direct, status is open", r.order?.settlement === SETTLEMENT.DIRECT && r.order?.status === STATUS.OPEN);
  check("expiresAt = createdAt + 14d", Date.parse(r.order.expiresAt) - Date.parse(r.order.createdAt) === ORDER_TTL_MS);
  const over = buildOrder({ merchant: MERCHANT, amountUsdc: "5.01", description: "x", capUsdc: 5, now: NOW });
  check("⭐ over the per-tx cap → refused WITH THE CAP NAMED", !!over.error && /5 USDC/.test(over.error) && over.cap === 5, over.error);
  check("exactly at the cap is allowed", !!buildOrder({ merchant: MERCHANT, amountUsdc: "5", description: "x", capUsdc: 5, now: NOW }).order);
  check("unreadable cap (NaN) → refused, never treated as no cap", /unreadable/.test(buildOrder({ merchant: MERCHANT, amountUsdc: "1", description: "x", capUsdc: NaN, now: NOW }).error || ""));
  check("no description → refused", /description/.test(buildOrder({ merchant: MERCHANT, amountUsdc: "1", description: "   ", capUsdc: 5 }).error || ""));
  check("141-char description → refused", /140/.test(buildOrder({ merchant: MERCHANT, amountUsdc: "1", description: "x".repeat(141), capUsdc: 5 }).error || ""));
  check("zero / negative / NaN / sub-unit / exponent amount → refused", ["0", "-1", "abc", "0.0000001", "1e-7", "", null].every((a) => !!buildOrder({ merchant: MERCHANT, amountUsdc: a, description: "x", capUsdc: 5 }).error));
  check("parseUnits6 is exact", C.parseUnits6("1.5") === 1500000n && C.parseUnits6("0.000001") === 1n && C.parseUnits6(2) === 2000000n && C.parseUnits6("1.2345678") === null);
  check("bad merchant address → refused", /address/.test(buildOrder({ merchant: "0x12", amountUsdc: "1", description: "x", capUsdc: 5 }).error || ""));
}

section("3 — write, read back, public view");
{
  reset();
  const { order } = buildOrder({ merchant: MERCHANT, amountUsdc: "1.5", description: "Coffee", capUsdc: 5, now: NOW });
  const w = await writeNewOrder(order);
  check("writeNewOrder ok", w.ok);
  check("record AND index written", mem.has(orderKey(order.id)) && mem.has(merchantKey(MERCHANT, order.id)));
  const again = await writeNewOrder(order);
  check("writing the same id again is refused (onlyIfNew)", !again.ok);
  const r = await readOrder(order.id);
  check("readOrder returns the record with an etag, readable", r.readable && r.order?.id === order.id && !!r.etag);
  const pub = publicOrder(r.order, NOW);
  check("public view carries merchant (the payee), amount, description, status open, no paidTx", pub.merchant === MERCHANT && pub.amountUsdc === "1.500000" && pub.status === "open" && pub.paidTx === null);
  check("effectiveStatus derives expired from the clock, never written", effectiveStatus(r.order, NOW + ORDER_TTL_MS + 1) === "expired" && JSON.parse(mem.get(orderKey(order.id)).json).status === "open");
}

section("4 — 🚨 transitions: paid is terminal, submitted is not paid, nothing goes backwards");
{
  reset();
  const { order } = buildOrder({ merchant: MERCHANT, amountUsdc: "1.5", description: "Coffee", capUsdc: 5, now: NOW });
  await writeNewOrder(order);
  const p1 = await transitionOrder({ id: order.id, from: "open", to: "paid", patch: { paidTx: HASH1, paidBy: BUYER_SCA, paidAt: new Date(NOW).toISOString() }, now: NOW });
  check("⭐ open → paid with a hash", p1.ok && p1.order.status === "paid" && p1.order.paidTx === HASH1, p1.reason);
  const p2 = await transitionOrder({ id: order.id, from: "open", to: "paid", patch: { paidTx: HASH2 }, now: NOW });
  check("🚨 a SECOND paid is refused (order is paid, not open)", !p2.ok && /paid/.test(p2.reason), p2.reason);
  check("🚨 …and the FIRST hash survives", JSON.parse(mem.get(orderKey(order.id)).json).paidTx === HASH1);
  const back = await transitionOrder({ id: order.id, from: "paid", to: "open", patch: {}, now: NOW });
  check("paid → open is not a transition", !back.ok);
  check("index carries the paid record too", JSON.parse(mem.get(merchantKey(MERCHANT, order.id)).json).status === "paid");

  const { order: o2 } = buildOrder({ merchant: MERCHANT, amountUsdc: "2", description: "Tea", capUsdc: 5, now: NOW });
  await writeNewOrder(o2);
  const s1 = await transitionOrder({ id: o2.id, from: "open", to: "submitted", patch: { circleId: "circle-1", paidBy: BUYER_SCA }, now: NOW });
  check("⭐ open → submitted (202: circleId, no hash)", s1.ok && s1.order.status === "submitted" && !s1.order.paidTx);
  check("🚨 submitted reads as submitted, NOT paid", effectiveStatus(s1.order, NOW) === "submitted" && publicOrder(s1.order, NOW).status === "submitted");
  const s2 = await transitionOrder({ id: o2.id, from: "submitted", to: "paid", patch: { paidTx: HASH1 }, now: NOW });
  check("⭐ submitted → paid once a hash is verified", s2.ok && s2.order.paidTx === HASH1, s2.reason);
  const s3 = await transitionOrder({ id: o2.id, from: "paid", to: "submitted", patch: {}, now: NOW });
  check("paid → submitted is refused", !s3.ok);
}

section("5 — expiry, absence, unreadable, CAS");
{
  reset();
  const { order } = buildOrder({ merchant: MERCHANT, amountUsdc: "1", description: "Old", capUsdc: 5, now: NOW });
  await writeNewOrder(order);
  const late = await transitionOrder({ id: order.id, from: "open", to: "paid", patch: { paidTx: HASH1 }, now: NOW + ORDER_TTL_MS + 1 });
  check("⭐ an expired order refuses every transition (status named as expired)", !late.ok && late.status === "expired", late.reason);
  const none = await transitionOrder({ id: mintOrderId(NOW), from: "open", to: "paid", patch: {}, now: NOW });
  check("no such order → refused as such", !none.ok && /no such order/.test(none.reason));
  unreadable = true;
  const ur = await readOrder(order.id);
  check("🚨 unreadable store → readable:false, NOT order:null-as-absent", ur.readable === false && ur.order === null);
  const urt = await transitionOrder({ id: order.id, from: "open", to: "paid", patch: {}, now: NOW });
  check("🚨 …and the transition is refused as UNREADABLE, never as 'no such order'", !urt.ok && /unreadable/.test(urt.reason) && !/no such/.test(urt.reason), urt.reason);
  unreadable = false;
  changeUnderUs = orderKey(order.id);
  const cas = await transitionOrder({ id: order.id, from: "open", to: "paid", patch: { paidTx: HASH1 }, now: NOW });
  check("⭐ CAS: a record changed under us is refused, not overwritten", !cas.ok && /changed under us/.test(cas.reason), cas.reason);
  check("…and the stored record is still open", JSON.parse(mem.get(orderKey(order.id)).json).status === "open");
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
