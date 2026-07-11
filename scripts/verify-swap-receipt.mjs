// verify-swap-receipt.mjs — ZERO-MONEY proof of job-swap-receipt-background.
//
// This is the RISKIEST new code in the swap brick, and the one path that cannot be forced
// live: _swap.mjs can return a NULL txHash (the 1098 async-waiter quirk — the Circle SCA
// submits asynchronously and App Kit throws "transaction hash is required" even though the
// swap lands). A receipt keyed only on a hash is unverifiable exactly when the SDK is least
// reliable. So the verifier has a second path: confirm by BALANCE DELTA against the snapshot
// job-swap-approve took before executing — the chain is the witness, not the SDK.
//
// Both paths are proven here, plus the honest-failure cases. Nothing signs; the chain reads
// are stubbed; no network call leaves this process.
//
//   node --experimental-test-module-mocks --env-file=.env scripts/verify-swap-receipt.mjs
import { mock } from "node:test";

const WALLET = "0xbafec950627579cf786acf875e6e216995e995a3";
const HASH = "0xaaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990";

const stores = {};
// hideReads simulates Netlify Blobs' ~11s EVENTUAL CONSISTENCY: the first N reads see
// nothing, even though the write has happened. Set it to exercise the read-retry.
let hideReads = 0;
let readCount = 0;
const mkStore = (name) => {
  stores[name] ??= new Map();
  const m = stores[name];
  return {
    get: async (k) => {
      readCount++;
      if (hideReads > 0) { hideReads--; return null; } // "not converged yet"
      return m.has(k) ? JSON.parse(m.get(k)) : null;
    },
    setJSON: async (k, v) => void m.set(k, JSON.stringify(v)),
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: mkStore } });

let INTERNAL_OK = true;
mock.module("../netlify/functions/_auth.mjs", { namedExports: { requireInternal: () => INTERNAL_OK } });

// The chain, stubbed. txReceipt drives the HASH path; balances drive the DELTA path.
let txReceipt = null;           // null = "not mined yet" (the read throws, as viem does)
let balances = { USDC: 100, EURC: 0 };
mock.module("../netlify/functions/_predict.mjs", {
  namedExports: {
    publicClient: () => ({
      getTransactionReceipt: async () => {
        if (!txReceipt) throw new Error("not found");
        return txReceipt;
      },
      // The verifier reads tokenOut's balance. We can't see WHICH token it asked for from a
      // bare readContract stub, so `nextBalance` is set per-case to the tokenOut value.
      readContract: async () => BigInt(Math.round(balances._next * 1e6)),
    }),
  },
});

const { handler } = await import("../netlify/functions/job-swap-receipt-background.mjs");

const deliv = mkStore("job-deliverables");
const seed = async (receipt) => deliv.setJSON("job-1", { status: "completed", receipt });
const baseReceipt = {
  approvedBy: "0xowner", tokenIn: "USDC", tokenOut: "EURC", amountIn: 10,
  walletAddress: WALLET, balancesBefore: { USDC: 100, EURC: 0 },
};
const call = () => handler({ headers: { "x-internal-token": "t" }, body: JSON.stringify({ jobId: "job-1" }), blobs: null });
const rec = async () => (await deliv.get("job-1")).receipt;

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log("── job-swap-receipt-background (zero money, chain stubbed) ──\n");

console.log("PATH 1 — hash present → ask the chain what happened to it");
{
  INTERNAL_OK = true;
  txReceipt = { status: "success", blockNumber: 123n };
  await seed({ ...baseReceipt, state: "submitted", txHash: HASH });
  await call();
  const r = await rec();
  check("tx success → confirmed", r.state === "confirmed", r.state);
  check("block recorded from the CHAIN", r.blockNumber === 123);
}
{
  txReceipt = { status: "reverted", blockNumber: 124n };
  await seed({ ...baseReceipt, state: "submitted", txHash: HASH });
  await call();
  const r = await rec();
  check("tx reverted → failed (never a fabricated success)", r.state === "failed", r.state);
}

console.log("\nPATH 2 — NULL HASH (the 1098 quirk) → confirm by BALANCE DELTA");
{
  txReceipt = null; // no hash to poll at all
  balances._next = 8.3; // EURC went 0 → 8.3 ⇒ the swap landed
  await seed({ ...baseReceipt, state: "submitted_no_hash", txHash: null });
  await call();
  const r = await rec();
  check("tokenOut balance ROSE → confirmed", r.state === "confirmed", r.state);
  check("marked as verified by balance-delta (not by a hash we never had)", r.verifiedBy === "balance-delta");
  check("amountOut derived from the DELTA (8.3 - 0)", r.amountOut === 8.3, `${r.amountOut}`);
  check("txHash still null — not invented", r.txHash === null);
}

console.log("\nHONEST FAILURE — no evidence must never become a success");
{
  txReceipt = null;
  balances._next = 0; // EURC never moved ⇒ we cannot say it landed
  await seed({ ...baseReceipt, state: "submitted_no_hash", txHash: null });
  await call();
  const r = await rec();
  check("no hash AND no balance movement → unconfirmed", r.state === "unconfirmed", r.state);
  check("NOT confirmed, NOT failed — honest incompleteness", r.state !== "confirmed" && r.state !== "failed");
}
{
  txReceipt = null;
  // The approve's balance read hiccuped, so there is no snapshot to compare against.
  await seed({ ...baseReceipt, state: "submitted_no_hash", txHash: null, balancesBefore: null });
  await call();
  const r = await rec();
  check("no hash AND no snapshot → unconfirmed (says why)", r.state === "unconfirmed" && /cannot verify/.test(r.note || ""), r.note);
}

console.log("\nBLOBS EVENTUAL CONSISTENCY — the bug that stranded the first live swap");
{
  // job-swap-approve writes the receipt and triggers us in the same breath. Blobs takes
  // ~11s to converge, so our FIRST read frequently sees nothing. A single get() then 404s
  // and the receipt is stranded at submitted_no_hash forever — with the swap already
  // on-chain. This simulates that: the receipt only becomes visible on the 3rd read.
  INTERNAL_OK = true;
  txReceipt = null;
  balances._next = 8.3;
  await seed({ ...baseReceipt, state: "submitted_no_hash", txHash: null });

  readCount = 0;
  hideReads = 3; // the first THREE reads see nothing, as an unconverged Blobs would
  const res = await call();

  const r = await rec();
  check("receipt invisible on the first reads → RETRIED, not 404'd", res.statusCode !== 404, `status=${res.statusCode}`);
  check("it kept reading until the write converged", readCount > 3, `reads=${readCount}`);
  check("and then confirmed by balance-delta", r.state === "confirmed", r.state);
  hideReads = 0;
}

console.log("\nIDEMPOTENCE + AUTH");
{
  txReceipt = { status: "success", blockNumber: 999n };
  await seed({ ...baseReceipt, state: "confirmed", txHash: HASH, blockNumber: 123 });
  await call();
  const r = await rec();
  check("a TERMINAL receipt is never re-written (replay/double-invoke is a no-op)", r.blockNumber === 123, `block=${r.blockNumber}`);
}
{
  INTERNAL_OK = false;
  await seed({ ...baseReceipt, state: "submitted", txHash: HASH });
  const res = await call();
  check("no internal token → 401 (it WRITES receipts; a public caller could forge one)", res.statusCode === 401);
  check("receipt untouched by the unauthorized call", (await rec()).state === "submitted");
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
