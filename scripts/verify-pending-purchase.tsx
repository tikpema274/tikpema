// verify-pending-purchase.tsx — A DATA BUY THAT MAY HAVE BEEN CHARGED IS NEVER "NO MONEY MOVED".
//
// ═══ 🚨 WHAT THIS GUARDS ═════════════════════════════════════════════════════════════════════
// maybeBuyData (_research.mjs) used to treat EVERY `!executed` from payX402 as "no money moved" and
// record nothing. Two of payX402's non-executed shapes say the opposite:
//
//   · pending:true      — ACCEPTED into a settlement batch; it WILL be charged (_x402.mjs 202 branch)
//   · charged:null      — the signed payment was SENT and no answer came; it MAY have been charged
//                         (_x402.mjs settle-timeout branch)
//   · handle, no 200    — accepted with a handle, and the retrieve then errored
//
// Recording nothing for those is an UNDER-COUNT of real spend from the operator pool — and it lets
// the next buy through a cap that should already have moved. This suite pins:
//   §1 pending        → a PENDING ledger entry with the seller's handle, counted against the caps
//   §2 settle-timeout → a PENDING entry (no handle exists), counted against the caps
//   §3 a GENUINE refusal (seller 402, pre-broadcast timeout) → NOTHING recorded
//   §4 a confirmed buy → UNCHANGED (same audit shape, no pending fields)
//   §5 an unresolved pending SURFACES: listed across days, returned by the Agents endpoint, rendered
//   §6 resolution: not-charged reverses EXACTLY ONCE; confirmed keeps the charge; both leave the list
//
// HOW: mocks only BOUNDARIES — @netlify/blobs (an in-memory store with etag CAS), the x402 wire
// (_x402.mjs), the pause switch, auth and wallet resolution. maybeBuyData, _budget.mjs and the
// Agents handler are the code under test and run for real. Zero network, ZERO MONEY.
//
//   npx tsx --experimental-test-module-mocks scripts/verify-pending-purchase.tsx

import { mock } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0, fail = 0;
const check = (label: string, cond: unknown, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const attempt = async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try { return await fn(); } catch (e: any) { fail++; console.log(`  ❌ ${label} THREW — ${e?.message ?? e}`); return undefined; }
};

// ── Boundary: an in-memory Netlify Blobs with etag CAS, one map per store name ──────────────────
const stores = new Map<string, Map<string, { data: any; etag: string }>>();
let etagSeq = 0;
const storeOf = (name: string) => {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name)!;
  const copy = (v: any) => JSON.parse(JSON.stringify(v));
  return {
    async get(key: string) { const h = m.get(key); return h ? copy(h.data) : null; },
    async getWithMetadata(key: string) { const h = m.get(key); return h ? { data: copy(h.data), etag: h.etag } : null; },
    async setJSON(key: string, value: any, opts: any = {}) {
      const cur = m.get(key);
      if (opts.onlyIfNew && cur) return { modified: false };
      if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
      m.set(key, { data: copy(value), etag: `e${++etagSeq}` });
      return { modified: true };
    },
    async set(key: string, value: any) { m.set(key, { data: JSON.parse(value), etag: `e${++etagSeq}` }); return { modified: true }; },
    async list({ prefix = "" } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(key: string) { m.delete(key); },
  };
};
mock.module("@netlify/blobs", { namedExports: { getStore: (n: any) => storeOf(typeof n === "string" ? n : n?.name), connectLambda: () => {} } });

