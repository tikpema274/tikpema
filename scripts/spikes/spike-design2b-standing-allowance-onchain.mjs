// spike-design2b-standing-allowance-onchain.mjs — DESIGN-2 PROVE, PART B: approve-ONCE-then-SKIP, on-chain.
//
// ═══ ⚠️ MOVES ~3 USDC (swapped to EURC, which you keep) + gas. Requires --confirm. ═══
// Part A proved the approve AMOUNT with a tripwire. This proves the thing a mock cannot: that the
// approve LANDS setting a standing allowance, and that SUBSEQUENT swaps SKIP it — the entire win of
// Design-2 over exact-amount (which would fire an approve on every single swap).
//
// ═══ ⭐ THE STAR WITNESS IS THE ALLOWANCE TRACE ═══
//     start 0.000000
//     swap 1 → approve fires, sets 25.000000, swap consumes 1 → 24.000000
//     swap 2 → NO approve                                     → 23.000000
//     swap 3 → NO approve                                     → 22.000000
// A monotonic decrement of exactly amountBase per swap that NEVER resets to 25 proves BOTH halves at
// once: the standing allowance is real and is being consumed, AND no re-approve fired. A stray approve
// is impossible to hide — it shows up as a jump back to 25.
//
// ═══ THE 25 IS DIRECTLY OBSERVABLE (not merely inferred) ═══
// The manual path returns at SUBMIT, so when executeAction returns on swap 1 the APPROVE has already
// landed (agentSwap awaits it) while the SWAP is still pending. Reading the allowance at that instant
// shows the untouched standing bound: 25.000000. Arc mines in ~2-3s, so the swap can occasionally land
// first — the runner reports which reading it got and falls back to the inferred check (after + spent),
// rather than asserting a number it did not observe.
//
// ═══ WHY THE SPIKE POLLS ═══
// Manual is submit-and-return by design. The spike therefore waits for each swap to reach COMPLETE
// (waitForTx, spike-side) BEFORE reading the next allowance — otherwise it samples mid-flight and the
// whole trace is garbage. The waiting lives HERE, never in the product path.
//
// SAFETY / SCOPE
//   • @netlify/blobs is in-memory → NO production budget, pause or mandate state is touched.
//   • Everything else is REAL: real quote, real approve, real swaps, real Circle ids, real chain.
//   • dd/rpc reads are throttle-hardened (rpcCall retries); a "request limit reached" must never be
//     reported as a finding (step-4 lesson).
//   • PRECONDITION: allowance MUST be exactly 0 — claim 1 (the 0→25 transition) is unobservable on a
//     pre-approved wallet, so the runner REFUSES rather than reporting a weaker result as a pass.
//   • RESIDUE: ~22 USDC of standing allowance remains afterwards. That is the INTENDED new posture,
//     not a leak — but re-running needs `--reset` (an approve(0) tx, costs gas) to restore allowance 0.
//
// RUN:
//   dry run:  node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-design2b-standing-allowance-onchain.mjs
//   for real: KIT_KEY="$(netlify env:get KIT_KEY --context production)" \
//               node --experimental-test-module-mocks --env-file=.env \
//                 scripts/spikes/spike-design2b-standing-allowance-onchain.mjs --confirm
//   re-run:   … --reset --confirm     (zeroes the allowance first, then runs)

process.env.PERIOD_CEILING_USDC ||= "60";
import { mock } from "node:test";

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const CONFIRM = process.argv.includes("--confirm");
const RESET = process.argv.includes("--reset");
const SWAPS = Number(arg("swaps", "3"));
const AMOUNT = Number(arg("amount", "1.00"));
const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";
const MAX_UINT256 = (1n << 256n) - 1n;

if (!CONFIRM) {
  console.log(`\n⚠️  DRY RUN — nothing submitted, nothing moved.\n`);
  console.log(`  plan: ${SWAPS} sequential MANUAL (confirm:false) swaps of ${AMOUNT} USDC→EURC on ${WALLET}`);
  console.log(`        swap 1 → approve fires (sets the standing cap) → swap consumes ${AMOUNT}`);
  console.log(`        swaps 2..${SWAPS} → NO approve; each just consumes ${AMOUNT} from the standing allowance`);
  console.log(`  ⭐ witness: the allowance trace 0 → 25 → ${25 - AMOUNT} → ${25 - 2 * AMOUNT} → ${25 - 3 * AMOUNT}, never resetting`);
  console.log(`  asserts:  approve count across ${SWAPS} swaps == 1 (exact-amount would fire ${SWAPS}) · allowance == cap exactly, never max-uint`);
  console.log(`            · USDC−${AMOUNT}/EURC+ per swap (dd/rpc) · audit entries carry confirmation:"submitted"`);
  console.log(`  cost: ~${(SWAPS * AMOUNT).toFixed(2)} USDC converted to EURC (you keep it) + gas. NO production Blobs state touched.`);
  console.log(`  precondition: allowance MUST be 0 (refuses otherwise; use --reset to zero it first).\n`);
  process.exit(0);
}
if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET || !process.env.KIT_KEY) {
  console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env) and KIT_KEY (prod env).");
  process.exit(2);
}

