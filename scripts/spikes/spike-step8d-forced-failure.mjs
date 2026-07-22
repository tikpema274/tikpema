// spike-step8d-forced-failure.mjs — STEP 8, part 5: validate the BACKSTOP against a REAL Circle failure.
//
// ═══ ⚠️ REAL SUBMIT. Requires --confirm; a bare run prints the plan and exits. ~12 min. ═══
//
// ═══ THE RUN'S PRIMARY PURPOSE IS THE MODEL-GAP CHECK ═══
// The backstop reverses on exactly one thing: `state ∈ TERMINAL_FAILED` (FAILED/CANCELLED/DENIED).
// If Circle reports an estimation-rejected swap with a state NOT in that set, the backstop reports
// `leftUnmodelled` and REVERSES NOTHING — the phantom stands. Step 4b observed
// `state:"FAILED", errorReason:"ESTIMATION_ERROR"` on a different call path; that is ONE observation
// and this run exists to confirm it here. ⭐ THE RAW state / errorReason / txHash ARE PRINTED BEFORE
// ANY ASSERTION so the classification is yours to check, not mine to assert.
//
// ═══ WHY THE BACKSTOP AND NOT THE VERIFIER ═══
// job-swap-receipt-background reverses only on `reason:"reverted"`, which needs a BROADCAST tx whose
// receipt reads reverted (_swap-confirm.mjs:136). An estimation-rejected swap is NEVER BROADCAST, so
// the verifier settles `unconfirmed` and never reaches its reversal branch. The manufacturable
// failure therefore lands on the BACKSTOP — which makes the backstop the primary handler for the one
// failure shape we have actually observed, and this the right thing to validate.
//
// ═══ SCOPE DEVIATION, STATED ═══
// The charge is created by calling executeAction on the MANUAL path directly — byte-identical to what
// job-swap-approve does at :171 — rather than driving a full job/proposal/session. The verifier leg
// cannot be exercised by this failure shape anyway (see above), so the scaffolding would add no
// validation. What is REAL here: the quote, the submit, the circleId, getTransaction, the backstop.
//
// SAFETY: @netlify/blobs is in-memory, so NO production budget state is touched. Reads are
// throttle-hardened. The verdict is computed from re-reads, never from the --confirm flag.
//
// RUN:
//   dry:  node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-step8d-forced-failure.mjs
//   real: KIT_KEY="$(netlify env:get KIT_KEY --context production)" \
//           node --experimental-test-module-mocks --env-file=.env \
//             scripts/spikes/spike-step8d-forced-failure.mjs --confirm

process.env.PERIOD_CEILING_USDC ||= "60";
import { mock } from "node:test";

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const CONFIRM = process.argv.includes("--confirm");
const DELAY_SEC = Number(arg("delay-sec", "630"));   // > the 600s quote TTL (step-4 phase 0)
const AMOUNT = Number(arg("amount", "1.00"));
const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const QUOTE_TTL_SEC = 600;

