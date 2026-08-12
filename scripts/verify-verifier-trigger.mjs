// verify-verifier-trigger.mjs — ZERO-MONEY proof of the fireVerifier fix.
//   node --experimental-test-module-mocks scripts/verify-verifier-trigger.mjs
//
// ⚠️ WHAT A STUB CANNOT PROVE — read this before trusting the result.
// The ORIGINAL bug (fire-and-forget dying to Netlify's post-response freeze) was hidden
// precisely because the old test stubbed `fetch`. A stub cannot reproduce the freeze:
// that is a PLATFORM behaviour, not a code behaviour. So CASE 3 below does NOT prove
// "Netlify delivers the invocation". It proves the strictly weaker, still-necessary
// claim: the handler now AWAITS the trigger, so the request is fully issued and its
// response consumed BEFORE the handler returns — which is exactly the property the freeze
// destroyed. The remaining gap (does the platform deliver it?) is only closable by a real
// approve on prod.
//
// To make CASE 3 as strong as a stub allows, the stubbed fetch is not a no-op: it invokes
// the REAL verifier handler in-process, so we observe the trigger actually reaching it.
import { mock } from "node:test";

const OWNER = "0xc54d47211997aca90ef4fcfbc742a3b511b4e621";
const BURN = "0xaaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990";

const stores = {};
const mkStore = (name) => {
  stores[name] ??= new Map();
  const m = stores[name];
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), setJSON: async (k, v) => void m.set(k, JSON.stringify(v)) };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: mkStore } });
mock.module("../netlify/functions/_auth.mjs", {
  namedExports: { requireSession: () => ({ address: OWNER, method: "metamask" }), internalToken: () => "tok", requireInternal: () => true },
});
mock.module("../netlify/functions/_agent-wallets.mjs", {
  namedExports: { WALLET_PROVISIONING_STATUS: 503, walletProvisioningRefusal: () => ({ error: "provisioning", reason: "wallet-provisioning", retryable: true, whatHappened: "nothing" }), ensureOwnerWallet: async () => ({ walletAddress: OWNER, pending: false }) },
});
mock.module("../netlify/functions/_actions.mjs", {
  namedExports: {
    executeAction: async (step) => ({
      ok: true, kind: "bridge_usdc", state: "submitted", burnHash: BURN,
      tx: `https://testnet.arcscan.app/tx/${BURN}`, destination: step.destination,
      feeUsdc: 0.2, netUsdc: Number(step.amountUsdc) - 0.2, recipient: OWNER,
    }),
  },
});

// ── the stubbed fetch: three modes ───────────────────────────────────────────
let mode = "reach"; // reach | hang | fail
let verifierInvocations = 0;
let lastVerifierBody = null;

globalThis.fetch = async (url, init) => {
  if (!String(url).includes("job-bridge-receipt-background")) throw new Error("unexpected fetch: " + url);
  if (mode === "fail") throw new Error("connect ECONNREFUSED");
  if (mode === "hang") {
    // Never resolves on its own — only the AbortController can end this.
    return new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  }
  // "reach": actually deliver the trigger to the REAL verifier handler.
  verifierInvocations++;
  lastVerifierBody = JSON.parse(init.body);
  await verifier({ httpMethod: "POST", headers: { "x-internal-token": "tok" }, blobs: null, body: init.body });
  return { status: 202, ok: true };
};

// Verifier's own network reads: IRIS says minted; chain verification passes.
mock.module("../netlify/functions/_bridge.mjs", {
  namedExports: {
    BRIDGE_DESTINATIONS: { base: { label: "Base (Sepolia)", cctpDomain: 6, explorerTx: "https://sepolia.basescan.org/tx/" } },
    bridgeMintStatus: async () => ({ state: "minted", mintTxHash: "0x" + "7f".repeat(32), mintTx: "https://sepolia.basescan.org/tx/0x7f" }),
    resolveDestination: (n) => (String(n).toLowerCase() === "base" ? { key: "base", label: "Base (Sepolia)", cctpDomain: 6 } : null),
  },
});
mock.module("../netlify/functions/_receipt.mjs", {
  namedExports: { verifyMintOnChain: async () => ({ verified: true, chainId: 84532, blockNumber: 1, usdcAddress: "0x036c", usdcAmount: 9.8 }) },
});

const { handler: approve } = await import("../netlify/functions/job-bridge-approve.mjs");
const { handler: verifier } = await import("../netlify/functions/job-bridge-receipt-background.mjs");

