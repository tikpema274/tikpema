#!/usr/bin/env node
// verify-auth-verify.mjs — the session login (netlify/functions/auth-verify.mjs), driven through the REAL handler.
//
//   node --experimental-test-module-mocks scripts/verify-auth-verify.mjs
//
// ═══ WHY THIS SUITE EXISTS (2026-09-30) ══════════════════════════════════════════════════════════════
// No test covered auth-verify. From ab85757 (2026-07-03) its passkey path accepted an UNSTORED credentialId: it took
// the CLIENT's publicKey, verified the WebAuthn assertion against THAT key (webauthn-p256 checks no origin / rpId; every
// field is client-supplied), and issued a session for the CLIENT-SUPPLIED address. A software P-256 key and a made-up
// address got a 200 and a valid session (proven locally 2026-09-30). The session is the identity 40 functions trust.
//
// ═══ THE MITIGATION UNDER TEST (T, 2026-09-30) ══════════════════════════════════════════════════════════
//   · a credentialId that is NOT stored → REFUSED (401). No first-use registration until the proper fix binds the
//     address to the key. Nothing is written.
//   · a FAILED credential read → REFUSED, never "unknown".
//   · a STORED credential → verified against the STORED key; the session is the STORED address.
//   · MetaMask (ecrecover) → unaffected.

import { mock } from "node:test";
const store = { rows: new Map(), throws: false, writes: [] };
mock.module("@netlify/blobs", { namedExports: {
  connectLambda: () => {},
  getStore: () => ({
    async get(key) { if (store.throws) throw new Error("blobs down"); const v = store.rows.get(key); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
    async set(key, value, o) { store.writes.push([key, o]); if (o?.onlyIfNew && store.rows.has(key)) return { modified: false }; store.rows.set(key, JSON.parse(value)); return { modified: true }; },
    async setJSON(key, value, o) { store.writes.push([key, o]); store.rows.set(key, value); return { modified: true }; },
  }),
} });
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-0123456789abcdef";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { if (cond) { pass++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); } };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

const { handler: challenge } = await import("../netlify/functions/auth-challenge.mjs");
const { handler: verify } = await import("../netlify/functions/auth-verify.mjs");
const { verifyToken } = await import("../netlify/functions/_auth.mjs");
const { p256 } = await import("@noble/curves/p256");
const { privateKeyToAccount } = await import("viem/accounts");
const { createHash, randomBytes } = await import("node:crypto");

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const newPasskey = () => { const priv = p256.utils.randomPrivateKey(); return { priv, publicKey: "0x" + Buffer.from(p256.getPublicKey(priv, false)).toString("hex") }; };
const call = async (fn, body) => { const r = await fn({ httpMethod: "POST", body: JSON.stringify(body), headers: {} }); let b; try { b = JSON.parse(r.body); } catch { b = r.body; } return { status: r.statusCode, body: b }; };

/** A WebAuthn assertion over the server's challenge hash, made with a SOFTWARE key — no authenticator. */
async function passkeyLogin({ address, credentialId, key, sendPublicKey = true }) {
  const ch = await call(challenge, { address, method: "passkey", credentialId });
  const authenticatorData = Buffer.concat([randomBytes(32), Buffer.from([0x05]), Buffer.alloc(4)]);
  const clientDataJSON = JSON.stringify({ type: "webauthn.get", challenge: b64url(Buffer.from(ch.body.hash.slice(2), "hex")), origin: "https://anything.example" });
  const msg = createHash("sha256").update(Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()])).digest();
  const sig = p256.sign(msg, key.priv, { prehash: false, lowS: true });
  return call(verify, { address, method: "passkey", credentialId, ...(sendPublicKey ? { publicKey: key.publicKey } : {}), nonce: ch.body.nonce,
    signature: "0x" + sig.r.toString(16).padStart(64, "0") + sig.s.toString(16).padStart(64, "0"),
    webauthn: { authenticatorData: "0x" + authenticatorData.toString("hex"), clientDataJSON, challengeIndex: clientDataJSON.indexOf('"challenge"'), typeIndex: clientDataJSON.indexOf('"type"'), userVerificationRequired: false } });
}
const reset = () => { store.rows.clear(); store.throws = false; store.writes.length = 0; };

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("⛔ THE PROOF (2026-09-30): an unstored credential + a software key + a made-up address");
{
  reset();
  const VICTIM = "0x" + "ab".repeat(20);
  const r = await passkeyLogin({ address: VICTIM, credentialId: "attacker-cred", key: newPasskey() });
  ok("⭐⭐ the real handler REFUSES it: 401, no token", r.status === 401 && !r.body?.token, JSON.stringify(r));
  ok("⭐ …and says why: an unknown credential is not registered here", /not registered|unknown credential|sign-up|registration/i.test(r.body?.error ?? ""), r.body?.error);
  ok("⭐ …and NOTHING is written (no credential bound to the made-up address)", store.writes.length === 0 && store.rows.size === 0, JSON.stringify(store.writes));
  const r2 = await passkeyLogin({ address: VICTIM, credentialId: "attacker-cred-2", key: newPasskey(), sendPublicKey: false });
  ok("the same without a publicKey → still 401", r2.status === 401 && !r2.body?.token, JSON.stringify(r2));
}

