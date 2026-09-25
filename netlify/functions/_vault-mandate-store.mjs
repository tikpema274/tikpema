// _vault-mandate-store.mjs — the vault mandate, persisted. Transport + the create core.
//
// ⭐ PURE LOGIC LIVES IN shared/vault-mandate/record.mjs. This file writes, reads and CASes records,
// and never decides what a record means: every write and every read runs verifyMandateRecord.
//
// ⚠️ THE STORE IS PASSED IN (`store`), so the suite drives these functions against an in-memory store
// with @netlify/blobs' onlyIfNew / onlyIfMatch semantics. Callers pass getStore(VAULT_MANDATE_STORE).
//
// ⭐ THE RULES THIS FILE HOLDS:
//   · WRITE-TIME VALIDATION. A new record is re-verified before it is written, so "exit" on a
//     pause-only rule, or a disclosure that does not match its rules, never reaches the store.
//   · A NEW RECORD IS NEVER ACTIVE. It is written awaiting acknowledgement; only
//     acknowledgeStoredMandate activates it, under CAS on the etag it read.
//   · RE-VERIFIED ON READ, not trusted because it was checked on write. A record changed in the store
//     after its acknowledgement reads back as unable to act.
//   · UNREADABLE IS NOT ABSENT. A store failure returns readable:false, never "no mandate".
//   · OWNER = THE SESSION. Keyed by the session address; an owner in the request body is refused.
//
// ⚠️ NO HTTP ENDPOINT YET, DELIBERATELY. createVaultMandate needs `readBaseline` — the signed DD report
// with a verified signer, the owner and the fee cap — which is the transport piece. An endpoint without
// it would be a create path with nothing to record the baseline from.

export const VAULT_MANDATE_STORE = "vault-mandates";
export const vaultMandateKey = (owner, id) => `m/${String(owner).toLowerCase()}/${id}`;

import {
  buildMandateRecord, verifyMandateRecord, acknowledgeMandate, MANDATE_STATUS,
} from "../../shared/vault-mandate/record.mjs";

// 🚨 STRONG, as for the policy store: a mandate is a SAFETY input. A CDN-cached copy could let a
// record the user just changed act on the rules it replaced.
const READ_CONSISTENCY = "strong";
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

/** Write a NEW record: verified, awaiting acknowledgement, never overwriting. */
export async function writeNewMandate({ store, record }) {
  const v = verifyMandateRecord(record);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (record.status !== MANDATE_STATUS.AWAITING_ACK || record.ack !== null) {
    return { ok: false, errors: ["a new mandate is written awaiting acknowledgement; it is activated only by acknowledging it"] };
  }
  let res;
  try { res = await store.setJSON(vaultMandateKey(record.owner, record.id), record, { onlyIfNew: true }); }
  catch (e) { return { ok: false, errors: [`mandate store unwritable: ${String(e?.message ?? e)}`] }; }
  if (res?.modified === false) return { ok: false, errors: [`a mandate with id ${record.id} already exists`] };
  return { ok: true, key: vaultMandateKey(record.owner, record.id) };
}

/** @returns {{readable:boolean, record:object|null, etag:string|null, verdict:object|null, errors:string[]}} */
export async function readMandate({ store, owner, id }) {
  let res;
  try { res = await store.getWithMetadata(vaultMandateKey(owner, id), { type: "json", consistency: READ_CONSISTENCY }); }
  catch (e) { return { readable: false, record: null, etag: null, verdict: null, errors: [`mandate store unreadable: ${String(e?.message ?? e)}`] }; }
  if (!res || res.data === null || res.data === undefined) return { readable: true, record: null, etag: null, verdict: null, errors: [] };
  const record = res.data;
  const verdict = verifyMandateRecord(record);
  // The key is owner-scoped; a record naming another owner under this key is corrupt, not someone else's.
  if (String(record.owner ?? "").toLowerCase() !== String(owner).toLowerCase()) {
    return { readable: true, record, etag: res.etag ?? null, verdict: { ...verdict, ok: false, mayAct: false, errors: [...verdict.errors, "the record names a different owner than its key"] }, errors: [] };
  }
  return { readable: true, record, etag: res.etag ?? null, verdict, errors: [] };
}

/** Activate a stored record with the fingerprint the user was shown. CAS on the etag just read. */
export async function acknowledgeStoredMandate({ store, owner, id, fingerprint, now }) {
  const r = await readMandate({ store, owner, id });
  if (!r.readable) return { ok: false, errors: r.errors };
  if (!r.record) return { ok: false, errors: ["no such mandate"] };
  if (!r.etag) return { ok: false, errors: ["the mandate was read without an etag, so it cannot be updated safely"] };
  const a = acknowledgeMandate(r.record, fingerprint, now);
  if (!a.ok) return a;
  let res;
  try { res = await store.setJSON(vaultMandateKey(owner, id), a.record, { onlyIfMatch: r.etag }); }
  catch (e) { return { ok: false, errors: [`mandate store unwritable: ${String(e?.message ?? e)}`] }; }
  if (res?.modified === false) return { ok: false, errors: ["the mandate changed while it was being acknowledged; review it again"] };
  return { ok: true, record: a.record };
}

const CREATE_INPUT_FIELDS = new Set(["vault", "rules"]);

/**
 * Create under a verified session. `deps`: store, now(), newId(), resolveVault(key) (the allowlist),
 * readBaseline(vault) (the transport: signed report + verified signer + owner + fee cap).
 * @returns {{ok:true, record, fingerprint} | {ok:false, errors:string[]}}
 */
export async function createVaultMandate({ session, walletAddress, input, deps }) {
  if (!isAddr(session?.address)) return { ok: false, errors: ["authentication required"] };
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["the request body must be an object"] };
  const extra = Object.keys(input).filter((k) => !CREATE_INPUT_FIELDS.has(k));
  if (extra.length) return { ok: false, errors: [`field(s) ${extra.join(", ")} cannot be sent; the owner is the signed-in session`] };
  const vault = deps.resolveVault(input.vault);
  if (!vault) return { ok: false, errors: [`vault ${JSON.stringify(input.vault)} is not on the allowlist`] };

  let baseline;
  try { baseline = await deps.readBaseline(vault); }
  catch (e) { baseline = { ok: false, why: String(e?.message ?? e) }; }

  const built = buildMandateRecord({
    owner: session.address, walletAddress, vault, rules: input.rules, baseline, now: deps.now(), id: deps.newId(),
  });
  if (!built.ok) return built;
  const w = await writeNewMandate({ store: deps.store, record: built.record });
  if (!w.ok) return w;
  return { ok: true, record: built.record, fingerprint: built.record.fingerprint };
}
