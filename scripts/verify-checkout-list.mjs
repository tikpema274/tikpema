// verify-checkout-list.mjs — a merchant lists ONLY their own orders, from the verified session, never from a field.
//
//   node --experimental-test-module-mocks scripts/verify-checkout-list.mjs   (npm run test:checkoutlist)
//
// ═══ THE GAP (live, 2026-09-19) ══════════════════════════════════════════════════════════════════
// A merchant who lost the tab had no way to find a checkout link again: the m:<merchant>:<orderId> index
// was written on every create/transition and read by NOTHING. checkout-list reads it — and the ONLY
// thing that chooses the prefix is the session token's address. A merchant field in the query or body
// is ignored, so a session cannot list anyone else's orders by asking.
//
// ═══ THE PROPERTIES ══════════════════════════════════════════════════════════════════════════════
//   1. No session → 401. GET only.
//   2. The prefix is m:<session address, lower-cased>: — asserted by what the store was ASKED for, and
//      by two sessions each seeing only their own rows. A ?merchant= of the other merchant changes nothing.
//   3. Rows = publicOrder + the merchant's own fields (paidBy, paidUnits, paidAtBlock); `expired` derived
//      at read time; newest first; capped.
//   4. The listing is EVENTUAL: the response says so (`note`), and a store that fails to list is 503,
//      never an empty list. [[absence-must-never-read-as-safe]]
import { mock } from "node:test";

const mem = new Map();
let listFails = false;
const asked = [];
mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {},
    getStore: () => ({
      list: async ({ prefix }) => {
        asked.push(prefix);
        if (listFails) throw new Error("list down");
        return { blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, etag: "e" })) };
      },
      get: async (k) => { const e = mem.get(k); return e ? JSON.parse(e) : null; },
      getWithMetadata: async (k) => { const e = mem.get(k); return e ? { data: JSON.parse(e), etag: "e" } : null; },
      setJSON: async (k, v) => { mem.set(k, JSON.stringify(v)); return { modified: true }; },
    }),
  },
});
let sessionAddress = null;
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireSession: () => (sessionAddress ? { address: sessionAddress, method: "passkey" } : null) } });

const { handler } = await import("../netlify/functions/checkout-list.mjs");
const { merchantKey, orderKey, buildOrder, ORDER_TTL_MS } = await import("../netlify/functions/_checkout.mjs");

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const A = "0x" + "aa".repeat(20), B = "0x" + "bb".repeat(20);
const NOW = Date.parse("2026-09-19T15:00:00.000Z");
const get = (qs = "", extra = {}) => handler({ httpMethod: "GET", headers: { authorization: "Bearer t" }, queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : null, ...extra });
const body = (r) => JSON.parse(r.body);
const put = (order) => { mem.set(orderKey(order.id), JSON.stringify(order)); mem.set(merchantKey(order.merchant, order.id), JSON.stringify(order)); return order; };
const mk = (merchant, amountUsdc, description, now, patch = {}) => put({ ...buildOrder({ merchant, amountUsdc, description, capUsdc: 5, createdAtBlock: 100, now }).order, ...patch });

console.log("\nverify-checkout-list — a merchant's own orders, from the session, never from a field\n");

section("1 — no session → 401; POST → 405");
{
  sessionAddress = null;
  const r = await get();
  check("🚨 no session → 401, no orders", r.statusCode === 401 && !body(r).orders, r.body);
  sessionAddress = A;
  const p = await handler({ httpMethod: "POST", headers: {}, body: "{}" });
  check("POST → 405", p.statusCode === 405);
}

section("2 — 🚨 the prefix comes from the SESSION; another merchant's orders never appear");
{
  mem.clear(); asked.length = 0;
  const a1 = mk(A, "1", "A one", NOW - 3000);
  const a2 = mk(A, "2", "A two", NOW - 1000);
  const b1 = mk(B, "3", "B one", NOW - 2000);
  sessionAddress = A;
  const ra = await get();
  const idsA = body(ra).orders.map((o) => o.id);
  check("⭐ session A lists A's two orders, newest first", ra.statusCode === 200 && idsA.length === 2 && idsA[0] === a2.id && idsA[1] === a1.id, JSON.stringify(idsA));
  check("🚨 …and NOT B's", !idsA.includes(b1.id));
  check("🚨 the store was asked for exactly m:<A lower>: (the session address), nothing else", asked.length === 1 && asked[0] === `m:${A.toLowerCase()}:`, JSON.stringify(asked));
  asked.length = 0;
  const spoof = await get(`merchant=${B}`);
  const idsS = body(spoof).orders.map((o) => o.id);
  check("🚨 ?merchant=<B> is IGNORED: still A's orders, still A's prefix", idsS.length === 2 && !idsS.includes(b1.id) && asked[0] === `m:${A.toLowerCase()}:`, JSON.stringify({ idsS, asked }));
  const spoofBody = await handler({ httpMethod: "GET", headers: { authorization: "Bearer t" }, queryStringParameters: null, body: JSON.stringify({ merchant: B }) });
  check("…a body field is ignored too", body(spoofBody).orders.every((o) => o.merchant === A));
  sessionAddress = B;
  const rb = await get();
  const idsB = body(rb).orders.map((o) => o.id);
  check("⭐ session B lists only B's one order", idsB.length === 1 && idsB[0] === b1.id, JSON.stringify(idsB));
  sessionAddress = A.toUpperCase().replace("0X", "0x");
  const rc = await get();
  check("a mixed-case session address still maps to the lower-cased prefix (same rows)", body(rc).orders.length === 2);
}

