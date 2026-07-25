// slots.mjs — the storage slots and bytecode patterns that IDENTIFY a contract's shape.
//
// ⚠️ EIP1967_IMPL_SLOT IS NOT HERE ON PURPOSE. It lives in shared/onchain-facts/index.mjs and is
// imported from there. This file holds only what that primitive does not already carry, so there is
// exactly one home for each constant.
//
// ⚠️ LOGGED DUPLICATION — EIP1967_ADMIN_SLOT also exists at scripts/dd/checks/owner-powers.mjs:59.
// Two copies of a constant is this repo's oldest bug ([[duplicate-source-of-truth]]), so this is a
// deliberate, stated decision rather than an oversight: consolidating it would mean editing either
// the Step-1 primitive (which is frozen for this slice) or an existing dd/ check (which this slice
// must not touch). The drift risk is near zero — it is a keccak-derived immutable defined by the EIP,
// not a policy value — but it IS a second copy. Consolidate in the hardening pass.

/** keccak256("eip1967.proxy.admin") - 1. Set on TRANSPARENT proxies; empty on UUPS. */
export const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

// ── EIP-1167 minimal proxy ────────────────────────────────────────────────────────────────────
// The canonical clone's ENTIRE runtime code is 45 bytes: a fixed prefix, the 20-byte target, a fixed
// suffix. Nothing else is in there — which is why a clone must never be selector-scanned directly:
// it has no business selectors at all, so a scan reports a clean bill on whatever the target can do.
// Matching is on the code we already fetched, so identifying a clone costs no extra RPC.
export const EIP1167_PREFIX = "363d3d373d3d3d363d73";
export const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

/** The clone's delegation target, or null if this is not a canonical minimal proxy. */
export function eip1167Target(code) {
  const c = String(code || "").toLowerCase().replace(/^0x/, "");
  if (!c.startsWith(EIP1167_PREFIX) || !c.endsWith(EIP1167_SUFFIX)) return null;
  const target = c.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40);
  return /^[0-9a-f]{40}$/.test(target) ? "0x" + target : null;
}

// ── EIP-2535 diamond ──────────────────────────────────────────────────────────────────────────
// The loupe is MANDATORY in the standard, so its selectors are the reliable fingerprint. `diamondCut`
// is the mutation entry point and is listed separately because a diamond can be immutable (cut
// removed) while remaining a diamond — presence of the loupe is the shape, presence of the cut is a
// power.
export const DIAMOND_LOUPE_SIGS = [
  "facets()",
  "facetFunctionSelectors(address)",
  "facetAddresses()",
  "facetAddress(bytes4)",
];
export const DIAMOND_CUT_SIGS = ["diamondCut((address,uint8,bytes4[])[],address,bytes)"];

// UUPS keeps its upgrade entry point in the IMPLEMENTATION, not the proxy — that asymmetry is what
// distinguishes it from transparent, whose upgrade path lives behind the admin slot.
export const UUPS_SIGS = ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"];
