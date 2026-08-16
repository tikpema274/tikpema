// spike-step2-money-prove.mjs — ⚠️ MONEY-MOVING (gated by --confirm). Re-prove STEP 2: the gate.
//
// Proves the DRAFTED agentSwap (confirm:true, DCA-style inline path) actually swaps on-chain, end-to-end,
// by running TWO consecutive 1-USDC USDC→EURC swaps on the funded throwaway SCA:
//   • swap 1 — allowance from phase0e (1 USDC) COVERS it → approve SKIPPED (approveId=null). Proves B+C+confirm.
//   • swap 2 — swap 1 drained the allowance to ~0 → approve FIRES → proves the full A+B+C+confirm chain.
// (The runner derives "expect approve" from the OBSERVED allowance before each swap, so it's correct even if
//  the starting allowance differs.)
//
// WITNESS = THE CHAIN, NOT THE SDK. Every pass/fail assertion reads Arc DIRECTLY through the independent
// dd/rpc stack (getChain + rpcCall → the public Arc RPC), NOT the Circle client that submitted the tx:
//   • balance deltas: USDC↓ (input left) and EURC↑ (output arrived), read before/after via eth_call balanceOf
//   • mined success: eth_getTransactionReceipt(txHash).status == 0x1  (swap tx AND, on swap 2, the approve tx)
//   • allowance: eth_call allowance(owner, adapter) before/after — proves drain (swap1) and re-approve (swap2)
// agentSwap's INTERNAL hard assert (calldata.to === adapter, else throw) means a RETURNED result already
// proves B1 to==0xbbd70b01… — a successful swap is that proof (to==adapter was also proven read-only in
// spike-B1-direct-calldata.mjs). The on-chain tx.to is NOT asserted: a Circle SCA submits via account
// abstraction, so the tx `to` is the entrypoint/SCA, not the adapter — the balance deltas + receipt are the
// robust, AA-proof witness of what actually happened.
//
// SAFETY: moves ~2 USDC total (two 1-USDC swaps) + ~gas, on a THROWAWAY SCA you created. A swap is not a
// transfer-out: you receive EURC back. Gated behind --confirm — a bare run is a DRY RUN (reads only, moves nothing).
//
// RUN:
//   DRY RUN (reads balances/allowance, prints the plan — NOTHING moves):
//     read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//       WALLET_ADDRESS=0x6fb28d6366e755e0e27307692282490c6682fc58 \
//       node --env-file=.env scripts/spikes/spike-step2-money-prove.mjs
//   EXECUTE (moves ~2 USDC — run this fresh when you're ready):
//     …same… scripts/spikes/spike-step2-money-prove.mjs --confirm

import { agentSwap, SwapPendingConfirm } from "../../netlify/functions/_swap.mjs";
import { circle } from "../../netlify/functions/_circle.mjs";
import { CONTRACTS, ARC, USDC_DECIMALS } from "../../netlify/functions/_arc.mjs";
import { rpcCall, assertChain } from "../../shared/dd/rpc.mjs";
import { getChain } from "../../shared/dd/chains.mjs";
import { requireKitKey } from "../_kit-key.mjs";

const WALLET = (process.env.WALLET_ADDRESS || "").toLowerCase();
const ADAPTER = "0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b";
const AMOUNT = "1.00";
const amountBase = BigInt(Math.round(Number(AMOUNT) * 10 ** USDC_DECIMALS)); // 1_000_000n
const CONFIRM = process.argv.includes("--confirm");
const SWAPS = 2;

// tolerances (Arc gas is paid in USDC, ~0.2 flat; so USDC drops by input + gas)
const USDC_DROP_MIN = 0.95;   // at least ~the 1-USDC input left the wallet
const USDC_DROP_MAX = 1.75;   // input + generous gas (+approve gas on swap 2) — sanity upper bound
const EURC_QUOTE_TOL = 0.10;  // on-chain EURC gain within 10% of the quote's estimated out

