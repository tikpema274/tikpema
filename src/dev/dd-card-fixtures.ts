// dd-card-fixtures.ts — DEV-ONLY canned DD reports for the #/dev/dd-card route.
//
// ⛔ Imported ONLY inside the `import.meta.env.DEV` gate in App.tsx (via a lazy import()), so it is
// DEAD CODE in production — proven by grepping dist/ for DEV_FIXTURE_MARKER (must be absent).
//
// ⭐ Mirrors scripts/verify-dd-card-copy.tsx section F — the SAME power-surface-unrecognised report the
// card test renders — so the browser preview and the test agree on the no-verdict shape. Not a new
// fixture: the baseReport/basePolicy/CEILING below are copied from that test.
//
// ⭐⭐ The refusal DETAIL is NOT hand-copied — it comes from the engine itself (engine-no-verdict runs
// analyze() and reads back the real string), so the dev card shows exactly what the paid endpoint says.

import { engineNoVerdictRefusal } from "./engine-no-verdict";

export const DEV_FIXTURE_MARKER = "dd-card-dev-fixture-8f3a2b1c"; // grep sentinel: MUST be absent from dist/

const CEILING =
  "no-clearance: a pass means NOTHING WAS FOUND AGAINST YOUR RULES — never that this contract is safe. " +
  "Powers are detected by selector presence, and absence of a selector is not proof the power is absent; " +
  "the rules are yours and cover nine catalogue groups, not every way a contract can take your funds.";

const baseReport = (over: any = {}) => ({
  subject: { address: "0x240eb85458cd41361bd8c3773253a1d78054f747", chainId: 5042002, blockNumber: 57256125 },
  powersPresent: ["emergencyWithdraw", "feesSettable"],
  coverage: { totals: { checked: 13, notChecked: 0 } },
  sources: { mode: "quorum", quorum: { required: 2, configured: 2 }, integrity: { providerDisagreement: false } },
  attestation: { status: "signed" },
  refusal: null,
  ...over,
});
const basePolicy = (over: any = {}) => ({
  passes: false,
  reason: "power-present",
  ceiling: CEILING,
  authority: "display-only",
  coverage: { checked: 9, total: 9, threshold: 9, meets: true },
  evaluated: ["upgradeable", "emergencyWithdraw"],
  failures: [
    { group: "emergencyWithdraw", scope: "fund-removal", reason: "power-present", detail: 'your rule refuses "emergencyWithdraw", and this contract has it.' },
    { group: "feesSettable", scope: "economics", reason: "power-present", detail: 'your rule refuses "feesSettable", and this contract has it.' },
  ],
  unreadableFailures: [],
  detail: "2 power(s) you refuse are present",
  ...over,
});

// (a) THE NO-VERDICT report — power-surface-unrecognised, powers empty. The refusal is the ENGINE's
// actual analyze() output (engineNoVerdictRefusal), not a hand-copied string; the display scaffold
// around it stays canned. Identical to section F, which renders the same engine refusal.
export const noVerdictData = {
  report: baseReport({
    powersPresent: [],
    refusal: engineNoVerdictRefusal,
  }),
  policy: basePolicy(),
  verifiability: { attestation: "signed" },
};

// (b) A RECOGNISED Xylo-style verdict report — refusal null, powers found (for side-by-side comparison).
export const xyloVerdictData = {
  report: baseReport(),
  policy: basePolicy(),
  verifiability: { attestation: "signed" },
};
