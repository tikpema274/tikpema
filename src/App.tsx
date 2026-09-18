import { useEffect, useState, lazy, Suspense } from "react";
import ConnectPasskey from "./components/ConnectPasskey";
import ResearchPanel from "./components/ResearchPanel";
import MyAgentPanel from "./components/MyAgentPanel";
import AgentsPanel from "./components/AgentsPanel";
import FeedbackPanel from "./components/FeedbackPanel";
import SendPanel from "./components/SendPanel";
import SwapPanel from "./components/SwapPanel";
import DcaPanel from "./components/DcaPanel";
import BridgePanel from "./components/BridgePanel";
import ManualBridgePanel from "./components/ManualBridgePanel";
import ManualSendPanel from "./components/ManualSendPanel";
import ManualSwapPanel from "./components/ManualSwapPanel";
import SelfSignedPanel from "./components/SelfSignedPanel";
import VaultPanel from "./components/VaultPanel";
import NanopaymentPanel from "./components/NanopaymentPanel";
import UnifiedBalancePanel from "./components/UnifiedBalancePanel";
import PlanPanel from "./components/PlanPanel";
import Dashboard from "./components/Dashboard";
import ReceivePanel from "./components/ReceivePanel";
import PayPanel from "./components/PayPanel";
import SellPanel from "./components/SellPanel";
import { useWallet } from "./wallet/useWallet";

// Multi-page console. ONE useWallet() instance lives at the shell and is passed
// to every page exactly as before — no per-page wallet, no shared-state change.
// Routing is a lightweight hash router (no dependency): the active view derives
// from window.location.hash, so #/send etc. deep-link and the back button works.
//
// Nav is six items — Dashboard, Wallet, AI Agent, Research, Send, Pay — every one
// backed by working code. Swap and Bridge are NOT nav items: they remain reachable
// inside AI Agent via natural-language tasks, exactly as today.
// ⭐ Pay (2026-09-18) is the SIXTH, decided by T against folding it into Send: a checkout link
// must be reachable from NAV, not only from a card (the 22-day unlinked #/dca outage below).
// Without ?order= it is the door, and it links Sell — so both checkout routes are linked.
// Feedback sits in a muted low-priority slot at the foot of the sidebar.
const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "wallet", label: "Wallet" },
  { id: "agent", label: "AI Agent" },
  { id: "research", label: "Research" },
  { id: "send", label: "Send" },
  { id: "pay", label: "Pay" },
];

// ⭐ DEV-ONLY fixture route. `import.meta.env.DEV` is statically replaced with `false` in the
// production build, so this folds to `null` and the lazy `import()` is eliminated — the DevDdCard
// module and its fixtures never enter dist/. Lets a developer see the DD card's no-verdict state
// without the API or a real refused vault. Reached at #/dev/dd-card via `npm run dev:vite`.
const DevDdCard = import.meta.env.DEV ? lazy(() => import("./dev/DevDdCard")) : null;

