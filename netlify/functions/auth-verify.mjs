// POST /api/auth-verify
//   metamask: { address, method, nonce, signature }
//   passkey:  { address, method, credentialId, publicKey?, nonce, signature, webauthn }
//
// Step 2 of session auth: verify the challenge, issue a session token.
//   - metamask (EOA): ecrecover — recoverMessageAddress must return `address`.
//   - passkey: OFF-CHAIN WebAuthn — webauthn-p256.verify against the credential's
//     public key. The ADDRESS is never the client's choice: it is DERIVED from the key
//     (_passkey-address.mjs — a Circle MSCA is a pure CREATE2 of its P-256 key). See the
//     block below. No on-chain ERC-1271, so a passkey needs no deployed account.
// Identity stays the SCA address for BOTH methods (2a/2b mappings unchanged).
import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { recoverMessageAddress } from "viem";
import { verify as verifyWebauthn } from "webauthn-p256";
import { json, parseBody } from "./_arc.mjs";
import { checkNonce, buildMessage, issueSession, passkeyChallengeHash } from "./_auth.mjs";
import { derivePasskeyAddress } from "./_passkey-address.mjs";

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

    // ═══ THE ADDRESS IS THE KEY'S, NEVER THE CLIENT'S (2026-09-30; replaces the 94ef870 mitigation) ═══════════
    // ab85757 (2026-07-03) bound an unstored credentialId to the CLIENT's publicKey AND the CLIENT's address, so a
    // software key and any address got a session. Now the server DECIDES the address: derive(publicKey). The client's
    // address is only compared, never adopted. Tested: scripts/verify-auth-verify.mjs, scripts/verify-passkey-address.mjs.
    //   · a FAILED read → refused (never "unknown": an outage must not become a registration or a login)
    //   · STORED → verified against the STORED key; the stored address must equal derive(stored key), else REFUSED —
    //     never re-bound (the three 2026-07-03 software-authenticator test records fail this; their keys are held by
    //     nobody — PROGRESS 6d1cbab)
    //   · NOT stored → REGISTRATION: derive from the submitted key; a client address that differs → refused, nothing
    //     written; verify against that key; write onlyIfNew; a failed write or a lost race → refused, no session
    const store = getStore(CRED_STORE);
    let stored;
    try { stored = await store.get(`cred:${credentialId}`, { type: "json" }); }
    catch { return json(401, { error: "your passkey could not be read right now — nothing was changed; try again shortly" }); }

    let pubkey, boundAddress;
    if (stored) {
      if (!isHex(stored.publicKey) || !isAddr(stored.address)) {
        return json(401, { error: "this passkey's record is incomplete — it cannot sign in; use MetaMask or register a new passkey" });
      }
      let own;
      try { own = derivePasskeyAddress(stored.publicKey); } catch { own = null; }
      if (own !== String(stored.address).toLowerCase()) {
        return json(401, { error: "this passkey's record does not match its key — it cannot sign in; use MetaMask or register a new passkey" });
      }
      pubkey = stored.publicKey;
      boundAddress = own;
    } else {
      if (!isHex(publicKey)) {
        return json(400, { error: "this passkey is not registered here yet — its public key is required to register it" });
      }
      let own;
      try { own = derivePasskeyAddress(publicKey); }
      catch (e) { return json(400, { error: `invalid passkey public key: ${e.message}` }); }
      if (own !== address.toLowerCase()) {
        return json(401, { error: "that address does not belong to this passkey — nothing was registered" });
      }
      pubkey = publicKey;
      boundAddress = own;
    }

    const hash = passkeyChallengeHash(nonce);
    const ok = await verifyWebauthn({ hash, publicKey: pubkey, signature, webauthn });
    if (!ok) return json(401, { error: "passkey verification failed" });

    if (!stored) {
      let wrote;
      try {
        wrote = await store.set(`cred:${credentialId}`,
          JSON.stringify({ publicKey: pubkey, address: boundAddress, createdAt: new Date().toISOString() }), { onlyIfNew: true });
      } catch { return json(401, { error: "your passkey could not be registered right now — nothing was changed; try again shortly" }); }
      if (!wrote?.modified) {
        return json(401, { error: "this passkey was registered by another request just now — sign in again" });
      }
    }

    const { token, exp } = issueSession({ address: boundAddress, method });
    return json(200, { token, exp, identity: { address: boundAddress, method } });
  } catch (e) {
    return json(401, { error: `verification error: ${e.message}` });
  }
}
