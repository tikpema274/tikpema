import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { internalToken } from "./_auth.mjs";
import { listAllStranded } from "./_bridge-receipts.mjs";

// SCHEDULED — bridge receipt sweeper. Finds stranded receipts across ALL owners and asks
// the settler to resolve them. Writes NOTHING itself.
//
// ══ WHY A CRON AND NOT JUST THE READ PATH ══════════════════════════════════════════
// Recovery used to ride /api/bridge-receipts, which needs THREE independent things to
// line up: a live session, the wallet that owns the receipt, and a page that calls it.
// On 2026-08-01 each of those failed separately over several hours — wallet not
// connected, wrong route, and finally three different login wallets — while
// `0x0175cf7b…` sat at `burn_confirmed` for 7h58m with its mint already landed on Base
// (0.946804, verified). The read path is not wrong, it is just CONDITIONAL, and the
// condition is "a human happens to look".
//
// ⭐ THE CASE IT EXISTS FOR IS THE ONE THE READ PATH CANNOT COVER AT ALL: a user who
// bridges once and never comes back. Their receipt is never re-read, so it is never
// recovered, so the record stays wrong forever about money that did arrive.
//
// ══ IT OWNS NO WRITES ══════════════════════════════════════════════════════════════
// The settler owns every write, is idempotent, and takes a single-flight lease — so a
// duplicate trigger costs a wasted read, never a wrong receipt. This function only
// decides WHO to ask about, using the same `isStranded` predicate the owner-scoped read
// uses, so the two can never disagree about what "stranded" means.
//
// ══ NOT HTTP-INVOKABLE ═════════════════════════════════════════════════════════════
// Netlify refuses HTTP invocation of a scheduled function (403), and the settler it
// calls is `requireInternal` regardless. There is deliberately no /api/* route.
// ⚠️ Do NOT comment the schedule out to test it on a draft without restoring it: the
// build stamp cannot see netlify.toml, so a forgotten restore leaves an identical tree
// hash and a sweeper that never runs. `gate:watch` checks that for strong-read-watch;
// this one has no such guard yet.

// Bounded per tick. A backlog is drained across ticks rather than fanned out at once —
// each trigger costs the settler a multi-minute poll slot.
const MAX_PER_TICK = 10;

