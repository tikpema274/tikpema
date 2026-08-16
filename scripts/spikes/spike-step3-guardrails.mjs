// spike-step3-guardrails.mjs — Re-prove STEP 3: the GUARDRAILS hold on the integrated
// executeAction(confirmSwap:true) path. Modeled on scripts/verify-pause-enforcement.mjs.
//
// TWO MODES (agentSwap is either a no-money tripwire OR the real money-mover — can't be both, so
// the --confirm flag switches which):
//
//   DEFAULT (ZERO MONEY) — PART A: guardrail LOGIC. @netlify/blobs is mocked in-memory and agentSwap
//     is a TRIPWIRE (records if reached, moves nothing). Proves the REJECT paths refuse BEFORE any
//     money-mover is touched:
//       • BASELINE control — in-cap, not-paused swap DOES reach agentSwap (so a test that rejects
//         everything can't masquerade as a pass).
//       • OVER-CAP — a swap above swapCapUsdc() is refused by the cap gate; agentSwap NOT reached.
//       • PAUSED — with the Executor paused, the swap is refused; agentSwap NOT reached.
//       • DAY-CEILING — with the day total at the ceiling, the swap is refused; agentSwap NOT reached.
//       • TRAP (static) — agentSwap has exactly ONE caller (executeAction); no path dodges the cap gate.
//
//   --confirm (ONE SMALL REAL SWAP) — PART B: ledger timing. ONLY @netlify/blobs is mocked (in-memory
//     budget/pause); agentSwap is REAL and moves ~1 USDC. Proves the day-ceiling ledger fires EXACTLY
//     ONCE, POST-CONFIRM (Drill #1): daySpend 0 → ~1 after one confirmed swap, never 2×, and only
//     reachable after the inline-confirmed agentSwap returned. On-chain movement witnessed by dd/rpc.
//
// SAFETY: PART A moves NOTHING (agentSwap mocked). PART B moves ~1 USDC on the throwaway SCA. The
// in-memory stores mean NO real pause/budget Blobs state is touched in either mode.
//
// RUN (mock.module needs the flag):
//   PART A (zero money):  node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-step3-guardrails.mjs
//   PART B (~1 USDC): read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//                     WALLET_ADDRESS=0x6fb28d… \
//                           node --experimental-test-module-mocks --env-file=.env scripts/spikes/spike-step3-guardrails.mjs --confirm

process.env.PERIOD_CEILING_USDC ||= "10"; // TEST ceiling (headroom for the 1-USDC ledger swap). Mechanism, not the deployed number.
import { mock } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const CONFIRM = process.argv.includes("--confirm");
const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const FN_DIR = new URL("../../netlify/functions/", import.meta.url);

// ── in-memory @netlify/blobs (both modes: pause + budget stores live only in this process) ──
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

// ── PART A only: money-movers → tripwires (prove reject-before-money) ──
let moved = [];
if (!CONFIRM) {
  const tripwire = (n) => async () => { moved.push(n); return { ok: true, kind: "swap_tokens", swap: { txHash: "0xMOCK" } }; };
  mock.module("../../netlify/functions/_swap.mjs", {
    namedExports: {
      SWAP_TOKENS: ["USDC", "EURC"],
      valueInUsdc: async ({ amount }) => Number(amount), // USDC 1:1 — deterministic cap math
      agentSwap: tripwire("agentSwap"),
      estimateSwapOnly: async () => ({ estimatedOutput: { amount: "1" } }),
    },
  });
}

// imports AFTER the mocks are registered
const { executeAction } = await import("../../netlify/functions/_actions.mjs");
const { setPaused } = await import("../../netlify/functions/_pause.mjs");
const { daySpend, recordAgentSpend } = await import("../../netlify/functions/_budget.mjs");
const { swapCapUsdc } = await import("../../netlify/functions/_arc.mjs");
const { AGENT } = await import("../../netlify/functions/_agents.mjs");

