// vault-redemption.mjs — WHAT maxRedeem MEANS, per vault type, and the ONE classifier both readers use.
//
// ═══ THE DEFECT THIS EXISTS FOR (measured 2026-09-26, PROGRESS "MORPHO V2 ON ARC MAINNET") ═════════
// `maxRedeem` means different things per vault type. On XyloVault it is the holder's balanceOf (verified
// source), so 0 means "you cannot redeem". On Morpho Vault V2 it ALWAYS returns 0, by design ("Gross
// underestimation because being revert-free cannot be guaranteed when calling the gate" — VaultV2.sol).
// Two readers — inspectVault (_vault.mjs) and the mandate's state-reads.mjs — mapped maxRedeem to
// full/partial/BLOCKED as if it meant one thing, so a V2 holder read as "blocked": a FALSE
// redemption-restricted finding on a vault that was fully liquid.
//
// ═══ THE RULE ═════════════════════════════════════════════════════════════════════════════════════
// A read whose MEANING depends on the vault type is interpreted only under a RECOGNISED profile — the
// rule the recognition gate (4bc0d03) already applies to owner powers. Each profile declares its
// redemption signal here; an unrecognised vault, an undeclared profile, or a declared-but-unbuilt
// signal is UNKNOWN with a reason — never "blocked", never "full".
//
// ⭐ WHY THIS MAP IS NOT IN vault-profiles.mjs: that registry is on the DD SURFACE (shared/onchain-facts,
// hashed into ddTree), and an edit there rotates the DD code identity and opens a refusal window. The
// profile NAME is the key; what it means for redemption lives here, off the surface.
// ⚠️ Any future liquidity reader must go through this too: the 2026-09-26 probe trusted an inner V2
// vault's maxWithdraw and read 0% where the vault was 100% redeemable. test:redemptionsignal guards that
// only the two sites call maxRedeem/maxWithdraw, and only via classifyRedemption.

export const REDEMPTION_SIGNAL = Object.freeze({
  /** maxRedeem(holder) is the redeemable share count, so it can be compared with the balance. */
  MAX_REDEEM: "max-redeem",
  /** Exit liquidity (idle + the liquidity market's reachable cash) + a simulated redeem. NOT BUILT. */
  EXIT_LIQUIDITY: "exit-liquidity",
});

/** Keyed by vault-profile NAME (shared/onchain-facts/vault-profiles.mjs). Undeclared → no signal. */
export const PROFILE_REDEMPTION_SIGNAL = Object.freeze({
  // XyloVault: maxRedeem(owner) is balanceOf(owner) (verified source, explorer 2026-09-25).
  xylo: REDEMPTION_SIGNAL.MAX_REDEEM,
  // Morpho Vault V2: maxRedeem is always 0. The signal is exit liquidity + a simulated redeem, which is
  // not built — so today this resolves to NO signal (unknown), never to maxRedeem.
  "morpho-v2": REDEMPTION_SIGNAL.EXIT_LIQUIDITY,
});

/** Signals the classifier can actually evaluate today. */
const BUILT = new Set([REDEMPTION_SIGNAL.MAX_REDEEM]);

/**
 * The redemption signal for a recognised profile.
 * @param {string|null|undefined} profileName  the recognised profile's name, or null when unrecognised
 * @returns {{signal: string|null, why: string|null}}  `signal` null ⇒ redemption is UNKNOWN, `why` says why
 */
export function redemptionSignalFor(profileName) {
  if (!profileName) {
    return { signal: null, why: "this vault's type is not recognised, so its maxRedeem cannot be interpreted (on some vaults, such as Morpho V2, it is always 0 by design) — whether you can redeem is UNKNOWN, not blocked" };
  }
  const declared = PROFILE_REDEMPTION_SIGNAL[profileName];
  if (!declared) {
    return { signal: null, why: `no redemption signal is declared for the "${profileName}" vault type — whether you can redeem is UNKNOWN, not blocked` };
  }
  if (!BUILT.has(declared)) {
    return { signal: null, why: `this vault type's redemption signal (${declared}) is not built yet — whether you can redeem is UNKNOWN, not blocked` };
  }
  return { signal: declared, why: null };
}

/**
 * ONE mapping from reads to a redemption state, for every reader.
 * @param {{signal: string|null, why?: string|null, maxRedeem: bigint|null|undefined, shares: bigint|null|undefined}} a
 * @returns {{state: "full"|"partial"|"blocked"|"unknown", redeemableShares: bigint|null, why: string|null}}
 *   ⚠️ `unknown` never collapses into `blocked` — both would read "you cannot withdraw", and only one is a fact.
 */
export function classifyRedemption({ signal, why = null, maxRedeem, shares }) {
  const unknown = (reason) => ({ state: "unknown", redeemableShares: null, why: reason });
  if (signal !== REDEMPTION_SIGNAL.MAX_REDEEM) {
    return unknown(why ?? "no redemption signal applies to this vault — whether you can redeem is UNKNOWN, not blocked");
  }
  if (typeof maxRedeem !== "bigint" || typeof shares !== "bigint") {
    return unknown("the redemption limit could not be read — whether you can withdraw right now is UNKNOWN, not blocked");
  }
  const redeemableShares = maxRedeem < shares ? maxRedeem : shares;
  const state = shares === 0n ? "full" // nothing held: nothing is being withheld
    : maxRedeem === 0n ? "blocked"
    : maxRedeem >= shares ? "full" : "partial";
  return { state, redeemableShares, why: null };
}
