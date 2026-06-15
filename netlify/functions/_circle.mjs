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
// that hasn't settled in `tries * 2s` is usually still pending, not dead, so the
// caller can distinguish "slow" from "reverted" and surface the right message.
export class TxPendingError extends Error {
  constructor(id) {
    super("Transaction still pending after timeout — it may still settle");
    this.name = "TxPendingError";
    this.txId = id;
  }
}

export async function waitForTx(client, id, tries = 30) {
  if (!id) throw new Error("No transaction id returned from Circle");
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data } = await client.getTransaction({ id });
    const state = data?.transaction?.state;
    if (state === "COMPLETE") return data.transaction.txHash;
    if (state === "FAILED") throw new Error("Transaction failed on-chain");
  }
  throw new TxPendingError(id);
}
