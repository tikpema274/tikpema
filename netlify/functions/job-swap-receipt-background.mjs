import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { requireInternal } from "./_auth.mjs";
import { publicClient } from "./_predict.mjs";
import { confirmSwapLanded } from "./_swap-confirm.mjs";
import { reverseChargeById } from "./_budget.mjs";

// job-swap-receipt-background — the same-chain twin of job-bridge-receipt-background.
//
// A bridge receipt must verify a CCTP burn → attestation → destination mint across two
// chains, polling IRIS. A SWAP has none of that: it either landed on Arc or it didn't. So
// this verifier is small, and it answers exactly one question — did the swap actually
// happen? — from the CHAIN, never from the SDK's own say-so.
//
// The single witness lives in _swap-confirm.mjs (confirmSwapLanded) and is SHARED with the DCA
// scheduler — one copy of a money-gating decision, never two that can drift. It answers hash-first
// (eth_getTransactionReceipt on the SDK's event hash) and, when _swap.mjs returned a NULL txHash
// (the 1098 async-waiter quirk: the Circle SCA submits asynchronously and App Kit throws
// "transaction hash is required" even though the swap lands), by a TWO-LEGGED LOG-SCAN: the one tx
// that both spent exactly amountIn of tokenIn from the wallet AND delivered tokenOut to it. That
// tx-shape match identifies OUR swap even if the wallet's balances moved for other reasons in the
// window — strictly stronger than the old aggregate `balanceAfter > balanceBefore` delta.
//
// This verifier owns the RETRY CADENCE: it polls the single-shot witness to a 90s deadline. If it
// never confirms, the receipt terminates at `unconfirmed` — honest incompleteness, never a
// fabricated success. (Bridge does the same with mint_unconfirmed.)
//
// ⚠️ Publicly reachable at /.netlify/functions/… like every Netlify function, and it WRITES
// receipts — so requireInternal (HMAC over SESSION_SECRET) guards it. It moves no money and
// cannot: it only reads the chain and records what it found.

const POLL_MS = 2_000;
const DEADLINE_MS = 90_000; // same-chain finality is sub-second on Arc; this is generous

// The log-scan window's lower bound. job-swap-approve does not persist a pre-swap block, and the
// swap landed shortly before this verifier was triggered, so we look back generously from the
// current head. Arc blocks are ~0.5s, so this spans ~15 min — far more than the approve→verify gap
// plus blob eventual-consistency — while the exact-amountIn two-legged match keeps it unambiguous.
const LOOKBACK_BLOCKS = 2000n;

export async function handler(event) {
  // ⚠️ A BACKGROUND FUNCTION FAILS INVISIBLY. Netlify acks 202 before it runs, so its response
  // is discarded, and its console output does NOT surface through `netlify logs`
  // (job-bridge-receipt-background documents the same). A throw here therefore strands a
  // receipt at submitted_* with the swap ALREADY ON-CHAIN and no way to learn why — which is
  // exactly what happened on the first live swap, and it cost an hour to find.
  //
  // So the failure is written INTO THE RECEIPT, the one place that is actually readable.
  // console.error is kept only as a courtesy; it is not the diagnostic.
  try {
    return await verify(event);
  } catch (e) {
    console.error(`[swap-verifier] THREW: ${e.message}\n${e.stack}`);
    try {
      const { jobId } = JSON.parse(event.body || "{}");
      if (jobId) {
        if (event.blobs) connectBlobs(event);
        const store = getStore("job-deliverables");
        const entry = await store.get(String(jobId), { type: "json" });
        if (entry?.receipt) {
          await store.setJSON(String(jobId), {
            ...entry,
            receipt: { ...entry.receipt, verifierError: e.message, verifierFailedAt: new Date().toISOString() },
          });
        }
      }
    } catch { /* nothing left to do — the throw is already lost */ }
    return { statusCode: 500, body: `verifier threw: ${e.message}` };
  }
}