let fails = 0;
const check = (name, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); if (!cond) fails++; };
const swapStep = (amt) => ({ type: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC", amountIn: amt, reasoning: "step3 guardrail test" });

// Static: every agentSwap CALL site (not import, not comment, not its own definition in _swap.mjs).
function agentSwapCallers() {
  const hits = [];
  for (const f of readdirSync(FN_DIR)) {
    if (!f.endsWith(".mjs") || f === "_swap.mjs") continue;
    const lines = readFileSync(new URL(f, FN_DIR), "utf8").split("\n");
    if (lines.some((l) => /\bagentSwap\s*\(/.test(l) && !/^\s*(\/\/|\*|import\b)/.test(l) && !/^\s*import\b/.test(l.trim())))
      hits.push(f);
  }
  return hits;
}

if (!CONFIRM) {
  // ═══ PART A — GUARDRAIL LOGIC (ZERO MONEY; agentSwap is a tripwire) ═══
  console.log(`\n════ STEP 3 · PART A · guardrail logic · ZERO MONEY (agentSwap mocked) ════\n`);
  const cap = swapCapUsdc();
  console.log(`swapCapUsdc() = ${cap}  ·  PERIOD_CEILING_USDC(test) = ${process.env.PERIOD_CEILING_USDC}\n`);

  moved = [];
  let r = await executeAction(swapStep(1), { walletAddress: WALLET });
  check("BASELINE control: in-cap, not-paused swap REACHES agentSwap (guardrails don't block everything)", moved.includes("agentSwap") && r.ok === true, `reached=${moved.join(",") || "none"} ok=${r.ok}`);

  moved = [];
  r = await executeAction(swapStep(cap + 5), { walletAddress: WALLET });
  check(`OVER-CAP (${cap + 5} > ${cap}) REJECTED at the cap gate, agentSwap NOT reached`, r.ok === false && /exceeds per-swap/i.test(r.blocked || "") && !moved.includes("agentSwap"), `blocked="${r.blocked}" reached=${moved.join(",") || "none"}`);

  await setPaused({ owner: WALLET, agent: AGENT.EXECUTOR, paused: true });
  moved = [];
  r = await executeAction(swapStep(1), { walletAddress: WALLET });
  check("PAUSED executor SKIPS the swap (refused before signing), agentSwap NOT reached", r.ok === false && /paused/i.test(r.blocked || "") && !moved.includes("agentSwap"), `blocked="${r.blocked}" reached=${moved.join(",") || "none"}`);
  await setPaused({ owner: WALLET, agent: AGENT.EXECUTOR, paused: false });

  await recordAgentSpend({ owner: WALLET, amountUsdc: Number(process.env.PERIOD_CEILING_USDC), source: "step3-prefill" });
  moved = [];
  r = await executeAction(swapStep(1), { walletAddress: WALLET });
  check("DAY-CEILING at limit → swap blocked, agentSwap NOT reached", r.ok === false && !moved.includes("agentSwap"), `blocked="${r.blocked}" reached=${moved.join(",") || "none"}`);

  const callers = agentSwapCallers();
  check("SWAP-CAP TRAP: agentSwap has exactly ONE caller (_actions.mjs) — no path dodges the cap gate", callers.length === 1 && callers[0] === "_actions.mjs", `callers: ${callers.join(", ") || "none"}`);

  console.log(`\n════ VERDICT — PART A ════`);
  console.log(fails === 0 ? `✅ PART A PASS — every reject guardrail refuses BEFORE agentSwap; the cap gate is the only route in. Now run PART B (--confirm) for the ledger.` : `❌ PART A FAIL — ${fails} guardrail assertion(s) failed above.`);
  process.exit(fails === 0 ? 0 : 1);
} else {
  // ═══ PART B — LEDGER POST-CONFIRM (ONE REAL 1-USDC SWAP; agentSwap real, stores in-memory) ═══
  console.log(`\n════ STEP 3 · PART B · day-ceiling ledger post-confirm · ⚠️ ~1 USDC REAL SWAP ════\n`);
  if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET || !process.env.KIT_KEY) { console.error("PART B needs CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env) and KIT_KEY (prod env)."); process.exit(2); }

  // independent on-chain witness (dd/rpc), same as step 2
  const { rpcCall, assertChain } = await import("../dd/rpc.mjs");
  const { getChain } = await import("../dd/chains.mjs");
  const { CONTRACTS, USDC_DECIMALS, ARC } = await import("../../netlify/functions/_arc.mjs");
  const chain = getChain("arc-testnet");
  const rpc = (m, p) => rpcCall({ endpoint: chain.rpc, method: m, params: p }).then((r) => r.result);
  const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const bal = async (t) => Number(BigInt(await rpc("eth_call", [{ to: t, data: "0x70a08231" + pad(WALLET) }, "latest"]))) / 10 ** USDC_DECIMALS;
  await assertChain(chain);

  const daySpendBefore = await daySpend({ owner: WALLET });
  const usdcB = await bal(CONTRACTS.USDC), eurcB = await bal(CONTRACTS.EURC);
  console.log(`  before: daySpend ledger = ${daySpendBefore}   ·   USDC ${usdcB.toFixed(6)}   EURC ${eurcB.toFixed(6)}\n`);

  let r, threw = null;
  try { r = await executeAction(swapStep("1.00"), { walletAddress: WALLET, confirmSwap: true }); } // ← REAL money, inline-confirm
  catch (e) { threw = e; }

  const daySpendAfter = await daySpend({ owner: WALLET });
  const usdcA = await bal(CONTRACTS.USDC), eurcA = await bal(CONTRACTS.EURC);
  const ledgerDelta = Number((daySpendAfter - daySpendBefore).toFixed(6));
  const usdcDrop = Number((usdcB - usdcA).toFixed(6)), eurcGain = Number((eurcA - eurcB).toFixed(6));

  check("executeAction returned ok (swap confirmed inline, no throw)", !threw && r?.ok === true, threw ? `threw: ${threw.message.split("\n")[0]}` : `blocked="${r?.blocked}"`);
  // on-chain witness that a swap actually happened (independent of the SDK)
  check("on-chain: USDC left + EURC arrived (dd/rpc witness)", usdcDrop >= 0.95 && eurcGain > 0, `USDC −${usdcDrop} · EURC +${eurcGain}`);
  // THE LEDGER PROPERTY: fired exactly once, post-confirm, value == the swap's USD value (~1), never 2×
  check("day-ceiling ledger fired EXACTLY ONCE post-confirm (daySpend +~1.0)", Math.abs(ledgerDelta - 1) < 0.02, `ledger ${daySpendBefore} → ${daySpendAfter} (Δ${ledgerDelta})`);
  check("ledger NOT double-counted (Δ ≈ 1×, not 2×)", ledgerDelta < 1.5, `Δ${ledgerDelta}`);
  check("post-confirm: ledger is only reachable after the inline-confirmed agentSwap returned (recordAgentSpend runs after agentSwap in the swap branch)", !threw && r?.ok === true && ledgerDelta > 0, `structural + observed: ok=${r?.ok} Δ=${ledgerDelta}`);

  if (r?.swap?.circleId) console.log(`\n  → circleId ${r.swap.circleId}`);
  if (r?.swap?.txHash) console.log(`  → swap tx  ${ARC.explorer}/tx/${r.swap.txHash}`);

  console.log(`\n════ VERDICT — PART B ════`);
  console.log(fails === 0 ? `✅ PART B PASS — one confirmed swap; the day-ceiling ledger fired exactly once, post-confirm, value-correct. Step 3 complete → step 4 (deadline-revert).` : `❌ PART B FAIL — ${fails} assertion(s) failed. Inspect the ❌ lines; the swap MAY have moved (check the tx) — re-read the chain before re-running.`);
  process.exit(fails === 0 ? 0 : 1);
}
