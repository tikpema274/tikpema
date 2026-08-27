// seller-census.mjs — WHAT DO x402 SELLERS ACTUALLY RECEIVE? Seven days, on-chain, Base.
//
//   node scripts/x402-census/seller-census.mjs      # writes census-out.json in the CWD
//
// PREREQUISITE — the seller list. HARVEST THE INDEX DIRECTLY. DO NOT USE THE `circle` CLI:
//
//   const base = "https://api.circle.com/v2/x402/discovery/resources";
//   let items = [], off = 0;
//   for (;;) {                                        // paginate until a SHORT page
//     const d   = await (await fetch(`${base}?limit=100&offset=${off}`)).json();
//     const got = (d.data ?? d).items ?? [];
//     items = items.concat(got); off += got.length;
//     if (got.length < 100) break;
//   }
//   # then every distinct `accepts[].payTo` where network === "eip155:8453",
//   # into sellers-base.json as a JSON array of addresses.
//
// ═══ 🚨 NO `siwx` PARAMETER — AND THAT IS THE WHOLE POINT OF DOING IT THIS WAY ═══════════════════
// `circle services search` silently appends `siwx=false`. It is NOT in the CLI's `--help`; it is
// visible only by reading the CLI's own `dist/index.js`. On 2026-08-27 that one undeclared
// parameter hid **165 of 1,003 listings — including EVERY TESTNET ROW**.
// ⚠️ A reproducer who "simplifies" this back to `circle services search` gets a DIFFERENT
// DENOMINATOR and is given no signal that it changed. The counts still look plausible. Do not.
//
// ═══ ⭐ SELF-CHECK THAT PROVES THE HARVEST WAS UNFILTERED ════════════════════════════════════════
// Count networks across every `accepts[]` entry before trusting the seller list. TESTNETS MUST
// APPEAR — they are the rows `siwx=false` removes:
//
//     eip155:84532 (Base Sepolia)   396      <- must be present
//     eip155:80002 (Polygon Amoy)   396      <- must be present
//
// If either is 0, THE HARVEST WAS FILTERED and the denominator is wrong — stop and fix the fetch
// rather than reporting the count. The 2026-08-25 run behind the published census showed both at
// 396, across 1,009 listings, yielding the 80 distinct Base `payTo` that document reports.
//
// ═══ ⭐ WHY THIS IS MEASURABLE AT ALL ═══════════════════════════════════════════════════════════
// An x402 endpoint publishes a `payTo` address in its 402 challenge. Those addresses are public,
// so what sellers RECEIVE can be measured without asking anyone and without buying anything.
//
// ═══ ⭐⭐ THE OPTIMISATION THAT MAKES A 7-DAY WINDOW FEASIBLE ═══════════════════════════════════
// `eth_getLogs` accepts an ARRAY in a topic position (OR-matching). All 80 recipients therefore
// collapse into ONE query per block-window: 80 addresses x 76 windows x 2 directions would be
// 12,160 requests; this is 152.
// ⚠️ VERIFIED, NOT ASSUMED — verify-census.mjs re-queries individual addresses in one window and
// compares against the batched tally. If array-matching behaved differently, every number here
// would be wrong, and nothing in the output would look odd.
//
// ═══ 🚨 WHAT IS MEASURED, AND WHAT IT IS NOT ═══════════════════════════════════════════════════
// · Matched on the TOKEN CONTRACT ADDRESS, not on the event topic alone.
// · BOTH DIRECTIONS. A seller that earns and withdraws looks identical to a dead one if you only
//   read balances; outbound is what rules that out.
// · AN INBOUND TRANSFER IS NOT A PURCHASE. Funding, refunds and unrelated transfers are
//   indistinguishable at this resolution. Every count is an UPPER BOUND on sales.
// · COVERAGE IS TRACKED PER WINDOW. If a window fails the run is marked INCOMPLETE rather than
//   reporting a partial count as a total.
// · 🚨 AND A NEAR-CAP RETURN COUNTS AS A FAILURE. A truncated `eth_getLogs` returns FEWER logs
//   with NO error, so a silent cap looks exactly like a quiet week. `CAP` marks any window
//   returning >= CAP logs INCOMPLETE. Without it, absence reads as safety.
//
// ⚠️ A WRITE-PROBE RUNS BEFORE ANY SCANNING. An early version of this script completed EVERY
// window — minutes of scanning — and then threw on its final write line, discarding everything.
// Expensive work must not be gated on an untested cheap step at the end.

