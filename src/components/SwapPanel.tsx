import { useState } from "react";
import type { useWallet } from "../wallet/useWallet";

type UnifiedWallet = ReturnType<typeof useWallet>;
type Token = "USDC" | "EURC";

const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

// SwapPanel — the Swap USDC<->EURC form, matching SendPanel. It does NOT touch the
// swap engine (_swap.mjs / App Kit): it builds a structured swap_tokens action and
// hands it to the EXISTING /api/agent-execute-plan executor as a one-step plan (via
// w.swapFromAgent). That route enforces the per-action cap + day-ceiling BEFORE the
// step runs and calls the shared executeAction — so this inherits the same caps as
// a swap step in any plan, and agentSwap/kit.swap is never called from the client.
export default function SwapPanel({ wallet: w }: { wallet: UnifiedWallet }) {
  const [tokenIn, setTokenIn] = useState<Token>("USDC");
  const tokenOut: Token = tokenIn === "USDC" ? "EURC" : "USDC";
  const [amount, setAmount] = useState("0.5");
  const [swapping, setSwapping] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [tx, setTx] = useState<string | null>(null);
  const [error, setError] = useState("");

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;

  const reset = () => {
    setConfirm("");
    setTx(null);
    setError("");
  };

  async function swap() {
    if (!amountValid) return;
    reset();
    setSwapping(true);
    try {
      const r = await w.swapFromAgent(tokenIn, tokenOut, amountNum);
      // The MANUAL swap path submits and returns; the on-chain confirm happens
      // out-of-band (job-swap-receipt-background), so there is deliberately no tx
      // hash yet. Word it the same way the agent panel does, so a merely-SUBMITTED
      // swap is never reported as done.
      // ⚠️ `state` is nested under `swap` (executeAction returns { ok, kind, swap, tx }
      // — no top-level state). Reading r?.state made this ALWAYS false, so the hedge
      // never rendered; with tx now always null on the manual path that left the UI
      // claiming a bare "✓ Swapped." for an unconfirmed swap.
      const submitted = r?.swap?.state === "submitted";
      setConfirm(
        `Swapped ${amountNum} ${tokenIn} → ${tokenOut}` +
          (submitted ? " — submitted, balance updates shortly." : ".")
      );
      setTx(r?.tx ?? null);
    } catch (e: any) {
      setError(e?.message || "Swap failed");
    } finally {
      setSwapping(false);
    }
  }

  // Gate identically to SendPanel: nothing to swap from before a wallet exists.
  if (!w.agentWallet) {
    return (
      <div className="plane">
        <div className="panel-eyebrow">Swap</div>
        <h2>Swap USDC ↔ EURC</h2>
        <div className="sub" style={{ marginBottom: 0 }}>
          Set up your wallet first — open{" "}
          <button className="linkbtn" onClick={() => (window.location.hash = "/wallet")}>
            Wallet
          </button>{" "}
          to connect and fund it, then come back here to swap.
        </div>
      </div>
    );
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Swap</div>
      <h2>Swap USDC ↔ EURC</h2>
      <div className="sub">
        Convert between USDC and EURC on Arc — from your wallet, gasless. Swaps run
        within your per-transaction and daily safety caps.
      </div>

      <div className="status" style={{ marginTop: 0, marginBottom: 18 }}>
        Swapping from{" "}
        <span className="mono">{shortAddr(w.agentWallet.address)}</span>
        {" · USDC "}
        <span className="mono">{w.agentWallet.balance ?? "…"}</span>
        {" · EURC "}
        <span className="mono">{w.agentWallet.eurcBalance ?? "…"}</span>
      </div>

      <div className="row">
        <select
          value={tokenIn}
          onChange={(e) => {
            setTokenIn(e.target.value as Token);
            reset();
          }}
        >
          <option value="USDC">USDC</option>
          <option value="EURC">EURC</option>
        </select>
        <span className="status" style={{ margin: 0 }}>
          → {tokenOut}
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
          {tokenIn}
        </span>
        <button className="emerald" disabled={swapping || !amountValid} onClick={swap}>
          {swapping ? "Swapping…" : `Swap ${amountValid ? amountNum : 0} ${tokenIn}`}
        </button>
      </div>

      {confirm && (
        <div className="status" style={{ color: "var(--emerald)" }}>
          {confirm}
          {tx && (
            <>
              {" "}
              <a href={tx} target="_blank" rel="noreferrer">
                View tx
              </a>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="status" style={{ color: "var(--warn)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
