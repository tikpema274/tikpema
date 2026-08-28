// verify-vanilla-seller-limits.mjs — THE ARMED SELLER MUST NOT TURN ONE HTTP REQUEST INTO ONE
// CIRCLE API CALL, FOR ANYONE, FOREVER.
//
//   node --experimental-test-module-mocks scripts/verify-vanilla-seller-limits.mjs
//   (also: npm run test:vanillalimits)
//
// ═══ 🚨 THE BLAST RADIUS THIS PROTECTS ══════════════════════════════════════════════════════════
// x402-vanilla-seller is PUBLIC and UNAUTHENTICATED. `_circle.mjs` is imported by 26 functions, all
// sharing ONE CIRCLE_API_KEY. So an attacker driving this endpoint is not spending the seller's gas
// — that was measured at zero (spike-vanilla-zero-balance-grief: Circle rejects at estimation, the
// seller's nonce never moves). They are spending the QUOTA that agent-send, dca-tick and the rest
// of the money path run on. The exposure is the product, not this seller.
//
// TWO GUARDS, AND THE ORDER IS LOAD-BEARING:
//   A. payerCanCover  — one eth_call; rejects the whole unfundable class before Circle is touched
//   B. claimSettleSlot — a global CAS ceiling per minute on what survives A
// A runs FIRST so unfundable traffic cannot exhaust the minute's budget. Asserted below, because
// swapping them would leave the ceiling trivially drainable by requests that can never pay.
import { mock } from "node:test";

