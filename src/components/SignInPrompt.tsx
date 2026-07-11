import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

// A signed-out state must be a DOOR, not a wall.
//
// The bug this fixes: the per-user Gateway UI correctly detected "signed out" and said
// "Sign in to see your balance" — but gave the user NO WAY TO DO IT. #/unified has no other
// sign-in affordance, so an expired session (30-min TTL) left the panel permanently dead:
// the deposit form was replaced by that text, so the Fund button didn't exist to click.
// The request was never even sent.
//
// Before the three-state refactor, the form was always rendered and clicking Fund called
// ensureSession(), which re-authenticates via passkey when the session has lapsed. That
// recovery path was the thing accidentally removed. This restores it explicitly.
//
// ensureSession() reuses a live token, or prompts the passkey when it has expired. It THROWS
// ("Connect a wallet first") when there's no wallet/credential at all — a different problem,
// so we route that case to the wallet page rather than showing a passkey prompt that cannot
// succeed.
export default function SignInPrompt({
  wallet: w,
  message,
  onSignedIn,
}: {
  wallet: UnifiedWallet;
  message: string;
  onSignedIn?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // No wallet/credential at all — signing in here is impossible; send them to connect one.
  const noWallet = !w.address;

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      await w.ensureSession(); // reuses a live token, or prompts the passkey if expired
      // isAuthenticated flips → useGatewayBalance re-polls on its own. onSignedIn lets the
      // caller refresh anything else it owns (e.g. the agent wallet record).
      onSignedIn?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sub" style={{ margin: 0 }}>
        {message}
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 8 }}>
        {noWallet ? (
          <button className="emerald" onClick={() => (window.location.hash = "/wallet")}>
            Connect a wallet
          </button>
        ) : (
          <button className="emerald" disabled={busy} onClick={signIn}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        )}
      </div>
      {error && (
        <div className="sub" style={{ margin: "8px 0 0", color: "var(--danger, #e5484d)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
