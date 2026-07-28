// probe-settlement.mjs — the ONE question the facilitator design is blocked on.
//
// ═══ WHAT THIS ANSWERS ════════════════════════════════════════════════════════════════════════
// The revised model is settle → confirm-by-positive-on-chain-read-at-payTo → serve. That model has
// two unverified premises, and neither can be settled read-only because settle() needs a signed
// payment. This probe settles ONE real payment and reads the chain around it:
//
//   Q1. What does SettleResponse.transaction actually contain at acceptance — a usable tx hash,
//       or empty/placeholder? (The type says `transaction: string`, required — but a required
//       string can be "".)
//   Q2. ⭐ Does Gateway settlement emit an ERC-20 Transfer to payTo AT ALL? "Gateway WALLET" implies
//       balances held INSIDE the contract; if it credits an internal ledger instead, payTo's USDC
//       balance never moves, no Transfer log exists, and the entire confirmation read finds nothing
//       forever. That would be a real blocker, not a detail.
//
// ═══ ⚠️ THIS MOVES REAL MONEY — 0.001 USDC on Arc Testnet ════════════════════════════════════
// Payer: DELEGATE_ADDRESS (an EOA holding 4.9916 USDC of Gateway balance — the batched scheme
// requires ecrecover(sig) == from, so the payer must be an EOA that both holds the balance and
// signs). Requires --confirm; a bare run does the read-only half and stops before paying.
//
// ⭐ WHY IT PAYS THE *OLD* payTo, NOT THE NEW REVENUE WALLET.
// It drives the existing live x402-quote endpoint, whose payTo is 0xc70112c7… . Paying into the new
// revenue wallet 0xb407967…  would destroy the exact property it was created for: its ZERO starting
// balance is what makes Transfer-to-payTo reconciliation attributable. A probe payment there would
// be the first entry in a ledger that is supposed to contain only real revenue. The old payTo is
// already mixed, so a probe costs it nothing.
//
//   node --env-file=.env scripts/dd/probe-settlement.mjs            # read-only half only
//   node --env-file=.env scripts/dd/probe-settlement.mjs --confirm  # SPENDS 0.001 USDC

import { fetchX402Requirements, payX402, DEFAULT_SELLER_URL } from "../../netlify/functions/_x402.mjs";

const RPC = "https://rpc.testnet.arc.network";
const USDC = "0x3600000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CONFIRM = process.argv.includes("--confirm");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");

// Arc's public RPC is throttled; a read that exhausts retries returns null and null is INDETERMINATE.
async function rpc(method, params, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const j = await r.json();
    if (j.result !== undefined) return j.result;
    if (!/limit/i.test(j.error?.message || "")) { console.log(`      ! ${method}: ${j.error?.message}`); return null; }
    await sleep(900 * (i + 1));
  }
  return null;
}
const usdcBalance = async (a) => {
  const r = await rpc("eth_call", [{ to: USDC, data: "0x70a08231" + pad(a) }, "latest"]);
  return r === null ? null : BigInt(r);
};

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  SETTLEMENT PROBE — is `success` backed by an on-chain movement?     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
console.log(`  mode: ${CONFIRM ? "⚠️  CONFIRM — WILL SPEND 0.001 USDC" : "READ-ONLY half (no payment)"}\n`);

// ── the 402 challenge (read-only) ─────────────────────────────────────────────────────────────
console.log("── the 402 challenge ───────────────────────────────────────────────");
const chal = await fetchX402Requirements({ sellerUrl: DEFAULT_SELLER_URL });
if (!chal.ok) { console.log("  ✗ could not fetch challenge:", JSON.stringify(chal.body).slice(0, 200)); process.exit(1); }
const req = chal.requirements ?? chal.body?.accepts?.[0];
const payTo = (req?.payTo || "").toLowerCase();
const atomic = BigInt(req?.maxAmountRequired ?? req?.amount ?? "0");
console.log(`  payTo   : ${payTo}`);
console.log(`  amount  : ${atomic} atomic (${Number(atomic) / 1e6} USDC)`);
console.log(`  asset   : ${req?.asset}`);
console.log(`  scheme  : ${req?.scheme} / ${req?.extra?.name}`);

// ── snapshot BEFORE: a block floor, not a balance snapshot ────────────────────────────────────
console.log("\n── before ──────────────────────────────────────────────────────────");
const headBefore = Number(BigInt(await rpc("eth_blockNumber", [])));
await sleep(400);
const balBefore = await usdcBalance(payTo);
console.log(`  head block      : ${headBefore}`);
console.log(`  payTo USDC      : ${balBefore === null ? "UNREADABLE" : (Number(balBefore) / 1e6).toFixed(6)}`);

