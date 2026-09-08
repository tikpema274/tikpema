// plan-acks.mjs — WHICH PER-STEP ACKNOWLEDGEMENT TOKENS MAY TRAVEL WITH A PLAN.
//
// ═══ ⭐⭐ A PURE FUNCTION BECAUSE THE PROPERTY IS WORTH TESTING, NOT GREPPING ═══════════════════
// This lived inline in MyAgentPanel, and the guard covering it matched the SHAPE of the expression
// — `planAcked[i] && planDisclosures` — rather than the behaviour. So it went red when the same
// property was rewritten as a guard clause, and it would have stayed GREEN on a rewrite that kept
// the shape and broke the rule. A regex over source cannot tell those two apart, which is exactly
// why it was the wrong instrument. [[assert-on-rendered-output-not-source-regex]] · [[flow-is-not-meaning]]
//
// ⭐ IN `shared/` AND PLAIN .mjs ON PURPOSE. The component that uses it is TSX and the guard that
// exercises it runs under bare node — the same reason shared/bridge-timing.mjs lives here. A .ts
// module would be importable by one of its two consumers, which is how a rule ends up with a
// second copy written for the other.
//
// ⛔ THE RULE: a token is sent ONLY for a step the user actually ticked. The server re-prices,
// re-inspects and refuses independently, so a missing token costs nothing — but a token sent for a
// step nobody accepted would be this client asserting a consent it never collected.
//
// ⚠️ TWO KINDS OF CONSENT, TWO MAPS. A bridge step is gated on a FEE BAND, a vault step on the
// vault's DISCLOSURE; they share only the step index. Merging them would let a vault entry fail a
// `band` test and drop out of the gate silently. [[vendor-field-carries-its-own-discriminator]]

/**
 * @typedef {object} AckMaps
 * @property {Record<string, {band?: string, ackToken?: string|null}>} [planDisclosures]
 *   Bridge steps by index. Gated when `band === "acknowledge"`.
 * @property {Record<string, {ackRequired?: boolean, ackToken?: string|null}>} [planVaults]
 *   Vault steps by index. Gated when `ackRequired`.
 */

/** Step indices that REQUIRE an acknowledgement before the plan may run — from BOTH kinds.
 *  @param {AckMaps} maps @returns {number[]} */
export function stepsNeedingAck({ planDisclosures = {}, planVaults = {} } = {}) {
  return [
    ...Object.entries(planDisclosures).filter(([, d]) => d?.band === "acknowledge").map(([k]) => Number(k)),
    ...Object.entries(planVaults).filter(([, d]) => !!d?.ackRequired).map(([k]) => Number(k)),
  ];
}

/**
 * The tokens to send, keyed by step index.
 * ⛔ ONLY for indices that are BOTH required and ticked. An unticked step contributes nothing, and
 * a step with no token contributes nothing rather than an `undefined` the server would read as a
 * mismatch it could not explain.
 * @param {AckMaps} maps @param {Record<number, boolean>} acked @returns {Record<number, string>}
 */
export function planAckTokensFor(maps, acked = {}) {
  const out = {};
  for (const i of stepsNeedingAck(maps)) {
    if (!acked[i]) continue;
    const t = maps?.planDisclosures?.[String(i)]?.ackToken ?? maps?.planVaults?.[String(i)]?.ackToken;
    if (t) out[i] = t;
  }
  return out;
}
