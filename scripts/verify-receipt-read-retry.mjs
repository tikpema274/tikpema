// verify-receipt-read-retry.mjs — ZERO-MONEY proof of the verifier's load() read-retry.
//   node --experimental-test-module-mocks scripts/verify-receipt-read-retry.mjs
//
// The bug: approve writes the receipt, then triggers the verifier. Blobs is eventually
// consistent (~11s). The verifier read ONCE and 404'd on the miss, exiting before taking
// the lease — stranding jobs #155262 and #155315 at burn_confirmed while the mint had
// landed. Prod logs proved the verifier WAS invoked (9s after approve), so the trigger was
// never the problem; a read was losing the race.
//
// Proves:
//   1. A receipt that becomes visible on the 4th read → verifier retries, finds it, and
//      runs through to `minted`. No 404.
//   2. A genuinely ABSENT receipt → still 404s, after a BOUNDED number of tries. It does
//      not hang forever and does not retry-bomb the store.
import { mock } from "node:test";

const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const BURN = "0x" + "a1".repeat(32);

// Store whose reads miss for the first `missFor` attempts (simulating eventual read lag).
let missFor = 0, reads = 0, writes = 0;
const RECORD = {
  status: "completed", canonicalReport: "{}", deliverableHash: "0xh", brief: {},
  receipt: { state: "burn_confirmed", destinationKey: "base", burnHash: BURN, recipient: OWNER, amountUsdc: 10, approvedAt: new Date(Date.now() - 4000).toISOString() },
};
let present = true;
const store = {
  get: async () => { reads++; if (!present) return null; return reads <= missFor ? null : structuredClone(RECORD); },
  setJSON: async (_k, v) => { writes++; RECORD.receipt = v.receipt; },
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: () => store } });
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireInternal: () => true } });
mock.module("../netlify/functions/_circle.mjs", { namedExports: { circle: () => ({}), waitForTx: async () => BURN } });
mock.module("../netlify/functions/_bridge.mjs", {
  namedExports: {
    BRIDGE_DESTINATIONS: { base: { label: "Base (Sepolia)", cctpDomain: 6, explorerTx: "https://sepolia.basescan.org/tx/" } },
    bridgeMintStatus: async () => ({ state: "minted", mintTxHash: "0x" + "7f".repeat(32), mintTx: "https://sepolia.basescan.org/tx/0x7f" }),
  },
});
mock.module("../netlify/functions/_receipt.mjs", {
  namedExports: { verifyMintOnChain: async () => ({ verified: true, chainId: 84532, blockNumber: 43964310, usdcAddress: "0x036c", usdcAmount: 9.79624 }) },
});

const { handler } = await import("../netlify/functions/job-bridge-receipt-background.mjs");
const call = () => handler({ httpMethod: "POST", headers: { "x-internal-token": "t" }, blobs: null, body: JSON.stringify({ jobId: "job-1" }) });

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log("CASE 1: receipt invisible for the first 3 reads (the #155315 condition)");
{
  present = true; missFor = 3; reads = 0; writes = 0;
  RECORD.receipt = { state: "burn_confirmed", destinationKey: "base", burnHash: BURN, recipient: OWNER, amountUsdc: 10, approvedAt: new Date(Date.now() - 4000).toISOString() };
  const t0 = Date.now();
  const res = await call();
  const body = JSON.parse(res.body);
  check("no 404 — the read was retried", res.statusCode !== 404, `HTTP ${res.statusCode}`);
  check("verifier ran through to minted", body.state === "minted", JSON.stringify(body));
  check("receipt persisted as minted", RECORD.receipt.state === "minted");
  check("lease cleared on terminal write", RECORD.receipt.verifyingSince === undefined);
  check("retried, did not give up on first miss", reads > 3, `${reads} reads`);
  console.log(`     (elapsed ${Date.now() - t0}ms — retries are real 1.5s sleeps)`);
}

console.log("\nCASE 2: receipt genuinely ABSENT → bounded 404, no retry-bomb, no hang");
{
  present = false; missFor = 0; reads = 0; writes = 0;
  const t0 = Date.now();
  const res = await call();
  const elapsed = Date.now() - t0;
  const body = JSON.parse(res.body);
  check("still 404s (absence is concluded, eventually)", res.statusCode === 404, `HTTP ${res.statusCode}`);
  check("reason is honest", /no receipt to verify/.test(body.error || ""));
  check("BOUNDED: exactly 10 reads, not unbounded", reads === 10, `${reads} reads`);
  check("no writes on the absent path", writes === 0, `${writes} writes`);
  check("terminated (did not hang)", elapsed < 30000, `${elapsed}ms`);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
console.log("NOTE: this proves the RETRY. It cannot prove the live race is now won —");
console.log("      only a fresh prod bridge that auto-closes can do that.");
process.exit(fail === 0 ? 0 : 1);
