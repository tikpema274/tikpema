// operator-wallets.mjs — THE WALLETS WE CONTROL, DERIVED FROM CONFIG, NEVER RETYPED.
//
// ═══ ⭐⭐ WHY THIS EXISTS: A LIST SOMEONE MUST REMEMBER TO UPDATE IS THE SAME FAILURE ═══════════
// The chain-derived bridge sweeper enumerates owners from the receipt store's `o/<owner>/` prefixes,
// so it can only look where somebody ALREADY has a receipt. MEASURED 2026-09-06: the agent SCA is
// not among the store's 14 owners, so a burn from it — which is exactly what `bridge-direct.mjs` and
// `spike-bridge.mjs` produce — would be invisible to discovery FOREVER, not merely until the next
// sweep. The blind spot is permanent and total for any wallet with no receipt yet.
//
// ⛔ AND THE OBVIOUS FIX IS THE ONE TO AVOID: pasting three addresses into the sweeper. That is a
// second copy of a fact config already holds, and it rots the day a fourth wallet appears —
// silently, because nothing fails when a wallet is merely *not scanned*. Absence reads as "no
// undocumented burns". [[duplicate-source-of-truth-is-the-recurring-bug]] · [[absence-must-never-read-as-safe]]
//
// ⭐ SO THE NAMES LIVE HERE, ONCE, AND THE VALUES COME FROM THE ENVIRONMENT THAT ALREADY DEFINES
// THEM. Adding a wallet to the operator config means adding ONE line to OPERATOR_WALLET_VARS — the
// sweeper is not edited, and `verify-bridge-discover` asserts that by deriving its expectation from
// this same array rather than from a copy of it.
//
// ⚠️ WHAT THIS IS NOT: an allowlist, a capability, or a claim that these wallets are trusted. It is
// only "look here too". Nothing branches on membership; the scan set is a UNION and the sweeper
// treats a seeded owner exactly like a store-derived one.

/** The env vars that name a wallet we control. ⭐ ONE LINE PER WALLET — this array is the surface. */
export const OPERATOR_WALLET_VARS = Object.freeze([
  "AGENT_WALLET_ADDRESS",   // the agent SCA — bridge-direct.mjs / spike-bridge.mjs default source
  "DELEGATE_ADDRESS",       // the delegate EOA that signs x402 payments
  "VANILLA_SELLER_ADDRESS", // the vanilla x402 seller EOA
  "DD_PAYTO_ADDRESS",       // the DD revenue wallet
]);

const isAddress = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v.trim());

/**
 * The operator wallets present in this environment, lowercased and de-duplicated.
 *
 * ⚠️ AN UNSET VAR IS SKIPPED, NOT AN ERROR. These scripts and jobs run in environments that
 * legitimately hold only some of them, and refusing to scan at all because one is missing would
 * trade a partial blind spot for a total one. ⭐ But the caller can see what was resolved and what
 * was not — `operatorWalletReport()` names both, so "we scanned 2 of 4" is never silently "we
 * scanned everything".
 */
export function operatorWallets(env = process.env) {
  const out = new Set();
  for (const name of OPERATOR_WALLET_VARS) {
    const v = env?.[name];
    if (isAddress(v)) out.add(v.trim().toLowerCase());
  }
  return [...out];
}

/** What resolved and what did not — so a caller can REPORT coverage rather than assume it. */
export function operatorWalletReport(env = process.env) {
  const resolved = [], missing = [];
  for (const name of OPERATOR_WALLET_VARS) {
    (isAddress(env?.[name]) ? resolved : missing).push(name);
  }
  return { resolved, missing, addresses: operatorWallets(env) };
}

/**
 * ⭐⭐ THE SCAN SET IS A UNION, AND THAT IS THE WHOLE POINT. Store-derived owners are everyone who
 * already has a receipt; operator-derived owners are the wallets that would otherwise never be
 * looked at because they have none yet. Neither set is sufficient alone.
 */
export function scanOwnerSet(storeOwners = [], env = process.env) {
  const out = new Set();
  for (const o of storeOwners) if (isAddress(o)) out.add(o.trim().toLowerCase());
  for (const o of operatorWallets(env)) out.add(o);
  return [...out];
}
