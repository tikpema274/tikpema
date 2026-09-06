// bridge-discover-run.mjs — DISCOVERY-ONLY. Reads the chain and the store; WRITES NOTHING.
// Usage: node scripts/bridge-discover-run.mjs [--from <block>] [--to <block>]
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { getStore } from "@netlify/blobs";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blockWindows, joinBurns, diffUndocumented, discoveredReceipt, sweepVerdict,
         TOKEN_MESSENGER_V2, DISCOVER_OUTCOME } from "../netlify/functions/_bridge-discover.mjs";
import { BRIDGE_CONTRACT } from "../netlify/functions/_bridge.mjs";
import { CONTRACTS } from "../netlify/functions/_arc.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };

// ⭐⭐ ARC'S PUBLIC RPC IS THROTTLED, AND "Request exceeds defined limit" IS THE THROTTLE, NOT A
// QUERY-SIZE ERROR. MEASURED: two full scans failed on DIFFERENT window sets (42-49 vs 45-69) and
// each missed a DIFFERENT known burn. A failure that moves between runs of the same query is rate
// limiting. ⚠️ Narrowing the filter did not fix it and was never going to.
// ⛔ WITHOUT BACKOFF A PARTIAL SCAN IS THE NORMAL OUTCOME on this endpoint — which is precisely why
// the verdict must be per-TICK. A sweeper that reported "none" on a partial scan would be wrong
// most of the time, and silently.
async function withBackoff(fn, tries = 5) {
  let wait = 500;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2.5, 12000);
    }
  }
}
const c = createPublicClient({ transport: http("https://rpc.testnet.arc.network") });
const cfg = JSON.parse(readFileSync(join(homedir(), ".config", "netlify", "config.json"), "utf8"));
const token = cfg.users[Object.keys(cfg.users)[0]].auth.token;
const siteID = JSON.parse(readFileSync(".netlify/state.json", "utf8")).siteId;
const store = getStore({ name: "bridge-receipts", siteID, token });

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const DFB = parseAbiItem("event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)");

// ── the store: owners to scan, and every burnHash already recorded ──────────────────────────────
const { blobs } = await store.list({ prefix: "o/" });
const owners = new Set(), recorded = new Set();
for (const b of blobs) {
  const r = await store.get(b.key, { type: "json" }).catch(() => null);
  if (!r) continue;
  if (r.owner) owners.add(String(r.owner).toLowerCase());
  if (r.burnHash) recorded.add(String(r.burnHash).toLowerCase());
}
const ownerList = [...owners];
console.log(`store: ${ownerList.length} owners indexed, ${recorded.size} burnHashes already recorded`);

const head = await c.getBlockNumber();
const from = BigInt(arg("--from", (head - 1500000n).toString()));
const to = BigInt(arg("--to", head.toString()));
const windows = blockWindows(from, to);
console.log(`scanning blocks ${from}..${to} in ${windows.length} window(s) of ≤9,999\n`);

let served = 0, transfersFound = 0;
const candidates = [];
for (const [i, w] of windows.entries()) {
  try {
    const t = await withBackoff(() => c.getLogs({ address: CONTRACTS.USDC, event: TRANSFER,
      args: { from: ownerList, to: BRIDGE_CONTRACT }, fromBlock: w.fromBlock, toBlock: w.toBlock }));
    // ⭐ the DepositForBurn read is only paid for when a Transfer actually matched
    let d = [];
    if (t.length) {
      transfersFound += t.length;
      // ⭐ NARROWED ON THE INDEXED TOPICS. Unfiltered, this returns every DepositForBurn on Arc in
      // the window and the RPC answers "Request exceeds defined limit" — which correctly made the
      // whole tick UNREADABLE, but scanned nothing.
      // ⭐⭐ AND THE FILTER IS `depositor`, THE VERY FIELD THE OWNER BINDING MAY NOT USE. It is
      // useless for attribution BECAUSE it is always the Kit, which is exactly what makes it a
      // perfect filter. Same fact, opposite conclusions — see joinBurns.
      d = await withBackoff(() => c.getLogs({ address: TOKEN_MESSENGER_V2, event: DFB,
        args: { burnToken: CONTRACTS.USDC, depositor: BRIDGE_CONTRACT },
        fromBlock: w.fromBlock, toBlock: w.toBlock }));
    }
    served++;
    candidates.push(...joinBurns({
      transfers: t.map((l) => ({ transactionHash: l.transactionHash, from: l.args.from, to: l.args.to,
        value: l.args.value.toString(), blockNumber: l.blockNumber })),
      deposits: d.map((l) => ({ transactionHash: l.transactionHash, depositor: l.args.depositor,
        amount: l.args.amount.toString(), maxFee: l.args.maxFee.toString(),
        destinationDomain: l.args.destinationDomain, mintRecipient: "0x" + l.args.mintRecipient.slice(26) })),
    }));
  } catch (e) {
    console.log(`  window ${i + 1}/${windows.length} (${w.fromBlock}..${w.toBlock}) ❌ ${String(e.shortMessage || e.message).slice(0, 60)}`);
  }
  if ((i + 1) % 25 === 0) process.stdout.write(`  …${i + 1}/${windows.length} windows, ${candidates.length} candidates\n`);
  await new Promise((r) => setTimeout(r, 150));
}

const undocumented = diffUndocumented(candidates, recorded);
const v = sweepVerdict({ windowsAttempted: windows.length, windowsServed: served, discovered: undocumented });

console.log(`\n${"═".repeat(76)}`);
console.log(`OUTCOME  ${v.outcome.toUpperCase()}   advanceCursor=${v.advanceCursor}`);
console.log(`${v.detail}`);
console.log(`burn candidates joined: ${candidates.length}  (from ${transfersFound} owner→Kit transfers)`);
console.log(`already recorded, EXCLUDED by the diff: ${candidates.length - undocumented.length}`);
console.log(`${"═".repeat(76)}`);
for (const u of undocumented) {
  const r = discoveredReceipt(u);
  console.log(`\n🚨 UNDOCUMENTED  ${u.burnHash}`);
  console.log(`   block ${u.blockNumber}  owner ${r.owner}`);
  console.log(`   ${r.amountRequested} USDC -> ${r.destinationLabel}   fee(ceiling) ${r.feeDisclosed}`);
  console.log(`   origin=${r.origin} feeIsCeiling=${r.feeIsCeiling} intentId=${"intentId" in r ? "CLAIMED 🚨" : "none ✅"}`);
}
const excluded = candidates.filter((x) => !undocumented.includes(x)).map((x) => x.burnHash.slice(0, 12));
console.log(`\nexcluded (already recorded): ${excluded.join(", ") || "none"}`);
console.log("\n⛔ DISCOVERY ONLY — nothing was written.");
