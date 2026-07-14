import { connectLambda, getStore } from "@netlify/blobs";
import { ubDepositMaxPerTxUsdc } from "./_arc.mjs";
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
// ⚠️ THIS FUNCTION IS PUBLICLY REACHABLE at /.netlify/functions/… — Netlify exposes EVERY
// function there, and withholding the /api/* redirect hides nothing. `requireInternal` (an
// HMAC over SESSION_SECRET, server-only, never in the client bundle) is what actually guards
// it. Note a background function acks 202 BEFORE this handler runs, so its status code proves
// nothing about whether work happened — check the chain.
//
// The front door (agent-ub-deposit.mjs) already enforced auth, the cap, and the funds check.
// But this worker does NOT simply trust that, for two reasons that bite even with no attacker:
//
//   1. REPLAY / DOUBLE-INVOKE. The internal token is STATIC, and Netlify is known to
//      re-invoke background functions (job-run-status carries a whole stall/re-fire mechanism
//      for exactly that). A second invocation with the same depositId would deposit AGAIN.
//      So we CLAIM the record: proceed only from "starting", and no-op otherwise. One
//      depositId ⇒ at most one deposit, forever.
//
//   2. NO SECOND LINE OF DEFENCE. _ubdeposit is uncapped by design. If the token ever leaked,
//      the front door's cap would be the only thing that had ever checked the amount. So we
//      re-check it here. Cheap, and it means "reached the worker" never implies "uncapped".
//
// The ordering inside ubDeposit (funds-check → ensureDelegate → approve → deposit) is
// unchanged and still load-bearing: moving the executor off the sync clock must not move
// the grant, which is what keeps addDelegate structurally unreachable on an empty wallet.
export async function handler(event) {
  if (event.blobs) connectLambda(event);

  // Only our own trigger may run this. A public caller would otherwise reach a raw executor.
  if (!requireInternal(event)) return { statusCode: 401, body: "unauthorized" };

  // ONLY the depositId is taken from the body. The amount and the depositor are read from the
  // persisted record below — the body is caller-supplied and must not be able to set either.
  const { depositId } = JSON.parse(event.body || "{}");
  if (!depositId) return { statusCode: 400, body: "depositId required" };

  const store = getStore("ub-deposits");
  const patch = async (fields) => {
    const prev = (await store.get(`dep:${depositId}`, { type: "json" }).catch(() => null)) ?? {};
    await store.setJSON(`dep:${depositId}`, { ...prev, ...fields, updatedAt: new Date().toISOString() });
  };

  const rec = await store.get(`dep:${depositId}`, { type: "json" }).catch(() => null);

  // ── CLAIM — single-use. A replayed or double-invoked call finds the record already past
  // "starting" and does nothing. Without this, one depositId could deposit twice. ──
  if (!rec) return { statusCode: 404, body: "unknown depositId" };
  if (rec.status !== "starting") {
    return { statusCode: 200, body: `already ${rec.status} — not re-running` };
  }

  // The amount and owner come from the RECORD, not the request body — a replayed body cannot
  // smuggle in a different amount or point the deposit at someone else's wallet.
  const amount = Number(rec.amountUsdc);
  const depositor = rec.walletAddress;

  // ── THE CAP, re-checked. Defence in depth: the executor below is uncapped. ──
  const cap = ubDepositMaxPerTxUsdc();
  if (!(amount > 0) || amount > cap) {
    await patch({ status: "failed", error: `amount ${amount} outside the per-deposit limit of ${cap} USDC`, fundsMoved: false });
    return { statusCode: 400, body: "amount outside cap" };
  }

  await patch({ status: "executing" });

  try {
    const r = await ubDeposit({ amountUsdc: amount, owner: depositor });
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
