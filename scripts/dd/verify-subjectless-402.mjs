// verify-subjectless-402.mjs — a probe that names NOTHING gets the terms, and can never be charged.
//
// ═══ ⭐⭐ WHY THIS SUITE EXISTS, AND WHAT IT REFUSES TO PROVE BY READING ════════════════════════
// Before this change, a subjectless request was fenced off from settlement STRUCTURALLY: the
// ADDRESS and CHAIN rungs refused with 400 before PAYTO or the payment rung ever ran. Measured
// against prod on 2026-08-26, five cases, all 400, rung 6 never reached.
//
// 🚨 OPENING THE ADDRESS RUNG REMOVES THAT FENCE. The 402-for-probes fix makes a subjectless request
// climb PAST the rungs that used to stop it. So the fence has to be re-stated explicitly — and
// asserted by INJECTION, on CALL COUNTS, not by tracing the code and concluding it looks fine.
// PROGRESS recorded the old claim honestly as "separable on reading; NOT proven by fault injection".
// This is where that debt is paid.
//
// ═══ 🚨 THE DANGEROUS CASE IS SUBJECTLESS-WITH-PAYMENT, NOT THE EMPTY PROBE ═══════════════════
// A 402 for a caller who ALREADY SENT PAYMENT would rebuild the exact infinite-retry loop closed in
// `acedafa`, one rung over: pay → challenged → pay → challenged, forever. It must be a TERMINAL 400.
//
//   node --experimental-test-module-mocks scripts/dd/verify-subjectless-402.mjs
//
// Zero network, zero Circle: the facilitator and the RPC transport are both replaced by counters.

import { mock } from "node:test";
import { SCHEMA_VERSION as _SV } from "../../shared/onchain-analyze/schema.mjs";
import { POWER_SIGS as _PS } from "../../shared/onchain-facts/index.mjs";

process.env.DD_BUILD_ID = process.env.DD_BUILD_ID || "test-build-0000000000000000000000000000000000000000";
process.env.DD_PUBLIC_ENABLED = "1";
// A resolvable DD_PAYTO_ADDRESS, or the PAYTO rung refuses 503 before any of this is reachable.
// ⚠️ It is DD_PAYTO_ADDRESS specifically — deliberately never defaulted to SELLER_ADDRESS.
process.env.DD_PAYTO_ADDRESS = process.env.DD_PAYTO_ADDRESS || "0xb407967319d56218c7e1c369125490e665a16ac4";

// ⚠️ Injected, never read from disk — the committed stamp is deliberately `null`, so an on-disk read
// makes this suite's result depend on whether `npm run build` happened to run last.
mock.module("../../shared/build-stamp.mjs", {
  namedExports: {
    ddCodeIdentity: () => ({ resolved: true, id: "e".repeat(64), source: "test-injected",
      detail: "deterministic identity injected by the suite" }),
    buildStamp: () => ({ resolved: true, commit: "a".repeat(40), dirty: false, tree: "b".repeat(64),
      fileCount: 1, generatedAt: "2026-01-01T00:00:00.000Z", detail: "test-injected" }),
    provenanceIsBound: () => true,
  },
});
const { codeIdentity: _ci } = await import("../../shared/dd-canary/health.mjs");
const _identity = _ci({ schemaVersion: _SV, powerSigs: _PS });
mock.module("../../netlify/functions/_dd-health.mjs", {
  namedExports: {
    readHealth: async () => ({
      record: { verdict: "pass", producedAt: new Date().toISOString(), identity: _identity, fixtures: [] },
      readable: true,
    }),
    writeHealth: async () => true,
    DD_HEALTH_STORE: "mock",
    healthKey: () => "mock",
  },
});

// ═══ 🚨 THE COUNTERS — the whole point of the suite ═══════════════════════════════════════════
const calls = { verify: 0, settle: 0, rpc: 0 };
mock.module("@circle-fin/x402-batching/server", {
  namedExports: {
    BatchFacilitatorClient: class {
      async verify() { calls.verify++; return { isValid: true }; }
      async settle() { calls.settle++; return { success: true, transaction: "0x" + "1".repeat(64) }; }
    },
  },
});
// ⚠️ These mocks are DELIBERATELY PERMISSIVE — verify returns valid and settle returns success. A
// facilitator that refused would make "settle was never called" true for the wrong reason, and the
// suite would pass even if the fence were gone.

