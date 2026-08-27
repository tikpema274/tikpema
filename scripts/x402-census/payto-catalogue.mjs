// payto-catalogue.mjs — WHAT IS A `payTo` ADDRESS'S INBOUND ACTUALLY MADE OF?
//
//   node scripts/x402-census/payto-catalogue.mjs 0x973a…12d6 0x5E70…4EB9
//   node scripts/x402-census/payto-catalogue.mjs            # reads payto.json (array) from the CWD
//
// ═══ ⭐⭐ WHY THIS EXISTS — seller-census.mjs MEASURES A TILL, NOT A PRODUCT ════════════════════
// seller-census.mjs reports inbound per `payTo` address. That is correct as far as it goes, and it
// is NOT a per-endpoint figure: **one payTo commonly serves a whole catalogue.** Measured
// 2026-08-27 over the same Base sets both censuses use:
//
//     Circle index : 50 of the census's 80 Base payTo (63%) serve MORE THAN ONE endpoint;
//                    96% of the 836 Base listings sit behind a multi-endpoint payTo;
//                    the largest single address serves 132 endpoints.
//     Bazaar       : 624 of 963 (65%), largest 965 endpoints across 21 price tiers.
//
// So "seller X received N transfers totalling V" is a CATALOGUE total. Dividing V by any one
// endpoint's list price is a category error, and it is the error that made 5.70 USDC look
// irreconcilable with 131 transfers at $0.75 — the transfers were mostly $0.02–$0.03 calls to
// OTHER endpoints behind the same address.
//
// ═══ 🚨 THE BOUND POINTS BOTH WAYS, AND BOTH DIRECTIONS ARE REAL ═══════════════════════════════
// ⬇ INBOUND OVERSTATES ONE ENDPOINT. A catalogue till pools many products, plus funding, refunds
//   and unrelated transfers. An inbound transfer is not a purchase (the census's own limit) and it
//   is not necessarily a purchase OF THE ENDPOINT YOU ARE PRICING.
// ⬆ INBOUND UNDERSTATES CALLS. Sellers sell PREPAID CREDITS — 402.com.tr quotes credit tiers at
//   250000/1000000/5000000/20000000 atomic — and one credit settlement backs many later calls that
//   never touch the chain. Circle Gateway batching does the same thing from the other end.
// ⛔ Therefore transfer count is an upper bound on SETTLEMENTS, not on CALLS, and value is an
//   upper bound on ONE ENDPOINT's revenue, not a measure of it. Do not collapse these into one
//   "sales" number; they do not net out to anything.
//
// ═══ ⭐ WHAT THIS ADDS OVER THE CENSUS ══════════════════════════════════════════════════════════
//   1. Every inbound amount HISTOGRAMMED and matched against the seller's own published price
//      tiers. A mean hides this completely: a $0.044 mean against a $0.75 list price reads as a
//      discount, when it is really the catalogue's MODAL price for entirely different products.
//   2. Distinct senders, because 131 transfers from one address and from 131 addresses are
//      different worlds and the count cannot tell them apart.
//   3. The SETTLEMENT TYPE per transfer, from the tx selector. `transferWithAuthorization`
//      (0xe3ee160e) is an x402 settlement; a plain `transfer` (0xa9059cbb) is somebody sending
//      USDC, which is not the same claim.
//   4. Outbound destinations, so a round-trip to the largest inbound sender is visible rather
//      than being averaged into a "withdrawal".
//
// ═══ 🚨 SELF-CHECK DISCIPLINE — INHERITED FROM THE CENSUS, AND EXTENDED ════════════════════════
// · WRITE-PROBE FIRST. Expensive scanning must not be gated on an untested cheap step at the end.
// · CAP guard: a truncated eth_getLogs returns FEWER logs with NO error, so a silent cap looks
//   exactly like a quiet week.
// · ⭐ AND THIS SCRIPT REFUSES TO REPORT RATHER THAN REPORTING A POSSIBLY-TRUNCATED COUNT. The
//   census marks a run INCOMPLETE and still prints its rows; here an incomplete scan writes
//   {status:"REFUSED"} and exits non-zero. A partial count of a distribution is not a weaker
//   result, it is a WRONG one — the missing windows are exactly where an unusual amount hides.
// · ⭐⭐ EVERY EQUALITY IS GATED ON NON-EMPTINESS FIRST. `agree === probes.length` is `0 === 0`
//   when nothing was probed, which is how verify-census.mjs prints a PASS on zero evidence.
//   assertNonEmpty() below REFUSES in that case; it never returns a verdict it did not earn.
// · The index harvests carry their own completeness proofs — see harvest() and the siwx note.
//
// ⚠️ WHAT THIS STILL CANNOT DO. It cannot say which endpoint a given transfer bought: several
// endpoints usually share one price. Matching an amount to a tier NARROWS the candidates and
// nothing more. And it cannot identify a buyer — an operator self-test, a paid liveness checker
// and a real customer are indistinguishable from transfers alone.

