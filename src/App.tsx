import { useEffect, useState } from "react";
import ConnectPasskey from "./components/ConnectPasskey";
import ResearchPanel from "./components/ResearchPanel";
import MyAgentPanel from "./components/MyAgentPanel";
import AgentsPanel from "./components/AgentsPanel";
import FeedbackPanel from "./components/FeedbackPanel";
import SendPanel from "./components/SendPanel";
import SwapPanel from "./components/SwapPanel";
import DcaPanel from "./components/DcaPanel";
import BridgePanel from "./components/BridgePanel";
import VaultPanel from "./components/VaultPanel";
import NanopaymentPanel from "./components/NanopaymentPanel";
import UnifiedBalancePanel from "./components/UnifiedBalancePanel";
import PlanPanel from "./components/PlanPanel";
import Dashboard from "./components/Dashboard";
import { useWallet } from "./wallet/useWallet";

// Multi-page console. ONE useWallet() instance lives at the shell and is passed
// to every page exactly as before — no per-page wallet, no shared-state change.
// Routing is a lightweight hash router (no dependency): the active view derives
// from window.location.hash, so #/send etc. deep-link and the back button works.
//
// Nav is five items only — Dashboard, Wallet, AI Agent, Research, Send — every
// one backed by working code. Swap and Bridge are NOT nav items: they remain
// reachable inside AI Agent via natural-language tasks, exactly as today.
// Feedback sits in a muted low-priority slot at the foot of the sidebar.
const NAV = [
  { id: "dashboard", label: "Dashboard" },
  { id: "wallet", label: "Wallet" },
  { id: "agent", label: "AI Agent" },
  { id: "research", label: "Research" },
  { id: "send", label: "Send" },
];

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

  let page: JSX.Element;
  switch (route) {
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
    // Reached via the AI Agent "Quick actions" Swap card, not the nav (like
    // #/nanopay) — Swap stays a sub-action of AI Agent, so the 5-item nav (Send is
    // the only money tool promoted to nav) is untouched.
    case "swap":
      page = <SwapPanel wallet={wallet} />;
      break;
    // DCA — recurring custodial swaps. Nav-less (#/dca), reached from the swap area, like
    // #/bridge and #/vault. Leads with the custodial disclosure band; the scheduler
    // (dca-tick) fills mandates autonomously, routed through the same capped executeAction.
    case "dca":
      page = <DcaPanel wallet={wallet} />;
      break;
    // Also reached via the AI Agent "Quick actions" Bridge card, nav-less like
    // #/swap — Bridge stays a sub-action of AI Agent, nav untouched.
    case "bridge":
      page = <BridgePanel wallet={wallet} />;
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
