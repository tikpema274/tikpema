// spike-sync-budget.mjs — READ-ONLY. Re-prove STEP 1: sync-timeout budget check for the manual swap path.
//
// QUESTION: can a SYNCHRONOUS HTTP handler (agent-act / agent-execute-plan / job-swap-approve) absorb the
// NEW agentSwap's blocking cost in confirm:false mode, under Netlify's sync-function ceiling?
//
// CEILING = 10_000 ms — Netlify's default synchronous Functions execution limit. NOT overridden in
// netlify.toml ([functions] sets only node_bundler; job-sweep/dca-tick entries are schedules). _circle.mjs
// is explicitly tuned against "Netlify's 10s sync-function ceiling". Background funcs (15min) & scheduled
// funcs (dca-tick) do NOT apply here — this is about the MANUAL, user-facing swap handlers.
//
// WHAT A MANUAL (confirm:false) SWAP BLOCKS ON (agentSwap, in order):
//   (A) allowance read                      [read-only]         ─┐
//       approve + waitForTx COMPLETE        [ONLY if allowance < amountIn — FIRST swap per wallet]
//   (B) createSwap HTTP quote               [read-only]          ├─ measured here (no submit)
//       viem getCallData                    [read-only, pure]   ─┘
//   (C) submit swap (createContractExecutionTransaction) → returns circleId, NO wait   [confirm:false skips the swap-wait]
// So confirm:false NEVER pays the swap-confirm wait. The only heavy, VARIABLE cost is the first-swap approve-wait.
//
// THIS SCRIPT measures the read-only overhead O_fixed = (A-read) + (B-quote) + (B-getCallData) on the
// APPROVED SCA (allowance already set → no approve fires → cleanly isolates the non-approve overhead), and
// MODELS the approve-wait A_approve from _circle.mjs's own constants (best-effort: also reads a historical
// tx's confirm latency if the SDK exposes it). It does NOT submit an approve or a swap — nothing moves, no gas.
//
// PASS/FAIL (see the VERDICT the script prints):
//   PASS (keep manual swap inline): subsequent-swap total (O_fixed + submit-call + handler pricing) is
//     COMFORTABLY < 10s, AND first-swap TYPICAL total (+ A_approve ~2–3s) leaves margin (< ~7s), with the
//     rare THROTTLE tail (A_approve → up to the 60s waitForTx deadline, first-swap-only, retryable,
//     self-healing since the allowance persists) judged acceptable.
//   FAIL (reshape the manual path): first-swap TYPICAL already near/over 10s, OR the throttle tail is
//     unacceptable → move the manual approve OFF the sync path (a one-time "arm wallet" approve job, or
//     pre-approve at wallet provisioning), leaving the sync swap = quote + getCallData + submit only.
//
// RUN (read-only; same env as spike-B1): KIT_KEY passed VERBATIM, supplied per-run.
//   read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//     WALLET_ADDRESS=0x6fb28d6366e755e0e27307692282490c6682fc58 \
//     node --env-file=.env scripts/spikes/spike-sync-budget.mjs

import { createViemAdapterFromProvider, resolveChainIdentifier } from "@circle-fin/adapter-viem-v2";
import { CONTRACTS, ARC, USDC_DECIMALS } from "../../netlify/functions/_arc.mjs";
import { publicClient } from "../../netlify/functions/_predict.mjs";
import { circle } from "../../netlify/functions/_circle.mjs";
import { valueInUsdc } from "../../netlify/functions/_swap.mjs";

import { requireKitKey } from "../_kit-key.mjs";
const KIT_KEY = requireKitKey();
const WALLET = (process.env.WALLET_ADDRESS || "").toLowerCase();
const SWAP_ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";
const SWAP_URL = "https://api.circle.com/v1/stablecoinKits/swap";
const AMOUNT_BASE = "1000000"; // 1 USDC
const CEILING_MS = 10_000; // Netlify sync Functions default (not overridden)
// _circle.mjs waitForTx model — the approve-wait A_approve:
const FIRST_WAIT_MS = 1500, POLL_MS = 400, DEADLINE_MS = 60_000;
const ALLOWANCE_ABI = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] }];
const now = () => globalThis.performance.now();
const ms = (x) => `${x.toFixed(0)} ms`;
const log = (s = "") => console.log(s);
const ok = (s) => log(`  ✅ ${s}`);
const no = (s) => log(`  ⚠️  ${s}`);
const info = (s) => log(`  ·  ${s}`);

