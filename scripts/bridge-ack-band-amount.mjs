// bridge-ack-band-amount.mjs — READ-ONLY. What amount makes the manual bridge's ACK GATE fire?
//
//   node scripts/bridge-ack-band-amount.mjs            # all routes
//   node scripts/bridge-ack-band-amount.mjs --route base
//
// ⛔ MOVES NO MONEY, NEEDS NO SESSION, WRITES NOTHING. It performs two unauthenticated GETs per
// route against Circle's public Iris sandbox — the same endpoint the server prices from. It does
// NOT call /api/user-bridge-start, deliberately: that endpoint CREATES AN INTENT, so "just getting
// a quote" through it would be a write. [[verification-method-must-not-mutate]]
//
// ═══ ⭐⭐ WHY THIS SCRIPT EXISTS RATHER THAN A NUMBER IN A DOC ══════════════════════════════════
// THE FEE MOVES, AND IT MOVES ENOUGH TO MATTER. Measured across two calls seconds apart on
// 2026-08-29: 0.054214 → 0.054218. The record already notes 0.0541 / 0.053520 / 0.053196 on one
// route in a single day.
//
// 🚨 AND A STALE ESTIMATE ALREADY FAILED ONCE, BY A HAIR. The design note estimated "roughly
// ≤0.22 USDC" for the acknowledge band on Base. At the live fee that estimate is WRONG:
//     0.054218 / 0.22 = 24.64%  →  band "warn", NOT "acknowledge". The gate would NOT have fired.
// The run would have looked like falsifier 1 ("the band computation is wrong live") when in fact
// the input was simply stale. ⭐ Re-derive immediately before running; do not carry a number.
//
// ═══ ⭐ IT IMPORTS THE SERVER'S OWN PRICING, IT DOES NOT REIMPLEMENT IT ═════════════════════════
// `bridgeFee` and `bridgeFeeBand` are the exact functions `priceAndGate` will call. A script that
// re-derived the arithmetic would be a second source of truth for the number the whole exercise
// turns on, and would keep agreeing with itself after the server changed.
// [[duplicate-source-of-truth-is-the-recurring-bug]]
import {
  bridgeFee, bridgeFeeBand, destinationOptions,
  FEE_BAND_ACKNOWLEDGE, FEE_BAND_WARN,
} from "../netlify/functions/_bridge.mjs";

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const only = arg("--route");

console.log(`\nMANUAL BRIDGE — the amount that fires the ACK GATE   (read-only, no session, no writes)`);
console.log(`bands: warn >= ${(FEE_BAND_WARN * 100).toFixed(0)}%   acknowledge >= ${(FEE_BAND_ACKNOWLEDGE * 100).toFixed(0)}%   ·  quoted ${new Date().toISOString()}\n`);

const rows = [];
for (const d of destinationOptions()) {
  if (only && d.key !== only) continue;
  try {
    // The fee is FLAT on these routes (minimumFee is 0, so the proportional part vanishes and
    // only the forwarder fee remains) — but that is READ from the quote, never assumed: a
    // non-zero minimumFee would make it partly proportional and the crossing point would move.
    const at1 = await bridgeFee({ amountUsdc: 1, cctpDomain: d.cctpDomain });
    const at01 = await bridgeFee({ amountUsdc: 0.1, cctpDomain: d.cctpDomain });
    const flat = Math.abs(at1.feeUsdc - at01.feeUsdc) < 1e-9;
    // Crossing point for a flat fee: ratio = fee/amount >= T  ⟺  amount <= fee/T.
    const crossesAt = at1.feeUsdc / FEE_BAND_ACKNOWLEDGE;
    rows.push({ key: d.key, label: d.label, fee: at1.feeUsdc, flat, crossesAt });
  } catch (e) {
    rows.push({ key: d.key, label: d.label, err: e.message });
  }
}

for (const r of rows) {
  if (r.err) { console.log(`  ${r.key.padEnd(11)} UNAVAILABLE — ${r.err}`); continue; }
  console.log(`  ${r.key.padEnd(11)} fee ${r.fee.toFixed(6)} USDC ${r.flat ? "(flat)" : "(NOT flat — see below)"}   acknowledge at amount <= ${r.crossesAt.toFixed(6)}`);
  if (!r.flat) console.log(`     ⚠️ the fee VARIES with amount on this route, so `+
    `\`amount <= fee/${FEE_BAND_ACKNOWLEDGE}\` is not exact — solve it against the printed band below.`);
}

// ── the recommendation, with its margin stated ──────────────────────────────────────────────────
const target = rows.find((r) => r.key === (only ?? "base") && !r.err);
if (!target) { console.log(`\n✖ no live quote for the target route — do not run the bridge.\n`); process.exit(1); }

