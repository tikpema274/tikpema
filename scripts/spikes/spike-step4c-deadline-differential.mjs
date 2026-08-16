// spike-step4c-deadline-differential.mjs — STEP 4, PART C: LINK 1 by DIFFERENTIAL, read-only.
//
// ═══ ZERO MONEY, ZERO GAS, ZERO BROADCAST ═══
// `circle()` is a TRIPWIRE that captures the built calldata and throws, so nothing can ever be
// submitted. Every chain interaction is an eth_call or a balance read. Runs ~11 minutes.
//
// ═══ WHY THIS EXISTS ═══
// Part B came back ESTIMATION-REJECTED: Circle refused the expired swap before broadcast, so the
// AdapterContract's OWN deadline enforcement (LINK 1) was never exercised. Link 1 still matters —
// estimation runs BEFORE broadcast, and the deadline exists to protect the window AFTER estimation and
// BEFORE mining, which estimation cannot cover by construction. It is also Circle-side behaviour we
// neither control nor have documented; the DD rule is not to depend on the audited.
// But proving it does NOT need a broadcast: eth_call executes the same EVM code path against the same
// state, and at `latest` the deadline is even further past, so a revert there holds a fortiori for any
// later block. Hence: prove it read-only.
//
// ═══ THE PROBE BUG THIS FILE FIXES (Part B, 2026-07-21) ═══
// Part B's probe was a BARE fetch with NO retry. Arc answered "request limit reached" — a THROTTLE —
// and the code turned a null `error.data` into "no revert data (bare revert / OOG)". A TRANSPORT
// FAILURE WAS RENDERED AS A FINDING ABOUT THE CONTRACT. Same class as the NaN-cap and the false-success
// banner. Two fixes here, and the second matters more than the first:
//   (1) every probe is wrapped in the PRODUCTION withRetry/isTransient (netlify/functions/_retry.mjs —
//       the same helper that hardened agentSwap's allowance read; NOT a second copy of the regex).
//   (2) transport failure can NEVER occupy the same slot as an execution result. Outcomes are a closed
//       set — success | revert | rpc-error | probe-failed — and only an RPC that actually SAYS
//       "execution reverted" (or hands back revert data) may be recorded as `revert`. Anything else is
//       INCONCLUSIVE and says so. A throttle can no longer masquerade as evidence.
//
// ═══ THE ARGUMENT — attribution by TIME, not by reason string ═══
//   CONTROL   (t≈0,    quote fresh):  eth_call(calldata) → must SUCCEED
//   TEST      (t≈630s, quote expired): eth_call(THE SAME calldata) → must REVERT (any shape, even bare)
//   The calldata is byte-identical and the sender is identical. The ONLY variable is elapsed time,
//   so a revert is time-attributable → the deadline. A decodable reason is CORROBORATION, never the
//   proof — which is what makes this immune to a bare `require(block.timestamp <= deadline)` with no
//   message, or a custom error not in any candidate table.
//   LIVENESS  (t≈630s, a FRESH quote): eth_call(new calldata) → must SUCCEED.
//     This is a LIVENESS control, not an isolation control: the fresh quote differs in execId and
//     signature too, so it does not isolate the deadline field. Its job is narrower and real — it rules
//     out "everything reverts at t=630 for an unrelated state/RPC reason", which is the main
//     alternative explanation the temporal differential alone cannot exclude.
//
// FAILURE OF THE CONTROL IS NOT A PASS: if the CONTROL reverts, the calldata was broken for some other
// reason and the differential proves NOTHING. Reported as INCONCLUSIVE and exits early — before the
// 630s wait, so a broken setup costs seconds, not eleven minutes.
//
// RUN (needs the standing allowance from Part B's surviving approve, so it stays gas-free):
//   read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//     node --experimental-test-module-mocks --env-file=.env \
//       scripts/spikes/spike-step4c-deadline-differential.mjs
//   optional: --amount=1.00   --wait-sec=NNN (default: until deadline +30s)   --allow-approve

process.env.PERIOD_CEILING_USDC ||= "60";
import { mock } from "node:test";
import { toFunctionSelector, decodeAbiParameters } from "viem";

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const AMOUNT = arg("amount", "1.00");
const EXTRA_MARGIN_SEC = Number(arg("wait-sec", "30"));
const ALLOW_APPROVE = process.argv.includes("--allow-approve");
const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";

if (!process.env.KIT_KEY || !process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
  console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env) and KIT_KEY (prod env) — the calldata comes from a REAL quote.");
  process.exit(2);
}

