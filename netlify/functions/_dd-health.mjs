// _dd-health.mjs — the DD service's health record: where it lives, and how a failed read is reported.
//
// ⚠️ SEPARATE FROM _pause.mjs BY DESIGN. That is the MONEY kill-switch for the agent; this is the
// CORRECTNESS kill-switch for a read-only analyzer. Different stores, different failure domains:
// the DD canary going dark must never disable the agent, and a Blobs problem in one must not be
// mistaken for the other. This module is not imported by the deposit path and does not import it.
//
// ⭐ THE READ RETURNS A TRI-STATE, NOT A VALUE. `{record, readable}` — because "I could not read the
// health record" and "the health record says unhealthy" are different facts, and only one of them is
// evidence about the detector. Collapsing them into `record = null` would let a Blobs hiccup be
// reported to the caller as a failed canary. Both refuse, but they refuse with the truth.
// This is the same tri-state lesson as the vault inspector's UNREADABLE.

import { getStore } from "@netlify/blobs";

export const DD_HEALTH_STORE = "dd-canary-health";

/** One key per code identity. A record for another build is not merely stale — it is about
 *  different code, so it must not be found at all when looking for this one. */
export const healthKey = (identity) =>
  `health:${identity.schemaVersion}:${identity.catalogueFingerprint}:${identity.build}`;

/**
 * Read the health record.
 * @returns {Promise<{record: object|null, readable: boolean, error?: string}>}
 *          `readable:false` means the STORE failed, which is NOT the same as "no record".
 */
export async function readHealth(identity) {
  try {
    const store = getStore(DD_HEALTH_STORE);
    const raw = await store.get(healthKey(identity), { type: "json" });
    return { record: raw ?? null, readable: true };
  } catch (e) {
    return { record: null, readable: false, error: String(e?.message ?? e) };
  }
}

/** Write the health record. Returns false rather than throwing, so a canary that cannot persist its
 *  verdict still reports that fact instead of dying silently — the absence will refuse anyway. */
export async function writeHealth(identity, record) {
  try {
    const store = getStore(DD_HEALTH_STORE);
    await store.setJSON(healthKey(identity), record);
    return true;
  } catch {
    return false;
  }
}