const deliv = mkStore("job-deliverables");
const runs = mkStore("job-runs");
const seed = async () => {
  stores["job-deliverables"].clear(); stores["job-runs"].clear();
  await runs.setJSON("run:r1", { runId: "r1", owner: OWNER, jobId: "job-1", walletAddress: OWNER });
  await deliv.setJSON("job-1", {
    status: "completed", canonicalReport: "{}", deliverableHash: "0xh", brief: {},
    proposal: { action: "bridge_usdc", destination: "base", amountUsdc: 10, reasoning: "r" },
  });
};
const call = () => approve({ httpMethod: "POST", headers: {}, blobs: null, body: JSON.stringify({ runId: "r1" }) });
const parse = (r) => ({ status: r.statusCode, body: JSON.parse(r.body) });

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// ── CASE 1: hung + failed trigger must NEVER fail the approve ──
console.log("CASE 1: trigger hangs / fails → approve still succeeds, burn intact");
for (const m of ["hang", "fail"]) {
  mode = m; await seed();
  const t0 = Date.now();
  const { status, body } = parse(await call());
  const elapsed = Date.now() - t0;
  const rec = (await deliv.get("job-1")).receipt;
  check(`[${m}] 200 executed:true`, status === 200 && body.executed === true, `got ${status}`);
  check(`[${m}] burn NOT reported as failure`, !body.error && body.receipt?.burnHash === BURN);
  check(`[${m}] receipt durable at burn_confirmed`, rec.state === "burn_confirmed" && rec.burnHash === BURN);
  check(`[${m}] verifierTriggered:false is a HINT, not an error`, body.verifierTriggered === false);
  if (m === "hang") check("[hang] aborted at the timeout, did not hang forever", elapsed < 5000, `${elapsed}ms`);
}

// ── CASE 2: single-flight lease ──
console.log("\nCASE 2: second invocation while lease held → exits without polling");
{
  mode = "reach"; await seed();
  const cur = await deliv.get("job-1");
  // Simulate a live loop: burn_confirmed with a FRESH lease.
  await deliv.setJSON("job-1", { ...cur, receipt: { state: "burn_confirmed", destinationKey: "base", burnHash: BURN, recipient: OWNER, verifyingSince: new Date().toISOString() } });
  const before = verifierInvocations;
  const r = JSON.parse((await verifier({ httpMethod: "POST", headers: { "x-internal-token": "tok" }, blobs: null, body: JSON.stringify({ jobId: "job-1" }) })).body);
  check("second invocation exits early", /lease held/.test(r.note || ""), JSON.stringify(r));
  check("receipt NOT advanced to minted by the duplicate", (await deliv.get("job-1")).receipt.state === "burn_confirmed");

  // A STALE lease must be reclaimable (this is what stranded #155262).
  const stale = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const cur2 = await deliv.get("job-1");
  await deliv.setJSON("job-1", { ...cur2, receipt: { ...cur2.receipt, verifyingSince: stale } });
  const r2 = JSON.parse((await verifier({ httpMethod: "POST", headers: { "x-internal-token": "tok" }, blobs: null, body: JSON.stringify({ jobId: "job-1" }) })).body);
  check("STALE lease is reclaimed → verifier runs to minted", r2.state === "minted", JSON.stringify(r2));
  check("lease cleared on terminal state", (await deliv.get("job-1")).receipt.verifyingSince === undefined);
  void before;
}

// ── CASE 3: THE FIX — the trigger actually reaches the verifier ──
console.log("\nCASE 3: normal approve → trigger is AWAITED and REACHES the verifier");
{
  mode = "reach"; await seed();
  verifierInvocations = 0; lastVerifierBody = null;
  const { status, body } = parse(await call());
  const rec = (await deliv.get("job-1")).receipt;
  check("200 executed:true", status === 200 && body.executed === true);
  check("verifierTriggered:true", body.verifierTriggered === true);
  check("verifier WAS invoked (old code: 0 invocations)", verifierInvocations === 1, `${verifierInvocations}`);
  check("trigger carried ONLY the jobId (a key, not a claim)", JSON.stringify(lastVerifierBody) === JSON.stringify({ jobId: "job-1" }));
  // The trigger was awaited, so by the time approve returned the verifier had already run.
  check("receipt PROGRESSED to minted before approve returned", rec.state === "minted", rec.state);
  check("mint double-verified", JSON.stringify(rec.mintVerifiedBy) === JSON.stringify(["iris", "destination-rpc"]));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero real network.`);
console.log("NOTE: CASE 3 proves the handler AWAITS and issues the trigger. It cannot prove Netlify");
console.log("      delivers it post-response — that is a platform property, provable only on prod.");
process.exit(fail === 0 ? 0 : 1);
