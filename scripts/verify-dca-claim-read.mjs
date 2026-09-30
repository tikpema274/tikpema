// verify-dca-claim-read.mjs — a FAILED read of a DCA fill claim is never "no claim".
//
//   node --experimental-test-module-mocks scripts/verify-dca-claim-read.mjs   (npm run test:dcaclaimread)
//
// ═══ ZERO MONEY, ZERO NETWORK ═══ Blobs in-memory; executeAction / circle / balances scripted; the REAL
// dca-tick handler runs.
//
// ═══ THE DEFECTS (sweep, 2026-09-30) — both were `fills.get(...).catch(() => null)` ═══════════════════
//   A. dca-tick :590, the IDEMPOTENCY CLAIM before a swap. A failed read → null → the tick OVERWROTE the
//      claim with "claimed" and swapped again. When the old claim was "submitted", that also ERASED the
//      in-flight fill's circleId — the only record of what is owed. (The mandate's pendingPeriod /
//      lastFilledPeriod run first; this claim is the guard for a stale mandate read or a concurrent tick.)
//   B. dca-tick :260, the RECONCILE of a pending fill. A failed read → "claim missing" → pendingPeriod
//      DROPPED WITHOUT LEDGERING: a real, submitted swap abandoned; spentAmount and the DCA day share
//      understated — fail-OPEN on the caps. (Not in the sweep's list; found reading :590's neighbour.)
// ⭐ Both now: a thrown read changes NOTHING about the claim and NOTHING about the fill — skip / leave
//    pending, say why, retry next tick. [[absence-must-never-read-as-safe]]
import { mock } from "node:test";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

const maps = new Map();
const getThrows = new Set();   // store names whose get() throws; writes still work (we must SEE any write)
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  if (!maps.has(nm)) maps.set(nm, new Map());
  const m = maps.get(nm);
  return {
    async get(k, opts) { if (getThrows.has(nm)) throw new Error("blobs read failed"); const v = m.get(k); if (v == null) return null; return opts?.type === "json" ? structuredClone(v) : JSON.stringify(v); },
    async getJSON(k) { if (getThrows.has(nm)) throw new Error("blobs read failed"); return m.get(k) ?? null; },
    async setJSON(k, v, opts) { if (opts?.onlyIfNew && m.has(k)) return { modified: false }; m.set(k, structuredClone(v)); return { modified: true }; },
    async setIfNew(k, v) { if (m.has(k)) return false; m.set(k, structuredClone(v)); return true; },
    async getWithMetadata(k) { const v = m.get(k); return v ? { data: v, etag: "e" } : null; },
    async list(pfx) {
      const p = typeof pfx === "string" ? pfx : pfx?.prefix ?? "";
      const keys = [...m.keys()].filter((x) => x.startsWith(p));
      return typeof pfx === "string" ? keys : { blobs: keys.map((key) => ({ key })) };
    },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });
mock.module("../netlify/functions/_blobs.mjs", { namedExports: { connectBlobs: () => {}, strongReadAvailable: () => true } });
mock.module("../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => null } });
let getTxCalls = 0;
mock.module("../netlify/functions/_circle.mjs", { namedExports: {
  circle: () => ({ getTransaction: async () => { getTxCalls++; return { data: { transaction: { state: "COMPLETE", txHash: "0xabc" } } }; } }),
  waitForTx: async () => "0xabc", TxPendingError: class extends Error {},
}});
const realSwap = await import("../netlify/functions/_swap.mjs");
const realArc = await import("../netlify/functions/_arc.mjs");
const realDca = await import("../netlify/functions/_dca.mjs");
mock.module("../netlify/functions/_swap.mjs", { namedExports: { ...realSwap, valueInUsdc: async ({ amount }) => Number(amount), agentSwap: async () => ({}) } });
mock.module("../netlify/functions/_arc.mjs", { namedExports: { ...realArc, swapCapUsdc: () => 25 } });
mock.module("../netlify/functions/_dca.mjs", { namedExports: { ...realDca, readTokenBalance: async () => 100 } });
let swaps = 0;
mock.module("../netlify/functions/_actions.mjs", { namedExports: {
  executeAction: async () => { swaps++; return { ok: true, kind: "swap_tokens", swap: { txHash: "0xnew", circleId: "cid-NEW", state: "confirmed" } }; },
}});

const { handler } = await import("../netlify/functions/dca-tick.mjs");
const { fillClaimKey, periodFor, mandateKey } = realDca;
const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };

