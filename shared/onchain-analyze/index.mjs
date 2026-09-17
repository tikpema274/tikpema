// shared/onchain-analyze — analyze(address) → an INVENTORY of what a contract's holder can do to you.
//
// ═══ WHAT THIS IS ═════════════════════════════════════════════════════════════════════════════
// DD Step 2, slice 1: the walking skeleton. Built ON TOP of shared/onchain-facts (the Step-1
// primitive with the UNREADABLE tri-state). Single RPC, Arc-only, EVM-only. No payment, no quorum,
// no signing, no canary — those are later hardening passes and are deliberately absent.
//
// ⚠️ IT TOUCHES NOTHING IN netlify/. This is a NEW CONSUMER of the shared primitive, built alongside
// the vault inspector, deployed nowhere. `_vault.mjs` and the deposit path are not modified, not
// imported, and not reachable from here.
//
// ═══ TRANSPORT IS INJECTED ════════════════════════════════════════════════════════════════════
// This module never touches the wire. It takes a `client` satisfying the tiny interface that
// scripts/dd/client.mjs already provides — { chain, assert(), pin(), call({method, params}) } — which
// keeps shared/ free of any dependency on scripts/ or netlify/, and carries forward Step 1's
// decision that TRANSPORT stays per-caller while INTERPRETATION is shared. It also means this module
// is service-consumable later without a rewrite.
//
// ═══ ⭐ A REFUSAL IS A REPORT, NOT AN EXCEPTION ═══════════════════════════════════════════════
// When the shape cannot be classified, analyze() returns a FIRST-CLASS REPORT: same schema,
// shape.class "unknown", empty powers, and a coverage manifest saying it classified nothing and
// therefore checked nothing. It does not throw and it does not return null.
//
// The reason is not ergonomics. An honest "I cannot assess this" is a VALID ANSWER THAT SETTLES — the
// reader learns something true and can act on it. A thrown error reads as "the service broke", which
// invites a retry, a fallback, or a shrug, and none of those are the finding. The only exceptions
// this module raises are for PROGRAMMER ERROR (a malformed address, a missing client) — things a
// caller must fix in code, never things the chain told us.

import { normalizeAddress } from "./normalize.mjs";
import { INTEGRITY_OUTCOMES } from "./endpoints.mjs";
import { makeCoverage } from "./coverage.mjs";
import { detectShape } from "./shape.mjs";
import { enumeratePowers, resolveOwner } from "./powers.mjs";
import { baseReport, assertReportValid } from "./schema.mjs";
import { hasSel, unread, POWER_SIGS } from "../onchain-facts/index.mjs";
// ⭐ The recognition gate — the SAME source the deposit path (_vault.mjs) uses. No new vocabulary here.
import { recognizeVaultProfile, ERC4626_METHODS } from "../onchain-facts/vault-profiles.mjs";

export { SCHEMA_VERSION, SEVERITY_MEANING, SCOPE_CLASSES, POWER_SCOPE } from "./schema.mjs";
// Attestation is OPT-IN and additive: analyze() neither signs nor requires a signer, so an
// unattested report is exactly what it was before. See docs/dd-attestation-canon1.md.
export {
  CANON_VERSION, DOMAIN, VALIDITY_MEANING,
  canonicalize, signingMessage, attestationDigest,
  attachAttestation, verifyAttestation, unsignedAttestation,
} from "./attest.mjs";

/**
 * Analyze one address.
 *
 * @param {string} address           0x-prefixed 20-byte address
 * @param {{client: object}} opts    client: { chain, assert(), pin(), call({method,params}) }
 * @returns {Promise<object>}        a report — ALWAYS a report, including on refusal
 * @throws  only on programmer error (bad address, missing client)
 */
