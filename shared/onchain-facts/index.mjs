// shared/onchain-facts — the FACT-PRODUCTION primitives, shared by the vault inspector
// (netlify/functions/_vault.mjs), the DD engine (scripts/dd/), and later the standalone service.
//
// ═══ WHY THIS MODULE EXISTS ═══════════════════════════════════════════════════════════════════
// Two codebases were doing overlapping on-chain owner-power analysis with two copies of the same
// tables and the same selector logic. A copied claim always drifts ([[duplicate-source-of-truth]]),
// and one copy — scripts/dd/checks/owner-powers.mjs — carried a milder form of the vault's own
// defect A (an RPC-exhausted owner() read misclassified as "no owner function"). This module is the
// single source of truth for the parts that are genuinely shared.
//
// ═══ THE CUT LINE — read before adding anything here ══════════════════════════════════════════
// SHARED (here): the FACT-shape concern — selector-in-bytecode primitives, the power/owner-shape
//   CATALOGUE, and the tri-state INTERPRETATION of already-read values (classifyOwnerType).
// NOT SHARED (stays in each caller): TRANSPORT. _vault reads via viem multicall; scripts/dd/ reads
//   via raw fetch so it can emit a reproducible curl per fact. This module never touches the wire —
//   every function is PURE over values the caller already fetched. That is what lets both callers
//   keep their incompatible transports while sharing the interpretation. Do not add a read here.
// NOT SHARED (stays in _vault): the VERDICT layer (BLOCK/WARN/OK + digest + ack). A fact is not a
//   verdict. Do not add a severity, a "pass", or a digest here.
//
// ═══ THE THIRD STATE — the reason the interpretation is worth sharing ═════════════════════════
// A read has THREE outcomes, not two: a VALUE, a confirmed ABSENCE (`null` — we asked, the chain
// answered "no such method" / the call reverted), and UNREADABLE (we could not ask at all).
// Collapsing the third into the second is the fail-open family this whole module guards against: an
// unread owner() must never become the reassuring "renounced", an unread slot never "not upgradeable".
//
// UNREADABLE is a Symbol on purpose: not falsy, equal to nothing, throws on arithmetic — a caller
// that forgets the third state fails LOUDLY instead of silently taking the safe-looking branch.
// (Same discipline as scripts/dd/fact.mjs, whose `error` facts carry `result: null` for this reason.)

import { toFunctionSelector } from "viem";

export const UNREADABLE = Symbol("unreadable");
export const unread = (v) => v === UNREADABLE;

// ── Selector-in-bytecode primitives ──────────────────────────────────────────────────────────
// The Solidity dispatcher embeds every external selector in the deployed code, so scanning bytecode
// finds state-changing functions too — works on unverified contracts, needs no explorer, cannot be
// fooled by a wrong ABI. `sel` → 8-hex, no 0x. `hasAny` → the matched signatures (not a boolean),
// so a caller can report WHICH variant matched.
export const sel = (sig) => toFunctionSelector(sig).slice(2).toLowerCase();
export const hasSel = (code, sig) => code.includes(sel(sig));
export const hasAny = (code, sigs) => sigs.filter((s) => hasSel(code, s));

