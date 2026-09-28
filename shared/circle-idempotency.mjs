// circle-idempotency.mjs — a Circle idempotency key derived from an INTENT key (the mandate's exit uses it). Pure.
//
// ⚠️ Deliberately OUTSIDE shared/vault-mandate/: _vault.mjs (the vault primitives, which executeAction calls into)
// imports it, and test:mandatedeposit forbids any file that imports mandate code from also reaching the executor.
// Nothing here knows about mandates; the namespace string below keeps its original (pinned) spelling.
//
// ═══ WHY DERIVED, NOT RANDOM (PROGRESS: PIECE 5 DESIGN CORRECTIONS, C4) ════════════════════════════
// The intent is written BEFORE submitting; Circle's transaction id only exists AFTER Circle accepts. A crash between
// the two loses the id. With a key that recovery can RECOMPUTE from the intent key alone, the transaction stays
// findable (and a retry with the same key is, per Circle, the same request) — so the key is a function of the intent
// key, never `randomUUID()`.
//
// ═══ WHY V4-SHAPED (Circle docs, read 2026-09-28) ══════════════════════════════════════════════════
// developers.circle.com/w3s/idempotent-requests: "you must generate and provide an idempotency key formatted as a
// UUID version 4". A UUIDv5 (the textbook name-based UUID) carries version nibble 5 and breaks that format. So: the
// first 16 bytes of sha256(namespace + intent key), with the version nibble set to 4 and the RFC 4122 variant bits —
// deterministic, and indistinguishable in FORMAT from a random v4. Whether Circle's server enforces the version
// nibble at all is UNMEASURED (the SDK itself does not validate; it sends `key ?? <random>`).
//
// ⛔ The namespace is versioned and the derivation is pinned by test:vaultsubmitredeem: changing either changes the key
// every OPEN intent will be recovered by. A new derivation takes a new namespace version, never an edit.

import { createHash } from "node:crypto";

const NAMESPACE = "tikpema/vault-mandate/idempotency/v1\n";
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a lowercase UUID in version-4 format (what Circle documents for `idempotencyKey`). */
export const isV4Uuid = (v) => typeof v === "string" && V4.test(v);

/** The key for an intent. Throws on a missing or non-string intent key: never a key for nothing. */
export function idempotencyKeyFor(intentKey) {
  if (typeof intentKey !== "string" || intentKey.length === 0) {
    throw new Error("idempotencyKeyFor: the intent key must be a non-empty string");
  }
  const b = createHash("sha256").update(NAMESPACE + intentKey).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
