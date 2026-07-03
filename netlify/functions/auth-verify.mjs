// POST /api/auth-verify
//   metamask: { address, method, nonce, signature }
//   passkey:  { address, method, credentialId, publicKey?, nonce, signature, webauthn }
//
// Step 2 of session auth: verify the challenge, issue a session token.
//   - metamask (EOA): ecrecover — recoverMessageAddress must return `address`.
//   - passkey: OFF-CHAIN WebAuthn — webauthn-p256.verify against the credential's
//     public key. The pubkey is captured at registration (login assertions don't
//     return it) into a Blobs store, trust-on-first-use with onlyIfNew. No
//     on-chain ERC-1271, so a fresh passkey needs no deployed smart account.
// Identity stays the SCA address for BOTH methods (2a/2b mappings unchanged).
import { connectLambda, getStore } from "@netlify/blobs";
import { recoverMessageAddress } from "viem";
import { verify as verifyWebauthn } from "webauthn-p256";
import { json, parseBody } from "./_arc.mjs";
import { checkNonce, buildMessage, issueSession, passkeyChallengeHash } from "./_auth.mjs";

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const isHex = (h) => typeof h === "string" && /^0x[0-9a-fA-F]+$/.test(h);
const CRED_STORE = "passkey-credentials";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectLambda(event);

  const { address, method, credentialId, publicKey, nonce, signature, webauthn } = parseBody(event);
  if (!isAddr(address)) return json(400, { error: "valid 'address' required" });
  if (method !== "passkey" && method !== "metamask") {
    return json(400, { error: "invalid method" });
  }
  if (!signature) return json(400, { error: "signature required" });

  try {
    // The nonce is server-issued, unexpired, and bound to this address+method.
    if (!checkNonce(nonce, address, method)) {
      return json(401, { error: "challenge invalid or expired — request a new one" });
    }

    // ---- MetaMask (EOA): ecrecover ----
    if (method === "metamask") {
      const message = buildMessage({ address, method, nonce });
      const recovered = await recoverMessageAddress({ message, signature });
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        return json(401, { error: "signature verification failed" });
      }
      const { token, exp } = issueSession({ address, method });
      return json(200, { token, exp, identity: { address: address.toLowerCase(), method } });
    }

    // ---- Passkey: off-chain WebAuthn ----
    if (!credentialId) return json(400, { error: "credentialId required" });
    if (!webauthn) return json(400, { error: "webauthn assertion required" });

    const store = getStore(CRED_STORE);
    const stored = await store.get(`cred:${credentialId}`, { type: "json" }).catch(() => null);

    // Login assertions don't return the public key, so we verify against the
    // STORED key. Registration supplies it (first use). Bind the identity to the
    // stored/first address so a later request can't swap it.
    let pubkey, boundAddress;
    if (stored?.publicKey) {
      pubkey = stored.publicKey;
      boundAddress = stored.address;
    } else {
      if (!isHex(publicKey)) {
        return json(400, { error: "unknown credential — publicKey required to register it" });
      }
      pubkey = publicKey;
      boundAddress = address.toLowerCase();
    }

    const hash = passkeyChallengeHash(nonce);
    const ok = await verifyWebauthn({ hash, publicKey: pubkey, signature, webauthn });
    if (!ok) return json(401, { error: "passkey verification failed" });

    // Trust-on-first-use: bind credentialId → { publicKey, address } immutably.
    if (!stored?.publicKey) {
      await store
        .set(`cred:${credentialId}`, JSON.stringify({ publicKey: pubkey, address: boundAddress, createdAt: new Date().toISOString() }), { onlyIfNew: true })
        .catch(() => {});
    }

    const { token, exp } = issueSession({ address: boundAddress, method });
    return json(200, { token, exp, identity: { address: boundAddress, method } });
  } catch (e) {
    return json(401, { error: `verification error: ${e.message}` });
  }
}
