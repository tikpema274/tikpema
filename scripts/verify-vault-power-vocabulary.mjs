// verify-vault-power-vocabulary.mjs — the recognition gate: an UNRECOGNISED power surface must
// REFUSE (notChecked / BLOCK), never a clean bill. Zero money, zero network — the RPC client is
// replaced wholesale and the bytecode is synthetic.
//
//   node --experimental-test-module-mocks scripts/verify-vault-power-vocabulary.mjs
//
// ⭐ THE DEFECT, AND WHY THIS GUARD GOES RED ON THE OLD CODE. The inspector scans ONE admin
// vocabulary (Xylo: setFees / emergencyWithdraw / pause). A Morpho-shaped vault has none, so the old
// code reports "no settable fees, no emergency withdraw, not pausable" — a CLEAN BILL. On the fixed
// code the same synthetic Morpho vault is UNRECOGNISED → a `power-surface-unrecognised` BLOCK and
// notChecked owner-power fields. Run this file against the pre-fix inspector and the Morpho section
// FAILS (clean bill); that failure is the recorded RED state.

import { mock } from "node:test";
import { recognizeVaultProfile, VAULT_PROFILES, ERC4626_SELECTORS } from "../shared/onchain-facts/vault-profiles.mjs";
import { sel } from "../shared/onchain-facts/index.mjs";
import { codeWith } from "./dd/_mock-chain.mjs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};

// The 12 ERC-4626 required signatures — both vaults are conformant, so recognition must NOT key here.
const ERC4626 = [
  "asset()", "totalAssets()", "convertToShares(uint256)", "convertToAssets(uint256)",
  "maxDeposit(address)", "maxWithdraw(address)", "previewDeposit(uint256)", "previewRedeem(uint256)",
  "deposit(uint256,address)", "mint(uint256,address)", "withdraw(uint256,address,address)", "redeem(uint256,address,address)",
];
// Xylo governance fingerprint — recognised.
const XYLO_GOV = ["setFees(uint256,uint256,uint256)", "emergencyWithdraw(address,uint256)", "transferOwnership(address)"];
// Morpho-shaped governance — a DIFFERENT vocabulary the inspector does not scan. Deliberately avoids
// every scanned selector (no setFee(uint256), no pause(), no emergencyWithdraw, no upgradeTo).
const MORPHO_GOV = ["setFee(uint96)", "setCurator(address)", "setIsAllocator(address,bool)", "setIsSentinel(address,bool)", "setSendSharesGate(address)", "submitCap(bytes,uint256)"];

// ── PART A · the registry, in isolation (no RPC) ────────────────────────────────────────────────
console.log("\n── PART A · registry recognition ──");
{
  const has = (present) => (sig) => present.includes(sig);
  check("Xylo fingerprint → recognised as 'xylo'", recognizeVaultProfile(has([...ERC4626, ...XYLO_GOV]))?.name === "xylo");
  check("⭐ Morpho vocabulary → UNRECOGNISED (null), not a clean bill", recognizeVaultProfile(has([...ERC4626, ...MORPHO_GOV])) === null);
  check("⛔ ERC-4626 conformance ALONE → UNRECOGNISED (fingerprint must not key on it)", recognizeVaultProfile(has([...ERC4626])) === null);
  // Structural invariant: no fingerprint selector is an ERC-4626 selector.
  const erc = new Set(ERC4626_SELECTORS);
  const leak = VAULT_PROFILES.flatMap((p) => p.fingerprint).filter((s) => erc.has(sel(s)));
  check("no profile fingerprint keys on an ERC-4626 selector", leak.length === 0, leak.join(",") || "clean");
}

