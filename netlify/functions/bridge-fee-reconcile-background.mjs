import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { requireInternal } from "./_auth.mjs";
import { rpcFallback, classifyRpcFailure } from "./_receipt.mjs";
import { readWithRetry, readFeeVerdict, writeFeeVerdictOnce } from "./_bridge-receipts.mjs";
import {
  ARC_CHAIN, observeFeeMovement, reconcileFee, disclosedFeeMinor, shoutFeeMismatch,
} from "./_fee-reconcile.mjs";

// POST /.netlify/functions/bridge-fee-reconcile-background { owner, burnHash }  (INTERNAL ONLY)
//
// ⭐⭐ A DETECTOR, NOT A GATE. The burn is already final when this runs. It answers ONE question —
// is the fee that MOVED the fee we DISPLAYED — and records the answer where a human can read it.
// The mechanics, the pins and the reason set all live in `_fee-reconcile.mjs`; this file is the
// boundary that decides WHEN to ask and WHAT to persist.
//
// ══ WHY ITS OWN FUNCTION AND NOT PART OF THE SETTLER ═══════════════════════════════════════════
// `bridge-mint-settle-background` is about the DESTINATION and is re-entrant; this is about the
// SOURCE and is write-once. And concretely: the settler holds a t0 receipt snapshot across a
// four-minute poll and writes it back wholesale, so anything written onto the receipt in that
// window is erased. See the block above `feeVerdictKey` in _bridge-receipts.mjs.
//
// ══ INTERNAL ONLY, FROM LINE ONE ═══════════════════════════════════════════════════════════════
// Every file under netlify/functions is a PUBLIC URL whether or not netlify.toml routes it.
// `requireInternal` runs before any read or write, and there is deliberately no /api/* route.
//
// ⚠️ IT NEVER TRUSTS ITS CALLER. `owner` and `burnHash` are KEYS used to look up a record we wrote
// ourselves; the payer, the disclosed fee and the amount all come from that record. No address and
// no amount enters this system from the request body.
//
// ══ ⛔ AND IT CANNOT FAIL ANYTHING ═════════════════════════════════════════════════════════════
// Every exit is a 200 describing what happened. A reconciliation that could break a bridge would
// be a gate, which is precisely what this is not.

