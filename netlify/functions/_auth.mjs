// _auth.mjs — session identity layer (Brick 1 of the per-user re-architecture).
//
// Closes the anonymous-spend hole: money-moving endpoints require a short-lived,
// server-signed session token proving the caller controls a wallet. The token
// carries the authenticated IDENTITY as a plain wallet address — the SAME value
// Brick 2 will use as the owner key for per-user wallet mapping. Both wallet
// paths resolve to an address:
//   - MetaMask (EOA): verified off-chain via ecrecover (recoverMessageAddress).
//   - Passkey (Circle MSCA): verified on-chain via ERC-1271 (verifyMessage).
//
// Dependency-free: HMAC-SHA256 over the server-only SESSION_SECRET (Node crypto),
// no JWT library. Fail-closed: if SESSION_SECRET is unset, token issue/verify
// throws and every gated endpoint rejects (401) rather than running unauthenticated.

import crypto from "node:crypto";

const SESSION_TTL_SEC = 30 * 60; // a session lasts 30 min (covers a research job)
const NONCE_TTL_SEC = 5 * 60; //   a challenge must be answered within 5 min
const DOMAIN = "tikpema.xyz";

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    // No secret → we cannot mint or trust sessions. Throw so callers fail closed
    // (challenge/verify → 500, gated endpoints → 401), never open.
    throw new Error("SESSION_SECRET not set (server env, >=16 chars) — auth disabled");
  }
  return s;
}

// --- base64url + HMAC primitives -------------------------------------------
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (obj) => b64url(Buffer.from(JSON.stringify(obj)));
const fromB64urlJson = (s) =>
  JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

function hmac(data) {
  return b64url(crypto.createHmac("sha256", secret()).update(data).digest());
}
function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
const nowSec = () => Math.floor(Date.now() / 1000);

// --- Challenge nonce: stateless + unforgeable ------------------------------
// Format: `<exp>.<rand>.<hmac>`. The HMAC binds address+method+exp+rand, so a
// nonce issued for one address/method can't be replayed for another, and it
// expires. Stateless (no store) — the signature itself is the freshness proof.
export function makeNonce(address, method) {
  const exp = nowSec() + NONCE_TTL_SEC;
  const rand = b64url(crypto.randomBytes(12));
  const body = `${address.toLowerCase()}|${method}|${exp}|${rand}`;
  return `${exp}.${rand}.${hmac("nonce:" + body)}`;
}
export function checkNonce(nonce, address, method) {
  if (typeof nonce !== "string") return false;
  const [expStr, rand, sig] = nonce.split(".");
  if (!expStr || !rand || !sig) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < nowSec()) return false;
  const body = `${address.toLowerCase()}|${method}|${exp}|${rand}`;
  return safeEq(sig, hmac("nonce:" + body));
}

// --- The exact message the wallet signs (rebuilt identically on verify) -----
// SIWE-style, human-readable, and explicit that it moves no funds. Rebuilt from
// {address, method, nonce} on both sides so the client can't sign a different
// message than the server validates.
export function buildMessage({ address, method, nonce }) {
  const iso = new Date(Number(nonce.split(".")[0]) * 1000).toISOString();
  return [
    `${DOMAIN} wants you to sign in with your wallet:`,
    address,
    ``,
    `Authenticate your Tikpema session. This proves you control this wallet.`,
    `It does not authorize or move any funds.`,
    ``,
    `Method: ${method}`,
    `Nonce: ${nonce}`,
    `Expires: ${iso}`,
  ].join("\n");
}

// --- Session token: compact HMAC-signed `<payloadB64>.<hmac>` ---------------
export function issueSession({ address, method }) {
  const payload = {
    sub: address.toLowerCase(), // the reusable identity / owner key (Brick 2)
    method, //                     "passkey" | "metamask"
    iat: nowSec(),
    exp: nowSec() + SESSION_TTL_SEC,
  };
  const p = b64urlJson(payload);
  return { token: `${p}.${hmac("session:" + p)}`, exp: payload.exp };
}
export function verifyToken(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  if (!safeEq(sig, hmac("session:" + p))) return null;
  let payload;
  try {
    payload = fromB64urlJson(p);
  } catch {
    return null;
  }
  if (!payload?.sub || !payload?.exp || payload.exp < nowSec()) return null;
  // Identity surfaced to endpoints. `address` is the owner key Brick 2 maps on.
  return { address: payload.sub, method: payload.method };
}

// --- Handler helpers --------------------------------------------------------
function bearer(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : null;
}

// Returns the authenticated identity {address, method} or null. Never throws —
// a missing secret or bad token both resolve to null → the caller returns 401.
export function requireSession(event) {
  try {
    const t = bearer(event);
    if (!t) return null;
    return verifyToken(t);
  } catch {
    return null;
  }
}

// --- Internal server-to-server token ---------------------------------------
// job-submit-background triggers job-evaluate-background directly (no user in
// the loop). That call carries this token instead of a user session, so the
// evaluate endpoint can reject direct/anonymous calls while still accepting the
// legitimate internal chain. Derived from SESSION_SECRET — no extra env needed.
export function internalToken() {
  return hmac("internal:evaluate");
}
export function requireInternal(event) {
  try {
    const h = event.headers || {};
    const got = h["x-internal-token"] || h["X-Internal-Token"] || "";
    return !!got && safeEq(got, internalToken());
  } catch {
    return false;
  }
}
