import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;

const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

// The CCTP-forwarded destinations agent-bridge accepts (keys mirror
// BRIDGE_DESTINATIONS in _bridge.mjs; the endpoint resolves the key server-side).
// Testnet labels kept honest — this is Arc Testnet.
const DESTINATIONS = [
  { key: "base", label: "Base (Sepolia)" },
  { key: "ethereum", label: "Ethereum (Sepolia)" },
  { key: "arbitrum", label: "Arbitrum (Sepolia)" },
  { key: "optimism", label: "Optimism (Sepolia)" },
  { key: "avalanche", label: "Avalanche (Fuji)" },
  { key: "polygon", label: "Polygon (Amoy)" },
  { key: "unichain", label: "Unichain (Sepolia)" },
  { key: "linea", label: "Linea (Sepolia)" },
];

// BridgePanel — cross-chain USDC bridge (Arc → 8 EVM testnets via CCTP), matching
// SendPanel/SwapPanel. It POSTs to /api/agent-bridge — the ONE endpoint that
// enforces the per-bridge cap (AGENT_BRIDGE_CAP_USDC) + live fee-floor + day-ceiling
// inside the shared executeAction BEFORE any funds move (agent-bridge.mjs:46 →
// _actions.mjs:91). It does NOT call executeAction/the bridge kit directly.
//
// UX = Option A (fire-and-inform): the Arc burn is synchronous, but the destination
// mint is async (~10–20 min, done by Circle's relayer). On submit we show the burn
// tx + net arrival and let the user leave — the bridge completes server-side. One
// optional "Check status" polls the mint ONCE (no blocking loop).
export default function BridgePanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [destination, setDestination] = useState("base");
  const [amount, setAmount] = useState("5");
  const [bridging, setBridging] = useState(false);
  const [run, setRun] = useState<any>(null); // agent-bridge response
  const [error, setError] = useState("");
  const [mint, setMint] = useState<any>(null); // one-shot status-check result
  const [checking, setChecking] = useState(false);

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const destLabel = DESTINATIONS.find((d) => d.key === destination)?.label ?? destination;

  const reset = () => {
    setRun(null);
    setError("");
    setMint(null);
  };

  async function bridge() {
    if (!amountValid) return;
    reset();
    setBridging(true);
    try {
      const res = await w.bridgeFromAgent(amountNum, destination);
      setRun(res);
    } catch (e: any) {
      setError(e?.message || "Bridge failed");
    } finally {
      setBridging(false);
    }
  }

  async function checkStatus() {
    if (!run?.burnHash || !run?.destination?.key) return;
    setChecking(true);
    try {
      const s = await w.checkBridgeStatus(run.burnHash, run.destination.key);
      setMint(s);
    } catch (e: any) {
      setMint({ state: "error", error: e?.message });
    } finally {
      setChecking(false);
    }
  }

  // Gate identically to Send/Swap: nothing to bridge from before a wallet exists.
  if (!w.agentWallet) {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Bridge</div>
        <h2>Bridge USDC cross-chain</h2>
        <div className="sub" style={{ marginBottom: 0 }}>
          Set up your wallet first — open{" "}
          <button className="linkbtn" onClick={() => (window.location.hash = "/wallet")}>
            Wallet
          </button>{" "}
          to connect and fund it, then come back here to bridge.
        </div>
      </div>
    );
  }

  const done = run?.executed && run?.burnHash;
  const pendingBurn = run && !error && !run.burnHash; // 202: burn still confirming

  return (
    <div className="plane">
      <div className="panel-eyebrow">Bridge</div>
      <h2>Bridge USDC cross-chain</h2>
      <div className="sub">
        Move USDC from Arc to another chain via CCTP — gasless, from your wallet. The
        Arc burn is instant; the destination mint follows in a few minutes (up to
        ~20 for some chains). Bridges run within your per-bridge and daily safety caps.
      </div>

      <div className="status" style={{ marginTop: 0, marginBottom: 18 }}>
        Bridging from{" "}
        <span className="mono">{shortAddr(w.agentWallet.address)}</span>
        {" · balance "}
        <span className="mono">{w.agentWallet.balance ?? "…"}</span> USDC
      </div>

      <div className="row">
        <select
          value={destination}
          onChange={(e) => {
            setDestination(e.target.value);
            reset();
          }}
        >
          {DESTINATIONS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        <span className="status" style={{ margin: 0 }}>
          destination
        </span>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <input
          type="number"
          min="0"
          step="0.01"
          style={{ maxWidth: 120 }}
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            reset();
          }}
        />
        <span className="status" style={{ margin: 0 }}>
          USDC
        </span>
        <button className="emerald" disabled={bridging || !amountValid} onClick={bridge}>
          {bridging ? "Bridging…" : `Bridge ${amountValid ? amountNum : 0} USDC → ${destLabel}`}
        </button>
      </div>

      <div className="sub" style={{ marginTop: 6, fontSize: "0.8rem" }}>
        A live cross-chain fee (taken from the amount) applies — you'll see the exact
        fee and net arrival on the confirmation. Bridges over your per-bridge cap, or
        too small to cover the fee, are refused before any funds move.
      </div>

      {error && (
        <div className="status" style={{ color: "var(--warn)" }}>
          {error}
        </div>
      )}

      {pendingBurn && (
        <div className="status">
          Bridge submitted — the Arc burn is still confirming. Check back shortly.
        </div>
      )}

      {done && (
        <div className="status" style={{ color: "var(--emerald)" }}>
          Bridge submitted ✓ — ~{Number(run.netUsdc).toFixed(2)} USDC will arrive on{" "}
          {run.destination?.label ?? destLabel} in a few minutes (up to ~20 for some chains)
          {run.feeUsdc != null && <> (fee ~{Number(run.feeUsdc).toFixed(2)} USDC)</>}.
          {run.tx && (
            <>
              {" "}
              <a href={run.tx} target="_blank" rel="noreferrer">
                View burn tx
              </a>
            </>
          )}
          <div className="sub" style={{ marginTop: 6 }}>
            You can leave this page — the bridge completes on its own.
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="linkbtn" disabled={checking} onClick={checkStatus}>
              {checking ? "Checking…" : "Check status"}
            </button>
            {mint?.state === "pending" && (
              <span className="status" style={{ marginLeft: 8 }}>
                Still bridging — the mint hasn't landed yet.
              </span>
            )}
            {mint?.state === "minted" && (
              <span className="status" style={{ marginLeft: 8, color: "var(--emerald)" }}>
                ✓ Arrived on {run.destination?.label ?? destLabel}.
                {mint.mintTx && (
                  <>
                    {" "}
                    <a href={mint.mintTx} target="_blank" rel="noreferrer">
                      View mint tx
                    </a>
                  </>
                )}
              </span>
            )}
            {mint?.state === "failed" && (
              <span className="status" style={{ marginLeft: 8, color: "var(--warn)" }}>
                Bridge failed on the destination.
              </span>
            )}
            {mint?.state === "error" && (
              <span className="status" style={{ marginLeft: 8, color: "var(--warn)" }}>
                Couldn't check status — {mint.error}.
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