// ── Boundary: the x402 wire. Each case sets the next payX402 result. ────────────────────────────
let nextPay: any = null;
let payCalls = 0;
mock.module("../netlify/functions/_x402.mjs", {
  namedExports: {
    fetchX402Requirements: async () => ({ ok: true, requirements: { amount: "100", payTo: "0xpayto", network: "eip155:test-network" } }),
    payX402: async () => { payCalls++; return nextPay; },
  },
});
mock.module("../netlify/functions/_pause.mjs", {
  namedExports: {
    assertNotPaused: async () => null,
    pauseStates: async () => ({}),
    setPaused: async () => ({}),
    globalHalt: () => null,
    ALL_AGENTS: "all",
  },
});
const OWNER = "0x00000000000000000000000000000000000a11ce";
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireSession: () => ({ address: "0xsession" }) } });
mock.module("../netlify/functions/_agent-wallets.mjs", {
  namedExports: {
    ensureOwnerWallet: async () => ({ walletAddress: OWNER }),
    WALLET_UNRESOLVABLE_STATUS: 503,
    walletUnresolvableRefusal: () => ({}),
    isWalletUnresolvable: () => false,
  },
});

process.env.DATA_SELLER_URL = "https://seller.test/arc";
process.env.DATA_PURCHASE_USDC = "0.01";
delete process.env.DD_WATCH_WEBHOOK; // the ledger-failure shout must not reach a network

const research = await import("../netlify/functions/_research.mjs");
const budget: any = await import("../netlify/functions/_budget.mjs");
const agentsFn: any = await import("../netlify/functions/agents.mjs");
const panel: any = await import("../src/components/AgentsPanel");

const BUDGET = () => stores.get("data-budget") ?? new Map();
// ⚠️ CLEAR the maps, never drop them: _budget caches its adapter, which holds the ORIGINAL map.
const reset = () => { for (const m of stores.values()) m.clear(); payCalls = 0; nextPay = null; };
const audits = () => [...BUDGET().entries()].filter(([k]) => k.startsWith("audit:")).map(([, v]) => v.data);
const allowedAudits = () => audits().filter((a) => a.allowed === true && !a.kind);
const dayTotal = () => {
  const rows = [...BUDGET().entries()].filter(([k]) => k.startsWith("day:")).map(([, v]) => v.data);
  return rows.reduce((s, r) => s + Number(r.spentUsdc || 0), 0);
};
const jobTotal = (jobId: string) => Number(BUDGET().get(`job:${jobId}`)?.data?.spentUsdc ?? 0);
const listPending = async () => (typeof budget.listPendingPurchases === "function"
  ? budget.listPendingPurchases({ owner: OWNER })
  : Promise.reject(new Error("listPendingPurchases is not exported")));

const buy = async (jobId: string) => {
  const outcome = research.newPurchaseOutcome();
  const facts = await research.maybeBuyData({
    apiKey: "k", model: "m", question: "what is the current block?", groundingBlock: "",
    jobId, jobPrice: 1, owner: OWNER, outcome,
    forceDecision: { kind: "onchain", method: "eth_blockNumber", params: [], justification: "live block" },
  });
  return { facts, outcome };
};

