import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

const go = (id: string) => {
  window.location.hash = "/" + id;
};

// Dashboard — a landing/overview composed ONLY from reads the wallet hook
// already exposes (agentWallet address + balance, busy, isAuthenticated). No new
// endpoint, no agent-status call: agent-status reads the SHARED env demo wallet,
// not the per-user wallet, so surfacing it here would misrepresent the balance.
export default function Dashboard({ wallet: w }: { wallet: UnifiedWallet }) {
  return (
    <>
      <div className="plane">
        <div className="panel-eyebrow">Overview</div>
        <h2>Your autonomous agent, on Arc.</h2>
        <div className="sub">
          One agent with its own on-chain wallet. Ask in plain language and it
          researches with cited sources, sends and swaps USDC, and bridges
          cross-chain to Ethereum, Base and more — gasless, no seed phrase, and
          kept within your per-transaction and daily spending caps.
        </div>

        {w.agentWallet ? (
          <div
            className="status"
            style={{
              marginTop: 0,
              padding: "14px 16px",
              background: "var(--field)",
              border: "1px solid var(--line)",
              borderRadius: 12,
            }}
          >
            <div
              style={{
                color: "var(--muted)",
                fontSize: "0.72rem",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                marginBottom: 6,
              }}
            >
              Your wallet
            </div>
            <div
              className="mono"
              style={{ color: "var(--paper)", wordBreak: "break-all", fontSize: "0.82rem" }}
            >
              {w.agentWallet.address}
            </div>
            <div className="row" style={{ marginTop: 10, alignItems: "baseline" }}>
              <span style={{ fontSize: "1.3rem", fontWeight: 600, color: "var(--paper)" }}>
                {w.agentWallet.balance ?? "…"}{" "}
                <span style={{ fontSize: "0.82rem", color: "var(--muted)", fontWeight: 400 }}>
                  USDC
                </span>
              </span>
              <button
                disabled={w.busy}
                onClick={() => w.refreshAgentWallet()}
                style={{ padding: "6px 12px", fontSize: "0.8rem" }}
              >
                Refresh
              </button>
              <button className="linkbtn" onClick={() => go("wallet")}>
                Manage wallet
              </button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ marginTop: 4 }}>
            <button className="emerald" onClick={() => go("wallet")}>
              Set up your wallet
            </button>
            <span className="sub" style={{ margin: 0 }}>
              Connect a passkey or MetaMask to begin.
            </span>
          </div>
        )}
      </div>

      <div className="plane">
        <div className="panel-eyebrow">Do something</div>
        <div className="quick">
          <button className="quick-card" onClick={() => go("agent")}>
            <div className="qt">AI Agent →</div>
            <div className="qd">
              Give your agent a task in plain language — research, send, swap,
              bridge, or a multi-step plan.
            </div>
          </button>
          <button className="quick-card" onClick={() => go("research")}>
            <div className="qt">Research →</div>
            <div className="qd">
              Commission a cited research brief, settled on-chain in USDC.
            </div>
          </button>
          <button className="quick-card" onClick={() => go("send")}>
            <div className="qt">Send →</div>
            <div className="qd">
              Send USDC from your wallet to any address, gasless on Arc.
            </div>
          </button>
          {/* 4th card wraps to a second row in the repeat(3,1fr) grid and sits
              alone on the left — intentional; no CSS tweak. Reflows to a single
              column on mobile like the rest. */}
          <button className="quick-card" onClick={() => go("nanopay")}>
            <div className="qt">Nanopayments →</div>
            <div className="qd">
              See how your agent pays a fraction of a cent for fresh data
              mid-research.
            </div>
          </button>
        </div>
      </div>
    </>
  );
}