import { readFileSync, writeFileSync } from "node:fs";

const OUT = "payto-catalogue-out.json";
// ⭐ WRITE-PROBE FIRST — see the discipline block above.
writeFileSync(OUT, JSON.stringify({ status: "IN PROGRESS — not a result" }));

const RPC  = "https://mainnet.base.org";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const T0   = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// ⭐ THE PUBLISHED WINDOW, VERBATIM — the same 302,401 blocks docs/x402-seller-census-2026-08-25.md
// reports, so figures from here are directly comparable with it. ⚠️ Not a default to "modernise":
// changing it silently produces a DIFFERENT SCAN that still looks plausible.
const FROM = 50_129_226, TO = 50_431_626, WINDOW = 4_000, CAP = 9_000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rpc = async (m, p, t = 6) => { let e; for (let i = 0; i < t; i++) { try {
  const r = await fetch(RPC, { method:"POST", headers:{"content-type":"application/json"},
                               body: JSON.stringify({ jsonrpc:"2.0", id:1, method:m, params:p }) });
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error).slice(0,90));
  return j.result;
} catch (x) { e = x; await sleep(1200 * (i + 1)); } } throw e; };

// ── REFUSE, don't degrade ────────────────────────────────────────────────────────────────────
// 🚨 The whole point: a result that is not fully covered is not written as a result at all.
function refuse(why, detail) {
  writeFileSync(OUT, JSON.stringify({ status:"REFUSED", why, detail }, null, 2));
  console.error(`\n⛔ REFUSED TO REPORT — ${why}`);
  if (detail) console.error(`   ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0,400)}`);
  process.exit(2);
}
// ⭐⭐ NON-EMPTINESS BEFORE EQUALITY. `n === total` passes vacuously at 0 === 0; a check that
// cannot discriminate must REFUSE, not return the pass it never earned.
function assertNonEmpty(n, what) {
  if (!n) refuse(`nothing to check: ${what}`,
    "an equality over an empty set passes vacuously — this run cannot discriminate, so it reports nothing");
  return n;
}

// ── the two directories, harvested DIRECTLY ──────────────────────────────────────────────────
// 🚨 NO `circle` CLI for the Circle index: it silently appends `siwx=false`, which on 2026-08-27
// hid 165 of 1,003 listings including EVERY TESTNET ROW. The testnet self-check below is what
// proves the harvest was unfiltered — if it fails, the denominator is wrong and we stop.
async function harvest(label, url, pick) {
  let items = [], off = 0, total = null;
  for (;;) {
    let d = null, err = null;
    for (let i = 0; i < 5; i++) { try { const r = await fetch(`${url}?limit=100&offset=${off}`);
      d = await r.json(); if (!pick(d)) throw new Error(`no items (HTTP ${r.status})`); err = null; break;
    } catch (e) { err = e; await sleep(1000 * (i + 1)); } }
    if (err) refuse(`${label} index harvest failed`, String(err.message));
    const got = pick(d);
    total = d.pagination?.total ?? total;
    items = items.concat(got); off += got.length;
    process.stderr.write(`\r  ${label}: ${items.length}${total ? "/" + total : ""}`);
    if (got.length < 100) break;
    if (total != null && items.length >= total) break;
    await sleep(120);
  }
  process.stderr.write("\n");
  // ⚠️ A live index can shift its own `total` between pages; treat a SHORTFALL as fatal and a
  // small overshoot as normal. Absence must not read as completeness either way.
  if (total != null && items.length < total)
    refuse(`${label} index harvest incomplete`, `${items.length} of ${total} listings`);
  return items;
}

// ── price tiers per payTo, from whichever directory lists it ─────────────────────────────────
function catalogue(items, source, into) {
  for (const it of items) for (const a of (it.accepts || [])) {
    if (a.network !== "eip155:8453") continue;
    const p = (a.payTo || "").toLowerCase(); if (!into[p]) continue;
    const c = into[p];
    c.endpoints.add(it.resource);
    (c.tiers[String(a.amount)] ||= new Set()).add(it.resource.replace(/^https?:\/\/[^/]+/, ""));
    c.sources.add(source);
    try { c.hosts.add(new URL(it.resource).host); } catch {}
  }
}