section("3 — rows: publicOrder + merchant fields; expired derived; unbound flagged; cap");
{
  mem.clear(); sessionAddress = A;
  const open = mk(A, "0.5", "open", NOW - 5000);
  const paid = mk(A, "0.1", "paid", NOW - 4000, { status: "paid", paidTx: "0x" + "11".repeat(32), paidBy: "0x" + "cd".repeat(20), paidUnits: "100000", paidAt: new Date(NOW - 3500).toISOString(), paidAtBlock: 150 });
  const sub = mk(A, "0.2", "submitted", NOW - 3000, { status: "submitted", circleId: "circle-1", paidBy: "0x" + "cd".repeat(20) });
  const old = mk(A, "0.3", "old", NOW - ORDER_TTL_MS - 60_000);
  const legacy = put({ ...buildOrder({ merchant: A, amountUsdc: "0.15", description: "legacy", capUsdc: 5, createdAtBlock: 7, now: NOW - 2000 }).order, createdAtBlock: undefined });
  const r = await get();
  const rows = Object.fromEntries(body(r).orders.map((o) => [o.description, o]));
  check("five rows", body(r).orders.length === 5);
  check("⭐ paid row carries paidTx, paidBy, paidUnits, paidAt, paidAtBlock (the merchant's own fields)", rows.paid.paidTx === paid.paidTx && rows.paid.paidBy === paid.paidBy && rows.paid.paidUnits === "100000" && rows.paid.paidAtBlock === 150 && !!rows.paid.paidAt, JSON.stringify(rows.paid));
  check("open row: status open, paidTx null, paidBy null", rows.open.status === "open" && rows.open.paidTx === null && rows.open.paidBy === null);
  check("submitted row: status submitted, circleId, NO paidTx", rows.submitted.status === "submitted" && rows.submitted.circleId === "circle-1" && rows.submitted.paidTx === null);
  check("⭐ expired is DERIVED at read time (stored status is open)", rows.old.status === "expired" && JSON.parse(mem.get(orderKey(old.id))).status === "open");
  check("⭐ legacy row: createdAtBlock null (the UI says 'cannot be settled')", rows.legacy.createdAtBlock === null);
  check("every row carries id, amountUsdc, description, createdAt, expiresAt, merchant", body(r).orders.every((o) => o.id && o.amountUsdc && o.description && o.createdAt && o.expiresAt && o.merchant === A));
  check("⭐ the response says the listing is EVENTUAL (a link made seconds ago may be missing)", /lag|seconds|eventual/i.test(body(r).note || ""), body(r).note);
  check("…and carries listedAt", !!body(r).listedAt);
  mem.clear();
  for (let i = 0; i < 120; i++) mk(A, "1", `bulk ${i}`, NOW - i * 1000);
  const big = await get();
  check("capped at 100, newest first, and the cap is STATED (truncated:true, total)", body(big).orders.length === 100 && body(big).orders[0].description === "bulk 0" && body(big).truncated === true && body(big).total === 120, JSON.stringify({ n: body(big).orders.length, truncated: body(big).truncated, total: body(big).total }));
}

section("4 — 🚨 a store that cannot list is 503, never an empty list");
{
  mem.clear(); sessionAddress = A; mk(A, "1", "x", NOW);
  listFails = true;
  const r = await get();
  check("🚨 list failure → 503 with 'unreadable', no `orders` array (absence is not safe)", r.statusCode === 503 && /unreadable/i.test(body(r).error) && !("orders" in body(r)), r.body);
  listFails = false;
  const ok = await get();
  check("…and an EMPTY merchant is 200 with orders:[] (a real empty, not a failure)", (() => { mem.clear(); return true; })() && ok.statusCode === 200);
  const empty = await get();
  check("empty → 200, orders:[], note still present", empty.statusCode === 200 && Array.isArray(body(empty).orders) && body(empty).orders.length === 0 && !!body(empty).note);
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
