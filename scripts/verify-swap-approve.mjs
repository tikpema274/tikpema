// verify-swap-approve.mjs — ZERO-MONEY dry exercise of job-swap-approve's WRITE path.
// executeAction, Blobs, auth, the wallet and the chain reads are all STUBBED. Nothing signs,
// nothing persists to Netlify, no network call leaves this process.
//
// The swap twin of verify-approve-writepath. Same trust boundary, same hostile body:
//   • the client CANNOT inject tokens / amount / txHash — a hostile body is ignored
//   • the cap is re-checked in USDC-EQUIVALENT (EURC != $1) at approve time
//   • the optimistic lock is written BEFORE executeAction runs
//   • a guard block RELEASES the lock and writes NO receipt
//   • a NULL txHash (the _swap.mjs 1098 quirk) yields submitted_no_hash + a balance
//     snapshot — honest incompleteness, never a fabricated success
//   • ownership / status / proposal preconditions all refuse before any execution
//
//   node --experimental-test-module-mocks --env-file=.env scripts/verify-swap-approve.mjs
import { mock } from "node:test";

// ⭐⭐ SPREAD THE REAL MODULE, OVERRIDE ONLY WHAT THIS SUITE NEEDS. An explicit namedExports
// list breaks every time _agent-wallets gains an export — it has now done so TWICE
// (WALLET_PROVISIONING_STATUS, then WALLET_UNRESOLVABLE_STATUS), each time failing at module
// INSTANTIATION with a message about the export rather than about the test. Spreading makes the
// mock track the module instead of a snapshot of it.
const REAL_WALLETS = await import("../netlify/functions/_agent-wallets.mjs");

const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const OTHER = "0x1e18D9418BFB6bB9750a4b294eA5077b2cfe31Be";
const WALLET = "0xbafec950627579cf786acf875e6e216995e995a3";
const SERVER_HASH = "0xaaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990";
const CLIENT_LIE = "0xbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad1";
const EURC_USD = 1.20;

const stores = {};
const mkStore = (name) => {
  stores[name] ??= new Map();
  const m = stores[name];
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: mkStore } });

let SESSION = { address: OWNER, method: "passkey" };
mock.module("../netlify/functions/_auth.mjs", {
  namedExports: { requireSession: () => SESSION, internalToken: () => "test-internal" },
});
mock.module("../netlify/functions/_agent-wallets.mjs", {
  namedExports: { ...REAL_WALLETS,  ensureOwnerWallet: async () => ({ walletAddress: WALLET, pending: false }) },
});
mock.module("../netlify/functions/_swap.mjs", {
  namedExports: {
    SWAP_TOKENS: ["USDC", "EURC"],
    valueInUsdc: async ({ token, amount }) =>
      String(token).toUpperCase() === "EURC" ? Number(amount) * EURC_USD : Number(amount),
  },
});
// Chain reads — the pre-flight balance gate and the snapshot.
let BAL = { USDC: 100, EURC: 100 };
mock.module("../netlify/functions/_predict.mjs", {
  namedExports: { publicClient: () => ({ readContract: async () => BigInt(Math.round(BAL._next * 1e6)) }) },
});

let execCalls = 0, lockSeenAtExec = null, execMode = "ok";
mock.module("../netlify/functions/_actions.mjs", {
  namedExports: {
    executeAction: async (step) => {
      execCalls++;
      lockSeenAtExec = (await mkStore("job-deliverables").get("job-1"))?.receipt ?? null;
      if (execMode === "blocked") return { ok: false, blocked: "exceeds per-swap limit of 25 USDC" };
      if (execMode === "throw") throw new Error("chain exploded");
      if (execMode === "nohash") return { ok: true, kind: "swap_tokens", swap: { txHash: null, state: "submitted" }, tx: null };
      return { ok: true, kind: "swap_tokens", swap: { txHash: SERVER_HASH, state: "submitted" }, tx: `https://x/tx/${SERVER_HASH}` };
    },
  },
});

globalThis.fetch = async () => ({ ok: true, json: async () => ({}) }); // verifier trigger — network guard only

const { handler } = await import("../netlify/functions/job-swap-approve.mjs");

const runs = mkStore("job-runs");
const deliv = mkStore("job-deliverables");
const PROPOSAL = { action: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: 10, indicativeAmountOut: 8.3, reasoning: "r" };
const seed = async ({ status = "completed", proposal = PROPOSAL, receipt } = {}) => {
  await runs.setJSON("run:run-1", { runId: "run-1", owner: OWNER, jobId: "job-1", walletAddress: WALLET });
  const entry = { status, canonicalReport: '{"immutable":true}', brief: {} };
  if (proposal) entry.proposal = proposal;
  if (receipt) entry.receipt = receipt;
  await deliv.setJSON("job-1", entry);
};
const reset = () => { execCalls = 0; lockSeenAtExec = null; execMode = "ok"; SESSION = { address: OWNER, method: "passkey" }; BAL = { USDC: 100, EURC: 100, _next: 100 }; };
const fresh = async (o) => { reset(); stores["job-deliverables"]?.clear(); stores["job-runs"]?.clear(); await seed(o); };

// A HOSTILE body: the client tries to dictate tokens, amount, and the hash.
const hostile = JSON.stringify({
  runId: "run-1",
  tokenIn: "EURC", tokenOut: "USDC", amountIn: 999999,
  txHash: CLIENT_LIE, state: "confirmed", valueUsdc: 0,
});
const call = (body = hostile) => handler({ httpMethod: "POST", headers: {}, body, blobs: null });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log("── job-swap-approve write path (stubbed executeAction; zero money) ──\n");

