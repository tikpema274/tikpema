// spike-step5b-real-fill.mjs — STEP 5, PART B: ONE REAL FILL THROUGH THE ID-RECONCILE NET.
//
// ═══ ⚠️ MOVES ~1 USDC. Requires --confirm; a bare run prints the plan and exits. ═══
//
// ═══ ITS WHOLE JOB: VALIDATE THE MODEL, NOT THE LOGIC ═══
// Part A proved the reconcile logic against a SCRIPTED getTransaction — i.e. against OUR MODEL of what
// Circle returns. Step 4 taught us that model can be wrong in ways that matter: Circle issued an id and
// then marked the tx FAILED/"ESTIMATION_ERROR" with NO hash, a shape we had not modelled. So this run's
// deliverable is a MODEL-FIDELITY REPORT: every getTransaction response Circle actually returns is
// recorded and compared against what the reconcile assumes. A surprising state is the FINDING, not a bug
// to be forced into red.
//
// ═══ WHAT IS REAL / WHAT IS NOT ═══
//   REAL: the quote, the allowance read, the approve (if it fires), the swap submit, the circleId, every
//         getTransaction the reconcile makes, the on-chain settlement, the tick's own balance read.
//   MOCKED: (1) @netlify/blobs → in-memory, so NO production mandate/budget state is touched;
//           (2) waitForTx → ID-DISCRIMINATING, exactly as Part A: swap ids throw TxPendingError so the
//               fill genuinely ENTERS THE PENDING NET instead of confirming inline; every other id
//               (the approve) goes to the REAL waitForTx and really waits.
//           (3) recordAgentSpend/recordDcaSpend → counting spies that DELEGATE to the real functions
//               (exactly-once is a call count, not a sum — two 0.5-charges must fail).
//   getTransaction is WRAPPED FOR OBSERVATION ONLY — it calls straight through to Circle.
//
// ═══ OUTCOME CLASSES — this is a LEARNING run, not a green/red binary ═══
//   A  MODEL CONFIRMED   — pending → COMPLETE → all three ledgers once, on-chain USDC↓/EURC↑.   PASS.
//   B  SUBMIT REJECTED   — id-then-FAILED / ESTIMATION_ERROR / no hash (the step-4 shape). Reported
//                          distinctly; the SAFETY assertions still apply (no funds, no ledger, mandate stopped).
//   C  UNMODELLED STATE  — Circle returned a state the reconcile does not classify. THE HIGH-VALUE
//                          FINDING: reported with the raw payload, never forced into pass/fail.
//   D  NET NOT EXERCISED — the fill confirmed INLINE (the forced timeout did not engage). Reported
//                          distinctly, NOT failed: Arc's 2–3s finality is fast and the discrimination
//                          may simply not have caught the swap id.
//   E  STILL PENDING     — non-terminal when the bounded wait ran out. Reported with the last state.
//
// ═══ TIMING ═══
// Tick 1 submits and parks the fill. The reconcile then runs on a POLL LOOP (every RECONCILE_EVERY_MS,
// bounded by MAX_WAIT_MS) because tick 2 may legitimately find the tx still SENT. The bound is kept
// UNDER CONFIRM_GRACE_MS (120s) on purpose — past it the reconcile would correctly declare the fill
// unconfirmed, which is a different (and slower) experiment than the one this run is doing.
//
// ═══ READS ARE THROTTLE-HARDENED ═══
// Balance/allowance reads go through dd/rpc's retrying rpcCall; the post-mortem getTransaction goes
// through the production withRetry. A "request limit reached" must NEVER be reported as a finding —
// that conflation is what made step 4's revert probe misleading.
//
// RUN:
//   dry run:  node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-step5b-real-fill.mjs
//   for real: read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//               node --experimental-test-module-mocks --env-file=.env \
//                 scripts/spikes/spike-step5b-real-fill.mjs --confirm

process.env.PERIOD_CEILING_USDC ||= "60";
import { mock } from "node:test";
import { requireKitKey } from "../_kit-key.mjs";

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const CONFIRM = process.argv.includes("--confirm");
const AMOUNT = Number(arg("amount", "1.00"));
const RECONCILE_EVERY_MS = 6_000;
const MAX_WAIT_MS = Number(arg("max-wait-ms", "90000")); // < CONFIRM_GRACE_MS (120s) by design
const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";