// ── in-memory @netlify/blobs ──
const stores = {};
let etagSeq = 0;
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  const m = (stores[nm] ??= new Map());
  return {
    async get(k, opts) { const e = m.get(k); if (e == null) return null; return opts?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { return m.get(k)?.value ?? null; },
    async setJSON(k, v, opts) {
      const cur = m.get(k);
      if (opts?.onlyIfNew && cur) return { modified: false };
      if (opts?.onlyIfMatch && cur?.etag !== opts.onlyIfMatch) return { modified: false };
      const etag = `e${++etagSeq}`; m.set(k, { value: v, etag }); return { modified: true, etag };
    },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(opts) { const p = opts?.prefix ?? ""; return { blobs: [...m.keys()].filter((x) => x.startsWith(p)).map((key) => ({ key })) }; },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });

// ── TRIPWIRE circle(): captures what WOULD have been submitted, submits nothing, ever. ──
const realCircleMod = await import("../../netlify/functions/_circle.mjs");
const captured = [];
class Captured extends Error { constructor(kind) { super(`captured ${kind} — Part C never submits`); this.name = "Captured"; } }
mock.module("../../netlify/functions/_circle.mjs", {
  namedExports: {
    ...realCircleMod,
    circle: () => ({
      createContractExecutionTransaction: async (args) => {
        const kind = args?.callData ? "swap" : (args?.abiFunctionSignature || "unknown");
        captured.push({ kind, callData: args?.callData ?? null, to: String(args?.contractAddress || "").toLowerCase() });
        throw new Captured(kind);
      },
      getTransaction: async () => { throw new Captured("getTransaction"); },
    }),
  },
});

// ── passive quote observer: records the deadline of each quote (never modifies the response). ──
const realFetch = globalThis.fetch;
const quotes = [];
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  if (String(url).includes("/stablecoinKits/swap") && res.ok) {
    try {
      const b = await res.clone().json();
      const EP = (b?.data ?? b)?.transaction?.executionParams;
      if (EP) quotes.push({ deadlineSec: Number(EP.deadline), execId: String(EP.execId), observedAt: Date.now() });
    } catch { /* observation only */ }
  }
  return res;
};

const { executeAction } = await import("../../netlify/functions/_actions.mjs");
const { CONTRACTS, USDC_DECIMALS } = await import("../../netlify/functions/_arc.mjs");
const { withRetry, isTransient } = await import("../../netlify/functions/_retry.mjs"); // SAME helper as agentSwap's hardened read
const { rpcCall, assertChain } = await import("../dd/rpc.mjs");
const { getChain } = await import("../dd/chains.mjs");

const chain = getChain("arc-testnet");
const rpc = (m, p) => rpcCall({ endpoint: chain.rpc, method: m, params: p }).then((r) => r.result); // dd's own retry
const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── THE HARDENED PROBE ────────────────────────────────────────────────────────────────────
// Raw POST (dd/rpc.mjs:69 throws on json.error and DISCARDS error.data — the revert payload we need),
// but wrapped in the production retry, and with transport failure classified SEPARATELY from execution.
async function rawPost(method, params) {
  const r = await realFetch(chain.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return r.json();
}
const REVERTISH = /execution reverted|reverted|invalid opcode|out of gas|stack underflow/i;
async function probe(callData, label) {
  try {
    return await withRetry(async () => {
      const j = await rawPost("eth_call", [{ from: WALLET, to: SWAP_ADAPTER, data: callData }, "latest"]);
      if (!j?.error) return { outcome: "success", result: j?.result ?? null };

      const message = String(j.error.message || "");
      const data = j.error.data?.data ?? j.error.data ?? null;
      const hasRevertData = typeof data === "string" && data.startsWith("0x");

      // A THROTTLE IS NOT A REVERT. Throw so withRetry can retry; if it exhausts, the caller records
      // probe-failed — never an observation about the contract.
      if (!hasRevertData && isTransient(new Error(message))) throw new Error(message);

      // Only an RPC that actually reports execution failure may be recorded as a revert.
      if (hasRevertData || REVERTISH.test(message)) return { outcome: "revert", data: hasRevertData ? data : null, message };
      return { outcome: "rpc-error", message }; // non-transient, non-revert → inconclusive, never evidence
    }, { retries: 4, label });
  } catch (e) {
    return { outcome: "probe-failed", message: e.message, transient: isTransient(e) };
  }
}

// Reason decoding — CORROBORATION ONLY. The differential is the proof; this never gates the verdict.
const ERROR_STRING_SELECTOR = "0x08c379a0";
const DEADLINE_SIGS = ["DeadlineExpired()", "Expired()", "SwapExpired()", "DeadlinePassed()", "TransactionExpired()", "DeadlineExceeded()", "ExpiredDeadline()", "SignatureExpired()"];
const DEADLINE_SELECTORS = Object.fromEntries(DEADLINE_SIGS.map((s) => [toFunctionSelector(s), s]));
function describeRevert(data) {
  if (!data) return "no revert data (bare revert — decodable reason absent; the differential does not need one)";
  if (data.startsWith(ERROR_STRING_SELECTOR)) {
    try { return `Error("${decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}`)[0]}")`; } catch { return `Error(string), undecodable`; }
  }
  const sel = data.slice(0, 10);
  return DEADLINE_SELECTORS[sel] ? `custom error ${DEADLINE_SELECTORS[sel]} (${sel}) — deadline-shaped` : `custom error ${sel} (not in the candidate table)`;
}

