import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";

// SECRET PLANE. apiKey + entitySecret are read from server-only env vars and
// never leave the function. If either is missing we fail loudly rather than
// silently behaving as if unauthenticated.
export function circle() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error(
      "Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET (server env). " +
        "Set them in Netlify env vars — never with a VITE_ prefix."
    );
  }
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

// Poll a Circle transaction until it settles. Returns the tx hash.
//
// On timeout we throw a TxPendingError (not a generic failure): a MEDIUM-fee tx
// that hasn't settled within the deadline is usually still pending, not dead, so
// the caller can distinguish "slow" from "reverted" and surface the right message.
export class TxPendingError extends Error {
  constructor(id) {
    super("Transaction still pending after timeout — it may still settle");
    this.name = "TxPendingError";
    this.txId = id;
  }
}

// ── POLL CADENCE — measured, not guessed. ────────────────────────────────────────────
// This used to sleep a flat 2s between polls, starting with a 2s sleep BEFORE the first
// check. Measured against real Circle txs on Arc (createDate → updateDate on the live
// deposit run): a tx reaches COMPLETE in **2–3s**.
//
// So the 2s wait is not the problem — the 2s GRANULARITY is. A tx that confirms at 3.0s
// isn't observed until the poll at ~4.3s, silently burning 1–2s PER TRANSACTION. The
// deposit path runs two txs back-to-back (approve + deposit), so it was losing 2–4s to
// rounding alone and landing at ~8.9s against Netlify's 10s sync-function ceiling —
// ~90% of budget, permanently, on the main funding path.
//
// Fix: keep an initial wait (the tx genuinely cannot be done sooner — polling at 100ms
// would just burn API calls), then poll FINELY so we catch completion when it actually
// happens instead of rounding up to the next 2s boundary.
const FIRST_WAIT_MS = 1500; // nothing confirms faster than this; don't waste calls
const POLL_MS = 400; // fine enough that we catch a 2–3s confirm within ~0.4s
const DEADLINE_MS = 60_000; // same overall budget as the old 30 × 2s

export async function waitForTx(client, id, deadlineMs = DEADLINE_MS) {
  if (!id) throw new Error("No transaction id returned from Circle");
  const giveUpAt = Date.now() + deadlineMs;

  await new Promise((r) => setTimeout(r, FIRST_WAIT_MS));
  while (Date.now() < giveUpAt) {
    const { data } = await client.getTransaction({ id });
    const state = data?.transaction?.state;
    if (state === "COMPLETE") return data.transaction.txHash;
    // ═══ 🚨 "FAILED" COVERS TWO DIFFERENT THINGS, AND THIS USED TO ASSERT THE WRONG ONE ═══════
    // The old message was the flat string "Transaction failed on-chain". Circle marks a transaction
    // FAILED both when it was broadcast and REVERTED, and when Circle REFUSED IT AT ESTIMATION and
    // it never touched the chain at all. Telling a user their transaction failed on-chain when no
    // transaction ever reached the chain asserts something we did not observe — the same defect as
    // the UI's "Send failed", and it surfaced six times in one burst against the vanilla seller.
    //
    // ⭐ THE DISCRIMINATOR WAS ALREADY KNOWN AND NEVER PROPAGATED HERE. spike-step4b, step4c and
    // step5b all record it in those words: "NO HASH → never broadcast". A FAILED transaction with a
    // txHash reverted; a FAILED transaction without one was rejected before broadcast. That
    // distinction matters to a caller deciding whether to retry — a revert will revert again, a
    // pre-broadcast rejection may not — and it decides whether gas was spent.
    //
    // ⚠️ ADDITIVE, NEVER A REPLACEMENT (the errorWithPayload precedent): every existing caller reads
    // `e.message` and keeps working. The structured fields ride alongside so a caller CAN branch
    // without parsing prose. 12+ money-path functions depend on this helper; nothing asserts on the
    // old wording (checked before changing it).
    if (state === "FAILED") {
      const txHash = data?.transaction?.txHash ?? null;
      const reason = data?.transaction?.errorReason ?? data?.transaction?.errorDetails ?? null;
      const err = new Error(
        txHash
          ? `Transaction reverted on-chain${reason ? ` (${reason})` : ""} — tx ${txHash}`
          : `Circle rejected the transaction before broadcast${reason ? ` (${reason})` : ""} — it never reached the chain`
      );
      err.circleId = id;
      err.txHash = txHash;
      err.broadcast = Boolean(txHash);   // ⭐ the fact, separate from the prose
      err.errorReason = reason;
      throw err;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new TxPendingError(id);
}