// ── inputs ───────────────────────────────────────────────────────────────────────────────────
let addrs = process.argv.slice(2).filter(a => /^0x[0-9a-fA-F]{40}$/.test(a));
if (!addrs.length) { try { addrs = JSON.parse(readFileSync("payto.json", "utf8")); } catch {} }
if (!Array.isArray(addrs) || !addrs.length)
  refuse("no payTo addresses given", "pass them on argv, or put a JSON array in payto.json");
addrs = [...new Set(addrs.map(a => a.toLowerCase()))];

const cat = Object.fromEntries(addrs.map(a =>
  [a, { endpoints:new Set(), tiers:{}, hosts:new Set(), sources:new Set() }]));

console.log(`\n▸ ${addrs.length} payTo address(es), Base, blocks ${FROM.toLocaleString()}–${TO.toLocaleString()}\n`);

const baz = await harvest("bazaar", "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
                          d => d.items);
const cir = await harvest("circle", "https://api.circle.com/v2/x402/discovery/resources",
                          d => (d.data ?? d).items);
// ⭐ THE SELF-CHECK THAT PROVES THE CIRCLE HARVEST WAS UNFILTERED: testnets must appear.
const nets = {}; for (const it of cir) for (const a of (it.accepts || [])) nets[a.network] = (nets[a.network]||0) + 1;
if (!nets["eip155:84532"] || !nets["eip155:80002"])
  refuse("Circle harvest looks FILTERED — no testnet rows",
         `Base Sepolia ${nets["eip155:84532"]||0}, Polygon Amoy ${nets["eip155:80002"]||0}; expected both non-zero`);
console.log(`  circle harvest unfiltered ✅ (Base Sepolia ${nets["eip155:84532"]}, Polygon Amoy ${nets["eip155:80002"]})`);
catalogue(baz, "bazaar", cat); catalogue(cir, "circle", cat);

// ── the scan ─────────────────────────────────────────────────────────────────────────────────
// ⭐ ONE eth_getLogs per window for ALL addresses (topic arrays OR-match) — the census's own
// optimisation, re-verified below rather than assumed.
const pad = a => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const padded = addrs.map(pad);
const rows = []; const incomplete = []; let covered = 0, windows = 0;
for (let b = FROM; b <= TO; b += WINDOW) {
  const to = Math.min(b + WINDOW - 1, TO); let ok = true;
  for (const dir of ["in", "out"]) {
    const topics = dir === "in" ? [T0, null, padded] : [T0, padded, null];
    try {
      const logs = await rpc("eth_getLogs", [{ fromBlock:"0x"+b.toString(16), toBlock:"0x"+to.toString(16),
                                               address: USDC, topics }]);
      // 🚨 A truncated result carries NO error. Near-cap is unmeasured, not quiet.
      if (logs.length >= CAP) { ok = false; incomplete.push({ from:b, to, dir, err:`possible truncation: ${logs.length} >= CAP ${CAP}` }); }
      for (const l of logs) {
        const f = ("0x" + l.topics[1].slice(26)).toLowerCase();
        const t = ("0x" + l.topics[2].slice(26)).toLowerCase();
        const who = dir === "in" ? t : f; if (!cat[who]) continue;
        rows.push({ dir, seller:who, from:f, to:t, amt:BigInt(l.data).toString(),
                    blk:parseInt(l.blockNumber,16), tx:l.transactionHash, li:parseInt(l.logIndex,16) });
      }
    } catch (e) { ok = false; incomplete.push({ from:b, to, dir, err:String(e.message).slice(0,70) }); }
    await sleep(200);
  }
  if (ok) covered += (to - b + 1);
  windows++; process.stderr.write(`\r  scan: ${windows} windows, ${covered.toLocaleString()} blocks, ${rows.length} rows`);
}
process.stderr.write("\n");

// 🚨 REFUSE — see the discipline block. A partial distribution is wrong, not weak.
if (incomplete.length || covered !== (TO - FROM + 1))
  refuse("scan coverage incomplete — a truncated or failed window makes the distribution wrong, not merely partial",
         { covered, expected: TO - FROM + 1, incompleteWindows: incomplete.slice(0, 8) });
assertNonEmpty(windows, "no windows were scanned");

