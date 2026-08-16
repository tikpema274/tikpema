// verify-vault.mjs — ZERO-MONEY proof of the Vault agent, rows 1–4.
//
// This proves the READ + GATE + CAP shape against the REAL XyloVault on Arc testnet, without
// moving a cent. The live fund-moving rows (5 deposit, 6 withdraw, 7 pause) are run BY HAND, one
// at a time, after these are green — they are NOT in this file.
//
//   1. INSPECTION MATCHES CHAIN — inspectVault(XyloVault) reports exactly what is on-chain.
//   2. BLOCK FIRES — a non-ERC-4626 contract and a non-allowlisted vault are both refused.
//   3. WARN + ACK FIRES against XyloVault's REAL owner powers (emergency-withdraw, settable fees,
//      EOA owner). A missing / malformed / mismatched ack refuses; the correct ack passes. And if
//      XyloVault ever STOPPED tripping the WARN, this fails — that would be a bug.
//   4. CAP FAIL-CLOSED — a garbled env throws; an over-cap deposit is blocked before any signing.
//
//   node --experimental-test-module-mocks scripts/verify-vault.mjs
import { mock } from "node:test";

const XYLO = "0x240Eb85458CD41361bd8C3773253a1D78054f747"; // XyloVault (allowlisted)
const USDC = "0x3600000000000000000000000000000000000000"; // a real contract, NOT a vault
const NOCODE = "0x1111111111111111111111111111111111111111"; // no contract code on Arc testnet
const WALLET = "0xbafec950627579cf786acf875e6e216995e995a3"; // a test agent SCA (read-only here)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // space the RPC-heavy e2e inspections

// Isolate the thing under test. Pause → running (its own proof is verify-pause-enforcement).
// Budget → allowed (its own proof is _budget-test). _circle → a FAKE client so the deposit
// happy-path never submits a transaction: `signed` flips only if execution reaches the signing
// call, which lets us assert "nothing signed" on every refusal path. inspectVault/gateDeposit use
// the REAL public RPC (read-only) — untouched by these mocks.
let signed = false;
mock.module("../netlify/functions/_pause.mjs", { namedExports: { assertNotPaused: async () => null } });
mock.module("../netlify/functions/_budget.mjs", {
  namedExports: { canSpendDay: async () => ({ allowed: true }), recordAgentSpend: async () => {} },
});
mock.module("../netlify/functions/_circle.mjs", {
  namedExports: {
    circle: () => ({
      createContractExecutionTransaction: async () => {
        signed = true; // reached the signing boundary — with the FAKE client, nothing is submitted
        return { data: { id: "fake-tx-id" } };
      },
      getTransaction: async () => ({ data: { transaction: { state: "COMPLETE", txHash: "0xFAKE" } } }),
    }),
    waitForTx: async () => "0xFAKE_NOT_A_REAL_TX",
    TxPendingError: class TxPendingError extends Error {},
  },
});

// ⭐⭐ HEALTH IS MOCKED TO "SERVING", and that is not a shortcut — it is the ONLY way to test the
// step-2 path in-process. `_vault-report.mjs` now refuses to analyse unless the DD detector is known
// good, and health lives in Netlify Blobs, which do not exist here. Without this mock every deposit
// below would BLOCK on `dd-report-missing` — the correct production behaviour, but it would test the
// health gate over and over instead of the disclosure it guards.
// ⚠️ THE HEALTH REFUSAL IS STILL PROVEN, just not here: verify-dd-report §G2 calls the REAL
// `vaultDdReport` with no mock, gets null, and asserts the deposit blocks. Both halves exist.
mock.module("../netlify/functions/_dd-rungs.mjs", {
  namedExports: { healthDisclosure: async () => ({ serving: true, reason: null, detail: null, selfClearing: null }) },
});

