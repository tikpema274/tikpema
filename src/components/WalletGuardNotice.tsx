// WalletGuardNotice — the ONE two-state wallet guard for every self-signed panel.
//
// ═══ 🚨 THE DEFECT THIS EXISTS TO MAKE IMPOSSIBLE ══════════════════════════════════════════════
// `manual-send-design-note.md` recorded "gap 2 — the two-state copy collapse" and its fix: the
// panels must tell apart *"MetaMask is not connected"* from *"MetaMask is connected but another
// wallet is active"*. The fact needed to do that lives in the hook (`metamaskConnected: !!mmWallet`)
// and was exported precisely SO THAT EVERY PANEL WOULD GET IT — the note's words: "it is fixed
// FIRST, in the hook, where both panels get it — not worked around twice."
//
// ⛔ AND THEN ManualSwapPanel SHIPPED WITHOUT READING IT. It branched on `activeKind === "metamask"`
// alone, so a user with MetaMask connected but another wallet active was told to "Connect MetaMask"
// — advice to connect what they had already connected. MEASURED: its two renders were
// BYTE-IDENTICAL, while Send and Bridge were correctly distinct. The hook fix was made; the third
// panel simply did not use it.
//
// ⭐ SO THE GUARD IS A COMPONENT, AND IT TAKES `metamaskConnected` AS A REQUIRED PROP. A panel
// cannot now render this notice without supplying the fact that distinguishes the states. That is
// the difference between a fix and a fix that stays fixed.
//
// ⚠️ AND ITS SUITE MUST ASSERT NON-COLLAPSE DIRECTLY — "the two states render differently" — not
// merely that each contains some expected phrase. The swap panel's own suite DID assert a
// "connected but unable" case and passed, because it exercised `activeKind === "metamask"` with a
// missing capability rather than the connected-but-not-active state that actually collapsed.
// A guard blind to the defect it was written for is worse than no guard.
// [[state-behind-a-transition-is-untested-by-default]] · [[binding-tested-across-what-it-binds]]
import type { ReactNode } from "react";

export type WalletGuardProps = {
  /** ⭐ REQUIRED, and the whole point: `!!mmWallet` from the hook. Without it the states collapse. */
  metamaskConnected: boolean;
  /** Is MetaMask the ACTIVE wallet? Distinguishes "wrong wallet active" from "cannot sign here". */
  active: boolean;
  /** The operation, lowercase: "send" | "bridge" | "swap". Used in prose, so it must read naturally. */
  verb: string;
  /** Where the agent-run twin lives — the page NAME the user will see in the nav or on screen. */
  twinLabel: string;
  /** The hash route of that twin, e.g. "/send". */
  twinRoute: string;
  /**
   * ⭐⭐ REQUIRED, and for the same reason `metamaskConnected` is: a panel must not be able to
   * render this guard without it. Naming a state the user cannot act on is the defect SignInPrompt's
   * header records on #/unified — "a signed-out state must be a DOOR, not a wall… gave the user NO
   * WAY TO DO IT." 🚨 And here there was no door anywhere in the app: ConnectPasskey gates its whole
   * connect block on `!w.address` and the Dashboard card on `!w.agentWallet`, so a user signed in
   * with a passkey — this guard's most likely reader — had nowhere to go. `setActiveKind` is never
   * called outside the hook, so there is no wallet switcher either. Wire this to
   * `w.connectMetaMask()`, which is the ONLY mechanism that makes MetaMask active.
   */
  onConnect: () => void;
  /** Disables the action while a connect is in flight — `w.busy`. */
  busy?: boolean;
  /**
   * ⚠️ Is there a session to lose? `connectMetaMask()` calls `clearSession()`, so it REPLACES the
   * active wallet rather than adding one. That is worth saying to someone signed in and FALSE for
   * someone who is not, so it is a prop rather than a constant — pass `!!w.address`.
   */
  replacesSession?: boolean;
};

/**
 * ⭐ THREE HONEST STATES, not two. The third is what the swap panel was really branching on:
 * MetaMask IS active, but this page still cannot sign — which is neither "connect" nor "switch".
 * Telling a user to connect or switch in that state is advice they cannot act on.
 */
export type WalletGuardState = "connect" | "switch" | "cannot-sign";

/**
 * ⭐⭐ THE DECISION, SHARED SEPARATELY FROM THE SENTENCE — and this split is the point.
 *
 * `SelfSignedPanel` needed the same three-way distinction and could not use this component: its
 * copy is PLURAL and page-shaped ("use these", "the agent-run versions"), where `verb`/`twinLabel`/
 * `twinRoute` describe ONE operation and the page covers three. So it branched on `activeKind`
 * alone, never read `metamaskConnected`, and its two guarded renders came out BYTE-IDENTICAL — the
 * exact defect this file's header says it exists to prevent, re-created on a surface written the
 * same day.
 *
 * ⛔ Sharing the SENTENCE was not available; sharing the DECISION is. A caller cannot reach a state
 * without passing the fact that distinguishes it, which is the same property `metamaskConnected`
 * being a required prop gives the component. What each surface then SAYS is legitimately its own.
 * ⚠️ Which is why the suite asserts PAIRWISE INEQUALITY on the page's renders and not a phrase: a
 * shared decision function cannot by itself guarantee two distinct sentences come out.
 */
export function walletGuardState(
  { metamaskConnected, active }: { metamaskConnected: boolean; active: boolean },
): WalletGuardState {
  if (metamaskConnected && active) return "cannot-sign";
  if (metamaskConnected) return "switch";
  return "connect";
}

export default function WalletGuardNotice({
  metamaskConnected, active, verb, twinLabel, twinRoute, onConnect, busy, replacesSession,
}: WalletGuardProps): ReactNode {
  const state = walletGuardState({ metamaskConnected, active });

  // ⭐ THE DOOR. One action for all three states, because there IS only one mechanism —
  // `connectMetaMask()` sets the active wallet — but the label names what the reader is doing.
  const action = (
    <div style={{ marginTop: 8 }}>
      <button className="emerald" disabled={busy} onClick={onConnect}>
        {state === "connect" ? "Connect MetaMask" : state === "switch" ? "Switch to MetaMask" : "Reconnect MetaMask"}
      </button>
      {replacesSession && (
        <div className="sub" style={{ margin: "6px 0 0" }}>
          This switches your active wallet and will end your current session.
        </div>
      )}
    </div>
  );
  const twin = (
    <>
      {" "}The agent {verb} is on the{" "}
      <button className="linkbtn" onClick={() => (window.location.hash = twinRoute)}>{twinLabel}</button>{" "}
      page.
    </>
  );

  if (state === "cannot-sign") {
    // ⚠️ Reached only when the panel's own capability check failed while MetaMask IS active.
    // Neither "connect" nor "switch" is true here, and saying either would be a false instruction.
    return (
      <div className="sub" style={{ marginBottom: 0 }}>
        MetaMask is active, but this page cannot sign a {verb} right now. Reconnect MetaMask and try
        again.{twin}
        {action}
      </div>
    );
  }
  if (state === "switch") {
    // 🚨 THE STATE THAT COLLAPSED. They HAVE MetaMask — do not tell them to connect it.
    return (
      <div className="sub" style={{ marginBottom: 0 }}>
        Switch to MetaMask to {verb} with your own key — it is connected, but another wallet is
        active right now.{twin}
        {action}
      </div>
    );
  }
  return (
    <div className="sub" style={{ marginBottom: 0 }}>
      Connect MetaMask to {verb} with your own key.{twin}
      {action}
    </div>
  );
}
