// spike-step4-phase0-deadline-ttl.mjs — STEP 4 (deadline-revert), PHASE 0: measure the createSwap
// quote's deadline TTL. READ-ONLY: it fetches quotes and prints numbers. NOTHING is submitted,
// NOTHING is signed, NO wallet call is made — createSwap is a QUOTE endpoint (it hands back
// executionParams + a signature; only createContractExecutionTransaction would move anything, and
// this file never calls it). Zero money, zero gas.
//
// WHY: the TTL decides the SHAPE of step 4 Part B (the on-chain backstop test).
//   • short TTL  → Part B is ONE run: quote → sleep past the deadline → submit expired.
//   • long TTL   → Part B is TWO runs: run 1 persists the quote, run 2 submits it already-stale.
// It also tells us how much real headroom DEADLINE_SAFETY_MS (20s, _swap.mjs:21) actually leaves.
//
// RUN (KIT_KEY is supplied per-run and must NOT be — supply it per-run, without echoing it):
//   read -rs KIT_KEY && export KIT_KEY   # paste at the prompt — never in argv or history
//     node --env-file=.env scripts/spikes/spike-step4-phase0-deadline-ttl.mjs
//
// SECRETS: the key is never printed. The signature is reported by LENGTH only, never by value.

const SWAP_URL = "https://api.circle.com/v1/stablecoinKits/swap";           // _swap.mjs:18
const DEADLINE_SAFETY_MS = 20_000;                                          // _swap.mjs:21
const WALLET = (process.env.WALLET_ADDRESS || "0x6fb28d6366e755e0e27307692282490c6682fc58").toLowerCase();
const SAMPLES = 3;   // repeat: is the TTL stable, or does it drift per quote?
const GAP_MS = 3000; // spacing between samples

import { requireKitKey } from "../_kit-key.mjs";
const kitKey = requireKitKey();
// The env:get traps (see caps-from-deployed-env-not-code-defaults): an UNSET var makes the CLI print
// "No value set…" to STDOUT with exit 0, which a non-empty check happily accepts. Shape-check instead.
if (!kitKey || /no value set/i.test(kitKey) || !kitKey.startsWith("KIT_KEY:")) {
  console.error(`✖ KIT_KEY missing or malformed (len=${kitKey?.length ?? 0}, starts "KIT_KEY:"=${!!kitKey?.startsWith("KIT_KEY:")}).`);
  console.error(`  Expected the VERBATIM prod key (it already carries its own "KIT_KEY:" prefix — re-prepending it was the B1 v2 401).`);
  process.exit(2);
}

const { CONTRACTS } = await import("../../netlify/functions/_arc.mjs");

async function quote(amountBase) {
  const t0 = Date.now();
  const res = await fetch(SWAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${kitKey}` }, // VERBATIM
    body: JSON.stringify({
      tokenInAddress: CONTRACTS.USDC,
      tokenOutAddress: CONTRACTS.EURC,
      tokenInChain: "Arc_Testnet",
      fromAddress: WALLET,
      toAddress: WALLET,
      amount: amountBase,
    }),
  });
  const t1 = Date.now();
  if (!res.ok) throw new Error(`createSwap HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
  const body = await res.json();
  const q = body?.data ?? body;
  const T = q?.transaction;
  const EP = T?.executionParams;
  if (!EP) throw new Error("createSwap response missing executionParams");
  return { EP, T, q, rttMs: t1 - t0, seenAt: t1 };
}

console.log(`\n════ STEP 4 · PHASE 0 · createSwap deadline TTL · READ-ONLY (no submit, no gas) ════\n`);
console.log(`wallet ${WALLET}   ·   USDC→EURC 1.00   ·   DEADLINE_SAFETY_MS = ${DEADLINE_SAFETY_MS}\n`);

const ttls = [];
for (let i = 1; i <= SAMPLES; i++) {
  const { EP, T, q, rttMs, seenAt } = await quote("1000000"); // 1.00 USDC in 6-dp minor units
  const deadlineSec = Number(EP.deadline);
  const deadlineMs = deadlineSec * 1000;
  const ttlMs = deadlineMs - seenAt; // ← THE NUMBER: deadline − now, measured at response receipt
  ttls.push(ttlMs);
  console.log(`  sample ${i}:  deadline=${EP.deadline}  (${new Date(deadlineMs).toISOString()})`);
  console.log(`             now=${new Date(seenAt).toISOString()}   rtt=${rttMs}ms`);
  console.log(`             ⏱  TTL = ${(ttlMs / 1000).toFixed(1)}s   (${(ttlMs / 60000).toFixed(2)} min)`);
  console.log(`             execId=${String(EP.execId)}  instructions=${EP.instructions?.length}  tokens=${EP.tokens?.length}  sig=${typeof T?.signature === "string" ? `${T.signature.length} chars` : "MISSING"}  est.out=${q?.estimatedAmount ?? "n/a"}`);
  if (i < SAMPLES) await new Promise((r) => setTimeout(r, GAP_MS));
}

const min = Math.min(...ttls), max = Math.max(...ttls), spread = max - min;
console.log(`\n════ VERDICT — PHASE 0 ════`);
console.log(`  TTL min ${(min / 1000).toFixed(1)}s · max ${(max / 1000).toFixed(1)}s · spread ${(spread / 1000).toFixed(1)}s ${spread < 2000 ? "(stable)" : "(DRIFTS — Part B must re-read the deadline per quote, not assume a constant)"}`);
console.log(`  headroom past the ${DEADLINE_SAFETY_MS / 1000}s pre-submit guard: ~${((min - DEADLINE_SAFETY_MS) / 1000).toFixed(1)}s of usable window`);
console.log(`\n  → PART B SHAPE: ${min <= 10 * 60_000
  ? `ONE RUN — sleep ${Math.ceil((min + 30_000) / 1000)}s (TTL + 30s margin) between quote and submit.`
  : `TWO RUNS — TTL is long (${(min / 60000).toFixed(1)} min); persist the quote in run 1, submit it already-stale in run 2.`}`);
console.log(`\n  (measured only — nothing was submitted, nothing signed, no funds or gas touched.)`);