const log = (s = "") => console.log(s);
const ok = (s) => log(`  ✅ ${s}`);
const bad = (s) => log(`  ❌ ${s}`);
const info = (s) => log(`  ·  ${s}`);
const chain = getChain("arc-testnet");
const rpc = (method, params) => rpcCall({ endpoint: chain.rpc, method, params }).then((r) => r.result);
const pad32 = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const toUsdc = (raw) => Number(raw) / 10 ** USDC_DECIMALS;
const fmt = (n) => n.toFixed(6);

// ── INDEPENDENT on-chain reads (dd/rpc → Arc public RPC; NOT the Circle submitting client) ──────────
const balanceOf = async (token, who) => BigInt(await rpc("eth_call", [{ to: token, data: "0x70a08231" + pad32(who) }, "latest"]));
const allowanceOf = async (token, owner, spender) => BigInt(await rpc("eth_call", [{ to: token, data: "0xdd62ed3e" + pad32(owner) + pad32(spender) }, "latest"]));
const receiptStatus = async (txHash) => { const r = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null); return r?.status ?? null; };
const snapshot = async () => ({
  usdc: await balanceOf(CONTRACTS.USDC, WALLET),
  eurc: await balanceOf(CONTRACTS.EURC, WALLET),
  allow: await allowanceOf(CONTRACTS.USDC, WALLET, ADAPTER),
});

// normalize the SDK quote's estimated EURC out (base units OR decimal) to a Number, or null.
function normEurc(amountOut) {
  if (amountOut == null) return null;
  const s = String(amountOut);
  if (/^\d+$/.test(s)) return Number(s) / 10 ** USDC_DECIMALS; // base units
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) { console.error("Need CIRCLE_API_KEY+CIRCLE_ENTITY_SECRET (.env)."); process.exit(2); }
requireKitKey();   // ⭐ unconditional: even the dry run prices a real quote
if (!/^0x[0-9a-fA-F]{40}$/.test(WALLET)) { console.error("Set WALLET_ADDRESS=0x… (the funded throwaway SCA)."); process.exit(2); }

log(`\n════ RE-PROVE STEP 2 · on-chain money-prove · ${CONFIRM ? "⚠️ WILL MOVE ~2 USDC" : "DRY RUN (reads only)"} ════`);
log(`wallet ${WALLET.slice(0, 10)}… · ${SWAPS}× ${AMOUNT} USDC→EURC via agentSwap(confirm:true) · witness = dd/rpc (independent)\n`);

await assertChain(chain); // fail-closed: don't read state from a wrong-chain endpoint
const pre = await snapshot();
info(`balances now:  USDC ${fmt(toUsdc(pre.usdc))}   EURC ${fmt(toUsdc(pre.eurc))}   allowance→adapter ${fmt(toUsdc(pre.allow))}`);

// Preconditions
let precondFail = false;
const needUsdc = Number(AMOUNT) * SWAPS + 0.5; // two swaps + gas headroom
if (toUsdc(pre.usdc) < needUsdc) { bad(`USDC balance ${fmt(toUsdc(pre.usdc))} < ~${needUsdc} needed for ${SWAPS} swaps + gas — fund the SCA first`); precondFail = true; }
else ok(`funded: USDC ${fmt(toUsdc(pre.usdc))} ≥ ~${needUsdc}`);
info(`plan: swap 1 expects approve ${pre.allow >= amountBase ? "SKIPPED (allowance covers it)" : "FIRED (allowance short)"}; swap 2 expects approve FIRED (swap 1 drains the allowance)`);

if (!CONFIRM) {
  log(`\nDRY RUN — nothing moved. Re-run with --confirm to execute the ${SWAPS} swaps and assert on-chain.\n`);
  process.exit(precondFail ? 1 : 0);
}
if (precondFail) { log(`\nPreconditions failed — refusing to move money.\n`); process.exit(1); }

