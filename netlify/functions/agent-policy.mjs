// agent-policy.mjs — GET/POST/DELETE /api/agent-policy  (session required)
//
// The owner's STANDING RULES, stored server-side. READ-ONLY with respect to money: this endpoint
// moves nothing, signs nothing, and gates nothing.
//
// ═══ ⚠️⚠️ IT STILL GATES NOTHING, AND THAT IS THE WHOLE POINT OF SHIPPING IT THIS WAY ══════════
// Storage is what would let a policy stop being display-only — a server-stored policy has none of
// the "the caller chose their own rules" defect. But storage WITHOUT the digest-bound override token
// is a policy that can BLOCK a deposit with no escape, and the rules are the user's own, so the
// lockout would be self-inflicted and unappealable. That is the 409-lockout shape already rejected
// once here.
//
// ⭐ SO: storage lands first, `authority` stays `display-only`, and the flip happens only when the
// override ships. Enforced by `assertMayGate()` in policy-doc.mjs, which THROWS — the first author to
// wire a gate meets an exception, not a silent enforcement.
import { json, parseBody } from "./_arc.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { requireSession } from "./_auth.mjs";
import { readPolicy, writePolicy, clearPolicy } from "./_policy-store.mjs";
import { POLICY_STATE, POLICY_AUTHORITY, CATALOGUE_SIZE } from "../../shared/onchain-analyze/policy-doc.mjs";
import { POWER_SIGS } from "../../shared/onchain-facts/index.mjs";

/**
 * ⭐⭐ THE FOUR STATES, EACH WITH ITS OWN SENTENCE. Collapsing any two is a consent bug: a user whose
 * rules were WIPED has made no decision, while a user who allowed everything has made one.
 */
const STATE_MEANING = Object.freeze({
  [POLICY_STATE.ABSENT]:
    "You have no stored rules. Nothing is evaluated, and that is NOT a pass — it is the absence of a preference.",
  [POLICY_STATE.EMPTY]:
    "⚠️ A policy is stored but its rules are EMPTY. This is not the same as allowing everything: it is the shape a wipe leaves behind. Nothing will be evaluated until you set a rule, and no result will read as approval.",
  [POLICY_STATE.ALL_ALLOW]:
    "Every rule you set is `allow`. This IS a decision, and evaluations will pass — but they pass because you refuse nothing, not because nothing was found.",
  [POLICY_STATE.ACTIVE]:
    "At least one rule refuses a power. Evaluations report what was found against those rules.",
});

const authorityBlock = () => ({
  authority: POLICY_AUTHORITY.DISPLAY_ONLY,
  authorityNote:
    "This policy is stored server-side, but it GATES NOTHING. A policy that can refuse a deposit " +
    "needs a digest-bound override token so a user is never locked out of their own funds by their " +
    "own rules; that token does not exist yet. Until it does, every verdict is advisory.",
});

export async function handler(event) {
  try {
    if (event.blobs) connectBlobs(event);
    const session = requireSession(event);
    if (!session) return json(401, { error: "Authentication required" });
    const owner = session.address;

    if (event.httpMethod === "GET") {
      const r = await readPolicy(owner);
      // ⚠️ UNREADABLE IS NOT ABSENT. A store outage must not render as "you have no rules".
      if (!r.readable) {
        return json(503, { error: "Could not read your policy", readable: false, errors: r.errors,
                           note: "This is our store failing, NOT a statement that you have no rules." });
      }
      return json(200, {
        state: r.state, meaning: STATE_MEANING[r.state] ?? null,
        policy: r.policy, digest: r.digest, storedAt: r.storedAt,
        // ⚠️ A STORED POLICY THAT NO LONGER VALIDATES SURFACES HERE rather than evaporating — most
        // likely it names a power group that a catalogue change removed.
        invalid: r.errors.length > 0, errors: r.errors,
        catalogue: Object.keys(POWER_SIGS), catalogueSize: CATALOGUE_SIZE,
        ...authorityBlock(),
      });
    }

    if (event.httpMethod === "POST") {
      const body = parseBody(event) || {};
      // ⚠️ THE DIGEST IS NEVER ACCEPTED FROM THE BODY. Refused loudly rather than ignored: a caller
      // that sent one believed it would be used, and silently dropping it leaves that belief intact.
      if ("digest" in body) {
        return json(400, { error: "`digest` is computed server-side and must not be supplied",
                           why: "an override token binds to this digest; a caller-supplied one would bind an override to rules nobody stored" });
      }
      const w = await writePolicy(owner, body.policy ?? body, { now: Date.now() });
      if (!w.ok) {
        return json(400, { error: "Policy rejected", errors: w.errors, state: w.state,
                           catalogue: Object.keys(POWER_SIGS), catalogueSize: CATALOGUE_SIZE });
      }
      return json(200, { ok: true, state: w.state, meaning: STATE_MEANING[w.state] ?? null,
                         digest: w.digest, storedAt: w.storedAt, ...authorityBlock() });
    }

    if (event.httpMethod === "DELETE") {
      const d = await clearPolicy(owner);
      if (!d.ok) return json(503, { error: "Could not clear your policy", errors: d.errors });
      // ⭐ Deleting leaves ABSENT, never EMPTY — a wipe must not land in the state that means
      // "something went wrong", or a deliberate clear becomes indistinguishable from a failure.
      return json(200, { ok: true, state: POLICY_STATE.ABSENT, meaning: STATE_MEANING[POLICY_STATE.ABSENT] });
    }

    return json(405, { error: "GET, POST or DELETE" });
  } catch (e) {
    console.error("[agent-policy] unhandled:", e);
    return json(500, { error: "The request could not be processed" });
  }
}