if (!CONFIRM) {
  console.log(`\n⚠️  DRY RUN — nothing submitted, nothing moved.\n`);
  console.log(`  plan: MANUAL swap ${AMOUNT} USDC→EURC (confirm:false — the path that ledgers at SUBMIT)`);
  console.log(`        · submit delayed ${DELAY_SEC}s past the ${QUOTE_TTL_SEC}s quote TTL → Circle estimation-rejects`);
  console.log(`        · agentSwap still returns state:"submitted" + circleId → ledger() fires → PHANTOM CHARGE exists`);
  console.log(`        · poll the REAL getTransaction → ⭐ PRINT RAW state / errorReason / txHash`);
  console.log(`        · sweep({ resolveAfterMs: 0 }) → backstop resolves it → expect ONE reversal`);
  console.log(`        · sweep again → expect open:0, no re-query, daySpend unchanged`);
  console.log(`  ⭐ PRIMARY PURPOSE: is the real state in TERMINAL_FAILED {FAILED,CANCELLED,DENIED}?`);
  console.log(`     If NOT → the backstop leaves it (leftUnmodelled) and reverses nothing = THE MODEL GAP.`);
  console.log(`     That is reported as a FINDING, not a failure — adding a state to TERMINAL_FAILED is your call.`);
  console.log(`  cost: likely ZERO — the observed shape is never broadcast (no gas), and the SCA's standing`);
  console.log(`        allowance skips the approve. If Circle DOES broadcast and the contract reverts: small gas,`);
  console.log(`        no principal (step 4C: atomic revert). If the swap unexpectedly SUCCEEDS: ~${AMOUNT} USDC → EURC (kept).`);
  console.log(`  blast radius: in-memory blobs ⇒ NO production budget/pause state is read or written.\n`);
  console.log(`  re-run with --confirm, in your own terminal (~${Math.ceil((DELAY_SEC + 120) / 60)} min exceeds an agent tool ceiling).\n`);
  process.exit(0);
}
if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET || !process.env.KIT_KEY) {
  console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env) and KIT_KEY (prod env).");
  process.exit(2);
}
if (DELAY_SEC <= QUOTE_TTL_SEC) {
  console.error(`✖ --delay-sec=${DELAY_SEC} does not exceed the ${QUOTE_TTL_SEC}s quote TTL — the quote would still be VALID and the swap would EXECUTE FOR REAL. Refusing.`);
  process.exit(2);
}

// ── in-memory @netlify/blobs — the ONLY mock. No production budget state is touched. ──
const maps = [];
let etagSeq = 0;
const memStore = (name) => {
  const nm = typeof name === "string" ? name : name?.name ?? "default";
  let m = maps.find((x) => x._n === nm);
  if (!m) { m = new Map(); m._n = nm; maps.push(m); }
  return {
    async get(k, o) { const e = m.get(k); if (e == null) return null; return o?.type === "json" ? e.value : JSON.stringify(e.value); },
    async getJSON(k) { return m.get(k)?.value ?? null; },
    async setJSON(k, v, o) {
      const cur = m.get(k);
      if (o?.onlyIfNew && cur) return { modified: false };
      if (o?.onlyIfMatch && cur?.etag !== o.onlyIfMatch) return { modified: false };
      m.set(k, { value: v, etag: `e${++etagSeq}` }); return { modified: true };
    },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(o) { const p = o?.prefix ?? ""; return { blobs: [...m.keys()].filter((x) => x.startsWith(p)).map((key) => ({ key })) }; },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });

// ── delay the SWAP submit so the quote expires. Everything else about Circle is REAL. ──
const realCircleMod = await import("../../netlify/functions/_circle.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let swapCircleId = null;
function wrap(client) {
  return new Proxy(client, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (p !== "createContractExecutionTransaction") return typeof v === "function" ? v.bind(t) : v;
      return async (args) => {
        if (args?.callData) {
          console.log(`\n  ⏳ swap calldata built — holding ${DELAY_SEC}s so its deadline passes (payload untouched)…`);
          const end = Date.now() + DELAY_SEC * 1000;
          while (Date.now() < end) {
            console.log(`     … ${Math.ceil((end - Date.now()) / 1000)}s remaining`);
            await sleep(Math.min(60_000, Math.max(1000, end - Date.now())));
          }
          console.log(`  ▶ submitting the now-EXPIRED swap\n`);
        }
        const res = await t.createContractExecutionTransaction(args);
        if (args?.callData) swapCircleId = res?.data?.id;
        return res;
      };
    },
  });
}
mock.module("../../netlify/functions/_circle.mjs", {
  namedExports: { ...realCircleMod, circle: () => wrap(realCircleMod.circle()) },
});

