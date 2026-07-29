import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { isTransient } from "./_retry.mjs";
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
  if (event.blobs) connectBlobs(event);

  // Only our own trigger may run this. A public caller would otherwise reach a raw executor.
  if (!requireInternal(event)) return { statusCode: 401, body: "unauthorized" };

  // ONLY the depositId is taken from the body. The amount and the depositor are read from the
  // persisted record below — the body is caller-supplied and must not be able to set either.
  const { depositId } = JSON.parse(event.body || "{}");
  if (!depositId) return { statusCode: 400, body: "depositId required" };

  const store = getStore("ub-deposits");
  // Last line of defence before a raw error reaches a user. Our own error classes already
  // carry short, honest messages — pass those through untouched. Anything else may be a viem
  // block ("Raw Call Arguments", hex calldata, a docs link): take its first line only, and if
  // even that looks like a dump, say something true and plain instead of leaking it.
  const userMessage = (e) => {
    if (e?.name === "DelegateAuthError" || e?.name === "DelegateAuthUnknownError") return e.message;
    if (e?.transient === true || e?.name === "TransientChainError") return e.message;
    // A transient that reached here UNSTAMPED (an unwrapped read, or a future one someone
    // forgets to wrap) still deserves its real cause, not the generic line. Say what actually
    // happened — the evidence supports it, because isTransient read it off the error.
    if (isTransient(e)) {
      return (
        "Arc's network is rate-limiting requests right now, so the deposit couldn't be " +
        "completed. Nothing was changed — try again in a moment."
      );
    }
    const first = String(e?.message ?? "").split("\n")[0].trim();
    // ⚠️ NOT-transient reaching here is a GENUINE failure, and this generic line must not
    // dress it up as a passing glitch. "Try again in a moment" would be a lie for a revert or
    // a bad address — it says the fault is temporary when we have no evidence it is. Say only
    // what we know: it failed, and we're not summarizing a viem dump at the user.
    if (!first || /^RPC Request failed|^HTTP request failed|^The contract function/i.test(first)) {
      return "The deposit failed. This isn't a temporary network problem — please report it if it repeats.";
    }
    return first.slice(0, 200);
  };
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
    //  · transient: the chain DID NOT ANSWER (Arc rate-limit). Not a failure of the deposit's
    //    logic and NOT a definite negative — see _retry.mjs. Kept separate from
    //    delegateAuthFailed precisely so "we don't know" never renders as "it didn't work".
    //  · allowanceDangling: a deposit failed AND the revoke also failed — real on-chain
    //    residue an operator must know about.
    //
    // ⚠️ `error` IS USER-FACING — UnifiedBalancePanel prints it verbatim. On 2026-07-17 this
    // line was `error: e.message`, and a throttled eth_call put viem's full hex dump on the
    // user's screen (records dep:07960ec2 / dep:1533b09c / dep:648c1c0b). Store the SHORT
    // message; the raw text stays for operators in `errorDetail`, which no view renders.
    // ⚠️ DERIVED FROM THE ERROR, NOT FROM WHO CAUGHT IT. This used to read
    // `e.transient === true || e.name === "TransientChainError"` — i.e. it trusted a stamp
    // that only withRetry applies. Record dep:07fdbcb0 (2026-07-17 09:58) throttled on an
    // UNWRAPPED read, so nothing stamped it, and the record was written `transient: false`
    // while its own errorDetail said "request limit reached". A reader then took the flag as
    // ground truth and concluded the throttle wasn't a throttle. A flag that can be a false
    // negative is worse than no flag: it invites exactly that reasoning.
    //
    // isTransient() inspects the error ITSELF (walking .cause), so it is true whenever the
    // failure really was the transient class — wrapped, unwrapped, retried or not. Every read
    // on this path is wrapped as of this change, but the flag must not DEPEND on that being
    // true forever: someone will add read #5 and forget.
    const transient = isTransient(e) || e.transient === true || e.name === "TransientChainError";
    const indeterminate = e.indeterminate === true;
    await patch({
      status: "failed",
      error: userMessage(e),
      errorDetail: String(e.cause?.message ?? e.message ?? "").slice(0, 2000), // operators only
      delegateAuthFailed: e.name === "DelegateAuthError",
      delegateAuthUnknown: e.name === "DelegateAuthUnknownError",
      transient,
      indeterminate,
      allowanceDangling: e.allowanceDangling === true,
      allowanceRevoked: e.allowanceRevoked === true,
      // Both delegate errors are thrown BEFORE any approve/deposit (see the ordering note in
      // _ubdeposit.mjs), so "no funds moved" is a structural fact here, not an inference.
      fundsMoved:
        e.name === "DelegateAuthError" || e.name === "DelegateAuthUnknownError"
          ? false
          : undefined,
    });
  }

  return { statusCode: 200, body: "ok" };
}
