import { connectLambda, getStore } from "@netlify/blobs";
import { formatUnits } from "viem";
import { CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { requireInternal } from "./_auth.mjs";
import { publicClient } from "./_predict.mjs";

// job-swap-receipt-background — the same-chain twin of job-bridge-receipt-background.
//
// A bridge receipt must verify a CCTP burn → attestation → destination mint across two
// chains, polling IRIS. A SWAP has none of that: it either landed on Arc or it didn't. So
// this verifier is small, and it answers exactly one question — did the swap actually
// happen? — from the CHAIN, never from the SDK's own say-so.
//
// TWO PATHS, because _swap.mjs can return a NULL txHash (the 1098 async-waiter quirk: the
// Circle SCA submits asynchronously and App Kit throws "transaction hash is required" even
// though the swap lands). A receipt keyed only on a hash would be unverifiable precisely
// when the SDK is least reliable — so:
//
//   1. HASH PATH   (state "submitted")         → eth_getTransactionReceipt.
//                                                 status 'success' → confirmed
//                                                 status 'reverted' → failed
//   2. DELTA PATH  (state "submitted_no_hash") → compare tokenOut's balance against the
//                                                 snapshot job-swap-approve took BEFORE
//                                                 executing. If tokenOut went UP, the swap
//                                                 landed. The chain is the witness.
//
// If neither can answer within the window, the receipt terminates at `unconfirmed` — honest
// incompleteness, never a fabricated success. (Bridge does the same with mint_unconfirmed.)
//
// ⚠️ Publicly reachable at /.netlify/functions/… like every Netlify function, and it WRITES
// receipts — so requireInternal (HMAC over SESSION_SECRET) guards it. It moves no money and
// cannot: it only reads the chain and records what it found.

const POLL_MS = 2_000;
const DEADLINE_MS = 90_000; // same-chain finality is sub-second on Arc; this is generous

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const tokenAddress = (sym) => (String(sym).toUpperCase() === "EURC" ? CONTRACTS.EURC : CONTRACTS.USDC);

async function readBalance(token, wallet) {
  const raw = await publicClient().readContract({
    address: tokenAddress(token),
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
  return Number(formatUnits(raw, USDC_DECIMALS));
}

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
        if (event.blobs) connectLambda(event);
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
  if (event.blobs) connectLambda(event);
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

  const giveUpAt = Date.now() + DEADLINE_MS;

  // ── PATH 1: we have a hash. Ask the chain what happened to it. ──
  if (receipt.state === "submitted" && receipt.txHash) {
    while (Date.now() < giveUpAt) {
      try {
        const r = await publicClient().getTransactionReceipt({ hash: receipt.txHash });
        if (r?.status === "success") {
          await settle({ state: "confirmed", blockNumber: Number(r.blockNumber) });
          return { statusCode: 200, body: "confirmed" };
        }
        if (r?.status === "reverted") {
          await settle({ state: "failed", error: "swap reverted on-chain", blockNumber: Number(r.blockNumber) });
          return { statusCode: 200, body: "failed" };
        }
      } catch {
        /* not mined yet — keep polling */
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    await settle({ state: "unconfirmed", note: "swap submitted; the chain did not confirm it within the window" });
    return { statusCode: 200, body: "unconfirmed" };
  }

  // ── PATH 2: no hash (the 1098 quirk). Verify by BALANCE DELTA against the pre-swap
  // snapshot. Without a snapshot there is nothing honest to compare, so we say so. ──
  const before = receipt.balancesBefore;
  // From the PERSISTED receipt (job-swap-approve wrote it), never from this request body.
  const walletAddress = receipt.walletAddress ?? null;
  if (!before || !walletAddress) {
    await settle({
      state: "unconfirmed",
      note: "swap submitted, but no tx hash was returned and no pre-swap balance snapshot exists — cannot verify",
    });
    return { statusCode: 200, body: "unconfirmed (no evidence)" };
  }

  while (Date.now() < giveUpAt) {
    try {
      const nowOut = await readBalance(receipt.tokenOut, walletAddress);
      // tokenOut went UP ⇒ the swap landed. Strictly greater: a stablecoin swap always
      // returns something, and the fee comes out of the OUTPUT, so any increase is proof.
      if (nowOut > before[receipt.tokenOut]) {
        await settle({
          state: "confirmed",
          verifiedBy: "balance-delta",
          amountOut: Number((nowOut - before[receipt.tokenOut]).toFixed(6)),
        });
        return { statusCode: 200, body: "confirmed (balance delta)" };
      }
    } catch {
      /* read hiccup — keep polling */
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await settle({
    state: "unconfirmed",
    verifiedBy: "balance-delta",
    note: "swap submitted; no hash returned and the output balance did not move within the window",
  });
  return { statusCode: 200, body: "unconfirmed" };
}
