// spike-step5a-reconcile-net.mjs — STEP 5, PART A: the ID-RECONCILE NET (zero money, zero gas).
//
// ═══ NOTHING CAN BE SUBMITTED ═══
// `circle()` is replaced: createContractExecutionTransaction returns a FAKE id and records the attempt;
// getTransaction is a SCRIPTED state machine. No real tx is ever created, so no gas and no chain state
// changes. The only real network calls are read-only: the createSwap quote, agentSwap's allowance read,
// and the tick's balance read.
//
// ═══ WHAT IT PROVES ═══
//   A2  ENTRY  — a real agentSwap whose SWAP-wait times out throws SwapPendingConfirm carrying the
//                circleId; dca-tick persists {circleId, fillValueUsdc} + pendingPeriod and ledgers NOTHING.
//   A3  JOIN   — next tick, getTransaction COMPLETE advances ALL THREE ledgers EXACTLY ONCE, records
//                SWAPPED; a third tick moves nothing. Plus the XOR in BOTH directions.
//   A1  MATRIX — FAILED/CANCELLED/DENIED stop · grace · unreadable-≠-didn't-land · legacy drain ·
//                MAX_RECONCILES_PER_TICK deferral.
//   TRAP       — dca-tick no longer CALLS confirmSwapLanded (PATH 2 gone for DCA) while _swap-confirm.mjs
//                survives for job-swap-receipt-background.
//
// ═══ THE ID-DISCRIMINATED waitForTx — the mechanism, and itself a proof ═══
// agentSwap calls waitForTx TWICE: the APPROVE-wait (_swap.mjs:208, BARE) and the SWAP-wait (:291,
// wrapped in the TxPendingError → SwapPendingConfirm conversion). A blanket "always throw TxPendingError"
// mock would make the APPROVE throw first and propagate as a plain error — the test would pass having
// proven nothing. So the mock discriminates BY ID: swap ids (recorded at submit, classified by `callData`
// vs `abiFunctionSignature`) throw TxPendingError; every other id goes to the REAL waitForTx, which polls
// the scripted getTransaction and returns normally. The approve therefore genuinely waits, and
// "SwapPendingConfirm comes ONLY from the swap-wait" is demonstrated rather than assumed.
// ⚠️ A2 uses perTickAmount 2.00 (> the ~1 USDC standing allowance) precisely so the approve branch FIRES.
// TxPendingError is the REAL class (agentSwap does `e instanceof`), taken from the pre-mock import.
//
// ═══ EXACTLY-ONCE IS A CALL COUNT, NOT A SUM ═══
// recordAgentSpend / recordDcaSpend are wrapped in counting spies that delegate to the real
// implementations. A sum-only assertion passes if something ledgers 0.5 TWICE; `.calls === 1` does not.
// ⚠️ patchMandate is a closure inside dca-tick's handler and cannot be spied directly. Substituted, and
// arguably better: the in-memory store counts durable WRITES per key, so a double-patch is caught as two
// writes of the same mandate.
//
// ═══ VALUE-MIX-UP GUARD ═══
// The COMPLETE case seeds perTickAmount 1.00 but fillValueUsdc 0.77. The reconcile must ledger 0.77
// (captured at submit — NO re-price) while spentAmount advances by 1.00. Equal values would hide a swap
// of the two quantities.
//
// ═══ POSITIVE CONTROL FIRST ═══
// A seeded mandate that is not genuinely DUE is silently skipped (evaluate(): status/endAt/remaining/
// lastFilledPeriod) or refused by the existingClaim guard (dca-tick.mjs:356) — and a skipped mandate
// reads as a false pass on every reject assertion. So the FIRST thing asserted is that a due mandate
// actually REACHES SUBMIT. If it does not, the run EXITS — the rest would be meaningless.
//
// RUN (zero money):
//   KIT_KEY="$(netlify env:get KIT_KEY --context production)" \
//     node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-step5a-reconcile-net.mjs

process.env.PERIOD_CEILING_USDC ||= "60";
import { mock } from "node:test";
import { readFileSync } from "node:fs";

const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";
if (!process.env.KIT_KEY || !process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
  console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env) and KIT_KEY (prod env) — A2 runs the REAL agentSwap up to a faked submit.");
  process.exit(2);
}

