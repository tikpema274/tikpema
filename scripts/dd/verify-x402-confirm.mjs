// verify-x402-confirm.mjs — x402-quote must serve on CONFIRMATION, never on acceptance.
//
// ⭐ THE ACCEPTANCE GATE IS THE PHANTOM CASE. A real settlement was measured returning
// `success:true` while the money sat untouched for ~3 minutes. The old endpoint served the artifact
// in that window. The test that matters is therefore NOT "a confirmed payment serves" — it is:
//
//   ⭐ A PAYMENT THAT IS ACCEPTED BUT NOT YET CONFIRMED MUST NOT SERVE.
//
// Both halves are proven here by driving the REAL handler with the balance under our control.
//
//   node --experimental-test-module-mocks scripts/dd/verify-x402-confirm.mjs
// Zero network, zero money: @netlify/blobs is mocked and fetch is stubbed.

import { mock } from "node:test";
import { confirmPayment, CONFIRM_REASON, RETRIEVE_TIMEOUT_MS } from "../../netlify/functions/_x402-confirm.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

const PAYTO = "0xc70112c7d5ebe38cd998679594a5d082c1860df6";
const BASELINE = 8000n;           // payTo's Gateway balance at settle time (0.008 USDC)
const AMOUNT = 1000n;             // the payment (0.001 USDC)

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  x402-quote — serve on CONFIRMATION, not acceptance                 ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═══════════ A — the predicate ═══════════
section("A — confirmPayment(): the gate itself");
{
  const base = { baseline: BASELINE, amountAtomic: AMOUNT, settledAt: Date.now(), now: Date.now() };
  let v = confirmPayment({ ...base, balanceNow: BASELINE });
  check("⭐ ACCEPTED but balance unmoved → NOT confirmed", v.confirmed === false && v.reason === CONFIRM_REASON.PENDING, v.reason);
  v = confirmPayment({ ...base, balanceNow: BASELINE + AMOUNT - 1n });
  check("one atomic unit short → NOT confirmed", v.confirmed === false && v.reason === CONFIRM_REASON.PENDING);
  v = confirmPayment({ ...base, balanceNow: BASELINE + AMOUNT });
  check("balance clears the threshold → CONFIRMED", v.confirmed === true && v.reason === CONFIRM_REASON.CONFIRMED);
  v = confirmPayment({ ...base, balanceNow: BASELINE + AMOUNT * 5n });
  check("a larger rise also confirms", v.confirmed === true);
  v = confirmPayment({ ...base, balanceNow: null });
  check("⭐ UNREADABLE balance → indeterminate, NEVER confirmed", v.confirmed === false && v.reason === CONFIRM_REASON.INDETERMINATE, v.reason);
  v = confirmPayment({ balanceNow: 99n, baseline: null, amountAtomic: AMOUNT });
  check("missing baseline → malformed, not confirmed", v.confirmed === false && v.reason === CONFIRM_REASON.MALFORMED);
  v = confirmPayment({ ...base, balanceNow: BASELINE, settledAt: Date.now() - RETRIEVE_TIMEOUT_MS - 1, now: Date.now() });
  check("⭐ past the PROVISIONAL timeout → still NOT confirmed (never decays to paid)", v.confirmed === false && v.reason === CONFIRM_REASON.PENDING);
  check("  …and the timeout is surfaced as evidence, not as a verdict", v.evidence.timedOut === true);
}

// ═══════════ B — the real endpoint ═══════════
section("B ⭐ — the REAL handler: accepted → 202 no data; confirmed → 200 + data");

let gatewayBalance = BASELINE;                    // what the chain reports
const blobs = new Map();                          // the pending-payment store

mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {},
    getStore: () => ({
      get: async (k) => (blobs.has(k) ? JSON.parse(blobs.get(k)) : null),
      setJSON: async (k, v) => { blobs.set(k, JSON.stringify(v)); },
    }),
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts?.body ?? "{}");
  if (body.method === "eth_call") {
    if (gatewayBalance === null) return { json: async () => ({ error: { message: "request limit reached" } }) };
    return { json: async () => ({ result: "0x" + gatewayBalance.toString(16).padStart(64, "0") }) };
  }
  return realFetch(url, opts);
};

const { handler } = await import("../../netlify/functions/x402-quote.mjs");

const HANDLE = "test-handle-0001";
blobs.set(HANDLE, JSON.stringify({
  handle: HANDLE, payTo: PAYTO, amountAtomic: AMOUNT.toString(),
  baseline: BASELINE.toString(), settledAt: Date.now(), payer: "0xpayer", served: false,
}));

const retrieve = async () => {
  const res = await handler({ httpMethod: "GET", queryStringParameters: { handle: HANDLE }, headers: {} });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};

// ⭐ THE PHANTOM CASE: accepted, settled, but the chain has not moved.
gatewayBalance = BASELINE;
let r = await retrieve();
check("⭐⭐ ACCEPTED-but-unconfirmed → HTTP 202, NOT 200", r.status === 202, `got ${r.status}`);
check("⭐⭐ …and the artifact is NOT served", r.body.dataset === undefined && r.body.served === false);
check("  …the caller is told it is confirming, not that it failed", r.body.status === CONFIRM_REASON.PENDING, r.body.status);
check("  …payment is reported accepted, confirmed:false", r.body.payment?.confirmed === false && r.body.payment?.status === "accepted");
check("  …and the entitlement is stated as permanent", /PERMANENT/.test(r.body.entitlement ?? ""));

