// spike-step4a-deadline-guard.mjs — STEP 4, PART A: the PRE-SUBMIT DEADLINE GUARD.
//
// ═══ ZERO MONEY, ZERO GAS — AND STRUCTURALLY UNABLE TO SUBMIT ═══
// No real Circle client is ever constructed: `circle()` is replaced by a TRIPWIRE that RECORDS a
// submit attempt and THROWS. Part A therefore cannot broadcast anything even if a guard fails open.
// The only network traffic is the (free, read-only) createSwap QUOTE call.
//
// WHAT IT PROVES — link 4's front half: a quote that is expired AT SUBMIT TIME is refused by
// `_swap.mjs`'s DEADLINE_SAFETY_MS guard BEFORE any Circle transaction is created, and the throw
// short-circuits `_actions.mjs`'s `ledger()` so the day-ceiling never advances.
//
// MECHANISM — FAKE THE CLOCK, NEVER THE PAYLOAD.
// The deadline is covered by `transaction.signature`, so EDITING it would make the adapter revert on
// SIGNATURE verification — a revert for the wrong reason that reads as a pass. Instead we fetch a
// REAL, VALID, UNMODIFIED quote and skew `Date.now()` FORWARD past its deadline, so the guard sees
// exactly what it would see on a genuinely stale quote. node:test `mock.timers` with **apis:['Date']
// ONLY** — faking setTimeout would break `waitForTx`'s poll sleeps (_circle.mjs:53,59). Safe here
// because the skewed run throws at the guard and never reaches a timer.
//
// WHY THE ALLOWANCE READ IS STUBBED (the one deliberate deviation, and its cost):
// The SCA's allowance is ~0 (step-3 Part B consumed it), so step A of agentSwap (_swap.mjs:198-209)
// would fire a REAL approve — real gas, breaking "Part A costs nothing". We stub ONLY `publicClient()`
// so the allowance read returns a large value and the approve is skipped. It is a READ, not a money
// move, and it sits UPSTREAM of the guard under test — the guard, the quote, executeAction, the caps
// and the ledger are all real and untouched. Cost of the stub: Part A does NOT exercise the approve
// branch. Part B does (for real).
//
// ASSERTIONS
//   1. SKEWED: agentSwap throws "deadline too close", ZERO submit attempts, daySpend Δ0.
//   2. The quote it refused was GENUINELY VALID in real time (deadline still in the future) — so the
//      refusal is attributable to the skew alone, not to a stale quote we happened to fetch.
//   3. BASELINE CONTROL (real clock, same code path): the swap REACHES the submit boundary — the
//      tripwire records callData addressed to the adapter. Without this, "it threw" proves nothing:
//      a path broken anywhere upstream would also "pass" every reject assertion.
//   4. No approve was attempted (the stub worked) and the allowance read actually happened.
//
// RUN (mock.module + mock.timers need the flag; KIT_KEY is supplied per-run):
//   read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//     node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-step4a-deadline-guard.mjs

process.env.PERIOD_CEILING_USDC ||= "60"; // headroom so the day-ceiling isn't what blocks; mechanism, not the deployed number
import { mock } from "node:test";

// Captured BEFORE mock.timers replaces the global Date, so we can still read wall-clock time while skewed.
const realDateNow = Date.now;

const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b"; // _swap.mjs:17
const QUOTE_TTL_MS = 600_000;                 // measured in step-4 phase 0: deadline = now + 600s, ±0.2s
const SKEW_MS = QUOTE_TTL_MS + 60_000;        // 660s forward — past the deadline, with margin

if (!process.env.KIT_KEY) { console.error("Need KIT_KEY (prod env) — the guard runs on a REAL quote, so the quote call must succeed."); process.exit(2); }