const { inspectVault, gateDeposit, applyReportDisclosure, ackTokenFor, resolveVault } = await import("../netlify/functions/_vault.mjs");
// ⭐ STEP 2: the owner powers and the holder now come from the DD report, so every gate call in
// this suite must go through `applyReportDisclosure` first — exactly as the real call sites do.
// A raw inspection is REFUSED by construction, and §0 below proves that rather than assuming it.
const { vaultDdReport } = await import("../netlify/functions/_vault-report.mjs");
const established = async (i, addr) => applyReportDisclosure(i, await vaultDdReport(addr));
const { executeAction, validateStepShape } = await import("../netlify/functions/_actions.mjs");
const { vaultDepositCapUsdc } = await import("../netlify/functions/_arc.mjs");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ── ROW 1 — INSPECTION MATCHES CHAIN ─────────────────────────────────────────────────────────
console.log("\n── ROW 1 · inspection matches chain (real read of XyloVault) ──");
const inspRaw = await inspectVault(XYLO);
const insp = await established(inspRaw, XYLO);
check("is a deployed contract", insp.conformance.isContract === true);
check("ERC-4626 conformant (all 12 methods present)", insp.conformance.erc4626 === true, `missing: [${insp.conformance.missingMethods.join(", ")}]`);
check("underlying asset is USDC", insp.asset.isUsdc === true, insp.asset.address ?? "null");
check("funded, not a shell", insp.funded.isShell === false && Number(insp.funded.totalAssetsUsdc) > 0, `totalAssets ≈ ${Number(insp.funded.totalAssetsUsdc).toLocaleString()} USDC`);
check("withdraw fee = 0.10% (10 bps)", insp.withdraw.withdrawFeeBps === 10, insp.withdraw.withdrawFeePct);
// Was: check("no lock / delay / cooldown", !insp.withdraw.lock && ...) — a VACUOUS assertion. Those
// fields were hardcoded `false`, so it asserted three literals and could never fail. Worse, `!x`
// treats UNKNOWN as ABSENT, which is the defect itself. The inspector performs no lock/delay check,
// so the only honest assertion is that it REPORTS the gap. Flip this to a real check the day the
// scan is written. (VAULT_INSPECT_DEFECTS.md, defect C)
check("lock / delay / cooldown reported as UNKNOWN, not absent",
  insp.withdraw.lock === null && insp.withdraw.delay === null && insp.withdraw.cooldown === null);
check("owner emergency-withdraw present", insp.ownerPowers.emergencyWithdraw.present === true, insp.ownerPowers.emergencyWithdraw.via.join(", "));
check("fees settable, max 20% (2000 bps)", insp.ownerPowers.settableFees.present === true && insp.ownerPowers.settableFees.maxBps === 2000, insp.ownerPowers.settableFees.maxPct ?? "");
// ⚠️ `=== "eoa"` and `=== false` are STRICT ON PURPOSE. Both fields are now tri-state: ownerIdentity
// can be "unreadable"/"unreadable-kind"/"no-owner-fn", and upgradeable.present can be null (UNKNOWN,
// proxy slot not read). A truthiness test (`!insp.ownerPowers.upgradeable.present`) would pass on
// UNKNOWN and re-create defect B inside its own regression test. Identity comparison, always.
check("owner identity is an EOA (strict — not 'unreadable')", insp.ownerPowers.ownerIdentity === "eoa", insp.ownerPowers.owner ?? "");
check("not upgradeable — proxy slot READ and empty (strict false, not null)", insp.ownerPowers.upgradeable.present === false);
check("proxy slot was actually read (defect B guard)", insp.ownerPowers.upgradeable.proxySlotUnreadable === false);
// Defect A guard: `renounced` must be unreachable from anything but a confirmed zero-address read.
// XyloVault has a real EOA owner, so any renounced/unknown class here means a read silently failed.
check("owner NOT reported as renounced or unknown", !["renounced", "unreadable", "unreadable-kind", "no-owner-fn"].includes(insp.ownerPowers.ownerIdentity), insp.ownerPowers.ownerIdentity);
check("no fail-open verdict codes on a healthy read", !insp.verdict.warns.some((w) => ["owner-unreadable", "owner-not-exposed"].includes(w.code)) && !insp.verdict.blocks.some((b) => b.code === "proxy-status-unreadable"));
check("verdict level = WARN", insp.verdict.level === "WARN", `blocks:${insp.verdict.blocks.length} warns:${insp.verdict.warns.length}`);

