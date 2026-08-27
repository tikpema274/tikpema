// catalogue-effect.mjs — DOES THE CATALOGUE-TILL EFFECT CHANGE THE CENSUS'S HEADLINES,
// OR ONLY ANNOTATE THEM?
//
//   node scripts/x402-census/catalogue-effect.mjs           # scans, writes catalogue-effect-out.json
//   node scripts/x402-census/catalogue-effect.mjs --report   # re-reads that file, prints the analysis
//
// ═══ ⭐⭐ THE QUESTION THIS ANSWERS ═════════════════════════════════════════════════════════════
// seller-census.mjs counts ADDRESSES: "53 of 80 received nothing". payto-catalogue.mjs established
// that 63% of those 80 addresses serve MORE THAN ONE endpoint. So the same evidence restated in
// LISTINGS may say something different — and the whole point is that it does, ASYMMETRICALLY:
//
//   · ZEROS TRANSLATE. A till that received nothing means EVERY endpoint behind it received
//     nothing. No sharing assumption is needed; the claim only gets stronger at listing level.
//   · EARNERS DO NOT TRANSLATE. Endpoints SHARE price tiers, so one transfer marks a whole tier
//     as possibly-live. Measured: 7 transfers totalling $0.007, from ONE sender, "light" all 132
//     listings behind x402.quicknode.com's payTo. At listing level "received anything" spans
//     27–477 of 836 — a 17x range, which is not a headline.
//
// ⛔ NEITHER SIDE IS PROOF, AND THE CORRECTION MUST NOT TRADE ONE OVERCLAIM FOR ANOTHER:
//   · "lit" is an UPPER BOUND — shared tiers mean one transfer lights many listings.
//   · "dark" is NOT provable-dead — a prepaid CREDIT settlement (a different amount) or Circle
//     Gateway batching backs calls whose own price never touches the chain at all.
//
// ═══ 🚨 A COUNTING TRAP THIS SCRIPT WALKED INTO ONCE, RECORDED SO IT IS NOT REPEATED ═══════════
// Summing `endpoints per (payTo, price tier)` gives **1,107**, not 836: a listing with several
// `accepts` entries is counted once PER PRICE. The first run of this analysis reported 1,107
// listings and a 63.8% dark rate from it. The correct unit is the DISTINCT LISTING, and a listing
// is dark only if NONE of its own quoted prices ever arrived — 836 listings, 435 dark (52.0%).
// ⚠️ The wrong number looked entirely plausible and moved the headline in the same direction.
//
// ═══ REFUSAL DISCIPLINE — same as payto-catalogue.mjs ══════════════════════════════════════════
// Write-probe first · CAP guard · REFUSE rather than report a truncated count · every equality
// gated on non-emptiness first · the Circle harvest's testnet self-check travels with the data.

import { writeFileSync, readFileSync, existsSync } from "node:fs";
const OUT="catalogue-effect-out.json";
const REPORT_ONLY = process.argv.includes("--report");

const RPC="https://mainnet.base.org";
const USDC="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const T0="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
// ⭐ THE PUBLISHED WINDOW, VERBATIM — figures here are meant to be compared with the census.
const FROM=50_129_226, TO=50_431_626, WINDOW=4_000, CAP=9_000;
// what the published census reports, for the reproduction check
const CENSUS={addresses:80, listings:836, inbound:44_885};

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=async(m,p,t=6)=>{let e;for(let i=0;i<t;i++){try{
 const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})});
 const j=await r.json(); if(j.error) throw new Error(JSON.stringify(j.error).slice(0,90)); return j.result;
}catch(x){e=x; await sleep(1200*(i+1));}} throw e;};
function refuse(why,detail){ writeFileSync(OUT,JSON.stringify({status:"REFUSED",why,detail},null,2));
  console.error(`\n⛔ REFUSED TO REPORT — ${why}`);
  if(detail) console.error("   "+(typeof detail==="string"?detail:JSON.stringify(detail).slice(0,400)));
  process.exit(2); }
