// _policy-store.mjs — the owner's standing policy, persisted. Transport only.
//
// ⭐ PURE LOGIC LIVES IN shared/onchain-analyze/policy-doc.mjs. This file opens the connection and
// nothing else, the same split the rest of this subsystem runs on.
//
// ⚠️ ONE RECORD PER OWNER, keyed by the SESSION ADDRESS — never by anything from a request body.
// The owner is `session.address`, which the caller cannot choose. A policy keyed by a client-supplied
// id is a policy any caller can read or overwrite.
import { getStore } from "@netlify/blobs";
import { normalizePolicy, classifyPolicy, policyDigest, POLICY_STATE } from "../../shared/onchain-analyze/policy-doc.mjs";

export const POLICY_STORE = "agent-policy";
export const policyKey = (owner) => `o/${String(owner).toLowerCase()}`;

// 🚨 STRONG, for the same reason _dd-health is strong. A policy is a SAFETY input, and an eventually
// consistent read serves a CDN-cached copy: a user who just tightened their rules would be evaluated
// against the looser ones they replaced, and the UI would show the new rules beside a verdict
// computed from the old. ⚠️ The dangerous direction is the tightening one — a cached PERMISSIVE
// policy outliving the stricter one that replaced it.
const READ_CONSISTENCY = "strong";

/**
 * @returns {Promise<{state, policy, digest, readable, storedAt, errors}>}
 *   ⚠️ `readable:false` means the STORE failed, which is NOT "no policy". Absent and unreadable are
 *   different findings and callers must be able to tell them apart — collapsing them would let a
 *   store outage read as "this user has no rules", which is the reassuring answer.
 */
export async function readPolicy(owner) {
  let raw = null;
  try {
    const store = getStore(POLICY_STORE);
    raw = await store.get(policyKey(owner), { type: "json", consistency: READ_CONSISTENCY });
  } catch (e) {
    return { state: null, policy: null, digest: null, readable: false, storedAt: null,
             errors: [`policy store unreadable: ${String(e?.message ?? e)}`] };
  }
  if (!raw) {
    return { state: POLICY_STATE.ABSENT, policy: null, digest: null, readable: true, storedAt: null, errors: [] };
  }

  // ⚠️⚠️ RE-VALIDATED ON READ, NOT TRUSTED BECAUSE IT WAS VALIDATED ON WRITE. A policy stored before
  // a catalogue change can name a group that no longer exists; evaluating it would silently skip the
  // vanished rule and treat the user as though they had never written it. Surfacing beats evaporating.
  const n = normalizePolicy(raw.policy ?? raw);
  if (!n.ok) {
    return { state: classifyPolicy(raw.policy ?? raw), policy: null, digest: null, readable: true,
             storedAt: raw.storedAt ?? null, errors: n.errors };
  }
  return { state: n.state, policy: n.policy, digest: policyDigest(n.policy), readable: true,
           storedAt: raw.storedAt ?? null, errors: [] };
}

/**
 * @returns {Promise<{ok, digest?, state?, errors?}>}
 * ⭐ The DIGEST is computed here from the NORMALISED document and stored alongside it. A digest that
 * arrived in the request would let a caller bind a future override token to rules nobody stored.
 */
export async function writePolicy(owner, rawPolicy, { now }) {
  const n = normalizePolicy(rawPolicy);
  if (!n.ok) return { ok: false, errors: n.errors, state: n.state };
  const digest = policyDigest(n.policy);
  const record = {
    // ⚠️ `owner` is recorded from the SESSION, never echoed from the body.
    owner: String(owner).toLowerCase(),
    policy: n.policy,
    digest,
    state: n.state,
    storedAt: new Date(now).toISOString(),
    // ⚠️ Recorded, so a future reader can tell WHICH catalogue this policy was written against —
    // the read-time validation explains a rejection, this explains when it started failing.
    catalogueSize: (await import("../../shared/onchain-analyze/policy-doc.mjs")).CATALOGUE_SIZE,
  };
  try {
    await getStore(POLICY_STORE).setJSON(policyKey(owner), record);
  } catch (e) {
    return { ok: false, errors: [`policy store unwritable: ${String(e?.message ?? e)}`], state: n.state };
  }
  return { ok: true, digest, state: n.state, storedAt: record.storedAt };
}

/** Delete. ⚠️ Leaves ABSENT, never `{}` — a wipe must not land in the EMPTY state, which is the
 *  shape a failed write leaves and must stay diagnostic rather than being something we author. */
export async function clearPolicy(owner) {
  try {
    await getStore(POLICY_STORE).delete(policyKey(owner));
    return { ok: true };
  } catch (e) {
    return { ok: false, errors: [`policy store unwritable: ${String(e?.message ?? e)}`] };
  }
}
