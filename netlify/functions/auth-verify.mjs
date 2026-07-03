// POST /api/auth-verify { address, method, nonce, signature }
//
// Step 2 of session auth: verify the signed challenge, issue a session token.
//   - metamask (EOA): ecrecover — recoverMessageAddress must return `address`.
//   - passkey (Circle MSCA): ERC-1271 — publicClient.verifyMessage validates the
//     account's own wrapped signature on-chain (works once the account is
//     deployed, i.e. after its first user-op / job creation).
// On success → a 30-min HMAC session token whose `sub` is the wallet address
// (the reusable owner identity for Brick 2).
import { json, parseBody } from "./_arc.mjs";
import { checkNonce, buildMessage, issueSession } from "./_auth.mjs";
import { recoverMessageAddress } from "viem";
import { publicClient } from "./_predict.mjs";

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const METHODS = new Set(["passkey", "metamask"]);

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { address, method, nonce, signature } = parseBody(event);
  if (!isAddr(address)) return json(400, { error: "valid 'address' required" });
  if (!METHODS.has(method)) return json(400, { error: "invalid method" });
  if (!signature) return json(400, { error: "signature required" });

  try {
    // The nonce is server-issued, unexpired, and bound to this address+method.
    if (!checkNonce(nonce, address, method)) {
      return json(401, { error: "challenge invalid or expired — request a new one" });
    }
    const message = buildMessage({ address, method, nonce });

    let ok = false;
    if (method === "metamask") {
      const recovered = await recoverMessageAddress({ message, signature });
      ok = recovered.toLowerCase() === address.toLowerCase();
    } else {
      // Passkey: the Circle smart account validates its own ERC-1271 signature.
      ok = await publicClient().verifyMessage({ address, message, signature });
    }
    if (!ok) return json(401, { error: "signature verification failed" });

    const { token, exp } = issueSession({ address, method });
    return json(200, { token, exp, identity: { address: address.toLowerCase(), method } });
  } catch (e) {
    return json(401, { error: `verification error: ${e.message}` });
  }
}
