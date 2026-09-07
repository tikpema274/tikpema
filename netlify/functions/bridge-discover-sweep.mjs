import { getStore } from "@netlify/blobs";
import { createPublicClient, http, parseAbiItem } from "viem";
import { connectBlobs } from "./_blobs.mjs";
import { json, ARC, CONTRACTS } from "./_arc.mjs";
import { BRIDGE_CONTRACT } from "./_bridge.mjs";
import { receiptKey, isStranded, BRIDGE_RECEIPTS_STORE } from "./_bridge-receipts.mjs";
import {
  blockWindows, joinBurns, diffUndocumented, discoveredReceipt, sweepVerdict,
  isSettleable, scanOwnerSet, operatorWalletReport, TOKEN_MESSENGER_V2, DISCOVER_OUTCOME,
} from "./_bridge-discover.mjs";
import { nextScanRange, nextCursor, CURSOR_KEY, MAX_WINDOWS_PER_TICK } from "../../shared/discover-cursor.mjs";

// bridge-discover-sweep — FIND BURNS THE RECORD LAYER NEVER SAW, ON A SCHEDULE.
//
// Scheduled in netlify.toml alongside bridge-mint-sweep (an in-code `export const config` is NOT
// picked up by a CLI deploy — the same trap every scheduled function here carries).
//
// ═══ ⭐⭐ WHY THIS HAD TO BECOME A CRON ════════════════════════════════════════════════════════
// The self-signed bridge leaves its burn hash in the browser between signing and promote. If the tab
// closes, the server never learns it and NOTHING recovers it — the settler cannot help, because a
// receipt with no burnHash has nothing to settle. Discovery closes that, but until now it existed
// only as a hand-run script, which means recovery depended on someone remembering to look. The
// panel's own hazard note says "we lose the record of it"; that sentence is only as true as this
// schedule, and the sentence must not be softened before the schedule exists.
//
// ═══ ⛔⛔ IT WRITES, AND THAT DIVERGES FROM bridge-mint-sweep DELIBERATELY ═════════════════════
// That sweeper owns no writes because SETTLING needs a single-flight lease and a multi-minute poll,
// so it delegates to a background function. Writing a discovered receipt is one `setJSON` with no
// lease and no poll, and the "no existing key" gate makes it idempotent — two overlapping ticks cost
// a wasted read, never a duplicate. Delegating would add a hop and a second failure surface for no
// property gained. ⚠️ Stated because a reader who knows the sibling will expect the other shape.
//
// ═══ ⚠️⚠️ WHAT SIX CLEAN TICKS DO **NOT** PROVE — READ BEFORE TRUSTING THIS ══════════════════
// MEASURED 2026-09-07, 08:10-09:00: six consecutive ticks, 793-842 blocks each, lag 25-140 blocks,
// no stall and no held cursor. That proves the schedule FIRES and the cursor advances CONTIGUOUSLY.
//
// ⛔ IT PROVES NOTHING ABOUT THE PER-TICK HOLD. Every one of those ticks was complete, so the
// UNREADABLE branch never ran. It is mutation-proven (advancing on an unreadable tick fails 4
// assertions) and it was exercised by hand during backfill — 55 of 151 windows failed and the
// verdict correctly refused to advance — but it has NEVER FIRED ON THE CRON.
//
// 🚨 AND THE CONDITION MAY BE RARE ENOUGH TO BE FIRST SEEN IN AN INCIDENT. A steady-state tick reads
// ~800 blocks in ONE window; the throttling that produced "Request exceeds defined limit" appeared
// under a 151-window backfill. The cheap path may simply never provoke it — which means the first
// real hold could arrive during whatever outage makes windows fail, i.e. exactly when nobody wants
// to be discovering whether the rule works. ⭐ Six green ticks must not be read as covering this;
// they are a different claim about a different branch. [[absence-must-never-read-as-safe]]
//
// ═══ ⛔ THE PER-TICK RULE, WIRED NOT REINVENTED ═══════════════════════════════════════════════
// `sweepVerdict` decides `advanceCursor`; this function obeys it. One failed window makes the tick
// UNREADABLE, nothing is written to the cursor, and the range is rescanned next tick. Findings from
// the served windows are still WRITTEN — a receipt for a burn we did read is not made less true by a
// window we could not.

const STORE = "bridge-discover";
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const DFB = parseAbiItem("event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)");

