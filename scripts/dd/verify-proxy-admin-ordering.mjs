// verify-proxy-admin-ordering.mjs — FIXING THE BLIND-PROXY GAP MUST NOT OPEN THE PROXY-ADMIN ONE.
//
//   node --experimental-test-module-mocks scripts/dd/verify-proxy-admin-ordering.mjs
//
// ═══ THE PROPERTY ════════════════════════════════════════════════════════════════════════════
// A transparent proxy whose EIP-1967 admin slot holds a live address can replace its implementation,
// whatever owner() says. So for such a vault the deposit gate must either BLOCK, or approve only a
// disclosure that names the upgrade power (`upgradeable`, or `owner-powers-unreadable` naming it when
// the admin could not be read). Never OK, never a WARN the user acked without it.
//
// ═══ WHY IT IS A BEHAVIOUR TEST AND NOT A LOAD-TIME ASSERTION ════════════════════════════════
// Whether `_vault.mjs`'s conformance scan "follows the implementation" is a property of WHICH BYTES it
// scans, not of a constant. An assertion at load could only check a flag somebody must remember to
// flip. Instead the mock below serves the deposit path two different bytecodes for the proxy address:
//   (a) TODAY  — the proxy's own stub. Conformance scans the stub, so the gate BLOCKs `not-erc4626`.
//   (b) FUTURE — the implementation's code, which is exactly what `_vault` would see once the
//                blind-proxy gap (_vault.mjs header, item 3) is fixed to follow the implementation.
// (b) holds only while the DD report counts the admin as an upgrade power. Fix the blind-proxy gap
// without that, and (b) turns red — whether or not whoever did it read this file.
//
// ⛔ RED on the pre-fix tree (2026-10-29): the report scanned only the implementation for upgrade
// selectors, so (b) reached WARN without `upgradeable` and an ack for it was accepted.
//
// ⚠️ WHAT THIS DOES NOT COVER: a fix that makes conformance follow the implementation while
// recognition (recognizeVaultProfile) still scans the stub. The mock changes the one `code` both read,
// so it cannot express that split; such a vault would BLOCK `power-surface-unrecognised` anyway.
//
// Zero money, zero network: both paths read from in-process mocks of the same chain.

