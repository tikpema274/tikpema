// _vault-disclosure.mjs — ONE ANSWER TO "MAY THIS DEPOSIT PROCEED, AND WHAT MUST BE ACCEPTED".
//
// ═══ ⭐⭐ WHY THIS IS A MODULE ═════════════════════════════════════════════════════════════════
// Three steps have to happen in this exact order before a deposit disclosure means anything:
//   1. inspect the vault on-chain, scoped to the HOLDER (maxRedeem is per-holder),
//   2. establish the disclosure from the DD report — `applyReportDisclosure`, without which the
//      owner powers are absent and the warn list looks reassuringly short,
//   3. dry-run `gateDeposit` with NO ack, to learn whether one is required and which token.
//
// That sequence lived inline in agent-vault-inspect, and when the agent gained the ability to
// propose a deposit it needed the identical answer. ⛔ Re-typing three ordered steps at a second
// call site is how the second site ends up skipping step 2 — and gateDeposit's own comment says a
// deposit gated on a raw inspection "sails through on a disclosure that silently omits every power
// the owner holds". The order is the safety property, so the order gets a name.
// [[duplicate-source-of-truth-is-the-recurring-bug]] · [[guard-belongs-on-the-caller-set]]
//
// ⛔ IT DECIDES NOTHING AND SIGNS NOTHING. This is the READ that lets a surface disclose. The
// authoritative gate runs again inside executeAction at execution time, on a FRESH inspection,
// because a disclosure fetched while the user was reading is not evidence about the vault now.

import { inspectVault, gateDeposit, applyReportDisclosure, ackTokenFor } from "./_vault.mjs";
import { vaultDdReport } from "./_vault-report.mjs";

/**
 * The deposit disclosure for one allowlisted vault, from the holder's point of view.
 *
 * @param {object}  args
 * @param {object}  args.vault  a VAULT_ALLOWLIST entry (never a free-form address)
 * @param {?string} args.owner  the holder, for the per-holder redemption block; null is allowed
 *                              and yields the `unknown` redemption state WITH its reason
 * @param {object}  [args.event] passed through to vaultDdReport for its Blobs wiring
 * @returns {Promise<object>} { vault, inspection, gate, depositable, ackRequired, ackToken }
 * @throws if the vault cannot be inspected — the caller decides the status code
 */
export async function depositDisclosure({ vault: v, owner = null, event = undefined }) {
  let inspection = await inspectVault(v.address, { owner });
  // ⭐ STEP 2 IS NOT OPTIONAL. See the module header: skipping it is a deposit approved against a
  // disclosure missing every owner power. gateDeposit refuses an inspection that never went
  // through here, so the omission fails closed rather than passing quietly — but it fails closed
  // at the GATE, which is far from whoever forgot it. Doing it here means nobody can forget.
  inspection = applyReportDisclosure(inspection, await vaultDdReport(v.address, { event }));

  // Dry-run the gate with NO ack, so the caller learns whether an ack is required and, if so,
  // exactly which token to send back. Never signs anything.
  const gate = gateDeposit({ inspection, ackToken: undefined, expectedAssetAddress: v.assetAddress });

  // ⚠️ THESE TWO CONDITIONS ARE DELIBERATELY DIFFERENT, AND THE DIFFERENCE IS LOAD-BEARING.
  // `ackRequired` additionally demands an empty block list, because gateDeposit can ADD a block
  // the inspection did not carry (an asset mismatch is only knowable in the deposit context). A
  // vault that is WARN on its own terms but BLOCKed by that check must not be presented as
  // "tick to proceed" — no acknowledgement overrides a BLOCK.
  // `ackToken` is minted whenever the vault's own verdict is WARN, so a caller can still SHOW the
  // token's disclosure in a blocked state without implying it is spendable.
  const ackRequired = inspection.verdict.level === "WARN" && !gate.disclosure.blocks.length;

  return {
    vault: { key: v.key, address: v.address, label: v.label, asset: v.asset, shareSymbol: v.shareSymbol },
    inspection,
    gate: { level: gate.disclosure.level, blocks: gate.disclosure.blocks, warns: gate.disclosure.warns },
    // If the level is BLOCK, deposits are refused outright — no ack can unblock them.
    depositable: gate.disclosure.level !== "BLOCK",
    ackRequired,
    // The token the deposit endpoint expects when ackRequired. Deterministic, not secret.
    ackToken: inspection.verdict.level === "WARN" ? ackTokenFor(inspection) : null,
  };
}