// The skew shifts the clock 11 minutes forward. _budget.mjs keys its bucket by DATE, so a run started
// within ~11 min of UTC midnight could read/write a different day bucket and make the Δ0 assertion
// meaningless. Refuse rather than report a number we can't trust.
const minsToUtcMidnight = (24 * 60) - (new Date().getUTCHours() * 60 + new Date().getUTCMinutes());
if (minsToUtcMidnight <= 15) {
  console.error(`✖ ${minsToUtcMidnight} min to UTC midnight — the ${SKEW_MS / 60000}-min skew could straddle the day-bucket boundary and invalidate the daySpend assertion. Re-run later.`);
  process.exit(2);
}

// ── in-memory @netlify/blobs (pause + budget stores live only in this process) ──
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

// ── stub ONLY publicClient (allowance read) — see header. Every other _predict export is preserved. ──
const realPredict = await import("../../netlify/functions/_predict.mjs");
let allowanceReads = 0;
const stubPublicClient = {
  readContract: async ({ functionName }) => {
    if (functionName !== "allowance") throw new Error(`Part A stub: unexpected readContract "${functionName}" — the stub covers the allowance read ONLY`);
    allowanceReads++;
    return 10n ** 12n; // 1,000,000 USDC in 6-dp minor units — comfortably over any test amount
  },
  // Anything beyond the allowance read must fail LOUDLY, never silently return a plausible value.
  request: async () => { throw new Error("Part A stub publicClient: no RPC beyond the allowance read"); },
};
mock.module("../../netlify/functions/_predict.mjs", { namedExports: { ...realPredict, publicClient: () => stubPublicClient } });

// ── TRIPWIRE Circle client: records the attempt, submits NOTHING. waitForTx / TxPendingError stay REAL
//    (agentSwap does `e instanceof TxPendingError`, which breaks against a re-declared class). ──
const realCircleMod = await import("../../netlify/functions/_circle.mjs");
const submits = [];
class TripwireSubmit extends Error {
  constructor(kind) { super(`TRIPWIRE — Part A must never submit (attempted: ${kind})`); this.name = "TripwireSubmit"; }
}
const tripwireClient = {
  createContractExecutionTransaction: async (args) => {
    const kind = args?.callData ? "swap(callData)" : (args?.abiFunctionSignature || "unknown");
    submits.push({ kind, contractAddress: String(args?.contractAddress || "").toLowerCase(), hasCallData: !!args?.callData, at: realDateNow() });
    throw new TripwireSubmit(kind);
  },
  getTransaction: async () => { throw new TripwireSubmit("getTransaction"); },
};
mock.module("../../netlify/functions/_circle.mjs", { namedExports: { ...realCircleMod, circle: () => tripwireClient } });

// ── passive quote observer: records what createSwap actually returned (does NOT modify it). ──
const realFetch = globalThis.fetch;
const quotes = [];
globalThis.fetch = async (url, init) => {
  const res = await realFetch(url, init);
  if (String(url).includes("/stablecoinKits/swap") && res.ok) {
    try {
      const b = await res.clone().json(); // clone: agentSwap still gets an unread body
      const EP = (b?.data ?? b)?.transaction?.executionParams;
      if (EP) quotes.push({ deadlineSec: Number(EP.deadline), observedAtReal: realDateNow() });
    } catch { /* observation only — never break the real call */ }
  }
  return res;
};

// imports AFTER the mocks are registered
const { executeAction } = await import("../../netlify/functions/_actions.mjs");
const { daySpend } = await import("../../netlify/functions/_budget.mjs");
const { swapCapUsdc } = await import("../../netlify/functions/_arc.mjs");

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const swapStep = (amt) => ({ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: amt, reasoning: "step4A deadline guard test" });

console.log(`\n════ STEP 4 · PART A · pre-submit deadline guard · ZERO MONEY / ZERO GAS / CANNOT SUBMIT ════\n`);
console.log(`wallet ${WALLET}   ·   swapCapUsdc()=${swapCapUsdc()}   ·   forward skew ${SKEW_MS / 1000}s (quote TTL ${QUOTE_TTL_MS / 1000}s + 60s)\n`);