export async function analyze(address, { client } = {}) {
  if (!client) throw new Error("analyze(): a transport client is required — this module does not open its own connection");
  const addr = normalizeAddress(address);
  if (!addr) throw new Error(`analyze(): not a 20-byte hex address: ${JSON.stringify(address)}`);

  const cov = makeCoverage();

  // The chain guard and the block pin are PRE-CONDITIONS, not checks: without them we do not know
  // which chain we are describing or at what state, so there is nothing to record coverage about.
  // A failure here is a genuine inability to start, and it returns a refusal report like any other.
  let chainId, blk;
  try {
    chainId = await client.assert();
    blk = await client.pin();
  } catch (e) {
    const rpt = baseReport({ address: addr, chainId: null, chainName: client.chain?.name ?? null, blockNumber: null });
    return {
      ...rpt,
      shape: { class: "unknown", family: "unknown", variant: null, evidence: { why: "could not establish the chain guard or pin a block" } },
      refusal: { reason: "chain-unreachable", detail: String(e?.message ?? e) },
    };
  }

  const shape = await detectShape(cov, client, addr, blk);
  const owner = await resolveOwner(cov, client, addr, blk, shape);

  // ⭐⭐ RECOGNITION GATE — the SAME source the deposit path uses (recognizeVaultProfile). Only VAULTS
  // (ERC-4626 conformant) are gated: analyze() serves ARBITRARY contracts, where "no vault powers" is
  // a legitimate finding, never a refusal. An ERC-4626 vault whose control vocabulary this engine does
  // NOT recognise gets a NO-VERDICT refusal below — scanning for the vocabularies we DO model would
  // report a false clean bill. This MUST match the deposit gate (_vault.mjs); verify-recognition-
  // agreement pins that the two paths never diverge. Scanned in the SAME effectiveCode the powers use.
  const effCode = shape.effectiveCode;
  const codeScannable = typeof effCode === "string" && !unread(effCode) && effCode !== "0x" && effCode.length > 2;
  // ⭐ VAULT-SHAPED, not "fully conformant" — a fail-CLOSED bar. A real vault whose bytecode is
  // missing a required selector (reached via fallback, a quirky impl, or a partial read) is STILL a
  // vault; treating "11 of 12" as a non-vault and running the full scan reports a false clean bill (a
  // failed probe reading as safe). So ANY ERC-4626 signal makes the surface vault-shaped and subject
  // to the gate. Only a contract with NONE of the ERC-4626 methods is a confident non-vault that
  // analyze() scans normally (it serves arbitrary contracts, most of which are not vaults). When the
  // code itself is UNREADABLE, shape.class is already "unknown" → the shape-unclassified refusal
  // below fires first, so a failed probe never reaches a clean scan.
  const erc4626Hits = codeScannable ? ERC4626_METHODS.filter((s) => hasSel(effCode, s)).length : 0;
  const vaultShaped = erc4626Hits > 0;
  const unrecognisedVaultSurface = vaultShaped && recognizeVaultProfile((s) => hasSel(effCode, s)) === null;

  let powers;
  if (unrecognisedVaultSurface) {
    // ⛔ Do NOT scan for our selectors on an unrecognised surface — that IS the false clean bill.
    // Every power group lands in notChecked WITH THE REASON; the report refuses below.
    for (const group of Object.keys(POWER_SIGS)) {
      cov.skip(`power:${group}`, { kind: "power", group }, "power-surface-unrecognised — this ERC-4626 vault's control vocabulary is not one this engine models, so scanning for our selectors would report a false clean bill");
    }
    powers = [];
  } else {
    powers = await enumeratePowers(cov, shape, owner);
  }

  const manifest = cov.manifest();
  const report = {
    ...baseReport({ address: addr, chainId, chainName: client.chain?.name ?? null, blockNumber: blk.number }),
    shape: {
      class: shape.class,
      family: shape.family,
      variant: shape.variant,
      scannedAddress: shape.effectiveCodeAddress ?? null,
      evidence: shape.evidence,
    },
    owner: { address: owner.address, kind: owner.type },
    powers,
    powersPresent: powers.filter((p) => p.present).map((p) => p.power),
    // ⚠️ A quorum that cannot attest its own independence but implies it is itself a false clean
    // bill. So the endpoint set rides on every report, and `independenceVerified` is FALSE unless
    // something out of band proved it — agreement between endpoints is NOT that proof.
    sources: client.endpoints
      ? { mode: "quorum", endpoints: client.endpoints, ...client.quorum,
          // ⭐⭐ THE SPLIT IS DISCLOSED AT REPORT LEVEL, NOT ONLY ON THE SLOT THAT SPLIT.
          //
          // A buyer paying for a claim about a subject deserves to know the providers underneath
          // DISAGREED — and it bears on the reliability of EVERYTHING ELSE in the same report, not
          // just the one check. If two endpoints served different values for one slot at one pinned
          // block, then every OTHER slot they agreed on was read from a set containing a source now
          // known to be wrong about something. Agreement from a compromised set is not corroboration.
          //
          // ⚠️ SO IT MUST NOT READ AS AN ORDINARY `unreadable`. Unreadable says our instrument
          // failed and implies nothing about the data. A split says at least one provider served
          // something FALSE — a positive finding, and the only one that proves a single-endpoint
          // build of this service would have signed and sold it.
          integrity: (() => {
            const split = manifest.notChecked.filter((n) => INTEGRITY_OUTCOMES.includes(n.reason));
            return split.length === 0
              ? { providerDisagreement: false, splits: [],
                  note: "No endpoint disagreed on any slot that was read. This is not a claim that the endpoints are independent — see independenceVerified." }
              : { providerDisagreement: true,
                  splits: split.map((n) => ({ id: n.id, group: n.group ?? null, reason: n.reason })),
                  note: "⚠️ ENDPOINTS DISAGREED. Two sources returned different values for the same call at the same block, so at least one is serving something false. This bears on EVERY check in this report, not only the ones listed: the slots that agreed were read from the same set. Treat corroboration here as unproven until the endpoint set is re-verified out of band." };
          })(),
          note: "Quorum covers PROVIDER integrity (proxy bug, stale/pruned cache, hijacked endpoint, lying aggregator). It does NOT cover consensus integrity: every Arc provider syncs from the same permissioned validator set. Endpoint agreement is not evidence of endpoint independence." }
      : { mode: "single-rpc", endpoints: [client.chain?.rpc ?? "unknown"],
          integrity: { providerDisagreement: null, splits: [],
            note: "⚠️ UNKNOWABLE on a single endpoint: with nothing to compare against, a provider serving something false is indistinguishable from one serving the truth. `null` is not `false`." },
          note: "Single endpoint. No cross-check: a wrong answer from this provider is reported as fact." },
    coverage: {
      ...manifest,
      summary:
        shape.class === "unknown"
          ? "could not classify this address's shape → nothing was scanned. This is an INDETERMINATE result, not a clean bill."
          : unrecognisedVaultSurface
            ? "this address presents an ERC-4626 vault surface this engine does not recognise → its owner powers were NOT scanned. This is a NO-VERDICT result, not a clean bill."
            : `${manifest.totals.checked} checks ran, ${manifest.totals.notChecked} did not. Everything not checked is listed with a reason.`,
    },
    reads: cov.reads(),
    refusal:
      shape.class === "unknown"
        ? { reason: "shape-unclassified", detail: shape.evidence?.why ?? "the shape-determining reads did not complete" }
        : unrecognisedVaultSurface
          ? { reason: "power-surface-unrecognised", detail: "This address presents an ERC-4626 vault surface (fully or partially), but its admin/control surface is not a vocabulary this engine recognises. Scanning for the vocabularies it does model would report a false clean bill, so NO VERDICT is given — this is NOT a clean result. The deposit gate refuses the same input." }
          : null,
  };

  // ⭐ The completeness invariant. Returns a refusal report if any catalogue group went unaccounted
  // for — a report you cannot trust not to be a false clean bill is not a report worth returning.
  return assertReportValid(report);
}