export async function handler(event) {
  // ⚠️ A background function's return value is DISCARDED — Netlify answers every caller 202 with
  // an empty body, including one with no token. The guard still runs before any read or write;
  // it is simply unobservable from outside, exactly as documented on the settler.
  if (event.httpMethod !== "POST") {
    console.warn(`[bridge-fee-reconcile] REFUSED — method ${event.httpMethod} (POST only)`);
    return json(405, { error: "POST only" });
  }
  if (!requireInternal(event)) {
    console.warn("[bridge-fee-reconcile] REFUSED — no valid x-internal-token; nothing was read or written");
    return json(401, { error: "internal only" });
  }
  if (event.blobs) connectBlobs(event);

  const { owner, burnHash } = parseBody(event) || {}; // KEYS, not claims
  if (!owner || !burnHash) return json(400, { error: "'owner' and 'burnHash' required" });

  // ⭐ WRITE-ONCE IS CHECKED HERE TOO, NOT ONLY AT THE STORE. The store's refusal is the guarantee;
  // this is the cheap path that avoids an RPC round trip for a burn already reconciled.
  const already = await readFeeVerdict(owner, burnHash);
  if (already) {
    return json(200, { ok: true, outcome: "already_reconciled", verdict: already.verdict });
  }

  // A 404 inside the ~11s Blobs window is not absence — poll for it, same as the settler.
  const { receipt } = await readWithRetry(owner, burnHash);
  if (!receipt) return json(404, { error: "no receipt to reconcile" });

  const record = {
    schema: "bridge-fee-verdict/1",
    owner,
    burnHash,
    reconciledAt: new Date().toISOString(),
  };

  // ── THE TWO INPUTS WE OWN, CHECKED BEFORE SPENDING AN RPC CALL ────────────────────────────────
  // ⚠️ Both are OUR OWN record being incomplete, not the chain being unreadable. They get their own
  // reasons so a reader is never told "we could not read the chain" about a chain we never asked.
  const disclosed = disclosedFeeMinor(receipt);
  if (!receipt.payer) {
    return await finish({ ...record, verdict: "unreadable", reason: "payer_unknown", detail: null,
      feeObservedMinor: null, feeDisclosedMinor: disclosed == null ? null : String(disclosed) });
  }
  if (disclosed == null) {
    const why = (receipt.feeDisclosed ?? receipt.feeUsdc) == null ? "disclosed_unknown" : "disclosed_not_exact";
    return await finish({ ...record, verdict: "unreadable", reason: why, detail: null,
      feeObservedMinor: null, feeDisclosedMinor: null });
  }

  // ── READ THE BURN ON ARC ──────────────────────────────────────────────────────────────────────
  let burn;
  try {
    // ⛔⛔ NO `absenceNeedsCorroboration` HERE, AND ITS ABSENCE IS DELIBERATE. Arc has ONE endpoint,
    // so corroboration cannot be satisfied — there is nobody else to ask. Passing the flag would
    // buy nothing and would invite the reader to believe an absence had been corroborated.
    // ⭐ THE RULE THIS ENFORCES: ON ARC, AN ABSENCE IS ALWAYS `unreadable`, NEVER A FINDING. A null
    // receipt here is indistinguishable from a pruned or lagging node, and public-RPC retention
    // makes that the COMMON case for an older burn. It may never become `mismatched`.
    const got = await rpcFallback(ARC_CHAIN, "eth_getTransactionReceipt", [burnHash]);
    burn = got.result;
  } catch (e) {
    if (e?.chainMismatch) {
      return await finish({ ...record, verdict: "unreadable", reason: "chain_unreadable",
        detail: `endpoint reports chain ${e.saw}`, feeObservedMinor: null, feeDisclosedMinor: String(disclosed) });
    }
    return await finish({ ...record, verdict: "unreadable", reason: "chain_unreadable",
      detail: e?.aggregateKind ?? classifyRpcFailure(e).failureKind,
      feeObservedMinor: null, feeDisclosedMinor: String(disclosed) });
  }

  if (!burn) {
    return await finish({ ...record, verdict: "unreadable", reason: "burn_absent", detail: null,
      feeObservedMinor: null, feeDisclosedMinor: String(disclosed) });
  }
  if (burn.status !== "0x1") {
    return await finish({ ...record, verdict: "unreadable", reason: "burn_reverted", detail: String(burn.status),
      feeObservedMinor: null, feeDisclosedMinor: String(disclosed) });
  }

  const observed = observeFeeMovement(burn.logs, { payer: receipt.payer });
  const v = reconcileFee({ observed, disclosedMinor: disclosed });
  return await finish({ ...record, ...v, burnBlockNumber: burn.blockNumber ?? null });

  async function finish(rec) {
    const w = await writeFeeVerdictOnce(rec);
    console.log(
      `[bridge-fee-reconcile] burnHash=${burnHash} verdict=${rec.verdict}` +
        `${rec.reason ? ` reason=${rec.reason}${rec.detail ? `(${rec.detail})` : ""}` : ""}` +
        ` observed=${rec.feeObservedMinor ?? "-"} disclosed=${rec.feeDisclosedMinor ?? "-"} written=${w.written}`
    );
    // 🚨 MISMATCHED ONLY. See shoutFeeMismatch — `unreadable` is the COMMON verdict until the
    // upfront-fee path is adopted, and an alert on the common case is one nobody reads.
    if (rec.verdict === "mismatched") {
      shoutFeeMismatch({ owner, burnHash, observedMinor: rec.feeObservedMinor, disclosedMinor: rec.feeDisclosedMinor });
    }
    return json(200, { ok: true, verdict: rec.verdict, reason: rec.reason ?? null, written: w.written });
  }
}
