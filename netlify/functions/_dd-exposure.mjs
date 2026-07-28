// _dd-exposure.mjs — is the DD service allowed to answer the public at all?
//
// ═══ ⭐ WHY THIS EXISTS: DEPLOYING IS NOT DECIDING ════════════════════════════════════════════
// `/api/dd-analyze` is committed in netlify.toml, and Netlify has NO per-function deploy — so the
// next `netlify deploy --prod` would publish a free public signed-attestation endpoint under agentId
// 851891 with no further decision by anyone. Prod was clean only because nobody had run the command.
// That is a TRAP, not a policy: the safety property lived in an untyped command nobody had typed.
//
// 🚨 REMOVING THE REDIRECT WOULD NOT FIX IT. Every deployed function is reachable at
// /.netlify/functions/<name> regardless of redirects — proven on a draft, where dd-analyze answered a
// real 405 from that path while `_arc`/`_vault` returned 502 (deployed, no handler). The `_` prefix is
// a repo convention, not protection. So inertness has to be IN THE CODE.
//
// ═══ UNSET = DISABLED. THE INVERSE OF _pause.mjs, DELIBERATELY. ══════════════════════════════
// _pause.mjs is a KILL SWITCH: unset means RUNNING, and anything unrecognised HALTS — because for a
// brake, the dangerous default is "not braking". This is an EXPOSURE flag, where the dangerous
// default is the opposite: publishing. So unset means DISABLED, and anything unrecognised is ALSO
// disabled. Both modules share the real rule — a typo must never widen what the system does — and
// they differ only in which direction "wider" points.

/** Values that turn the public surface ON. Everything else — including absence, empty string, and
 *  anything unrecognised — leaves it OFF. */
const ENABLED_VALUES = new Set(["1", "true", "on", "yes", "enabled"]);

export const EXPOSURE_REASON = Object.freeze({
  ENABLED: "enabled",
  UNSET: "not-enabled-unset",
  DISABLED: "not-enabled-explicit",
  UNRECOGNISED: "not-enabled-unrecognised",
});

/**
 * Pure predicate over the raw env value, so it is testable without a deploy.
 *
 * @param {string|undefined|null} raw  process.env.DD_PUBLIC_ENABLED, verbatim
 * @returns {{enabled: boolean, reason: string, detail: string}}
 */
export function evaluateExposure(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return {
      enabled: false,
      reason: EXPOSURE_REASON.UNSET,
      detail:
        "DD_PUBLIC_ENABLED is not set. The service is deployed but INERT by default: publishing a " +
        "signed-attestation endpoint is a decision someone must make explicitly, not a side effect of " +
        "running a deploy command.",
    };
  }
  const v = String(raw).trim().toLowerCase();
  if (ENABLED_VALUES.has(v)) {
    return { enabled: true, reason: EXPOSURE_REASON.ENABLED, detail: "public serving explicitly enabled" };
  }
  if (["0", "false", "off", "no", "disabled"].includes(v)) {
    return { enabled: false, reason: EXPOSURE_REASON.DISABLED, detail: "public serving explicitly disabled" };
  }
  // ⭐ A value we do not recognise is DISABLED, never enabled. We cannot tell whether the operator
  // meant to enable it and mistyped; the safe reading of an ambiguous instruction is the narrower one.
  return {
    enabled: false,
    reason: EXPOSURE_REASON.UNRECOGNISED,
    detail: `DD_PUBLIC_ENABLED is set to an unrecognised value (${JSON.stringify(String(raw).slice(0, 40))}). Refusing to serve: a typo must never widen what the service exposes.`,
  };
}

/** Convenience wrapper reading the live env. */
export const exposureState = () => evaluateExposure(process.env.DD_PUBLIC_ENABLED);