if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) { console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env). KIT_KEY is supplied per-run — see scripts/_kit-key.mjs (never from the production Netlify env)."); process.exit(2); }
if (!/^0x[0-9a-fA-F]{40}$/.test(WALLET)) { console.error("Set WALLET_ADDRESS=0x… (the approved SCA with allowance to the adapter)."); process.exit(2); }
if (!/^KIT_KEY:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/.test(KIT_KEY)) { console.error(`KIT_KEY must be the verbatim KIT_KEY:<id>:<secret> (do not strip the prefix).`); process.exit(2); }

const amountBase = BigInt(AMOUNT_BASE);
log(`\n════ RE-PROVE STEP 1 · sync-budget check · READ-ONLY (no submit, no gas, no money) ════`);
log(`wallet ${WALLET.slice(0, 10)}… · ceiling ${CEILING_MS} ms (Netlify sync default) · confirm:false path (no swap-wait)\n`);

// ── (A-read) allowance read — step A's read (the approve DECISION input). ────────────────────────
log("Measure O_fixed — the read-only overhead every manual swap pays (no approve fires: allowance is set)");
let tA;
{
  const t = now();
  const allowance = await publicClient().readContract({ address: CONTRACTS.USDC, abi: ALLOWANCE_ABI, functionName: "allowance", args: [WALLET, SWAP_ADAPTER] });
  tA = now() - t;
  info(`(A) allowance read: ${ms(tA)}   [allowance=${allowance} — ${allowance >= amountBase ? "≥ amount → approve SKIPPED (isolation holds)" : "< amount → this wallet WOULD approve; measurement NOT isolated ⚠️"}]`);
  if (allowance < amountBase) no("pick a wallet whose allowance ≥ 1 USDC to the adapter, or O_fixed is contaminated by an approve");
}

