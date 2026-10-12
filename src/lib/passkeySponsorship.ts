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

// ═══ (2026-10-12, T: "fix tikpema passkey") THE STEP THAT FAILED, NOT ALWAYS "SPONSORSHIP PAUSED" ═══════════════════
// The line above was shown for EVERY failure before acceptance — a fee read, the gas estimate, the send after the passkey
// signed — and Circle's real error was kept only as `cause`, which nothing shows. TikpemaPay hit the same thing live on
// 2026-10-11 (an Arbitrum fee refusal shown as "sponsorship refused") and fixed it there (src/wallet-lines.mjs walletError);
// this is the same fix. The modular transport is wrapped (recordCalls): each Circle call that FAILS is recorded — its method,
// code and Circle's message — and the line names THE STEP:
//   pm_getPaymasterStubData / pm_getPaymasterData → "Circle's gas sponsorship refused this." (ONLY these)
//   eth_estimateUserOperationGas → "Circle couldn't estimate the transaction."
//   eth_sendUserOperation → "Sending failed after you signed — Circle didn't accept it." (a JSON-RPC answer = refused, so
//                           nothing was sent; NO answer = it may have arrived → "not known", never "nothing was transferred")
//   circle_getAddress / circle_getAddressMapping → "Circle couldn't look up your wallet."
//   any other call (fees, nonce, block) → "Circle couldn't read the network."; nothing recorded → "The wallet couldn't complete this."
// …then what is TRUE, then "(Details: the call · its code · Circle's message)" — never a key, a request body or a signature.

export const NOTHING_SENT = "Nothing was transferred — your USDC is still in your wallet.";
export const STEP_LINE = Object.freeze({
  sponsor: "Circle's gas sponsorship refused this.",
  estimate: "Circle couldn't estimate the transaction.",
  send: "Sending failed after you signed — Circle didn't accept it.",
  lookup: "Circle couldn't look up your wallet.",
  read: "Circle couldn't read the network.",
  unknown: "The wallet couldn't complete this.",
});
export type PasskeyStep = keyof typeof STEP_LINE;
const STEP_OF: Record<string, PasskeyStep> = {
  pm_getPaymasterStubData: "sponsor", pm_getPaymasterData: "sponsor", eth_estimateUserOperationGas: "estimate",
  eth_sendUserOperation: "send", circle_getAddress: "lookup", circle_getAddressMapping: "lookup",
};
export const APPROVAL_LANDED_LINE =
  "The approval from the first step of this attempt is still in place; it moves nothing on its own.";
export const UNCONFIRMED_LINE =
  "Your transaction was handed to the network but isn't confirmed yet. Don't send it again — check your activity in a few minutes.";
export const SEND_UNKNOWN_LINE =
  "Sending failed after you signed, and it isn't known whether Circle received it. Don't send it again yet — check your activity in a few minutes.";

export type PasskeyPhase = "not-sent" | "sent-unconfirmed";
export type PasskeyError = Error & { tikpemaPhase: PasskeyPhase; tikpemaStep?: PasskeyStep; tikpemaDetails?: string; cause?: unknown };
export type CallFailure = { method: string | null; code: number | null; message: string | null };

// ⭐ TYPED, never the wording (test:proserecovery): Circle's SDK awaits navigator.credentials.get/create OUTSIDE any try, so a
// cancelled prompt arrives as the browser's own DOMException — `name` NotAllowedError (or AbortError). A wallet's rejection is
// EIP-1193 code 4001 (viem's UserRejectedRequestError carries it).
export function isPasskeyCancel(e: unknown): boolean {
  const v = e as { name?: unknown; code?: unknown } | null;
  return v?.name === "NotAllowedError" || v?.name === "AbortError" || v?.code === 4001;
}

/** What a failed call said: Circle's own code + message sit on the innermost error; viem wraps them. */
export function failureOf(e: unknown): { code: number | null; message: string | null } {
  let code: number | null = null, message: string | null = null;
  let x = e as { code?: unknown; status?: unknown; details?: unknown; message?: unknown; cause?: unknown } | null;
  for (let i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    if (typeof x.code === "number" && x.code !== -1) code = x.code;
    if (typeof x.status === "number" && code == null) code = x.status;
    const m = typeof x.details === "string" && x.details ? x.details : typeof x.message === "string" ? x.message : null;
    if (m) message = m;
  }
  return { code, message };
}

