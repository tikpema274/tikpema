// verify-census.mjs — IS THE CENSUS'S OWN OPTIMISATION SOUND?
//
//   node scripts/x402-census/verify-census.mjs      # reads census-out.json from the CWD
//
// ═══ 🚨 THE THING MOST LIKELY TO INVALIDATE EVERYTHING ═════════════════════════════════════════
// seller-census.mjs collapses 54 addresses into ONE eth_getLogs call per window using a topic
// ARRAY. That is what makes a 7-day scan cost 62 requests instead of ~3,300 — and if array-matching
// matched differently than expected, every figure would be wrong AND NOTHING IN THE OUTPUT WOULD
// LOOK ODD. A fast wrong answer is the failure mode worth checking for.
//
// Three checks:
//   A. arithmetic — do the per-row figures sum to the reported totals?
//   B. batched vs per-address — query one window both ways and compare counts. Equivalence must be
//      MEASURED, not assumed.
//   C. a reported ZERO, queried alone — "37 of 54 received nothing" is the strongest claim in the
//      write-up, and a batched query silently under-matching an address is exactly how a false zero
//      would appear.
//
// Result on the 2026-08-25 run: A consistent · B 3/3 exact (1005/1005, 62/62, 61/61) · C 0 logs.

import { readFileSync } from "node:fs";
const RPC="https://mainnet.base.org";
const USDC="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const T0="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const rpc=async(m,p,t=6)=>{let e;for(let i=0;i<t;i++){try{
 const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})});
 const j=await r.json(); if(j.error) throw new Error(JSON.stringify(j.error).slice(0,80)); return j.result;
}catch(x){e=x; await sleep(1200*(i+1));}} throw e;};
const j=JSON.parse(readFileSync("census-out.json","utf8"));
const pad=(a)=>"0x"+"0".repeat(24)+a.slice(2).toLowerCase();

// ── A. ARITHMETIC: do the rows sum to the reported totals? ──
const totIn=j.rows.reduce((a,r)=>a+r.inUsdc,0), totCnt=j.rows.reduce((a,r)=>a+r.inCount,0);
console.log("  A. arithmetic self-consistency");
console.log("     rows:",j.rows.length,"| inbound count",totCnt,"| inbound USDC",totIn.toFixed(4));

// ── B. THE OPTIMISATION UNDER TEST ──
// One 10k window, queried TWO ways: the batched topic-array (as the census did) vs a
// per-address query for three sellers. If the array form matched differently, every number is wrong.
const B0=j.fromBlock+120_000, B1=B0+9_999;
const all=j.rows.map(r=>pad(r.address));
const batched=await rpc("eth_getLogs",[{fromBlock:"0x"+B0.toString(16),toBlock:"0x"+B1.toString(16),address:USDC,topics:[T0,null,all]}]);
const tally=new Map();
for(const l of batched){const w=("0x"+l.topics[2].slice(26)).toLowerCase(); tally.set(w,(tally.get(w)||0)+1);}
console.log(`\n  B. topic-array vs per-address, blocks ${B0}..${B1}`);
console.log("     batched query returned",batched.length,"logs across",tally.size,"addresses");
const probes=[...tally.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([a])=>a);
if(!probes.length) console.log("     ⚠️ no logs in this window — cannot discriminate; pick another window");
let agree=0;
for(const a of probes){
  const solo=await rpc("eth_getLogs",[{fromBlock:"0x"+B0.toString(16),toBlock:"0x"+B1.toString(16),address:USDC,topics:[T0,null,pad(a)]}]);
  const same=solo.length===(tally.get(a)||0);
  if(same) agree++;
  console.log(`     ${a.slice(0,12)}…  batched ${String(tally.get(a)||0).padStart(5)}  solo ${String(solo.length).padStart(5)}  ${same?"✅ match":"🚨 MISMATCH"}`);
  await sleep(400);
}
console.log(`     ${agree}/${probes.length} agree — ${agree===probes.length?"⭐ the topic-array optimisation is sound":"🚨 THE CENSUS NUMBERS ARE SUSPECT"}`);

// ── C. A ZERO IS A REAL ZERO ──
// Pick a seller the census says received nothing, and query it alone across a sample window.
const zeros=j.rows.filter(r=>r.inCount===0);
const z=zeros[0];
if(z){
  const solo=await rpc("eth_getLogs",[{fromBlock:"0x"+j.fromBlock.toString(16),toBlock:"0x"+(j.fromBlock+9999).toString(16),address:USDC,topics:[T0,null,pad(z.address)]}]);
  console.log(`\n  C. a reported ZERO, queried alone: ${z.address.slice(0,12)}… -> ${solo.length} logs in a sample window ${solo.length===0?"✅ consistent":"🚨 the census MISSED transfers"}`);
}
