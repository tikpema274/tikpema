import { getStore } from "@netlify/blobs";
import { createPublicClient, http } from "viem";
import { blobsCredentials } from "./shared/blobs-cli.mjs";
import { CURSOR_KEY } from "./shared/discover-cursor.mjs";
import { ARC } from "./netlify/functions/_arc.mjs";
const c=blobsCredentials(); const s=getStore({name:"bridge-discover",siteID:c.siteID,token:c.token});
const rpc=createPublicClient({transport:http(ARC.rpc)});
let lastAt=null, ticks=0;
console.log("sampling every 60s — reporting only CHANGES and anomalies");
for(let i=0;i<50;i++){
  const cur=await s.get(CURSOR_KEY,{type:"json"}).catch(()=>null);
  let head=null; try{ head=await rpc.getBlockNumber(); }catch{}
  if(cur && cur.at!==lastAt){
    ticks++;
    const lag = head!=null ? (head - BigInt(cur.cursor)) : null;
    const adv = lastAt==null ? "—" : "advanced";
    console.log(`TICK ${ticks}  at=${cur.at}  cursor=${cur.cursor}  head=${head ?? "?"}  lag=${lag ?? "?"} blocks  ${adv}`);
    lastAt=cur.at;
  } else if(cur && head!=null){
    const lag = head - BigInt(cur.cursor);
    // ⭐ a cursor that stops advancing while lag GROWS past one tick's span is the alarm
    if(lag > 20000n) console.log(`⚠️  ${new Date().toISOString().slice(11,19)} cursor STALLED — lag ${lag} blocks, last write ${cur.at}`);
  }
  await new Promise(r=>setTimeout(r,60000));
}
console.log(`\n── ${ticks} tick(s) observed over ~${Math.round(50)} minutes ──`);