const { executeAction } = await import("../../netlify/functions/_actions.mjs");
const { sweep } = await import("../../netlify/functions/budget-sweep.mjs");
const { daySpend, listUnresolvedCharges } = await import("../../netlify/functions/_budget.mjs");
const { withRetry } = await import("../../netlify/functions/_retry.mjs");
const { CONTRACTS, USDC_DECIMALS, ARC } = await import("../../netlify/functions/_arc.mjs");
const { rpcCall, assertChain } = await import("../dd/rpc.mjs");
const { getChain } = await import("../dd/chains.mjs");

const chain = getChain("arc-testnet");
const rpc = (m, p) => rpcCall({ endpoint: chain.rpc, method: m, params: p }).then((r) => r.result);
const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const MINOR = 10 ** USDC_DECIMALS;
const bal = async (t) => Number(BigInt(await rpc("eth_call", [{ to: t, data: "0x70a08231" + pad(WALLET) }, "latest"]))) / MINOR;

let fails = 0, findings = [];
const check = (n, c, d = "") => { console.log(`   ${c ? "✅" : "❌"} ${n}${d ? ` — ${d}` : ""}`); if (!c) fails++; };
const FINDING = (m) => { findings.push(m); console.log(`   🔎 ${m}`); };
const TERMINAL_FAILED = new Set(["FAILED", "CANCELLED", "DENIED"]);

console.log(`\n════ STEP 8 · PART 5 · backstop vs a REAL Circle failure ════\n`);
await assertChain(chain);
const usdc0 = await bal(CONTRACTS.USDC), eurc0 = await bal(CONTRACTS.EURC);
console.log(`  before: USDC ${usdc0.toFixed(6)}  EURC ${eurc0.toFixed(6)}  daySpend ${await daySpend({ owner: WALLET })}\n`);

// ── 1 · create the phantom via the MANUAL path ──
let res = null, threw = null;
try {
  res = await executeAction(
    { type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: AMOUNT, reasoning: "step8d forced failure" },
    { walletAddress: WALLET } // NO confirmSwap → manual → ledgers at SUBMIT
  );
} catch (e) { threw = e; }

console.log(`── 1 · the phantom charge ──`);
if (threw || !res?.ok) {
  console.log(`   ⚠️ executeAction did not return ok: ${threw?.message ?? res?.blocked}`);
  console.log(`   If it threw BEFORE the ledger, no charge exists and there is nothing to sweep.`);
  check("a charge was created (required for this run to mean anything)", false, `daySpend=${await daySpend({ owner: WALLET })}`);
  process.exit(2);
}
const circleId = res.swap?.circleId ?? swapCircleId;
const daySpent1 = await daySpend({ owner: WALLET });
check("⭐ PHANTOM EXISTS: the manual path ledgered at SUBMIT", daySpent1 === AMOUNT, `daySpend=${daySpent1}`);
check("…the charge carries confirmation:'submitted' + circleId (the sweeper's index)", (await listUnresolvedCharges({ olderThanMs: 0 })).some((e) => e.circleId === circleId), `circleId=${circleId}`);
check("agentSwap returned state:'submitted' (submit-and-return, no inline wait)", res.swap?.state === "submitted", `state=${res.swap?.state}`);

// ── 2 · ⭐ THE MODEL-GAP CHECK — raw first, classify after ──
console.log(`\n── 2 · ⭐ MODEL-GAP CHECK — what does Circle actually say? ──`);
let state = null, errorReason = null, txHash = null, lookErr = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    const { data } = await withRetry(() => realCircleMod.circle().getTransaction({ id: circleId }), { retries: 3, label: "getTransaction" });
    state = data?.transaction?.state ?? null;
    txHash = data?.transaction?.txHash ?? null;
    errorReason = data?.transaction?.errorReason ?? data?.transaction?.errorDetails ?? null;
  } catch (e) { lookErr = e; }
  if (state && (TERMINAL_FAILED.has(state) || state === "COMPLETE")) break;
  console.log(`     … state=${state ?? `unreadable (${lookErr?.message?.slice(0, 40)})`} — waiting`);
  await sleep(5000);
}
console.log(`\n   ⭐ RAW: state=${JSON.stringify(state)}  errorReason=${JSON.stringify(errorReason)}  txHash=${JSON.stringify(txHash)}`);
console.log(`   backstop TERMINAL_FAILED = {FAILED, CANCELLED, DENIED}`);
const inSet = TERMINAL_FAILED.has(state);
if (inSet) FINDING(`state ${state} IS in TERMINAL_FAILED → the backstop should reverse.`);
else FINDING(`⚠️ MODEL GAP: state ${JSON.stringify(state)} is NOT in TERMINAL_FAILED → the backstop will LEAVE it (leftUnmodelled) and reverse NOTHING. Adding this state to the set is a deliberate widening of the only branch that can reverse — your call, not the runner's.`);