const PAYER = "0x6db396c1a37024fd3bee1f3dbf3020aa3b2bb380";

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────
section("§1 ACCEPTED, NOT YET CONFIRMED → recorded PENDING, with the handle");
reset();
nextPay = { status: 202, body: {
  executed: false, pending: true, seller: "https://seller.test/arc", payer: PAYER, priceUsdc: 0.0001,
  atomic: "100", payTo: "0xpayto", handle: "hdl-111", retrieve: "https://seller.test/arc?handle=hdl-111",
  payment: { status: "accepted", confirmed: false },
} };
{
  const r = await attempt("§1 buy", () => buy("job-1"));
  check("payX402 was actually called (the path reached the wire)", payCalls === 1);
  const pend = audits().filter((a) => a.confirmation === "pending");
  check("an audit entry is written with confirmation:\"pending\"", pend.length === 1, `got ${pend.length}`);
  check("…carrying the seller's handle", pend[0]?.pending?.handle === "hdl-111");
  check("…and the reason accepted-unconfirmed", pend[0]?.pending?.reason === "accepted-unconfirmed");
  check("the job counter is charged (a charge that WILL land narrows the cap now)", Math.abs(jobTotal("job-1") - 0.0001) < 1e-9, `job=${jobTotal("job-1")}`);
  check("the day counter is charged", Math.abs(dayTotal() - 0.0001) < 1e-9, `day=${dayTotal()}`);
  check("the outcome says PENDING, not 'no money moved'", r?.outcome?.code === "settle-pending", `code=${r?.outcome?.code}`);
  check("no facts are used from an unconfirmed buy", Array.isArray(r?.facts) && r!.facts.length === 0);
  const listed = await attempt("§1 list", listPending);
  check("the pending is LISTED as unresolved", listed?.length === 1 && listed[0]?.handle === "hdl-111", `listed=${listed?.length}`);
}

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────
section("§2 SETTLE TIMEOUT (charged:null) → recorded PENDING, no handle exists");
reset();
nextPay = { status: 502, body: {
  executed: false, step: "settle", indeterminate: true, charged: null, settled: null, retryable: false,
  reason: "settle-timeout", timeoutMs: 6000, payTo: "0xpayto", amountAtomic: "100", seller: "https://seller.test/arc",
} };
{
  const r = await attempt("§2 buy", () => buy("job-2"));
  const pend = audits().filter((a) => a.confirmation === "pending");
  check("an audit entry is written with confirmation:\"pending\"", pend.length === 1, `got ${pend.length}`);
  check("…with reason settle-timeout", pend[0]?.pending?.reason === "settle-timeout");
  check("…and handle recorded as null (none exists), not invented", pend[0]?.pending && pend[0].pending.handle === null);
  check("the day counter is charged (MAY-have-been-charged fails closed)", Math.abs(dayTotal() - 0.0001) < 1e-9, `day=${dayTotal()}`);
  check("the outcome says PENDING", r?.outcome?.code === "settle-pending", `code=${r?.outcome?.code}`);
  const listed = await attempt("§2 list", listPending);
  check("the pending is LISTED as unresolved", listed?.length === 1 && listed[0]?.reason === "settle-timeout");
}

section("§2b ACCEPTED WITH A HANDLE, THEN THE RETRIEVE ERRORED → PENDING");
reset();
nextPay = { status: 502, body: { executed: false, step: "retrieve", handle: "hdl-222", polls: 3, error: "retrieve returned 500" } };
{
  await attempt("§2b buy", () => buy("job-2b"));
  const pend = audits().filter((a) => a.confirmation === "pending");
  check("recorded as pending with the handle", pend.length === 1 && pend[0]?.pending?.handle === "hdl-222", `got ${pend.length}`);
  check("…reason retrieve-failed", pend[0]?.pending?.reason === "retrieve-failed");
}

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────
section("§3 A GENUINE REFUSAL → NOTHING recorded");
for (const [label, res] of [
  ["seller answered 402 (payment refused)", { status: 402, body: { executed: false, step: "settle", error: "Seller did not return 200 (got 402)", sellerStatus: 402 } }],
  ["pre-broadcast timeout (charged:false)", { status: 504, body: { executed: false, step: "sign", timeout: true, charged: false, settled: false } }],
  ["guard blocked before signing", { status: 200, body: { executed: false, blocked: "unexpected network eip155:1" } }],
] as const) {
  reset();
  nextPay = res;
  const r = await attempt(`§3 ${label}`, () => buy("job-3"));
  check(`${label}: no allowed audit entry`, allowedAudits().length === 0 && audits().filter((a) => a.confirmation === "pending").length === 0);
  check(`${label}: no counter charged`, dayTotal() === 0 && jobTotal("job-3") === 0);
  check(`${label}: outcome is settle-unconfirmed`, r?.outcome?.code === "settle-unconfirmed", `code=${r?.outcome?.code}`);
  const listed = await attempt(`§3 ${label} list`, listPending);
  check(`${label}: nothing listed as pending`, Array.isArray(listed) && listed.length === 0);
}

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────
section("§4 A CONFIRMED BUY IS UNCHANGED");
reset();
nextPay = { status: 200, body: {
  executed: true, seller: "https://seller.test/arc", payer: PAYER, priceUsdc: 0.0001, atomic: "100", payTo: "0xpayto",
  sellerBody: { jsonrpc: "2.0", id: 1, result: "0x10" },
  settleReceipt: { success: true, transaction: "d63f301a-b4a2-433a-b605-c5d8a4775441", network: "eip155:test-network" },
} };
{
  const r = await attempt("§4 buy", () => buy("job-4"));
  const a = allowedAudits();
  check("exactly one allowed audit entry", a.length === 1, `got ${a.length}`);
  check("it carries NO confirmation field (byte-identical to before)", a[0] && !("confirmation" in a[0]));
  check("it carries NO pending fields", a[0] && !("pending" in a[0]) && !("pendingId" in a[0]));
  check("it carries the settlement join", a[0]?.settlement?.id === "d63f301a-b4a2-433a-b605-c5d8a4775441");
  check("counters charged once", Math.abs(dayTotal() - 0.0001) < 1e-9 && Math.abs(jobTotal("job-4") - 0.0001) < 1e-9);
  check("counter records carry no chargedIds (unchanged shape)", ![...BUDGET().entries()].some(([k, v]) => (k.startsWith("day:") || k.startsWith("job:")) && "chargedIds" in v.data));
  check("outcome is purchased", r?.outcome?.code === "purchased", `code=${r?.outcome?.code}`);
  const listed = await attempt("§4 list", listPending);
  check("nothing listed as pending", Array.isArray(listed) && listed.length === 0);
}