// a self-transfer matches BOTH passes; identify a log by tx+logIndex
const seen = new Set(); const uniq = [];
for (const r of rows) { const k = r.tx + "#" + r.li; if (seen.has(k)) continue; seen.add(k); uniq.push(r); }

// ── the census optimisation, re-verified for THIS address set ────────────────────────────────
// ⚠️ MEASURED, NOT ASSUMED: if topic-array matching behaved differently, every figure would be
// wrong and nothing in the output would look odd.
const inb = uniq.filter(r => r.dir === "in");
assertNonEmpty(inb.length, "no inbound transfers found — nothing to verify or histogram");
{
  const busiest = Object.entries(inb.reduce((m,r) => (m[r.seller]=(m[r.seller]||0)+1, m), {}))
                        .sort((a,b) => b[1]-a[1])[0];
  assertNonEmpty(busiest?.[1], "no address received anything — the optimisation cannot be discriminated");
  const [a] = busiest;
  const solo = await rpc("eth_getLogs", [{ fromBlock:"0x"+FROM.toString(16), toBlock:"0x"+(FROM+9_999).toString(16),
                                           address: USDC, topics:[T0, null, pad(a)] }]);
  const batchedHere = inb.filter(r => r.seller === a && r.blk <= FROM + 9_999).length;
  // ⭐ Non-emptiness gate FIRST: an equality over two zeros proves nothing, so say so and refuse.
  if (!solo.length && !batchedHere)
    refuse("verification window is empty for the busiest address — cannot discriminate",
           "0 === 0 is not evidence; widen the verification window rather than accepting a vacuous pass");
  const match = solo.length === batchedHere;
  console.log(`  topic-array check: ${a.slice(0,10)}… batched ${batchedHere} vs solo ${solo.length} — ${match ? "✅ match" : "🚨 MISMATCH"}`);
  if (!match) refuse("batched and per-address queries disagree — every figure in this run is suspect",
                     { address:a, batched:batchedHere, solo:solo.length });
}

// ── settlement type per inbound transfer ─────────────────────────────────────────────────────
const SEL = { "0xe3ee160e":"EIP-3009 transferWithAuthorization (x402 settlement)",
              "0x88b7ab63":"EIP-3009 transferWithAuthorization (bytes sig)",
              "0xa9059cbb":"plain transfer() — NOT an x402 settlement",
              "0x23b872dd":"transferFrom()" };
const txInfo = {}; const txs = [...new Set(inb.map(r => r.tx))];
let k = 0;
for (const t of txs) { const tx = await rpc("eth_getTransactionByHash", [t]);
  txInfo[t] = { submitter: tx.from.toLowerCase(), sel: tx.input.slice(0, 10),
                direct: (tx.to || "").toLowerCase() === USDC };
  if (++k % 25 === 0) process.stderr.write(`\r  tx detail: ${k}/${txs.length}`); await sleep(90); }
process.stderr.write(`\r  tx detail: ${txs.length}/${txs.length}\n`);