let pass = 0, fail = 0;
const check = (l, c, x = "") => {
  let ok = false, note = x;
  try { ok = typeof c === "function" ? !!c() : !!c; }
  catch (e) { ok = false; note = `threw: ${String(e?.message ?? e).slice(0, 60)}`; }
  if (ok) { pass++; console.log(`  ✅ ${l}${note ? ` — ${note}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${note ? ` — ${note}` : ""}`); }
};
const section = async (t, fn) => { console.log(`\n${t}`); try { await fn(); }
  catch (e) { fail++; console.log(`  ❌ 🚨 SECTION CRASHED — ${String(e?.message ?? e).slice(0, 90)}`); } };

const SELLER = "0x1a63e59d1419cf48e2bd48cb54db85f27818dc99";
const PRICE = "10000";

// ── the Circle call is the thing being protected: count it, never make it ──
let circleCalls = 0;
// ⭐ `circleThrow`, when set, makes the settle call FAIL — the only way to reach the seller's catch
// block. Every suite in this repo mocked circle() to SUCCEED, so the settle failure path (the one
// that decides what a buyer is told about a rejected payment) had no behavioural coverage at all.
let circleThrow = null;
mock.module("../netlify/functions/_circle.mjs", { namedExports: {
  circle: () => ({ createContractExecutionTransaction: async () => { circleCalls++; if (circleThrow) throw circleThrow; return { data: { id: "tx" } }; } }),
  waitForTx: async () => "0x" + "ab".repeat(32),
  TxPendingError: class extends Error {},
}});

// ── a controllable chain + blobs, so every branch is reachable ──
let payerBalance = 0n, rpcThrows = false;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  if (body.method === "eth_call") {
    if (rpcThrows) throw new Error("RPC down");
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + payerBalance.toString(16).padStart(64, "0") }) };
  }
  return { ok: true, json: async () => ({ current: { temperature_2m: 1 }, current_units: {} }) };
};
let blobStore = new Map(), blobReadable = true;
mock.module("@netlify/blobs", { namedExports: {
  getStore: () => ({
    async getWithMetadata(k) {
      if (!blobReadable) throw new Error("store unreadable");
      const v = blobStore.get(k); return v ? { data: v, etag: "e" + v.n } : undefined;
    },
    async setJSON(k, v) { blobStore.set(k, v); return { modified: true }; },
  }),
  connectLambda: () => {},
}});
mock.module("../netlify/functions/_blobs.mjs", { namedExports: {
  connectBlobs: () => {}, strongReadAvailable: () => true, lastConnect: {}, UNCACHED_KEY: "x",
}});

// ⭐ The REAL error constructors, not imitations: the raw AxiosError v9 throws, and the SDK's own
// `fromAxiosError` that mints v10's typed error. The v10 copy is located wherever it lives — nested
// under adapter-circle-wallets today, top-level once the bump lands — and its ABSENCE IS A FAILURE,
// never a skip. [[absence-must-never-read-as-safe]]
const { AxiosError } = await import("axios");
let fromAxiosError = null;
{
  const { readdirSync, existsSync } = await import("node:fs");
  const root = "node_modules/@circle-fin";
  const cands = [];
  if (existsSync(root)) for (const p of readdirSync(root)) {
    cands.push(`../${root}/${p}/dist/developer-controlled-wallets.es.js`);
    const n = `${root}/${p}/node_modules/@circle-fin/developer-controlled-wallets`;
    if (existsSync(n)) cands.push(`../${n}/dist/developer-controlled-wallets.es.js`);
  }
  for (const rel of cands) {
    const url = new URL(rel, import.meta.url);
    if (!existsSync(url)) continue;
    try { const m = await import(url.href); if (typeof m.fromAxiosError === "function") { fromAxiosError = m.fromAxiosError; break; } } catch {}
  }
}

const { handler } = await import("../netlify/functions/x402-vanilla-seller.mjs");
process.env.VANILLA_SELLER_ADDRESS = SELLER;
process.env.VANILLA_SELLER_WALLET_ID = "wallet-id";
process.env.VANILLA_SELLER_SETTLES_PER_MIN = "2";

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const now = () => Math.floor(Date.now() / 1000);
let nonceSeq = 0;
const post = (from = "0x000000000000000000000000000000000000bEEF") => handler({
  httpMethod: "POST", headers: { host: "app.tikpema.xyz", "x-payment": b64({
    x402Version: 2, scheme: "exact", network: "eip155:5042002",
    payload: { authorization: { from, to: SELLER, value: PRICE, validAfter: "0",
      validBefore: String(now() + 600), nonce: "0x" + (++nonceSeq).toString(16).padStart(64, "0") },
      signature: "0x" + "cd".repeat(65) } }) }, body: "{}", blobs: "ctx" });
const reset = () => { circleCalls = 0; blobStore = new Map(); blobReadable = true; rpcThrows = false; circleThrow = null; };

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  ARMED SELLER — one request must not equal one Circle API call      ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
check("⭐ the v10 typed-error factory is present (needed by §7)", typeof fromAxiosError === "function",
  typeof fromAxiosError === "function" ? "" : "SEARCHED node_modules/@circle-fin AND FOUND NONE");
if (typeof fromAxiosError !== "function") { console.log("\n❌ cannot test the v10 shape without the SDK's own factory — refusing to report a pass."); process.exit(1); }

await section("── 1. A PAYER WHO CANNOT COVER NEVER REACHES CIRCLE ────────────────", async () => {
  reset(); payerBalance = 0n;
  const r = await post();
  check("refused with 402", r.statusCode === 402, `got ${r.statusCode}`);
  check("🚨 ZERO Circle calls — the quota was never touched", circleCalls === 0, `${circleCalls} calls`);
  check("…and it says why", /cannot cover/i.test(r.body));
  reset(); payerBalance = 9999n;                       // one atomic unit short
  await post();
  check("⭐ one atomic short is still refused (>=, not >)", circleCalls === 0);
});

await section("── 2. A FUNDED PAYER STILL SETTLES (the fix must not break selling) ", async () => {
  reset(); payerBalance = 10000n;                      // exactly the price
  const r = await post();
  check("⭐ exactly the price is enough", r.statusCode === 200, `got ${r.statusCode}`);
  check("…and Circle WAS called", circleCalls === 1, `${circleCalls} calls`);
});

await section("── 3. THE GLOBAL CEILING BOUNDS WHAT SURVIVES GUARD A ──────────────", async () => {
  reset(); payerBalance = 10_000_000n;
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post()).statusCode);
  check("⭐ first 2 settle, rest are 429 (cap=2)", JSON.stringify(codes) === JSON.stringify([200, 200, 429, 429]), codes.join(","));
  check("⭐⭐ Circle called EXACTLY twice, not four times", circleCalls === 2, `${circleCalls} calls`);
});

await section("── 4. FAIL-CLOSED: 'could not check' must never mean 'allowed' ─────", async () => {
  reset(); payerBalance = 10_000_000n; rpcThrows = true;
  await post();
  check("🚨 an unreadable RPC refuses rather than spending a Circle call", circleCalls === 0, `${circleCalls} calls`);
  reset(); payerBalance = 10_000_000n; blobReadable = false;
  const r = await post();
  check("🚨 an unreadable rate store refuses too", circleCalls === 0, `${circleCalls} calls`);
  check("…as 429, with a reason", r.statusCode === 429 && /unreadable/i.test(r.body), `${r.statusCode}`);
});

await section("── 5. ⭐ ORDER: A BEFORE B — unfundable traffic must not drain the cap", async () => {
  reset(); payerBalance = 0n;
  for (let i = 0; i < 5; i++) await post();            // five unfundable attempts
  payerBalance = 10_000_000n;
  const r = await post();
  // 🚨 If B ran first, those five would have consumed the minute's 2 slots and this would 429.
  check("⭐⭐ a real payer still settles after 5 unfundable attempts", r.statusCode === 200, `got ${r.statusCode}`);
  check("…and only the real one reached Circle", circleCalls === 1, `${circleCalls} calls`);
});

await section("── 6. 🚨 A MISCONFIGURED CEILING MUST STOP THE SELLER, NOT UNCAP IT ", async () => {
  const saved = process.env.VANILLA_SELLER_SETTLES_PER_MIN;
  for (const bad of ["abc", "0", "-1", "2.5", "Infinity"]) {
    reset(); payerBalance = 10_000_000n;
    process.env.VANILLA_SELLER_SETTLES_PER_MIN = bad;
    const r = await post();
    // 🚨 THE FAIL-OPEN THIS PINS: `n >= NaN` is FALSE, so a malformed cap silently permits
    // EVERYTHING while every other signal still looks healthy. [[nan-fail-open-cap-pattern]]
    check(`${JSON.stringify(bad)} refuses instead of uncapping`, r.statusCode !== 200 && circleCalls === 0,
      `HTTP ${r.statusCode}, ${circleCalls} Circle calls`);
  }
  // ⚠️ BOTH DIRECTIONS: an UNSET variable must still sell, on the documented default.
  reset(); payerBalance = 10_000_000n;
  delete process.env.VANILLA_SELLER_SETTLES_PER_MIN;
  check("⭐ unset falls back to the default and still sells", (await post()).statusCode === 200);
  process.env.VANILLA_SELLER_SETTLES_PER_MIN = saved;
});

// ═══ 7. ⭐⭐ THE SETTLE FAILURE PATH — BOTH SDK ERROR SHAPES ═══════════════════════════════════
// 🚨 THE GAP THIS CLOSES. Sections 1–6 all mock circle() to SUCCEED, so the seller's catch block
// — which decides what a buyer is told when their payment is REJECTED — was never executed by any
// suite. It is also unreachable from a draft deploy (VANILLA_SELLER_* are production-scoped, so
// the handler 500s at its env guard 150 lines earlier) and from every read-only prod probe (they
// all return before settle). This is the only place it can be exercised before the SDK bump.
//
// ⭐ WHY BOTH SHAPES. developer-controlled-wallets v9 throws a raw AxiosError with the reason at
// `e.response.data`; v10 wraps 43 methods and throws a typed HttpResponseError that has NO
// `.response` at all. The seller reads that reason to tell the buyer why settlement failed, so the
// two majors must produce the SAME answer. The v10 error is built by the SDK's own
// `fromAxiosError`, from the real 10.7.1 on disk — not a hand-rolled imitation.
await section("── 7. ⭐⭐ A REJECTED SETTLEMENT READS THE SAME ON v9 AND v10 ───────", async () => {
  const data = { code: 155201, message: "FiatTokenV2: authorization is used or canceled" };
  const mkAxios = () => new AxiosError(
    "Request failed with status code 400", "ERR_BAD_REQUEST",
    { url: "/v1/w3s/developer/transactions/contractExecution", method: "post" }, {},
    { status: 400, statusText: "", headers: {}, config: {}, data });

  reset(); payerBalance = 10_000_000n; circleThrow = mkAxios();
  const v9 = await post();
  reset(); payerBalance = 10_000_000n; circleThrow = fromAxiosError(mkAxios());
  const v10 = await post();

  check("v9  raw AxiosError    → the seller answers 402", v9.statusCode === 402, `got ${v9.statusCode}`);
  check("v10 typed HttpError   → the seller answers 402", v10.statusCode === 402, `got ${v10.statusCode}`);
  // ⭐⭐ THE ASSERTION THE SHIM EXISTS FOR. Before it, v9 surfaced the structured body and v10
  // surfaced only a bare message — the buyer silently lost Circle's error code on the newer major.
  check("⭐⭐ both shapes produce a BYTE-IDENTICAL response body",
    v9.body === v10.body, v9.body === v10.body ? "" : `\n     v9:  ${String(v9.body).slice(0, 200)}\n     v10: ${String(v10.body).slice(0, 200)}`);
  for (const [label, r] of [["v9", v9], ["v10", v10]]) {
    const b = JSON.parse(r.body);
    check(`${label} keeps Circle's numeric code (155201) for the buyer`, /155201/.test(b.reason ?? ""), String(b.reason).slice(0, 120));
    check(`${label} keeps the revert reason text`, /authorization is used or canceled/.test(b.reason ?? ""));
    // ⚠️ The headline must not claim the chain saw something we did not observe.
    check(`${label} does not assert an on-chain revert it never witnessed`,
      !/reverted on-chain/.test(b.error ?? "") || /could not determine/.test(b.error ?? ""), String(b.error));
    check(`${label} still re-issues the challenge so the buyer can retry correctly`, Array.isArray(b.accepts) && b.accepts.length === 1);
  }

  // A transport failure has no status and no body — the seller must still answer, and must not
  // invent a reason it was never given.
  reset(); payerBalance = 10_000_000n;
  circleThrow = new AxiosError("connect ECONNREFUSED", "ECONNREFUSED", { url: "/x", method: "post" }, {}, undefined);
  const t9 = await post();
  reset(); payerBalance = 10_000_000n;
  circleThrow = fromAxiosError(new AxiosError("connect ECONNREFUSED", "ECONNREFUSED", { url: "/x", method: "post" }, {}, undefined));
  const t10 = await post();
  check("⭐ a transport failure answers 402 on both shapes", t9.statusCode === 402 && t10.statusCode === 402, `${t9.statusCode}/${t10.statusCode}`);
  check("⭐ …identically", t9.body === t10.body);
  check("⭐ …and names the transport cause rather than inventing one", /ECONNREFUSED/.test(JSON.parse(t9.body).reason ?? ""), String(JSON.parse(t9.body).reason).slice(0, 100));
});


console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ Unfundable traffic costs nothing; funded traffic is bounded; unknown refuses.\n");
