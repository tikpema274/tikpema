// vault-mandate-operator.mjs — STEP 0: the OPERATOR-ONLY vault mandate path. create · ack · cancel, for the
// operator's OWN agent wallet. Design: PROGRESS.md 2026-09-27, "OPERATOR-ONLY CREATION — SCOPE" + T's decisions.
// It exists so a real mandate can sit in the production store and the DEPLOYED, DISARMED tick can run it:
// signing latency (→ the freshness window and the fee), how often the two endpoints disagree, WOULD DEPOSIT
// receipts. It moves no money and arms nothing: the tick's shipped constants decide what a mandate may do.
//
// ═══ 🚨 THE SESSION GATE IS THE BOUNDARY — NOT THE ABSENCE OF A ROUTE ═══════════════════════════════
// There is no /api route and no UI link, and that protects NOTHING: every file here is served at
// /.netlify/functions/<name>. So the FIRST thing the handler does, before it looks at the method, the body or
// any dependency, is the gate: a valid session whose address is in OPERATOR_MANDATE_OWNERS
// (shared/vault-mandate/operators.mjs, T's login address only). Every other caller — no session, a forged or
// expired token, a valid session that is not an operator, any method, any body — gets the SAME 403, byte for
// byte, and nothing is read or loaded: no store, no wallet, no chain. The membership check does constant work
// for any address (operators.mjs). test:mandateoperator §2 asserts all of it.
//
// ═══ 🚨 THE VAULT ACK TOKEN COMES ONLY FROM ackRequired === true ═══════════════════════════════════
// depositDisclosure mints ackToken on the vault's own WARN even when the gate added a BLOCK. The token is taken
// through vaultAckFromDisclosure (_vault-mandate-check.mjs), which refuses anything but ackRequired === true
// on a depositable, unblocked vault, and checks the token is the one for the inspection SHOWN. That exact token
// is handed to readBaseline, so the token in the stored mandate is the token whose disclosure the create
// response shows. A blocked vault is refused BEFORE the baseline is read: no signature is spent on it.
//
// ═══ WHAT IT IS NOT ═════════════════════════════════════════════════════════════════════════════════
// Not user-facing (piece 6 is). Never on behalf of anyone: the owner is the SESSION, the wallet is the
// session's; an owner or origin in the body is refused by the create core. Not a bypass: the same record
// builder, limits, signed baseline and write-time verification; a new mandate is written awaiting-ack and acts
// only after the operator acknowledges the fingerprint they were shown. It acknowledges and cancels only
// OPERATOR-origin mandates. It never reaches the executor. Exit rules stay refused (EXIT_AVAILABLE; the operator
// exception is deferred to piece 5). The ONE file allowed to write origin "operator" (test:mandaterecord).

import { randomUUID } from "node:crypto";
import { requireSession } from "./_auth.mjs";
import { json } from "./_arc.mjs";
import { WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { isOperatorOwner } from "../../shared/vault-mandate/operators.mjs";
import { MANDATE_ORIGIN, cancelMandate, preflightMandateInput } from "../../shared/vault-mandate/record.mjs";
import { createVaultMandate, readMandate, acknowledgeStoredMandate, updateStoredMandate, VAULT_MANDATE_STORE } from "./_vault-mandate-store.mjs";
import { vaultAckFromDisclosure } from "./_vault-mandate-check.mjs";

/**
 * The gate. Returns the session only for an operator; null for EVERY other caller. The membership check runs
 * whether or not there is a session, with the same constant work, so no branch here depends on the list.
 */
export function operatorGate(event) {
  const session = requireSession(event);
  const operator = isOperatorOwner(session?.address ?? null);
  return session && operator ? session : null;
}

/** The one refusal every unauthorised caller receives. It names nothing. */
const denied = () => json(403, { error: "forbidden" });

const OPS = new Set(["create", "ack", "cancel"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** @param {(event) => Promise<object>} loadDeps  called only AFTER the gate has admitted an operator */
export function makeOperatorHandler(loadDeps) {
  return async function operatorHandler(event) {
    // ⭐ THE GATE FIRST: before the method, the body, or any dependency.
    const session = operatorGate(event);
    if (!session) return denied();

    if (event?.httpMethod !== "POST") return json(405, { error: "POST only" });
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "the body is not JSON" }); }
    if (!isObj(body)) return json(400, { error: "the body must be an object" });
    const { op, ...rest } = body;
    if (!OPS.has(op)) return json(400, { error: `unknown op ${JSON.stringify(op)}; expected one of ${[...OPS].join(", ")}` });

    const deps = await loadDeps(event);
    try {
      if (op === "create") return await create({ session, input: rest, deps });
      if (op === "ack") return await acknowledge({ session, input: rest, deps });
      return await cancel({ session, input: rest, deps });
    } catch (e) {
      return json(500, { error: `the ${op} did not complete: ${String(e?.message ?? e)}` });
    }
  };
}

