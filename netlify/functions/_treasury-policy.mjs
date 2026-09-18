// _treasury-policy.mjs — the owner's treasury targets, persisted. Transport only; the document logic
// is shared/treasury/plan.mjs (normalizeTreasuryPolicy). A SIBLING of _policy-store.mjs, not a new
// document type inside it: that normalizer rejects unknown shapes by design.
//
// ⚠️ ONE RECORD PER OWNER, keyed by the SESSION ADDRESS — never by anything from a request body.
// 🚨 STRONG reads: targets are an input to money PROPOSALS a user then confirms; a CDN-cached older
// policy would size a move from targets the user has already replaced.
import { getStore } from "@netlify/blobs";
import { normalizeTreasuryPolicy } from "../../shared/treasury/plan.mjs";
import { DESTINATION_CHAINS } from "./_receipt.mjs";

export const TREASURY_POLICY_STORE = "treasury-policy";
export const policyKey = (owner) => `o/${String(owner).toLowerCase()}`;
export const ALLOWED_DEST_CHAINS = Object.keys(DESTINATION_CHAINS);
const READ_CONSISTENCY = "strong";

/** @returns {{ policy, readable, storedAt, error? }} — `readable:false` is a STORE failure, not "no policy". */
export async function readTreasuryPolicy(owner, s) {
  let raw;
  try { raw = await (s ?? getStore(TREASURY_POLICY_STORE)).get(policyKey(owner), { type: "json", consistency: READ_CONSISTENCY }); }
  catch (e) { return { policy: null, readable: false, storedAt: null, error: `treasury policy store unreadable: ${e?.message ?? e}` }; }
  if (!raw) return { policy: null, readable: true, storedAt: null };
  const n = normalizeTreasuryPolicy(raw.policy ?? raw, { allowedChains: ALLOWED_DEST_CHAINS });
  if (n.error) return { policy: null, readable: true, storedAt: raw.storedAt ?? null, error: `stored policy invalid: ${n.error}` };
  return { policy: n.policy, readable: true, storedAt: raw.storedAt ?? null };
}

/** Validate then write. Returns { ok, policy } or { ok:false, error }. */
export async function writeTreasuryPolicy(owner, rawPolicy, s, now = new Date()) {
  const n = normalizeTreasuryPolicy(rawPolicy, { allowedChains: ALLOWED_DEST_CHAINS });
  if (n.error) return { ok: false, error: n.error };
  // ⭐ STORE THE CANONICAL FIELDS ONLY. `unallocatedPct` is DERIVED by the normalizer; storing it made the
  // stored document fail its own re-validation on the next read ("unknown policy field") — the suite
  // caught it. A derived field is recomputed, never persisted.
  const { version, targets, minMoveUsdc } = n.policy;
  try { await (s ?? getStore(TREASURY_POLICY_STORE)).setJSON(policyKey(owner), { policy: { version, targets, minMoveUsdc }, storedAt: now.toISOString() }); }
  catch (e) { return { ok: false, error: `treasury policy store write failed: ${e?.message ?? e}` }; }
  return { ok: true, policy: n.policy };
}

export async function clearTreasuryPolicy(owner, s) {
  try { await (s ?? getStore(TREASURY_POLICY_STORE)).delete(policyKey(owner)); return { ok: true }; }
  catch (e) { return { ok: false, error: `treasury policy store delete failed: ${e?.message ?? e}` }; }
}