// ── in-memory @netlify/blobs, with per-key WRITE COUNTS (the patchMandate substitute) ──
let stores = {};
let writes = {};
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
      const etag = `e${++etagSeq}`;
      m.set(k, { value: v, etag });
      writes[`${nm}/${k}`] = (writes[`${nm}/${k}`] || 0) + 1;
      return { modified: true, etag };
    },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(opts) { const p = opts?.prefix ?? ""; return { blobs: [...m.keys()].filter((x) => x.startsWith(p)).map((key) => ({ key })) }; },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });

// ── SCRIPTED Circle: fake ids on submit, scripted getTransaction, NEVER a real transaction ──
const realCircleMod = await import("../../netlify/functions/_circle.mjs");
const TxPendingError = realCircleMod.TxPendingError; // REAL class — agentSwap does `e instanceof`
const SCRIPT = new Map();        // circleId -> { state, txHash } | { throw: "..." }
const swapIds = new Set();       // ids classified as SWAP submits (drives the waitForTx discrimination)
let submits = [];
let idSeq = 0;
let TIMEOUT_SWAPS = true;        // A3 direction-2 flips this to exercise the INLINE-confirm path
let waitCalls = [];              // every waitForTx call, with how it was handled

const scriptedClient = {
  createContractExecutionTransaction: async (args) => {
    const isSwap = !!args?.callData;
    const id = `fake-${isSwap ? "swap" : "approve"}-${++idSeq}`;
    submits.push({ kind: isSwap ? "swap" : "approve", id, to: String(args?.contractAddress || "").toLowerCase(), hasCallData: isSwap });
    if (isSwap) swapIds.add(id);
    else SCRIPT.set(id, { state: "COMPLETE", txHash: `0xapprove${idSeq}` }); // the approve genuinely completes
    return { data: { id } };
  },
  getTransaction: async ({ id }) => {
    const s = SCRIPT.get(id);
    if (!s) throw new Error(`scripted getTransaction: no script for ${id}`);
    if (s.throw) throw new Error(s.throw);
    return { data: { transaction: { state: s.state, txHash: s.txHash ?? null } } };
  },
};

// THE DISCRIMINATION: swap ids time out; everything else goes to the REAL waitForTx.
const discriminatingWaitForTx = async (client, id, ...rest) => {
  if (swapIds.has(id) && TIMEOUT_SWAPS) {
    waitCalls.push({ id, handled: "TxPendingError (swap-wait)" });
    throw new TxPendingError(id);
  }
  waitCalls.push({ id, handled: swapIds.has(id) ? "REAL waitForTx (swap, timeout disabled)" : "REAL waitForTx (approve)" });
  return realCircleMod.waitForTx(client, id, ...rest); // real polling against the scripted state
};
mock.module("../../netlify/functions/_circle.mjs", {
  namedExports: { ...realCircleMod, circle: () => scriptedClient, waitForTx: discriminatingWaitForTx },
});

// ── LEDGER SPIES — delegate to the real implementations, count every call ──
const realBudget = await import("../../netlify/functions/_budget.mjs"); // AFTER the blobs mock, so it binds the in-memory store
// ⚠️ The spy resolves LEDGER[key] AT CALL TIME. It must NEVER capture the record object: an earlier
// version did, and reset() rebound LEDGER.agent to a fresh object — orphaning the spy, so every count
// read 0 for the whole run. That broke `=== 1` checks AND silently made every `=== 0` check pass
// VACUOUSLY. TOTAL is never reset, so a silent detachment is caught by the meta-assertion at the end.
const LEDGER = { agent: { calls: 0, args: [] }, dca: { calls: 0, args: [] } };
const TOTAL = { agent: 0, dca: 0 };
const spy = (fn, key) => async (a) => { LEDGER[key].calls++; LEDGER[key].args.push(a?.amountUsdc); TOTAL[key]++; return fn(a); };
mock.module("../../netlify/functions/_budget.mjs", {
  namedExports: { ...realBudget, recordAgentSpend: spy(realBudget.recordAgentSpend, "agent"), recordDcaSpend: spy(realBudget.recordDcaSpend, "dca") },
});

