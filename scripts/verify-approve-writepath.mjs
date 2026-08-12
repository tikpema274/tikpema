// verify-approve-writepath.mjs — ZERO-MONEY dry exercise of job-bridge-approve's WRITE path.
// executeAction, the Blobs store, auth, and the agent wallet are all STUBBED. Nothing
// signs, nothing persists to Netlify, no network call leaves this process.
//
//   node --experimental-test-module-mocks scripts/verify-approve-writepath.mjs
//
// What this proves (the logic the adversarial read-test could not reach):
//   • the client CANNOT inject burnHash / amount / destination — a hostile body is ignored
//   • the optimistic lock is written BEFORE executeAction runs (narrowing double-approve)
//   • a second approve while a receipt exists is REFUSED (409) and never bridges twice
//   • a guard block RELEASES the lock and writes NO receipt
//   • TxPendingError yields burn_pending (no burnHash) — honest incompleteness
//   • ownership / status / proposal / cap preconditions all refuse before any execution
import { mock } from "node:test";
import { TxPendingError } from "../netlify/functions/_circle.mjs";

const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const OTHER = "0x1e18D9418BFB6bB9750a4b294eA5077b2cfe31Be";
const SERVER_BURN = "0xaaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990";
const CLIENT_LIE  = "0xbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad1";

// ── in-memory blob stores ────────────────────────────────────────────────────
const stores = {};
const mkStore = (name) => {
  stores[name] ??= new Map();
  const m = stores[name];
  return {
    get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    setJSON: async (k, v) => void m.set(k, JSON.stringify(v)),
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: mkStore } });

// ── auth + wallet stubs ──────────────────────────────────────────────────────
let SESSION = { address: OWNER, method: "metamask" };
mock.module("../netlify/functions/_auth.mjs", {
  namedExports: { requireSession: () => SESSION, internalToken: () => "test-internal" },
});
mock.module("../netlify/functions/_agent-wallets.mjs", {
  namedExports: { WALLET_PROVISIONING_STATUS: 503, walletProvisioningRefusal: () => ({ error: "provisioning", reason: "wallet-provisioning", retryable: true, whatHappened: "nothing" }), ensureOwnerWallet: async () => ({ walletAddress: OWNER, pending: false }) },
});

// ── executeAction stub — the money path, replaced ────────────────────────────
let execMode = "ok";
let execCalls = 0;
let lockSeenAtExec = null; // what the receipt looked like WHEN executeAction ran
mock.module("../netlify/functions/_actions.mjs", {
  namedExports: {
    executeAction: async (step) => {
      execCalls++;
      lockSeenAtExec = (await mkStore("job-deliverables").get("job-1"))?.receipt ?? null;
      if (execMode === "blocked") return { ok: false, blocked: "exceeds per-bridge limit of 25 USDC" };
      if (execMode === "pending") throw new TxPendingError("circle-tx-id-123");
      if (execMode === "throw") throw new Error("chain exploded");
      return {
        ok: true, kind: "bridge_usdc", state: "submitted",
        burnHash: SERVER_BURN, tx: `https://testnet.arcscan.app/tx/${SERVER_BURN}`,
        destination: step.destination, feeUsdc: 0.21, netUsdc: Number(step.amountUsdc) - 0.21,
        recipient: OWNER,
      };
    },
  },
});

// fireVerifier must never actually reach the network in a dry run. The stub stays — it is
// the network guard — but this file NO LONGER ASSERTS ON IT.
//
// It used to check `verifierFired === 1`, and those assertions have been REMOVED rather than
// repaired: verify-verifier-trigger.mjs supersedes them and says why in its own header —
// "precisely because the old test stubbed `fetch`. A stub cannot reproduce the freeze".
// This IS that old test. Netlify FREEZES the lambda after the response, so a fire-and-forget
// fetch can be killed mid-flight; counting stubbed calls proves the call was *made*, not that
// it *survived* — which is the only thing that matters. Asserting it here would be a green
// light for a bug the superseding test actually catches.
//
// What this file still proves (and is worth keeping): the APPROVE TRUST BOUNDARY — that every
// client-supplied field is ignored in favour of the server-authored proposal, that the lock is
// in place before executeAction runs, and that canonicalReport is never mutated.
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

const { handler } = await import("../netlify/functions/job-bridge-approve.mjs");

// ── fixtures ─────────────────────────────────────────────────────────────────
const runs = mkStore("job-runs");
const deliv = mkStore("job-deliverables");
const seed = async ({ status = "completed", proposal = { action: "bridge_usdc", destination: "base", amountUsdc: 5, reasoning: "r" }, receipt } = {}) => {
  await runs.setJSON("run:run-1", { runId: "run-1", owner: OWNER, jobId: "job-1", walletAddress: OWNER });
  // NOTE: pass `proposal: null` to seed a brief with NO proposal. Passing `undefined`
  // would re-trigger the destructuring default above and silently seed a VALID one —
  // which is exactly the trap that made an earlier run of this test lie.
  const entry = { status, canonicalReport: '{"immutable":true}', deliverableHash: "0xhash", brief: {} };
  if (proposal) entry.proposal = proposal;
  if (receipt) entry.receipt = receipt;
  await deliv.setJSON("job-1", entry);
};
const reset = () => { execCalls = 0; lockSeenAtExec = null; execMode = "ok"; SESSION = { address: OWNER, method: "metamask" }; };