export const handler = async (event) => {
  connectBlobs(event);

  const started = Date.now();
  const { scanned, stranded, total, provisional, reconcilable, reconcilableTotal, degraded } =
    await listAllStranded({ limit: MAX_PER_TICK });

  if (degraded) {
    // ⚠️ An unreadable store is NOT "nothing stranded". Say so loudly — this is the
    // absence-reads-as-safe shape, and a silent sweep is indistinguishable from a clean one.
    console.error("[bridge-sweep] DEGRADED — could not list the store; this tick proves nothing");
    return json(200, { ok: false, reason: "store-unreadable" });
  }

  // ⭐⭐ THE PROVISIONAL CENSUS — LOGGED BEFORE THE CLEAN EARLY-RETURN, DELIBERATELY.
  //
  // 🚨 A provisional receipt is never `stranded`, so `total === 0` is the NORMAL state of a store
  // that is full of aged-out `tx-` records needing a human. Logging the census after that return
  // would mean the one condition worth escalating is the one condition that prints "clean" and
  // exits — which is how this sweeper's own log line would have become the thing hiding it.
  //
  // ⚠️ THE SWEEP STILL OWNS NO WRITES. This is a count and a sentence, nothing more; the
  // reconcile job that could act on it is unbuilt, and that is stated rather than implied.
  if (provisional) {
    const { settling, unwitnessed, unresolved } = provisional;
    if (unresolved > 0) {
      console.error(
        `[bridge-sweep] 🚨 ${unresolved} PROVISIONAL RECEIPT(S) PAST THE 24h CAP — submitted, never ` +
          `confirmed, and nothing will resolve them automatically. Each needs its txId reconciled ` +
          `against Circle BY HAND. (also settling=${settling} unwitnessed=${unwitnessed})`
      );
    } else if (settling + unwitnessed > 0) {
      console.log(`[bridge-sweep] provisional census — settling=${settling} unwitnessed=${unwitnessed} unresolved=0`);
    }
  }

  const base = process.env.DEPLOY_URL || process.env.URL;
  if (!base) {
    console.error("[bridge-sweep] no DEPLOY_URL/URL — cannot reach the settler");
    return json(500, { ok: false, reason: "no-base-url" });
  }

  // ⭐⭐ ASK CIRCLE WHAT BECAME OF EACH PROVISIONAL SUBMISSION — the recovery the `tx-` record was
  // written as a hook for, and which the cap could only make LOUD rather than fix.
  //
  // ⚠️ THIS FUNCTION STILL OWNS NO WRITES. It triggers; `bridge-reconcile-background` performs
  // every write, exactly as it does for the settler. That invariant is asserted by substring in
  // verify-bridge-receipts.mjs and is worth more than doing the work inline.
  //
  // ⚠️ AND IT RUNS BEFORE THE `total === 0` RETURN, for the same reason the census does: a
  // provisional record is NEVER stranded, so `stranded=0` is the normal state of a store full of
  // records this job is the only thing that can resolve. Reconciling after that return would mean
  // never reconciling at all.
  let reconciled = 0;
  for (const r of reconcilable) {
    try {
      const res = await fetch(`${base}/.netlify/functions/bridge-reconcile-background`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken() },
        body: JSON.stringify({ owner: r.owner, txId: r.txId }),
      });
      reconciled++;
      console.log(`[bridge-sweep] reconcile triggered owner=${r.owner} txId=${r.txId} status=${res.status}`);
    } catch (e) {
      console.warn(`[bridge-sweep] reconcile trigger failed txId=${r.txId}: ${e?.message}`);
    }
  }
  if (reconcilableTotal > reconciled) {
    console.log(`[bridge-sweep] reconcile CAPPED at ${MAX_PER_TICK}/tick — ${reconcilableTotal - reconciled} deferred`);
  }

  if (total === 0) {
    console.log(`[bridge-sweep] clean — scanned=${scanned} stranded=0 reconcileTriggered=${reconciled}`);
    return json(200, { ok: true, scanned, stranded: 0, triggered: 0, provisional, reconciled });
  }

  let triggered = 0;
  for (const r of stranded) {
    try {
      // Awaited, for the same reason agent-bridge awaits its trigger: an un-awaited fetch
      // in a handler that then returns may never be sent at all. The settler acks 202.
      const res = await fetch(`${base}/.netlify/functions/bridge-mint-settle-background`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken() },
        body: JSON.stringify({ owner: r.owner, burnHash: r.burnHash }),
      });
      triggered++;
      console.log(
        `[bridge-sweep] triggered owner=${r.owner} burnHash=${r.burnHash} state=${r.state} status=${res.status}`
      );
    } catch (e) {
      // One failure must not abort the sweep — the rest are still worth asking about.
      console.warn(`[bridge-sweep] trigger failed burnHash=${r.burnHash}: ${e?.message}`);
    }
  }

  // ⭐ THE REMAINDER IS REPORTED, NEVER DROPPED SILENTLY. `total` is the true count;
  // `triggered` is what this tick acted on. If they differ, the next tick has work left,
  // and that must be visible rather than inferred from a list that looks complete.
  const remaining = total - triggered;
  console.log(
    `[bridge-sweep] scanned=${scanned} stranded=${total} triggered=${triggered} remaining=${remaining} ms=${Date.now() - started}` +
      (remaining > 0 ? ` — CAPPED at ${MAX_PER_TICK}/tick, ${remaining} deferred to the next run` : "")
  );
  return json(200, { ok: true, scanned, stranded: total, triggered, remaining, provisional });
};
