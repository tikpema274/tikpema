#!/usr/bin/env node
// verify-vault-mandate-operator.mjs — step 0: the OPERATOR-ONLY mandate creation path (PROGRESS 2026-09-27,
// "OPERATOR-ONLY CREATION — SCOPE" + T's decisions). create · acknowledge · cancel, for T's own wallet only.
//
//   node scripts/verify-vault-mandate-operator.mjs
//
// ═══ THE TWO REQUIREMENTS THIS SUITE EXISTS TO PROVE (T, 2026-09-27) ═════════════════════════════
//   1. THE SESSION GATE IS THE BOUNDARY. /.netlify/functions/vault-mandate-operator is publicly reachable
//      whether or not anything links to it. A session whose address is not in OPERATOR_MANDATE_OWNERS gets
//      the SAME 403 as no session at all — byte-identical response, no dependency touched, and the membership
//      check does the same work for any address — so nothing reveals whether an address is on the list.
//   2. THE vaultAckToken COMES ONLY FROM ackRequired === true. depositDisclosure mints an ackToken on the
//      vault's own WARN even when the gate added a BLOCK; taking the token alone would bake a blocked vault's
//      token into a mandate. And the create response SHOWS the disclosure behind the token, because
//      acknowledging the fingerprint acknowledges that disclosure.
//
// ⚠️ Offline. The handler, the store core, the record and the session check are the real ones; the chain-
// and Circle-facing dependencies (wallet, disclosure, baseline) are fakes that count every call.

process.env.SESSION_SECRET = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
  ? process.env.SESSION_SECRET : "operator-suite-secret-0123456789";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { issueSession } from "../netlify/functions/_auth.mjs";