// ⭐⭐ NON-EMPTINESS BEFORE EQUALITY — `n === total` passes vacuously at 0 === 0.
function assertNonEmpty(n,what){ if(!n) refuse(`nothing to check: ${what}`,
  "an equality over an empty set passes vacuously — this run cannot discriminate, so it reports nothing"); return n; }
const pc=(a,b)=>b?(100*a/b).toFixed(1)+"%":"n/a";

// ── directory harvest ─────────────────────────────────────────────────────────────────────────
// 🚨 NO `circle` CLI: it silently appends `siwx=false`, which hid 165 of 1,003 listings including
// EVERY TESTNET ROW. The testnet self-check below is what proves the harvest was unfiltered.
async function harvestCircle(){
  let items=[], off=0;
  for(;;){ let d=null,err=null;
    for(let i=0;i<5;i++){ try{ const r=await fetch(`https://api.circle.com/v2/x402/discovery/resources?limit=100&offset=${off}`);
      d=await r.json(); if(!((d.data??d).items)) throw new Error(`no items (HTTP ${r.status})`); err=null; break;
    }catch(e){ err=e; await sleep(1000*(i+1)); } }
    if(err) refuse("Circle index harvest failed",String(err.message));
    const got=(d.data??d).items; items=items.concat(got); off+=got.length;
    process.stderr.write(`\r  circle: ${items.length}`); if(got.length<100) break; await sleep(120); }
  process.stderr.write("\n");
  const nets={}; for(const it of items) for(const a of (it.accepts||[])) nets[a.network]=(nets[a.network]||0)+1;
  if(!nets["eip155:84532"]||!nets["eip155:80002"])
    refuse("Circle harvest looks FILTERED — no testnet rows",
           `Base Sepolia ${nets["eip155:84532"]||0}, Polygon Amoy ${nets["eip155:80002"]||0}; expected both non-zero`);
  console.log(`  circle harvest unfiltered ✅ (Base Sepolia ${nets["eip155:84532"]}, Polygon Amoy ${nets["eip155:80002"]})`);
  return items;
}

