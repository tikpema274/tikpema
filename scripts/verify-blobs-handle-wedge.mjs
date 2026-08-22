// verify-blobs-handle-wedge.mjs — THE STALE BLOBS HANDLE, AND THE WEDGE THAT REPORTED errors:0.
//
//   node --experimental-test-module-mocks scripts/verify-blobs-handle-wedge.mjs  (npm run test:wedge)
//
// ═══ ZERO MONEY, ZERO NETWORK ═══ Blobs in-memory, circle()/executeAction/pause all scripted.
//
// ═══ 🚨 THE PRODUCTION INCIDENT THIS PINS — 2026-08-22 ════════════════════════════════════════
// A DCA fill at 17:12:06 succeeded and built _budget.mjs's memoised store adapter. The adapter is
// bound to the Blobs token live at that moment (~15 min TTL). The next fill came due at 18:00 and
// EVERY tick from 18:00:44 on deferred with "Failed to decode token: Token exp…", forever, because
// nothing rebuilt the handle.
//
// ⭐ THE DISCRIMINATOR THAT IDENTIFIED IT, worth keeping: in the SAME invocation dca-tick's own
// stores worked (it calls getStore INSIDE the handler, so they are fresh) while every budget call
// failed — and the tick's injected token was fresh, tokenExp.remainingAtStartMs ~899 000. Same
// Blobs, same live token, one path working and one not. The only difference was the memo.
//
// ⭐⭐ AND THE WORSE HALF WAS THE REPORTING. `errors` stayed 0 — correctly, a defer is not an error
// — so every wedged tick logged at INFO in the same shape as a healthy one, with `deferred=1`
// buried mid-line among fourteen counters. The tick reported healthy for as long as it was broken.
import { mock } from "node:test";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);

// ── the store, with a CALL COUNTER (how many times a handle was built) and a THROW switch ──────
const maps = [];
let etagSeq = 0;
let storeBuilds = 0;               // getStore() invocations, per store name
const throwFor = new Set();        // store names whose every call throws a Blobs-transient error
const blobsTokenError = () =>
  Object.assign(new Error("Netlify Blobs has generated an internal error (Failed to decode token: Token exp)"), { name: "BlobsInternalError" });