import { verifyMandateRecord, buildMandateRecord, acknowledgeMandate, mandateFingerprint, renderDisclosure } from "../shared/vault-mandate/record.mjs";
import { vaultMandateKey, readMandate } from "../netlify/functions/_vault-mandate-store.mjs";
import { disclosureDigest, ackTokenFor } from "../netlify/functions/_vault.mjs";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);
const attempt = (fn) => { try { return fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const attemptAsync = async (fn) => { try { return await fn(); } catch (e) { return { threw: String(e?.message ?? e) }; } };
const show = (o) => JSON.stringify(o ?? null)?.slice(0, 200);
const clone = (o) => JSON.parse(JSON.stringify(o));
// A module that does not exist yet is a FAILING CHECK, not a crash, so the red state is readable.
const load = async (p) => { try { return await import(p); } catch (e) { return { __missing: String(e?.message ?? e) }; } };

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  VAULT MANDATE — the operator-only creation path                     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const OPS = await load("../shared/vault-mandate/operators.mjs");
const H = await load("../netlify/functions/vault-mandate-operator.mjs");
const CHK = await load("../netlify/functions/_vault-mandate-check.mjs");
const T_ADDR = "0x74b7b561FD71C68Eb1Da6b96a7A87033904b24E5"; // T's login address (T, 2026-09-27) — the ONE operator
const STRANGER = "0xaaaa000000000000000000000000000000000001";
const WALLET = "0xbbbb000000000000000000000000000000000002";
const VAULT_OWNER = "0x94e0dc7ad29b94ec9819f6cec3364dd34f41b3c6";
const VAULT = { key: "xylo-usdc", address: "0x240Eb85458CD41361bd8C3773253a1D78054f747", chainId: 31337, label: "XyloNet USDC Vault (xyUSDC)", assetAddress: "0x" + "36".repeat(20) }; // fixture chain id (test:literals)
const NOW = Date.parse("2026-09-27T12:00:00Z");
const TERMS = { amountPerDepositUsdc: 10, maxTotalUsdc: 100, cadence: "weekly" };
const RULES = [{ kind: "power", subject: "upgradeable", onFinding: "pause" }, { kind: "state", subject: "exit-fee-above", limitBps: 0, onFinding: "pause" }];
const bearer = (address) => ({ authorization: `Bearer ${issueSession({ address, method: "metamask" }).token}` });
const ev = ({ headers = {}, method = "POST", body } = {}) => ({ httpMethod: method, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });

function fakeStore() {
  const m = new Map(); let n = 0;
  return { _map: m,
    async get(key) { return m.has(key) ? clone(m.get(key).data) : null; },
    async getWithMetadata(key) { return m.has(key) ? { data: clone(m.get(key).data), etag: m.get(key).etag } : null; },
    async setJSON(key, data, opts = {}) {
      if (opts.onlyIfNew && m.has(key)) return { modified: false };
      if (opts.onlyIfMatch !== undefined && (!m.has(key) || m.get(key).etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = `"e${++n}"`; m.set(key, { data: clone(data), etag }); return { modified: true, etag };
    } };
}

// ── a WARN inspection, and what depositDisclosure returns for it (its exact return shape) ──
const INSPECTION = {
  verdict: { level: "WARN", blocks: [], warns: [{ code: "owner-is-eoa", detail: "a single key controls the vault" }, { code: "fees-settable", detail: "the owner can change fees" }] },
  withdraw: { withdrawFeeBps: 10 }, ownerPowers: { settableFees: { currentBps: { deposit: 0 } } },
  disclosure: { holder: VAULT_OWNER, holderKind: "eoa" }, address: VAULT.address,
};
const TOKEN = ackTokenFor(INSPECTION);
const disclosureOf = (over = {}) => ({
  vault: { key: VAULT.key, address: VAULT.address, label: VAULT.label },
  inspection: INSPECTION, gate: { level: "WARN", blocks: [], warns: INSPECTION.verdict.warns },
  depositable: true, ackRequired: true, ackToken: TOKEN, ...over,
});
// ⭐ THE BLOCKED CASE, exactly as depositDisclosure produces it: the vault's own verdict is WARN, so ackToken IS
// minted; the gate ADDED a block (asset mismatch), so ackRequired is false and it is not depositable.
const BLOCKED = disclosureOf({ gate: { level: "BLOCK", blocks: [{ code: "asset-mismatch", detail: "underlying is not USDC" }], warns: INSPECTION.verdict.warns },
  depositable: false, ackRequired: false, ackToken: TOKEN });

function operatorDeps({ disclosure = disclosureOf(), baselineOwner = VAULT_OWNER } = {}) {
  const calls = [];
  const store = fakeStore();
  const count = (name, fn) => async (...a) => { calls.push(name); return fn(...a); };
  let tokenGiven = null;
  const deps = {
    store,
    now: () => NOW, newId: () => "vm-op-1",
    ensureOwnerWallet: count("ensureOwnerWallet", async () => ({ walletAddress: WALLET })),
    resolveVault: (k) => (k === VAULT.key ? VAULT : null),
    depositDisclosure: count("depositDisclosure", async () => clone(disclosure)),
    readBaseline: count("readBaseline", async (vault, { holder, vaultAckToken }) => {
      tokenGiven = await vaultAckToken({ vault, holder });
      return { ok: true, owner: { address: baselineOwner, kind: "eoa" }, reportBlock: 990, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: tokenGiven };
    }),
    digestOf: disclosureDigest, tokenOf: ackTokenFor,
  };
  return { deps, calls, store, tokenGiven: () => tokenGiven };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — the operator list: T's login address only (T, 2026-09-27)");
{
  ok("operators.mjs exists", !OPS.__missing, OPS.__missing ?? "");
  const list = OPS.OPERATOR_MANDATE_OWNERS ?? [];
  ok("⭐ exactly ONE operator, T's login address (stored lowercase)", Array.isArray(list) && list.length === 1 && list[0] === T_ADDR.toLowerCase(), show(list));
  ok("the list is frozen", Object.isFrozen(list));
  const m = (a) => attempt(() => OPS.operatorMatch(a));
  ok("T's address matches, in any case", m(T_ADDR)?.match === true && m(T_ADDR.toLowerCase())?.match === true && m(T_ADDR.toUpperCase().replace("0X", "0x"))?.match === true, show(m(T_ADDR)));
  ok("a stranger does not; nor null, '', garbage, an address one character off", [STRANGER, null, "", "hello", T_ADDR.slice(0, -1) + "4"].every((a) => m(a)?.match === false));
  // ⭐ CONSTANT WORK: the check compares against EVERY entry, with the same-length compare, whatever it is given —
  // no early return on a hit or a malformed input — so the time taken does not depend on the address.
  const counts = [T_ADDR, STRANGER, null, "", "garbage", "0x" + "f".repeat(40)].map((a) => m(a)?.compared);
  ok("⭐⭐ the membership check does the SAME work for a member, a stranger and garbage (compares every entry)",
    counts.every((c) => c === list.length) && list.length > 0, JSON.stringify(counts));
  ok("  …and uses a timing-safe compare (source)", /timingSafeEqual/.test(OPS.__missing ? "" : readFileSync("shared/vault-mandate/operators.mjs", "utf8")));
  ok("isOperatorOwner agrees with operatorMatch", OPS.isOperatorOwner?.(T_ADDR) === true && OPS.isOperatorOwner?.(STRANGER) === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐⭐ THE SESSION GATE IS THE BOUNDARY: every unauthorised call is the SAME 403");
{
  ok("the handler module exists and exports makeOperatorHandler + handler", !H.__missing && typeof H.makeOperatorHandler === "function" && typeof H.handler === "function", H.__missing ?? "");
  let loads = 0;
  const probe = operatorDeps();
  const handler = H.makeOperatorHandler ? H.makeOperatorHandler(async () => { loads++; return probe.deps; }) : async () => ({ statusCode: 0, headers: {}, body: "" });
  const wrongSecret = (() => { const t = issueSession({ address: T_ADDR, method: "metamask" }).token; const [p] = t.split("."); return `${p}.${"A".repeat(43)}`; })();
  const expired = (() => { const p = Buffer.from(JSON.stringify({ sub: T_ADDR.toLowerCase(), method: "metamask", iat: 1, exp: 2 })).toString("base64url");
    const sig = createHash("sha256").update("x").digest("base64url"); return `${p}.${sig}`; })();
  const stranger = bearer(STRANGER);
  const cases = [
    ["no session, no body", ev()],
    ["no session, a create body", ev({ body: { op: "create", vault: "xylo-usdc", ...TERMS, rules: RULES } })],
    ["a garbage bearer token", ev({ headers: { authorization: "Bearer not-a-token" }, body: { op: "create" } })],
    ["⭐ T's address in a token signed with the WRONG secret", ev({ headers: { authorization: `Bearer ${wrongSecret}` }, body: { op: "create" } })],
    ["an expired / forged-signature token for T", ev({ headers: { authorization: `Bearer ${expired}` }, body: { op: "create" } })],
    ["⭐⭐ a VALID session for a non-operator, create", ev({ headers: stranger, body: { op: "create", vault: "xylo-usdc", ...TERMS, rules: RULES } })],
    ["⭐ a valid non-operator session, ack", ev({ headers: stranger, body: { op: "ack", id: "vm-op-1", fingerprint: "0".repeat(64) } })],
    ["a valid non-operator session, cancel", ev({ headers: stranger, body: { op: "cancel", id: "vm-op-1" } })],
    ["a valid non-operator session, an unknown op", ev({ headers: stranger, body: { op: "list" } })],
    ["a valid non-operator session, malformed JSON", ev({ headers: stranger, body: "{not json" })],
    ["⭐ a valid non-operator session, GET (the method is not checked before the gate)", ev({ headers: stranger, method: "GET" })],
    ["no session, OPTIONS", ev({ method: "OPTIONS" })],
  ];
  const results = [];
  for (const [label, e] of cases) results.push([label, await attemptAsync(() => handler(e))]);
  const first = results[0][1];
  // Each must BE the 403 (not merely equal to the first case, which a missing handler would satisfy vacuously).
  const same = (r) => r?.statusCode === 403 && typeof r?.body === "string" && r.body.length > 0 &&
    r?.statusCode === first?.statusCode && r?.body === first?.body && JSON.stringify(r?.headers) === JSON.stringify(first?.headers);
  ok("the reference refusal is a 403", first?.statusCode === 403, show(first));
  for (const [label, r] of results) ok(`${label} → the SAME 403 (status, headers, body byte-identical)`, same(r), show(r));
  ok("⭐⭐ …and NOT ONE unauthorised call loaded a dependency (no store, wallet, chain, or disclosure read)", loads === 0 && probe.calls.length === 0, `loads=${loads} calls=${probe.calls.join(",")}`);
  ok("  …the 403 body names nothing (no 'operator', no 'session', no 'list')", typeof first?.body === "string" && first.body.length > 0 && !/operator|session|list|owner/i.test(first.body), first?.body);

  // ⭐ The gate runs the membership check on EVERY call — no branch before it, one return after it — so a
  // missing session does not take a shorter path. (Pinned in the source: an injectable matcher on a security
  // gate would itself be a bypass seam.)
  const hsrc = H.__missing ? "" : readFileSync("netlify/functions/vault-mandate-operator.mjs", "utf8");
  const gateBody = (hsrc.match(/export function operatorGate\([^)]*\)\s*\{([\s\S]*?)\n\}/) ?? [])[1] ?? "";
  const matchAt = gateBody.search(/\b(isOperatorOwner|operatorMatch)\(/);
  // The statement itself is pinned: the check is the whole right-hand side, on `session?.address ?? null` — no
  // ternary, no `&&`, nothing that could skip it.
  ok("⭐ the gate calls the membership check unconditionally: `const x = isOperatorOwner(session?.address ?? null);`, no branch before it, one return",
    matchAt > 0 && /^\s*const \w+ = (isOperatorOwner|operatorMatch)\(session\?\.address \?\? null\)(\.match)?;\s*$/m.test(gateBody) &&
    !/\bif\s*\(|\breturn\b|\?\s|&&|\|\|/.test(gateBody.slice(0, matchAt).replace(/requireSession\(event\)/, "")) && (gateBody.match(/\breturn\b/g) ?? []).length === 1,
    gateBody.trim().replace(/\s+/g, " ").slice(0, 160));

  // Authorised: T. The method check comes AFTER the gate.
  const t = operatorDeps(); let tl = 0;
  const th = H.makeOperatorHandler ? H.makeOperatorHandler(async () => { tl++; return t.deps; }) : null;
  const g = th ? await attemptAsync(() => th(ev({ headers: bearer(T_ADDR), method: "GET" }))) : null;
  ok("T with GET → 405 (only an authorised caller learns the method rule)", g?.statusCode === 405, show(g));
  const u = th ? await attemptAsync(() => th(ev({ headers: bearer(T_ADDR), body: { op: "list" } }))) : null;
  ok("T with an unknown op → 400, nothing written", u?.statusCode === 400 && t.store._map.size === 0, show(u));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ the vault ack token: ONLY when ackRequired === true");
{
  const f = CHK.vaultAckFromDisclosure;
  ok("vaultAckFromDisclosure is exported from _vault-mandate-check.mjs", typeof f === "function");
  const r = (d) => (typeof f === "function" ? attempt(() => f(d, { digestOf: disclosureDigest, tokenOf: ackTokenFor })) : null);
  const good = r(disclosureOf());
  ok("WARN, ackRequired, depositable → the token", good?.ok === true && good?.token === TOKEN, show(good));
  ok("  …with the disclosure BEHIND it: level, warns, holder, both fees, and the digest the token hashes",
    good?.disclosure?.level === "WARN" && good?.disclosure?.warns?.length === 2 && good?.disclosure?.holder === VAULT_OWNER &&
    good?.disclosure?.withdrawFeeBps === 10 && good?.disclosure?.depositFeeBps === 0 && typeof good?.disclosure?.digest === "string", show(good?.disclosure));
  ok("  …and the digest really is what the token hashes (sha256(digest) === token)", good?.disclosure?.digest && createHash("sha256").update(good.disclosure.digest).digest("hex") === TOKEN);
  const b = r(BLOCKED);
  ok("⭐⭐ BLOCKED by the gate, with an ackToken MINTED beside it → REFUSED, and the token is NOT returned",
    b?.ok === false && b?.token === undefined && BLOCKED.ackToken === TOKEN, show(b));
  ok("  …the refusal names the block", /asset-mismatch|block/i.test(b?.why ?? ""), b?.why);
  ok("  …and still carries the disclosure, so the operator sees WHY", b?.disclosure?.level === "BLOCK" && b?.disclosure?.blocks?.length === 1, show(b?.disclosure));
  ok("ackRequired false for any other reason → refused", r(disclosureOf({ ackRequired: false }))?.ok === false);
  ok("ackRequired as a truthy non-boolean ('true') → refused (=== true only)", r(disclosureOf({ ackRequired: "true" }))?.ok === false);
  ok("not depositable → refused, even with ackRequired true", r(disclosureOf({ depositable: false }))?.ok === false);
  ok("⭐ an OK vault (no warnings) has no token → refused, and says a mandate's baseline needs one", /no acknowledg|no token|requires/i.test(r(disclosureOf({ gate: { level: "OK", blocks: [], warns: [] }, ackRequired: false, ackToken: null }))?.why ?? ""));
  ok("⭐ a token that is NOT sha256 of the inspection shown → refused (shown ≠ stored)", r(disclosureOf({ ackToken: "cd".repeat(32) }))?.ok === false);
  ok("a malformed token → refused", r(disclosureOf({ ackToken: "zz" }))?.ok === false);
  ok("no disclosure at all → refused", r(null)?.ok === false && r(undefined)?.ok === false);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — create (T): origin operator, awaiting ack, the response SHOWS what the token stands for");
{
  const t = operatorDeps();
  const h = H.makeOperatorHandler ? H.makeOperatorHandler(async () => t.deps) : null;
  const res = h ? await attemptAsync(() => h(ev({ headers: bearer(T_ADDR), body: { op: "create", vault: "xylo-usdc", ...TERMS, rules: RULES } }))) : null;
  const body = res?.body ? JSON.parse(res.body) : null;
  const stored = t.store._map.get(vaultMandateKey(T_ADDR, "vm-op-1"))?.data;
  ok("201, one record written", res?.statusCode === 201 && t.store._map.size === 1, show(res));
  ok("⭐ the record: origin operator, owned by T's SESSION address, awaiting acknowledgement",
    stored?.origin === "operator" && stored?.owner === T_ADDR.toLowerCase() && stored?.status === "awaiting-ack" && stored?.ack === null, show({ o: stored?.origin, s: stored?.status }));
  ok("  …consistent (verify ok), cannot deposit yet", verifyMandateRecord(stored)?.ok === true && verifyMandateRecord(stored)?.mayDeposit === false);
  ok("⭐⭐ the token baked into the baseline is EXACTLY the one whose disclosure was shown", stored?.baseline?.vaultAckToken === TOKEN && t.tokenGiven() === TOKEN && body?.vaultDisclosure?.token === TOKEN);
  ok("⭐⭐ the response shows the VAULT disclosure behind it: level, warns, holder, fees, digest",
    body?.vaultDisclosure?.level === "WARN" && body?.vaultDisclosure?.warns?.length === 2 && body?.vaultDisclosure?.holder === VAULT_OWNER &&
    body?.vaultDisclosure?.withdrawFeeBps === 10 && typeof body?.vaultDisclosure?.digest === "string", show(body?.vaultDisclosure));
  ok("  …and the MANDATE disclosure text + rule lines + the fingerprint to acknowledge",
    body?.disclosure?.text === stored?.disclosure?.text && body?.disclosure?.ruleLines?.length === 2 && body?.fingerprint === stored?.fingerprint, show(Object.keys(body ?? {})));
  ok("  …and says the fingerprint covers the vault disclosure (the ack token is inside it)", /fingerprint/i.test(body?.acknowledge ?? "") && /vault/i.test(body?.acknowledge ?? ""), body?.acknowledge);
  ok("the order: wallet → disclosure → baseline (the disclosure is read BEFORE anything is signed)",
    JSON.stringify(t.calls) === JSON.stringify(["ensureOwnerWallet", "depositDisclosure", "readBaseline"]), t.calls.join(" → "));

  const bl = operatorDeps({ disclosure: BLOCKED });
  const hb = H.makeOperatorHandler ? H.makeOperatorHandler(async () => bl.deps) : null;
  const rb = hb ? await attemptAsync(() => hb(ev({ headers: bearer(T_ADDR), body: { op: "create", vault: "xylo-usdc", ...TERMS, rules: RULES } }))) : null;
  const bb = rb?.body ? JSON.parse(rb.body) : null;
  ok("⭐⭐ a BLOCKED vault → refused (409), NOTHING written", rb?.statusCode === 409 && bl.store._map.size === 0, show(rb));
  ok("  …the baseline was never read (no signature spent on a vault that cannot be deposited into)", !bl.calls.includes("readBaseline"), bl.calls.join(","));
  ok("  …the refusal shows the blocked disclosure and carries NO token", bb?.vaultDisclosure?.level === "BLOCK" && !JSON.stringify(bb ?? {}).includes(TOKEN), show(bb));

  const x = operatorDeps();
  const hx = H.makeOperatorHandler ? H.makeOperatorHandler(async () => x.deps) : null;
  const ro = hx ? await attemptAsync(() => hx(ev({ headers: bearer(T_ADDR), body: { op: "create", vault: "xylo-usdc", ...TERMS, rules: RULES, origin: "user" } }))) : null;
  ok("⭐ an `origin` in the body → refused, nothing written (the path sets it; the body never does)", ro?.statusCode === 400 && x.store._map.size === 0, show(ro));
  const rw = hx ? await attemptAsync(() => hx(ev({ headers: bearer(T_ADDR), body: { op: "create", vault: "xylo-usdc", ...TERMS, rules: RULES, owner: STRANGER } }))) : null;
  ok("⭐ an `owner` in the body → refused, nothing written (never on behalf of anyone)", rw?.statusCode === 400 && x.store._map.size === 0, show(rw));
  const re = hx ? await attemptAsync(() => hx(ev({ headers: bearer(T_ADDR), body: { op: "create", vault: "xylo-usdc", ...TERMS, rules: [{ kind: "power", subject: "upgradeable", onFinding: "exit" }] } }))) : null;
  ok("an EXIT rule → refused (EXIT_AVAILABLE is false; the operator exception is deferred to piece 5)", re?.statusCode === 400 && x.store._map.size === 0 && /exit/i.test(re?.body ?? ""), show(re));
  // The wallet: the canonical refusals (test:ub's pattern), and an UNTAGGED throw never borrows them.
  const wcall = async (walletImpl) => {
    const w = operatorDeps(); w.deps.ensureOwnerWallet = walletImpl;
    const hw = H.makeOperatorHandler ? H.makeOperatorHandler(async () => w.deps) : null;
    return { w, r: hw ? await attemptAsync(() => hw(ev({ headers: bearer(T_ADDR), body: { op: "create", vault: "xylo-usdc", ...TERMS, rules: RULES } }))) : null };
  };
  const tagged = await wcall(async () => { throw Object.assign(new Error("circle 503"), { name: "WalletUnresolvable" }); });
  ok("a tagged unresolvable wallet → 503 wallet-unresolvable (retryable), nothing written", tagged.r?.statusCode === 503 && /wallet-unresolvable/.test(tagged.r?.body ?? "") && tagged.w.store._map.size === 0, show(tagged.r));
  const pend = await wcall(async () => ({ pending: true }));
  ok("a wallet still provisioning → 503 wallet-provisioning, nothing read or written", pend.r?.statusCode === 503 && /wallet-provisioning/.test(pend.r?.body ?? "") && !pend.w.calls.includes("depositDisclosure"), show(pend.r));
  const bug = await wcall(async () => { throw new TypeError("x is undefined"); });
  ok("⭐ an UNTAGGED throw (a bug) → 500, never dressed as 'temporary, retry'", bug.r?.statusCode === 500 && !/wallet-unresolvable|wallet-provisioning/.test(bug.r?.body ?? ""), show(bug.r));

  const y = operatorDeps();
  const hy = H.makeOperatorHandler ? H.makeOperatorHandler(async () => y.deps) : null;
  const rv = hy ? await attemptAsync(() => hy(ev({ headers: bearer(T_ADDR), body: { op: "create", vault: "not-a-vault", ...TERMS, rules: RULES } }))) : null;
  ok("a vault off the allowlist → 400 before any read", rv?.statusCode === 400 && y.calls.length === 0 && y.store._map.size === 0, show({ s: rv?.statusCode, calls: y.calls }));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("5 — acknowledge and cancel (T), and only operator mandates");
{
  const t = operatorDeps();
  const h = H.makeOperatorHandler ? H.makeOperatorHandler(async () => t.deps) : null;
  const call = (body) => (h ? attemptAsync(() => h(ev({ headers: bearer(T_ADDR), body }))) : null);
  const c = await call({ op: "create", vault: "xylo-usdc", ...TERMS, rules: RULES });
  const fp = c?.body ? JSON.parse(c.body).fingerprint : null;
  const bad = await call({ op: "ack", id: "vm-op-1", fingerprint: "0".repeat(64) });
  ok("ack with the wrong fingerprint → refused, still awaiting", bad?.statusCode === 409 && t.store._map.get(vaultMandateKey(T_ADDR, "vm-op-1"))?.data?.status === "awaiting-ack", show(bad));
  const a = await call({ op: "ack", id: "vm-op-1", fingerprint: fp });
  const st = t.store._map.get(vaultMandateKey(T_ADDR, "vm-op-1"))?.data;
  ok("ack with the fingerprint shown → ACTIVE, may deposit (the tick's arming constants still decide what it does)", a?.statusCode === 200 && st?.status === "active" && verifyMandateRecord(st)?.mayDeposit === true, show(a));
  const k = await call({ op: "cancel", id: "vm-op-1" });
  const ck = t.store._map.get(vaultMandateKey(T_ADDR, "vm-op-1"))?.data;
  ok("⭐ cancel → status cancelled (terminal): neither deposit nor monitor; the record is KEPT (audit trail)",
    k?.statusCode === 200 && ck?.status === "cancelled" && typeof ck?.cancelledAt === "string" && verifyMandateRecord(ck)?.mayDeposit === false && verifyMandateRecord(ck)?.mayMonitor === false, show(k));
  const k2 = await call({ op: "cancel", id: "vm-op-1" });
  ok("cancelling twice → refused", k2?.statusCode === 409, show(k2));
  const na = await call({ op: "ack", id: "no-such", fingerprint: fp });
  ok("ack of a mandate that does not exist → 404", na?.statusCode === 404, show(na));

  // A USER-origin mandate owned by T (made by piece 6, one day) is not the operator path's to acknowledge or cancel.
  const u = buildMandateRecord({ owner: T_ADDR, walletAddress: WALLET, vault: VAULT, terms: TERMS, rules: RULES, now: NOW, id: "vm-user",
    baseline: { ok: true, owner: { address: VAULT_OWNER, kind: "eoa" }, reportBlock: 990, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: TOKEN } });
  await t.store.setJSON(vaultMandateKey(T_ADDR, "vm-user"), u.record, { onlyIfNew: true });
  const ua = await call({ op: "ack", id: "vm-user", fingerprint: u.record?.fingerprint });
  ok("⭐ acknowledging a USER-origin mandate through the operator path → refused", ua?.statusCode === 409 && t.store._map.get(vaultMandateKey(T_ADDR, "vm-user"))?.data?.status === "awaiting-ack", show(ua));
  const uc = await call({ op: "cancel", id: "vm-user" });
  ok("⭐ cancelling a USER-origin mandate through the operator path → refused", uc?.statusCode === 409 && t.store._map.get(vaultMandateKey(T_ADDR, "vm-user"))?.data?.status === "awaiting-ack", show(uc));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⭐⭐ the record refuses an operator origin whose owner is not an operator");
{
  const base = { walletAddress: WALLET, vault: VAULT, terms: TERMS, rules: RULES, now: NOW, id: "vm-x",
    baseline: { ok: true, owner: { address: VAULT_OWNER, kind: "eoa" }, reportBlock: 990, reportSigned: true, signerVerified: true, maxFeeBps: 2000, vaultAckToken: TOKEN } };
  const s = attempt(() => buildMandateRecord({ ...base, owner: STRANGER, origin: "operator" }));
  ok("building origin operator for a stranger → refused", s?.ok === false && /operator/i.test((s?.errors ?? []).join(" ")), show(s));
  const tb = attempt(() => buildMandateRecord({ ...base, owner: T_ADDR, origin: "operator" }));
  ok("building origin operator for T → ok", tb?.ok === true, show(tb?.errors));
  // A stranger's user mandate, rewritten CONSISTENTLY to say operator (fingerprint recomputed, even re-acknowledged):
  const u = buildMandateRecord({ ...base, owner: STRANGER }).record;
  const forged = clone(u); forged.origin = "operator"; forged.disclosure = renderDisclosure(forged); forged.fingerprint = mandateFingerprint(forged);
  forged.status = "active"; forged.ack = { fingerprint: forged.fingerprint, at: new Date(NOW).toISOString() };
  const v = verifyMandateRecord(forged);
  ok("⭐⭐ a store-forged operator record for a stranger, even re-fingerprinted and re-acked → INCONSISTENT, cannot act",
    v?.ok === false && v?.mayDeposit === false && v?.mayMonitor === false && /operator/i.test((v?.errors ?? []).join(" ")), show(v?.errors));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("7 — what it must NOT be: no route, no UI, no arming");
{
  const toml = readFileSync("netlify.toml", "utf8");
  ok("⭐ no /api route points at vault-mandate-operator (and none may)", !/vault-mandate-operator/.test(toml));
  const ui = (() => { try { return String(execSync("git grep -l vault-mandate-operator -- src", { stdio: ["ignore", "pipe", "ignore"] })).trim(); } catch { return ""; } })();
  ok("no front-end file mentions it", ui === "", ui);
  const h = H.__missing ? "" : readFileSync("netlify/functions/vault-mandate-operator.mjs", "utf8");
  ok("the handler never reaches the executor or the deposit path", h !== "" && !/executeAction|depositForMandate|runMandateTick|vaultDeposit/.test(h));
  ok("the handler passes no test seam (exitAvailable / config)", h !== "" && !/\bexitAvailable\b|\bconfig\s*:/.test(h));
  ok("⭐ the gate runs before the method check, the body parse and any dependency (source order)", (() => {
    const gate = h.indexOf("operatorGate("), meth = h.indexOf("httpMethod"), parse = h.indexOf("JSON.parse"), load = h.indexOf("loadDeps(");
    return gate > 0 && [meth, parse, load].every((i) => i > gate);
  })());
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
