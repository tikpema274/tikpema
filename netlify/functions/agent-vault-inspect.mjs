// POST /api/agent-vault-inspect { vault }  (auth required) — READ-ONLY, moves nothing.
//
// The read half of the Vault agent. Given an allowlisted vault KEY, read the vault on-chain and
// return the DISCLOSURE the user needs before depositing — conformance, underlying asset,
// funded-vs-shell, withdraw mechanics, and OWNER POWERS — plus the exact ackToken the deposit
// endpoint will require if the vault raises a WARN. The ackToken is deterministic over the
// disclosure, so a UI that shows the warnings and has the user tick "I understand" simply echoes
// this token back on deposit; if the vault's terms change in between, the token no longer matches
// and the deposit refuses (fail-closed — see _vault.gateDeposit).
import { json, parseBody } from "./_arc.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { requireSession } from "./_auth.mjs";
import { resolveVault, inspectVault, gateDeposit, applyReportDisclosure, ackTokenFor, SUPPORTED_VAULT_KEYS } from "./_vault.mjs";
import { vaultDdReport } from "./_vault-report.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { vault } = parseBody(event);
  const v = resolveVault(vault);
  if (!v) {
    return json(400, { error: `unsupported vault "${vault}" (not on the allowlist)`, supported: SUPPORTED_VAULT_KEYS });
  }

  let inspection;
  try {
    inspection = await inspectVault(v.address);
  } catch (e) {
    return json(502, { error: `cannot inspect vault ${v.label}: ${e.message}` });
  }

  // ⭐ ESTABLISH THE DISCLOSURE FROM THE DD REPORT before gating or minting an ack. The ack binds to
  // the disclosure the user SAW, so it must be computed over the same combined disclosure the
  // deposit gate will recompute at execute time — otherwise every ack would mismatch by design.
  inspection = applyReportDisclosure(inspection, await vaultDdReport(v.address, { event }));

  // Dry-run the gate with NO ack, so the UI learns whether an ack is required and, if so, exactly
  // which token to send back. Never signs anything.
  const gate = gateDeposit({ inspection, ackToken: undefined, expectedAssetAddress: v.assetAddress });
  const ackRequired = inspection.verdict.level === "WARN" && !gate.disclosure.blocks.length;

  return json(200, {
    vault: { key: v.key, address: v.address, label: v.label, asset: v.asset, shareSymbol: v.shareSymbol },
    inspection,
    gate: { level: gate.disclosure.level, blocks: gate.disclosure.blocks, warns: gate.disclosure.warns },
    // If the level is BLOCK, deposits are refused outright — no ack can unblock them.
    depositable: gate.disclosure.level !== "BLOCK",
    ackRequired,
    // The token the deposit endpoint expects when ackRequired. Deterministic, not secret.
    ackToken: inspection.verdict.level === "WARN" ? ackTokenFor(inspection) : null,
  });
}
