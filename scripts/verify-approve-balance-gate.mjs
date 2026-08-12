// verify-approve-balance-gate.mjs — ZERO-MONEY proof of the pre-flight balance gate.
//   node --experimental-test-module-mocks scripts/verify-approve-balance-gate.mjs
//
// job #155341 approved a 10 USDC bridge against a 6.30 wallet → burn reverted on-chain
// (INSUFFICIENT_TOKEN) → raw 500 + standing allowance. This gate reads the balance BEFORE
// the burn and rejects cleanly. Proves:
//   1. balance < amount → 402 need/have/walletAddress, and executeAction is NEVER called
//      (no burn submitted — the whole point).
//   2. balance >= amount → proceeds to execution as before (funded path unchanged).
//   3. balance == amount → proceeds (>= is inclusive; sponsored gas means amount suffices).
//   + ordering: on reject, NO lock is written and NO burn is submitted.
import { mock } from "node:test";

const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const BURN = "0x" + "b1".repeat(32);

const stores = {};
const mkStore = (name) => {
  stores[name] ??= new Map();
  const m = stores[name];
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: mkStore } });
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireSession: () => ({ address: OWNER, method: "metamask" }), internalToken: () => "t", requireInternal: () => true } });
mock.module("../netlify/functions/_agent-wallets.mjs", { namedExports: { WALLET_PROVISIONING_STATUS: 503, walletProvisioningRefusal: () => ({ error: "provisioning", reason: "wallet-provisioning", retryable: true, whatHappened: "nothing" }), ensureOwnerWallet: async () => ({ walletAddress: OWNER, pending: false }) } });

// ── the balance the pre-flight read returns (6-dp minor units) ──
let balanceMinor = 0n;
mock.module("../netlify/functions/_predict.mjs", {
  namedExports: { publicClient: () => ({ readContract: async () => balanceMinor }) },
});

// executeAction: instrumented so we can PROVE it is not called on the reject path.
let execCalls = 0;
mock.module("../netlify/functions/_actions.mjs", {
  namedExports: {
    executeAction: async (step) => {
      execCalls++;
      return { ok: true, kind: "bridge_usdc", state: "submitted", burnHash: BURN, tx: `x/${BURN}`, destination: step.destination, feeUsdc: 0.2, netUsdc: step.amountUsdc - 0.2, recipient: OWNER };
    },
  },
});
globalThis.fetch = async () => ({ status: 202, ok: true }); // verifier trigger, swallowed

const { handler } = await import("../netlify/functions/job-bridge-approve.mjs");

const runs = mkStore("job-runs"), deliv = mkStore("job-deliverables");
const seed = async (amount) => {
  stores["job-runs"].clear(); stores["job-deliverables"].clear();
  await runs.setJSON("run:r1", { runId: "r1", owner: OWNER, jobId: "job-1", walletAddress: OWNER });
  await deliv.setJSON("job-1", {
    status: "completed", canonicalReport: "{}", deliverableHash: "0xh", brief: {},
    proposal: { action: "bridge_usdc", destination: "base", amountUsdc: amount, reasoning: "r" },
  });
};
const call = () => handler({ httpMethod: "POST", headers: {}, blobs: null, body: JSON.stringify({ runId: "r1" }) });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });
const usdc = (n) => BigInt(Math.round(n * 1e6));

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log("CASE 1: balance 6.30 < amount 10 → clean 402, NO burn (the #155341 scenario)");
{
  await seed(10); balanceMinor = usdc(6.30); execCalls = 0;
  const { status, body } = parse(await call());
  check("HTTP 402", status === 402, `got ${status}`);
  check("need == 10", body.need === 10);
  check("have == 6.3", body.have === 6.3);
  check("walletAddress present", body.walletAddress === OWNER);
  check("executeAction NEVER called (no burn submitted)", execCalls === 0, `calls=${execCalls}`);
  check("NO lock written (receipt absent on reject)", (await deliv.get("job-1")).receipt === undefined);
  check("message names have+need", /Have 6\.30 USDC, need 10\.00/.test(body.error || ""), body.error);
}

console.log("\nCASE 2: balance 25.00 >= amount 10 → proceeds to execution (funded, no regression)");
{
  await seed(10); balanceMinor = usdc(25); execCalls = 0;
  const { status, body } = parse(await call());
  check("HTTP 200 executed:true", status === 200 && body.executed === true, `got ${status}`);
  check("executeAction WAS called (burn proceeds)", execCalls === 1, `calls=${execCalls}`);
  check("receipt burn_confirmed", (await deliv.get("job-1")).receipt.state === "burn_confirmed");
}

console.log("\nCASE 3: balance 10.00 == amount 10 → proceeds (>= inclusive; sponsored gas)");
{
  await seed(10); balanceMinor = usdc(10); execCalls = 0;
  const { status, body } = parse(await call());
  check("HTTP 200 executed:true (boundary is inclusive)", status === 200 && body.executed === true, `got ${status}`);
  check("executeAction called at exact-balance", execCalls === 1, `calls=${execCalls}`);
}

console.log("\nORDERING: read → reject-or-proceed → (only if funded) burn");
{
  await seed(10); balanceMinor = usdc(9.999999); execCalls = 0; // one micro-USDC short
  const { status } = parse(await call());
  check("9.999999 < 10 → 402, still no burn", status === 402 && execCalls === 0, `status=${status} calls=${execCalls}`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money.`);
process.exit(fail === 0 ? 0 : 1);