const NOW = Date.now();
const mandate = (id, owner, patch = {}) => ({
  id, owner, walletAddress: owner, status: "active", tokenIn: "USDC", tokenOut: "EURC",
  perTickAmount: 0.05, totalBudgetAmount: 1, cadenceMs: 3_600_000, endAt: NOW + 86_400_000,
  createdAt: NOW - 7_200_000, spentAmount: 0, pendingPeriod: null, consecutiveFailures: 0, consecutiveUnconfirmed: 0, ...patch,
});

section("A — ⛔ the idempotency claim read FAILS before a swap (:590)");
{
  const OWNER = "0x" + "aa".repeat(20);
  const m = mandate("claim-a", OWNER);
  const period = periodFor(m, NOW);
  memStore("dca-mandates").setJSON(mandateKey(OWNER, m.id), m);
  // A prior invocation already SUBMITTED this period (the mandate read here is the stale one).
  const inFlight = { mandateId: m.id, period, status: "submitted", circleId: "cid-IN-FLIGHT", fillValueUsdc: 0.05, submittedAt: "2026-09-30T12:00:00Z" };
  await memStore("dca-fills").setJSON(fillClaimKey(m.id, period), inFlight);
  swaps = 0; getThrows.add("dca-fills");
  const beat = JSON.parse((await quiet(() => handler({}))).body ?? "{}");
  getThrows.delete("dca-fills");
  const claim = maps.get("dca-fills").get(fillClaimKey(m.id, period));
  check("⭐⭐ NO swap — a claim we cannot read is not 'no claim'", swaps === 0, `swaps=${swaps}`);
  check("⭐⭐ the in-flight claim is UNTOUCHED — status submitted, circleId intact", claim?.status === "submitted" && claim?.circleId === "cid-IN-FLIGHT", JSON.stringify(claim));
  const mm = maps.get("dca-mandates").get(mandateKey(OWNER, m.id));
  check("⭐ the mandate is NOT stopped and NOT marked filled (a retryable skip)", mm.status === "active" && mm.lastFilledPeriod !== period, JSON.stringify({ status: mm.status, lastFilledPeriod: mm.lastFilledPeriod }));
  const hb = maps.get("dca-heartbeat")?.get("last") ?? {};
  const said = (hb.details ?? []).find((d) => d.id === m.id);
  check("⭐ …and the tick's record SAYS why (the claim could not be read, nothing changed)", /claim .* could not be read/i.test(said?.reason ?? ""), JSON.stringify(said));
}

section("B — ⛔ the reconcile read of a PENDING fill FAILS (:260)");
{
  const OWNER = "0x" + "bb".repeat(20);
  const P = 7;
  const m = mandate("claim-b", OWNER, { pendingPeriod: P, lastFilledPeriod: undefined });
  memStore("dca-mandates").setJSON(mandateKey(OWNER, m.id), m);
  await memStore("dca-fills").setJSON(fillClaimKey(m.id, P), { mandateId: m.id, period: P, status: "submitted", circleId: "cid-PENDING", fillValueUsdc: 0.05, submittedAt: new Date(NOW - 60_000).toISOString() });
  swaps = 0; getTxCalls = 0; getThrows.add("dca-fills");
  const beat = JSON.parse((await quiet(() => handler({}))).body ?? "{}");
  getThrows.delete("dca-fills");
  const mm = maps.get("dca-mandates").get(mandateKey(OWNER, m.id));
  check("⭐⭐ the pending pointer is KEPT — a real submitted fill is never dropped on an unreadable claim", mm.pendingPeriod === P, `pendingPeriod=${mm.pendingPeriod}`);
  const hbB = (maps.get("dca-heartbeat")?.get("last")?.details ?? []).find((d) => d.id === m.id);
  check("⭐ the tick's record says the claim could not be read", /claim .* could not be read/i.test(hbB?.reason ?? ""), JSON.stringify(hbB));
  check("⭐⭐ …not recorded as PENDING_DROPPED / 'claim missing'", !/pending-dropped|claim missing/i.test(JSON.stringify(mm)) && !(beat.unresolvable > 0), JSON.stringify({ last: mm.lastOutcome, reason: mm.lastReason, unresolvable: beat.unresolvable }));
  check("⭐ …the claim is untouched", maps.get("dca-fills").get(fillClaimKey(m.id, P))?.circleId === "cid-PENDING");
  check("⭐ …and no new swap this tick (the pending fill is settled first)", swaps === 0, `swaps=${swaps}`);

  // The store comes back: the SAME pending fill now reconciles normally.
  getTxCalls = 0;
  await quiet(() => handler({}));
  const after = maps.get("dca-mandates").get(mandateKey(OWNER, m.id));
  check("once the claim reads again, the pending fill RECONCILES (Circle asked, pointer cleared)", getTxCalls >= 1 && after.pendingPeriod == null, `getTx=${getTxCalls} pendingPeriod=${after.pendingPeriod}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-dca-claim-read — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
