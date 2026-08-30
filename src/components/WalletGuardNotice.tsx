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
};

/**
 * ⭐ THREE HONEST STATES, not two. The third is what the swap panel was really branching on:
 * MetaMask IS active, but this page still cannot sign — which is neither "connect" nor "switch".
 * Telling a user to connect or switch in that state is advice they cannot act on.
 */
export default function WalletGuardNotice({
  metamaskConnected, active, verb, twinLabel, twinRoute,
}: WalletGuardProps): ReactNode {
  const twin = (
    <>
      {" "}The agent {verb} is on the{" "}
      <button className="linkbtn" onClick={() => (window.location.hash = twinRoute)}>{twinLabel}</button>{" "}
      page.
    </>
  );

  if (metamaskConnected && active) {
    // ⚠️ Reached only when the panel's own capability check failed while MetaMask IS active.
    // Neither "connect" nor "switch" is true here, and saying either would be a false instruction.
    return (
      <div className="sub" style={{ marginBottom: 0 }}>
        MetaMask is active, but this page cannot sign a {verb} right now. Reconnect MetaMask and try
        again.{twin}
      </div>
    );
  }
  if (metamaskConnected) {
    // 🚨 THE STATE THAT COLLAPSED. They HAVE MetaMask — do not tell them to connect it.
    return (
      <div className="sub" style={{ marginBottom: 0 }}>
        Switch to MetaMask to {verb} with your own key — it is connected, but another wallet is
        active right now.{twin}
      </div>
    );
  }
  return (
    <div className="sub" style={{ marginBottom: 0 }}>
      Connect MetaMask to {verb} with your own key.{twin}
    </div>
  );
}