if (!CONFIRM) {
  console.log(`\n⚠️  DRY RUN — nothing submitted, nothing moved.\n`);
  console.log(`  plan: seed ONE due mandate (in-memory only) · perTickAmount ${AMOUNT} USDC → EURC on ${WALLET}`);
  console.log(`        tick 1: REAL quote → REAL approve (if allowance short) → REAL swap submit → waitForTx forced`);
  console.log(`                to time out FOR THE SWAP ID ONLY → SwapPendingConfirm → fill parked in the net, NO ledger`);
  console.log(`        then:   reconcile ticks every ${RECONCILE_EVERY_MS / 1000}s (bounded ${MAX_WAIT_MS / 1000}s, under the 120s grace)`);
  console.log(`                polling the REAL getTransaction until terminal`);
  console.log(`  witnesses: dd/rpc USDC↓ / EURC↑ · daySpend +≈${AMOUNT} EXACTLY ONCE (call count) · spentAmount +${AMOUNT}`);
  console.log(`             · claim resolved · pendingPeriod null · every observed Circle state logged for model fidelity`);
  console.log(`  cost: ~${AMOUNT} USDC swapped (you keep the EURC) + gas. NO production Blobs state is touched.`);
  console.log(`\n  re-run with --confirm to execute.\n`);
  process.exit(0);
}
// ⭐ Below the dry-run exit: only the --confirm real fill needs a credential.
if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
  console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env).");
  process.exit(2);
}
requireKitKey();

// ── in-memory @netlify/blobs — NO production mandate/budget/pause state is read or written ──
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

// ── REAL Circle, with (a) submit observation, (b) getTransaction observation, (c) the id-discriminating wait ──
const realCircleMod = await import("../../netlify/functions/_circle.mjs");
const TxPendingError = realCircleMod.TxPendingError; // REAL class — agentSwap does `e instanceof`
const submits = [];
const swapIds = new Set();
const observed = [];   // every getTransaction response the reconcile actually saw
const waitCalls = [];
let TIMEOUT_SWAPS = true;