// ── report ───────────────────────────────────────────────────────────────────────────────────
const report = [];
for (const a of addrs) {
  const c = cat[a];
  const IN  = uniq.filter(r => r.dir === "in"  && r.seller === a);
  const OUTr= uniq.filter(r => r.dir === "out" && r.seller === a);
  const tot = IN.reduce((s,r) => s + BigInt(r.amt), 0n);
  const tiers = Object.keys(c.tiers).map(Number).sort((x,y) => x-y);

  console.log(`\n${"═".repeat(92)}`);
  console.log(`${a}   ${[...c.hosts].join(", ") || "(not listed in either directory)"}`);
  console.log(`⭐ CATALOGUE TILL: ${c.endpoints.size} endpoint(s) across ${tiers.length} price tier(s)` +
              `   [listed in: ${[...c.sources].join("+") || "neither index"}]`);
  console.log(`   inbound ${IN.length} transfers / ${(Number(tot)/1e6).toFixed(4)} USDC` +
              `   ·   outbound ${OUTr.length} / ${(Number(OUTr.reduce((s,r)=>s+BigInt(r.amt),0n))/1e6).toFixed(4)} USDC`);
  if (c.endpoints.size > 1)
    console.log(`   ⛔ inbound above is a CATALOGUE total. It is NOT any one endpoint's revenue.`);

  // histogram — the finding a mean destroys
  const hist = {}; for (const r of IN) hist[r.amt] = (hist[r.amt] || 0) + 1;
  console.log(`\n   amount histogram (${Object.keys(hist).length} distinct amounts):`);
  console.log(`     atomic         USDC     n    %tx      value   %val   endpoints listed at this price`);
  for (const amt of Object.keys(hist).map(BigInt).sort((x,y) => x<y?-1:x>y?1:0)) {
    const n = hist[amt], v = Number(amt * BigInt(n)) / 1e6;
    const at = c.tiers[amt.toString()];
    const label = at ? `${at.size}: ${[...at].slice(0,3).join(", ")}${at.size>3?" …":""}`
                     : "— no listed endpoint at this price";
    console.log(`     ${amt.toString().padStart(9)}  ${(Number(amt)/1e6).toFixed(4).padStart(9)} ${String(n).padStart(5)}` +
                `  ${(100*n/IN.length).toFixed(1).padStart(5)}% ${v.toFixed(4).padStart(10)}  ${(100*v/(Number(tot)/1e6)).toFixed(1).padStart(5)}%   ${label}`);
  }

  // senders — 131 from one address and from 131 addresses are different worlds
  const by = {};
  for (const r of IN) { (by[r.from] ||= { n:0, v:0n, sel:{} }); by[r.from].n++; by[r.from].v += BigInt(r.amt);
    const s = txInfo[r.tx]?.sel || "?"; by[r.from].sel[s] = (by[r.from].sel[s] || 0) + 1; }
  const S = Object.entries(by).sort((x,y) => y[1].n - x[1].n);
  const topShare = S.length ? 100 * S[0][1].n / IN.length : 0;
  console.log(`\n   ⭐ distinct senders: ${S.length}   (largest = ${topShare.toFixed(1)}% of transfers,` +
              ` ${S.length ? (100*Number(S[0][1].v)/Number(tot)).toFixed(1) : "0"}% of value)`);
  for (const [f, d] of S.slice(0, 12))
    console.log(`     ${f.slice(0,10)}…${f.slice(-6)}  ${String(d.n).padStart(4)} tx  ${(Number(d.v)/1e6).toFixed(4).padStart(9)} USDC   ` +
                Object.entries(d.sel).map(([s,n]) => `${n}× ${SEL[s] || s}`).join(" | "));
  if (S.length > 12) console.log(`     … and ${S.length - 12} more senders`);

  // ⭐ ROUND-TRIP: is the biggest inbound sender also where the outbound went? A mean hides this.
  const outTo = {}; for (const r of OUTr) outTo[r.to] = (outTo[r.to] || 0n) + BigInt(r.amt);
  if (OUTr.length) {
    console.log(`\n   outbound destinations:`);
    for (const [d, v] of Object.entries(outTo).sort((x,y) => Number(y[1] - x[1]))) {
      const back = by[d] ? `  ⭐ SAME ADDRESS as an inbound sender (sent in ${(Number(by[d].v)/1e6).toFixed(4)} USDC)` : "";
      console.log(`     ${d.slice(0,10)}…${d.slice(-6)}  ${(Number(v)/1e6).toFixed(4).padStart(9)} USDC${back}`);
    }
  }
  report.push({ payTo:a, hosts:[...c.hosts], sources:[...c.sources],
    endpoints:c.endpoints.size, priceTiers:tiers.length,
    inboundTransfers:IN.length, inboundUsdc:Number(tot)/1e6,
    outboundTransfers:OUTr.length, outboundUsdc:Number(OUTr.reduce((s,r)=>s+BigInt(r.amt),0n))/1e6,
    distinctSenders:S.length, largestSenderPctTransfers:Number(topShare.toFixed(1)),
    histogram:Object.fromEntries(Object.entries(hist).map(([amt,n]) =>
      [amt, { n, listedEndpoints: c.tiers[amt]?.size ?? 0 }])),
    outboundToInboundSenders: Object.keys(outTo).filter(d => by[d]) });
}

writeFileSync(OUT, JSON.stringify({
  status:"COMPLETE", chain:"Base (eip155:8453)", asset:USDC,
  fromBlock:FROM, toBlock:TO, blocks:TO-FROM+1, coveredBlocks:covered, windows,
  bazaarListings:baz.length, circleListings:cir.length, sellers:report }, null, 2));
console.log(`\n  written ${OUT}`);
console.log(`  ⛔ REMINDER: inbound is an upper bound on SETTLEMENTS, not calls (credits and Gateway`);
console.log(`     batching hide calls), and a catalogue total, not one endpoint's revenue.`);