// ⭐ THE BLOBS STORE — mocked ONLY so the 1b liveness contrast can reach the facilitator. The
// subjectless paths never touch it; without this, a subject-ful paid call 500s on a missing store
// BEFORE facilitator.verify, and the "verify was never called" zeros above would be unfalsifiable.
mock.module("@netlify/blobs", {
  namedExports: {
    connectLambda: () => {},
    getStore: () => {
      const m = new Map();
      return {
        get: async (k, o) => (o?.type === "json" ? (m.get(k) ?? null) : (m.get(k) ?? null)),
        getWithMetadata: async (k) => (m.has(k) ? { data: m.get(k) } : null),
        setJSON: async (k, v) => { m.set(k, v); },
        set: async (k, v) => { m.set(k, v); },
        list: async () => ({ blobs: [] }),
        delete: async (k) => { m.delete(k); },
      };
    },
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("rpc.testnet.arc.network")) {
    calls.rpc++;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), {
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(url, init);
};

const { handler } = await import("../../netlify/functions/dd-analyze.mjs");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 64 - t.length))}`);

const PAY = Buffer.from(JSON.stringify({ x402Version: 2, payload: {} }), "utf8").toString("base64");
const VALID = "0x240Eb85458CD41361bd8C3773253a1D78054f747";

async function call(body, headers = {}) {
  calls.verify = 0; calls.settle = 0; calls.rpc = 0;
  const res = await handler({
    httpMethod: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { /* asserted by caller */ }
  return { status: res.statusCode, body: parsed, headers: res.headers ?? {}, counts: { ...calls } };
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log("║  SUBJECTLESS 402 — a probe learns the price; a probe can never be charged");
console.log("╚══════════════════════════════════════════════════════════════════════");

// ═══════════════════════════════════════════════════════════════════════════════════════════
section("1 🚨🚨 SUBJECTLESS + PAYMENT — TERMINAL 400, AND settle IS NEVER CALLED");
// The dangerous case. Asserted on call counts, with a facilitator that WOULD have succeeded.
for (const [label, body] of [
  ["{}", {}],
  ["no body at all", null],
  ['{"chain":"arc-testnet"}', { chain: "arc-testnet" }],
]) {
  const r = await call(body, { "payment-signature": PAY });
  check(`${label} + payment → 400`, r.status === 400, `got ${r.status}`);
  check(`${label} + payment → 🚨 NOT 402 (a 402 here rebuilds the pay→challenge→pay loop)`, r.status !== 402);
  check(`${label} + payment → 🚨🚨 facilitator.verify NEVER called`, r.counts.verify === 0, `count=${r.counts.verify}`);
  check(`${label} + payment → 🚨🚨 facilitator.settle NEVER called`, r.counts.settle === 0, `count=${r.counts.settle}`);
  check(`${label} + payment → says the authorization was NOT spent`,
    /was not spent/i.test(JSON.stringify(r.body ?? {})));
}

// ⭐ THE COUNTER MUST BE ABLE TO MOVE, or every zero above is vacuous.
section("1b ⭐ THE COUNTERS ARE NOT DEAD — a real paid call DOES reach the facilitator");
{
  const r = await call({ address: VALID, chain: "arc-testnet" }, { "payment-signature": PAY });
  check("a SUBJECT-FUL paid call reaches facilitator.verify — so verify=0 above means something",
    r.counts.verify > 0, `verify=${r.counts.verify} settle=${r.counts.settle} status=${r.status}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
section("2 ⭐ THE FIX — a subjectless probe gets the 402 challenge");
for (const [label, body] of [
  ["{}", {}],
  ["no body at all", null],
  ['{"chain":"arc-testnet"}', { chain: "arc-testnet" }],
]) {
  const r = await call(body);
  check(`${label} → 402 (was 400: the discovery defect)`, r.status === 402, `got ${r.status}`);
  const hdr = r.headers["PAYMENT-REQUIRED"] ?? r.headers["payment-required"];
  check(`${label} → carries the PAYMENT-REQUIRED header`, Boolean(hdr));
  check(`${label} → body carries accepts[]`, Array.isArray(r.body?.accepts) && r.body.accepts.length > 0);
  check(`${label} → body carries x402Version 2`, r.body?.x402Version === 2, String(r.body?.x402Version));
  check(`${label} → NO subjectPreview (nothing was named, so nothing is previewed)`,
    !Object.prototype.hasOwnProperty.call(r.body ?? {}, "subjectPreview"));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
section("3 ⭐ ZERO RPC — asserted on CALL COUNT, never on latency");
{
  const probe = await call({});
  check("the subjectless 402 makes ZERO rpc calls", probe.counts.rpc === 0, `count=${probe.counts.rpc}`);
  // ⭐ AND THE CONTRAST, so the zero is not indistinguishable from a broken counter.
  const subjectful = await call({ address: VALID, chain: "arc-testnet" });
  check("…while the SUBJECT-FUL 402 spends one eth_getCode on the preview",
    subjectful.counts.rpc > 0, `count=${subjectful.counts.rpc}`);
  check("🚨 so the subjectless challenge is CHEAPER than the one already served, not costlier",
    probe.counts.rpc < subjectful.counts.rpc, `${probe.counts.rpc} < ${subjectful.counts.rpc}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
section("4 🚨 THE INCENTIVE ARGUMENT — everything answerable FREE stays 400");
// We never quote a price for something we already know the answer to, and narrowing the supported
// chain set still gains nothing. Nothing was traded away to make discovery work.
for (const [label, body, reason] of [
  ['{"address":"garbage"} — named badly, NOT a probe', { address: "garbage" }, "invalid-address"],
  ["address valid, chain omitted", { address: VALID }, "chain-not-specified"],
  ["address valid, chain unsupported", { address: VALID, chain: "ethereum" }, "unsupported-chain"],
  ["body is not JSON", "not json at all", "malformed-request"],
  ["body is not an object", "[1,2,3]", "malformed-request"],
]) {
  const r = await call(body);
  check(`${label} → 400`, r.status === 400, `got ${r.status}`);
  check(`${label} → 🚨 NOT 402 (quoting here would invoice for a free diagnosis)`, r.status !== 402);
  check(`${label} → reason ${reason}`, r.body?.refusal?.reason === reason, r.body?.refusal?.reason);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
if (fail) { console.log(`║  ❌ FAILURES   pass ${pass} / fail ${fail}`); console.log("╚══════════════════════════════════════════════════════════════════════\n"); process.exit(1); }
console.log(`║  ✅ ALL GREEN   pass ${pass} / fail 0`);
console.log("╚══════════════════════════════════════════════════════════════════════\n");
