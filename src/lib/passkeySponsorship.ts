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

// ⭐ TYPED, never the wording (test:proserecovery): Circle's SDK awaits navigator.credentials.get/create OUTSIDE any try, so a
// cancelled prompt arrives as the browser's own DOMException — `name` NotAllowedError (or AbortError). A wallet's rejection is
// EIP-1193 code 4001 (viem's UserRejectedRequestError carries it).
export function isPasskeyCancel(e: unknown): boolean {
  const v = e as { name?: unknown; code?: unknown } | null;
  return v?.name === "NotAllowedError" || v?.name === "AbortError" || v?.code === 4001;
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

// ═══ CONNECT (sign in / create with a passkey) — 2026-10-09, T ════════════════════════════════
// The same outage hit "Connect a passkey": the panel showed "Error: Missing or invalid parameters… Version: viem@2.52.2".
// Connecting is not a user-op and moves nothing, so its line says nothing about gas sponsorship (T: "Do NOT mention gas
// sponsorship there"). Only a failure FROM CIRCLE'S SERVICE (a viem RPC/HTTP error, including a request that never got an answer) gets it; a passkey
// cancel and our own messages pass through.
export const WALLET_SERVICE_LINE = "Circle's wallet service didn't respond. Nothing was changed. Try again in a few minutes.";

// ⭐ TYPED: everything that fails inside a viem transport — Circle's RPC answer, an HTTP error, even a raw network TypeError —
// reaches us as a viem BaseError (buildRequest wraps the unknown as UnknownRpcError), which carries `shortMessage` and
// `version` as FIELDS. So the error's class marks it; its wording is never read.
export function isCircleServiceFailure(e: unknown): boolean {
  if (!e || isPasskeyCancel(e)) return false;
  const v = e as { name?: unknown; shortMessage?: unknown; version?: unknown };
  if (typeof v.shortMessage === "string" && typeof v.version === "string") return true;      // a viem BaseError
  return typeof v.name === "string" && /RpcError|RpcRequestError|HttpRequestError|TimeoutError/.test(v.name);
}

/** What the connect status line shows for a failure: our line for Circle's service, else the message as is. */
export function connectFailureLine(e: unknown): string {
  if (isCircleServiceFailure(e)) return WALLET_SERVICE_LINE;
  return String((e as { message?: unknown } | null)?.message ?? e);
}