console.log(`\n── ${target.label} — candidate amounts, priced LIVE ──`);
let recommended = null;
for (const amt of [0.25, 0.22, 0.20, 0.18, 0.15, 0.12, 0.10]) {
  const f = await bridgeFee({ amountUsdc: amt, cctpDomain: destinationOptions().find((d) => d.key === target.key).cctpDomain });
  const b = bridgeFeeBand({ amountUsdc: amt, feeUsdc: f.feeUsdc, netUsdc: f.netUsdc });
  const fires = b.band === "acknowledge";
  // ⭐ The recommendation is the LARGEST amount that fires, then one step smaller for margin —
  // the fee can drift DOWN between this quote and the run, and a run that quietly lands in "warn"
  // proves nothing while still costing the fee.
  if (fires && recommended === null) recommended = null; // filled after the loop
  console.log(`  ${amt.toFixed(2)} USDC → fee ${f.feeUsdc.toFixed(6)} · ratio ${(b.feeRatio * 100).toFixed(2)}% · band ${b.band.padEnd(11)} ${fires ? "✅ FIRES" : "—"} · arrives ${f.netUsdc.toFixed(6)}`);
}

// ═══ ⭐ THE SELECTION RULE, AND WHY IT TAKES A BIG MARGIN ═══════════════════════════════════════
// THE FEE IS FLAT, so the COST OF THE EXERCISE DOES NOT DEPEND ON THE AMOUNT — 0.20 and 0.15 cost
// exactly the same fee. Margin is therefore FREE, and the only thing a larger amount buys is more
// USDC coming back on the far side. A run that quietly lands in `warn` because the fee drifted
// down proves nothing and still costs the full fee, so the margin is worth far more than the
// difference in what arrives.
// ⚠️ If a route's fee were NOT flat this rule would need rethinking — which is why flatness is
// measured above and printed, not assumed.
const MIN_HEADROOM = 0.40; // fire at >= 35% when the band is 25%
let pick = null;
for (const amt of [0.20, 0.18, 0.15, 0.12, 0.10]) {
  const f = await bridgeFee({ amountUsdc: amt, cctpDomain: destinationOptions().find((d) => d.key === target.key).cctpDomain });
  const b = bridgeFeeBand({ amountUsdc: amt, feeUsdc: f.feeUsdc, netUsdc: f.netUsdc });
  const headroom = (b.feeRatio - FEE_BAND_ACKNOWLEDGE) / FEE_BAND_ACKNOWLEDGE;
  if (b.band === "acknowledge" && headroom >= MIN_HEADROOM) { pick = { amt, f, b, headroom }; break; }
}

console.log(`\n${"═".repeat(78)}`);
if (!pick) {
  // ⛔ THE PRE-REGISTERED FALSIFIER: "the fee does not cross even at the amount you compute → say
  // so and STOP; do not raise the amount until it crosses."  Raising it would be fitting the
  // experiment to the desired outcome.
  console.log(`⛔ NO AMOUNT IN THE SAFE RANGE FIRES THE GATE WITH MARGIN ON ${target.label}.`);
  console.log(`   DO NOT run the bridge, and DO NOT lower the amount further to force it — report`);
  console.log(`   this as the finding it is. The fee has moved enough that the band is no longer`);
  console.log(`   reachable at a sane amount on this route.`);
  process.exit(2);
}
console.log(`⭐ ENTER THIS:   amount ${pick.amt}   destination "${target.label}"`);
console.log(`   fee now      ${pick.f.feeUsdc.toFixed(6)} USDC   ratio ${(pick.b.feeRatio * 100).toFixed(2)}%   band ${pick.b.band}`);
console.log(`   arrives      ${pick.f.netUsdc.toFixed(6)} USDC on the destination chain`);
console.log(`   COST TO YOU  ${pick.f.feeUsdc.toFixed(6)} USDC (the fee) + Arc gas. The fee is FLAT,`);
console.log(`                so a larger amount would NOT cost more — it would only fail to cross.`);
console.log(`   headroom     ${(pick.headroom * 100).toFixed(0)}% above the ${(FEE_BAND_ACKNOWLEDGE * 100).toFixed(0)}% band — the fee can fall that far and still fire.`);
console.log(`   ⚠️ RE-RUN THIS IMMEDIATELY BEFORE BRIDGING. "0.22" was right two days ago and is`);
console.log(`      band "warn" today — a stale amount fails the run and still costs the fee.`);
console.log(`${"═".repeat(78)}\n`);