// ── in-memory @netlify/blobs — the ONLY mock. No production budget/pause state is read or written. ──
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
    async setIfNew(k, v) { if (m.has(k)) return false; m.set(k, { value: v, etag: `e${++etagSeq}` }); return true; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { data: e.value, etag: e.etag } : null; },
    async list(opts) { const p = typeof opts === "string" ? opts : opts?.prefix ?? ""; return { blobs: [...m.keys()].filter((x) => x.startsWith(p)).map((key) => ({ key })) }; },
  };
};
mock.module("@netlify/blobs", { namedExports: { connectLambda: () => {}, getStore: memStore } });
// Read audit entries straight out of the in-memory stores — independent of _budget's list() shape.
const auditEntries = () => Object.values(stores).flatMap((m) => [...m.entries()].filter(([k]) => k.startsWith("audit:")).map(([, v]) => v.value));

// imports AFTER the mock. NOTHING else is mocked — real quote, real approve, real swap, real chain.
const { executeAction } = await import("../../netlify/functions/_actions.mjs");
const { circle, waitForTx } = await import("../../netlify/functions/_circle.mjs");
const { swapCapUsdc, CONTRACTS, USDC_DECIMALS, ARC } = await import("../../netlify/functions/_arc.mjs");
const { daySpend } = await import("../../netlify/functions/_budget.mjs");
const { rpcCall, assertChain } = await import("../dd/rpc.mjs");
const { getChain } = await import("../dd/chains.mjs");

const chain = getChain("arc-testnet");
const rpc = (m, p) => rpcCall({ endpoint: chain.rpc, method: m, params: p }).then((r) => r.result); // retrying
const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const MINOR = 10 ** USDC_DECIMALS;
const allowanceRaw = async () => BigInt(await rpc("eth_call", [{ to: CONTRACTS.USDC, data: "0xdd62ed3e" + pad(WALLET) + pad(SWAP_ADAPTER) }, "latest"]));
const allowanceNow = async () => Number(await allowanceRaw()) / MINOR;
const tokenBal = async (t) => Number(BigInt(await rpc("eth_call", [{ to: t, data: "0x70a08231" + pad(WALLET) }, "latest"]))) / MINOR;