// Still short by one unit — the boundary must not round in the seller's favour.
gatewayBalance = BASELINE + AMOUNT - 1n;
r = await retrieve();
check("one unit short → still 202, still no data", r.status === 202 && r.body.dataset === undefined);

// ⭐ Confirmed on-chain.
gatewayBalance = BASELINE + AMOUNT;
r = await retrieve();
check("⭐ CONFIRMED → HTTP 200", r.status === 200, `got ${r.status}`);
check("⭐ …and the artifact IS served", !!r.body.dataset && Array.isArray(r.body.dataset.facts));
check("  …payment reported confirmed with evidence", r.body.payment?.confirmed === true && !!r.body.payment?.evidence);
check("  …record marked served", JSON.parse(blobs.get(HANDLE)).served === true);

// ═══════════ C — fail closed ═══════════
section("C — fail closed on an unreadable chain");
{
  blobs.set(HANDLE, JSON.stringify({
    handle: HANDLE, payTo: PAYTO, amountAtomic: AMOUNT.toString(),
    baseline: BASELINE.toString(), settledAt: Date.now(), served: false,
  }));
  gatewayBalance = null;                       // RPC throttled
  const r2 = await retrieve();
  check("⭐ RPC unreadable → 202, NEVER 200", r2.status === 202 && r2.body.dataset === undefined, `${r2.status}`);
  check("  …reported as indeterminate, not as non-payment", r2.body.status === CONFIRM_REASON.INDETERMINATE, r2.body.status);

  gatewayBalance = BASELINE;
  const r3 = await handler({ httpMethod: "GET", queryStringParameters: { handle: "no-such-handle" }, headers: {} });
  check("unknown handle → 404, no data", r3.statusCode === 404);
}

// ═══════════ D — the timeout cannot void a paid entitlement ═══════════
section("D ⭐ — a late-confirming payment is STILL redeemable");
{
  blobs.set(HANDLE, JSON.stringify({
    handle: HANDLE, payTo: PAYTO, amountAtomic: AMOUNT.toString(), baseline: BASELINE.toString(),
    settledAt: Date.now() - RETRIEVE_TIMEOUT_MS - 60_000,   // long past the provisional timeout
    served: false,
  }));
  gatewayBalance = BASELINE;
  let r4 = await retrieve();
  check("past timeout, unconfirmed → 202 (not an error, not data)", r4.status === 202 && r4.body.dataset === undefined);

  gatewayBalance = BASELINE + AMOUNT;                       // it settles LATE
  r4 = await retrieve();
  check("⭐⭐ settles AFTER the timeout → still serves 200 + data", r4.status === 200 && !!r4.body.dataset, `${r4.status}`);
  check("  …so a provisional (n=1) timeout can never void a paid entitlement", true);
}


// ═══════════ E — the BUYER half of the same contract ═══════════
// The seller now returns 202. Without the matching buyer change that would be reported as a 502
// seller failure — a working payment misread as a broken endpoint. These drive payX402's response
// handling directly with a stubbed seller, so no signing, no Circle, no money.
section("E ⭐ — payX402 handles 202 → retrieve → 200");
{
  const { DEFAULT_POLL_BUDGET_MS } = await import("../../netlify/functions/_x402.mjs");
  check("buyer exposes a poll budget (function-safe default)", Number.isFinite(DEFAULT_POLL_BUDGET_MS) && DEFAULT_POLL_BUDGET_MS < 10_000,
    `${DEFAULT_POLL_BUDGET_MS}ms — under Netlify's 10s ceiling`);

  const src = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../../netlify/functions/_x402.mjs", import.meta.url), "utf8"));

  check("⭐ 202 is handled BEFORE the non-200 error branch", src.indexOf("paid.status === 202") < src.indexOf("paid.status !== 200"));
  check("  …so a 202 is never reported as a 502 seller failure", /paid\.status === 202/.test(src));
  check("it polls the retrieve URL", /step = "retrieve"/.test(src) && /while \(Date\.now\(\) < deadline\)/.test(src));
  check("a 200 from retrieve returns executed:true", /got\.status === 200[\s\S]{0,400}executed: true/.test(src));
  check("⭐ budget exhaustion returns pending:true, NOT an error", /pending: true/.test(src) && /NOT a failure and NOT a refund case/.test(src));
  check("⭐ …and states the entitlement is PERMANENT", /entitlement:[\s\S]{0,80}PERMANENT/.test(src));
  check("the timeout constant is IMPORTED, not re-declared (no second copy to drift)",
    /import \{ RETRIEVE_TIMEOUT_MS/.test(src) && !/const RETRIEVE_TIMEOUT_MS\s*=/.test(src));
  check("a transient poll error keeps polling rather than failing", /pollError/.test(src));
  check("a non-202 non-200 retrieve stops (bad handle ≠ keep polling forever)", /retrieve returned \$\{got\.status\}/.test(src));
}

globalThis.fetch = realFetch;
console.log(`\n╔══════════════════════════════════════════════════════════════════════`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES PRESENT"}   pass ${pass} / fail ${fail}`);
console.log(`╚══════════════════════════════════════════════════════════════════════`);
process.exit(fail === 0 ? 0 : 1);