// ── §5 ─────────────────────────────────────────────────────────────────────────────────────
section("§5 AN UNRESOLVED PENDING SURFACES WHERE A HUMAN SEES IT");
reset();
{
  // A pending from YESTERDAY must still be listed — the Agents activity feed shows only today, so
  // a pending that outlives its day would otherwise drop out of every view.
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  await attempt("§5 record yesterday", () => budget.recordSpend({
    jobId: "job-5", jobPriceUsdc: 1, amountUsdc: 0.0001, source: "seller.test", justification: "live block",
    owner: OWNER, at: yesterday, confirmation: "pending",
    pending: { reason: "settle-timeout", handle: null, retrieve: null, payTo: "0xpayto", amountAtomic: "100", seller: "https://seller.test/arc" },
  }));
  const listed = await attempt("§5 list", listPending);
  check("a pending from a PREVIOUS day is still listed", listed?.length === 1, `listed=${listed?.length}`);

  const res = await attempt("§5 agents GET", () => agentsFn.handler({ httpMethod: "GET", headers: {} }));
  const body = res ? JSON.parse(res.body) : {};
  check("the Agents endpoint returns pendingPurchases", Array.isArray(body.pendingPurchases) && body.pendingPurchases.length === 1,
    `got ${JSON.stringify(body.pendingPurchases)?.slice(0, 80)}`);

  const Notice = panel.PendingPurchasesNotice;
  const html = typeof Notice === "function"
    ? renderToStaticMarkup(React.createElement(Notice, { items: body.pendingPurchases ?? [], unreadable: false })) : "";
  check("the Agents panel renders the pending notice", /awaiting settlement/i.test(html), html.slice(0, 120));
  check("…and says it may still be charged — never 'no money moved'", /may still be charged/i.test(html) && !/no money moved/i.test(html));
  const unreadable = typeof Notice === "function"
    ? renderToStaticMarkup(React.createElement(Notice, { items: null, unreadable: true })) : "";
  check("an UNREADABLE pending list says so (never renders as 'none')", /could not read/i.test(unreadable), unreadable.slice(0, 120));
  const empty = typeof Notice === "function"
    ? renderToStaticMarkup(React.createElement(Notice, { items: [], unreadable: false })) : "x";
  check("an empty list renders nothing", empty === "");
}

// ── §6 ─────────────────────────────────────────────────────────────────────────────────────
section("§6 RESOLUTION — not-charged reverses EXACTLY once; confirmed keeps the charge");
reset();
nextPay = { status: 202, body: { executed: false, pending: true, payer: PAYER, priceUsdc: 0.0001, atomic: "100",
  payTo: "0xpayto", handle: "hdl-601", retrieve: "https://seller.test/arc?handle=hdl-601", seller: "https://seller.test/arc" } };