let fails = 0, stops = [];
const check = (name, cond, detail = "") => { console.log(`   ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const STOP = (m) => { stops.push(m); console.log(`   🛑 ${m}`); };
const f6 = (n) => Number(n).toFixed(6);

console.log(`\n════ DESIGN-2 · PART B · approve-once-then-SKIP, ON-CHAIN · ⚠️ ~${(SWAPS * AMOUNT).toFixed(2)} USDC ════\n`);
await assertChain(chain); // never read state from an endpoint unproven to be Arc testnet

const cap = swapCapUsdc();
const capBase = BigInt(Math.ceil(cap * MINOR));
const amountBase = BigInt(Math.round(AMOUNT * MINOR));

// ── PRECONDITION: allowance must be exactly 0 ──
if (RESET) {
  const cur = await allowanceRaw();
  if (cur === 0n) console.log(`  --reset: allowance already 0, nothing to do`);
  else {
    console.log(`  --reset: zeroing a standing allowance of ${f6(Number(cur) / MINOR)} USDC (costs gas)…`);
    const c = circle();
    const rv = await c.createContractExecutionTransaction({
      walletAddress: WALLET, blockchain: ARC.blockchain, contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "approve(address,uint256)", abiParameters: [SWAP_ADAPTER, "0"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    await waitForTx(c, rv.data?.id);
    console.log(`  --reset: done, allowance now ${f6(await allowanceNow())}`);
  }
}
const startAllowance = await allowanceRaw();
if (startAllowance !== 0n) {
  console.error(`\n✖ PRECONDITION FAILED — allowance is ${f6(Number(startAllowance) / MINOR)} USDC, not 0.`);
  console.error(`  Claim 1 (the 0 → ${cap} transition) is UNOBSERVABLE on a pre-approved wallet, and reporting the`);
  console.error(`  weaker remainder as a pass would be dishonest. Re-run with --reset to zero it first.`);
  process.exit(2);
}

const usdc0 = await tokenBal(CONTRACTS.USDC), eurc0 = await tokenBal(CONTRACTS.EURC);
console.log(`  cap ${cap} USDC (capBase ${capBase})  ·  amount ${AMOUNT} (amountBase ${amountBase})`);
console.log(`  before: allowance 0.000000   USDC ${f6(usdc0)}   EURC ${f6(eurc0)}   daySpend ${await daySpend({ owner: WALLET })}\n`);
if (usdc0 < SWAPS * AMOUNT + 0.5) { console.error(`✖ wallet holds ${f6(usdc0)} USDC — not enough for ${SWAPS}×${AMOUNT} + gas.`); process.exit(2); }

// ── THE RUN ────────────────────────────────────────────────────────────────────────────────
const trace = [];
for (let i = 1; i <= SWAPS; i++) {
  console.log(`── SWAP ${i}/${SWAPS} (manual, confirm:false) ──`);
  const before = await allowanceRaw();
  let res, threw = null;
  try {
    res = await executeAction(
      { type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: AMOUNT, reasoning: `design-2 part B swap ${i}` },
      { walletAddress: WALLET } // NO confirmSwap → MANUAL path
    );
  } catch (e) { threw = e; }
  if (threw || !res?.ok) { STOP(`swap ${i} did not submit: ${threw?.message ?? res?.blocked}`); break; }

  const swap = res.swap;
  // Read the allowance NOW: the approve has landed (agentSwap awaits it) but the swap is still
  // pending, so on swap 1 this is the untouched standing bound. Racy by ~2-3s — reported, not asserted.
  const midRaw = await allowanceRaw();
  console.log(`   circleId ${swap.circleId}   approveId ${swap.approveId ?? "none (SKIPPED)"}   state ${swap.state}`);
  console.log(`   allowance mid-flight (post-approve, pre-swap-confirm): ${f6(Number(midRaw) / MINOR)}`);

  // Spike-side wait — the product path deliberately does NOT do this.
  let confirmErr = null;
  try { await waitForTx(circle(), swap.circleId); } catch (e) { confirmErr = e; }
  if (confirmErr) { STOP(`swap ${i} never confirmed (${confirmErr.name}: ${confirmErr.message}) — the trace below is incomplete`); }

  const after = await allowanceRaw();
  trace.push({ i, before, mid: midRaw, after, approveId: swap.approveId ?? null, state: swap.state, circleId: swap.circleId });
  console.log(`   allowance ${f6(Number(before) / MINOR)} → ${f6(Number(after) / MINOR)}   (Δ ${f6(Number(before - after) / MINOR)})\n`);
  if (confirmErr) break;
}

const usdc1 = await tokenBal(CONTRACTS.USDC), eurc1 = await tokenBal(CONTRACTS.EURC);
const endAllowance = await allowanceRaw();

// ── ASSERTIONS ─────────────────────────────────────────────────────────────────────────────
console.log(`════ ASSERTIONS ════`);
console.log(`  trace: 0.000000 → ${trace.map((t) => f6(Number(t.after) / MINOR)).join(" → ")}\n`);

const t1 = trace[0];
// CLAIM 1 — the approve fired and set the standing cap.
check("SWAP 1 fired an approve (the product reports an approveId)", !!t1?.approveId, `approveId=${t1?.approveId ?? "none"}`);
if (t1 && t1.mid === capBase) {
  check(`SWAP 1 · standing allowance OBSERVED at exactly capBase ${capBase} (${f6(cap)} USDC)`, true, "read mid-flight, before the swap consumed it");
} else if (t1) {
  // The swap landed before the mid-flight read — fall back to the inferred value, and SAY SO.
  const inferred = t1.after + amountBase;
  check(`SWAP 1 · standing allowance == capBase (INFERRED: after ${t1.after} + consumed ${amountBase})`, inferred === capBase,
    `mid-flight read was ${t1.mid} (swap had already landed) → inferred ${inferred} vs capBase ${capBase}`);
}
check("SWAP 1 · allowance after = capBase − amountBase (the swap consumed exactly its amount)", t1 && t1.after === capBase - amountBase, `after=${t1?.after} expected=${capBase - amountBase}`);
check("SWAP 1 · NOT the exact-amount behaviour (allowance would be ~0 after, not ~24)", t1 && t1.after > 0n, `after=${f6(Number(t1?.after ?? 0) / MINOR)}`);
if (t1 && t1.after === 0n) STOP(`allowance is 0 after swap 1 — the approve was exact-amount, so the !confirm gate did NOT branch. Design-2 delivers nothing.`);

// ⭐ CLAIM 2 — the skip. This is the whole win.
const later = trace.slice(1);
check(`SWAPS 2..${SWAPS} SKIPPED the approve (no approveId on any of them)`, later.length > 0 && later.every((t) => t.approveId === null), later.map((t) => `#${t.i}:${t.approveId ?? "skip"}`).join(" "));
check("⭐ approve count across all swaps is EXACTLY 1 (exact-amount would fire one per swap)", trace.filter((t) => t.approveId).length === 1, `${trace.filter((t) => t.approveId).length} approve(s) in ${trace.length} swap(s)`);
if (later.some((t) => t.approveId)) STOP(`an approve fired on a later swap — the skip logic is broken and Design-2 delivers no reduction in approves.`);

// ⭐ CLAIM 3 — the trace: monotonic, exact, never reset.
const monotonic = trace.every((t, idx) => idx === 0 || t.after < trace[idx - 1].after);
const exactSteps = later.every((t) => t.before - t.after === amountBase);
check("⭐ allowance decrements by EXACTLY amountBase on every skipping swap", exactSteps, later.map((t) => `#${t.i}:−${f6(Number(t.before - t.after) / MINOR)}`).join(" "));
check("⭐ allowance NEVER resets upward (a stray re-approve would jump it back to capBase)", monotonic && !later.some((t) => t.after >= capBase), `trace ${trace.map((t) => t.after).join(" → ")}`);

// CLAIM 4 — the bound.
check("allowance never exceeded capBase", trace.every((t) => t.mid <= capBase && t.after <= capBase), `max observed ${trace.reduce((a, t) => (t.mid > a ? t.mid : a), 0n)}`);
check("allowance is NEVER max-uint256", trace.every((t) => t.mid !== MAX_UINT256 && t.after !== MAX_UINT256), "checked mid + after on every swap");
if (trace.some((t) => t.mid > capBase || t.after > capBase)) STOP(`allowance exceeded the cap — CAP-SAFETY VIOLATED. Do not ship.`);

// On-chain money witness (dd/rpc, independent of the SDK).
const usdcDrop = Number((usdc0 - usdc1).toFixed(6)), eurcGain = Number((eurc1 - eurc0).toFixed(6));
check(`on-chain: USDC fell by ≈${(trace.length * AMOUNT).toFixed(2)} + gas, EURC arrived`, usdcDrop >= trace.length * AMOUNT && eurcGain > 0, `USDC −${usdcDrop} · EURC +${eurcGain}`);

// The manual path ledgers at SUBMIT — and (new) says so in the audit. Verifies the audit-honesty fix.
const entries = auditEntries().filter((e) => e.source === "swap_tokens");
check(`day-ceiling ledgered once per swap (manual ledgers at submit)`, (await daySpend({ owner: WALLET })) === trace.length * AMOUNT, `daySpend=${await daySpend({ owner: WALLET })} for ${trace.length} swap(s)`);
check(`AUDIT HONESTY: every manual entry records confirmation:"submitted"`, entries.length === trace.length && entries.every((e) => e.confirmation === "submitted"), `${entries.length} entr(ies): ${entries.map((e) => e.confirmation ?? "MISSING").join(", ")}`);
check(`…and allowed stays true (authorized + counted — not a claim about the chain)`, entries.every((e) => e.allowed === true), `allowed: ${entries.map((e) => e.allowed).join(", ")}`);

// ── VERDICT ────────────────────────────────────────────────────────────────────────────────
console.log(`\n════ VERDICT — DESIGN-2 PART B ════`);
if (fails === 0 && stops.length === 0) {
  console.log(`✅ PASS — approve ONCE, then SKIP, witnessed on-chain:`);
  console.log(`   • swap 1 set a standing allowance of exactly ${f6(cap)} USDC (never max-uint, never over cap);`);
  console.log(`   • swaps 2..${SWAPS} fired NO approve — ${trace.filter((t) => t.approveId).length} approve across ${trace.length} swaps (exact-amount would have fired ${trace.length});`);
  console.log(`   • the allowance decremented by exactly ${AMOUNT} per swap and never reset — so the standing`);
  console.log(`     allowance is real, is being consumed, and nothing re-approved behind our back.`);
  console.log(`   Residue: ${f6(Number(endAllowance) / MINOR)} USDC of standing allowance remains — the INTENDED posture. Use --reset to re-run.`);
} else {
  console.log(`❌ ${stops.length ? "STOP" : "FAIL"} — ${fails} failed assertion(s), ${stops.length} stop condition(s).`);
  stops.forEach((s) => console.log(`   🛑 ${s}`));
  console.log(`   Allowance now ${f6(Number(endAllowance) / MINOR)} USDC. Re-read the chain before re-running.`);
}
console.log(`\n  (every number above was read back from the chain or the in-memory ledger after the fact — never asserted from the --confirm flag.)`);
process.exit(fails === 0 && stops.length === 0 ? 0 : 1);
