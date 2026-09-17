// vault-profiles.mjs — the governance-vocabulary REGISTRY and the recognition gate.
//
// ⭐ WHY THIS EXISTS — the false-clean-bill defect. The vault inspector's owner-power scan looks for
// ONE vocabulary of admin selectors (XyloVault-shaped: setFees / emergencyWithdraw / pause). A vault
// whose governance surface uses a DIFFERENT vocabulary (e.g. a Morpho vault: setFee / setCurator /
// setSendSharesGate) has none of those, so "selector absent → power absent" reports a CLEAN BILL —
// while in fact a Morpho V1 Owner can raise the fee with no Guardian veto and a Curator can set an
// exit-blocking gate. Right address, wrong power vocabulary, reported as safe.
//
// ⭐ THE INVERSION. "selector absent → power absent → safe" is valid ONLY inside a power vocabulary we
// recognise. So recognition comes FIRST: match the bytecode's governance selectors against a named
// profile. Recognised → the caller scans that profile's powers as before. UNRECOGNISED → the caller
// must return NOT CHECKED with a reason, never a reassuring absence. Morpho is the second vocabulary;
// there will be a third — this registry is the durable fix, not a Morpho-specific patch.

import { sel } from "./index.mjs";

// The ERC-4626 required interface — a FROZEN standard. Two consumers: (1) the structural guard below
// forbids a fingerprint from keying on it (both Xylo and Morpho are conformant, so an ERC-4626
// selector recognises EVERY vault); (2) analyze() (shared/onchain-analyze) uses it to decide "is this
// a vault" before applying the recognition gate — the deposit path (inspectVault) applies the same
// gate only to ERC-4626 vaults, and the recognition-agreement test pins that the two paths do not
// diverge. It mirrors _vault.mjs's ERC4626_REQUIRED (same 12 methods, a frozen standard).
export const ERC4626_METHODS = Object.freeze([
  "asset()", "totalAssets()", "convertToShares(uint256)", "convertToAssets(uint256)",
  "maxDeposit(address)", "maxWithdraw(address)", "previewDeposit(uint256)", "previewRedeem(uint256)",
  "deposit(uint256,address)", "mint(uint256,address)", "withdraw(uint256,address,address)", "redeem(uint256,address,address)",
]);

/**
 * The registry. Each profile is a governance vocabulary: a `fingerprint` (the DISTINCTIVE admin
 * selectors that identify the implementation family — ALL must be present to recognise) plus its
 * name/label. The fingerprint must NEVER be an ERC-4626 selector (enforced below).
 *
 * ⛔ Morpho V1 (MetaMorpho) and V2 (Vault V2) profiles are Scope 2 — deliberately NOT added here yet.
 * This ships the registry + the recognition gate only; a Morpho selector set is a FIXTURE, not a
 * profile, until that work is greenlit.
 */
export const VAULT_PROFILES = Object.freeze([
  Object.freeze({
    name: "xylo",
    label: "XyloVault-family — setFees(uint256,uint256,uint256) / emergencyWithdraw(address,uint256) admin surface",
    fingerprint: Object.freeze(["setFees(uint256,uint256,uint256)", "emergencyWithdraw(address,uint256)"]),
  }),
]);

// ═══ STRUCTURAL GUARD (constraint: the fingerprint must NOT key on ERC-4626) ══════════════════════
// Enforced at module load, not merely documented — a future profile that fingerprints on an ERC-4626
// method would recognise every vault and silently re-open the defect. This throws instead.
const _erc4626Sels = new Set(ERC4626_METHODS.map(sel));
for (const p of VAULT_PROFILES) {
  if (!Array.isArray(p.fingerprint) || p.fingerprint.length < 1) {
    throw new Error(`vault-profiles: profile "${p.name}" has an empty fingerprint — a profile that recognises on nothing recognises everything`);
  }
  for (const sig of p.fingerprint) {
    if (_erc4626Sels.has(sel(sig))) {
      throw new Error(`vault-profiles: profile "${p.name}" fingerprint keys on ERC-4626 selector "${sig}" — both Xylo and Morpho are ERC-4626 conformant, so that recognises EVERY vault. Fingerprints must be distinctive GOVERNANCE selectors.`);
    }
  }
}

/** The set of ERC-4626 selectors, exported so a test can assert the invariant independently. */
export const ERC4626_SELECTORS = Object.freeze([..._erc4626Sels]);

/**
 * Recognise a vault's governance vocabulary from its bytecode.
 * @param {(sig: string) => boolean} hasSelector — does the bytecode contain this signature's selector?
 * @returns the matching profile, or `null` when the power surface is UNRECOGNISED. The caller MUST
 *          treat null as "not checked" (refuse / notChecked), NEVER as "no powers".
 */
export function recognizeVaultProfile(hasSelector) {
  for (const p of VAULT_PROFILES) {
    if (p.fingerprint.every((sig) => hasSelector(sig))) return p;
  }
  return null;
}