import { mock } from "node:test";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { ERC4626_METHODS } from "../../shared/onchain-facts/vault-profiles.mjs";
import { EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import { EIP1967_ADMIN_SLOT } from "../../shared/onchain-analyze/slots.mjs";
import { SUBJ, IMPL, OWNER, ZERO_WORD, word, codeWith, mockClient, transientThrow } from "./_mock-chain.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${l}${x ? ` — ${x}` : ""}`); };

const ADMIN = "0x" + "ad".repeat(20);
const PLAIN_DIGEST_PRE_0_4 =
  "0x1111111111111111111111111111111111111111|warns:emergency-withdraw,fees-settable,owner-is-eoa|wf:10|df:0|holder:0x3333333333333333333333333333333333333333|kind:eoa|v2";
const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x3600000000000000000000000000000000000000";
const XYLO_GOV = ["setFees(uint256,uint256,uint256)", "emergencyWithdraw(address,uint256)"];
// The implementation: a conformant ERC-4626 vault with a RECOGNISED power surface, and no upgrade
// selector of its own — on a transparent proxy the upgrade entry point is in the proxy, not here.
const IMPL_CODE = codeWith([...ERC4626_METHODS, ...XYLO_GOV]);
// The proxy's own stub: an OZ-v5-shaped TransparentUpgradeableProxy exposes only upgradeToAndCall
// (to its admin) and delegates everything else.
const STUB_CODE = codeWith(["upgradeToAndCall(address,bytes)"]);

// ── the DEPOSIT path's chain: inspectVault via the _predict publicClient mock ─────────────────
const VALUES = {
  asset: USDC, totalAssets: 8_000_000_000_000n, decimals: 6, symbol: "pv", name: "pv",
  totalSupply: 7_900_000_000_000n, withdrawFee: 10n, depositFee: 0n, performanceFee: 0n, MAX_FEE: 2000n,
  owner: ZERO, convertToAssets: 1_000_000n, previewRedeem: 999_000n,
};
const fakeClient = ({ codeAtProxy, implSlot }) => () => ({
  getBytecode: async ({ address }) => (address.toLowerCase() === SUBJ ? codeAtProxy : "0x"),
  multicall: async ({ contracts }) => contracts.map((c) =>
    c.functionName in VALUES ? { status: "success", result: VALUES[c.functionName] } : { status: "failure", error: new Error("absent") }),
  getStorageAt: async ({ slot }) => (String(slot).toLowerCase() === EIP1967_IMPL_SLOT.toLowerCase() ? implSlot : ZERO_WORD),
});
async function depositPath(chain) {
  mock.restoreAll();
  mock.module("../../netlify/functions/_predict.mjs", { namedExports: { publicClient: fakeClient(chain) } });
  return import(`../../netlify/functions/_vault.mjs?t=${Math.random()}`);
}

// ── the REPORT's chain: analyze() via the _mock-chain call() interface ────────────────────────
const proxyChain = ({ adminSlot }) => ({
  [`code@${SUBJ}`]: STUB_CODE,
  [`slot@${EIP1967_IMPL_SLOT}`]: word(IMPL),
  [`slot@${EIP1967_ADMIN_SLOT}`]: adminSlot,
  [`code@${IMPL}`]: IMPL_CODE,
  [`call@0x8da5cb5b`]: ZERO_WORD, // owner() renounced
});

/** inspect → report → disclosure → gate, with an ack minted for exactly the disclosure shown. */
async function gateFor({ deposit, report }) {
  const { inspectVault, applyReportDisclosure, gateDeposit, ackTokenFor, disclosureDigest } = await depositPath(deposit);
  const inspection = applyReportDisclosure(await inspectVault(SUBJ), report);
  const gate = gateDeposit({ inspection, ackToken: ackTokenFor(inspection), expectedAssetAddress: USDC });
  const warns = inspection.verdict.warns;
  const namesUpgrade =
    warns.some((w) => w.code === "upgradeable") ||
    warns.some((w) => w.code === "owner-powers-unreadable" && /\bupgradeable\b/.test(w.detail));
  return { inspection, gate, namesUpgrade, digest: disclosureDigest(inspection), codes: warns.map((w) => w.code), blocks: inspection.verdict.blocks.map((b) => b.code) };
}

const liveAdmin = await analyze(SUBJ, { client: mockClient(proxyChain({ adminSlot: word(ADMIN) })) });
const unreadAdmin = await analyze(SUBJ, { client: mockClient(proxyChain({ adminSlot: transientThrow })) });

console.log("\n── the fixture is the shape under test ──");
check("the report reads a live admin on an EIP-1967 proxy", liveAdmin.shape.family === "eip1967" && liveAdmin.shape.evidence?.admin === ADMIN,
  `${liveAdmin.shape.class}, admin ${liveAdmin.shape.evidence?.admin}`);
check("owner() is renounced", liveAdmin.owner?.kind === "renounced", String(liveAdmin.owner?.kind));
check("the report is an answer, not a refusal", liveAdmin.refusal === null, liveAdmin.refusal?.reason ?? "");
check("the unreadable-admin report is an EIP-1967 proxy with the admin slot unreadable",
  unreadAdmin.shape.family === "eip1967" && unreadAdmin.shape.evidence?.adminSlot === "unreadable" && unreadAdmin.refusal === null,
  `${unreadAdmin.shape.class}, adminSlot ${unreadAdmin.shape.evidence?.adminSlot}`);

console.log("\n── (a) TODAY: the deposit path scans the proxy's own stub ──");
{
  const r = await gateFor({ deposit: { codeAtProxy: STUB_CODE, implSlot: word(IMPL) }, report: liveAdmin });
  check("the gate BLOCKs", r.gate.ok === false && r.inspection.verdict.level === "BLOCK", r.blocks.join(","));
  check("…as not-erc4626 (conformance scanned the stub)", r.blocks.includes("not-erc4626"), r.blocks.join(","));
}

console.log("\n── (b) FUTURE: conformance follows the implementation; admin live, owner renounced ──");
{
  const r = await gateFor({ deposit: { codeAtProxy: IMPL_CODE, implSlot: word(IMPL) }, report: liveAdmin });
  check("the disclosure is not OK", r.inspection.verdict.level !== "OK", r.inspection.verdict.level);
  check("⭐ the gate approves only a disclosure that names the upgrade power", !r.gate.ok || r.namesUpgrade,
    `gate ${r.gate.ok ? "APPROVED" : "refused"}; warns: ${r.codes.join(",") || "(none)"}`);
}

console.log("\n── (b′) FUTURE, admin slot unreadable ──");
{
  const r = await gateFor({ deposit: { codeAtProxy: IMPL_CODE, implSlot: word(IMPL) }, report: unreadAdmin });
  check("⭐ the gate approves only a disclosure that names the upgrade power (or says it is unknown)", !r.gate.ok || r.namesUpgrade,
    `gate ${r.gate.ok ? "APPROVED" : "refused"}; warns: ${r.codes.join(",") || "(none)"}`);
}

console.log("\n── CONTROL: the harness can approve — a plain (non-proxy) recognised vault ──");
{
  const report = await analyze(SUBJ, { client: mockClient({
    [`code@${SUBJ}`]: IMPL_CODE, [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
    [`call@0x8da5cb5b`]: word(OWNER), [`code@${OWNER}`]: "0x",
  }) });
  const r = await gateFor({ deposit: { codeAtProxy: IMPL_CODE, implSlot: ZERO_WORD }, report });
  check("a WARN acked for exactly what was shown is APPROVED", r.gate.ok === true && r.inspection.verdict.level === "WARN",
    `${r.inspection.verdict.level}; ${r.blocks.join(",") || r.codes.join(",")}`);
  check("…and it names no upgrade power (there is none)", !r.namesUpgrade, r.codes.join(","));
  // ⭐ the disclosure a user acks for a NON-proxy vault did not move with 0.4.0: digest computed on the
  // pre-0.4.0 tree (8308729). If this moves, every outstanding ack for such a vault dies.
  check("its disclosure digest is unchanged from 0.3.0", r.digest === PLAIN_DIGEST_PRE_0_4, r.digest);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