function parseHash(): string {
  // Strip any `?intent` query (e.g. #/wallet?new) so deep-links still resolve to
  // the base route; the target page reads the intent from the raw hash itself.
  return window.location.hash.replace(/^#\/?/, "").split("?")[0].trim() || "dashboard";
}

export default function App() {
  const wallet = useWallet();
  const [route, setRoute] = useState<string>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (id: string) => {
    window.location.hash = "/" + id;
  };

  // DEV-ONLY: the DD-card fixture page (see DevDdCard above). Dead code in production.
  if (import.meta.env.DEV && route === "dev/dd-card" && DevDdCard) {
    return <Suspense fallback={<div style={{ padding: 24 }}>loading dev fixture…</div>}><DevDdCard /></Suspense>;
  }

  let page: JSX.Element;
  switch (route) {
    // ⭐ Receive. NOT in NAV — reached from the Wallet page and from the Dashboard, the two places
    // a user is already thinking about their own money. The 5-item nav is reserved for working
    // tools, and this is a one-fact screen. [[tikpema-ui-conventions]]
    case "receive":
      page = <ReceivePanel wallet={wallet} />;
      break;
    case "wallet":
      page = <ConnectPasskey wallet={wallet} />;
      break;
    case "agent":
      page = <MyAgentPanel wallet={wallet} />;
      break;
    // The AGENTS ROSTER. Nav-less (the 5-item nav stays reserved for working tools) —
    // reached from the Dashboard card, like #/unified and #/plan.
    case "agents":
      page = <AgentsPanel wallet={wallet} />;
      break;
    case "research":
      page = <ResearchPanel wallet={wallet} />;
      break;
    case "send":
      page = <SendPanel wallet={wallet} />;
      break;
    // ⭐ CHECKOUT (2026-09-18, direct settlement only). #/pay?order=<id> is the buyer's side and a
    // NAV item; #/sell is the seller's side, reached from the Dashboard "Sell something" card and
    // from the Pay door. The buyer pays through the SAME agent-send path as #/send.
    case "pay":
      page = <PayPanel wallet={wallet} />;
      break;
    case "sell":
      page = <SellPanel wallet={wallet} />;
      break;
    // Reached via the AI Agent "Quick actions" Swap card, not the nav (like
    // #/nanopay) — Swap stays a sub-action of AI Agent, so the 5-item nav (Send is
    // the only money tool promoted to nav) is untouched.
    // ⭐ THE MANUAL SEND — user-signed, from the CONNECTED wallet. Sibling of #/send, not a
    // replacement: the agent send stays exactly as it was, and is still the nav item. Nav-less like
    // #/bridge-manual, and LINKED from SendPanel — a live route nothing links to is the state that
    // hid a 22-day outage on #/dca (src/App.tsx records it).
    case "send-manual":
      page = <ManualSendPanel wallet={wallet} />;
      break;
    // ⭐ LINKED FROM SwapPanel, never only reachable by typing the hash — a live route nothing
    // links to is the state that hid #/dca for 22 days while reading as shipped.
    // ⭐ The three self-signed operations as ONE page. ⛔ DELIBERATELY NOT IN `NAV` — the page's
    // only claim is contrastive ("caps do not apply"), and a nav entry would let a reader arrive
    // having never seen the capped panel, where that sentence reads as reassurance rather than as
    // the removal of a guard. Reached from a Dashboard card and from each agent panel's twin link.
    case "self-signed":
      page = <SelfSignedPanel wallet={wallet} />;
      break;
    case "swap-manual":
      page = <ManualSwapPanel wallet={wallet} />;
      break;
    case "swap":
      page = <SwapPanel wallet={wallet} />;
      break;
    // DCA — recurring custodial swaps. Nav-less (#/dca). Leads with the custodial disclosure
    // band; the scheduler (dca-tick) fills mandates autonomously, through the same capped
    // executeAction.
    // ⚠️ THIS COMMENT USED TO SAY "reached from the swap area, like #/bridge and #/vault." FALSE —
    // and doubly so, because those two ARE reached that way and this one never was. NOTHING in
    // src/ links to #/dca; it is reachable only by typing the hash. That combination — live route,
    // live redirects, live cron, no way in — is the state that hid a 22-day outage here.
    // 🚧 New mandates are now GATED at the server (CREATE_GATED in _dca.mjs, which carries the
    // unblock condition). Re-link this route in the same commit that un-gates it.
    case "dca":
      page = <DcaPanel wallet={wallet} />;
      break;
    // Also reached via the AI Agent "Quick actions" Bridge card, nav-less like
    // #/swap — Bridge stays a sub-action of AI Agent, nav untouched.
    case "bridge":
      page = <BridgePanel wallet={wallet} />;
      break;
    // ⭐ THE MANUAL BRIDGE — user-signed, from the CONNECTED wallet. A sibling of #/bridge, not a
    // replacement: the agent path stays exactly as it was. Nav-less like #/swap and #/bridge, and
    // LINKED from BridgePanel — src/App.tsx:85 records what happens to a live route nothing links
    // to (#/dca sat reachable only by typing the hash for 22 days).
    case "bridge-manual":
      page = <ManualBridgePanel wallet={wallet} />;
      break;
    // The Vault agent — inspect an allowlisted ERC-4626 vault, then deposit/withdraw. Nav-less
    // like #/swap and #/bridge: a sub-action reached from the Dashboard/AI Agent, so the 5-item
    // nav (working tools only) stays untouched.
    case "vault":
      page = <VaultPanel wallet={wallet} />;
      break;
    // Reached via the Dashboard "Do something" card, not the nav — a copy-only
    // explainer, so the 5-item nav (working tools only) stays untouched.
    case "nanopay":
      page = <NanopaymentPanel />;
      break;
    // The proposal loop's own door — reached via the Dashboard "Plan an action" card,
    // nav-less like #/bridge. Separate from #/research because research declines advice
    // ("should I…") while an action plan IS a recommendation; plan-quote's guardrail is
    // executability, not opinion. The 5-item nav stays untouched.
    case "plan":
      page = <PlanPanel wallet={wallet} />;
      break;
    // Reached via the Dashboard "Agent unified balance" card, nav-less like #/nanopay
    // — a cross-chain balance view plus the (auth- and cap-gated) funding control, so
    // the 5-item nav stays untouched.
    case "unified":
      page = <UnifiedBalancePanel wallet={wallet} />;
      break;
    case "feedback":
      page = <FeedbackPanel wallet={wallet} />;
      break;
    case "dashboard":
    default:
      page = <Dashboard wallet={wallet} />;
      break;
  }

  return (
    <div className="console">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="wordmark">
            <b>
              Tikpema<span className="seal">.</span>
            </b>
            <span className="eyebrow">Autonomous agent</span>
          </div>
          <span className="chip">
            <span className="dot">●</span> Arc Testnet
          </span>
        </div>

        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={"nav-item" + (route === n.id ? " active" : "")}
              onClick={() => go(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>

        <div className="nav nav-foot">
          <button
            className={"nav-item muted" + (route === "feedback" ? " active" : "")}
            onClick={() => go("feedback")}
          >
            Feedback
          </button>
          {/* Low-key contact block — muted text, amber links, matching the nav padding. */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 3,
              padding: "6px 12px 2px",
              fontSize: "0.72rem",
              color: "var(--muted)",
            }}
          >
            <a href="mailto:tikpema274@gmail.com" style={{ color: "var(--amber)", textDecoration: "none" }}>
              tikpema274@gmail.com
            </a>
            <a
              href="https://x.com/tikpemaGB"
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--amber)", textDecoration: "none" }}
            >
              @tikpemaGB
            </a>
          </div>
        </div>
      </aside>

      <main className="console-main">{page}</main>
    </div>
  );
}
