// policy-doc.mjs — a STORED policy: validate it, classify it, digest it. Pure: no I/O, no clock.
//
// `policy.mjs` decides what a policy MEANS against a report. This decides what a policy IS: whether
// it is well-formed, which of the several "empty-looking" states it is in, and the digest an
// override token will one day bind to.
//
// ═══ ⚠️⚠️ STORAGE IS WHAT MAKES `authority` STOP BEING DISPLAY-ONLY ═══════════════════════════
// A client-supplied policy can never gate anything — a caller who chooses their own rules can choose
// rules that pass. A SERVER-STORED policy has no such defect, which is exactly why it becomes
// dangerous: the moment it is trusted, it can BLOCK a deposit, and storage without a digest-bound
// override token is a policy that blocks with no escape. That is the 409-lockout shape this repo has
// already rejected once.
//
// ⭐ SO THE ORDER IS: storage first, still DISPLAY-ONLY, and the authority flips only when the
// override token exists. And "still display-only" is enforced by `assertMayGate()` rather than by
// intention — the first author to wire a gate hits a THROW, not silent enforcement. Leaving a field
// set to a safe value and trusting the next person to notice is how a safe default becomes an unsafe
// one, quietly, in a diff about something else.

import { POWER_SIGS } from "../onchain-facts/index.mjs";

/** Closed set. ⚠️ `enforcing` is DECLARED BUT UNREACHABLE — see assertMayGate. */
export const POLICY_AUTHORITY = Object.freeze({
  DISPLAY_ONLY: "display-only",
  ENFORCING: "enforcing",
});

/**
 * 🚨 THE GUARD THAT KEEPS (1) HONEST. Any future gate MUST call this before acting on a verdict.
 * It throws while the override token does not exist, so wiring a gate is a deliberate act that
 * requires deleting this constant — not something a plausible-looking `if (policy.passes)` achieves
 * by accident.
 *
 * ⚠️ DELETE `OVERRIDE_TOKEN_EXISTS = false` ONLY WHEN THE OVERRIDE TOKEN ACTUALLY SHIPS. Without it,
 * a user whose stored rules refuse a power the vault has is locked out of their own deposit with no
 * way to proceed — and the rules are theirs, so the lockout is self-inflicted and unappealable.
 */
const OVERRIDE_TOKEN_EXISTS = false;
export function assertMayGate(authority) {
  if (!OVERRIDE_TOKEN_EXISTS) {
    throw new Error(
      "a policy verdict MUST NOT gate anything yet: the digest-bound override token does not exist, " +
      "so a refusing policy would block a deposit with no escape. Ship the override first, then set " +
      "OVERRIDE_TOKEN_EXISTS in shared/onchain-analyze/policy-doc.mjs."
    );
  }
  if (authority !== POLICY_AUTHORITY.ENFORCING) {
    throw new Error(`policy authority is "${authority}", not "${POLICY_AUTHORITY.ENFORCING}" — it may not gate`);
  }
  return true;
}

/**
 * ⭐⭐ THE FOUR STATES, AND WHY COLLAPSING ANY TWO IS A CONSENT BUG.
 *
 *   ABSENT     — no record. The user has never expressed a preference.
 *   EMPTY      — a record exists whose `rules` is `{}`. ⚠️ NOT the same as absent, and NOT the same
 *                as allowing everything: it is the shape a WIPE leaves behind — a failed migration,
 *                a serialisation bug, a delete that half-completed. A user whose rules got wiped has
 *                made no decision, and reading `{}` as consent is exactly how a cleared policy
 *                becomes a green tick.
 *   ALL_ALLOW  — a record where every rule is "allow". ⭐ THIS ONE **IS** A DECISION. Someone sat
 *                down and permitted every power in the catalogue. It legitimately PASSES — and the
 *                wording must say why, because "you allow everything, so nothing was refused" and
 *                "nothing was found against your rules" are different sentences and only one of them
 *                is true here.
 *   ACTIVE     — at least one rule refuses something.
 */
export const POLICY_STATE = Object.freeze({
  ABSENT: "absent",
  EMPTY: "empty",
  ALL_ALLOW: "all-allow",
  ACTIVE: "active",
});

export const RULE_VERDICTS = Object.freeze(["refuse", "allow"]);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const CATALOGUE_SIZE = Object.keys(POWER_SIGS).length;

/**
 * Classify a stored policy document. `null`/`undefined` → ABSENT.
 * ⚠️ Classification says nothing about VALIDITY — a malformed policy still has a state, and callers
 * must check `normalizePolicy` too. Two questions, two answers, never one conflated flag.
 */
export function classifyPolicy(policy) {
  if (policy === null || policy === undefined) return POLICY_STATE.ABSENT;
  if (!isObj(policy) || !isObj(policy.rules)) return POLICY_STATE.EMPTY;
  const entries = Object.entries(policy.rules);
  if (entries.length === 0) return POLICY_STATE.EMPTY;
  if (entries.every(([, v]) => v === "allow")) return POLICY_STATE.ALL_ALLOW;
  return POLICY_STATE.ACTIVE;
}