/** THE log of failed Circle calls (newest last, at most 50) — filled by recordCalls, read by beforeAccepted. */
export const passkeyCalls: CallFailure[] = [];

/** Wrap a viem transport so every request that FAILS is recorded (method, code, message) before it is rethrown. */
export function recordCalls<T extends (...a: any[]) => any>(transport: T, log: CallFailure[] = passkeyCalls): T {
  return ((opts: unknown) => {
    const t = transport(opts);
    return { ...t, async request(args: { method?: unknown }, o?: unknown) {
      try { return await t.request(args, o); }
      catch (e) { log.push({ method: String(args?.method ?? ""), ...failureOf(e) }); if (log.length > 50) log.splice(0, log.length - 50); throw e; }
    } };
  }) as unknown as T;
}

/** The call that failed this step: the LAST recorded failure (the SDK's own gas-price probe aside — it recovers from that). */
export function failedCall(calls: CallFailure[] = []): CallFailure | null {
  return [...calls].reverse().find((c) => c?.method !== "circle_getUserOperationGasPrice") ?? null;
}

const SECRETS = /(Bearer\s+\S+|(TEST|LIVE)_CLIENT_KEY:\S+|(TEST|LIVE)_API_KEY:\S+|0x[0-9a-fA-F]{130,})/g;
/** "eth_estimateUserOperationGas · -32500 · AA21 didn't pay prefund" — one line, no viem version, nothing secret. */
export function detailsLine({ method = null, code = null, message = null }: Partial<CallFailure> = {}): string {
  const m = String(message ?? "").replace(/\n?Version: viem@\S+/g, "").replace(/\s+/g, " ").replace(SECRETS, "[hidden]").trim().slice(0, 240);
  return [method || "—", code ?? "no code", m || "no message"].join(" · ");
}

function tagged(message: string, phase: PasskeyPhase, cause: unknown, extra: Partial<PasskeyError> = {}): PasskeyError {
  return Object.assign(new Error(message, { cause }), { tikpemaPhase: phase }, extra) as PasskeyError;
}

/** A failure BEFORE the bundler accepted the op → the failing step's line + what is true + Details. A cancel passes through.
 *  @param opts.calls the failed Circle calls recorded DURING this step (beforeAccepted passes them) */
export function notSentError(e: unknown, opts: { approvalLanded?: boolean; calls?: CallFailure[] } = {}): unknown {
  if (isPasskeyCancel(e)) return e;
  if ((e as PasskeyError | null)?.tikpemaPhase) return e;
  const c = failedCall(opts.calls ?? []);
  const f: CallFailure = c ?? { method: null, ...failureOf(e) };
  const step: PasskeyStep = (f.method && STEP_OF[f.method]) || (f.method ? "read" : "unknown");
  const details = detailsLine(f);
  if (step === "send" && f.code == null)      // the request got no answer: it may have reached Circle
    return tagged(`${SEND_UNKNOWN_LINE} (Details: ${details})`, "sent-unconfirmed", e, { tikpemaStep: step, tikpemaDetails: details });
  const line = [STEP_LINE[step], NOTHING_SENT, opts.approvalLanded ? APPROVAL_LANDED_LINE : ""].filter(Boolean).join(" ");
  return tagged(`${line} (Details: ${details})`, "not-sent", e, { tikpemaStep: step, tikpemaDetails: details });
}

/** A failure AFTER the bundler accepted the op: it may still land. */
export function unconfirmedError(e: unknown): unknown {
  if ((e as PasskeyError | null)?.tikpemaPhase) return e;
  return tagged(UNCONFIRMED_LINE, "sent-unconfirmed", e);
}

/** Run the steps BEFORE a submission is accepted (fees, nonce, sendUserOperation). Only the calls that failed DURING this
 *  step name it. */
export async function beforeAccepted<T>(step: () => Promise<T>, opts: { approvalLanded?: boolean } = {}, log: CallFailure[] = passkeyCalls): Promise<T> {
  const from = log.length;
  try { return await step(); } catch (e) { throw notSentError(e, { ...opts, calls: log.slice(from) }); }
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