// ── scan ──────────────────────────────────────────────────────────────────────────────────────
async function scan(){
  writeFileSync(OUT, JSON.stringify({status:"IN PROGRESS — not a result"}));   // write-probe first
  const cir=await harvestCircle();
  // one row per DISTINCT LISTING — see the counting-trap block above
  const listing={}, byAddr={};
  for(const it of cir) for(const a of (it.accepts||[])){
    if(a.network!=="eip155:8453") continue;
    const p=(a.payTo||"").toLowerCase(); if(!p) continue;
    const k=it.resource+"|"+p;
    (listing[k] ||= {res:it.resource, payTo:p, tiers:new Set(), rails:new Set(),
                     host:(()=>{try{return new URL(it.resource).host}catch{return""}})()});
    listing[k].tiers.add(String(a.amount)); listing[k].rails.add(a.extra?.name||"(none)");
    (byAddr[p] ||= {res:new Set(), tiers:new Set(), rails:new Set(), hosts:new Set()});
    byAddr[p].res.add(it.resource); byAddr[p].tiers.add(String(a.amount));
    byAddr[p].rails.add(a.extra?.name||"(none)");
    try{ byAddr[p].hosts.add(new URL(it.resource).host); }catch{}
  }
  const addrs=Object.keys(byAddr).sort();
  assertNonEmpty(addrs.length,"no Base payTo in the Circle index");
  const listings=Object.keys(listing).length;
  console.log(`\n▸ Base payTo ${addrs.length} (census ${CENSUS.addresses})   listings ${listings} (census ${CENSUS.listings})`);
  if(addrs.length!==CENSUS.addresses||listings!==CENSUS.listings)
    console.log(`  ⚠️ the index has DRIFTED from the published census — figures below are today's set, not its set`);

  const pad=a=>"0x"+"0".repeat(24)+a.slice(2).toLowerCase();
  const padded=addrs.map(pad);
  const st={}; for(const a of addrs) st[a]={in:0,inAmt:0n,out:0,outAmt:0n,hist:{},senders:new Set()};
  const incomplete=[]; let covered=0, windows=0;
  for(let b=FROM;b<=TO;b+=WINDOW){
    const to=Math.min(b+WINDOW-1,TO); let ok=true;
    for(const dir of ["in","out"]){
      const topics = dir==="in" ? [T0,null,padded] : [T0,padded,null];
      try{
        const logs=await rpc("eth_getLogs",[{fromBlock:"0x"+b.toString(16),toBlock:"0x"+to.toString(16),address:USDC,topics}]);
        // 🚨 a truncated result carries NO error — near-cap is unmeasured, not quiet
        if(logs.length>=CAP){ ok=false; incomplete.push({from:b,to,dir,err:`possible truncation: ${logs.length} >= CAP ${CAP}`}); }
        for(const l of logs){
          const f=("0x"+l.topics[1].slice(26)).toLowerCase(), t=("0x"+l.topics[2].slice(26)).toLowerCase();
          const who=dir==="in"?t:f; const r=st[who]; if(!r) continue;
          const v=BigInt(l.data);
          if(dir==="in"){ r.in++; r.inAmt+=v; r.hist[v.toString()]=(r.hist[v.toString()]||0)+1; r.senders.add(f); }
          else { r.out++; r.outAmt+=v; }
        }
      }catch(e){ ok=false; incomplete.push({from:b,to,dir,err:String(e.message).slice(0,70)}); }
      await sleep(190);
    }
    if(ok) covered+=(to-b+1);
    windows++; process.stderr.write(`\r  scan: ${windows} windows, ${covered.toLocaleString()} blocks`);
  }
  process.stderr.write("\n");
  // 🚨 REFUSE — a partial distribution is wrong, not weak
  if(incomplete.length||covered!==(TO-FROM+1))
    refuse("scan coverage incomplete — a truncated or failed window makes the distribution wrong, not merely partial",
           {covered, expected:TO-FROM+1, incompleteWindows:incomplete.slice(0,8)});
  assertNonEmpty(windows,"no windows were scanned");
  const totalIn=addrs.reduce((s,a)=>s+st[a].in,0);
  assertNonEmpty(totalIn,"no inbound transfers across any address — nothing to analyse");

  writeFileSync(OUT, JSON.stringify({ status:"COMPLETE", fromBlock:FROM, toBlock:TO,
    coveredBlocks:covered, windows, reproducesCensusInbound: totalIn===CENSUS.inbound,
    addrs: addrs.map(a=>({ a, inCnt:st[a].in, inAmt:st[a].inAmt.toString(), outCnt:st[a].out,
      outAmt:st[a].outAmt.toString(), senders:st[a].senders.size, hist:st[a].hist,
      endpoints:byAddr[a].res.size, tiers:[...byAddr[a].tiers], rails:[...byAddr[a].rails],
      hosts:[...byAddr[a].hosts] })),
    listings: Object.values(listing).map(l=>({ res:l.res, payTo:l.payTo, host:l.host,
      tiers:[...l.tiers], rails:[...l.rails] })) }, null, 2));
  console.log(`  inbound ${totalIn.toLocaleString()} transfers (census ${CENSUS.inbound.toLocaleString()}) — ${totalIn===CENSUS.inbound?"✅ reproduces":"⚠️ DIFFERS"}`);
  console.log(`  written ${OUT}`);
}

