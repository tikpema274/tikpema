import { useEffect } from "react";
import type { useWallet } from "../wallet/useWallet";
import AddressDisplay from "./AddressDisplay";

type UnifiedWallet = ReturnType<typeof useWallet>;

const go = (id: string) => {
  window.location.hash = "/" + id;
};

// Auto-refresh cadence for the wallet balances. Manual Refresh stays.
const BALANCE_POLL_MS = 30_000;

// Dashboard — a landing/overview composed ONLY from reads the wallet hook
// already exposes (agentWallet address + balance, busy, isAuthenticated). No new
// endpoint, no agent-status call: agent-status reads the SHARED env demo wallet,
// not the per-user wallet, so surfacing it here would misrepresent the balance.
export default function Dashboard({ wallet: w }: { wallet: UnifiedWallet }) {
  // Auto-update balances on a timer while a wallet is connected — reuses the
  // existing refreshAgentWallet (no new endpoint). Cleared on unmount. The
  // manual Refresh button below is unchanged.
  const hasWallet = !!w.agentWallet;
  useEffect(() => {
    if (!hasWallet) return;
    const id = setInterval(() => {
      w.refreshAgentWallet().catch(() => {});
    }, BALANCE_POLL_MS);
    return () => clearInterval(id);
  }, [hasWallet, w.refreshAgentWallet]);

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
            <AddressDisplay address={w.agentWallet.address} />
            {/* USDC and EURC shown as TWO distinct labeled amounts — not summed
                (different units; EURC != $1). */}
            <div className="row" style={{ marginTop: 12, gap: 22, alignItems: "baseline" }}>
              <span style={{ fontSize: "1.3rem", fontWeight: 600, color: "var(--paper)" }}>
                {w.agentWallet.balance ?? "…"}{" "}
                <span style={{ fontSize: "0.82rem", color: "var(--muted)", fontWeight: 400 }}>
                  USDC
                </span>
              </span>
              <span style={{ fontSize: "1.3rem", fontWeight: 600, color: "var(--paper)" }}>
                {w.agentWallet.eurcBalance ?? "…"}{" "}
                <span style={{ fontSize: "0.82rem", color: "var(--muted)", fontWeight: 400 }}>
                  EURC
                </span>
              </span>
            </div>
            <div className="row" style={{ marginTop: 12, alignItems: "baseline" }}>
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
          // Three explicit entry points. Passkey/MetaMask start the connect flow
          // in THIS click (preserving the user gesture WebAuthn needs) and route
          // to the Wallet page, where status + the duplicate-wallet guard already
          // render. "Set up a new wallet" deep-links into that page's existing
          // create sub-flow (which carries the guard) via ?new.
          <div style={{ display: "grid", gap: 12, marginTop: 4 }}>
            <div>
              <button
                className="emerald"
                style={{ width: "100%" }}
                disabled={w.busy}
                onClick={() => {
                  go("wallet");
                  w.connectLogin().catch(() => {});
                }}
              >
                Connect a passkey
              </button>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                Sign in with Face ID or fingerprint — no seed phrase.
              </div>
            </div>

            {(w.connectors.find((c) => c.kind === "metamask")?.isAvailable() ?? false) && (
              <div>
                <button
                  style={{ width: "100%" }}
                  disabled={w.busy}
                  onClick={() => {
                    go("wallet");
                    w.connectMetaMask().catch(() => {});
                  }}
                >
                  Connect MetaMask
                </button>
                <div className="sub" style={{ margin: "6px 0 0" }}>
                  Use your existing MetaMask wallet.
                </div>
              </div>
            )}

            <div>
              <button
                style={{ width: "100%" }}
                disabled={w.busy}
                onClick={() => go("wallet?new")}
              >
                Set up a new wallet
              </button>
              <div className="sub" style={{ margin: "6px 0 0" }}>
                New here? Create a fresh agent wallet.
              </div>
            </div>
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