if (!CONFIRM) {
  console.log("\n╔══ READ-ONLY HALF DONE — nothing was paid ══════════════════════════");
  console.log("║  Re-run with --confirm to settle 0.001 USDC and answer Q1/Q2.");
  console.log("╚════════════════════════════════════════════════════════════════════");
  process.exit(0);
}

// ── settle ONE real payment ───────────────────────────────────────────────────────────────────
console.log("\n── paying (0.001 USDC from the DELEGATE Gateway balance) ───────────");
// ⭐ A CLI probe can afford to wait where a Netlify function cannot: pass a generous poll budget so
// the 202 → retrieve → 200 round trip completes here instead of returning pending.
const POLL_BUDGET_MS = 6 * 60 * 1000;   // ~2x the single observed ~3min settlement. PROVISIONAL (n=1).
const res = await payX402({ sellerUrl: DEFAULT_SELLER_URL, challenge: chal, approvedUsdc: 0.01, requireApproved: false, pollBudgetMs: POLL_BUDGET_MS });
console.log(`  http status : ${res.status}`);
console.log(`  executed    : ${res.body?.executed}`);
console.log(`  pending     : ${res.body?.pending ?? false}   handle: ${res.body?.handle ?? "-"}   polls: ${res.body?.polls ?? 0}`);
if (res.body?.pending) console.log(`  ⚠️ budget exhausted before confirmation — NOT a failure; handle stays redeemable`);
if (res.body?.blocked) console.log(`  BLOCKED     : ${res.body.blocked}`);

// ⭐ Q1 — what is actually in the settlement receipt?
console.log("\n── ⭐ Q1: what does the settlement receipt contain? ─────────────────");
const settle = res.body?.paymentResponse ?? res.body?.settlement ?? res.settlement ?? null;
console.log("  raw:", JSON.stringify(settle ?? res.body).slice(0, 600));
if (settle && typeof settle === "object") {
  console.log(`  success     : ${settle.success}`);
  console.log(`  transaction : ${JSON.stringify(settle.transaction)}  ${settle.transaction ? `(len ${String(settle.transaction).length})` : "← EMPTY"}`);
  console.log(`  network     : ${settle.network}`);
  console.log(`  payer       : ${settle.payer}`);
}

// ── ⭐ Q2 — did anything actually land at payTo? ──────────────────────────────────────────────
console.log("\n── ⭐ Q2: did an ERC-20 Transfer to payTo actually happen? ──────────");
for (const wait of [0, 3000, 6000, 10000]) {
  if (wait) { console.log(`  …waiting ${wait / 1000}s`); await sleep(wait); }
  const balAfter = await usdcBalance(payTo);
  await sleep(400);
  const head = Number(BigInt(await rpc("eth_blockNumber", [])));
  await sleep(400);
  const logs = await rpc("eth_getLogs", [{
    address: USDC, fromBlock: "0x" + headBefore.toString(16), toBlock: "0x" + head.toString(16),
    topics: [TRANSFER_TOPIC, null, "0x" + pad(payTo)],
  }]);
  const delta = (balAfter === null || balBefore === null) ? null : balAfter - balBefore;
  console.log(`  head ${head}  payTo USDC ${balAfter === null ? "UNREADABLE" : (Number(balAfter) / 1e6).toFixed(6)}` +
              `  delta ${delta === null ? "?" : (Number(delta) / 1e6).toFixed(6)}` +
              `  Transfer logs to payTo: ${Array.isArray(logs) ? logs.length : "UNREADABLE"}`);
  if (Array.isArray(logs) && logs.length) {
    for (const l of logs) {
      console.log(`    tx ${l.transactionHash} logIndex ${l.logIndex} block ${Number(BigInt(l.blockNumber))}`);
      console.log(`      from ${"0x" + (l.topics[1] || "").slice(26)}  value ${Number(BigInt(l.data)) / 1e6} USDC`);
    }
    break;
  }
  if (delta && delta > 0n) break;
}

console.log("\n╔══ VERDICT ════════════════════════════════════════════════════════");
console.log("║  Q1 → see `transaction` above: a real hash, or empty/placeholder?");
console.log("║  Q2 → a Transfer log to payTo means the confirmation read WORKS.");
console.log("║       No log + no balance delta means Gateway credits an INTERNAL");
console.log("║       ledger, the read finds nothing forever, and the design needs");
console.log("║       revising before any build.");
console.log("╚════════════════════════════════════════════════════════════════════");