export const handler = async (event) => {
  if (event?.blobs) connectBlobs(event);
  const started = Date.now();
  const cursorStore = getStore(STORE);
  const receipts = getStore(BRIDGE_RECEIPTS_STORE);
  const c = createPublicClient({ transport: http(ARC.rpc) });

  // ── who to look at: store-derived ∪ operator-derived ────────────────────────────────────────
  let owners = [], recorded = new Set();
  try {
    const { blobs } = await receipts.list({ prefix: "o/" });
    const seen = new Set();
    for (const b of blobs) {
      const r = await receipts.get(b.key, { type: "json" }).catch(() => null);
      if (r?.owner) seen.add(String(r.owner).toLowerCase());
      if (r?.burnHash) recorded.add(String(r.burnHash).toLowerCase());
    }
    owners = scanOwnerSet([...seen]);
  } catch (e) {
    // ⛔ AN UNREADABLE STORE IS NOT "NO OWNERS". Scanning zero owners would find zero burns and
    // report a clean tick — the exact absence-reads-as-safe shape. Refuse the tick instead.
    console.error(`[discover-sweep] DEGRADED — could not list the receipt store: ${e?.message}`);
    return json(200, { ok: false, reason: "store-unreadable" });
  }
  const opReport = operatorWalletReport();
  if (opReport.missing.length) {
    console.log(`[discover-sweep] operator wallets resolved ${opReport.resolved.length}/${opReport.resolved.length + opReport.missing.length} — NOT scanned: ${opReport.missing.join(", ")}`);
  }

  // ── the range this tick owns ────────────────────────────────────────────────────────────────
  const head = await c.getBlockNumber();
  const prev = await cursorStore.get(CURSOR_KEY, { type: "json" }).catch(() => null);
  const range = nextScanRange({ cursor: prev?.cursor ?? null, head });
  if (range.coldStart) {
    console.log(`[discover-sweep] ⚠️ COLD START — no cursor. Scanning ONE window (${range.from}..${range.to}). ` +
      `This tick does NOT cover history; backfill is scripts/bridge-discover-run.mjs, deliberately.`);
  }
  if (range.nothingToDo) {
    console.log(`[discover-sweep] caught up at ${prev?.cursor} (head ${head}) — nothing new.`);
    return json(200, { ok: true, outcome: "caught-up", cursor: prev?.cursor ?? null, head: String(head) });
  }
  if (range.lag > 0n) console.log(`[discover-sweep] cursor lag ${range.lag} blocks behind head`);

  // ── scan ────────────────────────────────────────────────────────────────────────────────────
  const windows = blockWindows(range.from, range.to);
  let served = 0;
  const cands = [];
  for (const w of windows) {
    try {
      const t = await c.getLogs({ address: CONTRACTS.USDC, event: TRANSFER,
        args: { from: owners, to: BRIDGE_CONTRACT }, fromBlock: w.fromBlock, toBlock: w.toBlock });
      let d = [];
      if (t.length) {
        // ⭐ Narrowed on the indexed topics — and the filter is `depositor`, the very field the owner
        // binding may NOT use. Useless for attribution because it is always the Kit, which is what
        // makes it the right filter. See joinBurns.
        d = await c.getLogs({ address: TOKEN_MESSENGER_V2, event: DFB,
          args: { burnToken: CONTRACTS.USDC, depositor: BRIDGE_CONTRACT },
          fromBlock: w.fromBlock, toBlock: w.toBlock });
      }
      served++;
      cands.push(...joinBurns({
        transfers: t.map((l) => ({ transactionHash: l.transactionHash, from: l.args.from, to: l.args.to,
          value: l.args.value.toString(), blockNumber: l.blockNumber })),
        deposits: d.map((l) => ({ transactionHash: l.transactionHash, depositor: l.args.depositor,
          amount: l.args.amount.toString(), maxFee: l.args.maxFee.toString(),
          destinationDomain: l.args.destinationDomain, mintRecipient: "0x" + l.args.mintRecipient.slice(26) })),
      }));
    } catch (e) {
      console.warn(`[discover-sweep] window ${w.fromBlock}..${w.toBlock} FAILED: ${e?.shortMessage || e?.message}`);
    }
  }

  const undocumented = diffUndocumented(cands, recorded);
  const verdict = sweepVerdict({ windowsAttempted: windows.length, windowsServed: served, discovered: undocumented });

  // ── write what was actually read ────────────────────────────────────────────────────────────
  let written = 0, skipped = 0;
  for (const u of undocumented) {
    try {
      const blk = await c.getBlock({ blockNumber: BigInt(u.blockNumber) });
      const r = discoveredReceipt({ ...u, blockTimestamp: new Date(Number(blk.timestamp) * 1000).toISOString() });
      const key = receiptKey(r.owner, r.burnHash);
      if (!isSettleable(r)) { skipped++; console.warn(`[discover-sweep] SKIP ${r.burnHash} — not settleable`); continue; }
      if (await receipts.get(key, { type: "json" }).catch(() => null)) { skipped++; continue; }
      await receipts.setJSON(key, r);
      written++;
      console.log(`[discover-sweep] 🚨 WROTE a receipt for an undocumented burn ${r.burnHash} owner=${r.owner} ${r.amountRequested} USDC -> ${r.destinationLabel} stranded=${isStranded(r)}`);
    } catch (e) {
      console.error(`[discover-sweep] write FAILED for ${u.burnHash}: ${e?.message}`);
      skipped++;
    }
  }

  // ── advance, or deliberately do not ─────────────────────────────────────────────────────────
  const next = nextCursor({ current: prev?.cursor ?? null, scannedTo: range.to, advanceCursor: verdict.advanceCursor });
  if (next.moved) {
    await cursorStore.setJSON(CURSOR_KEY, { cursor: next.cursor, at: new Date().toISOString(), head: String(head) });
  } else {
    console.warn(`[discover-sweep] CURSOR HELD at ${next.cursor ?? "(none)"} — ${next.reason}. ` +
      `${windows.length - served}/${windows.length} windows unread; this range will be rescanned.`);
  }

  console.log(`[discover-sweep] outcome=${verdict.outcome} windows=${served}/${windows.length} ` +
    `owners=${owners.length} undocumented=${undocumented.length} written=${written} skipped=${skipped} ` +
    `cursor=${next.cursor ?? "none"} moved=${next.moved} ms=${Date.now() - started}`);

  return json(200, {
    ok: verdict.outcome !== DISCOVER_OUTCOME.UNREADABLE,
    outcome: verdict.outcome, windowsAttempted: windows.length, windowsServed: served,
    owners: owners.length, undocumented: undocumented.length, written, skipped,
    cursor: next.cursor, cursorMoved: next.moved, coldStart: range.coldStart, head: String(head),
  });
};
