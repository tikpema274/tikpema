// probe-settlement-batch.mjs — turn Gateway settlement latency from a point into a distribution.
//
// Two samples so far disagree by ~4.8x (≈3 min, then 14.5 min), so every timeout/poll number in the
// facilitator design is currently set against an unknown. This runs N real settlements and reports
// min / median / max so those numbers can be set against the observed TAIL.
//
// ⚠️ MOVES REAL MONEY: N x 0.001 USDC from the DELEGATE Gateway balance (an EOA — the batched scheme
// requires ecrecover(sig)==from, so the payer must hold the balance and sign). NOT the revenue wallet
// (0xb407967… must only ever receive real revenue, its zero baseline is load-bearing) and NOT the
// agent wallet (0xc54d47… signs the DD attestations).
//
// ⭐ STRICTLY SEQUENTIAL, AND THAT IS NOT AN OPTIMISATION CHOICE. Confirmation is a THRESHOLD against
// a balance snapshot, so two in-flight payments to the same payTo CROSS-CONFIRM: run 2's baseline is
// read while run 1 is still pending, so run 1's credit satisfies run 2's threshold and both look
// instant. Firing these concurrently would fabricate a fast distribution. Each run therefore waits
// for its own credit to land before the next is fired.
//
//   node --env-file=.env scripts/dd/probe-settlement-batch.mjs --url <seller> --runs 5 --confirm

import { fetchX402Requirements, payX402 } from "../../netlify/functions/_x402.mjs";

const RPC = "https://rpc.testnet.arc.network";
const GW = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const USDC = "0x3600000000000000000000000000000000000000";
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const SELLER = arg("--url", "https://app.tikpema.xyz/.netlify/functions/x402-quote");
const RUNS = Number(arg("--runs", "5"));
const CONFIRM = process.argv.includes("--confirm");
const MAX_WAIT_MS = 45 * 60 * 1000;      // generous: the tail is unknown, that is the point
const POLL_MS = 20_000;                  // Arc's public RPC throttles; do not hammer it
const GAP_MS = 30_000;                   // breathing room between runs

const pad = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gwBalance(addr) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: GW, data: "0x3ccb64ae" + pad(USDC) + pad(addr) }, "latest"] }) });
    const j = await r.json();
    if (j.result !== undefined) return BigInt(j.result);
    if (!/limit/i.test(j.error?.message || "")) return null;   // real error, not throttle
    await sleep(900 * (i + 1));
  }
  return null;                                                  // exhausted → INDETERMINATE
}

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  SETTLEMENT LATENCY — building a distribution                       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
console.log(`  seller : ${SELLER}`);
console.log(`  runs   : ${RUNS}   mode: ${CONFIRM ? "⚠️  CONFIRM — SPENDS " + (RUNS * 0.001).toFixed(3) + " USDC" : "DRY RUN"}`);

const chal0 = await fetchX402Requirements({ sellerUrl: SELLER });
if (!chal0.ok) { console.log("  ✗ no challenge:", JSON.stringify(chal0.body).slice(0, 200)); process.exit(1); }
const req0 = chal0.requirements ?? chal0.body?.accepts?.[0];
const payTo = (req0?.payTo || "").toLowerCase();
const amount = BigInt(req0?.maxAmountRequired ?? req0?.amount ?? "0");
console.log(`  payTo  : ${payTo}   amount: ${Number(amount) / 1e6} USDC each\n`);

if (!CONFIRM) { console.log("  DRY RUN — re-run with --confirm to spend.\n"); process.exit(0); }

const results = [];
for (let n = 1; n <= RUNS; n++) {
  const before = await gwBalance(payTo);
  if (before === null) { console.log(`  run ${n}: ✗ baseline UNREADABLE (RPC) — skipping, not guessing`); continue; }

  const chal = await fetchX402Requirements({ sellerUrl: SELLER });
  if (!chal.ok) { console.log(`  run ${n}: ✗ challenge failed`); continue; }

  const t0 = Date.now();
  // pollBudgetMs: 0 → take the handle and return immediately; we measure the LEDGER, not the endpoint.
  const res = await payX402({ sellerUrl: SELLER, challenge: chal, approvedUsdc: 0.01,
    requireApproved: false, pollBudgetMs: 0 });
  if (res.status !== 202 && res.status !== 200) {
    console.log(`  run ${n}: ✗ pay failed (${res.status}) ${JSON.stringify(res.body?.blocked ?? res.body?.error ?? "").slice(0, 120)}`);
    continue;
  }
  process.stdout.write(`  run ${n}: settled→ handle ${String(res.body?.handle ?? "-").slice(0, 8)}… waiting`);

  const target = before + amount;
  let landed = null;
  while (Date.now() - t0 < MAX_WAIT_MS) {
    await sleep(POLL_MS);
    const now = await gwBalance(payTo);
    if (now === null) { process.stdout.write("?"); continue; }   // throttled read ≠ not landed
    if (now >= target) { landed = Date.now(); break; }
    process.stdout.write(".");
  }
  if (landed === null) { console.log(`  → ✗ NOT CONFIRMED within ${MAX_WAIT_MS / 60000}min`); results.push(null); continue; }

  const secs = (landed - t0) / 1000;
  console.log(`  → ✅ ${secs.toFixed(1)}s (${(secs / 60).toFixed(1)} min)`);
  results.push(secs);
  if (n < RUNS) await sleep(GAP_MS);
}

const ok = results.filter((x) => typeof x === "number").sort((a, b) => a - b);
console.log("\n╔══ DISTRIBUTION ═══════════════════════════════════════════════════");
if (!ok.length) { console.log("║  no confirmed samples"); }
else {
  const med = ok.length % 2 ? ok[(ok.length - 1) / 2] : (ok[ok.length / 2 - 1] + ok[ok.length / 2]) / 2;
  console.log(`║  n       : ${ok.length} confirmed (of ${RUNS} attempted)`);
  console.log(`║  samples : ${ok.map((s) => (s / 60).toFixed(1) + "m").join(", ")}`);
  console.log(`║  min     : ${(ok[0] / 60).toFixed(1)} min`);
  console.log(`║  median  : ${(med / 60).toFixed(1)} min`);
  console.log(`║  max     : ${(ok[ok.length - 1] / 60).toFixed(1)} min   ← set timeouts against THIS, not the median`);
  console.log(`║  spread  : ${(ok[ok.length - 1] / ok[0]).toFixed(1)}x`);
}
console.log("╚════════════════════════════════════════════════════════════════════");
