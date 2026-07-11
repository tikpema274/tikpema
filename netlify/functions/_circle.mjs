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
    if (state === "FAILED") throw new Error("Transaction failed on-chain");
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new TxPendingError(id);
}
