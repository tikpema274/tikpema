// POST /api/auth-challenge { address, method, credentialId? }
//
// Step 1 of session auth: issue a signing challenge.
//   - metamask: returns a SIWE-style message string to personal_sign.
//   - passkey:  returns a 32-byte hash for the WebAuthn authenticator to sign
//               (verified off-chain against the stored public key — no on-chain
//               ERC-1271, so a fresh passkey needs no deployed smart account).
// The nonce is a stateless HMAC bound to this address+method and expires.
import { json, parseBody } from "./_arc.mjs";
import { makeNonce, buildMessage, passkeyChallengeHash } from "./_auth.mjs";

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const METHODS = new Set(["passkey", "metamask"]);

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { address, method, credentialId } = parseBody(event);
  if (!isAddr(address)) return json(400, { error: "valid 'address' required" });
  if (!METHODS.has(method)) {
    return json(400, { error: "method must be 'passkey' or 'metamask'" });
  }
  if (method === "passkey" && !credentialId) {
    return json(400, { error: "credentialId required for passkey" });
  }

  try {
    const nonce = makeNonce(address, method);
    if (method === "passkey") {
      // The authenticator signs this hash; the assertion carries it as the
      // WebAuthn challenge, which the server re-derives and verifies.
      return json(200, { address, method, nonce, hash: passkeyChallengeHash(nonce) });
    }
    return json(200, { address, method, nonce, message: buildMessage({ address, method, nonce }) });
  } catch (e) {
    // Almost always: SESSION_SECRET not configured. Surface loudly.
    return json(500, { error: e.message });
  }
}