// imports AFTER all mocks
const { handler } = await import("../../netlify/functions/dca-tick.mjs");
const { MANDATE_STORE, FILLS_STORE, HEARTBEAT_STORE, mandateKey, fillClaimKey, periodFor, STATUS, OUTCOME, CONFIRM_GRACE_MS, MAX_PENDING_AGE_MS, MAX_RECONCILES_PER_TICK, MAX_CONSECUTIVE_UNCONFIRMED } = await import("../../netlify/functions/_dca.mjs");
const budgetAsConsumersSeeIt = await import("../../netlify/functions/_budget.mjs");
const { daySpend, dcaDaySpend } = budgetAsConsumersSeeIt;

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };

// ── INSTRUMENTATION SELF-CHECK — run BEFORE any assertion that reads a count. A detached spy makes
// every "must be ZERO" assertion pass vacuously, so an unverified spy is worse than no spy. ──
if (budgetAsConsumersSeeIt.recordAgentSpend === realBudget.recordAgentSpend) {
  console.error(`\n✖ INSTRUMENTATION NOT ATTACHED: consumers resolve the REAL recordAgentSpend, so every call-count assertion would be meaningless (and every "=== 0" check would pass vacuously). Fix the mock before trusting any verdict.`);
  process.exit(2);
}
const CADENCE = 60 * 60 * 1000;

function reset() {
  stores = {}; writes = {}; submits = []; waitCalls = [];
  // MUTATE IN PLACE — never rebind (see the spy note above).
  LEDGER.agent.calls = 0; LEDGER.agent.args.length = 0;
  LEDGER.dca.calls = 0; LEDGER.dca.args.length = 0;
  SCRIPT.clear(); swapIds.clear(); TIMEOUT_SWAPS = true;
}
// dca-tick writes an UNCONDITIONAL heartbeat every invocation (dca-tick.mjs:498) — that is the
// proof-of-liveness feature, not a mandate write. Exclude it, or "did this tick write anything?" is
// always true and the idempotence check can never hold.
const durableWrites = () => JSON.stringify(Object.entries(writes).filter(([k]) => !k.startsWith(`${HEARTBEAT_STORE}/`)).sort());
const mandateStore = () => memStore(MANDATE_STORE);
const fillStore = () => memStore(FILLS_STORE);

async function seedMandate(id, over = {}) {
  const m = {
    id, owner: WALLET, walletAddress: WALLET, status: STATUS.ACTIVE,
    tokenIn: "USDC", tokenOut: "EURC",
    perTickAmount: 1.0, totalBudgetAmount: 100, spentAmount: 0,
    cadenceMs: CADENCE, endAt: Date.now() + 30 * 24 * 3600_000,
    lastFilledPeriod: periodFor({ cadenceMs: CADENCE }, Date.now()) - 1, // ← DUE this period
    pendingPeriod: null, consecutiveFailures: 0, consecutiveUnconfirmed: 0, needsAttention: false,
    ...over,
  };
  await mandateStore().setJSON(mandateKey(WALLET, id), m);
  writes = {}; // seeding is not a tick write
  return m;
}
const readMandate = (id) => mandateStore().get(mandateKey(WALLET, id), { type: "json" });
const readClaim = (id, period) => fillStore().get(fillClaimKey(id, period), { type: "json" });
const thisPeriod = () => periodFor({ cadenceMs: CADENCE }, Date.now());
const tick = () => handler({});

console.log(`\n════ STEP 5 · PART A · id-reconcile net · ZERO MONEY / ZERO GAS / NOTHING SUBMITTED ════`);

// ═══════════════ A2 — ENTRY INTO THE NET (+ THE POSITIVE CONTROL) ═══════════════
console.log(`\n── A2 · entry: real agentSwap, swap-wait forced to time out ──`);
reset();
const P = thisPeriod();
await seedMandate("m-entry", { perTickAmount: 2.0 }); // 2.00 > standing allowance → the APPROVE branch FIRES
await tick();

const swapSubmit = submits.find((s) => s.kind === "swap");
// ── POSITIVE CONTROL — everything below is meaningless without it ──
check("POSITIVE CONTROL: a DUE mandate reached SUBMIT (evaluate() said due, the claim guard let it through)", !!swapSubmit && swapSubmit.to === SWAP_ADAPTER, swapSubmit ? `swap submit → ${swapSubmit.to}` : `submits: ${submits.map((s) => s.kind).join(",") || "NONE — mandate was skipped, not tested"}`);
if (!swapSubmit) {
  const m = await readMandate("m-entry");
  console.log(`\n   ⚠️ the mandate never submitted — last outcome "${m?.lastOutcome ?? "?"}" / reason "${m?.lastReason ?? "?"}"`);
  console.log(`   A skipped mandate would make every reject assertion below pass vacuously. Fix the seed (due-ness/funds/cap) before trusting anything.`);
  console.log(`   NOTE: "balance unreadable" here is a TRANSPORT failure (Arc throttle), not a logic failure — just re-run.`);
  process.exit(2);
}

