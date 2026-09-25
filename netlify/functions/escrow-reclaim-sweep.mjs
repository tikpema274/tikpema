// escrow-reclaim-sweep.mjs — SCHEDULED (netlify.toml). Watches the research-job escrow; reclaims expired
// escrows ONLY when armed, and ONLY for jobs that expired after it was armed.
//
// ═══ 🔭 SHIPS DISARMED (decision 2026-09-25) ═══════════════════════════════════════════════════
// A scheduled sweeper that reclaimed the 59.25 USDC backlog (25 jobs, June–July) on its first tick would be
// a fund-moving run nobody approved. So:
//   · RECLAIM_ARMED = false — a CODE constant, not an env toggle: arming costs a commit and a review, never a
//     dashboard click (the budget-sweep reasoning; an unset env var reads as "off" at exit 0).
//   · Disarmed, it RECORDS what it WOULD reclaim and moves nothing.
//   · Armed, it still reclaims only jobs that expired AFTER ARMED_FROM_SEC — set to the arming moment in the
//     SAME commit that flips RECLAIM_ARMED. The historical backlog is structurally out of its reach; it is
//     T's explicit, one-time run via scripts/escrow-reclaim.mjs.
//
// ═══ ALWAYS ON: the escrow-fee watch (read-only) ═══════════════════════════════════════════════
// complete() deducts platformFeeBP + evaluatorFeeBP — admin-set, outside our control, 0/0 today. Our copy
// ("comes back to your agent wallet") is true on a COMPLETED job only while both are 0. Every tick reads
// them tri-state, records them, and NOTIFIES on any change or on a first non-zero reading.
//
// 🚨 NOT HTTP-invokable (Netlify 403s scheduled functions) and deliberately no /api route.
import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { planReclaim, executeReclaim, readEscrowFees, feeChange, liveDeps, ourJobIds } from "./_escrow-reclaim.mjs";

export const RECLAIM_ARMED = false;
/** Jobs that expired before this moment are never the schedule's to reclaim. null while disarmed. */
export const ARMED_FROM_SEC = null;
const WATCH_STORE = "escrow-watch";

/** The sweep, with every dependency injected (verify-escrow-reclaim drives it with no network). */
export async function sweep({ jobIds, readJob, nowSec, armed, armedFromSec, readFee, feeStore, submitClaim, readReceiptLogs, notify }) {
  const beat = { at: new Date().toISOString(), armed, armedFromSec: armedFromSec === null ? null : String(armedFromSec),
    fees: null, feeChange: null, wouldReclaim: [], reclaimed: [], excludedBeforeCutoff: 0, unreadable: 0, errors: [] };

  // ── 1. the fee watch — every tick, armed or not ──
  const fees = await readEscrowFees({ readFee });
  beat.fees = fees;
  if (fees.readable) {
    const prev = await feeStore.get("fees").catch(() => null);
    const ch = feeChange(prev, fees);
    beat.feeChange = ch;
    if (ch.changed || (ch.first && ch.nonZero)) {
      await notify(`⚠️ Research-job escrow fees ${ch.changed ? "CHANGED" : "are non-zero"}: platform fee ${fees.platformFeeBP} bps, ` +
        `evaluator fee ${fees.evaluatorFeeBP} bps${ch.from ? ` (was ${ch.from.platformFeeBP}/${ch.from.evaluatorFeeBP})` : ""}. ` +
        `complete() deducts these; the "comes back to your agent wallet" copy is only true at 0/0.`).catch((e) => beat.errors.push(`notify: ${e.message}`));
    }
    await feeStore.set("fees", { ...fees, observedAt: beat.at }).catch((e) => beat.errors.push(`fee record: ${e.message}`));
  }

  // ── 2. the reclaim — planned always, executed only when armed, never before the cutoff ──
  const cutoff = armedFromSec ?? nowSec + 1n; // disarmed with no cutoff: nothing is "after" it
  const plan = await planReclaim({ jobIds, readJob, nowSec, expiredAfterSec: armed ? cutoff : (armedFromSec ?? null) });
  beat.excludedBeforeCutoff = plan.excludedBeforeCutoff.length;
  beat.unreadable = plan.unreadable.length;
  if (!armed) {
    beat.wouldReclaim = plan.reclaimable.map((r) => ({ jobId: r.jobId, budgetUsdc: r.budgetUsdc }));
    return beat;
  }
  for (const entry of plan.reclaimable) {
    try { beat.reclaimed.push(await executeReclaim({ entry, submitClaim, readReceiptLogs })); }
    catch (e) { beat.errors.push(`${entry.jobId}: ${e.message}`); }
  }
  return beat;
}

export async function handler(event) {
  if (event?.blobs) connectBlobs(event);
  const watch = getStore(WATCH_STORE);
  const deps = await liveDeps({ walletAddress: RECLAIM_ARMED ? process.env.ESCROW_RECLAIM_WALLET_ADDRESS ?? null : null });
  if (RECLAIM_ARMED && !deps.submitClaim) {
    console.error("[escrow-reclaim-sweep] ARMED but ESCROW_RECLAIM_WALLET_ADDRESS is unset — refusing to reclaim");
  }
  const url = process.env.DD_WATCH_WEBHOOK; // service-integrity channel (same as shoutLedgerFailure)
  const beat = await sweep({
    jobIds: await ourJobIds({ getStore }), readJob: deps.readJob, nowSec: deps.nowSec,
    armed: RECLAIM_ARMED && !!deps.submitClaim, armedFromSec: ARMED_FROM_SEC === null ? null : BigInt(ARMED_FROM_SEC),
    readFee: deps.readFee, readReceiptLogs: deps.readReceiptLogs, submitClaim: deps.submitClaim,
    feeStore: { get: (k) => watch.get(k, { type: "json" }), set: (k, v) => watch.setJSON(k, v) },
    notify: async (content) => { if (!url) return; await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) }); },
  });
  await watch.setJSON("last", beat).catch(() => {});
  console.log(`[escrow-reclaim-sweep] ${JSON.stringify({ armed: beat.armed, fees: beat.fees, would: beat.wouldReclaim.length, reclaimed: beat.reclaimed.length, errors: beat.errors.length })}`);
  return { statusCode: 200, body: "ok" };
}