// ── ⭐⭐ ROW 1b — THE MIGRATION'S FAIL-CLOSED CATCH ──────────────────────────────────────────
// 🚨 THE ONE CHECK THAT MAKES DELETING THE SEVEN WARNS SAFE. Since step 2 the powers and the holder
// come from the DD report; an inspection that never went through `applyReportDisclosure` carries
// NONE of them and its `warns` look reassuringly short. If the gate accepted it, a deposit would
// proceed against a disclosure that silently omits every power the owner holds — which is the exact
// silent-consent-removal the retain-and-mark ordering was built to avoid, arriving by another door.
console.log("\n── ROW 1b · a raw inspection can never be gated on ──");
{
  const g = gateDeposit({ inspection: inspRaw, ackToken: ackTokenFor(insp), expectedAssetAddress: USDC });
  check("🚨🚨 a RAW inspection is REFUSED even with a valid-looking ack", g.ok === false, g.blocked);
  check("🚨 …and says the disclosure was never established",
    g.disclosure?.blocks?.some((b) => b.code === "disclosure-not-established"), JSON.stringify(g.disclosure?.blocks?.[0]?.code));
  check("⭐ the established inspection carries its provenance",
    insp.disclosure?.source === "report" && insp.disclosure?.established === true);
  // ⚠️ ABSENCE, WRONG SUBJECT AND A REFUSAL ALL BLOCK — tested by calling, because each is a way the
  // second subsystem can fail to establish something, and none may resolve to "no powers found".
  const noRpt = applyReportDisclosure(inspRaw, null);
  check("🚨 a MISSING report BLOCKs (an absent report is not an absence of powers)",
    noRpt.verdict.level === "BLOCK" && noRpt.verdict.blocks.some((b) => b.code === "dd-report-missing"));
  const wrongSubj = applyReportDisclosure(inspRaw, { subject: { address: "0x" + "9".repeat(40), chainId: 5042002 }, powersPresent: [], coverage: { notChecked: [] }, owner: { kind: "multisig" } });
  check("🚨🚨 a report about ANOTHER contract BLOCKs — never another contract's powers under this name",
    wrongSubj.verdict.level === "BLOCK" && wrongSubj.verdict.blocks.some((b) => b.code === "dd-report-subject-mismatch"));
  const refused = applyReportDisclosure(inspRaw, { subject: { address: XYLO.toLowerCase(), chainId: 5042002 }, refusal: { reason: "chain-unreachable" } });
  check("🚨 a REFUSAL report BLOCKs — it established nothing",
    refused.verdict.level === "BLOCK" && refused.verdict.blocks.some((b) => b.code === "dd-report-indeterminate"));
  const unchecked = applyReportDisclosure(inspRaw, { subject: { address: XYLO.toLowerCase(), chainId: 5042002 }, powersPresent: [], owner: { kind: "multisig" }, coverage: { notChecked: [{ group: "upgradeable" }] } });
  check("⭐⭐ an UNCHECKED power warns rather than reading as absent",
    unchecked.verdict.warns.some((w) => w.code === "owner-powers-unreadable"));
  const weirdOwner = applyReportDisclosure(inspRaw, { subject: { address: XYLO.toLowerCase(), chainId: 5042002 }, powersPresent: [], owner: { kind: "brand-new-kind" }, coverage: { notChecked: [] } });
  check("⭐ an UNRECOGNISED owner kind is treated as unknown, not as benign",
    weirdOwner.verdict.warns.some((w) => w.code === "owner-unreadable"));
}

// ── ROW 2 — BLOCK FIRES ──────────────────────────────────────────────────────────────────────
console.log("\n── ROW 2 · BLOCK fires (non-ERC-4626 + non-allowlisted) ──");
const inspUsdcRaw = await inspectVault(USDC);
const inspUsdc = await established(inspUsdcRaw, USDC);
check("USDC token (not a vault) → not-erc4626 BLOCK", inspUsdc.verdict.level === "BLOCK" && inspUsdc.verdict.blocks.some((b) => b.code === "not-erc4626"));
const gUsdc = gateDeposit({ inspection: inspUsdc, ackToken: ackTokenFor(inspUsdc), expectedAssetAddress: USDC });
check("gate refuses the non-vault even WITH an ack", gUsdc.ok === false && /failed inspection/.test(gUsdc.blocked || ""), gUsdc.blocked);
const inspNoCode = await inspectVault(NOCODE);
check("plain address (no code) → not-a-contract BLOCK", inspNoCode.verdict.level === "BLOCK" && inspNoCode.verdict.blocks.some((b) => b.code === "not-a-contract"));
check("resolveVault('nope') = null (non-allowlisted)", resolveVault("nope") === null);
check("validateStepShape rejects a non-allowlisted vault", validateStepShape({ type: "vault_deposit", vault: "nope", amountUsdc: 1 }) === `unsupported vault "nope" (not on the allowlist)`);
{
  signed = false;
  const r = await executeAction({ type: "vault_deposit", vault: "nope", amountUsdc: 1 }, { walletAddress: WALLET });
  check("executeAction refuses a non-allowlisted vault", r.ok === false && /not on the allowlist/.test(r.blocked || ""), r.blocked);
  check("  └ nothing signed", signed === false);
}

