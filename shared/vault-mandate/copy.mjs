// copy.mjs — disclosure sentences T approved word for word (2026-09-25). Pinned verbatim by
// test:mandatecannotpay. ⛔ Do not soften them: "We can't recover them for you." stays.
// The mandate record (piece 3) renders these beside the vault's fee cap figure.

// ⭐ ONE ENDING, TWO OPENINGS (T, 2026-09-26). The ending is written once so the two paragraphs cannot drift;
// test:mandatecannotpay still pins each full paragraph verbatim.
const CANNOT_PAY_ENDING =
  "it may be short of USDC, its owner can move the funds out at any time, and USDC itself can refuse a transfer. We check " +
  "whether the vault could pay you at the moment we check, but that can change in the next block. If a vault can't pay, " +
  "your mandate pauses and your shares stay where they are. We can't recover them for you.";

/** Beside every mandate that has any exit rule — including one that ALSO has vault-cannot-pay (exit wins). */
export const EXIT_NOT_GUARANTEED =
  "An exit is not guaranteed. When one of your rules says exit, we ask the vault to pay you. The vault may not be able to: " +
  CANNOT_PAY_ENDING;

/**
 * Beside a vault-cannot-pay rule on a mandate with NO exit rule (T, 2026-09-26). The paragraph belongs there — the
 * vault may be unable to pay you back — but "when one of your rules says exit" was untrue on it. Never beside
 * EXIT_NOT_GUARANTEED: a disclosure carries one or the other (renderDisclosure, record.mjs).
 */
export const PAYOUT_NOT_GUARANTEED =
  "Getting your USDC back is not guaranteed. When you withdraw, the vault has to pay you, and it may not be able to: " +
  CANNOT_PAY_ENDING;

/** Beside every rule set to exit: the exit fee is set by the party being exited. */
export const EXIT_FEE_RISE =
  "If the owner raises the exit fee to its cap and your rule exits, you pay that raised fee to leave.";

// ── The three provenance paragraphs, verbatim from PROGRESS.md "VAULT MANDATE — POST-DEPOSIT
// ASSERTION + DISCLOSURE WORDING" (2026-09-25). Every rule line in a disclosure names which of
// the first two it rests on.
export const VERIFIED_PARAGRAPH =
  "Verified by a signed report — anyone can check it. Who controls this vault and what they can do with your " +
  "deposit comes from a signed due-diligence report (Tikpema DD, agentId 851891). You or anyone else can verify it " +
  "against the chain without trusting us.";
export const MONITORED_PARAGRAPH =
  "Monitored by Tikpema — our own reading. Fees, whether you can withdraw in full, and the vault's share price " +
  "come from our own reads of the vault, taken before each deposit. They aren't signed, so here you're relying on " +
  "us. They exist to pause your mandate early when something changes, and every figure we act on is recorded in " +
  "your receipt with the block it came from.";
export const CHECKED_AFTER_PARAGRAPH =
  "Checked after each deposit. We compare the shares you received with what the vault quoted. Because both " +
  "come from the chain, anyone can re-read them from the transaction in your receipt.";