await attempt("§6 buy A", () => buy("job-6a"));
nextPay = { ...nextPay, body: { ...nextPay.body, handle: "hdl-602", retrieve: "https://seller.test/arc?handle=hdl-602" } };
await attempt("§6 buy B", () => buy("job-6b"));
{
  const before = dayTotal();
  check("two pendings charged", Math.abs(before - 0.0002) < 1e-9, `day=${before}`);
  const listed: any[] = (await attempt("§6 list", listPending)) ?? [];
  const A = listed.find((p) => p.handle === "hdl-601");
  const B = listed.find((p) => p.handle === "hdl-602");
  const resolve = (p: any, outcome: string) => budget.resolvePendingPurchase({ owner: OWNER, pendingId: p?.pendingId, outcome, evidence: "test" });

  const r1 = await attempt("§6 resolve A not-charged", () => resolve(A, "not-charged"));
  check("not-charged reverses the charge", Math.abs(dayTotal() - 0.0001) < 1e-9 && jobTotal("job-6a") === 0, `day=${dayTotal()} job=${jobTotal("job-6a")}`);
  check("…and reports it reversed", r1?.reversed === true);
  const r2 = await attempt("§6 resolve A again", () => resolve(A, "not-charged"));
  check("a SECOND not-charged is a no-op (no double credit)", Math.abs(dayTotal() - 0.0001) < 1e-9 && r2?.reversed === false, `day=${dayTotal()}`);

  await attempt("§6 resolve B confirmed", () => resolve(B, "confirmed"));
  check("confirmed KEEPS the charge", Math.abs(dayTotal() - 0.0001) < 1e-9 && Math.abs(jobTotal("job-6b") - 0.0001) < 1e-9);
  const after: any[] = (await attempt("§6 list after", listPending)) ?? ["x"];
  check("both leave the unresolved list", after.length === 0, `left=${after.length}`);
  const r3 = await attempt("§6 flip B to not-charged after confirmed", () => resolve(B, "not-charged"));
  check("a resolved pending cannot be re-resolved the other way (no credit after confirmed)", r3?.reversed === false && Math.abs(dayTotal() - 0.0001) < 1e-9);
  const bad = await budget.resolvePendingPurchase?.({ owner: OWNER, pendingId: A?.pendingId, outcome: "maybe" }).catch((e: any) => ({ threw: e.message }));
  check("an unknown outcome is REFUSED", bad && (bad.refused || bad.threw), JSON.stringify(bad)?.slice(0, 80));
  const kinds = audits().map((a) => a.kind).filter(Boolean);
  check("the trail records one reversal and one resolution", kinds.filter((k) => k === "reversal").length === 1 && kinds.filter((k) => k === "resolution").length === 1, kinds.join(","));
}

section("§6b CRASH SAFETY — a pending whose charge never landed cannot credit anything");
reset();
{
  // Simulate: the pending index was written, then the process died before the counters moved.
  await attempt("§6b seed", () => storeOf("data-budget").setJSON(`pending-buy:${OWNER}:orphan-1`, {
    pendingId: "orphan-1", owner: OWNER, status: "pending", amountUsdc: 0.0001, jobId: "job-6c",
    chargedKeys: [`job:job-6c`, `day:${OWNER}:${new Date().toISOString().slice(0, 10)}`],
    reason: "settle-timeout", handle: null, timestamp: new Date().toISOString(),
  }));
  const r = await attempt("§6b resolve", () => budget.resolvePendingPurchase({ owner: OWNER, pendingId: "orphan-1", outcome: "not-charged", evidence: "test" }));
  check("no counter goes NEGATIVE / no phantom credit", dayTotal() === 0 && jobTotal("job-6c") === 0, `day=${dayTotal()}`);
  check("…and it is reported as nothing-to-reverse", r?.reversed === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
