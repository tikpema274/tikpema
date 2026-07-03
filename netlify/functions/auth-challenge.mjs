// POST /api/auth-challenge { address, method }
//
// Step 1 of session auth: issue a signing challenge. Returns a stateless nonce
// and the exact SIWE-style message the wallet must sign. No secrets leave the
// server; the nonce is an HMAC that binds this address+method and expires.
import { json, parseBody } from "./_arc.mjs";
import { makeNonce, buildMessage } from "./_auth.mjs";

const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
const METHODS = new Set(["passkey", "metamask"]);

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { address, method } = parseBody(event);
  if (!isAddr(address)) return json(400, { error: "valid 'address' required" });
  if (!METHODS.has(method)) {
    return json(400, { error: "method must be 'passkey' or 'metamask'" });
  }

  try {
    const nonce = makeNonce(address, method);
    const message = buildMessage({ address, method, nonce });
    return json(200, { address, method, nonce, message });
  } catch (e) {
    // Almost always: SESSION_SECRET not configured. Surface loudly.
    return json(500, { error: e.message });
  }
}
