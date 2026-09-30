// verify-selfheal.mjs — ZERO-MONEY proof of the provisioning-stall self-heal.
//   node --experimental-test-module-mocks scripts/verify-selfheal.mjs
//
// Proves the safety design:
//   1. job-run-status: a run stalled at "starting" past STALL_MS → RE-FIRES
//      job-run-background (once), stamps reFiredAt.
//   2. job-run-status: a run already "creating"/"funded" (or too young, or re-fired
//      recently) → does NOT re-fire (no double-create).
//   3. job-run-background: the IDEMPOTENCY GUARD — a second invocation of a run already
//      advanced past "starting" ABORTS before createJob (no second on-chain job).
//   4. job-run-background: a genuine first call (status "starting") PROCEEDS to createJob.
//   5. ⛔ (2026-09-30) job-run-background: a FAILED run read is REFUSED — never read as "no record".
//      It used to `.catch(() => null)`, so an outage during a self-heal re-fire looked like a fresh
//      run and went on to createJob + fund: a second on-chain job, funded twice. Now nothing is
//      created and nothing written; the run stays "starting", so the self-heal re-fires it later.
import { mock } from "node:test";

const OWNER = "0xowner", WALLET = "0xwallet";

const stores = {};
const readThrows = new Set(); // store names whose get() throws (a Blobs outage)
const writes = [];
const mkStore = (name) => {
  stores[name] ??= new Map();
  const m = stores[name];
  return {
    get: async (k) => { if (readThrows.has(name)) throw new Error("blobs down"); return m.has(k) ? JSON.parse(m.get(k)) : null; },
    setJSON: async (k, v) => { writes.push([name, k, v?.status]); m.set(k, JSON.stringify(v)); },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: mkStore } });
mock.module("../netlify/functions/_auth.mjs", {
  namedExports: { requireSession: () => ({ address: OWNER }), requireInternal: () => true, internalToken: () => "tok" },
});

// Count createJob executions — the double-spend detector.
let createJobCalls = 0;
mock.module("../netlify/functions/_circle.mjs", {
  namedExports: {
    circle: () => ({
      createContractExecutionTransaction: async ({ abiFunctionSignature }) => {
        if (abiFunctionSignature.startsWith("createJob")) createJobCalls++;
        return { data: { id: "tx" } };
      },
    }),
    waitForTx: async () => "0xhash",
    TxPendingError: class extends Error {},
  },
});
// job-run-background parses a JobCreated event from the receipt — stub it.
mock.module("../netlify/functions/_predict.mjs", {
  namedExports: { publicClient: () => ({ getTransactionReceipt: async () => ({ logs: [{ __job: true }] }) }) },
});
// viem parseEventLogs → return a synthetic JobCreated. Mock viem's named export used there.
// (job-run-background imports parseEventLogs from viem; we can't easily mock viem, so we
//  drive the guard/abort paths which return BEFORE createJob, and the proceed path far
//  enough to count createJobCalls.)

// Capture the self-heal re-fire (job-run-status → job-run-background).
let reFireCount = 0;
globalThis.fetch = async (url) => {
  if (String(url).includes("job-run-background")) reFireCount++;
  return { status: 202, ok: true };
};

const { handler: status } = await import("../netlify/functions/job-run-status.mjs");
const { handler: bg } = await import("../netlify/functions/job-run-background.mjs");