function wrapClient(client) {
  return new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "createContractExecutionTransaction") {
        return async (args) => {
          const isSwap = !!args?.callData;
          const res = await target.createContractExecutionTransaction(args); // REAL submit
          const id = res?.data?.id;
          submits.push({ kind: isSwap ? "swap" : "approve", id, to: String(args?.contractAddress || "").toLowerCase() });
          if (isSwap && id) swapIds.add(id);
          console.log(`   → REAL ${isSwap ? "SWAP" : "approve"} submitted, Circle id ${id}`);
          return res;
        };
      }
      if (prop === "getTransaction") {
        return async (a) => {
          // OBSERVATION ONLY — straight through to Circle.
          try {
            const res = await target.getTransaction(a);
            const t = res?.data?.transaction;
            observed.push({ id: a?.id, state: t?.state ?? null, txHash: t?.txHash ?? null, errorReason: t?.errorReason ?? t?.errorDetails ?? null, shapeOk: !!t && "state" in t });
            return res;
          } catch (e) { observed.push({ id: a?.id, threw: e.message }); throw e; }
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
// Same mechanism as Part A: ONLY swap ids time out, so the fill genuinely enters the pending net.
// Every other id (the approve) goes to the REAL waitForTx and really waits for the real tx.
const discriminatingWaitForTx = async (client, id, ...rest) => {
  if (swapIds.has(id) && TIMEOUT_SWAPS) { waitCalls.push({ id, handled: "TxPendingError (swap-wait)" }); throw new TxPendingError(id); }
  waitCalls.push({ id, handled: "REAL waitForTx" });
  return realCircleMod.waitForTx(client, id, ...rest);
};
mock.module("../../netlify/functions/_circle.mjs", {
  namedExports: { ...realCircleMod, circle: () => wrapClient(realCircleMod.circle()), waitForTx: discriminatingWaitForTx },
});

// ── ledger spies: delegate to the real functions, count calls (resolved at CALL time — never captured) ──
const realBudget = await import("../../netlify/functions/_budget.mjs");
const LEDGER = { agent: { calls: 0, args: [] }, dca: { calls: 0, args: [] } };
const spy = (fn, key) => async (a) => { LEDGER[key].calls++; LEDGER[key].args.push(a?.amountUsdc); return fn(a); };
mock.module("../../netlify/functions/_budget.mjs", {
  namedExports: { ...realBudget, recordAgentSpend: spy(realBudget.recordAgentSpend, "agent"), recordDcaSpend: spy(realBudget.recordDcaSpend, "dca") },
});

const { handler } = await import("../../netlify/functions/dca-tick.mjs");
const { MANDATE_STORE, FILLS_STORE, mandateKey, fillClaimKey, periodFor, STATUS, OUTCOME, CONFIRM_GRACE_MS } = await import("../../netlify/functions/_dca.mjs");
const budgetSeen = await import("../../netlify/functions/_budget.mjs");
const { daySpend } = budgetSeen;
const { CONTRACTS, USDC_DECIMALS, ARC } = await import("../../netlify/functions/_arc.mjs");
const { withRetry } = await import("../../netlify/functions/_retry.mjs");
const { rpcCall, assertChain } = await import("../../shared/dd/rpc.mjs");
const { getChain } = await import("../../shared/dd/chains.mjs");

// instrumentation must be attached, or every "=== 0" assertion passes vacuously (step-5 Part A lesson)
if (budgetSeen.recordAgentSpend === realBudget.recordAgentSpend) {
  console.error("✖ ledger spies NOT attached — call-count assertions would be meaningless. Aborting before spending.");
  process.exit(2);
}

const chain = getChain("arc-testnet");
const rpc = (m, p) => rpcCall({ endpoint: chain.rpc, method: m, params: p }).then((r) => r.result); // retrying
const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const tokenBal = async (t) => Number(BigInt(await rpc("eth_call", [{ to: t, data: "0x70a08231" + pad(WALLET) }, "latest"]))) / 10 ** USDC_DECIMALS;
const allowanceNow = async () => Number(BigInt(await rpc("eth_call", [{ to: CONTRACTS.USDC, data: "0xdd62ed3e" + pad(WALLET) + pad(SWAP_ADAPTER) }, "latest"]))) / 10 ** USDC_DECIMALS;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const note = (name, detail) => console.log(`   ⃠  ${name} — ${detail}`);

const CADENCE = 60 * 60 * 1000;
const mandateStore = () => memStore(MANDATE_STORE);
const fillStore = () => memStore(FILLS_STORE);
const ID = "m-real";
const P = periodFor({ cadenceMs: CADENCE }, Date.now());

console.log(`\n════ STEP 5 · PART B · ONE REAL FILL THROUGH THE NET · ⚠️ ~${AMOUNT} USDC ════\n`);
await assertChain(chain);

const usdcB = await tokenBal(CONTRACTS.USDC), eurcB = await tokenBal(CONTRACTS.EURC), allowB = await allowanceNow();
const dayB = await daySpend({ owner: WALLET });
console.log(`  before: USDC ${usdcB.toFixed(6)}  EURC ${eurcB.toFixed(6)}  allowance→adapter ${allowB.toFixed(6)}  daySpend ${dayB}`);
console.log(`  approve expected to ${allowB >= AMOUNT ? "SKIP (standing allowance covers it)" : "FIRE (allowance short)"}\n`);

await mandateStore().setJSON(mandateKey(WALLET, ID), {
  id: ID, owner: WALLET, walletAddress: WALLET, status: STATUS.ACTIVE,
  tokenIn: "USDC", tokenOut: "EURC", perTickAmount: AMOUNT,
  totalBudgetAmount: 100, spentAmount: 0, cadenceMs: CADENCE,
  endAt: Date.now() + 30 * 24 * 3600_000, lastFilledPeriod: P - 1, pendingPeriod: null,
  consecutiveFailures: 0, consecutiveUnconfirmed: 0, needsAttention: false,
});

// ── TICK 1 — real submit, forced into the pending net ──
console.log(`── TICK 1 · real submit ──`);
await handler({});
const swapSubmit = submits.find((s) => s.kind === "swap");
let m = await mandateStore().get(mandateKey(WALLET, ID), { type: "json" });
let claim = await fillStore().get(fillClaimKey(ID, P), { type: "json" });

if (!swapSubmit) {
  console.log(`\n════ NO SUBMIT — nothing was spent ════`);
  console.log(`  outcome "${m?.lastOutcome}" reason "${m?.lastReason}"`);
  console.log(`  (a "balance unreadable" reason is an Arc THROTTLE, not a logic failure — re-run.)`);
  process.exit(2);
}
const enteredNet = m?.pendingPeriod === P && claim?.status === "submitted" && !!claim?.circleId;
console.log(`   circleId ${swapSubmit.id}   ·   waits: ${waitCalls.map((w) => w.handled).join(" | ")}`);
check("entered the PENDING NET (SwapPendingConfirm parked it with its circleId)", enteredNet, `pendingPeriod=${m?.pendingPeriod} claim=${claim?.status}/${claim?.circleId}`);
check("NO ledger advanced at submit", LEDGER.agent.calls === 0 && LEDGER.dca.calls === 0 && m?.spentAmount === 0, `agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls} spent=${m?.spentAmount}`);

if (!enteredNet && m?.lastOutcome === OUTCOME.SWAPPED) {
  // CLASS D — reported, not failed.
  console.log(`\n════ CLASS D · NET NOT EXERCISED (the fill confirmed INLINE) ════`);
  console.log(`  The forced swap-wait timeout did not engage, so this run tested the inline path, not the net.`);
  console.log(`  Not a failure — but Part B's purpose is unmet. Check the swap-id classification and re-run.`);
  process.exit(2);
}

// ── RECONCILE LOOP — the reconcile may legitimately see a non-terminal state on the first pass ──
console.log(`\n── RECONCILE · polling real getTransaction every ${RECONCILE_EVERY_MS / 1000}s (bounded ${MAX_WAIT_MS / 1000}s, grace is ${CONFIRM_GRACE_MS / 1000}s) ──`);
const deadline = Date.now() + MAX_WAIT_MS;
let ticks = 0;
while (Date.now() < deadline) {
  await sleep(RECONCILE_EVERY_MS);
  await handler({}); ticks++;
  m = await mandateStore().get(mandateKey(WALLET, ID), { type: "json" });
  const last = observed[observed.length - 1];
  console.log(`   tick ${ticks + 1}: Circle state=${last?.state ?? last?.threw ?? "?"}  ·  pendingPeriod=${m?.pendingPeriod}  ·  spentAmount=${m?.spentAmount}`);
  if (m?.pendingPeriod == null) break;
}
claim = await fillStore().get(fillClaimKey(ID, P), { type: "json" });

// ── post-mortem straight from Circle (retry-hardened: a throttle must never read as a finding) ──
let finalState = null, finalHash = null, finalErr = null, lookErr = null;
try {
  const { data } = await withRetry(() => realCircleMod.circle().getTransaction({ id: swapSubmit.id }), { retries: 4, label: "post-mortem getTransaction" });
  finalState = data?.transaction?.state; finalHash = data?.transaction?.txHash;
  finalErr = data?.transaction?.errorReason || data?.transaction?.errorDetails || null;
} catch (e) { lookErr = e; }

const usdcA = await tokenBal(CONTRACTS.USDC), eurcA = await tokenBal(CONTRACTS.EURC), allowA = await allowanceNow();
const dayA = await daySpend({ owner: WALLET });
const usdcDrop = Number((usdcB - usdcA).toFixed(6)), eurcGain = Number((eurcA - eurcB).toFixed(6)), ledgerDelta = Number((dayA - dayB).toFixed(6));

console.log(`\n  after: USDC ${usdcA.toFixed(6)} (−${usdcDrop})  EURC ${eurcA.toFixed(6)} (+${eurcGain})  allowance ${allowA.toFixed(6)}`);
console.log(`  Circle final: state=${finalState ?? (lookErr ? `UNREADABLE (${lookErr.message.slice(0, 60)})` : "?")}${finalErr ? ` err=${JSON.stringify(finalErr).slice(0, 120)}` : ""}`);
console.log(`  tx: ${finalHash ? `${ARC.explorer}/tx/${finalHash}` : "NO HASH"}`);

// ── MODEL FIDELITY — the actual deliverable ──
console.log(`\n── MODEL FIDELITY (what Circle really returned vs what the reconcile models) ──`);
const MODELLED_TERMINAL_OK = new Set(["COMPLETE"]);
const MODELLED_TERMINAL_FAIL = new Set(["FAILED", "CANCELLED", "DENIED"]);
const MODELLED_NONTERMINAL = new Set(["INITIATED", "QUEUED", "SENT", "CONFIRMED", "ACCELERATED", "PENDING_RISK_SCREENING"]);
const seen = [...new Set(observed.map((o) => o.state).filter(Boolean))];
console.log(`   states observed: ${seen.join(", ") || "none"}   (${observed.length} getTransaction call(s))`);
const unmodelled = seen.filter((s) => !MODELLED_TERMINAL_OK.has(s) && !MODELLED_TERMINAL_FAIL.has(s) && !MODELLED_NONTERMINAL.has(s));
check("every observed state is one the reconcile classifies", unmodelled.length === 0, unmodelled.length ? `UNMODELLED: ${unmodelled.join(", ")} ← treated as non-terminal (kept pending); decide deliberately whether that is right` : "all known");
check("response SHAPE matches the model (data.transaction.state / .txHash)", observed.filter((o) => !o.threw).every((o) => o.shapeOk), `shape-ok on ${observed.filter((o) => o.shapeOk).length}/${observed.filter((o) => !o.threw).length}`);
if (unmodelled.length) console.log(`   🔎 CLASS C — this is the finding this run exists to surface. Raw: ${JSON.stringify(observed.slice(-3))}`);

// ── OUTCOME CLASSES ──
console.log(`\n── VERDICT ──`);
if (finalState === "COMPLETE" && eurcGain > 0) {
  console.log(`  CLASS A · MODEL CONFIRMED — the real fill matched the scripted model.`);
  check("on-chain: the swap landed (USDC left, EURC arrived) — dd/rpc witness", usdcDrop > 0 && eurcGain > 0, `USDC −${usdcDrop} · EURC +${eurcGain}`);
  check("all three ledgers advanced EXACTLY ONCE (call count, not sum)", LEDGER.agent.calls === 1 && LEDGER.dca.calls === 1 && m?.spentAmount === AMOUNT, `agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls} spentAmount=${m?.spentAmount}`);
  check(`day-ceiling ledger delta ≈ ${AMOUNT}`, Math.abs(ledgerDelta - AMOUNT) < 0.02, `daySpend ${dayB} → ${dayA} (Δ${ledgerDelta})`);
  check("mandate recorded SWAPPED, pointer cleared, claim resolved", m?.lastOutcome === OUTCOME.SWAPPED && m?.pendingPeriod === null && claim?.status !== "submitted", `outcome=${m?.lastOutcome} pending=${m?.pendingPeriod} claim=${claim?.status}`);
  check("ledgered the value captured at submit (no re-price)", LEDGER.agent.args[0] === Number(claim?.fillValueUsdc ?? AMOUNT) || LEDGER.agent.args[0] === AMOUNT, `ledgered ${LEDGER.agent.args[0]}`);
} else if (MODELLED_TERMINAL_FAIL.has(finalState)) {
  console.log(`  CLASS B · SUBMIT/EXECUTION REJECTED (state ${finalState}${finalHash ? "" : ", NO HASH → never broadcast"}) — the step-4 shape.`);
  console.log(`  Not a logic failure: the net's job here is to stop safely. Safety assertions:`);
  check("no funds moved (EURC Δ exactly 0)", eurcGain === 0, `EURC Δ${eurcGain}`);
  check("NO ledger advanced", LEDGER.agent.calls === 0 && LEDGER.dca.calls === 0 && ledgerDelta === 0, `agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls} Δ${ledgerDelta}`);
  check("mandate stopped and flagged, pointer cleared", m?.status === STATUS.STOPPED_FAILED && m?.needsAttention === true && m?.pendingPeriod === null, `status=${m?.status}`);
  note("MODEL NOTE", `Circle reached ${finalState} without a hash — the reconcile handled it as a terminal failure, which is correct. Record that this shape is REAL, not hypothetical.`);
} else if (m?.pendingPeriod != null) {
  console.log(`  CLASS E · STILL PENDING after ${Math.round(MAX_WAIT_MS / 1000)}s — last state ${finalState ?? "unreadable"}.`);
  note("not a failure", "the fill is parked in the net exactly as designed; it simply had not settled inside this run's bound.");
  note("budget", `intact: ledger calls agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls}, spentAmount=${m?.spentAmount}`);
  note("next", `it would confirm (or age past the ${CONFIRM_GRACE_MS / 1000}s grace → failed-unconfirmed, budget intact) on later ticks. Re-run with --max-wait-ms=... if you want to watch it.`);
} else {
  console.log(`  CLASS C/UNCLASSIFIED · final state ${finalState ?? "unreadable"}, EURC Δ${eurcGain}, ledger calls agent=${LEDGER.agent.calls}.`);
  note("READ BEFORE CONCLUDING", `the reconcile resolved the pointer but the outcome does not match a modelled class. Raw observations: ${JSON.stringify(observed.slice(-3))}`);
  fails++;
}

console.log(`\n════ SUMMARY ════`);
console.log(fails === 0
  ? `✅ PART B — ${finalState === "COMPLETE" ? "the real fill validated the model end-to-end." : "no assertion failed; read the class note above for what was (and was not) exercised."}`
  : `❌ PART B — ${fails} assertion(s) failed. Read the chain before re-running: ${finalHash ? `${ARC.explorer}/tx/${finalHash}` : "no tx hash"}`);
console.log(`   observed states: ${seen.join(", ") || "none"}   ·   ledger calls: agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls}   ·   standing allowance now ${allowA.toFixed(6)} USDC`);
console.log(`\n  (every number above was read back from the chain, Circle, or the in-memory ledger after the fact — never asserted from the --confirm flag.)`);
process.exit(fails === 0 ? 0 : 1);
