// mock-shape.mjs — build a module mock from the REAL module's SHAPE, so a new export can never break module loading.
//
// ═══ WHY (2026-10-01; the d5239d7 class, a third time) ═══════════════════════════════════════════════════════════
// A mock written as a hand-listed `namedExports` pins the real module's export list as a side effect: when the code under
// test starts importing a NEW export, the suite does not fail an assertion — it fails MODULE INSTANTIATION. That kept
// the kill-switch suite (verify-pause-enforcement) dead for 33 days in 2026-08, broke it again with `shoutLedgerFailure`,
// and a third time today (d5239d7, `bridgeAckSentence`). Reproduced on purpose before this helper existed: one new
// `_bridge.mjs` export used by its importers made ALL FIVE suites that mocked `_bridge.mjs` by hand fail to load.
// `_budget.mjs`'s mock already moved to `...real` after breaking twice. This is the same fix, made safe for suites whose
// job is "nothing moves": a plain `{...real}` spread would let a new export run its REAL code (a network call, a spend)
// unnoticed. So:
//   · every non-function export (constants, ABIs, tables) is the REAL value;
//   · every FUNCTION is replaced by `stub(name)` — a recording TRIPWIRE in a kill-switch suite, a loud "unstubbed"
//     throw elsewhere — so a new export neither breaks loading nor executes real code;
//   · classes stay real (a stubbed class breaks `instanceof`);
//   · `override` supplies the doubles a suite actually needs, last.
// ⛔ A detector that catches a broken mock is worth less than a mock that cannot break (T, 2026-10-01).

const isClass = (v) => typeof v === "function" && /^class[\s{]/.test(Function.prototype.toString.call(v));

/**
 * @param {object} real                      the module namespace, imported BEFORE mock.module(...) replaces it
 * @param {{stub:(name:string)=>Function, override?:object}} o
 * @returns {object} namedExports for mock.module
 */
export function mockShape(real, { stub, override = {} }) {
  if (typeof stub !== "function") throw new Error("mockShape: a stub factory is required (tripwire or unstubbed)");
  const out = {};
  for (const [name, value] of Object.entries(real)) {
    out[name] = typeof value === "function" && !isClass(value) ? stub(name) : value;
  }
  return { ...out, ...override };
}

/** The default stub outside kill-switch suites: calling a function this suite did not stub throws, naming it. */
export const unstubbed = (moduleLabel) => (name) => () => {
  throw new Error(`unstubbed ${moduleLabel}.${name}() was called — this suite must stub it explicitly`);
};