// ── report ────────────────────────────────────────────────────────────────────────────────────
function report(){
  if(!existsSync(OUT)) refuse("no scan output to report on",`run without --report first to produce ${OUT}`);
  const j=JSON.parse(readFileSync(OUT,"utf8"));
  if(j.status!=="COMPLETE") refuse("scan output is not a result",`status=${j.status}`);
  const A=j.addrs, L=j.listings;
  assertNonEmpty(A.length,"no addresses in the scan output");
  assertNonEmpty(L.length,"no listings in the scan output");
  const H={}, IN={}; for(const r of A){ H[r.a]=r.hist; IN[r.a]=r.inCnt; }
  const earners=A.filter(r=>r.inCnt>0), zeros=A.filter(r=>r.inCnt===0);
  const totalTx=A.reduce((s,r)=>s+r.inCnt,0), totalV=A.reduce((s,r)=>s+Number(BigInt(r.inAmt))/1e6,0);
  assertNonEmpty(totalTx,"no inbound transfers — nothing to report");
  const sum=(xs,f)=>xs.reduce((s,x)=>s+f(x),0);
  const railOf=a=>{ const s=new Set(A.find(r=>r.a===a)?.rails||[]);
    const v=s.has("USD Coin"), g=[...s].some(n=>/gateway/i.test(n));
    return v&&g?"both":v?"vanilla":g?"gateway":"neither"; };

  console.log(`\n${"═".repeat(92)}\nA. ADDRESS-LEVEL (the census's unit) vs LISTING-LEVEL (the same evidence)\n${"═".repeat(92)}`);
  console.log(`  addresses ${A.length}   listings ${L.length}   inbound ${totalTx.toLocaleString()} tx / ${totalV.toFixed(2)} USDC`);
  console.log(`  received something: ${earners.length}/${A.length} (${pc(earners.length,A.length)})   received NOTHING: ${zeros.length}/${A.length} (${pc(zeros.length,A.length)})`);
  const zSet=new Set(zeros.map(r=>r.a));
  const behindZero=L.filter(l=>zSet.has(l.payTo)).length;
  console.log(`\n  ⭐ listings behind an address that received NOTHING: ${behindZero} of ${L.length} (${pc(behindZero,L.length)})`);
  console.log(`     listings behind an address that received something: ${L.length-behindZero} of ${L.length} (${pc(L.length-behindZero,L.length)})`);
  console.log(`     ⛔ the second figure is NOT "listings that earned" — see C.`);

  console.log(`\n${"═".repeat(92)}\nB. THE ZEROS — single endpoint, or a whole catalogue that earned nothing?\n${"═".repeat(92)}`);
  console.log(`  single-endpoint ${zeros.filter(r=>r.endpoints===1).length}   catalogue tills ${zeros.filter(r=>r.endpoints>1).length}` +
              `   largest zero-receipt catalogue: ${Math.max(0,...zeros.map(r=>r.endpoints))} endpoints`);
  for(const r of [...zeros].sort((a,b)=>b.endpoints-a.endpoints).slice(0,6))
    console.log(`    ${r.a.slice(0,10)}…${r.a.slice(-6)}  ${String(r.endpoints).padStart(3)} endpoints, ${r.tiers.length} tiers   ${r.hosts[0]||""}   [${railOf(r.a)}]`);

  console.log(`\n${"═".repeat(92)}\nC. THE ASYMMETRY — why zeros translate to services and earners do not\n${"═".repeat(92)}`);
  let dark=0, darkZeroTill=0;
  const perAddr={};
  for(const l of L){ const h=H[l.payTo]||{};
    const lit=l.tiers.some(t=>h[t]);
    (perAddr[l.payTo] ||= {tot:0,dark:0}); perAddr[l.payTo].tot++;
    if(!lit){ dark++; perAddr[l.payTo].dark++; if(IN[l.payTo]===0) darkZeroTill++; } }
  console.log(`  listings where NO price they quote ever arrived at their payTo : ${dark} of ${L.length} (${pc(dark,L.length)})`);
  console.log(`  listings where at least one of their prices did arrive         : ${L.length-dark} of ${L.length} (${pc(L.length-dark,L.length)})`);
  console.log(`    of the dark: ${darkZeroTill} behind a till that received nothing at all;` +
              ` ${dark-darkZeroTill} behind a till that DID earn — the shop took money, this price never arrived`);
  const worst=Object.entries(perAddr).filter(([a])=>IN[a]>0).sort((x,y)=>y[1].dark-x[1].dark)[0];
  if(worst) console.log(`    worst earning catalogue: ${worst[0].slice(0,10)}…${worst[0].slice(-6)} — ${worst[1].dark} of ${worst[1].tot} listings dark`);
  // ⭐ the concrete demonstration that "lit" is near-worthless as evidence
  const cheap=earners.filter(r=>r.endpoints>=20).sort((a,b)=>a.inCnt-b.inCnt)[0];
  if(cheap){ const lit=L.filter(l=>l.payTo===cheap.a && l.tiers.some(t=>(H[cheap.a]||{})[t])).length;
    console.log(`\n  ⭐ WHY "lit" IS AN UPPER BOUND, concretely:`);
    console.log(`     ${cheap.a.slice(0,10)}…${cheap.a.slice(-6)} (${cheap.hosts[0]||""}) received ${cheap.inCnt} transfers` +
                ` / ${(Number(BigInt(cheap.inAmt))/1e6).toFixed(4)} USDC from ${cheap.senders} sender(s)`);
    console.log(`     — and that lights ${lit} of its ${cheap.endpoints} listings, because they share price tiers.`); }
  console.log(`\n  ⛔ AND "dark" IS NOT PROVABLE-DEAD: prepaid credits and Gateway batching back calls`);
  console.log(`     whose own price never touches the chain. Neither bound may be dropped.`);

  console.log(`\n${"═".repeat(92)}\nD. THE TOP-1 ADDRESS — one tier, or spread across the catalogue?\n${"═".repeat(92)}`);
  const t=[...earners].sort((a,b)=>b.inCnt-a.inCnt)[0];
  const th=Object.entries(t.hist).sort((a,b)=>b[1]-a[1]);
  assertNonEmpty(th.length,"top-1 address has no histogram");
  console.log(`  ${t.a}  ${t.hosts.join(",")}`);
  console.log(`  ${t.inCnt.toLocaleString()} tx = ${pc(t.inCnt,totalTx)} of ALL census transfers;` +
              ` ${(Number(BigInt(t.inAmt))/1e6).toFixed(2)} USDC = ${pc(Number(BigInt(t.inAmt))/1e6,totalV)} of value`);
  console.log(`  catalogue: ${t.endpoints} endpoints, ${t.tiers.length} tiers, ${t.senders} distinct senders`);
  const modalAmt=th[0][0];
  const modalListings=L.filter(l=>l.payTo===t.a && l.tiers.includes(modalAmt)).length;
  for(const [amt,n] of th.slice(0,6))
    console.log(`    ${amt.padStart(10)} = $${(Number(amt)/1e6).toFixed(4).padStart(9)}  ${String(n).padStart(6)} tx ${pc(n,t.inCnt).padStart(7)}` +
                `   ${t.tiers.includes(amt)?`${L.filter(l=>l.payTo===t.a&&l.tiers.includes(amt)).length} listing(s) at this price`:"— NOT a listed price"}`);
  console.log(`\n  ⭐ ${pc(th[0][1],t.inCnt)} of its transfers sit on ONE tier ($${(Number(modalAmt)/1e6).toFixed(4)}),` +
              ` quoted by ${modalListings} of the ${L.length} listings.`);
  console.log(`     That single tier is ${pc(th[0][1],totalTx)} of ALL ${totalTx.toLocaleString()} transfers in the census.`);

  console.log(`\n${"═".repeat(92)}\nE. LISTING-LEVEL, split by the settlement rail the listing declares\n${"═".repeat(92)}`);
  const agg={};
  for(const l of L){ const rl=railOf(l.payTo), h=H[l.payTo]||{};
    (agg[rl] ||= {tot:0,dark:0}); agg[rl].tot++; if(!l.tiers.some(t=>h[t])) agg[rl].dark++; }
  console.log(`  rail       listings      dark (no price of theirs arrived)`);
  for(const [k,d] of Object.entries(agg).sort((a,b)=>b[1].tot-a[1].tot))
    console.log(`  ${k.padEnd(10)} ${String(d.tot).padStart(8)} ${(String(d.dark)+" ("+pc(d.dark,d.tot)+")").padStart(30)}`);
  console.log(`\n  ⚠️ For Gateway-declaring listings a dark result is UNINFORMATIVE, not negative:`);
  console.log(`     Gateway settles net positions in bulk, so real sales can leave no transfer at all.`);
}

if(REPORT_ONLY) report(); else { await scan(); report(); }
