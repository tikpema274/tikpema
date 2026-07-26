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
import { makeCoverage } from "./coverage.mjs";
import { detectShape } from "./shape.mjs";
import { enumeratePowers, resolveOwner } from "./powers.mjs";
import { baseReport, assertReportValid } from "./schema.mjs";

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
  const powers = await enumeratePowers(cov, shape, owner);

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
          note: "Quorum covers PROVIDER integrity (proxy bug, stale/pruned cache, hijacked endpoint, lying aggregator). It does NOT cover consensus integrity: every Arc provider syncs from the same permissioned validator set. Endpoint agreement is not evidence of endpoint independence." }
      : { mode: "single-rpc", endpoints: [client.chain?.rpc ?? "unknown"],
          note: "Single endpoint. No cross-check: a wrong answer from this provider is reported as fact." },
    coverage: {
      ...manifest,
      summary:
        shape.class === "unknown"
          ? "could not classify this address's shape → nothing was scanned. This is an INDETERMINATE result, not a clean bill."
          : `${manifest.totals.checked} checks ran, ${manifest.totals.notChecked} did not. Everything not checked is listed with a reason.`,
    },
    reads: cov.reads(),
    refusal:
      shape.class === "unknown"
        ? { reason: "shape-unclassified", detail: shape.evidence?.why ?? "the shape-determining reads did not complete" }
        : null,
  };

  // ⭐ The completeness invariant. Returns a refusal report if any catalogue group went unaccounted
  // for — a report you cannot trust not to be a false clean bill is not a report worth returning.
  return assertReportValid(report);
}