// ── build calldata through the REAL path (quote → getCallData), submitting nothing ──
async function buildCalldata(tag) {
  const before = captured.length;
  try { await executeAction({ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: AMOUNT, reasoning: `step4C ${tag}` }, { walletAddress: WALLET, confirmSwap: true }); }
  catch (e) { if (e?.name !== "Captured") throw new Error(`${tag}: path failed before submit — ${e.message}`); }
  const c = captured[before];
  if (!c?.callData) throw new Error(`${tag}: no calldata captured (captured: ${c?.kind ?? "nothing"})`);
  if (c.to !== SWAP_ADAPTER) throw new Error(`${tag}: calldata addressed to ${c.to}, not the adapter`);
  return { callData: c.callData, quote: quotes[quotes.length - 1] };
}

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };

console.log(`\n════ STEP 4 · PART C · LINK 1 by DIFFERENTIAL · READ-ONLY (no gas, no broadcast) ════\n`);
await assertChain(chain);

// ZERO-GAS GATE: with a standing allowance, agentSwap skips its approve. Without one it would fire a
// REAL approve — so refuse rather than quietly spend gas in a "read-only" spike.
const allowance = Number(BigInt(await rpc("eth_call", [{ to: CONTRACTS.USDC, data: "0xdd62ed3e" + pad(WALLET) + pad(SWAP_ADAPTER) }, "latest"]))) / 10 ** USDC_DECIMALS;
console.log(`  standing allowance → adapter: ${allowance.toFixed(6)} USDC   ·   probe amount: ${AMOUNT} USDC`);
if (allowance < Number(AMOUNT) && !ALLOW_APPROVE) {
  console.error(`\n✖ allowance ${allowance} < ${AMOUNT}: agentSwap would fire a REAL approve (gas), breaking Part C's read-only guarantee.`);
  console.error(`  Fix: --amount=${allowance > 0 ? allowance.toFixed(2) : "<= allowance>"} to fit the standing allowance, or --allow-approve to accept one real approve tx.`);
  process.exit(2);
}

// ── CONTROL — fresh quote, probed immediately ──
console.log(`\n── CONTROL (quote fresh) ──`);
const A = await buildCalldata("control");
const deadlineMs = A.quote.deadlineSec * 1000;
console.log(`  calldata ${A.callData.slice(0, 26)}…  (${A.callData.length} chars)  execId ${A.quote.execId}`);
console.log(`  deadline ${new Date(deadlineMs).toISOString()} (in ${((deadlineMs - Date.now()) / 1000).toFixed(0)}s)`);
const controlBlock = await rpc("eth_blockNumber", []);
const control = await probe(A.callData, "control probe");
console.log(`  → ${control.outcome}${control.message ? `: ${control.message.slice(0, 120)}` : ""}   @block ${parseInt(controlBlock, 16)}`);

if (control.outcome !== "success") {
  console.log(`\n════ VERDICT — PART C · INCONCLUSIVE (control did not succeed) ════`);
  console.log(`  The differential needs a SUCCEEDING control: if this calldata already fails while its deadline is`);
  console.log(`  still valid, a later revert proves nothing about the deadline.`);
  console.log(control.outcome === "probe-failed" || control.outcome === "rpc-error"
    ? `  This was a TRANSPORT/RPC failure (${control.message?.slice(0, 100)}), NOT a statement about the contract. Re-run.`
    : `  The contract rejected a VALID-deadline swap (${describeRevert(control.data)}). Investigate that first — it is a different finding.`);
  console.log(`\n  (nothing submitted, no gas, no funds moved — exited before the wait.)`);
  process.exit(2);
}

