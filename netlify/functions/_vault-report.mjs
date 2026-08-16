// _vault-report.mjs — the vault path's TRANSPORT for the DD report.
//
// ⭐ TRANSPORT STAYS PER-CALLER, INTERPRETATION IS SHARED. `_vault.mjs` is pure over values the
// caller already fetched and must not gain a wire dependency; `applyReportDisclosure` takes the
// report as a parameter. This module is the one place the vault path opens that connection.
//
// ⭐⭐ THE SAME `analyze()` AND THE SAME QUORUM the paid endpoint and the in-app card use, so the
// deposit gate and the card cannot disclose different powers for the same vault at the same block.
//
// ⚠️ NO ATTESTATION HERE, DELIBERATELY. `makeProduceReport` also SIGNS, because a buyer needs a
// verifiable artifact. The gate is not selling anything and never shows this report to anyone — it
// consumes the FACTS. Signing on every deposit would spend the service key on the money path for a
// signature nobody reads. ⚠️ The facts come from the identical code path either way; it is only the
// envelope that differs.
//
// ⚠️ NEVER THROWS. A failure resolves to `null`, and `applyReportDisclosure(insp, null)` BLOCKS —
// which is the correct outcome and keeps the decision in one place instead of splitting it between
// a catch here and the gate there.
import { healthDisclosure } from "./_dd-rungs.mjs";
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { quorumClient } from "../../shared/onchain-analyze/quorum.mjs";
import { ARC_QUORUM_ENDPOINTS } from "../../shared/onchain-analyze/endpoints.mjs";
import { chainClient } from "../../shared/dd/client.mjs";

// ═══ 🚨🚨 THE HEALTH GATE APPLIES HERE TOO — FOUND WHILE BUILDING STEP 2 ═════════════════════
// The first version of this module called `analyze()` directly and skipped the health check, and
// that was a real defect on the money path: `/api/dd-analyze` REFUSES when the detector is not known
// good, and so does the in-app card — but the DEPOSIT GATE would have consumed the same detector's
// output regardless. A detector that fails its own known-shape fixtures would be too broken to sell
// a report and too broken to show a card, yet still trusted to say whether a vault's owner can drain
// it. ⭐ The stakes run the other way: a buyer loses the price of a report, a depositor loses the
// deposit.
//
// ⚠️ AN UNKNOWN HEALTH STATE REFUSES TOO. `serving === null` means we could not tell, and "could not
// tell" is not "fine" — the same tri-state discipline the rest of this subsystem runs on.
export async function vaultDdReport(address, { event = null } = {}) {
  try {
    const health = await healthDisclosure(event ?? { headers: {} });
    if (health.serving !== true) {
      console.error(`[vault-report] refusing: detector not known good (${health.reason ?? "unknown"})`);
      return null;
    }
    return await analyze(address, {
      client: quorumClient(ARC_QUORUM_ENDPOINTS.map((rpc) => chainClient("arc-testnet", { rpc }))),
    });
  } catch (e) {
    console.error("[vault-report] analyze failed:", e?.message ?? e);
    return null;
  }
}
