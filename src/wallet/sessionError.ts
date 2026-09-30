// sessionError.ts — WHY a sign-in did not produce a session, classified so the screen can say it honestly.
//
// ⭐ A CANCELLED PROMPT IS NOT A REFUSAL (T, 2026-09-30). webauthn-p256's sign() wraps EVERY
// navigator.credentials.get failure as Error("credential request failed.", { cause }), so pressing Escape
// used to render "Sign-in was refused. credential request failed." — an error, when the user simply
// changed their mind. Three kinds:
//   · refused   — the SERVER said no (auth-challenge / auth-verify non-OK). Its words, verbatim.
//   · cancelled — the prompt ended without a signature: NotAllowedError / AbortError. The browser does not
//                 tell a dismissal from a timeout, so neither is called a failure. Nothing was signed.
//   · failed    — anything else (network, another credential error): its own reason, never "refused".
export type SessionError = { kind: "refused" | "cancelled" | "failed"; message: string };

const CANCEL_NAMES = new Set(["NotAllowedError", "AbortError"]);

export function classifySessionError(e: unknown): SessionError {
  const err = e as { serverRefusal?: boolean; message?: string; name?: string; cause?: unknown } | null;
  if (err && err.serverRefusal) return { kind: "refused", message: String(err.message ?? "") };
  // Walk the cause chain: the browser's DOMException sits under webauthn-p256's wrapper.
  for (let cur: any = err, depth = 0; cur && depth < 5; cur = cur.cause, depth++) {
    if (CANCEL_NAMES.has(cur.name)) {
      return { kind: "cancelled", message: "The passkey prompt was closed before it signed anything." };
    }
  }
  if (err instanceof Error) {
    // The wrapper's own text says nothing; prefer the browser's reason underneath it.
    const inner = (err.cause as { message?: string } | undefined)?.message;
    const message = err.message === "credential request failed." && inner ? inner : err.message;
    return { kind: "failed", message: message || String(e) };
  }
  return { kind: "failed", message: String(e) };
}