/**
 * Validate and canonicalise a policy document.
 *
 * ⚠️⚠️ UNKNOWN GROUP NAMES ARE REJECTED, NOT DROPPED — at write time AND at read time.
 * A policy naming `upgradable` would silently fail to refuse `upgradeable`: the user's own safety
 * rule, quietly doing nothing, with a UI that shows it as set. Dropping it is worse than rejecting
 * it, because the user keeps believing they are protected. This is the closed-set discipline aimed
 * at the one place where the closed set is the USER'S.
 *
 * ⭐ AND READ-TIME VALIDATION IS NOT REDUNDANT. A policy stored before a catalogue change can name a
 * group that no longer exists. Validating only on write would let that policy be read back, silently
 * skip the vanished rule, and evaluate as though the user had never written it — the same
 * evaporation, arriving through time instead of through a typo.
 *
 * @returns {{ok: boolean, policy: object|null, errors: string[], state: string}}
 */
export function normalizePolicy(raw) {
  const errors = [];
  const state = classifyPolicy(raw);

  if (raw === null || raw === undefined) {
    return { ok: false, policy: null, state, errors: ["no policy document"] };
  }
  if (!isObj(raw)) {
    return { ok: false, policy: null, state, errors: ["a policy must be a JSON object"] };
  }
  if (!isObj(raw.rules)) {
    return { ok: false, policy: null, state, errors: ["`rules` must be an object"] };
  }

  const rules = {};
  for (const [group, verdict] of Object.entries(raw.rules)) {
    if (!(group in POWER_SIGS)) {
      // ⚠️ NAMED IN THE ERROR, with the catalogue alongside — a rejection a user cannot act on is a
      // rejection they will work around by deleting the rule.
      errors.push(`unknown power group "${group}" — the catalogue is: ${Object.keys(POWER_SIGS).join(", ")}`);
      continue;
    }
    if (!RULE_VERDICTS.includes(verdict)) {
      errors.push(`rule for "${group}" is ${JSON.stringify(verdict)}, which is not "refuse" or "allow"`);
      continue;
    }
    rules[group] = verdict;
  }

  // ── coverageThreshold ──────────────────────────────────────────────────────────────────────
  // ⭐ null AND 0 ARE BOTH VALID AND ARE NOT THE SAME. `null` = the user set no threshold, so
  // coverage is reported and not gated. `0` = a threshold that is trivially met — a deliberate "I
  // do not require any coverage", which is a statement, not an absence. Coercing 0 → null (or
  // treating a falsy threshold as unset) erases a decision the user made.
  let coverageThreshold = null;
  if (raw.coverageThreshold !== undefined && raw.coverageThreshold !== null) {
    const t = raw.coverageThreshold;
    if (!Number.isInteger(t)) {
      errors.push(`coverageThreshold must be an integer or null (got ${JSON.stringify(t)})`);
    } else if (t < 0) {
      errors.push(`coverageThreshold must not be negative (got ${t})`);
    } else if (t > CATALOGUE_SIZE) {
      // 🚨 AN UNSATISFIABLE THRESHOLD IS A LOCKOUT THE USER WROTE THEMSELVES. The catalogue has
      // CATALOGUE_SIZE groups, so a higher floor can NEVER be met by any report about any contract:
      // every evaluation would refuse, forever, for a reason that looks like a finding about the
      // vault. Rejected at write time, where it is still a typo rather than a mystery.
      errors.push(
        `coverageThreshold ${t} can never be satisfied — the catalogue has only ${CATALOGUE_SIZE} power groups, ` +
        `so this policy would refuse every contract forever`
      );
    } else {
      coverageThreshold = t;
    }
  }

  if (errors.length) return { ok: false, policy: null, state, errors };
  return { ok: true, policy: { rules, coverageThreshold }, state: classifyPolicy({ rules }), errors: [] };
}

/**
 * ⭐⭐ THE DIGEST IS COMPUTED HERE, FROM THE NORMALISED DOCUMENT, AND NEVER ACCEPTED FROM A CALLER.
 *
 * 🚨 THE REASON IS THE OVERRIDE TOKEN THAT DOES NOT EXIST YET. That token will bind to this digest,
 * so a client that could supply the digest could bind an override to a policy it invented — the
 * override would attest to rules the user never stored. Same discipline as the bridge receipt: every
 * field of a record that carries authority must be SERVER-SOURCED.
 *
 * ⭐ CANONICAL, so semantically identical policies digest identically: rule keys sorted, and the
 * threshold rendered with `null` distinguished from `0` rather than both becoming falsy.
 * ⚠️ Versioned `v1` from the start — the vault digest needed a v1→v2 bump the moment an input was
 * added, and that only worked because the marker was already there.
 */
export function policyDigest(policy) {
  const rules = Object.entries(policy?.rules ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([g, v]) => `${g}=${v}`)
    .join(",");
  const t = policy?.coverageThreshold;
  const threshold = t === null || t === undefined ? "none" : String(t);
  return `rules:${rules}|cov:${threshold}|v1`;
}
