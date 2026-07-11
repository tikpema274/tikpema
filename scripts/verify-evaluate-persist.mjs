// verify-evaluate-persist.mjs — ZERO-MONEY replay of job-evaluate-background's persist().
// No network, no Blobs, no chain. Reimplements the OLD and NEW merge side by side against
// a simulated eventually-consistent store, and asserts the safety properties.
//
//   node scripts/verify-evaluate-persist.mjs
//
// Proves:
//   1. proposal SURVIVES the rebuild (the #155200 bug)
//   2. txHash/tx SURVIVE (the pre-existing, silent loss)
//   3. NOTHING new becomes forgeable: a hostile `threaded` body (which arrives over the
//      wire) can NEVER inject or override a `proposal` — prior always wins, and when
//      prior is absent the proposal is LOST, not reconstructed.
//   4. When prior never converges, behavior degrades exactly as before (fail-closed).

const sleep = () => Promise.resolve(); // no real waiting in the replay

// A store that returns null for the first `missFor` reads, then the record (eventual read).
function makeStore(record, missFor) {
  let reads = 0;
  return {
    reads: () => reads,
    get: async () => (++reads <= missFor ? null : record),
  };
}

// The record job-submit-background wrote at step 6.
const STEP_SIX = {
  status: "submitted",
  canonicalReport: '{"question":"Bridge 10 USDC from Arc to Base"}',
  deliverableHash: "0xhash",
  brief: { answer: "…", sources: [1], proposal: { action: "bridge", destination: "Base", amountUsdc: 10 } },
  proposal: { action: "bridge_usdc", destination: "base", amountUsdc: 10, cap: 25 }, // SERVER-VALIDATED
  txHash: "0xSUBMIT",
  tx: "https://testnet.arcscan.app/tx/0xSUBMIT",
};
const THREADED = {
  status: "submitted",
  canonicalReport: STEP_SIX.canonicalReport,
  deliverableHash: STEP_SIX.deliverableHash,
  brief: STEP_SIX.brief,
};
const PATCH = { status: "completed", verdict: "pass", evalStatus: "ok", hashVerified: true, settleTx: "0xSETTLE" };

// ── OLD persist (single read, `|| {}` on miss) ──
async function persistOld(store, threaded, patch) {
  const prior = (await store.get()) || {};
  return { ...(threaded || {}), ...prior, ...patch };
}

// ── NEW persist (retry the read; WHITELISTED seed; fail-closed) ──
// Mirrors job-evaluate-background.mjs exactly, including SEED_KEYS.
const SEED_KEYS = ["status", "canonicalReport", "deliverableHash", "brief"];
async function persistNew(store, threaded, patch) {
  const seed = () =>
    threaded ? Object.fromEntries(SEED_KEYS.filter((k) => threaded[k] !== undefined).map((k) => [k, threaded[k]])) : {};
  const tries = threaded ? 8 : 1;
  let prior = null;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep();
    prior = await store.get();
    if (prior) break;
  }
  if (!prior) return { ...seed(), ...patch };
  return { ...seed(), ...prior, ...patch };
}

let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

console.log("── 1. Blobs race: prior invisible for the first 3 reads (the #155200 condition) ──");
{
  const oldOut = await persistOld(makeStore(STEP_SIX, 3), THREADED, PATCH);
  check("OLD: proposal DESTROYED (reproduces the bug)", oldOut.proposal === undefined);
  check("OLD: txHash DESTROYED (the pre-existing loss)", oldOut.txHash === undefined);

  const s = makeStore(STEP_SIX, 3);
  const newOut = await persistNew(s, THREADED, PATCH);
  check("NEW: proposal SURVIVES", JSON.stringify(newOut.proposal) === JSON.stringify(STEP_SIX.proposal));
  check("NEW: txHash SURVIVES", newOut.txHash === "0xSUBMIT" && newOut.tx === STEP_SIX.tx);
  check("NEW: retried until visible", s.reads() === 4, `${s.reads()} reads`);
  check("NEW: patch still wins (status completed)", newOut.status === "completed");
  check("NEW: hash fields intact (on-chain proof unaffected)", newOut.deliverableHash === "0xhash");
}

console.log("\n── 2. Prior visible immediately (the happy path) — merge order unchanged ──");
{
  const newOut = await persistNew(makeStore(STEP_SIX, 0), THREADED, PATCH);
  const oldOut = await persistOld(makeStore(STEP_SIX, 0), THREADED, PATCH);
  check("NEW == OLD when there is no race", JSON.stringify(newOut) === JSON.stringify(oldOut));
}

console.log("\n── 3. SECURITY: a HOSTILE threaded body cannot inject or override a proposal ──");
{
  // `threaded` arrives over the wire. Suppose it is forged to carry a proposal that would
  // bridge 25 USDC to Ethereum. prior (the real, server-authored record) must win.
  const HOSTILE = { ...THREADED, proposal: { action: "bridge_usdc", destination: "ethereum", amountUsdc: 25 }, txHash: "0xFAKE" };

  const withPrior = await persistNew(makeStore(STEP_SIX, 3), HOSTILE, PATCH);
  check("forged proposal LOSES to the server-authored one",
    withPrior.proposal.destination === "base" && withPrior.proposal.amountUsdc === 10,
    `got ${JSON.stringify(withPrior.proposal)}`);
  check("forged txHash LOSES to the real one", withPrior.txHash === "0xSUBMIT");

  // And when prior NEVER converges, the forged proposal must NOT be reconstructed —
  // fail-closed: the record carries no proposal at all, so no approve button can appear.
  const neverStore = { get: async () => null };
  const noPrior = await persistNew(neverStore, HOSTILE, PATCH);
  check("prior never converges → forged proposal is NOT persisted", noPrior.proposal === undefined,
    `got ${JSON.stringify(noPrior.proposal)}`);
  check("prior never converges → no fake txHash persisted", noPrior.txHash === undefined);
  check("prior never converges → brief/report still preserved (no regression)",
    !!noPrior.canonicalReport && !!noPrior.brief);
}

console.log("\n── 4. Forced-refund path: no record expected, must not stall ──");
{
  const s = { reads: 0, get: async function () { this.reads++; return null; } };
  const out = await persistNew(s, null, { status: "rejected", reason: "no usable brief" });
  check("threaded=null → single read, no 8× retry", s.reads === 1, `${s.reads} read(s)`);
  check("refund patch persists", out.status === "rejected");
}

console.log(`\n${fail === 0 ? "✅ ALL CHECKS PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
