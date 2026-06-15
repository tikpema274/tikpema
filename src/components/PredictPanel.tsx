import { useState } from "react";

// PredictPanel — the prediction-market plane.
//
// Two explicit steps, mirroring the backend's deliberate analyze/bet split:
//   1. "Analyze market" hits the standalone analyst server (it can run 50-80s
//      because of web search, longer than a Netlify function allows), which
//      returns an advisory decision. READ ONLY — no funds move.
//   2. "Place agent's bet" hits the /api/predict-bet Netlify function, which
//      re-checks its own guards (OPEN, before deadline, ≤ spend cap) before the
//      agent's wallet stakes USDC. Enabled only once a decision suggests > 0.
//
// The browser never holds a key for either call.

// The analyst server runs separately from the Netlify functions (see the ~60s
// web-search latency). Falls back to the local dev port.
const ANALYST_URL = import.meta.env.VITE_ANALYST_URL || "http://localhost:8787";

type Decision = {
  side: "yes" | "no";
  confidence: number; // decimal 0..1
  edge: number; // decimal -1..1 (your YES prob minus pool's implied YES)
  reasoning: string;
  suggestedAmountUsdc: number;
};

type AnalyzeResult = {
  market?: { question?: string; status?: string; pools?: { totalUsdc?: number } };
  decision: Decision | null;
  warning?: string;
  raw?: string;
};

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

export default function PredictPanel() {
  const [marketId, setMarketId] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [betting, setBetting] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState("");
  const [txOut, setTxOut] = useState<string>("");

  const idIsValid = /^\d+$/.test(marketId.trim());
  const decision = result?.decision ?? null;
  const canBet =
    !!decision && decision.suggestedAmountUsdc > 0 && !analyzing && !betting;

  async function analyze() {
    if (!idIsValid) return;
    setAnalyzing(true);
    setError("");
    setResult(null);
    setTxOut("");
    try {
      const res = await fetch(`${ANALYST_URL}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId: Number(marketId) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setResult(data as AnalyzeResult);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function placeBet() {
    if (!decision) return;
    setBetting(true);
    setTxOut("Submitting approve + placeBet…");
    try {
      const res = await fetch("/api/predict-bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketId: Number(marketId),
          isYes: decision.side === "yes",
          amountUsdc: decision.suggestedAmountUsdc,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      setTxOut(JSON.stringify(data, null, 2));
    } catch (e: any) {
      setTxOut(`Error: ${e.message}`);
    } finally {
      setBetting(false);
    }
  }

  return (
    <div className="plane">
      <h2>Prediction plane</h2>
      <div className="sub">
        Agent reads a TikpemaPrediction market, searches the web, and recommends a
        side · betting is a separate, explicit step
      </div>

      <div className="row">
        <input
          type="number"
          min={0}
          step={1}
          placeholder="market id, e.g. 0"
          value={marketId}
          onChange={(e) => setMarketId(e.target.value)}
          style={{ maxWidth: 160 }}
        />
        <button disabled={analyzing || betting || !idIsValid} onClick={analyze}>
          Analyze market
        </button>
      </div>

      {analyzing && (
        <div className="status" style={{ marginTop: 14 }}>
          <span className="spinner" /> Agent analyzing… (~60s)
        </div>
      )}

      {error && (
        <pre className="mono status" style={{ whiteSpace: "pre-wrap", marginTop: 14 }}>
          Error: {error}
        </pre>
      )}

      {result && !analyzing && (
        <div style={{ marginTop: 16 }}>
          {result.market?.question && (
            <div style={{ fontSize: 15, marginBottom: 12 }}>
              {result.market.question}
            </div>
          )}

          {decision ? (
            <>
              <div className="row" style={{ gap: 20, marginBottom: 10 }}>
                <Stat label="Side" value={decision.side.toUpperCase()} />
                <Stat label="Confidence" value={pct(decision.confidence)} />
                {typeof decision.edge === "number" && (
                  <Stat label="Edge" value={signedPct(decision.edge)} />
                )}
                <Stat
                  label="Suggested stake"
                  value={`${decision.suggestedAmountUsdc} USDC`}
                />
              </div>
              <div className="status" style={{ marginBottom: 14 }}>
                {decision.reasoning}
              </div>

              <button
                className="emerald"
                disabled={!canBet}
                onClick={placeBet}
                title={
                  decision.suggestedAmountUsdc > 0
                    ? "Stake the agent's own USDC on this side"
                    : "Agent suggests no bet (no clear edge)"
                }
              >
                {betting
                  ? "Placing bet…"
                  : `Place agent's bet (${decision.suggestedAmountUsdc} USDC ${decision.side.toUpperCase()})`}
              </button>
            </>
          ) : (
            <div className="status">
              No decision returned{result.warning ? ` — ${result.warning}` : ""}.
              {result.raw ? (
                <pre
                  className="mono status"
                  style={{ whiteSpace: "pre-wrap", marginTop: 8 }}
                >
                  {result.raw}
                </pre>
              ) : null}
            </div>
          )}
        </div>
      )}

      {txOut && (
        <pre className="mono status" style={{ whiteSpace: "pre-wrap", marginTop: 14 }}>
          {txOut}
        </pre>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="status" style={{ margin: 0, fontSize: 11 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 15 }}>
        {value}
      </div>
    </div>
  );
}
