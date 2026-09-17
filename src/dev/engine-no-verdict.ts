// engine-no-verdict.ts — the power-surface-unrecognised refusal, TAKEN FROM THE ENGINE, not hand-copied.
//
// ⭐ WHY THIS EXISTS. The #/dev/dd-card fixture and the card-copy test (scripts/verify-dd-card-copy.tsx)
// both need the NO-VERDICT refusal the DD card renders. The detail string lives INLINE in the engine
// (shared/onchain-analyze/index.mjs) — on the DD surface, so it cannot be exported without rotating
// ddTree. Hand-copying it drifted: the fixtures said "This address IS an ERC-4626 vault" while the
// engine, since the ≥1-hit gate, says "presents an ERC-4626 vault surface (fully or partially)". So
// instead of copying the words we RUN the engine — analyze() an unrecognised ERC-4626 vault surface
// and read back its ACTUAL refusal. The browser dev card and the Node test then show the exact wording
// the paid endpoint would, and drift is impossible.
//
// ⛔ DEV/TEST ONLY. Imported only from src/dev (DEV-gated in App.tsx, excluded from the prod build) and
// from the card-copy test. Uses the offline mock chain — no RPC, no real address, no network.
import { analyze } from "../../shared/onchain-analyze/index.mjs";
import { ERC4626_METHODS } from "../../shared/onchain-facts/vault-profiles.mjs";
import { EIP1967_IMPL_SLOT } from "../../shared/onchain-facts/index.mjs";
import { mockClient, codeWith, SUBJ, OWNER, ZERO_WORD, word } from "../../scripts/dd/_mock-chain.mjs";

// A Morpho-shaped (unrecognised) governance surface over the full ERC-4626 interface — the same
// "unrecognised vault" input the recognition-agreement suite uses. ANY unrecognised vault yields the
// same refusal; the exact governance selectors don't matter, only that no profile recognises them.
const MORPHO_GOV = ["setFee(uint96)", "setCurator(address)", "setIsSentinel(address,bool)", "setSendSharesGate(address)"];
const handlers = {
  [`code@${SUBJ}`]: codeWith([...ERC4626_METHODS, ...MORPHO_GOV]),
  [`slot@${EIP1967_IMPL_SLOT}`]: ZERO_WORD,
  [`call@0x8da5cb5b`]: word(OWNER), // owner()
  [`code@${OWNER}`]: "0x",
};

// The real engine output for an unrecognised vault. Top-level await: the module resolves only once
// analyze() has produced the report, so importers see a settled value.
export const engineNoVerdictReport = await analyze(SUBJ, { client: mockClient(handlers) });

// LOUD if the engine ever stops producing this refusal for an unrecognised vault — the fixture and the
// test must never silently fall back to a stale, clean, or differently-shaped result.
if (engineNoVerdictReport.refusal?.reason !== "power-surface-unrecognised") {
  throw new Error(
    `engine-no-verdict: expected a power-surface-unrecognised refusal from analyze(), got ${JSON.stringify(engineNoVerdictReport.refusal)}`,
  );
}

/** The engine's ACTUAL `{ reason, detail }` for a no-verdict vault — the words the DD card renders. */
export const engineNoVerdictRefusal = engineNoVerdictReport.refusal as { reason: string; detail: string };
