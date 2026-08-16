// spike-design2a-standing-allowance.mjs — DESIGN-2 PROVE, PART A: the MANUAL-path approve AMOUNT.
//
// ═══ ZERO MONEY, ZERO GAS, STRUCTURALLY UNABLE TO SUBMIT ═══
// `circle()` is replaced by a TRIPWIRE that CAPTURES the approve's arguments and THROWS before any
// transaction is created. No real Circle client is ever constructed, so nothing can be broadcast even
// if a guard failed open. `publicClient()` is stubbed so the allowance reads 0 — a deterministic
// approve trigger, and the only Arc RPC call agentSwap makes.
//
// ═══ WHAT IT PROVES — the branch steps 2-5 never exercised ═══
// Every prior money-prove ran confirm:true (DCA, exact-amount). Design-2 changes the MANUAL
// (confirm:false) branch, which has never been run end-to-end. Four claims:
//   1. MANUAL  USDC→EURC 1.00  → approves capBase (25 USDC), NOT the exact 1.00
//   2. DCA     same swap        → approves EXACTLY 1.00  ← THE CONTROL
//   3. MANUAL  EURC→USDC 1.00  → approves cap/eurPrice (~21.5 EURC), NOT 25 EURC (~27 USD)
//   4. never max-uint, in any case
//
// ⚠️ CLAIM 2 IS THE LOAD-BEARING CONTROL. Without it, a hardcoded 25 passes claim 1 just as well as a
// correct `!confirm` branch does. The DCA case is what proves the gate actually BRANCHES — same
// discipline as step 3's BASELINE and step 4's attribution control.
//
// ═══ WHY NO QUOTE / NO BALANCE IS NEEDED ═══
// agentSwap's step (A) — allowance read → approve — runs BEFORE step (B) fetches the createSwap quote.
// The tripwire fires inside step (A), so the run never reaches the quote, the calldata build, or the
// submit. Nothing needs funding and no quote needs to be valid.
//
// ⚠️ HONEST LIMIT ON CLAIM 3: the eurPrice used to compute the EXPECTED value comes from the same
// valueInUsdc() the code under test uses. So claim 3 asserts the RELATION (capBase == cap ÷ price, and
// capBase × price ≤ the USD cap) — it does NOT independently verify the price itself. What it rules out
// is the failure that matters: treating 1 EURC as 1 USD and approving 25 EURC (~27 USD) — a 16% breach
// of the USD cap. An independent rate source would be a different test.
//
// RUN (mock.module needs the flag; KIT_KEY only for case 3's EURC pricing — cases 1/2 need no network):
//   read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//     node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-design2a-standing-allowance.mjs

process.env.PERIOD_CEILING_USDC ||= "60";
import { mock } from "node:test";

const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";
const MAX_UINT256 = (1n << 256n) - 1n;

// ── in-memory @netlify/blobs (pause + budget live only in this process) ──
let stores = {};
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

// ── stub ONLY publicClient: allowance reads 0, so the approve branch always fires. Anything else
//    must fail LOUDLY rather than silently return a plausible value. ──
const realPredict = await import("../../netlify/functions/_predict.mjs");
let allowanceReads = 0;
const stubPublicClient = {
  readContract: async ({ functionName }) => {
    if (functionName !== "allowance") throw new Error(`stub: unexpected readContract "${functionName}" — this stub covers the allowance read ONLY`);
    allowanceReads++;
    return 0n; // deterministic: 0 < amountBase, so step (A) always approves
  },
  request: async () => { throw new Error("stub publicClient: no RPC beyond the allowance read") },
};
mock.module("../../netlify/functions/_predict.mjs", { namedExports: { ...realPredict, publicClient: () => stubPublicClient } });

