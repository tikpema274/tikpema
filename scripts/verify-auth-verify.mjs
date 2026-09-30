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
// ═══ THE PROPER FIX UNDER TEST (T, 2026-09-30) — the server DECIDES the address ══════════════════════
//   · REGISTRATION (credentialId not stored): the address is DERIVED from the submitted key (_passkey-address.mjs —
//     a Circle MSCA is a pure CREATE2 of its P-256 key). A client address that differs → REFUSED, adopting NEITHER;
//     nothing is written. The assertion is verified against THAT key; the record is written only if new (onlyIfNew).
//     A failed read, a failed write, or a lost onlyIfNew race → REFUSED, no session.
//   · LOGIN (stored): verified against the STORED key, and the stored address must equal derive(stored key) — a record
//     that disagrees (the three 2026-07-03 software-authenticator test artifacts) → REFUSED, never exempted.
//   · MetaMask (ecrecover) → unaffected.
// History: 94ef870 (the MITIGATION) refused every unstored credential — sign-ups paused. RED recorded against both the
// TOFU code (94ef870^) and the mitigation before the fix.

import { mock } from "node:test";
const store = { rows: new Map(), throws: false, setThrows: false, notModified: false, writes: [] };
mock.module("@netlify/blobs", { namedExports: {
  connectLambda: () => {},
  getStore: () => ({
    async get(key) { if (store.throws) throw new Error("blobs down"); const v = store.rows.get(key); return v === undefined ? null : JSON.parse(JSON.stringify(v)); },
    async set(key, value, o) { store.writes.push([key, o]); if (store.setThrows) throw new Error("blobs write down"); if (store.notModified || (o?.onlyIfNew && store.rows.has(key))) return { modified: false }; store.rows.set(key, JSON.parse(value)); return { modified: true }; },
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

// The EXPECTED address comes from the SDK's own (unexported) computeAddress — an oracle independent of the module under
// test (whose parity with it is verify-passkey-address.mjs's job). Loaded from its dist beside node_modules.
const { readFileSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
const PARITY_DIR = new URL("../node_modules/.cache/auth-verify-oracle/", import.meta.url);
mkdirSync(PARITY_DIR, { recursive: true });
writeFileSync(new URL("sdk.mjs", PARITY_DIR), readFileSync(new URL("../node_modules/@circle-fin/modular-wallets-core/dist/index.mjs", import.meta.url), "utf8") + "\nexport { computeAddress as __computeAddress };\n");
const { __computeAddress } = await import(new URL("sdk.mjs", PARITY_DIR));
rmSync(PARITY_DIR, { recursive: true, force: true });
const { toWebAuthnAccount } = await import("viem/account-abstraction");
const derived = (publicKey) => __computeAddress(toWebAuthnAccount({ credential: { id: "x", publicKey } })).toLowerCase();

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
const reset = () => { store.rows.clear(); store.throws = false; store.setThrows = false; store.notModified = false; store.writes.length = 0; };

// ════════════════════════════════════════════════════════════════════════════════════════════════
section("⛔ THE TOFU EXPLOIT: an unstored credential + a software key + SOMEONE ELSE'S address");
{
  reset();
  const VICTIM = "0x" + "ab".repeat(20);
  const key = newPasskey();
  const r = await passkeyLogin({ address: VICTIM, credentialId: "attacker-cred", key });
  ok("⭐⭐ REFUSED: 401, no token", r.status === 401 && !r.body?.token, JSON.stringify(r));
  ok("⭐⭐ …and NOTHING is written — the made-up address is bound to nothing", store.writes.length === 0 && store.rows.size === 0, JSON.stringify(store.writes));
  ok("⭐ …and the refusal names the disagreement (the address is not this passkey's)", /does not belong|not this passkey|address/i.test(r.body?.error ?? ""), r.body?.error);
  ok("⭐ …and neither address is adopted (no session for the victim, none for the derived address)", !r.body?.identity, JSON.stringify(r.body));

  // The victim is a REAL registered passkey user: the attacker names their address with a fresh credentialId.
  reset();
  const victimKey = newPasskey(); const VICTIM2 = derived(victimKey.publicKey);
  store.rows.set("cred:victim-cred", { publicKey: victimKey.publicKey, address: VICTIM2, createdAt: "2026-07-12T00:00:00Z" });
  const r2 = await passkeyLogin({ address: VICTIM2, credentialId: "attacker-cred-2", key: newPasskey() });
  ok("⭐⭐ a REGISTERED user's address named with a fresh credential + the attacker's key → 401, no token", r2.status === 401 && !r2.body?.token, JSON.stringify(r2));
  ok("…nothing written", store.writes.length === 0, JSON.stringify(store.writes));

  // The attacker's key with the victim's key as the claimed publicKey: the signature cannot verify.
  reset();
  const r3 = await passkeyLogin({ address: VICTIM2, credentialId: "attacker-cred-3", key: { priv: newPasskey().priv, publicKey: victimKey.publicKey } });
  ok("⭐ claiming the VICTIM's public key (so the address derives correctly) but signing with another key → 401, nothing written", r3.status === 401 && !r3.body?.token && store.writes.length === 0, JSON.stringify(r3));
}

section("⭐ REGISTRATION: a new passkey signs up again — the address is the one its key derives");
{
  reset();
  const key = newPasskey(); const ADDR = derived(key.publicKey);
  const r = await passkeyLogin({ address: ADDR, credentialId: "new-cred", key });
  ok("⭐⭐ its own derived address → 200 and a session for exactly that address", r.status === 200 && verifyToken(r.body?.token)?.address === ADDR, JSON.stringify(r.body?.identity ?? r));
  ok("⭐ ONE write, onlyIfNew, keyed by the credential", store.writes.length === 1 && store.writes[0][0] === "cred:new-cred" && store.writes[0][1]?.onlyIfNew === true, JSON.stringify(store.writes));
  const rec = store.rows.get("cred:new-cred");
  ok("⭐ the record binds the SUBMITTED key to the DERIVED address", rec?.publicKey === key.publicKey && rec?.address === ADDR, JSON.stringify(rec));
  const r2 = await passkeyLogin({ address: ADDR, credentialId: "new-cred", key, sendPublicKey: false });
  ok("…and it logs in afterwards through the stored path (no publicKey needed)", r2.status === 200 && verifyToken(r2.body?.token)?.address === ADDR && store.writes.length === 1, JSON.stringify(r2.body?.identity ?? r2));

  reset();
  const k2 = newPasskey(); const A2 = derived(k2.publicKey);
  const r3 = await passkeyLogin({ address: A2.replace(/[a-f]/g, (c) => c.toUpperCase()).replace(/^0X/, "0x"), credentialId: "case-cred", key: k2 });
  ok("a checksummed / upper-case client address of the same account → 200, stored lowercase", r3.status === 200 && store.rows.get("cred:case-cred")?.address === A2, JSON.stringify(r3.body?.identity ?? r3));

  reset();
  const k3 = newPasskey(); const unprefixed = "0x" + k3.publicKey.slice(4);
  const r4 = await passkeyLogin({ address: derived(k3.publicKey), credentialId: "raw-cred", key: { priv: k3.priv, publicKey: unprefixed } });
  ok("the 64-byte x‖y key form (what Circle returns; what prod stores) registers too", r4.status === 200 && store.rows.get("cred:raw-cred")?.publicKey === unprefixed, JSON.stringify(r4.body?.identity ?? r4));
}

section("REGISTRATION refuses — and writes nothing — on every non-proof");
{
  reset();
  const key = newPasskey(); const ADDR = derived(key.publicKey);
  const r = await passkeyLogin({ address: ADDR, credentialId: "nokey-cred", key, sendPublicKey: false });
  ok("no publicKey for an unstored credential → refused, nothing written", r.status >= 400 && !r.body?.token && store.writes.length === 0, JSON.stringify(r));

  reset();
  const r2 = await passkeyLogin({ address: ADDR, credentialId: "badkey-cred", key: { priv: key.priv, publicKey: "0x04" + "11".repeat(64) } });
  ok("a malformed / off-curve publicKey → refused, nothing written", r2.status >= 400 && !r2.body?.token && store.writes.length === 0, JSON.stringify(r2));

  reset();
  const other = newPasskey();
  const r3 = await passkeyLogin({ address: derived(other.publicKey), credentialId: "wrongsig-cred", key: { priv: key.priv, publicKey: other.publicKey } });
  ok("a signature by another key than the submitted one → 401, nothing written", r3.status === 401 && !r3.body?.token && store.writes.length === 0, JSON.stringify(r3));
}

section("⛔ A FAILED read / write is REFUSED — never 'unknown', never a session without a record");
{
  reset();
  const key = newPasskey(); const ADDR = derived(key.publicKey);
  store.rows.set("cred:real-cred", { publicKey: key.publicKey, address: ADDR, createdAt: "2026-07-12T20:00:00Z" });
  store.throws = true;
  const r = await passkeyLogin({ address: ADDR, credentialId: "real-cred", key });
  ok("⭐⭐ the store read THROWS → 401 (an outage never becomes a login, nor a registration)", r.status === 401 && !r.body?.token, JSON.stringify(r));
  ok("…and the refusal says the credential could not be read (retry), not that it is unknown", /could not be read|unavailable|try again/i.test(r.body?.error ?? ""), r.body?.error);
  ok("…nothing written", store.writes.length === 0);
  const k2 = newPasskey();
  const r2 = await passkeyLogin({ address: derived(k2.publicKey), credentialId: "real-cred", key: k2 });
  ok("⭐ reusing an EXISTING credentialId during the outage, with a new key and ITS derived address → 401, nothing written", r2.status === 401 && !r2.body?.token && store.writes.length === 0, JSON.stringify(r2));

  reset();
  store.setThrows = true;
  const k3 = newPasskey();
  const r3 = await passkeyLogin({ address: derived(k3.publicKey), credentialId: "write-fails", key: k3 });
  ok("⭐⭐ a registration whose WRITE throws → 401, no token (no session without a stored binding)", r3.status === 401 && !r3.body?.token, JSON.stringify(r3));

  reset();
  store.notModified = true;
  const k4 = newPasskey();
  const r4 = await passkeyLogin({ address: derived(k4.publicKey), credentialId: "race-cred", key: k4 });
  ok("⭐ a registration that LOSES the onlyIfNew race (modified:false) → 401, no token", r4.status === 401 && !r4.body?.token, JSON.stringify(r4));
}

section("A stored credential with no public key is REFUSED (malformed)");
{
  reset();
  store.rows.set("cred:broken", { address: "0x" + "cd".repeat(20) });
  const r = await passkeyLogin({ address: "0x" + "cd".repeat(20), credentialId: "broken", key: newPasskey() });
  ok("a stored record without publicKey → 401, never treated as first use", r.status === 401 && !r.body?.token && store.writes.length === 0, JSON.stringify(r));
}

section("⛔ LOGIN: a stored record whose address is NOT its key's — the 2026-07-03 test-artifact shape — is REFUSED");
{
  reset();
  const key = newPasskey(); const WRONG = "0x" + "9c".repeat(20);
  store.rows.set("cred:tofu-artifact", { publicKey: key.publicKey, address: WRONG, createdAt: "2026-07-03T20:07:12.122Z" });
  const r = await passkeyLogin({ address: WRONG, credentialId: "tofu-artifact", key, sendPublicKey: false });
  ok("⭐⭐ even with a VALID assertion by the stored key → 401, no token", r.status === 401 && !r.body?.token, JSON.stringify(r));
  ok("⭐ …never re-bound: the record is untouched, nothing written", store.writes.length === 0 && store.rows.get("cred:tofu-artifact").address === WRONG, JSON.stringify(store.writes));
  const r2 = await passkeyLogin({ address: derived(key.publicKey), credentialId: "tofu-artifact", key });
  ok("⭐ …and naming the DERIVED address instead does not open it either (no session for either)", r2.status === 401 && !r2.body?.token && store.writes.length === 0, JSON.stringify(r2));
}

section("EXISTING passkey users keep logging in — verified against the STORED key");
{
  reset();
  const key = newPasskey(); const ADDR = derived(key.publicKey);
  store.rows.set("cred:real-cred", { publicKey: key.publicKey, address: ADDR, createdAt: "2026-07-12T20:00:00Z" });
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
  const k5 = newPasskey(); const A5 = derived(k5.publicKey);
  store.rows.set("cred:prod-shape", { publicKey: "0x" + k5.publicKey.slice(4), address: A5, createdAt: "2026-07-12T20:00:00Z" });
  const r5 = await passkeyLogin({ address: A5, credentialId: "prod-shape", key: k5, sendPublicKey: false });
  ok("⭐ a stored 64-byte x‖y key (the shape every prod record has) → 200", r5.status === 200 && verifyToken(r5.body?.token)?.address === A5, JSON.stringify(r5.body?.identity ?? r5));
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