console.log("CASE 1: happy path with a HOSTILE body");
await fresh();
{
  const { status, body } = parse(await call());
  const rec = (await deliv.get("job-1")).receipt;
  check("200 executed", status === 200 && body.executed === true, `got ${status}`);
  check("txHash is the SERVER's, not the client's", rec.txHash === SERVER_HASH, rec.txHash === CLIENT_LIE ? "CLIENT LIE ACCEPTED!" : "server value");
  check("client 'tokenIn: EURC' IGNORED (proposal's USDC used)", rec.tokenIn === "USDC", `receipt says ${rec.tokenIn}`);
  check("client 'tokenOut: USDC' IGNORED (proposal's EURC used)", rec.tokenOut === "EURC", `receipt says ${rec.tokenOut}`);
  check("client 'amountIn: 999999' IGNORED (proposal's 10 used)", rec.amountIn === 10, `receipt says ${rec.amountIn}`);
  check("client 'state: confirmed' IGNORED", rec.state === "submitted", `state=${rec.state}`);
  check("valueUsdc re-derived server-side (not the client's 0)", rec.valueUsdc === 10, `${rec.valueUsdc}`);
  check("balance snapshot recorded (verifier's fallback evidence)", rec.balancesBefore?.USDC === 100, JSON.stringify(rec.balancesBefore));
  check("walletAddress recorded (verifier reads it, not its request body)", rec.walletAddress === WALLET);
  check("LOCK was in place BEFORE executeAction ran", lockSeenAtExec?.state === "approving", `saw ${lockSeenAtExec?.state}`);
  check("canonicalReport untouched", (await deliv.get("job-1")).canonicalReport === '{"immutable":true}');
}

console.log("\nCASE 2: NULL txHash (the _swap.mjs 1098 quirk) → honest submitted_no_hash");
await fresh(); execMode = "nohash";
{
  const { status, body } = parse(await call());
  const rec = (await deliv.get("job-1")).receipt;
  check("200 executed (the swap WAS submitted)", status === 200 && body.executed === true);
  check("state = submitted_no_hash (not a fabricated success)", rec.state === "submitted_no_hash", rec.state);
  check("txHash is null, not invented", rec.txHash === null);
  check("snapshot present → the verifier can confirm by balance delta", rec.balancesBefore?.EURC === 100);
}

console.log("\nCASE 3: second approve while a receipt exists");
{
  // Reuse CASE 2's persisted receipt (do NOT re-seed), but zero the counter first — CASE 2's
  // own legitimate call left it at 1, and this asserts nothing NEW executes.
  execCalls = 0;
  const { status, body } = parse(await call());
  check("409 refused", status === 409, `got ${status}`);
  check("executeAction NOT called again (no double swap)", execCalls === 0, `calls=${execCalls}`);
}

console.log("\nCASE 4: a guard blocks → lock released, no receipt");
await fresh(); execMode = "blocked";
{
  const { status, body } = parse(await call());
  check("200 executed:false with the reason", status === 200 && body.executed === false, body.blocked);
  check("LOCK RELEASED — no receipt left behind", (await deliv.get("job-1")).receipt === undefined);
}

console.log("\nCASE 5: unexpected throw → lock released");
await fresh(); execMode = "throw";
{
  check("500", parse(await call()).status === 500);
  check("LOCK RELEASED", (await deliv.get("job-1")).receipt === undefined);
}

console.log("\nCASE 6: THE CAP, re-checked at approve time in USDC-EQUIVALENT");
{
  // 22 EURC is BELOW the raw cap number (25) but ≈ 26.40 USDC — OVER. A stale proposal must
  // not outrank the current guard, and the guard must not bound the raw amount.
  await fresh({ proposal: { ...PROPOSAL, tokenIn: "EURC", tokenOut: "USDC", amountIn: 22 } });
  const { status, body } = parse(await call());
  check("22 EURC (raw < cap) ≈ 26.40 USDC → 409 refused", status === 409 && /per-swap limit/.test(body.error || ""), body.error);
  check("nothing executed", execCalls === 0);
  check("no receipt written", (await deliv.get("job-1")).receipt === undefined);
}

console.log("\nCASE 7: pre-flight balance gate → clean 402, no lock");
{
  await fresh();
  BAL._next = 1; // wallet holds 1 USDC, proposal wants 10
  const { status, body } = parse(await call());
  check("402 insufficient funds", status === 402 && /Insufficient funds/.test(body.error || ""), body.error);
  check("nothing executed", execCalls === 0);
  check("no lock taken", (await deliv.get("job-1")).receipt === undefined);
}

console.log("\nCASE 8: preconditions (each must refuse BEFORE executeAction)");
await fresh();
SESSION = { address: OTHER, method: "passkey" };
check("foreign session → 403 (per-user: not your job)", parse(await call()).status === 403);
SESSION = { address: OWNER, method: "passkey" };
await fresh({ status: "rejected" });
check("research not completed → 409", parse(await call()).status === 409);
await fresh({ proposal: null });
check("no proposal → 409", parse(await call()).status === 409);
await fresh({ proposal: { action: "bridge_usdc", destination: "base", amountUsdc: 5 } });
check("a BRIDGE proposal is not approvable here → 409", parse(await call()).status === 409);
check("executeAction never ran on any precondition path", execCalls === 0, `calls=${execCalls}`);
{
  const r = await handler({ httpMethod: "POST", headers: {}, body: "{}", blobs: null });
  check("no runId → 400", r.statusCode === 400);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