// ── 3 · the backstop, with a short threshold via the injected seam (prod keeps 30m) ──
console.log(`\n── 3 · backstop sweep (resolveAfterMs: 0 — test-only, prod keeps its constant) ──`);
const b1 = await sweep({ resolveAfterMs: 0 });
const daySpent2 = await daySpend({ owner: WALLET });
console.log(`   beat: ${JSON.stringify({ open: b1.open, reversed: b1.reversed, resolved: b1.resolved, leftUnmodelled: b1.leftUnmodelled, leftPending: b1.leftPending, leftUnreadable: b1.leftUnreadable })}`);

if (inSet) {
  check("⭐ the backstop REVERSED the phantom exactly once (re-read)", daySpent2 === 0 && b1.reversed === 1, `daySpend ${daySpent1} → ${daySpent2}, reversed=${b1.reversed}`);
  const b2 = await sweep({ resolveAfterMs: 0 });
  check("second sweep: retired, not re-queried, ledger unchanged", b2.open === 0 && (await daySpend({ owner: WALLET })) === 0, `open=${b2.open}`);
} else {
  check("model gap confirmed: the backstop left the charge standing (fail-CLOSED, nothing guessed)", daySpent2 === daySpent1 && b1.reversed === 0, `daySpend ${daySpent1} → ${daySpent2}, leftUnmodelled=${b1.leftUnmodelled}`);
}

// ── 4 · on-chain witness ──
const usdc1 = await bal(CONTRACTS.USDC), eurc1 = await bal(CONTRACTS.EURC);
const usdcDrop = +(usdc0 - usdc1).toFixed(6), eurcGain = +(eurc1 - eurc0).toFixed(6);
console.log(`\n── 4 · on-chain (dd/rpc) ──`);
console.log(`   USDC −${usdcDrop}   EURC +${eurcGain}   ${txHash ? `${ARC.explorer}/tx/${txHash}` : "no tx broadcast"}`);
if (eurcGain > 0) FINDING(`⚠️ the swap actually EXECUTED (EURC +${eurcGain}) — the quote did not expire as intended; the charge is REAL, not phantom. Do not treat this run as a reversal proof.`);
else check("no principal moved (EURC Δ0 — the failure was pre-broadcast or an atomic revert)", eurcGain === 0, `EURC Δ${eurcGain}`);

console.log(`\n════ VERDICT — STEP 8 PART 5 ════`);
console.log(fails === 0
  ? (inSet
      ? `✅ VALIDATED — a REAL Circle failure produced a real phantom charge, Circle reported ${state}, and the\n   backstop reversed it exactly once. The model matches reality on this path.`
      : `⚠️ NO FAILURE — but a FINDING: the real state is not in TERMINAL_FAILED, so the backstop correctly\n   left the charge standing. Decide whether to widen the set; nothing was guessed.`)
  : `❌ FAIL — ${fails} assertion(s) above.`);
findings.forEach((f) => console.log(`   🔎 ${f}`));
console.log(`\n  (verdict computed from chain + ledger re-reads; never from the --confirm flag. In-memory blobs: no prod budget state touched.)`);
process.exit(fails === 0 ? 0 : 1);