check("the APPROVE branch fired and waited for REAL (2.00 > standing allowance)", waitCalls.some((w) => w.handled.includes("approve")), `waits: ${waitCalls.map((w) => w.handled).join(" | ") || "none"}`);
check("SwapPendingConfirm came from the SWAP-wait only (approve-wait completed normally)", waitCalls.filter((w) => w.handled.startsWith("TxPendingError")).length === 1 && waitCalls[waitCalls.length - 1].handled.startsWith("TxPendingError"), `${waitCalls.length} wait(s), last = ${waitCalls[waitCalls.length - 1]?.handled}`);

const entryClaim = await readClaim("m-entry", P);
const entryMandate = await readMandate("m-entry");
check("claim persisted with the authoritative circleId + fillValueUsdc", entryClaim?.status === "submitted" && entryClaim?.circleId === swapSubmit.id && Number(entryClaim?.fillValueUsdc) === 2.0, `claim=${JSON.stringify(entryClaim)}`);
check("mandate marked pending for this period", entryMandate?.pendingPeriod === P, `pendingPeriod=${entryMandate?.pendingPeriod} (expected ${P})`);
check("NO LEDGER ADVANCED on submit — nothing is confirmed yet", LEDGER.agent.calls === 0 && LEDGER.dca.calls === 0 && entryMandate?.spentAmount === 0, `agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls} spentAmount=${entryMandate?.spentAmount}`);

// ═══════════════ A3 — THE JOIN + THE EXACTLY-ONCE INVARIANT ═══════════════
console.log(`\n── A3 · join: next tick reconciles COMPLETE ──`);
SCRIPT.set(swapSubmit.id, { state: "COMPLETE", txHash: "0xREconciled" });
const daySpendBefore = await daySpend({ owner: WALLET });
await tick();

const joined = await readMandate("m-entry");
check("all THREE ledgers advanced: spentAmount + recordDcaSpend + recordAgentSpend", joined?.spentAmount === 2.0 && LEDGER.dca.calls === 1 && LEDGER.agent.calls === 1, `spentAmount=${joined?.spentAmount} dcaCalls=${LEDGER.dca.calls} agentCalls=${LEDGER.agent.calls}`);
check("EXACTLY ONCE by CALL COUNT (two 0.5-charges would fail this, a sum check would not)", LEDGER.agent.calls === 1 && LEDGER.dca.calls === 1, `agent=${LEDGER.agent.calls}, dca=${LEDGER.dca.calls}`);
check("…and by ledger DELTA", Math.abs((await daySpend({ owner: WALLET })) - daySpendBefore - 2.0) < 1e-6, `daySpend Δ${((await daySpend({ owner: WALLET })) - daySpendBefore).toFixed(6)}`);
check("recorded SWAPPED, pointer cleared, period marked filled", joined?.pendingPeriod === null && joined?.lastFilledPeriod === P && joined?.lastOutcome === OUTCOME.SWAPPED, `pending=${joined?.pendingPeriod} lastFilled=${joined?.lastFilledPeriod} outcome=${joined?.lastOutcome}`);

console.log(`\n── A3 · idempotence: a third tick must move nothing ──`);
const writesBefore = durableWrites();
await tick();
const after3 = await readMandate("m-entry");
check("XOR-1 (reconciled ⇒ never counted again): no further ledger calls", LEDGER.agent.calls === 1 && LEDGER.dca.calls === 1, `agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls}`);
check("…spentAmount unchanged and the period is not re-submitted", after3?.spentAmount === 2.0 && !submits.some((s, i) => s.kind === "swap" && i > submits.indexOf(swapSubmit)), `spentAmount=${after3?.spentAmount}, swap submits=${submits.filter((s) => s.kind === "swap").length}`);
check("…no duplicate durable write of the mandate (heartbeat excluded — it writes every tick by design)", durableWrites() === writesBefore, `durable writes changed: ${durableWrites() !== writesBefore}`);

