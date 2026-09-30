// POST /api/auth-verify
//   metamask: { address, method, nonce, signature }
//   passkey:  { address, method, credentialId, publicKey?, nonce, signature, webauthn }
//
// Step 2 of session auth: verify the challenge, issue a session token.
//   - metamask (EOA): ecrecover — recoverMessageAddress must return `address`.
//   - passkey: OFF-CHAIN WebAuthn — webauthn-p256.verify against the credential's
//     public key. ⛔ 2026-09-30: ONLY a credential already stored logs in — the old
//     trust-on-first-use registration (the client's own key + the client's own address)
//     is refused until the proper fix binds the address to the key. See the MITIGATION
//     block below. No on-chain ERC-1271, so a stored passkey needs no deployed account.
// Identity stays the SCA address for BOTH methods (2a/2b mappings unchanged).
import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { recoverMessageAddress } from "viem";
import { verify as verifyWebauthn } from "webauthn-p256";
import { json, parseBody } from "./_arc.mjs";
import { checkNonce, buildMessage, issueSession, passkeyChallengeHash } from "./_auth.mjs";

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const isHex = (h) => typeof h === "string" && /^0x[0-9a-fA-F]+$/.test(h);
const CRED_STORE = "passkey-credentials";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

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

    // ═══ 🚨 MITIGATION (2026-09-30): NO FIRST-USE REGISTRATION; A FAILED READ IS REFUSED ════════════════════
    // Until ab85757's replacement lands, this path ONLY logs in a credential the server ALREADY stores. The old
    // trust-on-first-use branch took the CLIENT's publicKey for an unstored credentialId, verified the assertion
    // against THAT key (webauthn-p256 checks no origin / rpId; every field is client-supplied) and issued a session
    // for the CLIENT-SUPPLIED address — so a software key and any address got a session (proven locally, 2026-09-30).
    // New passkey sign-ups stop until the proper fix binds the address to the key; existing users are unaffected;
    // MetaMask (ecrecover, above) is unaffected. Tested: scripts/verify-auth-verify.mjs.
    //   · a FAILED read → refused (never "unknown": an outage must not become a registration or a login)
    //   · no stored record, or a stored record without a public key → refused; NOTHING is written
    //   · a stored credential → verified against the STORED key; the session is the STORED address
    //     (the request's `publicKey` and `address` are never used for a passkey session)
    const store = getStore(CRED_STORE);
    let stored;
    try { stored = await store.get(`cred:${credentialId}`, { type: "json" }); }
    catch { return json(401, { error: "your passkey could not be read right now — nothing was changed; try again shortly" }); }
    if (!stored || !isHex(stored.publicKey) || !isAddr(stored.address)) {
      return json(401, { error: "this passkey is not registered here — new passkey sign-ups are paused while registration is being secured; use an existing passkey or MetaMask" });
    }
    const pubkey = stored.publicKey;
    const boundAddress = String(stored.address).toLowerCase();

    const hash = passkeyChallengeHash(nonce);
    const ok = await verifyWebauthn({ hash, publicKey: pubkey, signature, webauthn });
    if (!ok) return json(401, { error: "passkey verification failed" });

    const { token, exp } = issueSession({ address: boundAddress, method });
    return json(200, { token, exp, identity: { address: boundAddress, method } });
  } catch (e) {
    return json(401, { error: `verification error: ${e.message}` });
  }
}