// ── ROW 3 — WARN + ACK FIRES against XyloVault's real powers ─────────────────────────────────
console.log("\n── ROW 3 · WARN + ack fires against XyloVault ──");
const warnCodes = insp.verdict.warns.map((w) => w.code);
check("WARN cites emergency-withdraw", warnCodes.includes("emergency-withdraw"));
check("WARN cites settable fees", warnCodes.includes("fees-settable"));
check("WARN cites the EOA owner", warnCodes.includes("owner-is-eoa"));
const goodAck = ackTokenFor(insp);
check("no ack → REFUSED", gateDeposit({ inspection: insp, ackToken: undefined, expectedAssetAddress: USDC }).ok === false);
check("malformed ack → REFUSED", gateDeposit({ inspection: insp, ackToken: "not-a-token", expectedAssetAddress: USDC }).ok === false);
check("wrong (mismatched) ack → REFUSED", gateDeposit({ inspection: insp, ackToken: "0".repeat(64), expectedAssetAddress: USDC }).ok === false);
check("correct disclosure-bound ack → PASSES", gateDeposit({ inspection: insp, ackToken: goodAck, expectedAssetAddress: USDC }).ok === true);
{
  // End-to-end through executeAction (real inspection + gate; fake signer). Each executeAction
  // re-inspects on-chain, so space these out to keep the public RPC from throttling a read to null.
  await sleep(600);
  signed = false;
  const noAck = await executeAction({ type: "vault_deposit", vault: "xylo-usdc", amountUsdc: 5 }, { walletAddress: WALLET });
  check("deposit WITHOUT ack → blocked, nothing signed", noAck.ok === false && /acknowledg/i.test(noAck.blocked || "") && signed === false, noAck.blocked);
}
{
  await sleep(600);
  signed = false;
  const withAck = await executeAction({ type: "vault_deposit", vault: "xylo-usdc", amountUsdc: 5, ackToken: goodAck }, { walletAddress: WALLET });
  check("deposit WITH correct ack → passes the gate (reaches signer)", withAck.ok === true && signed === true, withAck.ok ? "ok" : withAck.blocked);
}

// ── ROW 4 — CAP FAIL-CLOSED ──────────────────────────────────────────────────────────────────
console.log("\n── ROW 4 · cap fail-closed (garbled env + over-cap) ──");
{
  const saved = process.env.AGENT_VAULT_DEPOSIT_CAP_USDC;
  process.env.AGENT_VAULT_DEPOSIT_CAP_USDC = "1O0"; // letter O — a classic typo
  try {
    vaultDepositCapUsdc();
    check("garbled cap → throws (fail-closed)", false, "it did NOT throw — the cap is fail-OPEN");
  } catch (e) {
    check("garbled cap → REFUSES (fail-closed)", /misconfigured/i.test(e.message), e.message.slice(0, 52));
  }
  // Restore precisely: assigning `undefined` would set the STRING "undefined" (which then parses
  // to NaN and throws) — an unset var must be DELETED, not reassigned.
  if (saved === undefined) delete process.env.AGENT_VAULT_DEPOSIT_CAP_USDC;
  else process.env.AGENT_VAULT_DEPOSIT_CAP_USDC = saved;
}
const CAP = vaultDepositCapUsdc();
check(`cap reads a finite number (${CAP} USDC)`, Number.isFinite(CAP) && CAP > 0);
{
  signed = false;
  const over = await executeAction({ type: "vault_deposit", vault: "xylo-usdc", amountUsdc: CAP + 0.01, ackToken: goodAck }, { walletAddress: WALLET });
  check("OVER cap → blocked", over.ok === false && /per-vault-deposit limit/.test(over.blocked || ""), over.blocked);
  check("  └ nothing signed on the over-cap deposit", signed === false);
}
{
  // `>` is inclusive: an AT-cap deposit passes the cap gate (then the WARN gate, with a valid ack).
  await sleep(600);
  signed = false;
  const at = await executeAction({ type: "vault_deposit", vault: "xylo-usdc", amountUsdc: CAP, ackToken: goodAck }, { walletAddress: WALLET });
  check("AT cap → passes the cap gate (bound is inclusive)", !/per-vault-deposit limit/.test(at.blocked || ""), at.ok ? "reached signer" : at.blocked);
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, nothing signed on-chain.`);
process.exit(fail === 0 ? 0 : 1);