console.log(`\n── A3 · XOR direction 2: an INLINE-confirmed fill never enters the net ──`);
reset();
TIMEOUT_SWAPS = false; // swap-wait resolves normally → executeAction returns ok → inline confirm
const P2 = thisPeriod();
await seedMandate("m-inline", { perTickAmount: 1.0 });
// the swap id is created during the tick; script it COMPLETE on demand
const origCreate = scriptedClient.createContractExecutionTransaction;
scriptedClient.createContractExecutionTransaction = async (args) => {
  const res = await origCreate(args);
  if (args?.callData) SCRIPT.set(res.data.id, { state: "COMPLETE", txHash: "0xINline" });
  return res;
};
await tick();
scriptedClient.createContractExecutionTransaction = origCreate;

const inlineM = await readMandate("m-inline");
const inlineClaim = await readClaim("m-inline", P2);
check("inline confirm ledgered exactly once (agent via executeAction, dca via the tick)", LEDGER.agent.calls === 1 && LEDGER.dca.calls === 1, `agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls}`);
check("XOR-2 (inline ⇒ never reconciled): pendingPeriod stays null and no 'submitted' claim exists", inlineM?.pendingPeriod == null && inlineClaim?.status !== "submitted", `pending=${inlineM?.pendingPeriod} claimStatus=${inlineClaim?.status}`);
const agentAfterInline = LEDGER.agent.calls;
await tick(); // the net must find nothing to do
check("…and a following tick adds no ledger call", LEDGER.agent.calls === agentAfterInline, `agent=${LEDGER.agent.calls}`);

// ═══════════════ A1 — THE SEEDED MATRIX (one isolated tick per case) ═══════════════
// Seeded directly with pendingPeriod + a claim, so these never touch the submit path.
async function seedPending(id, { state, throwMsg, ageMs = 0, circleId = `cid-${id}`, fillValueUsdc = 0.77, perTickAmount = 1.0, over = {} } = {}) {
  reset();
  const p = thisPeriod();
  await seedMandate(id, { perTickAmount, pendingPeriod: p, lastFilledPeriod: p - 1, ...over });
  await fillStore().setJSON(fillClaimKey(id, p), {
    mandateId: id, period: p, status: "submitted", circleId,
    fillValueUsdc, submittedAt: new Date(Date.now() - ageMs).toISOString(),
  });
  if (throwMsg) SCRIPT.set(circleId, { throw: throwMsg });
  else if (state) SCRIPT.set(circleId, { state, txHash: "0xSEEDED" });
  writes = {};
  return p;
}

console.log(`\n── A1 · COMPLETE (value-mix-up guard: perTick 1.00 vs fillValue 0.77) ──`);
let p = await seedPending("m-complete", { state: "COMPLETE" });
await tick();
let m = await readMandate("m-complete");
check("ledgers the CAPTURED fillValueUsdc (0.77) — no re-price", LEDGER.dca.args[0] === 0.77 && LEDGER.agent.args[0] === 0.77, `dca=${LEDGER.dca.args[0]} agent=${LEDGER.agent.args[0]}`);
check("spentAmount advances by perTickAmount (1.00) — the two quantities are NOT swapped", m?.spentAmount === 1.0, `spentAmount=${m?.spentAmount}`);
check("exactly one call to each ledger", LEDGER.agent.calls === 1 && LEDGER.dca.calls === 1, `agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls}`);

for (const state of ["FAILED", "CANCELLED", "DENIED"]) {
  console.log(`\n── A1 · ${state} → stop, no ledger ──`);
  p = await seedPending(`m-${state}`, { state });
  await tick();
  m = await readMandate(`m-${state}`);
  check(`${state}: mandate STOPPED_FAILED, flagged for attention`, m?.status === STATUS.STOPPED_FAILED && m?.needsAttention === true, `status=${m?.status}`);
  check(`${state}: NO ledger advanced, spentAmount untouched`, LEDGER.agent.calls === 0 && LEDGER.dca.calls === 0 && m?.spentAmount === 0, `agent=${LEDGER.agent.calls} dca=${LEDGER.dca.calls} spent=${m?.spentAmount}`);
  check(`${state}: pointer cleared`, m?.pendingPeriod === null, `pending=${m?.pendingPeriod}`);
}