// ── EXECUTE + ASSERT ───────────────────────────────────────────────────────────────────────────
let failures = 0;
const client = circle();
const check = (cond, good, why) => { if (cond) ok(good); else { bad(why); failures++; } };

for (let i = 1; i <= SWAPS; i++) {
  log(`\n──────── SWAP ${i}/${SWAPS} · ${AMOUNT} USDC → EURC ────────`);
  const before = await snapshot();
  const expectApprove = before.allow < amountBase;
  info(`before: USDC ${fmt(toUsdc(before.usdc))}  EURC ${fmt(toUsdc(before.eurc))}  allowance ${fmt(toUsdc(before.allow))} → expect approve ${expectApprove ? "FIRE" : "SKIP"}`);

  let r;
  try {
    r = await agentSwap({ walletAddress: WALLET, tokenIn: "USDC", tokenOut: "EURC", amountIn: AMOUNT, confirm: true }); // ← MONEY MOVES
  } catch (e) {
    if (e instanceof SwapPendingConfirm || e?.name === "SwapPendingConfirm") {
      bad(`INCONCLUSIVE — inline confirm timed out (circleId ${e.circleId}). The swap MAY have landed; verify on arcscan and re-run. Not counted as a mechanism pass.`);
      info(`${ARC.explorer} · circleId ${e.circleId}`);
      failures++; break;
    }
    bad(`agentSwap THREW: ${e.message.split("\n")[0]}`); failures++; break;
  }

  const after = await snapshot();
  const usdcDropped = toUsdc(before.usdc - after.usdc);
  const eurcGained = toUsdc(after.eurc - before.eurc);
  const quoteEurc = normEurc(r.estimate?.amountOut);

  // 1) inline confirm returned "confirmed"
  check(r.state === "confirmed", `state = confirmed (inline waitForTx → COMPLETE)`, `state = ${r.state} (expected "confirmed")`);

  // 2) approve fired/skipped as the observed allowance predicted
  check(expectApprove ? !!r.approveId : !r.approveId,
    `approve ${expectApprove ? `FIRED (approveId ${r.approveId})` : "SKIPPED (approveId null) — allowance covered it"}`,
    `approve mismatch: expected ${expectApprove ? "FIRE" : "SKIP"}, got approveId=${r.approveId}`);

  // 2b) if it approved, independently confirm the approve tx mined success
  let approveTxHash = null;
  if (r.approveId) {
    approveTxHash = await client.getTransaction({ id: r.approveId }).then((x) => x.data?.transaction?.txHash).catch(() => null);
    const st = approveTxHash ? await receiptStatus(approveTxHash) : null;
    check(st === "0x1", `approve tx mined success (status 0x1) — ${approveTxHash}`, `approve tx receipt status ${st} (expected 0x1) — ${approveTxHash}`);
  }

  // 3) swap tx mined success — independent receipt via dd/rpc
  check(!!r.txHash, `submit → txHash ${r.txHash}`, `no swap txHash returned`);
  if (r.txHash) {
    const st = await receiptStatus(r.txHash);
    check(st === "0x1", `swap tx mined SUCCESS (status 0x1) — independent dd/rpc receipt`, `swap tx receipt status ${st} (expected 0x1)`);
  }

  // 4) USDC input left the wallet (core input witness), within [min, max] (input + gas)
  check(usdcDropped >= USDC_DROP_MIN && usdcDropped <= USDC_DROP_MAX,
    `USDC dropped ${fmt(usdcDropped)} (≈ 1 input + gas) — the input left the wallet`,
    `USDC drop ${fmt(usdcDropped)} outside [${USDC_DROP_MIN}, ${USDC_DROP_MAX}] — unexpected`);

  // 5) EURC output arrived, within tolerance of the quote (the swap actually happened)
  check(eurcGained > 0, `EURC gained ${fmt(eurcGained)} — output arrived`, `EURC delta ${fmt(eurcGained)} ≤ 0 — no output`);
  if (quoteEurc != null && eurcGained > 0) {
    const rel = Math.abs(eurcGained - quoteEurc) / quoteEurc;
    check(rel <= EURC_QUOTE_TOL, `EURC gain ${fmt(eurcGained)} within ${(EURC_QUOTE_TOL * 100)}% of quote ${fmt(quoteEurc)} (Δ ${(rel * 100).toFixed(1)}%)`,
      `EURC gain ${fmt(eurcGained)} vs quote ${fmt(quoteEurc)} off by ${(rel * 100).toFixed(1)}% (> ${(EURC_QUOTE_TOL * 100)}%)`);
  } else info(`quote amountOut unparsed (${JSON.stringify(r.estimate?.amountOut)}) — checked direction+magnitude only`);

  // 6) allowance consumed by the swap (transferFrom decremented it)
  check(after.allow < before.allow || (r.approveId && after.allow <= amountBase),
    `allowance moved (before ${fmt(toUsdc(before.allow))} → after ${fmt(toUsdc(after.allow))}) — swap pulled via allowance`,
    `allowance unchanged (${fmt(toUsdc(after.allow))}) — swap did not consume it?`);

  // ── independent-verify handles for the user ──
  log(`  → circleId  ${r.circleId}`);
  log(`  → swap tx   ${ARC.explorer}/tx/${r.txHash}`);
  if (approveTxHash) log(`  → approve tx ${ARC.explorer}/tx/${approveTxHash}`);
}