// ── TRIPWIRE circle(): capture the approve arguments, submit NOTHING. waitForTx / TxPendingError stay
//    REAL (agentSwap does `e instanceof TxPendingError`, which breaks against a re-declared class). ──
const realCircleMod = await import("../../netlify/functions/_circle.mjs");
const captured = [];
class Tripwire extends Error {
  constructor(kind) { super(`TRIPWIRE — Part A must never submit (attempted: ${kind})`); this.name = "Tripwire"; }
}
mock.module("../../netlify/functions/_circle.mjs", {
  namedExports: {
    ...realCircleMod,
    circle: () => ({
      createContractExecutionTransaction: async (args) => {
        captured.push({
          sig: args?.abiFunctionSignature ?? null,
          contractAddress: String(args?.contractAddress ?? "").toLowerCase(),
          spender: String(args?.abiParameters?.[0] ?? "").toLowerCase(),
          amountRaw: args?.abiParameters?.[1] ?? null,   // ← THE VALUE UNDER TEST
          hasCallData: !!args?.callData,
        });
        throw new Tripwire(args?.callData ? "swap(callData)" : args?.abiFunctionSignature ?? "unknown");
      },
      getTransaction: async () => { throw new Tripwire("getTransaction") },
    }),
  },
});

// imports AFTER the mocks
const { executeAction } = await import("../../netlify/functions/_actions.mjs");
const { swapCapUsdc, CONTRACTS, USDC_DECIMALS } = await import("../../netlify/functions/_arc.mjs");
const { valueInUsdc } = await import("../../netlify/functions/_swap.mjs");
const { daySpend } = await import("../../netlify/functions/_budget.mjs");

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const MINOR = 10 ** USDC_DECIMALS;
const human = (base) => (Number(base) / MINOR).toFixed(6);

// Drive ONE case through the real executeAction → real agentSwap → tripwire.
async function runCase({ tokenIn, tokenOut, amountIn, confirm }) {
  stores = {}; // isolate: fresh pause/budget state per case
  const before = captured.length;
  let threw = null;
  try {
    await executeAction(
      { type: "swap_tokens", tokenIn, tokenOut, amountIn, reasoning: "design-2 part A" },
      { walletAddress: WALLET, ...(confirm ? { confirmSwap: true } : {}) }
    );
  } catch (e) { threw = e; }
  return { rec: captured[before] ?? null, threw, daySpent: await daySpend({ owner: WALLET }) };
}

console.log(`\n════ DESIGN-2 · PART A · manual standing-allowance AMOUNT · ZERO MONEY / CANNOT SUBMIT ════\n`);
const cap = swapCapUsdc();
const capBaseUsdc = BigInt(Math.ceil(cap * MINOR));
console.log(`  swapCapUsdc() = ${cap} USDC  →  capBase(USDC) = ${capBaseUsdc}   ·   wallet ${WALLET}`);
if (cap !== 25) console.log(`  ⚠️ cap is ${cap}, not the 25 the deployed default resolves to — expectations below follow the HELPER, as they should.`);

// ═══ CASE 1 — MANUAL: the standing cap, not the exact amount ═══
console.log(`\n── CASE 1 · MANUAL (confirm:false) · USDC→EURC 1.00 ──`);
let c = await runCase({ tokenIn: "USDC", tokenOut: "EURC", amountIn: 1.0, confirm: false });
check("reached the APPROVE (tripwire captured it before any submit)", c.rec?.sig === "approve(address,uint256)", c.rec ? `sig=${c.rec.sig}` : "nothing captured");
check("approve targets tokenIn, spender = the adapter", c.rec?.contractAddress === CONTRACTS.USDC.toLowerCase() && c.rec?.spender === SWAP_ADAPTER, `to=${c.rec?.contractAddress} spender=${c.rec?.spender}`);
check(`approves capBase ${capBaseUsdc} (${human(capBaseUsdc)} USDC) — the STANDING cap`, BigInt(c.rec?.amountRaw ?? -1) === capBaseUsdc, `captured=${c.rec?.amountRaw}`);
check("…and NOT the exact amount 1000000 (the old behaviour)", BigInt(c.rec?.amountRaw ?? -1) !== BigInt(1 * MINOR), `captured=${c.rec?.amountRaw}`);
check("nothing was ledgered (the tripwire threw before ledger())", c.daySpent === 0, `daySpend=${c.daySpent}`);

// ═══ CASE 2 — DCA CONTROL: exact-amount, unchanged. THE PROOF THAT THE GATE BRANCHES. ═══
console.log(`\n── CASE 2 · DCA CONTROL (confirm:true) · USDC→EURC 1.00 ──`);
const c2 = await runCase({ tokenIn: "USDC", tokenOut: "EURC", amountIn: 1.0, confirm: true });
check(`approves EXACTLY 1000000 (1.000000 USDC) — DCA unchanged`, BigInt(c2.rec?.amountRaw ?? -1) === BigInt(1 * MINOR), `captured=${c2.rec?.amountRaw}`);
check("⭐ THE GATE BRANCHES: DCA ≠ MANUAL for the same swap (a hardcoded cap would fail here)", c2.rec?.amountRaw !== c.rec?.amountRaw, `dca=${c2.rec?.amountRaw} vs manual=${c.rec?.amountRaw}`);