section("⛔ A FAILED credential read is REFUSED, never 'unknown'");
{
  reset();
  const key = newPasskey(); const ADDR = "0x" + "cd".repeat(20);
  store.rows.set("cred:real-cred", { publicKey: key.publicKey, address: ADDR, createdAt: "2026-07-03T20:00:00Z" });
  store.throws = true;
  const r = await passkeyLogin({ address: ADDR, credentialId: "real-cred", key });
  ok("⭐⭐ the store THROWS → 401 (an outage never becomes a login, nor a registration)", r.status === 401 && !r.body?.token, JSON.stringify(r));
  ok("…and the refusal says the credential could not be read (retry), not that it is unknown", /could not be read|unavailable|try again/i.test(r.body?.error ?? ""), r.body?.error);
  ok("…nothing written", store.writes.length === 0);
  const r2 = await passkeyLogin({ address: "0x" + "ee".repeat(20), credentialId: "real-cred", key: newPasskey() });
  ok("⭐ an attacker reusing an EXISTING credentialId during the outage, with their own key → 401", r2.status === 401 && !r2.body?.token, JSON.stringify(r2));
}

section("A stored credential with no public key is REFUSED (malformed)");
{
  reset();
  store.rows.set("cred:broken", { address: "0x" + "cd".repeat(20) });
  const r = await passkeyLogin({ address: "0x" + "cd".repeat(20), credentialId: "broken", key: newPasskey() });
  ok("a stored record without publicKey → 401, never treated as first use", r.status === 401 && !r.body?.token && store.writes.length === 0, JSON.stringify(r));
}

section("EXISTING passkey users keep logging in — verified against the STORED key");
{
  reset();
  const key = newPasskey(); const ADDR = "0x" + "cd".repeat(20);
  store.rows.set("cred:real-cred", { publicKey: key.publicKey, address: ADDR, createdAt: "2026-07-03T20:00:00Z" });
  const r = await passkeyLogin({ address: ADDR, credentialId: "real-cred", key });
  ok("⭐⭐ the stored key's assertion → 200 and a session for the STORED address", r.status === 200 && verifyToken(r.body?.token)?.address === ADDR, JSON.stringify(r.body?.identity ?? r));
  ok("…and nothing is written (the credential already exists)", store.writes.length === 0, JSON.stringify(store.writes));
  const r2 = await passkeyLogin({ address: ADDR, credentialId: "real-cred", key, sendPublicKey: false });
  ok("the same without a publicKey in the request (a login assertion) → 200", r2.status === 200 && verifyToken(r2.body?.token)?.address === ADDR, JSON.stringify(r2.body?.identity ?? r2));
  const r3 = await passkeyLogin({ address: ADDR, credentialId: "real-cred", key: newPasskey() });
  ok("⭐ a STORED credential signed with ANOTHER key (the client's publicKey ignored) → 401", r3.status === 401 && !r3.body?.token, JSON.stringify(r3));
  const OTHER = "0x" + "99".repeat(20);
  const r4 = await passkeyLogin({ address: OTHER, credentialId: "real-cred", key });
  ok("⭐ a stored credential with a DIFFERENT address in the request → the session is the STORED address, never the requested one",
    (r4.status === 200 && verifyToken(r4.body?.token)?.address === ADDR) || r4.status === 401, JSON.stringify(r4.body?.identity ?? r4));
}

section("MetaMask login is unaffected");
{
  reset();
  const acct = privateKeyToAccount("0x" + "11".repeat(32));
  const ch = await call(challenge, { address: acct.address, method: "metamask" });
  const signature = await acct.signMessage({ message: ch.body.message });
  const r = await call(verify, { address: acct.address, method: "metamask", nonce: ch.body.nonce, signature });
  ok("⭐ a valid ecrecover signature → 200, the signer's address", r.status === 200 && verifyToken(r.body?.token)?.address === acct.address.toLowerCase(), JSON.stringify(r.body?.identity ?? r));
  const liar = privateKeyToAccount("0x" + "22".repeat(32));
  const bad = await liar.signMessage({ message: ch.body.message });
  const r2 = await call(verify, { address: acct.address, method: "metamask", nonce: ch.body.nonce, signature: bad });
  ok("a signature from another key → 401", r2.status === 401, JSON.stringify(r2));
  ok("MetaMask login touches no credential store", store.writes.length === 0);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-auth-verify — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