// ═══ RUN 1 — SKEWED CLOCK: a real, valid quote must be refused as expired ═══
const daySpendBefore = await daySpend({ owner: WALLET });
const skewTarget = realDateNow() + SKEW_MS;
mock.timers.enable({ apis: ["Date"] });   // Date ONLY — setTimeout stays real
mock.timers.setTime(skewTarget);
let threwSkew = null;
try { await executeAction(swapStep("1.00"), { walletAddress: WALLET, confirmSwap: true }); }
catch (e) { threwSkew = e; }
mock.timers.reset();                       // restore the real clock before anything else reads it
const daySpendAfterSkew = await daySpend({ owner: WALLET });

const q = quotes[0];
const quoteMarginMs = q ? q.deadlineSec * 1000 - q.observedAtReal : null;

console.log(`RUN 1 — clock skewed +${SKEW_MS / 1000}s:`);
check("agentSwap THREW the pre-submit deadline refusal", !!threwSkew && /deadline too close/i.test(threwSkew?.message || ""), threwSkew ? `"${threwSkew.message.split("\n")[0]}"` : "did not throw");
check("ZERO submit attempts — refused BEFORE any Circle transaction was created", submits.length === 0, `attempts=${submits.length ? submits.map((s) => s.kind).join(",") : "none"}`);
check("day-ceiling ledger did NOT advance (throw short-circuits ledger())", daySpendAfterSkew - daySpendBefore === 0, `daySpend ${daySpendBefore} → ${daySpendAfterSkew}`);
check("ATTRIBUTION: the refused quote was GENUINELY VALID in real time (only the skew made it look expired)", !!q && quoteMarginMs > 0, q ? `real margin was +${(quoteMarginMs / 1000).toFixed(1)}s at fetch` : "no quote observed");
check("the allowance stub was actually used (approve deliberately skipped, not accidentally)", allowanceReads >= 1, `allowance reads=${allowanceReads}`);

// ═══ RUN 2 — BASELINE CONTROL, real clock: the SAME path must reach the submit boundary ═══
console.log(`\nRUN 2 — BASELINE CONTROL (real clock, same code path):`);
const submitsBefore = submits.length;
const dayBefore2 = await daySpend({ owner: WALLET });
let threwBase = null;
try { await executeAction(swapStep("1.00"), { walletAddress: WALLET, confirmSwap: true }); }
catch (e) { threwBase = e; }
const dayAfter2 = await daySpend({ owner: WALLET });
const baseSubmit = submits[submitsBefore];

check("BASELINE reaches the SUBMIT boundary (guard passes on a fresh quote)", threwBase?.name === "TripwireSubmit" && !!baseSubmit, threwBase ? `stopped by: ${threwBase.name}` : "did not reach the tripwire");
check("…and what it tried to submit is swap calldata addressed to the ADAPTER", !!baseSubmit?.hasCallData && baseSubmit?.contractAddress === SWAP_ADAPTER, baseSubmit ? `to=${baseSubmit.contractAddress} callData=${baseSubmit.hasCallData}` : "n/a");
check("no APPROVE was attempted (allowance stub held for the baseline too)", !submits.some((s) => s.kind.startsWith("approve")), `attempts: ${submits.map((s) => s.kind).join(", ")}`);
check("BASELINE also left the ledger untouched (it never confirmed)", dayAfter2 - dayBefore2 === 0, `daySpend ${dayBefore2} → ${dayAfter2}`);

console.log(`\n════ VERDICT — PART A ════`);
if (fails === 0) {
  console.log(`✅ PART A PASS — an expired quote is refused BEFORE any Circle tx exists, the ledger stays put, and the`);
  console.log(`   control proves the path was otherwise live (it reached the adapter-addressed submit).`);
  console.log(`   NOTE: this proves the GUARD only. The on-chain backstop (does the adapter itself revert?) is Part B.`);
} else {
  console.log(`❌ PART A FAIL — ${fails} assertion(s) above. Nothing was submitted (the tripwire makes that impossible), so no chain state changed.`);
}
console.log(`   (no funds moved, no gas burned, no transaction submitted — the only network call was the free quote.)`);
process.exit(fails === 0 ? 0 : 1);