// A HOSTILE body: the client tries to dictate the hash, the amount, the destination.
const hostileBody = JSON.stringify({
  runId: "run-1",
  burnHash: CLIENT_LIE, mintTxHash: CLIENT_LIE, txHash: CLIENT_LIE,
  amountUsdc: 999999, destination: "ethereum", feeUsdc: 0, state: "minted",
});
const call = (body = hostileBody) => handler({ httpMethod: "POST", headers: {}, body, blobs: null });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

console.log("── job-bridge-approve write path (stubbed executeAction; zero money) ──\n");

// CASE 1 — happy path, under a hostile body.
console.log("CASE 1: happy path with a HOSTILE body (client tries to inject hash/amount/destination)");
reset(); stores["job-deliverables"]?.clear(); stores["job-runs"]?.clear(); await seed();
{
  const { status, body } = parse(await call());
  const rec = (await deliv.get("job-1")).receipt;
  check("200 executed", status === 200 && body.executed === true, `got ${status}`);
  check("burnHash is the SERVER's, not the client's", rec.burnHash === SERVER_BURN, rec.burnHash === CLIENT_LIE ? "CLIENT LIE ACCEPTED!" : "server value");
  check("client 'amountUsdc: 999999' IGNORED (proposal's 5 used)", rec.amountUsdc === 5, `receipt says ${rec.amountUsdc}`);
  check("client 'destination: ethereum' IGNORED (proposal's base used)", rec.destinationKey === "base", `receipt says ${rec.destinationKey}`);
  check("client 'state: minted' IGNORED", rec.state === "burn_confirmed", `state=${rec.state}`);
  check("no mintTxHash present (mint not yet verified)", rec.mintTxHash === undefined);
  check("LOCK was in place BEFORE executeAction ran", lockSeenAtExec?.state === "approving", `saw ${lockSeenAtExec?.state}`);
  check("canonicalReport untouched (on-chain hash safe)", (await deliv.get("job-1")).canonicalReport === '{"immutable":true}');
}

// CASE 2 — double approve.
console.log("\nCASE 2: second approve while a receipt exists");
reset();
{
  const { status, body } = parse(await call());
  check("409 refused", status === 409, `got ${status}`);
  check("executeAction NOT called again (no double bridge)", execCalls === 0, `calls=${execCalls}`);
  check("error names the existing state", /already approved/.test(body.error || ""), body.error);
}

// CASE 3 — guard block releases the lock.
console.log("\nCASE 3: executeAction returns blocked (a guard refuses)");
reset(); stores["job-deliverables"].clear(); stores["job-runs"].clear(); await seed(); execMode = "blocked";
{
  const { status, body } = parse(await call());
  const entry = await deliv.get("job-1");
  check("200 executed:false with the block reason", status === 200 && body.executed === false, body.blocked);
  check("LOCK RELEASED — no receipt left behind", entry.receipt === undefined, `receipt=${JSON.stringify(entry.receipt)}`);
}

// CASE 4 — TxPendingError → burn_pending.
console.log("\nCASE 4: slow burn (TxPendingError) → honest burn_pending");
reset(); stores["job-deliverables"].clear(); stores["job-runs"].clear(); await seed(); execMode = "pending";
{
  const { status, body } = parse(await call());
  const rec = (await deliv.get("job-1")).receipt;
  check("202 pending", status === 202 && body.pending === true, `got ${status}`);
  check("state = burn_pending", rec.state === "burn_pending", rec.state);
  check("NO burnHash (we don't have one yet)", rec.burnHash === undefined);
  check("circleTxId retained for later resolution", rec.circleTxId === "circle-tx-id-123");
}

// CASE 5 — unexpected throw releases the lock.
console.log("\nCASE 5: unexpected throw during execution");
reset(); stores["job-deliverables"].clear(); stores["job-runs"].clear(); await seed(); execMode = "throw";
{
  const { status } = parse(await call());
  check("500", status === 500);
  check("LOCK RELEASED — no receipt", (await deliv.get("job-1")).receipt === undefined);
}

// CASE 6 — preconditions refuse BEFORE any execution.
console.log("\nCASE 6: preconditions (each must refuse before executeAction runs)");
reset(); stores["job-deliverables"].clear(); stores["job-runs"].clear(); await seed();
SESSION = { address: OTHER, method: "metamask" };
check("foreign session → 403", parse(await call()).status === 403);
SESSION = { address: OWNER, method: "metamask" };

stores["job-deliverables"].clear(); await seed({ status: "rejected" });
check("research not completed → 409", parse(await call()).status === 409);

stores["job-deliverables"].clear(); await seed({ proposal: null });
check("no proposal → 409", parse(await call()).status === 409);

stores["job-deliverables"].clear(); await seed({ proposal: { action: "bridge_usdc", destination: "base", amountUsdc: 26 } });
check("proposal over the 25 cap → 409", parse(await call()).status === 409);

stores["job-deliverables"].clear(); await seed({ proposal: { action: "bridge_usdc", destination: "narnia", amountUsdc: 5 } });
check("unsupported destination → 409", parse(await call()).status === 409);

check("executeAction NEVER ran for any precondition failure", execCalls === 0, `calls=${execCalls}`);

console.log(`\n${fail === 0 ? "✅ ALL WRITE-PATH CHECKS PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
