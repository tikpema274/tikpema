// identity.mjs — the DD service's production identity, as DATA. Pure: no imports, no I/O, no credentials.
//
// Moved out of attest-circle.mjs (which imports Circle credential plumbing) so the VERIFIER can pin
// against it without importing a signer. attest.mjs reads the pinned fields from here; attest-circle.mjs
// re-exports DD_IDENTITY for the signing side. One copy.
//
// ═══ WHAT THE VERIFIER PINS, AND WHAT IT DERIVES ═══════════════════════════════════════════════
// canon/1 excludes the whole `attestation` object from the signed bytes, so every identity field a
// report carries is an UNSIGNED CLAIM. A verifier that uses those claims as inputs asks a forger's own
// contracts whether the forger is honest (measured live, 2026-09-25). So:
//   PINNED  — agentId, registry, chainId, domain: a report whose attestation differs is refused.
//   DERIVED — the verifying contract: read as ownerOf(agentId) on the PINNED registry at verify time.
//             Never pinned here, so rotating the identity's owner account keeps verifying new reports.
// `verifyingContract` below is what the SIGNER writes into new reports; the verifier never trusts it.

/** Domain-separated prefixes. A signature under one domain is MATHEMATICALLY invalid under the other.
 *  attest.mjs re-exports this as DOMAIN. */
export const DD_DOMAIN = Object.freeze({
  prod: "tikpema-dd-attestation/canon1/prod",
  dev: "tikpema-dd-attestation/canon1/dev",
});

/** What a verifier compares a report's attestation against. The verifying contract is deliberately absent. */
export const DD_PINNED_IDENTITY = Object.freeze({
  agentId: "851891",
  registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  chainId: "5042002", // where the identity is REGISTERED — a record, never derived from the app's chain config
  domain: DD_DOMAIN.prod,
});

/** The full production identity the SIGNER uses (attest-circle.mjs → attachAttestation). */
export const DD_IDENTITY = Object.freeze({
  ...DD_PINNED_IDENTITY,
  walletId: "2c93ca5d-be5c-5f51-883d-1a220647f7b1",
  verifyingContract: "0xc54d47211997aca90ef4fcfbc742a3b511b4e621", // ownerOf(851891) when written; the verifier re-derives it
  keyId: "circle-wallet:2c93ca5d-be5c-5f51-883d-1a220647f7b1",
  keyClass: "registered",
});
