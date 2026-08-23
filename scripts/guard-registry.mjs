// guard-registry.mjs — WHO GUARDS WHAT, DECLARED IN ONE PLACE.
//
// ═══ 🚨 WHY THIS EXISTS — THREE SPECIES OF NON-GUARDING GUARD, ALL MEASURED 2026-08-20 ════════
//   1. UNGUARDED CLAIM — no suite names the surface. `PlanPanel` promised "with live pricing" for
//      four deferrals; nothing rendered that card, so nobody was ever required to revisit it.
//   2. UNWIRED SUITE — exists, never invoked. Four of nine RENDER suites were unreachable from
//      `test:all`, and they were precisely the ones asserting what a user sees.
//   3. 🚨 TOLERATED RED — visible and ignored, AND it masks everything behind it. `test:probe`
//      sat red for ~2 days at position 1 of an `&&` chain, so all 17 later suites never ran.
//   4. ⭐⭐ WRONG PHASE — correct, wired, and asking a question unanswerable where it stands.
//      See the block below `MAX_UNCOVERED`; it is the only one that reddens with nothing broken.
//
// ⭐ The first two fail open QUIETLY. The third recruits the reader into failing open, which is why
// it is the worst of them: an unwired guard is merely absent, and absence is honest.
//
// ═══ ⭐⭐ THIS FILE SHIPS GREEN, AND THAT IS A DESIGN REQUIREMENT, NOT A COMPROMISE ═══════════
// Seven components carry claim-bearing copy that no suite renders. A gate that failed on all seven
// would be RED ON ITS FIRST DAY — recreating species 3 in the very file written to end it. So the
// debt is DECLARED, reported loudly on every run, and RATCHETED: `MAX_UNCOVERED` may only ever be
// lowered. Known debt that cannot grow is a plan; known debt that can grow is a habit.
//
// ⚠️ WHAT THIS REGISTRY DOES NOT PROVE, stated plainly: that a named suite RENDERS its component
// non-emptily. That property is only checkable by rendering, so it lives in each suite's own
// section 0 (`verify-ub-exit-view`, `verify-plan-card-copy`, `verify-job-status-merge` all carry
// one). This file proves DECLARATION, REACHABILITY and NON-REGRESSION. Reading it as proof of
// coverage would be the same mistake `verify-unified-balance-copy`'s header made about
// `UbExitStatus` — which contributed zero characters while being listed as covered.

/**
 * Every file in `src/components`. A new one that is not here FAILS — declaration is the point.
 *   { suite }      — a suite RENDERS this component and asserts its claims
 *   { noClaims }   — carries no claim-bearing copy. ⚠️ Checked, not trusted: if it grows one, the
 *                    gate fails. This is the "a no-claims file that grows a promise" assertion.
 *   { uncovered }  — KNOWN DEBT. Claim-bearing, unrendered by any suite. Counted and ratcheted.
 */
export const COMPONENTS = {
  // ── covered ────────────────────────────────────────────────────────────────────────────────
  PlanPanel:            { suite: "verify-plan-card-copy.tsx" },
  UnifiedBalancePanel:  { suite: "verify-unified-balance-copy.tsx" },
  YourMoney:            { suite: "verify-unified-balance-copy.tsx" },
  UbExitStatus:         { suite: "verify-ub-exit-view.tsx" },
  DdReportCard:         { suite: "verify-dd-card-copy.tsx" },
  bridgeReceiptStatus:  { suite: "verify-bridge-copy.tsx" },
  jobTimeline:          { suite: "verify-job-status-merge.tsx" },
  VaultPanel:           { suite: "verify-vault-panel-copy.tsx" },
  MyAgentPanel:         { suite: "verify-agent-panel-copy.tsx" },
  DcaPanel:             { suite: "verify-dca-consent-copy.tsx" },
  NanopaymentPanel:     { suite: "verify-nanopay-copy.tsx" },
  BridgePanel:          { suite: "verify-bridge-panel-copy.tsx" },
  Dashboard:            { suite: "verify-dashboard-copy.tsx" },
  ResearchPanel:        { suite: "verify-research-panel-copy.tsx" },
  // ⚠️ NOT verify-activity-fallback — that renders ONE row subcomponent for a fallback label and
  // asserts nothing about the page's claims. It is why this entry read as covered while being debt.
  AgentsPanel:          { suite: "verify-agents-panel-copy.tsx" },

  // ── known debt, claim-bearing and unrendered ────────────────────────────────────────────────
  // ⚠️ Ordered by what a wrong claim would COST, not by how many claims each carries.

  // ── no claim-bearing copy ──────────────────────────────────────────────────────────────────
  AddressDisplay: { noClaims: true }, ConnectPasskey: { noClaims: true },
  FeedbackPanel:  { noClaims: true }, PredictPanel:   { noClaims: true },
  SendPanel:      { noClaims: true }, SignInPrompt:   { noClaims: true },
  SwapPanel:      { noClaims: true },
};

/** 🚨 THE RATCHET. Lower it when debt is paid; raising it must be a deliberate, reviewed edit. */
export const MAX_UNCOVERED = 0;

/**
 * ⚠️ THE RATCHET STOPS DEBT GROWING. NOTHING IN IT MAKES DEBT SHRINK — 8 will sit at 8 forever
 * unless something pulls. So the horizon is named, and it is not arbitrary: every uncovered entry
 * is a MONEY-PATH ABSOLUTE ("always available, never blocked by a pause", "the burn is instant"),
 * and disclosure changes who is culpable, not what a user can do. Testnet tolerates an unguarded
 * absolute. Mainnet does not.
 *
 * ⭐⭐ AND IT DELIBERATELY DOES NOT FAIL THE GATE ON THAT DATE. A deadline wired to a gate becomes
 * a TOLERATED RED the morning it fires — species 3, scheduled in advance by the very file written
 * to end it. What it does instead is PRINT the days left and the burn-down rate required, every
 * run, so the number is impossible not to see and impossible to mistake for progress.
 */