import { readFileSync, writeFileSync } from "node:fs";
// ⭐ WRITE-PROBE FIRST. An early run completed every window — minutes of scanning — and then threw
// on the final write line (require() in an .mjs with top-level await), discarding everything.
// The expensive work must not be gated on an untested cheap step at the end.
writeFileSync("census-out.json", JSON.stringify({ status: "IN PROGRESS — not a result" }));
const RPC="https://mainnet.base.org";
const USDC="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const T0="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const rpc=async(m,p,t=6)=>{let e;for(let i=0;i<t;i++){try{
 const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})});
 const j=await r.json(); if(j.error) throw new Error(JSON.stringify(j.error).slice(0,90)); return j.result;
}catch(x){e=x; await sleep(1200*(i+1));}} throw e;};

const sellers=JSON.parse(readFileSync("sellers-base.json","utf8"));
const pad=(a)=>"0x"+"0".repeat(24)+a.slice(2).toLowerCase();
const padded=sellers.map(pad);
const byAddr=new Map(sellers.map(a=>[a.toLowerCase(),{in:0,inAmt:0n,out:0,outAmt:0n}]));

const head=parseInt(await rpc("eth_blockNumber",[]),16);
// ⭐ THESE ARE THE PARAMETERS OF THE PUBLISHED RUN, not defaults. 4,000-block windows over
// 302,401 blocks give the 76 windows per direction that docs/x402-seller-census-2026-08-25.md
// reports. ⚠️ An earlier committed value of 9_999 would have produced ~31 windows — a DIFFERENT
// SCAN from the published one, silently, from the same file.
const WINDOW=4_000, CAP=9_000, DAYS=7, BLOCKS_PER_DAY=43_200;   // Base ~2s blocks
const FROM=head-DAYS*BLOCKS_PER_DAY;
let covered=0, incomplete=[], windows=0;

// ⭐ ONE query per window for ALL sellers: eth_getLogs accepts an ARRAY in a topic position (OR).
// 80 addresses x 76 windows x 2 directions would be 12,160 requests; this is 152.
for(let b=FROM;b<=head;b=b+WINDOW){
  const to=Math.min(b+WINDOW-1,head);
  let okBoth=true;
  for(const dir of ["in","out"]){
    const topics = dir==="in" ? [T0,null,padded] : [T0,padded,null];
    try{
      const logs=await rpc("eth_getLogs",[{fromBlock:"0x"+b.toString(16),toBlock:"0x"+to.toString(16),address:USDC,topics}]);
      // 🚨 A truncated result carries no error — treat a near-cap return as unmeasured, not as data.
      if(logs.length>=CAP){ okBoth=false; incomplete.push({from:b,to,dir,err:`possible truncation: ${logs.length} logs >= CAP ${CAP}`}); }
      for(const l of logs){
        const who=("0x"+l.topics[dir==="in"?2:1].slice(26)).toLowerCase();
        const rec=byAddr.get(who); if(!rec) continue;
        const v=BigInt(l.data);
        if(dir==="in"){rec.in++; rec.inAmt+=v;} else {rec.out++; rec.outAmt+=v;}
      }
    }catch(e){ okBoth=false; incomplete.push({from:b,to,dir,err:String(e.message).slice(0,70)}); }
    await sleep(220);
  }
  if(okBoth) covered+=(to-b+1);
  windows++;
  process.stderr.write(`\r  ${windows} windows, ${covered.toLocaleString()} blocks covered`);
}
process.stderr.write("\n");
const startBlk=await rpc("eth_getBlockByNumber",["0x"+FROM.toString(16),false]);
const endBlk=await rpc("eth_getBlockByNumber",["0x"+head.toString(16),false]);
const out={ chain:"Base (eip155:8453)", asset:USDC, sellers:sellers.length,
  fromBlock:FROM, toBlock:head, blocks:head-FROM+1, coveredBlocks:covered,
  complete: incomplete.length===0, incompleteWindows: incomplete,
  fromTime:new Date(parseInt(startBlk.timestamp,16)*1000).toISOString(),
  toTime:new Date(parseInt(endBlk.timestamp,16)*1000).toISOString(),
  rows:[...byAddr.entries()].map(([a,r])=>({address:a,inCount:r.in,inUsdc:Number(r.inAmt)/1e6,outCount:r.out,outUsdc:Number(r.outAmt)/1e6})) };
writeFileSync("census-out.json",JSON.stringify(out,null,2));
console.log("  written census-out.json");