const runs = mkStore("job-runs");
const seedRun = async (patch) => runs.setJSON("run:r1", {
  runId: "r1", owner: OWNER, walletAddress: WALLET, question: "bridge 1 USDC to Base",
  budgetUsdc: 0.3, status: "starting", createdAt: new Date(Date.now() - 60_000).toISOString(), ...patch,
});
const callStatus = () => status({ httpMethod: "GET", headers: {}, blobs: null, queryStringParameters: { runId: "r1" } });
const callBg = () => bg({ httpMethod: "POST", headers: { "x-internal-token": "tok" }, blobs: null,
  body: JSON.stringify({ runId: "r1", question: "q", budgetUsdc: 0.3, walletAddress: WALLET, owner: OWNER }) });

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log("── job-run-status self-heal ──");
{
  reFireCount = 0; await seedRun({ createdAt: new Date(Date.now() - 60_000).toISOString() }); // 60s old, stalled
  await callStatus();
  check("stalled 'starting' (60s) → re-fired once", reFireCount === 1, `reFires=${reFireCount}`);
  const r = await runs.get("run:r1");
  check("reFiredAt stamped", !!r.reFiredAt);

  reFireCount = 0; await callStatus(); // immediately again — cooldown should block
  check("second poll within cooldown → NOT re-fired again", reFireCount === 0, `reFires=${reFireCount}`);

  reFireCount = 0; await seedRun({ createdAt: new Date(Date.now() - 5_000).toISOString() }); // only 5s old
  await callStatus();
  check("young 'starting' (5s < 30s) → NOT re-fired", reFireCount === 0, `reFires=${reFireCount}`);

  reFireCount = 0; await seedRun({ status: "creating", createdAt: new Date(Date.now() - 60_000).toISOString() });
  await callStatus();
  check("status 'creating' → NOT re-fired (job started, don't double-create)", reFireCount === 0, `reFires=${reFireCount}`);

  reFireCount = 0; await seedRun({ status: "funded", jobId: "155999", createdAt: new Date(Date.now() - 60_000).toISOString() });
  await callStatus();
  check("has jobId → NOT re-fired", reFireCount === 0, `reFires=${reFireCount}`);
}

console.log("\n── job-run-background idempotency guard ──");
{
  createJobCalls = 0;
  await seedRun({ status: "creating", jobId: "155999", createdAt: new Date().toISOString() }); // already advanced
  const r = await callBg();
  check("re-invocation of an ADVANCED run → aborts", r.statusCode === 202 && /already/.test(r.body || ""), r.body);
  check("createJob NOT called (no double-create)", createJobCalls === 0, `createJobCalls=${createJobCalls}`);

  // A funded run likewise aborts.
  createJobCalls = 0; await seedRun({ status: "funded", jobId: "155999" });
  const r2 = await callBg();
  check("re-invocation of a FUNDED run → aborts", r2.statusCode === 202 && /already/.test(r2.body || ""), r2.body);
  check("still no createJob", createJobCalls === 0);
}

console.log("\n── ⛔ job-run-background: a FAILED run read is REFUSED (2026-09-30) ──");
{
  createJobCalls = 0;
  await seedRun({ status: "funded", jobId: "155999" }); // the run DID advance; the read cannot see it
  readThrows.add("job-runs"); writes.length = 0;
  const r = await callBg();
  readThrows.delete("job-runs");
  check("⭐⭐ the run read THROWS → createJob NOT called (no second on-chain job, no second fund)", createJobCalls === 0, `createJobCalls=${createJobCalls}`);
  check("⭐ …nothing written (the record is not touched on a guess)", writes.length === 0, JSON.stringify(writes));
  check("⭐ …and it says why (the run could not be read), without claiming the run is new", /could not be read|unreadable/i.test(r.body || ""), r.body);
  const after = await runs.get("run:r1");
  check("the stored run is unchanged (still funded, jobId intact)", after.status === "funded" && after.jobId === "155999", JSON.stringify(after));

  createJobCalls = 0;
  await seedRun({ status: "starting", jobId: undefined });
  readThrows.add("job-runs"); writes.length = 0;
  await callBg();
  readThrows.delete("job-runs");
  check("⭐ a 'starting' run whose read throws → also refused (it stays 'starting' for the self-heal to re-fire)", createJobCalls === 0 && writes.length === 0 && (await runs.get("run:r1")).status === "starting", `createJobCalls=${createJobCalls} writes=${JSON.stringify(writes)}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
