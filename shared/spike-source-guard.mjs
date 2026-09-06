// spike-source-guard.mjs — refuse a burn from a wallet discovery cannot see, and SAY WHY.
//
// ⭐⭐ THE REASON IS THE GUARD. "Unknown address" tells someone to pass the override; naming the
// CONSEQUENCE — that a burn from here leaves no record anyone will ever find — is what makes them
// stop. A refusal whose text does not survive being read carefully is a speed bump.
//
// ⚠️ THE BLIND SPOT IS REAL AND MEASURED (2026-09-06): the chain-derived sweeper enumerates owners
// from the receipt store, so a wallet with no receipt is never scanned — permanently, not until the
// next sweep. `shared/operator-wallets.mjs` seeds the known ones; an arbitrary SPIKE_FROM is outside
// both sets by construction.

import { operatorWallets } from "./operator-wallets.mjs";

export const SPIKE_SOURCE_REASON = Object.freeze({
  OK_OPERATOR: "operator-wallet",
  OK_KNOWN: "known-to-discovery",
  REFUSED_INVISIBLE: "invisible-to-discovery",
});

/**
 * @param from            the address the burn would come from
 * @param storeOwners     owners that already have receipts (visible to discovery)
 * @param acknowledged    the second flag — deliberate, not incidental
 */
export function checkSpikeSource({ from, storeOwners = [], env = process.env, acknowledged = false } = {}) {
  const f = String(from || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(f)) {
    return { ok: false, reason: SPIKE_SOURCE_REASON.REFUSED_INVISIBLE,
      detail: `"${from}" is not an address, so nothing can be checked about it.` };
  }
  if (operatorWallets(env).includes(f)) return { ok: true, reason: SPIKE_SOURCE_REASON.OK_OPERATOR, detail: null };
  if (storeOwners.map((o) => String(o).toLowerCase()).includes(f)) {
    return { ok: true, reason: SPIKE_SOURCE_REASON.OK_KNOWN, detail: null };
  }
  const detail =
    `${f} has NO receipts in the bridge store and is not one of this deployment's operator wallets.\n` +
    `   The chain-derived sweeper enumerates owners from the receipt store, so it would NEVER scan\n` +
    `   this address — a burn from it would be invisible to discovery permanently, not just until\n` +
    `   the next sweep. The money would move and no record of it would exist anywhere, and nothing\n` +
    `   would report that anything was missing.\n` +
    `   If that is genuinely what you want, pass --accept-invisible as well. If it is not, use an\n` +
    `   operator wallet, or add this one to OPERATOR_WALLET_VARS so discovery can see it.`;
  if (acknowledged) {
    return { ok: true, reason: SPIKE_SOURCE_REASON.REFUSED_INVISIBLE,
      detail: `⚠️ PROCEEDING WITH AN INVISIBLE SOURCE — acknowledged.\n   ${detail}` };
  }
  return { ok: false, reason: SPIKE_SOURCE_REASON.REFUSED_INVISIBLE, detail };
}
