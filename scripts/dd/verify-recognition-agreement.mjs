// verify-recognition-agreement.mjs — THE TWO PATHS MUST NOT DISAGREE.
//
//   node --experimental-test-module-mocks scripts/dd/verify-recognition-agreement.mjs
//
// The deposit gate (netlify/functions/_vault.mjs inspectVault) and the paid/card engine
// (shared/onchain-analyze analyze()) both apply the SAME recognition gate, from the SAME source
// (recognizeVaultProfile). This guard fails if, for one input, one path refuses an unrecognised vault
// while the other returns a clean/answered result. A false clean bill on EITHER surface is the defect;
// they must move together.
//
// ⛔ RED on the pre-fix HEAD: inspectVault already refuses a Morpho-shaped vault (shipped 4bc0d03),
// but analyze() returned a clean report for it — so the two DISAGREED. This guard turns that red.

import { mock } from "node:test";
import { readFileSync } from "node:fs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { ERC4626_METHODS } from "../../shared/onchain-facts/vault-profiles.mjs";
import { EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import { SUBJ, IMPL, OWNER, ZERO_WORD, word, codeWith, mockClient, transientThrow } from "./_mock-chain.mjs";
import { EIP1967_ADMIN_SLOT } from "../../shared/onchain-analyze/slots.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${l}${x ? ` — ${x}` : ""}`); };

const XYLO_GOV = ["setFees(uint256,uint256,uint256)", "emergencyWithdraw(address,uint256)"];
const MORPHO_GOV = ["setFee(uint96)", "setCurator(address)", "setIsSentinel(address,bool)", "setSendSharesGate(address)"];

// ── DEPOSIT PATH — inspectVault, via the _predict publicClient mock (synthetic bytecode + a valid,
//    funded, non-proxy vault so the ONLY differentiator is the power vocabulary). ────────────────
const VAULT = "0x240Eb85458CD41361bd8C3773253a1D78054f747";
const EOA = "0x5b967871bb9b2ce1ac7e3a3a2ab2ec5c1e4b8a2f";
const USDC = "0x3600000000000000000000000000000000000000";
const OK_SLOT = "0x" + "0".repeat(64);
const VALUES = {
  asset: USDC, totalAssets: 8_000_000_000_000n, decimals: 6, symbol: "mv", name: "mv",
  totalSupply: 7_900_000_000_000n, withdrawFee: 10n, depositFee: 0n, performanceFee: 0n, MAX_FEE: 2000n,
  owner: EOA, convertToAssets: 1_000_000n, previewRedeem: 999_000n,
};
const fakeClient = (code) => () => ({
  getBytecode: async ({ address }) => (address.toLowerCase() === VAULT.toLowerCase() ? code : "0x"),
  multicall: async ({ contracts }) => contracts.map((c) =>
    c.functionName in VALUES ? { status: "success", result: VALUES[c.functionName] } : { status: "failure", error: new Error("absent") }),
  getStorageAt: async () => OK_SLOT,
});
async function depositRefusesUnrecognised(code) {
  mock.restoreAll();
  mock.module("../../netlify/functions/_predict.mjs", { namedExports: { publicClient: fakeClient(code) } });
  const { inspectVault } = await import(`../../netlify/functions/_vault.mjs?t=${Math.random()}`);
  const i = await inspectVault(VAULT);
  return (i.verdict?.blocks ?? []).some((b) => b.code === "power-surface-unrecognised");
}

// ── ANALYZE PATH — via the _mock-chain call() interface. ─────────────────────────────────────
async function analyzeRefusesUnrecognised(code) {
  const base = { [`code@${SUBJ}`]: code, [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x" };
  const r = await analyze(SUBJ, { client: mockClient(base) });
  return r.refusal?.reason === "power-surface-unrecognised";
}

console.log("\n── the deposit gate and analyze() agree on recognition, for every input ──");
const CASES = [
  ["Morpho-shaped (unrecognised vault)", [...ERC4626_METHODS, ...MORPHO_GOV], true],
  ["ERC-4626-only (unrecognised vault)", [...ERC4626_METHODS], true],
  ["Xylo-shaped (recognised vault)", [...ERC4626_METHODS, ...XYLO_GOV], false],
  ["non-vault (pause only)", ["pause()"], false],
];
for (const [name, sigs, expectRefuse] of CASES) {
  const code = codeWith(sigs);
  const dep = await depositRefusesUnrecognised(code);
  const ana = await analyzeRefusesUnrecognised(code);
  check(`⭐ ${name}: deposit=${dep ? "REFUSE" : "allow"} ⟺ analyze=${ana ? "REFUSE" : "allow"} — the paths AGREE`, dep === ana, `deposit=${dep} analyze=${ana}`);
  check(`   …and both match the expected ${expectRefuse ? "REFUSE" : "allow"}`, dep === expectRefuse && ana === expectRefuse);
}

// ── FAIL-OPEN CHECKS — a failed / partial / proxied VAULT probe must NEVER clean-bill. ──────────
// The rule (3b): if analyze() cannot confidently establish a vault is a RECOGNISED vault, it must
// return a no-verdict refusal (or an error) — never a clean report. The deposit gate refuses each of
// these; analyze() must not disagree by returning clean.
async function analyzeReport(handlers) {
  return analyze(SUBJ, { client: mockClient(handlers) });
}
async function depositBlocks(code, { throwCode = false } = {}) {
  mock.restoreAll();
  const fc = throwCode
    ? () => ({ getBytecode: async () => { throw Object.assign(new Error("rpc"), { transient: true }); }, multicall: async ({ contracts }) => contracts.map(() => ({ status: "failure", error: new Error("x") })), getStorageAt: async () => OK_SLOT })
    : fakeClient(code);
  mock.module("../../netlify/functions/_predict.mjs", { namedExports: { publicClient: fc } });
  const { inspectVault } = await import(`../../netlify/functions/_vault.mjs?t=${Math.random()}`);
  const i = await inspectVault(VAULT);
  return (i.verdict?.blocks ?? []).length > 0; // refuses at all
}
const MORPHO_GOV2 = ["setFee(uint96)", "setCurator(address)", "setIsSentinel(address,bool)", "setSendSharesGate(address)"];

console.log("\n── FAIL-OPEN · a failed/partial/proxied vault probe must not clean-bill ──");
{
  // 1. PROBE RPC FAILURE — the effective bytecode read fails.
  const rpc = await analyzeReport({ [`code@${SUBJ}`]: transientThrow });
  check("⭐ RPC-failed probe → analyze REFUSES, not clean", rpc.refusal !== null, `refusal=${rpc.refusal?.reason ?? "NONE (clean bill!)"}`);
  check("   …deposit gate also refuses", await depositBlocks(null, { throwCode: true }));

  // 2. PARTIAL ERC-4626 — one required method's selector missing (e.g. reached via fallback, or a
  //    quirky impl). A vault-shaped surface that is not FULLY conformant must not be clean-billed.
  const partialCode = codeWith([...ERC4626_METHODS.slice(1), ...MORPHO_GOV2]); // drop asset() → 11 of 12
  const partial = await analyzeReport({ [`code@${SUBJ}`]: partialCode, [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD, [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x" });
  check("⭐⭐ partial ERC-4626 (11/12) → analyze REFUSES, not clean", partial.refusal !== null, `refusal=${partial.refusal?.reason ?? "NONE (clean bill!)"}`);
  check("   …deposit gate refuses the same partial contract", await depositBlocks(partialCode));

  // 3. PROXY-FRONTED VAULT — a Morpho impl behind an EIP-1967 proxy. analyze resolves the impl and
  //    must refuse (unrecognised); it must never clean-bill through the proxy.
  const proxy = await analyzeReport({
    [`code@${SUBJ}`]: codeWith([]), [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL), [`slot@${EIP1967_ADMIN_SLOT}`]: word(OWNER),
    [`code@${IMPL}`]: codeWith([...ERC4626_METHODS, ...MORPHO_GOV2]), [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  });
  check("⭐ proxy-fronted Morpho vault → analyze REFUSES, not clean", proxy.refusal !== null, `refusal=${proxy.refusal?.reason ?? "NONE (clean bill!)"}`);
  check("   …deposit gate refuses the proxy stub", await depositBlocks(codeWith([])));
}

// ── DRIFT GUARD — the two ERC-4626 lists must stay identical sets. ──────────────────────────────
// analyze() uses vault-profiles' ERC4626_METHODS; the deposit gate uses _vault.mjs's own
// ERC4626_REQUIRED. They are byte-identical today but are SEPARATE declarations — deliberately NOT
// unified (no deposit-path change). If they ever drift, the two paths could detect "is a vault"
// differently and disagree. This asserts they are the same set; it goes red the moment either changes.
console.log("\n── DRIFT GUARD · _vault ERC4626_REQUIRED === vault-profiles ERC4626_METHODS ──");
{
  const vaultSrc = readFileSync(new URL("../../netlify/functions/_vault.mjs", import.meta.url), "utf8");
  const m = vaultSrc.match(/ERC4626_REQUIRED\s*=\s*\[([\s\S]*?)\]/);
  const reqd = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  const setEq = (a, b) => a.length === b.length && [...new Set(a)].sort().join("|") === [...new Set(b)].sort().join("|");
  check("⭐ the two ERC-4626 lists are identical sets (12 each)", reqd.length === 12 && setEq(reqd, ERC4626_METHODS), `_vault:${reqd.length} vault-profiles:${ERC4626_METHODS.length}`);
}

console.log(`\n${"═".repeat(80)}`);
console.log(`verify-recognition-agreement: ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}  pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