export const DEBT_HORIZON = { date: "2026-09-16", why: "mainnet — these are money-path absolutes" };

/**
 * Suites deliberately NOT reachable from `test:all` or `deploy:prod`, each with a reason.
 * ⭐ AN ALLOW-LIST, so a NEW unwired suite fails — the direction that costs a decision rather than
 * silently adding another invisible guard.
 */
/**
 * ═══ ⭐⭐ A FOURTH SPECIES: A GUARD IN THE WRONG PHASE ════════════════════════════════════════
 * Not unguarded, not unwired, not tolerated red. **Correctly written, correctly wired, asking a
 * question that cannot be answered where it stands.**
 *
 *     a PRE-deploy gate asserts on the LOCAL TREE — what is about to ship
 *     a POST-deploy gate asserts on WHAT SHIPPED — production as it now is
 *
 * A suite that reads PRODUCTION sits, before a deploy, in a window where its claim is
 * STRUCTURALLY unanswerable — and that window is exactly the one the deploy exists to close. It is
 * not wrong; it is EARLY.
 *
 * 🚨 AND IT IS THE ONLY SPECIES THAT GOES RED WHILE NOTHING IS BROKEN. The code is right, the guard
 * is right, and the failure is real — which is why it is so easily misread as flake, and why
 * folding it into flake is the expensive mistake. The other three all involve something genuinely
 * absent or ignored.
 *
 * ⭐ THE DISCRIMINATOR IS THE DEPLOY BOUNDARY, AND IT IS CHEAP: a suite that FAILS pre-deploy and
 * PASSES post-deploy on the SAME TREE is diagnosing phase, not flake. Flake does not correlate with
 * a deploy boundary. Run it again after the deploy before concluding anything.
 *
 * ⚠️ THE THREE RESPONSES ARE WRONG IN DISTINGUISHABLE WAYS:
 *     QUARANTINE hides a working check.
 *     LOOSENING removes a real one.
 *     MOVING puts it where it can be true.
 * The fix is PLACEMENT — relocate the suite in `deploy:prod` to sit beside `gate:deployed`, which
 * already asks the same kind of question at the only moment it is answerable.
 *
 * ⚠️ NOT YET OBSERVED. `test:prodsession` and `test:liveness` read production and currently run
 * PRE-deploy; on 2026-08-20 the gate passed 27/0 with seven unshipped copy corrections in the tree,
 * so neither noticed. That is a fact about WHAT THEY COVER, not evidence the phase problem is
 * absent — a suite in the unanswerable window is in it whether or not it happens to look.
 */

/**
 * 🚨 IF A SUITE EVER BLOCKS A DEPLOY SPURIOUSLY, QUARANTINE IT HERE WITH A REASON — DO NOT LOOSEN
 * `test:all`. `deploy:prod` now runs the aggregate first, so a flaky suite can hold up a ship, and
 * the pressure in that moment is to weaken the gate. That is how tolerated red gets reinvented one
 * level up: an exemption listed here stays visible, attributable and reversible; a loosened
 * assertion is invisible and permanent.
 *
 * ⚠️ AND THE LIKELIEST FIRST OFFENDERS ARE NOT THE TWO EXCLUDED BELOW. `test:liveness` and
 * `test:prodsession` are ALREADY inside `test:all` and both touch the network — they, not
 * `gate:pins`, are where the first spurious block will most likely come from. Naming them here so
 * the first flake gets a quarantine entry rather than an argument about the gate.
 */
export const UNWIRED_OK = {
  "gate:pins": "network-dependent (IPFS routing probes). ⚠️ A flaky network inside a BLOCKING aggregate manufactures tolerated red — species 3 — so it is run deliberately, not on every commit.",
  "test:ddwatch": "network-dependent (probes the live DD service). Same reasoning as gate:pins.",
  "gate:draft": "the deploy-preview variant of gate:watch; runs against a draft, not a checkout.",
  "test:vanillabyteslive": "network-dependent (eth_calls Arc's PUBLIC RPC, recorded as throttled and observed ETIMEDOUT 2026-08-23 mid-run). Same call as gate:pins: a flaky network inside a BLOCKING aggregate manufactures tolerated red. Its in-process half, test:vanillabytes, IS in test:all and asserts this file exists and stays registered — so splitting it out cannot become dropping it.",
};

/**
 * PASS-THROUGH rebuilds — code that carries already-vetted data forward. ⚠️ NOT exposure builders
 * (an endpoint choosing what leaves the server) and NOT hashed artifacts (a fixed field set): for
 * those an include-list is CORRECT. Only pass-throughs can silently LOSE a field, which is how
 * `synthesis` never once reached the screen.
 * ⭐ Each must be exercised by a suite fed a REAL RECORDED PAYLOAD — a hand-written fixture only
 * proves the code handles what its author imagined.
 */
export const PASSTHROUGH = [
  { site: "src/lib/mergeJobStatus.ts", suite: "verify-job-status-merge.tsx",
    fixture: "job-run-status-181281.json",
    why: "the client poll merge. Dropped `synthesis`/`secondOpinion` in every commit ever made." },
  { site: "netlify/functions/ub-withdraw.mjs (GET → UbExitStatus)", suite: "verify-ub-exit-view.tsx",
    fixture: "ub-withdrawal-16be509f.json",
    why: "the exit's read path, server projection into the component that renders it." },
];
