// ubExitProof.ts — THE ONE record of the single end-to-end unified-balance exit that has run.
//
// ⭐ WHY THIS EXISTS. Two surfaces cite the same dated proof — YourMoney's "Not included" note and
// UnifiedBalancePanel's evidence disclosure. Both hand-copied "1 USDC … 2026-08-12 … 2026-08-20 …
// 7 days and 4 hours"; a duplicated fact drifts the moment one copy is edited and the other is not.
// [[duplicate-source-of-truth-is-the-recurring-bug]]
//
// ⭐ WHY A CONSTANT AND NOT A LIVE READ. This is a FIXED HISTORICAL FACT — a past completed run
// (16be509f, initiated 2026-08-12, completed 2026-08-20), not a live figure. It does not change, and
// wiring a display string to an async /api/ub-withdraw read would add a fetch and its failure modes
// to a static proof. The live withdrawal record is the RIGHT source only for something that moves;
// this does not, so one shared constant is the honest single source. Update it here if a second
// real run is ever cited — and both surfaces move together.
//
// ⚠️ The surrounding PROSE differs between the two surfaces by design (each frames the same facts in
// its own voice); only the VALUES below are shared. Guarded by verify-unified-balance-copy.tsx.
export const UB_EXIT_PROOF = {
  amount: "1 USDC",
  askedDate: "2026-08-12",
  returnedDate: "2026-08-20",
  duration: "7 days and 4 hours",
} as const;
