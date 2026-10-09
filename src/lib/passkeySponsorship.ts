// passkeySponsorship.ts — A PASSKEY USER-OP THAT CIRCLE REFUSES, IN OUR WORDS.
//
// ═══ THE OUTAGE ═══════════════════════════════════════════════════════════════════════════════
// 2026-10-08: Circle paused Modular Wallets on every network (status.circle.com incident q2q22hphfrb1, 16:47 UTC), then
// re-enabled them at 21:56 UTC with the PAYMASTER (gas sponsorship) still paused. Every passkey user-op here asks for it
// (`paymaster: true`), so each one failed with Circle's text through viem — "Missing or invalid parameters… the specified
// blockchain is either not supported or deprecated. Version: viem@2.52.2", later "An internal error was received".
//
// ═══ ⛔ THE BOUNDARY (same rule as shared/swap-no-route.mjs) ══════════════════════════════════
// "Nothing was transferred" is said ONLY for a failure BEFORE the bundler accepted the user-op (fees, nonce, sponsorship,
// estimation, submission). A failure WAITING for the receipt means the op was accepted and may still land → "not confirmed
// yet", never "nothing". A passkey cancel passes through untouched. A two-step flow (approve → act) names the approval that
// already landed in this attempt — it moves nothing by itself, but the user should know it is there.

export const CIRCLE_PAUSED_LINE =
  "Circle's gas sponsorship is paused right now. Nothing was transferred — your USDC is still in your wallet. Try again later.";
export const APPROVAL_LANDED_LINE =
  "The approval from the first step of this attempt is still in place; it moves nothing on its own.";
export const UNCONFIRMED_LINE =
  "Your transaction was handed to the network but isn't confirmed yet. Don't send it again — check your activity in a few minutes.";

export type PasskeyPhase = "not-sent" | "sent-unconfirmed";
export type PasskeyError = Error & { tikpemaPhase: PasskeyPhase; cause?: unknown };

export function isPasskeyCancel(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return true;
  const msg = String((e as { message?: unknown } | null)?.message ?? e ?? "");
  return /NotAllowed|aborted|cancel|user rejected/i.test(msg);
}

function tagged(message: string, phase: PasskeyPhase, cause: unknown): PasskeyError {
  return Object.assign(new Error(message, { cause }), { tikpemaPhase: phase }) as PasskeyError;
}

/** A failure BEFORE the bundler accepted the op → our line (Circle's error kept as `cause`). A cancel passes through. */
export function notSentError(e: unknown, opts: { approvalLanded?: boolean } = {}): unknown {
  if (isPasskeyCancel(e)) return e;
  if ((e as PasskeyError | null)?.tikpemaPhase) return e;
  return tagged(opts.approvalLanded ? `${CIRCLE_PAUSED_LINE} ${APPROVAL_LANDED_LINE}` : CIRCLE_PAUSED_LINE, "not-sent", e);
}

/** A failure AFTER the bundler accepted the op: it may still land. */
export function unconfirmedError(e: unknown): unknown {
  if ((e as PasskeyError | null)?.tikpemaPhase) return e;
  return tagged(UNCONFIRMED_LINE, "sent-unconfirmed", e);
}

/** Run the steps BEFORE a submission is accepted (fees, nonce, sendUserOperation). */
export async function beforeAccepted<T>(step: () => Promise<T>, opts: { approvalLanded?: boolean } = {}): Promise<T> {
  try { return await step(); } catch (e) { throw notSentError(e, opts); }
}

/** Wait for an ACCEPTED op's receipt. */
export async function afterAccepted<T>(step: () => Promise<T>): Promise<T> {
  try { return await step(); } catch (e) { throw unconfirmedError(e); }
}
