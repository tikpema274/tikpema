import { connectLambda, getStore } from "@netlify/blobs";
import { requireInternal } from "./_auth.mjs";
import { ubDeposit } from "./_ubdeposit.mjs";

// agent-ub-deposit-background — the SLOW half of the UB deposit, off the sync clock.
//
// WHY THIS EXISTS. The deposit runs two sequential on-chain txs (approve → deposit), each
// confirming in 2–3s, plus the one-time addDelegate grant on a user's first deposit. Even
// after tightening waitForTx's poll cadence (8938ms → 6442ms, measured on prod) it sat at
// ~64% of Netlify's **10s** sync-function ceiling, with an irreducible ~6s floor. A single
// slow Circle call tipped it over — and a timeout there is a 502 with no result written,
// which is a terrible shape for a money path even when the funds are safe.
//
// Background functions get **15 minutes**, so the chain simply has time to be the chain.
//
// ⚠️ NO GUARDS HERE. The caller (agent-ub-deposit.mjs) has ALREADY enforced auth, the
// per-deposit cap, and the funds check BEFORE invoking us — and it is the only thing that
// can reach us (requireInternal). This worker executes; it does not decide.
//
// The ordering inside ubDeposit (funds-check → ensureDelegate → approve → deposit) is
// unchanged and still load-bearing: moving the executor off the sync clock must not move
// the grant, which is what keeps addDelegate structurally unreachable on an empty wallet.
export async function handler(event) {
  if (event.blobs) connectLambda(event);

  // Only our own trigger may run this. A public caller would be an uncapped deposit.
  if (!requireInternal(event)) return { statusCode: 401, body: "unauthorized" };

  const { depositId, amountUsdc, owner } = JSON.parse(event.body || "{}");
  if (!depositId || !owner) return { statusCode: 400, body: "depositId and owner required" };

  const store = getStore("ub-deposits");
  const patch = async (fields) => {
    const prev = (await store.get(`dep:${depositId}`, { type: "json" }).catch(() => null)) ?? {};
    await store.setJSON(`dep:${depositId}`, { ...prev, ...fields, updatedAt: new Date().toISOString() });
  };

  await patch({ status: "executing" });

  try {
    const r = await ubDeposit({ amountUsdc: Number(amountUsdc), owner });
    await patch({
      status: "completed",
      amountUsdc: r.amountUsdc,
      depositedTo: r.depositedTo,
      approveTxHash: r.approveTxHash,
      depositTxHash: r.depositTxHash,
      tx: r.tx,
      // Non-null ONLY on the deposit that actually granted the delegate (the user's first).
      delegateAuthorized: r.delegateAuthorized,
      delegateAlreadyAuthorized: r.delegateAlreadyAuthorized,
      delegateTxHash: r.delegateTxHash,
    });
  } catch (e) {
    // Persist the failure SHAPE, not just a string — the poller surfaces these distinctly.
    //  · delegateAuthFailed: the grant failed BEFORE any approve, so no funds moved and the
    //    user's USDC is still plain in their own SCA. Clean and retryable.
    //  · allowanceDangling: a deposit failed AND the revoke also failed — real on-chain
    //    residue an operator must know about.
    await patch({
      status: "failed",
      error: e.message,
      delegateAuthFailed: e.name === "DelegateAuthError",
      allowanceDangling: e.allowanceDangling === true,
      allowanceRevoked: e.allowanceRevoked === true,
      fundsMoved: e.name === "DelegateAuthError" ? false : undefined,
    });
  }

  return { statusCode: 200, body: "ok" };
}