const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  storeBuilds++;
  let m = maps.find((x) => x._n === nm);
  if (!m) { m = new Map(); m._n = nm; maps.push(m); }
  const guard = () => { if (throwFor.has(nm)) throw blobsTokenError(); };
  return {
    async get(k, opts) { guard(); const e = m.get(k); if (e == null) return null; return opts?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { guard(); return m.get(k)?.value ?? null; },
    async setJSON(k, v, opts) {
      guard();
      const cur = m.get(k);
      if (opts?.onlyIfNew && cur) return { modified: false };
      m.set(k, { value: v, etag: `e${++etagSeq}` }); return { modified: true };
    },
    async setIfNew(k, v) { guard(); if (m.has(k)) return false; m.set(k, { value: v, etag: `e${++etagSeq}` }); return true; },
    async getWithMetadata(k) { guard(); const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(pfx) {
      guard();
      const p = typeof pfx === "string" ? pfx : pfx?.prefix ?? "";
      const keys = [...m.keys()].filter((x) => x.startsWith(p));
      return typeof pfx === "string" ? keys : { blobs: keys.map((key) => ({ key })) };
    },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });
mock.module("../netlify/functions/_blobs.mjs", { namedExports: {
  connectBlobs: () => {}, strongReadAvailable: () => true,
}});
mock.module("../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => null } });
mock.module("../netlify/functions/_circle.mjs", { namedExports: {
  circle: () => ({ getTransaction: async () => ({ data: { transaction: { state: "COMPLETE", txHash: "0xabc" } } }) }),
  waitForTx: async () => "0xabc", TxPendingError: class extends Error {},
}});
// ⚠️ SPREAD THE REAL MODULES rather than hand-listing exports. A hand-written namedExports list is
// a second copy of the module's surface: it drifts, and the failure is a SyntaxError in a
// transitively-imported file that has nothing to do with the test ([[duplicate-source-of-truth]]).
// Only the few functions that would touch the chain or a cap are overridden.
const realSwap = await import("../netlify/functions/_swap.mjs");
const realArc = await import("../netlify/functions/_arc.mjs");
mock.module("../netlify/functions/_swap.mjs", { namedExports: {
  ...realSwap, valueInUsdc: async ({ amount }) => Number(amount), agentSwap: async () => ({}),
}});
mock.module("../netlify/functions/_arc.mjs", { namedExports: {
  ...realArc, swapCapUsdc: () => 25, readTokenBalance: async () => 100,
}});
mock.module("../netlify/functions/_actions.mjs", { namedExports: {
  executeAction: async () => ({ ok: true, kind: "swap_tokens", swap: { txHash: "0xabc", circleId: "cid-1", state: "confirmed" } }),
}});

const budget = await import("../netlify/functions/_budget.mjs");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  THE STALE HANDLE, AND THE WEDGE THAT LOOKED HEALTHY                 ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE HANDLE IS REBUILT WHEN THE BLOBS CONTEXT CHANGES");
{
  const OWNER = "0x" + "11".repeat(20);
  const AT = Date.parse("2026-08-22T18:00:00.000Z");
  const spend = () => budget.recordAgentSpend({
    owner: OWNER, amountUsdc: 0.05, source: "swap_tokens", justification: "handle probe", at: AT,
  });

  process.env.NETLIFY_BLOBS_CONTEXT = "ctx-token-A";
  storeBuilds = 0;
  await spend();
  const afterFirst = storeBuilds;
  await spend();
  const afterSecond = storeBuilds;
  check("⭐ the handle is REUSED while the context is unchanged — the memo still does its job",
    afterSecond === afterFirst, `builds ${afterFirst} → ${afterSecond}`);

  // The token is rotated. connectLambda overwrites NETLIFY_BLOBS_CONTEXT wholesale, so a new token
  // IS a new string — which is exactly what makes the compare exact without parsing the token.
  process.env.NETLIFY_BLOBS_CONTEXT = "ctx-token-B";
  await spend();
  check("⭐⭐ …and REBUILT when the context changes — the wedge's root cause, closed",
    storeBuilds > afterSecond, `builds ${afterSecond} → ${storeBuilds}`);

  // 🚨 THE REGRESSION THAT WOULD REINTRODUCE THE INCIDENT: a handle that survives a token rotation.
  // Pinned as its own assertion because "it still works" is true of the broken version too — right
  // up until the first token expiry, which is ~15 minutes after anyone would have tested it.
  const day = await budget.daySpend({ owner: OWNER, at: AT });
  check("🚨 …and all three writes still landed on ONE counter — rebuilding is not re-initialising",
    day === 0.15, `day=${day}`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨🚨 A WEDGE MUST NOT REPORT AS HEALTHY");
{
  const { handler } = await import("../netlify/functions/dca-tick.mjs");
  const OWNER = "0x" + "22".repeat(20);
  const mandates = memStore("dca-mandates");
  const NOW = Date.now();
  await mandates.setJSON(`mandate:${OWNER}:wedge-1`, {
    id: "wedge-1", owner: OWNER, walletAddress: OWNER, status: "active",
    tokenIn: "USDC", tokenOut: "EURC", perTickAmount: 0.05, totalBudgetAmount: 1,
    cadenceMs: 3_600_000, endAt: NOW + 86_400_000, createdAt: NOW - 7_200_000,
    spentAmount: 0, pendingPeriod: null, consecutiveFailures: 0, consecutiveUnconfirmed: 0,
  });

  // The budget store — and ONLY it — fails, reproducing the incident exactly: dca-tick's own
  // stores are fine, the injected token is fine, the budget handle is the broken one.
  throwFor.add("data-budget");

  const realLog = console.log, realErr = console.error, realFetch = globalThis.fetch;
  const logs = [], errs = [], posts = [];
  process.env.DD_WATCH_WEBHOOK = "https://example.invalid/hook";
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  globalThis.fetch = async (u, i) => { posts.push({ u, i }); return { ok: true }; };

  const beats = [];
  for (let i = 0; i < 3; i++) beats.push(JSON.parse((await handler({})).body ?? "{}"));
  const hb = () => maps.find((m) => m._n === "dca-heartbeat")?.get("last")?.value ?? {};

  console.log = realLog; console.error = realErr; globalThis.fetch = realFetch;

  const tickLines = logs.filter((l) => l.startsWith("[dca-tick] "));
  const wedgeLines = errs.filter((l) => l.startsWith("[dca-tick][WEDGED] "));

  check("⭐ every tick DEFERRED — the budget store is unreachable",
    beats.every((b) => b.deferred === 1), JSON.stringify(beats.map((b) => b.deferred)));
  check("⭐⭐ …and `errors` stayed 0 throughout — a defer is NOT an error, and that is correct",
    hb().errors === 0, `errors=${hb().errors}`);
  check("🚨🚨 …so the WEDGE needed its own signal: the 3rd tick escalates to console.ERROR",
    wedgeLines.length >= 1, `${wedgeLines.length} wedge line(s), ${tickLines.length} info line(s)`);
  check("⭐ …the first two ticks do NOT escalate — a transient defer must stay quiet",
    tickLines.length === 2 && wedgeLines.length === 1,
    `info=${tickLines.length} wedged=${wedgeLines.length}`);
  check("⭐⭐ …and the wedge line SAYS errors=0 does not mean healthy, rather than leaving a number to interpret",
    /errors=0 is expected here and does NOT mean healthy/.test(wedgeLines[0] ?? ""));
  check("⭐ the heartbeat carries `wedged` so a reader of the RECORD sees it too",
    hb().wedged >= 1, `wedged=${hb().wedged}`);
  check("⭐⭐ the streak is DURABLE — it is counted on the mandate, a DIFFERENT store from the failing one",
    (maps.find((m) => m._n === "dca-mandates")?.get(`mandate:${OWNER}:wedge-1`)?.value?.consecutiveDeferrals ?? 0) === 3,
    `streak=${maps.find((m) => m._n === "dca-mandates")?.get(`mandate:${OWNER}:wedge-1`)?.value?.consecutiveDeferrals}`);
  check("🚨 …and it ALERTS off-Blobs — the wedge IS a Blobs failure, so the signal must not route through it",
    posts.length === 1 && /WEDGED/.test(JSON.parse(posts[0].i.body).content));

  // ── RECOVERY: the store comes back, and the wedge must CLEAR rather than latch. ─────────────
  throwFor.delete("data-budget");
  console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => errs.push(a.join(" "));
  await handler({});
  console.log = realLog; console.error = realErr;
  const streakAfter = maps.find((m) => m._n === "dca-mandates")?.get(`mandate:${OWNER}:wedge-1`)?.value?.consecutiveDeferrals;
  check("⭐⭐ once the store recovers the streak RESETS — an alarm that cannot clear is a new outage",
    streakAfter === 0, `streak=${streakAfter}`);
  check("⭐ …and the tick is back on the INFO channel", errs.filter((l) => l.startsWith("[dca-tick][WEDGED]")).length === 1);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
