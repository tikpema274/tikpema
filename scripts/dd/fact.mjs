// fact.mjs — THE CONTRACT. Every check returns one of these, and nothing else.
//
// ⚠️ A FACT IS NOT A VERDICT. There is no `pass`, no `ok`, no `severity`. A check reports what it
// OBSERVED ("this address has no bytecode at block N"); a human decides what that MEANS ("so the
// project cannot settle there"). The moment a check starts concluding, the engine acquires an
// opinion — and an opinion is the one thing this tool must never ship, because its entire value is
// that its output is checkable rather than believable.
//
// ⚠️ THE THREE-STATE RULE — the reason this file exists. A check has THREE outcomes, not two:
//     observed  → we asked, the chain answered, here is the fact
//     error     → we could not ask (RPC down, bad input, chain mismatch). NOT a fact. NOT "false".
// An `eth_getCode` that TIMES OUT must never become `hasCode: false`. That is the Arcent-killer
// firing on a network blip, and it is the same fail-open shape that has bitten this repo before
// (`amount > cap` is false for NaN → the cap silently disappears). An absent answer and an answer
// of "absent" are different things. `error` carries no `result` at all, so nothing downstream can
// mistake one for the other.
//
// EVERY fact carries `query`: the exact request that produced it, including a copy-pasteable curl.
// If a reader cannot re-run the query and get the same evidence, the fact is worthless.

import { createHash } from "node:crypto";

/**
 * @typedef {Object} Fact
 * @property {string} check       - check id, e.g. "code-exists"
 * @property {"observed"|"error"} status
 * @property {object} input       - exactly what was asked, normalized
 * @property {object|null} result - the OBSERVATION, structured. Always null when status==="error".
 * @property {object|null} evidence - the raw, unmodified response the observation was read from
 * @property {object|null} query  - endpoint + method + params + `reproduce` (a curl string)
 * @property {string} observedAt  - ISO8601, when the query ran
 * @property {string|null} error  - human-readable reason, only when status==="error"
 */

/** A successful observation. `result` is the fact; `evidence` is what we read it from. */
export function observed({ check, input, result, evidence, query }) {
  return {
    check,
    status: "observed",
    input,
    result,
    evidence,
    query,
    observedAt: new Date().toISOString(),
    error: null,
  };
}

/**
 * We could not ask. Deliberately carries `result: null` — there is NO fact here, and a caller that
 * treats this as a negative observation is the bug this shape exists to prevent.
 */
export function failed({ check, input, error, query = null, evidence = null }) {
  return {
    check,
    status: "error",
    input,
    result: null,
    evidence,
    query,
    observedAt: new Date().toISOString(),
    error: String(error?.message ?? error),
  };
}

/** Stable fingerprint of bytecode — lets check 2 ask "is this the SAME deployment as over there?" */
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** 0x-prefixed 20-byte address, or null. Rejects at the gate rather than passing junk to an RPC. */
export function normalizeAddress(a) {
  if (typeof a !== "string") return null;
  const s = a.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.toLowerCase() : null;
}
