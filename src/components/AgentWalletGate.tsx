import type { useWallet } from "../wallet/useWallet";
import SignInPrompt from "./SignInPrompt";
import { goToWalletAndReturn } from "../lib/returnTo";

type UnifiedWallet = ReturnType<typeof useWallet>;

// AgentWalletGate — what a page that SPENDS FROM the agent wallet shows while `w.agentWallet` is null.
//
// ═══ FOUR STATES, NOT ONE (live proof, 2026-09-19) ═══════════════════════════════════════════════
// `!w.agentWallet` is true in four different situations, and until now Pay and Send rendered all four
// as "Set up your wallet first — open Wallet". Three of those were wrong, and the fourth was a dead
// end: a buyer whose /api/my-wallet resolve had FAILED sat on that sentence forever, with no reason
// and no retry, because the failure was swallowed in the hook. [[absence-must-never-read-as-safe]]
//
//   no login wallet (`!w.address`)              → connect one — the ONLY case that leaves the page,
//                                                 and it leaves WITH a return-to (goToWalletAndReturn)
//   wallet, no session (`!w.isAuthenticated`)   → Sign in HERE (SignInPrompt); the user never leaves
//                                                 the order / payment link they are on
//   session, resolve in flight                  → "Preparing your agent wallet…" — it is CREATED for
//                                                 them, needs no funds, nothing to do but wait
//   session, resolve FAILED (`agentWalletError`) → the reason, "nothing was <verb>", and RETRY
//
// ⛔ NOT "connect and fund it": funding is not checked here and does not unblock anything. The
// pre-existing sentence had already been corrected on that point; the four-way split keeps it.
// ⚠️ AGENT voice: needs the agent wallet, points at Wallet. Not to be merged with the self-signed
// voice, which needs MetaMask ACTIVE and points at the landing page.
export default function AgentWalletGate({
  wallet: w,
  verb,
  nothingHappened,
}: {
  wallet: UnifiedWallet;
  /** What the page does once unblocked — "pay", "send", "bridge". Used in "come back here to <verb>". */
  verb: string;
  /** The reassurance in the failed state — "Nothing was paid." / "Nothing was sent." */
  nothingHappened: string;
}) {
  if (!w.address) {
    return (
      <div className="status">
        Set up your wallet first — open{" "}
        <button className="linkbtn" onClick={goToWalletAndReturn}>Wallet</button>{" "}
        to connect one, then come back here to {verb}. (You will be brought back to this page.)
      </div>
    );
  }
  if (!w.isAuthenticated) {
    return (
      <div className="status">
        <SignInPrompt
          wallet={w}
          message={`Your wallet is connected. Sign in (one passkey tap) to prepare your agent wallet and ${verb} from it — you stay on this page.`}
          onSignedIn={() => { w.refreshAgentWallet().catch(() => { /* recorded as agentWalletError */ }); }}
        />
      </div>
    );
  }
  if (w.agentWalletError) {
    return (
      <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
        <b>Couldn't prepare your agent wallet.</b> {w.agentWalletError}. {nothingHappened}{" "}
        <button className="linkbtn" onClick={() => { w.refreshAgentWallet().catch(() => { /* recorded */ }); }}>
          Retry
        </button>{" "}
        · or open{" "}
        <button className="linkbtn" onClick={goToWalletAndReturn}>Wallet</button>
      </div>
    );
  }
  return (
    <div className="status">
      <span className="spinner" /> <b>Preparing your agent wallet…</b> This is the wallet that {verb}s for you. It is
      created for your login and needs no funds to be created — nothing to do but wait a moment.
    </div>
  );
}
