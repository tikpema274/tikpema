// SelfSignedPanel — the three operations you sign yourself, in one place.
//
// ═══ ⭐ NAMED FOR WHO CAN MOVE IT WITHOUT YOU, NOT FOR THE WALLET BRAND ═════════════════════════
// NOT "your own wallet": the AGENT wallet is the user's own too — a per-user SCA holding their
// money — so ownership does not discriminate between the two pages at all. What differs is that on
// the agent page the agent can move funds unattended within caps, and here nobody can but the user.
// ⭐ "Self-signed" names the ACT THAT CAUSES the property, so the page's one shared claim follows
// from its title, and it survives a second connector — a Ledger or WalletConnect session is still
// self-signed, where a page named for MetaMask would age badly.
// ⚠️ The HEADING carries the meaning for the reader; the route carries durability. See
// docs/self-signed-page-scope.md.
//
// ═══ ⛔ DELIBERATELY NOT IN THE NAV, AND THAT IS A POSITIONING DECISION ═════════════════════════
// Every panel here makes one claim the agent panels do not: caps do not apply. That claim is
// CONTRASTIVE — "an absence stated against silence tells the reader nothing" (verify-send-copy). A
// top-level nav entry would let someone arrive having never seen the capped panel, where the
// sentence reads as REASSURANCE rather than as the removal of a guard. The route in is doing
// disclosure work. ⭐ Reached instead from a Dashboard card and from each agent panel's twin link —
// four ways in, none requiring a typed hash, which is the difference from #/dca's 22-day
// invisibility (that had ZERO entry points, not a missing nav item).
//
// 🚨 THE TWIN LINKS BOTH WAYS ARE LOad-BEARING AND MUST NOT BE TIDIED AWAY. Agent panel → its manual
// twin is how a reader arrives having just seen the caps stated. This page → each operation is what
// stops the page being the thing nothing links to.
import { walletGuardState } from "./WalletGuardNotice";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

const OPS = [
  { route: "send-manual",   title: "Send",   blurb: "Move USDC to any address on Arc.", twin: "Send" },
  { route: "bridge-manual", title: "Bridge", blurb: "Move USDC to another chain via CCTP.", twin: "Bridge" },
  { route: "swap-manual",   title: "Swap",   blurb: "Convert between USDC and EURC on Arc.", twin: "Swap" },
];

export default function SelfSignedPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const isMetaMask = w.activeKind === "metamask";
  return (
    <div className="plane">
      <div className="panel-eyebrow">Self-signed</div>
      <h2>Operations you sign yourself</h2>
      {/* ⭐ THE CONTRAST IS STATED HERE, ONCE, so a reader arriving from the Dashboard gets the
          frame the twin links would otherwise have given them. */}
      <div className="sub">
        These move money from the wallet you connected, and nothing moves until you sign it in your
        wallet. Your agent cannot run them on your behalf — which is also why{" "}
        <b>its spending caps do not bound them</b>. To use the capped, agent-run versions instead,
        open the matching page from the list below.
      </div>

      {/* ═══ 🚨 THIS GUARD HAD COLLAPSED, ON THE PAGE, AFTER THE PANELS WERE FIXED ═══════════════
          It branched on `activeKind` alone and never read `metamaskConnected`, so "MetaMask
          connected but another wallet active" rendered BYTE-IDENTICALLY to "not connected" —
          telling the user to connect what they already had. That is the same defect
          WalletGuardNotice exists to prevent, on a surface written the same day as it.
          ⭐ It cannot render this component: `verb`/`twinLabel`/`twinRoute` describe ONE operation
          and this page covers three, and its copy is plural. So it shares the DECISION instead —
          `walletGuardState` — and says the page-shaped thing for each state.
          ⚠️ `active` is FALSE by construction here (this block renders only when `!isMetaMask`, and
          `isMetaMask` has no capability term on this page), so the state is "connect" or "switch"
          and never "cannot-sign". Adding a capability term to `isMetaMask` above would make the
          third state reachable and would need a third branch here. */}
      {!isMetaMask && (
        <div className="status" style={{ borderLeft: "3px solid var(--warn)", paddingLeft: ".9rem" }}>
          {walletGuardState({ metamaskConnected: !!w.metamaskConnected, active: isMetaMask }) === "switch" ? (
            <>
              Switch to MetaMask to use these — it is connected, but another wallet is active right
              now. Each one is signed with your own key; the agent-run versions work with any wallet.
            </>
          ) : (
            <>
              Connect MetaMask to use these — each one is signed with your own key. The agent-run
              versions work with any wallet.
            </>
          )}
        </div>
      )}

      <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10, marginTop: 16 }}>
        {OPS.map((o) => (
          <div key={o.route} className="status" style={{ margin: 0, display: "block" }}>
            <button className="linkbtn" style={{ fontWeight: 600 }}
              onClick={() => (window.location.hash = "/" + o.route)}>
              {o.title} from your own wallet
            </button>
            <div style={{ opacity: 0.8 }}>{o.blurb}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