// ── VERDICT ──────────────────────────────────────────────────────────────────────────────────
log(`\n════════════════════════════ VERDICT ════════════════════════════`);
if (failures === 0) {
  log(`✅ STEP 2 PASS — agentSwap moved USDC→EURC on-chain, twice, confirm-gated. Swap 1 skipped the approve;`);
  log(`   swap 2 fired the approve (A) + extracted B1 calldata (to==adapter, internal assert) + submitted (C) +`);
  log(`   inline-confirmed. Every assertion witnessed by dd/rpc reads, independent of the Circle submitting client.`);
  log(`   → Proceed to step 3 (caps/pause/ledger via executeAction). Verify the printed txHashes on arcscan.`);
} else {
  log(`❌ STEP 2 FAIL — ${failures} assertion(s) failed above. Do NOT proceed to step 3 or commit. Read the ❌ lines;`);
  log(`   an INCONCLUSIVE (inline-confirm timeout) is not a mechanism failure — re-run, or check the circleId on arcscan.`);
}

// ── MONEY STATUS — READ THE CHAIN, NEVER THE --confirm FLAG. A net snapshot vs the run's start is the
//    ground truth of what actually moved, robust to a throw AFTER submit (which per-swap bookkeeping misses).
if (CONFIRM) {
  log(`\nMONEY STATUS (verified via dd/rpc — net over the whole run, independent of the submitting client):`);
  try {
    const post = await snapshot();
    const netUsdcOut = toUsdc(pre.usdc - post.usdc);
    const netEurcIn = toUsdc(post.eurc - pre.eurc);
    const moved = Math.abs(netUsdcOut) > 1e-6 || Math.abs(netEurcIn) > 1e-6;
    if (moved) log(`  MOVED:  USDC ${netUsdcOut >= 0 ? "−" : "+"}${fmt(Math.abs(netUsdcOut))}  ·  EURC ${netEurcIn >= 0 ? "+" : "−"}${fmt(Math.abs(netEurcIn))}  ·  allowance ${fmt(toUsdc(pre.allow))} → ${fmt(toUsdc(post.allow))}`);
    else log(`  NOTHING MOVED — USDC and EURC unchanged from the run's start. (The --confirm flag does not assert movement; the chain does.)`);
  } catch (e) {
    log(`  COULD NOT READ final on-chain state (${e.message.split("\n")[0]}) — do NOT assume movement either way; re-read the chain before re-running.`);
  }
}
log("");
process.exit(failures === 0 ? 0 : 1);