async function create({ session, input, deps }) {
  // ⭐ THE PREFLIGHT FIRST: a body creation would refuse (an exit rule, bad terms, an unknown field) is refused here,
  // before the wallet, the disclosure, or the baseline (which signs) — nothing read, nothing spent. The same function
  // the create core runs; not a copy of its rules.
  const pre = preflightMandateInput({ owner: session.address, origin: MANDATE_ORIGIN.OPERATOR, input });
  if (!pre.ok) return json(400, { error: pre.errors.join("; "), errors: pre.errors });
  const vault = deps.resolveVault(input.vault);
  if (!vault) return json(400, { error: `vault ${JSON.stringify(input.vault)} is not on the allowlist` });

  const { ensureOwnerWallet } = deps; // bound so the scoped try below reads exactly as test:ub pins it
  let wallet;
  // ⭐ The canonical pattern (agent-vault-withdraw): ONLY the tagged external failure earns the retryable refusal;
  // anything else re-throws and surfaces unclaimed, rather than borrowing a "temporary, please retry" it cannot honour.
  try { wallet = await ensureOwnerWallet(session); }
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }
  if (wallet?.pending) return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  if (!wallet?.walletAddress) return json(409, { error: "the agent wallet resolved with no address" });
  const walletAddress = wallet.walletAddress;

  // The vault disclosure, read BEFORE anything is signed; its token only through vaultAckFromDisclosure.
  let disclosure;
  try { disclosure = await deps.depositDisclosure({ vault, owner: walletAddress }); }
  catch (e) { return json(502, { error: `the vault's disclosure could not be read: ${String(e?.message ?? e)}` }); }
  const ack = vaultAckFromDisclosure(disclosure, { digestOf: deps.digestOf, tokenOf: deps.tokenOf });
  if (!ack.ok) return json(409, { error: ack.why, vaultDisclosure: ack.disclosure });

  const res = await createVaultMandate({
    session, walletAddress, input, origin: MANDATE_ORIGIN.OPERATOR,
    deps: {
      store: deps.store, now: deps.now, newId: deps.newId, resolveVault: deps.resolveVault,
      // ⭐ The EXACT token whose disclosure is shown below — never one re-read later.
      readBaseline: (v) => deps.readBaseline(v, { holder: walletAddress, vaultAckToken: async () => ack.token }),
    },
  });
  if (!res.ok) return json(400, { error: res.errors.join("; "), errors: res.errors, vaultDisclosure: ack.disclosure });
  const rec = res.record;
  if (rec.baseline?.vaultAckToken !== ack.token) {
    // Cannot happen through readBaseline as wired; if it ever does, the operator must not acknowledge this record.
    return json(500, { error: "the stored vault token differs from the one shown — do NOT acknowledge; cancel this mandate", id: rec.id });
  }
  return json(201, {
    ok: true, id: rec.id, origin: rec.origin, status: rec.status, fingerprint: rec.fingerprint,
    disclosure: { text: rec.disclosure.text, ruleLines: rec.disclosure.ruleLines },
    vaultDisclosure: ack.disclosure,
    acknowledge: "Read BOTH disclosures. The fingerprint covers the mandate's rules and text AND the vault disclosure " +
      "(its token, sha256 of the digest shown). To acknowledge, send {op:\"ack\", id, fingerprint}.",
    record: rec,
  });
}

/** Read a mandate the operator path may touch: the session's own, and OPERATOR-origin only. */
async function readOperatorMandate({ session, id, deps }) {
  if (typeof id !== "string" || !id) return { res: json(400, { error: "an id is required" }) };
  const r = await readMandate({ store: deps.store, owner: session.address, id });
  if (!r.readable) return { res: json(503, { error: r.errors.join("; ") }) };
  if (!r.record) return { res: json(404, { error: "no such mandate" }) };
  if (r.record.origin !== MANDATE_ORIGIN.OPERATOR) return { res: json(409, { error: "this mandate was not made through the operator path" }) };
  return { r };
}

async function acknowledge({ session, input, deps }) {
  const { r, res } = await readOperatorMandate({ session, id: input.id, deps });
  if (res) return res;
  const a = await acknowledgeStoredMandate({ store: deps.store, owner: session.address, id: r.record.id, fingerprint: input.fingerprint, now: deps.now() });
  if (!a.ok) return json(409, { error: a.errors.join("; ") });
  return json(200, { ok: true, id: a.record.id, status: a.record.status });
}

async function cancel({ session, input, deps }) {
  const { r, res } = await readOperatorMandate({ session, id: input.id, deps });
  if (res) return res;
  const c = cancelMandate(r.record, deps.now());
  if (!c.ok) return json(409, { error: c.errors.join("; ") });
  const w = await updateStoredMandate({ store: deps.store, owner: session.address, id: r.record.id, record: c.record, etag: r.etag });
  if (!w.ok) return json(409, { error: (w.errors ?? []).join("; ") || "the mandate could not be written" });
  return json(200, { ok: true, id: c.record.id, status: c.record.status });
}

// ═══ PRODUCTION WIRING — loaded only after the gate admits an operator ═════════════════════════════
async function productionDeps(event) {
  const [{ getStore }, { connectBlobs }, wallets, vaultMod, disc, check, rungs] = await Promise.all([
    import("@netlify/blobs"), import("./_blobs.mjs"), import("./_agent-wallets.mjs"), import("./_vault.mjs"),
    import("./_vault-disclosure.mjs"), import("./_vault-mandate-check.mjs"), import("./_dd-rungs.mjs"),
  ]);
  if (event?.blobs) connectBlobs(event);
  return {
    store: getStore(VAULT_MANDATE_STORE),
    now: () => Date.now(), newId: () => randomUUID(),
    ensureOwnerWallet: (s) => wallets.ensureOwnerWallet(s),
    resolveVault: vaultMod.resolveVault,
    depositDisclosure: ({ vault, owner }) => disc.depositDisclosure({ vault, owner, event }),
    readBaseline: (v, { holder, vaultAckToken }) => check.readBaseline(v,
      check.productionDeps({ health: () => rungs.healthDisclosure(event ?? { headers: {} }), resolveVault: vaultMod.resolveVault, vaultAckToken }),
      { holder }),
    digestOf: vaultMod.disclosureDigest, tokenOf: vaultMod.ackTokenFor,
  };
}

export const handler = makeOperatorHandler(productionDeps);
