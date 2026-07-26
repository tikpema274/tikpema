// attest-circle.mjs — the TRANSPORT half of report attestation: a signer backed by the Circle
// developer-controlled wallet that owns ERC-8004 agentId 851891.
//
// This lives in scripts/dd/ and not in shared/ on purpose. shared/onchain-analyze/attest.mjs holds
// the canonicalization and the verdict logic and never touches the wire or holds a key; the wire is
// per-caller. Same split as the rest of the engine (interpretation shared, transport injected).
//
// ⚠️ ON THE ONE IMPORT FROM netlify/. `_circle.mjs` is credential plumbing — it reads two env vars
// and constructs an SDK client. It is NOT the deposit path, produces no facts and no verdicts, and
// nothing here can reach _vault.mjs. The engine's code-independence limit (published in
// agent-metadata/dd-service.json) is about SHARING A FACT-PRODUCTION CATALOGUE with the audited
// system; a shared way of reading an API key is not that. Duplicating the credential logic instead
// would create the second copy that this project's own recurring bug is about.
//
// ═══ NO KEY IS EVER HELD HERE ════════════════════════════════════════════════════════════════
// The signing key belongs to Circle. This module asks Circle to sign a string; it cannot extract,
// export, or persist anything. The account that validates the result (0xc54d47…) is a smart
// contract with no private key at all — see attest.mjs for why that makes ERC-1271 the binding.

import { circle } from "../../netlify/functions/_circle.mjs";
import { DOMAIN } from "../../shared/onchain-analyze/attest.mjs";

/** The DD service's production identity. These are ASSERTED against the chain by verifyAttestation —
 *  nothing here is trusted merely because it is written down. */
export const DD_IDENTITY = Object.freeze({
  agentId: "851891",
  walletId: "2c93ca5d-be5c-5f51-883d-1a220647f7b1",
  verifyingContract: "0xc54d47211997aca90ef4fcfbc742a3b511b4e621",
  registry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  chainId: "5042002",
  domain: DOMAIN.prod,
  keyId: "circle-wallet:2c93ca5d-be5c-5f51-883d-1a220647f7b1",
  keyClass: "registered",
});

/**
 * Build a `sign(message)` function backed by Circle.
 *
 * Circle signs EIP-191 `personal_sign` over the UTF-8 message, which is exactly the digest
 * ERC-1271 validation expects here — proven by spike, and the reason attest.mjs hashes with
 * viem's `hashMessage` rather than `keccak256`.
 *
 * @param {{walletId?: string}} [opts]
 * @returns {(message: string) => Promise<string>}
 */
export function makeCircleSigner({ walletId = DD_IDENTITY.walletId } = {}) {
  let client = null;
  return async function sign(message) {
    client ??= circle(); // lazy: importing this module must not require credentials
    const res = await client.signMessage({ walletId, message });
    const signature = res?.data?.signature;
    if (!signature) {
      // Fail CLOSED and loudly. A missing signature must never become an unsigned-but-silent report:
      // the caller asked for an attested report and did not get one.
      throw new Error(
        `Circle returned no signature for walletId ${walletId}. Raw: ${JSON.stringify(res?.data)?.slice(0, 200)}`
      );
    }
    return signature;
  };
}

/** Convenience: the argument bundle attachAttestation() expects for the DD production identity. */
export function ddAttestationOptions(overrides = {}) {
  const { walletId, ...identity } = DD_IDENTITY;
  return { sign: makeCircleSigner({ walletId }), ...identity, ...overrides };
}