console.log(`\n── A1 · non-terminal WITHIN grace → stays pending ──`);
p = await seedPending("m-young", { state: "SENT", ageMs: 5_000 });
await tick();
m = await readMandate("m-young");
check("still pending, budget intact, not failed", m?.pendingPeriod === p && m?.spentAmount === 0 && m?.status === STATUS.ACTIVE && LEDGER.agent.calls === 0, `pending=${m?.pendingPeriod} status=${m?.status}`);

console.log(`\n── A1 · non-terminal PAST grace (${CONFIRM_GRACE_MS / 1000}s) → unconfirmed, BUDGET INTACT ──`);
p = await seedPending("m-old", { state: "SENT", ageMs: CONFIRM_GRACE_MS + 5_000 });
await tick();
m = await readMandate("m-old");
check("FAILED_UNCONFIRMED with budget INTACT (never a phantom fill)", m?.lastOutcome === OUTCOME.FAILED_UNCONFIRMED && m?.spentAmount === 0 && LEDGER.agent.calls === 0, `outcome=${m?.lastOutcome} spent=${m?.spentAmount}`);
check("consecutiveUnconfirmed incremented, flagged for attention", m?.consecutiveUnconfirmed === 1 && m?.needsAttention === true, `consecutive=${m?.consecutiveUnconfirmed}`);

console.log(`\n── A1 · UNREADABLE (getTransaction throws) — "couldn't look" ≠ "didn't land" ──`);
p = await seedPending("m-unreadable-young", { throwMsg: "request limit reached", ageMs: 10_000 });
await tick();
m = await readMandate("m-unreadable-young");
check("young + unreadable → stays pending (a read failure never fails a fill)", m?.pendingPeriod === p && m?.spentAmount === 0 && m?.status === STATUS.ACTIVE, `pending=${m?.pendingPeriod} status=${m?.status}`);

p = await seedPending("m-unreadable-old", { throwMsg: "request limit reached", ageMs: MAX_PENDING_AGE_MS + 60_000 });
await tick();
m = await readMandate("m-unreadable-old");
check(`unreadable past ${MAX_PENDING_AGE_MS / 60000}m → escalates to unconfirmed, budget INTACT (never a false confirm)`, m?.lastOutcome === OUTCOME.FAILED_UNCONFIRMED && m?.spentAmount === 0 && m?.needsAttention === true && LEDGER.agent.calls === 0, `outcome=${m?.lastOutcome} spent=${m?.spentAmount}`);

console.log(`\n── A1 · ${MAX_CONSECUTIVE_UNCONFIRMED}th consecutive unconfirmed → STOPPED ──`);
p = await seedPending("m-strike3", { state: "SENT", ageMs: CONFIRM_GRACE_MS + 5_000, over: { consecutiveUnconfirmed: MAX_CONSECUTIVE_UNCONFIRMED - 1 } });
await tick();
m = await readMandate("m-strike3");
check(`stops at ${MAX_CONSECUTIVE_UNCONFIRMED} in a row, budget still intact`, m?.status === STATUS.STOPPED_FAILED && m?.spentAmount === 0, `status=${m?.status} consecutive=${m?.consecutiveUnconfirmed}`);

console.log(`\n── A1 · LEGACY claim (no circleId) drains cleanly ──`);
reset();
p = thisPeriod();
await seedMandate("m-legacy", { pendingPeriod: p });
await fillStore().setJSON(fillClaimKey("m-legacy", p), { mandateId: "m-legacy", period: p, status: "submitted", submittedAt: new Date().toISOString() }); // pre-refactor shape
await tick();
m = await readMandate("m-legacy");
check("legacy pointer dropped, no ledger, no crash", m?.pendingPeriod === null && LEDGER.agent.calls === 0 && LEDGER.dca.calls === 0, `pending=${m?.pendingPeriod} agent=${LEDGER.agent.calls}`);