// ── The owner-power CATALOGUE — the UNION of what both callers scan for ───────────────────────
// ⚠️ This is the UNION on purpose. scripts/dd/ scans all nine groups; _vault scans only four of
// them (emergencyWithdraw, feesSettable, pausable, upgradeable) and deliberately leaves the rest
// unscanned, because wiring a new group into _vault's disclosure raises a new warn code, which moves
// disclosureDigest(), which invalidates every outstanding ack — money-path work, not a cleanup.
// The catalogue is shared DATA; which groups a caller actually scans is the caller's frozen choice.
// A `_vault`-only catalogue would silently drop denylist/withdrawalDelay from the DD engine — a
// coverage regression — which is exactly why the union lives here and the SELECTION stays per-caller.
// Key order matches scripts/dd/'s historical ALL_SIGS so its `powersPresent` ordering is unchanged.
export const POWER_SIGS = {
  emergencyWithdraw: ["emergencyWithdraw(address,uint256)", "emergencyWithdraw()", "sweep(address)", "rescueTokens(address,uint256)", "rescue(address,uint256)"],
  feesSettable: ["setFees(uint256,uint256,uint256)", "setFee(uint256)", "setWithdrawFee(uint256)", "setDepositFee(uint256)", "setPerformanceFee(uint256)"],
  setStrategy: ["setStrategy(address)"],
  setFeeRecipient: ["setFeeRecipient(address)"],
  transferOwnership: ["transferOwnership(address)"],
  pausable: ["pause()", "paused()"],
  upgradeable: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"],
  denylist: ["denylist(address)", "unDenylist(address)", "blacklist(address)", "unBlacklist(address)", "isDenylisted(address)"],
  withdrawalDelay: ["updateWithdrawalDelay(uint256)", "withdrawalDelay()", "initiateWithdrawal(address,uint256)"],
};

// Owner-contract fingerprints (to classify a contract owner: safe-multisig / timelock / other).
export const SAFE_SIGS = ["getThreshold()", "getOwners()"];
export const TIMELOCK_SIGS = ["getMinDelay()", "TIMELOCK_ADMIN_ROLE()"];

// EIP-1967 implementation storage slot — a non-zero value means the contract is a proxy, i.e. its
// logic is upgradeable behind the same address. keccak256("eip1967.proxy.implementation")-1.
export const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// ── Owner classification — PURE, and the home of the defect-A fix ─────────────────────────────
// Interprets two ALREADY-READ values into an owner TYPE. It does NOT read the chain: the caller
// fetches owner() and (for a real address) the owner's bytecode, then passes them here, each carrying
// its own third state. The caller attaches the human LABEL and any transport evidence — this returns
// the canonical type + address ONLY, so it can never encode one caller's prose into the other's.
//
//   ownerValue        : the owner() read — an address string, `null` (confirmed no owner()/revert),
//                       or UNREADABLE (the read did not complete).
//   ownerCodeResult   : the owner-address bytecode read — a hex string, or UNREADABLE, or `undefined`
//                       when the caller correctly did not read it (the early classes never touch it).
//
// 🚨 DEFECT A LIVED IN THE FIRST BRANCH. The old logic treated a falsy owner as the zero address →
// "renounced", the ONE owner class that raises no warning. An owner() that was never read is falsy,
// so an RPC failure produced the single most reassuring answer on no evidence. `renounced` is now
// reachable ONLY from a confirmed zero-address read; every other unknown says what actually happened.
export function classifyOwnerType(ownerValue, ownerCodeResult) {
  // Could not ask. NOT renounced, NOT ownerless — unknown.
  if (unread(ownerValue)) return { address: null, type: "unreadable" };
  // Asked, and the chain answered there is no owner(). A real observation, but NOT proof of
  // ownerlessness — a role-based admin (AccessControl) exposes no owner() and holds every power.
  if (ownerValue === null || ownerValue === undefined) return { address: null, type: "no-owner-fn" };
  // A confirmed zero address — the ONLY path to `renounced`.
  if (/^0x0+$/.test(String(ownerValue))) return { address: ownerValue, type: "renounced" };
  // Real, non-zero owner: classify by its own bytecode. The address is known but the code may not be —
  // must not default to `eoa`, which would be a guess wearing a verdict (the unreadable-kind case).
  if (unread(ownerCodeResult) || (ownerCodeResult !== undefined && ownerCodeResult !== null && typeof ownerCodeResult !== "string")) {
    return { address: ownerValue, type: "unreadable-kind" };
  }
  const c = String(ownerCodeResult || "0x").toLowerCase();
  if (c === "0x" || c === "") return { address: ownerValue, type: "eoa" };
  if (SAFE_SIGS.every((s) => hasSel(c, s))) return { address: ownerValue, type: "multisig" };
  if (TIMELOCK_SIGS.some((s) => hasSel(c, s))) return { address: ownerValue, type: "timelock" };
  return { address: ownerValue, type: "contract" };
}