async function verify(event) {
  if (event.blobs) connectBlobs(event);
  if (!requireInternal(event)) {
    console.error("[swap-verifier] rejected: bad or missing x-internal-token");
    return { statusCode: 401, body: "unauthorized" };
  }

  const { jobId } = JSON.parse(event.body || "{}");
  if (!jobId) return { statusCode: 400, body: "jobId required" };

  const store = getStore("job-deliverables");

  // ⚠️ READ-RETRY, NOT A SINGLE READ. Netlify Blobs is EVENTUALLY CONSISTENT (~11s), and
  // job-swap-approve writes the receipt and triggers us in the same breath — so our first
  // read very often lands BEFORE that write is visible. A single get() then sees no receipt,
  // returns 404, and the receipt is stranded at submitted_no_hash forever with the swap
  // already on-chain. That is exactly what happened on the first live run.
  //
  // job-bridge-receipt-background solved this already; this is the same window and the same
  // sizing: 10 x 1.5s = 15s > the ~11s convergence window. (See verify-receipt-read-retry.)
  const RECEIPT_TRIES = 10;
  const RECEIPT_DELAY_MS = 1500;
  let entry = null;
  for (let i = 0; i < RECEIPT_TRIES; i++) {
    entry = await store.get(jobId, { type: "json" }).catch(() => null);
    if (entry?.receipt) break;
    await new Promise((r) => setTimeout(r, RECEIPT_DELAY_MS));
  }

  const receipt = entry?.receipt;
  if (!receipt) return { statusCode: 404, body: "no receipt (not visible after read-retry)" };

  // Only act on a receipt awaiting verification. A terminal receipt is never re-written —
  // a replayed or double-invoked call is a no-op (the same claim discipline as the UB
  // deposit worker).
  if (receipt.state !== "submitted" && receipt.state !== "submitted_no_hash") {
    return { statusCode: 200, body: `receipt is '${receipt.state}' — nothing to verify` };
  }

  const settle = async (fields) => {
    const fresh = await store.get(jobId, { type: "json" }).catch(() => null);
    await store.setJSON(jobId, {
      ...(fresh ?? entry),
      receipt: { ...(fresh?.receipt ?? receipt), ...fields, verifiedAt: new Date().toISOString() },
    });
  };

  // ⚠️ TELEMETRY INTO THE RECEIPT, NOT INTO LOGS. A background function's console output does
  // NOT surface through `netlify logs` (job-bridge-receipt-background documents the same
  // thing), so a verifier that dies silently leaves a receipt stranded with the swap already
  // on-chain and NO way to find out why. Stamping progress onto the receipt makes every run
  // diagnosable from the record itself.
  await settle({ verifierRanAt: new Date().toISOString(), verifierStage: "loaded" });

  // The wallet + amount come from the PERSISTED receipt (job-swap-approve wrote them), never from
  // this request body — the verifier cannot be told what to believe.
  const walletAddress = receipt.walletAddress ?? null;
  if (!walletAddress || receipt.amountIn == null) {
    await settle({
      state: "unconfirmed",
      note: "swap submitted, but the receipt lacks the wallet/amount needed to witness it on-chain",
    });
    return { statusCode: 200, body: "unconfirmed (no evidence)" };
  }

  // Anchor the log-scan window ONCE (stable across polls). The swap already landed shortly before
  // we were triggered, so look back from the current head.
  let fromBlock;
  try { fromBlock = (await publicClient().getBlockNumber()) - LOOKBACK_BLOCKS; }
  catch { fromBlock = 0n; }
  if (fromBlock < 0n) fromBlock = 0n;

  const giveUpAt = Date.now() + DEADLINE_MS;
  let lastReason = "pending";

  // Poll the SHARED single-shot witness to the deadline. Hash-first, else the two-legged log-scan.
  while (Date.now() < giveUpAt) {
    const res = await confirmSwapLanded({
      walletAddress,
      tokenIn: receipt.tokenIn,
      tokenOut: receipt.tokenOut,
      amountIn: receipt.amountIn,
      fromBlock,
      eventTxHash: receipt.txHash || null,
    });
    if (res.confirmed) {
      await settle({
        state: "confirmed",
        verifiedBy: res.verifiedBy,
        txHash: res.txHash,
        tx: res.tx ?? receipt.tx ?? null,
        blockNumber: res.blockNumber ?? null,
        amountOut: res.amountOut ?? null,
      });
      return { statusCode: 200, body: `confirmed (${res.verifiedBy})` };
    }
    if (res.reason === "reverted") {
      await settle({ state: "failed", error: "swap reverted on-chain", txHash: res.txHash });

      // ── PRIMARY PHANTOM-CHARGE REVERSAL (step 8) ────────────────────────────────────────────
      // This path ledgers the day ceiling at SUBMIT (executeAction, manual submit-and-return), so a
      // swap that fails afterwards leaves a charge for a spend that never happened. We are the one
      // place that KNOWS it failed, with the id in hand — so reverse here: no age threshold, no
      // re-query, no scan, and no window in which a slow-but-real swap could be mistaken for a dead
      // one (we are not guessing from timing; we observed the revert).
      //
      // ⚠️ The day the charge lands in comes from the CHARGE's own audit timestamp, never from now —
      // this verifier runs later than the charge and may cross UTC midnight. reverseAgentSpend
      // derives it that way internally; do not pass a date from here.
      //
      // Crash-safe without a transaction: reverseAgentSpend is idempotent (reversedIds inside its
      // CAS), so a crash between reversing and marking is recovered by the next attempt — and the
      // scheduled backstop reaching the same charge cannot double-reverse it either.
      //
      // Best-effort: a failure here must NOT change the receipt outcome the caller already settled.
      // An un-reversed charge is the pre-step-8 status quo and the backstop will catch it.
      if (receipt.circleId) {
        try {
          const rev = await reverseChargeById({
            circleId: receipt.circleId,
            reason: `job-swap ${jobId} reverted on-chain`,
          });
          // ⚠️ A FAILED LOOKUP IS NOT A LICENCE TO GUESS. If the charge could not be found at all
          // (no entry AND no marker) we reverse NOTHING here and raise needsAttention — we do not
          // assume it was never charged, and we do not reverse "just in case". Reversing on an absent
          // read is the fail-OPEN direction of the absence-as-safe family.
          // A miss because it is ALREADY handled (backstop or an earlier attempt) is benign: no flag.
          //
          // ACCEPTED BEHAVIOUR ON A FAILED LOOKUP (decided, not an oversight): the day-ceiling charge
          // STANDS. That is fail-CLOSED — it over-restricts the user by at most one cap for the rest
          // of the UTC day, and never widens one — and it self-heals at UTC rollover.
          // ⚠️ IT IS NOT STRANDED: because we write NO marker here, the charge stays unresolved, so
          // the backstop sweeper's ordinary scan finds it on a later run and reverses it then
          // (proven: spike-step8c case 3). No retry machinery lives here, by decision — adding
          // reversal attempts to speed up a recovery that is already safe would only widen the
          // fail-open surface.
          await settle({
            dayCeilingReversed: rev.reversed === true,
            reversalNote: rev.refused ?? null,
            ...(rev.anomalous ? { needsAttention: true } : {}),
          });
        } catch (e) {
          // The lookup or the write threw — same rule: never reverse on a failed read, flag instead.
          await settle({ dayCeilingReversed: false, needsAttention: true, reversalNote: `reversal failed: ${e.message}` });
        }
      } else {
        // Pre-step-8 receipt: no id was persisted, so we cannot name the charge. Say so in the
        // record rather than guessing — the scheduled backstop handles these orphans.
        await settle({ dayCeilingReversed: false, reversalNote: "no circleId on receipt (pre-step-8) — left for the backstop" });
      }

      return { statusCode: 200, body: "failed" };
    }
    lastReason = res.reason;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await settle({
    state: "unconfirmed",
    note: `swap submitted; no on-chain witness within the window (${lastReason})`,
  });
  return { statusCode: 200, body: "unconfirmed" };
}