// ── PART B · the inspector end-to-end, synthetic bytecode ───────────────────────────────────────
const USDC = "0x3600000000000000000000000000000000000000";
const EOA = "0x5b967871bb9b2ce1ac7e3a3a2ab2ec5c1e4b8a2f";
const VAULT = "0x240Eb85458CD41361bd8C3773253a1D78054f747";
const OK_SLOT = "0x" + "0".repeat(64);
const VALUES = {
  asset: USDC, totalAssets: 8_000_000_000_000n, decimals: 6, symbol: "mvUSDC", name: "Mock Vault USDC",
  totalSupply: 7_900_000_000_000n, withdrawFee: 10n, depositFee: 0n, performanceFee: 0n, MAX_FEE: 2000n, owner: EOA,
  convertToAssets: 1_000_000n, previewRedeem: 999_000n,
};
const fakeClient = (code) => () => ({
  getBytecode: async ({ address }) => (address.toLowerCase() === VAULT.toLowerCase() ? code : "0x"),
  multicall: async ({ contracts }) => contracts.map((c) =>
    c.functionName in VALUES ? { status: "success", result: VALUES[c.functionName] } : { status: "failure", error: new Error("absent") }),
  getStorageAt: async () => OK_SLOT,
});
const inspectWith = async (code) => {
  mock.restoreAll();
  mock.module("../netlify/functions/_predict.mjs", { namedExports: { publicClient: fakeClient(code) } });
  const { inspectVault } = await import(`../netlify/functions/_vault.mjs?t=${Math.random()}`);
  return inspectVault(VAULT);
};
const hasBlock = (i, c) => (i.verdict?.blocks ?? []).some((b) => b.code === c);

console.log("\n── PART B1 · ⭐ Morpho-shaped vault → REFUSE (this section is the RED state on old code) ──");
{
  const i = await inspectWith(codeWith([...ERC4626, ...MORPHO_GOV]));
  const sf = i.ownerPowers?.settableFees ?? {};
  check("power surface is NOT recognised", i.ownerPowers?.powerSurfaceRecognised === false, `profile=${i.ownerPowers?.profile}`);
  check("⭐⭐ a `power-surface-unrecognised` BLOCK is raised (refuse, not clean)", hasBlock(i, "power-surface-unrecognised"));
  check("⭐⭐ verdict level is BLOCK", i.verdict?.level === "BLOCK", i.verdict?.level);
  check("settableFees is notChecked, present is null", sf.notChecked === true && sf.present === null, `present=${sf.present} notChecked=${sf.notChecked}`);
  check("⛔ and carries NO reassuring 'No fee-setter found' note", !/No fee-setter found/i.test(sf.note ?? ""), (sf.note ?? "").slice(0, 50));
  check("emergencyWithdraw is notChecked", i.ownerPowers?.emergencyWithdraw?.notChecked === true);
  check("pausable is notChecked", i.ownerPowers?.pausable?.notChecked === true);
}

console.log("\n── PART B2 · CONTROL · Xylo-shaped vault → recognised and SCANNED ──");
{
  const i = await inspectWith(codeWith([...ERC4626, ...XYLO_GOV]));
  check("power surface recognised as 'xylo'", i.ownerPowers?.powerSurfaceRecognised === true && i.ownerPowers?.profile === "xylo");
  check("NO power-surface block on a recognised vault", !hasBlock(i, "power-surface-unrecognised"));
  check("⭐ settableFees is SCANNED and present:true (not notChecked)", i.ownerPowers?.settableFees?.present === true && !i.ownerPowers?.settableFees?.notChecked);
  check("⭐ emergencyWithdraw is SCANNED and present:true", i.ownerPowers?.emergencyWithdraw?.present === true);
}

console.log("\n── PART B3 · SPECIFICITY · ERC-4626-only (no governance) → UNRECOGNISED ──");
{
  const i = await inspectWith(codeWith([...ERC4626]));
  check("⛔ ERC-4626 conformance alone does NOT recognise → BLOCK", i.ownerPowers?.powerSurfaceRecognised === false && hasBlock(i, "power-surface-unrecognised"));
}

console.log(`\n${"═".repeat(80)}`);
console.log(`verify-vault-power-vocabulary: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
