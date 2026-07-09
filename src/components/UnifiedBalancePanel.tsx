import { useEffect, useState } from "react";
import AddressDisplay from "./AddressDisplay";

const go = (id: string) => {
  window.location.hash = "/" + id;
};

// Poll cadence matches the Dashboard unified card.
const BALANCE_POLL_MS = 30_000;

// UnifiedBalancePanel — a first-class READ-ONLY page for the agent's Unified
// Balance. Reached nav-less via #/unified (from the Dashboard "Agent unified
// balance" card), mirroring #/bridge and #/nanopay: the 5-item nav stays reserved
// for working tools.
//
// Read-only: it reuses the public /api/gateway-balance read (agent-wallet keyed,
// no secrets, no kit/adapter) to show the cross-chain total + per-chain breakdown
// and the depositor (owner) address. It MOVES NO MONEY — the funding button
// (depositFor, a money-path write) is a DISABLED placeholder here; the next brick
// wires it. Prop-less like NanopaymentPanel; a wallet prop arrives only when
// funding lands and needs a signer.
export default function UnifiedBalancePanel() {
  type PerChain = { chain: string; usdc: string | null; ok: boolean };
  const [data, setData] = useState<{ depositor: string; total: string; perChain: PerChain[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/gateway-balance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const d = await r.json().catch(() => null);
        if (!alive) return;
        if (!r.ok || !Array.isArray(d?.perChain)) {
          setFailed(true);
          return;
        }
        setData({ depositor: d.depositor ?? "", total: d.unifiedBalanceUsdc ?? "0", perChain: d.perChain });
        setFailed(false);
      } catch {
        if (alive) setFailed(true);
      }
    };
    load();
    const id = setInterval(load, BALANCE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="plane">
      <div className="panel-eyebrow">Unified balance</div>
      <h2>One USDC balance, across chains.</h2>
      <div className="sub">
        Your agent holds a single unified USDC balance that spans multiple chains
        via Circle Gateway. This view reads it live across Arc Testnet and Base
        Sepolia — no seed phrase, no bridging to check a total.
      </div>

      {/* Balance card — same surface as the Dashboard "Agent unified balance" card.
          Degrades gracefully to an "unavailable" line if the read fails. */}
      <div
        className="status"
        style={{
          marginTop: 14,
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
          Agent unified balance · across chains
        </div>
        {!data || failed ? (
          <div className="sub" style={{ margin: 0 }}>
            Unified balance unavailable.
          </div>
        ) : (
          <>
            <span style={{ fontSize: "1.6rem", fontWeight: 600, color: "var(--paper)" }}>
              <span className="mono">{data.total}</span>{" "}
              <span style={{ fontSize: "0.85rem", color: "var(--muted)", fontWeight: 400 }}>USDC</span>
            </span>
            <div className="sub" style={{ marginTop: 8, display: "flex", gap: 16, flexWrap: "wrap" }}>
              {data.perChain.map((p) => (
                <span key={p.chain}>
                  {p.chain}:{" "}
                  {p.ok ? (
                    <span className="mono">{p.usdc} USDC</span>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>unavailable</span>
                  )}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Owner address — the agent wallet the unified balance is keyed to (the
          depositor). Masked + expand + copy via AddressDisplay. ONE address only;
          the delegate signer is server-side and never surfaced. */}
      {data?.depositor && (
        <div
          className="status"
          style={{
            marginTop: 12,
            padding: "12px 16px",
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
            Agent wallet · unified balance owner
          </div>
          <AddressDisplay address={data.depositor} />
        </div>
      )}

      {/* Funding — placeholder for the NEXT brick (depositFor, a money-path write).
          Disabled on purpose; this read-only brick only reserves the layout slot. */}
      <div
        className="status"
        style={{
          marginTop: 12,
          padding: "14px 16px",
          background: "var(--field)",
          border: "1px dashed var(--line)",
          borderRadius: 12,
        }}
      >
        <div
          style={{
            color: "var(--muted)",
            fontSize: "0.72rem",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Fund the unified balance
        </div>
        <button disabled style={{ opacity: 0.55, cursor: "not-allowed" }}>
          Fund — coming soon
        </button>
        <div className="sub" style={{ margin: "8px 0 0" }}>
          Depositing USDC into the unified balance arrives in the next update.
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button className="linkbtn" onClick={() => go("dashboard")}>
          ← Back to dashboard
        </button>
      </div>
    </div>
  );
}