// ── (B-quote) createSwap HTTP quote. ─────────────────────────────────────────────────────────────
let tB1, q;
{
  const t = now();
  const res = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KIT_KEY}` },
    body: JSON.stringify({ tokenInAddress: CONTRACTS.USDC, tokenOutAddress: CONTRACTS.EURC, tokenInChain: "Arc_Testnet", fromAddress: WALLET, toAddress: WALLET, amount: AMOUNT_BASE }),
  });
  const body = await res.json().catch(() => null);
  tB1 = now() - t;
  if (!res.ok) { no(`createSwap HTTP ${res.status} — cannot measure quote+getCallData; check auth/env`); process.exit(1); }
  q = body?.data ?? body;
  info(`(B) createSwap quote: ${ms(tB1)}`);
}

// ── (B-getCallData) viem-adapter getCallData (pure encoding — the B1 extraction cost). ───────────
let tB2;
{
  const t = now();
  const T = q.transaction, EP = T.executionParams;
  const executeParams = {
    instructions: EP.instructions.map((i) => ({ target: i.target, data: i.data, value: BigInt(i.value), tokenIn: i.tokenIn, amountToApprove: BigInt(i.amountToApprove), tokenOut: i.tokenOut, minTokenOut: BigInt(i.minTokenOut) })),
    tokens: EP.tokens.map((t2) => ({ token: t2.token, beneficiary: t2.beneficiary })),
    execId: BigInt(EP.execId), deadline: BigInt(EP.deadline), metadata: EP.metadata,
  };
  const tokenInputs = [{ permitType: 0, token: CONTRACTS.USDC, amount: amountBase, permitCalldata: "0x" }];
  const adapter = await createViemAdapterFromProvider({
    provider: { request: async () => { throw new Error("read-only"); } },
    getPublicClient: () => publicClient(),
    capabilities: { addressContext: "developer-controlled" },
  });
  const prepared = await adapter.prepareAction("swap.execute", { executeParams, tokenInputs, signature: T.signature, inputAmount: amountBase, tokenInAddress: CONTRACTS.USDC }, { chain: resolveChainIdentifier("Arc_Testnet"), address: WALLET });
  const cd = prepared.getCallData();
  tB2 = now() - t;
  const match = cd && cd.to.toLowerCase() === SWAP_ADAPTER;
  info(`(B) getCallData: ${ms(tB2)}   [to==adapter: ${match ? "✅" : "⚠️ MISMATCH"}]`);
}

const O_fixed = tA + tB1 + tB2;
ok(`O_fixed (read-only overhead) = ${ms(O_fixed)}\n`);

// ── Handler-level pricing cost (agent-act / job-swap-approve call valueInUsdc BEFORE executeAction). ──
log("Handler pre-executeAction cost (read-only) — valueInUsdc the manual handlers also pay");
let tPrice = 0;
try { const t = now(); await valueInUsdc({ token: "EURC", amount: 1 }); tPrice = now() - t; info(`valueInUsdc(EURC) [getTokenRates]: ${ms(tPrice)}   (USDC-in is ~0; job-swap-approve adds ~2 balance reads ≈ ${ms(tA)} each)`); }
catch (e) { no(`valueInUsdc failed (rate glitch): ${e.message.split("\n")[0]}`); }

// ── Approve-wait model (best-effort empirical from a historical tx; else _circle.mjs constants). ──
log("\nApprove-wait A_approve — the first-swap-only blocking cost (NOT sent here)");
let empiricalApprove = null;
try {
  // Best-effort READ: newest COMPLETE tx for this wallet → its on-chain confirm latency (createDate→updateDate).
  const client = circle();
  if (typeof client.listTransactions === "function") {
    const { data } = await client.listTransactions({ walletIds: [WALLET], pageSize: 10 }).catch(() => ({ data: null }));
    const txs = data?.transactions || [];
    const done = txs.find((t) => t.state === "COMPLETE" && t.createDate && t.updateDate);
    if (done) { empiricalApprove = Date.parse(done.updateDate) - Date.parse(done.createDate); info(`empirical (historical COMPLETE tx ${String(done.id).slice(0, 8)}…): create→update = ${ms(empiricalApprove)}`); }
  }
} catch { /* best-effort only */ }
const A_typical = empiricalApprove ?? (FIRST_WAIT_MS + POLL_MS + 1000); // model: first-wait + ~1 poll + ~1s confirm
info(`model: FIRST_WAIT ${FIRST_WAIT_MS} + ~1 poll ${POLL_MS} + confirm ≈ TYPICAL ~${ms(A_typical)}   ·   WORST (throttle) = waitForTx deadline ${DEADLINE_MS} ms`);

// ── VERDICT — budget bands vs the 10s ceiling. submit-call (createContractExecutionTransaction, returns
//    circleId, no wait) is not sent; modeled ~800 ms from Circle API latency. ──
const SUBMIT_CALL = 800;
const subsequent = O_fixed + SUBMIT_CALL + tPrice;                 // allowance already set → no approve
const firstTypical = subsequent + A_typical;                       // + first-swap approve-wait (typical)
const firstWorst = subsequent + DEADLINE_MS;                       // + approve-wait under throttle
log(`\n════════════════════════════ VERDICT (vs ${CEILING_MS} ms) ════════════════════════════`);
info(`subsequent swap (allowance set):   O_fixed ${ms(O_fixed)} + submit ~${SUBMIT_CALL} + pricing ${ms(tPrice)} = ~${ms(subsequent)}`);
info(`first swap TYPICAL (+approve):      ~${ms(subsequent)} + A_approve ~${ms(A_typical)} = ~${ms(firstTypical)}`);
info(`first swap WORST (throttle):        ~${ms(subsequent)} + ${DEADLINE_MS} = ~${ms(firstWorst)}`);
log("");
(subsequent < CEILING_MS * 0.5 ? ok : no)(`subsequent-swap ${subsequent < CEILING_MS * 0.5 ? "COMFORTABLE" : "TIGHT"} (${ms(subsequent)} vs ${CEILING_MS})`);
(firstTypical < CEILING_MS * 0.7 ? ok : no)(`first-swap TYPICAL ${firstTypical < CEILING_MS * 0.7 ? "has margin" : "NEAR/OVER budget"} (${ms(firstTypical)} vs ~${CEILING_MS * 0.7} target)`);
no(`first-swap WORST (${ms(firstWorst)}) EXCEEDS ${CEILING_MS} ms — the known throttle tail. Decision: accept (first-swap-only, retryable, self-heals as allowance persists) OR move the manual approve off the sync path.`);
log(`\nRECOMMENDATION: ${firstTypical < CEILING_MS * 0.7 ? "PASS — keep manual swap inline; the only risk is the rare first-swap throttle tail (accept & document, or pre-approve at provisioning)." : "FAIL — reshape: move the manual approve to a one-time 'arm wallet' job / pre-approve, so the sync swap = quote+getCallData+submit only."}`);
log(`\nRead-only: allowance read + createSwap quote + getCallData + (best-effort) tx list. Nothing submitted, no gas, no money.\n`);