console.log(`\n── A1 · burst: MAX_RECONCILES_PER_TICK = ${MAX_RECONCILES_PER_TICK} → the rest DEFER (not fail) ──`);
reset();
p = thisPeriod();
for (const id of ["b1", "b2", "b3"]) {
  await seedMandate(id, { pendingPeriod: p, lastFilledPeriod: p - 1 });
  await fillStore().setJSON(fillClaimKey(id, p), { mandateId: id, period: p, status: "submitted", circleId: `cid-${id}`, fillValueUsdc: 1.0, submittedAt: new Date().toISOString() });
  SCRIPT.set(`cid-${id}`, { state: "COMPLETE", txHash: `0x${id}` });
}
writes = {};
await tick();
const resolved = (await Promise.all(["b1", "b2", "b3"].map(readMandate))).filter((x) => x?.pendingPeriod === null).length;
check(`exactly ${MAX_RECONCILES_PER_TICK} reconciled this tick`, resolved === MAX_RECONCILES_PER_TICK && LEDGER.agent.calls === MAX_RECONCILES_PER_TICK, `resolved=${resolved} agentCalls=${LEDGER.agent.calls}`);
check("the deferred ones are still ACTIVE and pending — DEFERRED, not failed", (await Promise.all(["b1", "b2", "b3"].map(readMandate))).filter((x) => x?.pendingPeriod === p && x?.status === STATUS.ACTIVE).length === 3 - MAX_RECONCILES_PER_TICK, `still pending & active: ${(await Promise.all(["b1", "b2", "b3"].map(readMandate))).filter((x) => x?.pendingPeriod === p).length}`);
await tick(); await tick();
check("…and they drain over subsequent ticks (one per tick)", (await Promise.all(["b1", "b2", "b3"].map(readMandate))).every((x) => x?.pendingPeriod === null) && LEDGER.agent.calls === 3, `agentCalls=${LEDGER.agent.calls}`);

// ═══════════════ STATIC TRAP ═══════════════
console.log(`\n── TRAP (static): PATH 2 is gone for DCA, but survives for the job-verifier ──`);
const codeLines = (f) => readFileSync(new URL(`../../netlify/functions/${f}`, import.meta.url), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
const tickCalls = codeLines("dca-tick.mjs").filter((l) => /\bconfirmSwapLanded\s*\(|\bimport\b.*confirmSwapLanded/.test(l));
check("dca-tick.mjs neither imports nor calls confirmSwapLanded (comments excluded)", tickCalls.length === 0, tickCalls.length ? `found: ${tickCalls[0].trim().slice(0, 80)}` : "none");
let verifierKeeps = false;
try { verifierKeeps = codeLines("job-swap-receipt-background.mjs").some((l) => /confirmSwapLanded/.test(l)); } catch { verifierKeeps = false; }
check("_swap-confirm.mjs's OTHER consumer (job-swap-receipt-background) still uses it — not deleted out from under it", verifierKeeps, verifierKeeps ? "still referenced" : "NOT referenced — check whether the verifier moved or broke");

// ── META: the spies must have OBSERVED work. If they saw nothing, every "=== 0" assertion above passed
//    vacuously and the whole verdict is void (the failure mode that produced the first FAIL run). ──
console.log(`\n── INSTRUMENTATION META-CHECK ──`);
check("the ledger spies observed real calls this run (so the zero-assertions mean something)", TOTAL.agent > 0 && TOTAL.dca > 0, `total observed: agent=${TOTAL.agent} dca=${TOTAL.dca}`);

console.log(`\n════ VERDICT — STEP 5 PART A ════`);
if (fails === 0) {
  console.log(`✅ PART A PASS — the id-reconcile net holds:`);
  console.log(`   • a timed-out SWAP-wait (and only the swap-wait) enters the net carrying its circleId, ledgering NOTHING;`);
  console.log(`   • COMPLETE advances all three ledgers EXACTLY ONCE by call count, with the captured value (no re-price);`);
  console.log(`   • the XOR holds both ways — inline and reconcile never both count a period;`);
  console.log(`   • terminal failures stop without spending, an unreadable tx is never a false confirm, legacy claims drain,`);
  console.log(`     and a burst defers rather than failing. PATH 2 is gone for DCA.`);
  console.log(`   NOTE: proven against a SCRIPTED getTransaction. Part B (one real fill) validates that model against Circle.`);
} else {
  console.log(`❌ PART A FAIL — ${fails} assertion(s) above. Nothing was submitted (all Circle ids are fake), so no chain state changed.`);
}
console.log(`\n  (zero money, zero gas: no real transaction was ever created.)`);
process.exit(fails === 0 ? 0 : 1);
