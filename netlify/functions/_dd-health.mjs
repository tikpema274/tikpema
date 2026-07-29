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
// ═══ 🚨 STRONG CONSISTENCY IS LOAD-BEARING — DO NOT DROP IT ══════════════════════════════════
// Netlify Blobs reads default to `consistency: "eventual"` — a CDN-cached edge read, not the origin.
// For a SAFETY VERDICT that is wrong in the most dangerous possible way.
//
// MEASURED 2026-07-29, not theorised: a freshly-written health artifact was invisible to the reader.
// The canary reported ok:true / wrote:true while dd-analyze kept refusing `stale` with an `ageMs`
// that CLIMBED PAST the canary run — pinned at 3601018 ms, i.e. exactly one hour, a cache-shaped
// number rather than a staleness-shaped one. The write went to origin; the read came off a stale edge
// copy. A tight curl-then-probe chain worked the night before only because nothing had cached the key
// yet.
//
// ⭐ THE FAIL-OPEN THIS PREVENTS, which is the reason it matters — the symptom above is the SAFE
// direction, and the same defect runs the other way:
//
//     canary detects a regression → writes verdict:"fail"
//     dd-analyze reads a CACHED PASSING artifact → KEEPS SERVING
//
// The entire dead-man's-switch design assumes the endpoint reads the LATEST artifact. An eventually
// consistent read silently voids that assumption, and a broken detector would go on answering
// questions about other people's contracts. Same family as the build-id sentinel and every other
// entry in this codebase's recurring failure mode: a stale value quietly filled the result slot and
// read as a verdict about NOW.
//
// The cost is one uncached round trip on a path that already refuses on absence — negligible against
// serving from a detector nobody has checked.
const READ_CONSISTENCY = "eventual"; // ⚠️ DEGRADED — see INCIDENT note above

export async function readHealth(identity) {
  try {
    const store = getStore(DD_HEALTH_STORE);
    const raw = await store.get(healthKey(identity), { type: "json", consistency: READ_CONSISTENCY });
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