// ═══ CASE 3 — MANUAL EURC: the cap is PRICED into tokenIn units ═══
console.log(`\n── CASE 3 · MANUAL (confirm:false) · EURC→USDC 1.00 (cap priced) ──`);
if (!process.env.KIT_KEY) {
  console.log(`   ⃠  SKIPPED — needs KIT_KEY (EURC pricing calls getTokenRates). Cases 1/2 need no network.`);
  fails++; // a skipped claim is not a passed claim
} else {
  const eurPrice = await valueInUsdc({ token: "EURC", amount: 1 });      // USD per 1 EURC
  const expected = BigInt(Math.ceil((cap / eurPrice) * MINOR));          // same formula as the code under test
  const c3 = await runCase({ tokenIn: "EURC", tokenOut: "USDC", amountIn: 1.0, confirm: false });
  const got = BigInt(c3.rec?.amountRaw ?? -1);
  console.log(`   eurPrice = ${eurPrice} USD/EURC   ·   expected capBase = ${expected} (${human(expected)} EURC)`);
  check("approve targets EURC (tokenIn), spender = the adapter", c3.rec?.contractAddress === CONTRACTS.EURC.toLowerCase() && c3.rec?.spender === SWAP_ADAPTER, `to=${c3.rec?.contractAddress}`);
  check(`approves the PRICED cap ${expected} (${human(expected)} EURC)`, got === expected, `captured=${got}`);
  check(`…and NOT ${capBaseUsdc} — treating 1 EURC as 1 USD would approve ${(Number(capBaseUsdc) / MINOR * eurPrice).toFixed(2)} USD, breaching the ${cap} cap`, got !== capBaseUsdc, `captured=${got}`);
  check(`the USD value of the allowance is ≤ the cap (+ceil dust)`, (Number(got) / MINOR) * eurPrice <= cap + 0.01, `${((Number(got) / MINOR) * eurPrice).toFixed(6)} USD vs cap ${cap}`);
  check("strictly fewer EURC units than USDC units (EUR is worth more than USD)", got < capBaseUsdc, `${got} < ${capBaseUsdc}`);
}

// ═══ CASE 4 — NEVER MAX-UINT, in any case ═══
console.log(`\n── CASE 4 · never max-uint (all captured approves) ──`);
const approves = captured.filter((r) => r.sig === "approve(address,uint256)");
check("no captured approve is max-uint256", approves.every((r) => BigInt(r.amountRaw) !== MAX_UINT256), `${approves.length} approve(s) checked`);
check("every captured approve is ≤ capBase(USDC) — nothing exceeds the cap in any token", approves.every((r) => BigInt(r.amountRaw) <= capBaseUsdc), approves.map((r) => r.amountRaw).join(", "));

// ── INSTRUMENTATION META-CHECK — a detached tripwire would make "nothing submitted" vacuous ──
console.log(`\n── INSTRUMENTATION ──`);
check("the tripwire actually fired (captures exist — otherwise every assertion above is vacuous)", approves.length >= 2, `${captured.length} capture(s), ${allowanceReads} allowance read(s)`);
check("NOTHING was ever submitted: no swap calldata reached the client", !captured.some((r) => r.hasCallData), `callData captures: ${captured.filter((r) => r.hasCallData).length}`);

console.log(`\n════ VERDICT — DESIGN-2 PART A ════`);
console.log(fails === 0
  ? `✅ PASS — the manual path approves the BOUNDED STANDING CAP, DCA still approves exact-amount (so the\n   !confirm gate genuinely branches), the EURC cap is PRICED to the USD bound, and no approve is max-uint.\n   NOTE: this proves the AMOUNT. That the approve LANDS and that later swaps SKIP it is Part B (on-chain).`
  : `❌ FAIL — ${fails} assertion(s) above. Nothing was submitted (the tripwire makes that impossible), so no chain state changed.`);
console.log(`\n  (zero money, zero gas: no Circle client was ever constructed.)`);
process.exit(fails === 0 ? 0 : 1);