// ── WAIT for the deadline to genuinely pass ──
const waitMs = deadlineMs + EXTRA_MARGIN_SEC * 1000 - Date.now();
console.log(`\n── WAITING ${Math.ceil(waitMs / 1000)}s for the deadline to pass (real time; the calldata is untouched) ──`);
const end = Date.now() + waitMs;
while (Date.now() < end) {
  console.log(`     … ${Math.ceil((end - Date.now()) / 1000)}s remaining`);
  await sleep(Math.min(60_000, Math.max(1_000, end - Date.now())));
}

// ── TEST — the SAME calldata, now expired ──
console.log(`\n── TEST (same calldata, deadline now ${((Date.now() - deadlineMs) / 1000).toFixed(0)}s in the past) ──`);
const testBlock = await rpc("eth_blockNumber", []);
const test = await probe(A.callData, "test probe");
console.log(`  → ${test.outcome}${test.message ? `: ${test.message.slice(0, 120)}` : ""}   @block ${parseInt(testBlock, 16)}`);
if (test.outcome === "revert") console.log(`  reason (corroboration only): ${describeRevert(test.data)}`);

// ── LIVENESS — a FRESH quote probed at the same moment ──
console.log(`\n── LIVENESS CONTROL (fresh quote, same instant) ──`);
let liveness = { outcome: "not-run" };
try {
  const B = await buildCalldata("liveness");
  liveness = await probe(B.callData, "liveness probe");
  console.log(`  → ${liveness.outcome}${liveness.message ? `: ${liveness.message.slice(0, 120)}` : ""}   execId ${B.quote.execId}`);
} catch (e) { console.log(`  → could not build a fresh quote: ${e.message}`); }

// ── VERDICT ───────────────────────────────────────────────────────────────────────────────
console.log(`\n════ ASSERTIONS ════`);
check("CONTROL: the calldata executes cleanly while its deadline is valid", control.outcome === "success", `outcome=${control.outcome}`);
check("TEST: the SAME calldata is REJECTED once the deadline has passed", test.outcome === "revert", `outcome=${test.outcome}${test.outcome === "probe-failed" ? " (transport, NOT contract evidence)" : ""}`);
check("LIVENESS: a fresh quote still succeeds at that same moment (the chain/state/RPC are healthy)", liveness.outcome === "success", `outcome=${liveness.outcome}`);
check("PROBE INTEGRITY: no transport failure was counted as an execution result", ![control, test, liveness].some((p) => p.outcome === "probe-failed" || p.outcome === "rpc-error"), `outcomes: ${[control.outcome, test.outcome, liveness.outcome].join(" / ")}`);

console.log(`\n════ VERDICT — PART C ════`);
if (test.outcome === "success") {
  console.log(`🛑 STOP — THE ADAPTER DOES NOT ENFORCE THE DEADLINE.`);
  console.log(`   The same calldata still executes ${((Date.now() - deadlineMs) / 1000).toFixed(0)}s past its deadline. LINK 1 IS FALSE:`);
  console.log(`   the pre-submit guard (_swap.mjs:229-232) and Circle's estimation are the ONLY protections, and the`);
  console.log(`   comment at _swap.mjs:225-228 is wrong. Do not commit the refactor on the current deadline posture.`);
  process.exit(1);
}
if (fails === 0) {
  console.log(`✅ PART C PASS — LINK 1 PROVEN BY DIFFERENTIAL, no broadcast required:`);
  console.log(`   identical calldata, identical sender — SUCCEEDS before the deadline, REVERTS after.`);
  console.log(`   The only variable is elapsed time, so the rejection IS the deadline${test.data ? ` (reason corroborates: ${describeRevert(test.data)})` : ` — and this holds even though the revert carries no decodable reason`}.`);
  console.log(`   Chain state was healthy at test time (a fresh quote succeeded in the same window).`);
  console.log(`   Scope: proven by SIMULATION at latest — the same EVM path, with the deadline even further past than`);
  console.log(`   at mining time, so it holds a fortiori for a mined tx. NOT a mined-receipt proof; the 4337 envelope`);
  console.log(`   question is separate and untouched.`);
} else {
  console.log(`⚠️ INCONCLUSIVE — ${fails} assertion(s) unmet. Nothing here contradicts the deadline posture; it simply`);
  console.log(`   was not established. Re-run if any probe reported transport failure — that is a network artifact,`);
  console.log(`   NOT a statement about the contract (the exact conflation that made Part B's probe misleading).`);
}
console.log(`\n  (read-only: nothing submitted, no gas, no funds moved; the tripwire makes submission impossible.)`);
process.exit(test.outcome === "success" ? 1 : fails === 0 ? 0 : 2);
