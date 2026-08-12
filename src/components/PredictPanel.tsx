import { useEffect, useState } from "react";
import type { ModularWallet } from "../wallet/useModularWallet";
import { JobTimeline, isTerminal } from "./jobTimeline";
import type { TrackedJob } from "./jobTimeline";
import { readJson } from "../lib/readJson";

// PredictPanel — browse prediction markets, then pay the agent for sourced
// research on the one you pick. No betting, no advice: selecting a market runs
// the SAME paid research-job lifecycle as ResearchPanel (quote → create → fund
// → submit → poll job-deliverable). The market's pooled odds are passed to the
// agent only as a fact about the market, never as a recommendation.
//
// The browser never holds a key; funding is passkey-signed via the wallet.

// One market in the browsable list, as returned by /api/predict-markets
// (already junk-filtered and de-duplicated; marketId is the real on-chain id).
type MarketSummary = {
  marketId: number;
  question: string;
  category: string;
  status: string;
  statusCode: number;
  bettingDeadline: number;
  resolutionTime: number;
  pools: { yesUsdc: number; noUsdc: number; totalUsdc: number };
  probabilities: { yesPct: number; noPct: number };
};

// List formatting: pool sizes are already in USDC, odds already in percent.
const usd = (n: number) => `${(n ?? 0).toFixed(2)} USDC`;
const odds = (n: number) => `${Math.round(n ?? 0)}%`;

export default function PredictPanel({ wallet }: { wallet: ModularWallet }) {
  const [marketId, setMarketId] = useState("");

  // Browsable market list (loaded once on mount).
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [marketsError, setMarketsError] = useState("");

  // Research-job lifecycle state (mirrors ResearchPanel).
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hireStatus, setHireStatus] = useState("");
  const [quote, setQuote] = useState<{ budgetUsdc: number; reasoning: string } | null>(
    null
  );
  // Set when the quote endpoint declines a question (advice/opinion, not research).
  // Mutually exclusive with `quote` — each new quote request clears the other.
  const [quoteDeclined, setQuoteDeclined] = useState<{ reason: string } | null>(null);
  // The job whose deliver→settle timeline we're currently tracking (null = none).
  const [trackedJob, setTrackedJob] = useState<TrackedJob | null>(null);

  // Small local async runner: toggles busy + surfaces errors.
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Load the cleaned market list once on mount. READ ONLY.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMarketsLoading(true);
      setMarketsError("");
      try {
        const res = await fetch("/api/predict-markets");
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
        if (!cancelled) setMarkets(data.markets || []);
      } catch (e: any) {
        if (!cancelled) setMarketsError(e.message);
      } finally {
        if (!cancelled) setMarketsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll the deliverable record every 5s while the tracked job is non-terminal.
  // Re-runs whenever jobId or status changes; the cleanup clears the interval on
  // unmount, on a new job, and once a terminal status is reached.
  useEffect(() => {
    if (!trackedJob || isTerminal(trackedJob.status)) return;

    const jobId = trackedJob.jobId;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`/.netlify/functions/job-deliverable?jobId=${jobId}`);
        const data = await r.json();
        if (!r.ok) return;
        // Nothing written yet (background fn still running) — keep the funded
        // state and keep polling rather than clobbering it with "not_found".
        if (!data.status || data.status === "not_found") return;
        setTrackedJob((prev) =>
          prev && prev.jobId === jobId
            ? {
                ...prev,
                status: data.status,
                brief: data.brief ?? prev.brief,
                verdict: data.verdict ?? prev.verdict,
                reason: data.reason ?? prev.reason,
                settleTx: data.settleTx ?? prev.settleTx,
                settleTxUrl: data.settleTxUrl ?? prev.settleTxUrl,
                error: data.error ?? prev.error,
              }
            : prev
        );
      } catch {
        // Transient network error — leave state alone and try again next tick.
      }
    }, 5000);

    return () => clearInterval(id);
  }, [trackedJob?.jobId, trackedJob?.status]);

  // Selecting a market clears any stale quote/job from a previously selected
  // market. Guard: ignore market switches while a quote/create/fund is in
  // flight, so the tracked job stays bound to the market it was funded for.
  function selectMarket(id: number) {
    if (busy || wallet.busy) return;
    setMarketId(String(id));
    setQuote(null);
    setQuoteDeclined(null);
    setTrackedJob(null);
    setError("");
  }

  const selectedMarket = markets.find((m) => String(m.marketId) === marketId) ?? null;

  // The research question built from the selected market. The pooled odds are
  // reported as a fact about the market — never as advice or a recommendation.
  const researchQuestion = selectedMarket
    ? `Research the current state of evidence on this question: "${selectedMarket.question}". Report only what authoritative sources actually confirm about this question. If the specific outcome cannot be verified from real sources, say so plainly rather than inferring a result. For context, a prediction market's pooled money currently implies YES ${selectedMarket.probabilities.yesPct}% / NO ${selectedMarket.probabilities.noPct}% — report this only as a fact about the market, never as a recommendation. Do not advise a side, a bet, or a stake.`
    : "";

  return (
    <div className="plane">
      <h2>Research a prediction market</h2>
      <div className="sub">
        Pick a market and pay the agent for sourced research on it · you decide
        what to do with it · no betting, no advice.
      </div>

      {/* Browsable market list — pick one to research. */}
      {marketsLoading && (
        <div className="status" style={{ marginTop: 14 }}>
          <span className="spinner" /> Loading markets…
        </div>
      )}
      {marketsError && (
        <pre className="mono status" style={{ whiteSpace: "pre-wrap", marginTop: 14 }}>
          Error loading markets: {marketsError}
        </pre>
      )}
      {!marketsLoading && !marketsError && markets.length === 0 && (
        <div className="status" style={{ marginTop: 14 }}>
          No markets to show.
        </div>
      )}

      {markets.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
          {markets.map((m) => {
            const selected = String(m.marketId) === marketId;
            // Locked while a quote/create/fund is in flight (see selectMarket).
            const locked = busy || wallet.busy;
            return (
              <button
                key={m.marketId}
                onClick={() => selectMarket(m.marketId)}
                disabled={locked && !selected}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 8,
                  cursor: locked && !selected ? "not-allowed" : "pointer",
                  opacity: locked && !selected ? 0.5 : 1,
                  border: selected
                    ? "1px solid #34d399"
                    : "1px solid rgba(255,255,255,0.12)",
                  background: selected
                    ? "rgba(52,211,153,0.08)"
                    : "rgba(255,255,255,0.03)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{m.question}</span>
                  <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>
                    #{m.marketId}
                  </span>
                </div>
                <div
                  className="status"
                  style={{
                    margin: "6px 0 0",
                    fontSize: 12,
                    display: "flex",
                    gap: 14,
                    flexWrap: "wrap",
                  }}
                >
                  <span>{m.category || "—"}</span>
                  <span>{m.status}</span>
                  <span>Pool {usd(m.pools.totalUsdc)}</span>
                  <span>
                    YES {odds(m.probabilities.yesPct)} · NO {odds(m.probabilities.noPct)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Step 1 — get a sub-dollar quote for researching the selected market. */}
      <div className="row" style={{ marginTop: 14 }}>
        <button
          disabled={busy || !selectedMarket}
          onClick={() =>
            run(async () => {
              const r = await fetch("/.netlify/functions/job-quote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: researchQuestion }),
              });
              const data = await r.json();
              if (!r.ok) throw new Error(data.error || "Quote failed");
              // A new quote request always clears prior state.
              if (data.declined === true) {
                setQuote(null);
                setQuoteDeclined({ reason: data.reason || "" });
              } else {
                setQuoteDeclined(null);
                setQuote(data);
              }
            })
          }
        >
          {selectedMarket ? "Research this market" : "Select a market to research"}
        </button>
      </div>

      {quoteDeclined && (
        <div className="status" style={{ marginTop: 12, color: "#f5a623" }}>
          {quoteDeclined.reason && <div>{quoteDeclined.reason}</div>}
          <div style={{ marginTop: 4 }}>
            I do factual research with cited sources, not personal advice.
          </div>
        </div>
      )}

      {/* Step 2 — show the quote, then hire+fund the agent from the wallet. */}
      {quote && (
        <div className="status" style={{ marginTop: 12 }}>
          <div>
            Estimated budget: <b>{quote.budgetUsdc} USDC</b>
          </div>
          {quote.reasoning && (
            <div style={{ marginTop: 4 }}>{quote.reasoning}</div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="emerald"
              disabled={busy || !wallet.address}
              onClick={() =>
                run(async () => {
                  setHireStatus("Creating job…");
                  const jobId = await wallet.createJobAsUser(researchQuestion);

                  setHireStatus("Setting budget…");
                  const r = await fetch("/.netlify/functions/job-set-budget", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      jobId: jobId.toString(),
                      budgetUsdc: quote.budgetUsdc,
                    }),
                  });
                  if (!r.ok) {
                    const data = await readJson(r);
                    throw new Error(data.error || "Setting budget failed");
                  }

                  setHireStatus("Funding…");
                  await wallet.fundJobAsUser(Number(jobId), quote.budgetUsdc);

                  setHireStatus("");

                  // Funding is done — start the deliver→settle timeline and let
                  // it poll separately (non-blocking). Fire submit once; the
                  // backend auto-chains submit→evaluate→settle. Fire-and-forget:
                  // it returns 202 immediately, so don't await.
                  setTrackedJob({ jobId: jobId.toString(), status: "funded" });
                  fetch("/.netlify/functions/job-submit-background", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      jobId: jobId.toString(),
                      question: researchQuestion,
                    }),
                  }).catch(() => {
                    // The submit trigger failing doesn't undo funding; the
                    // timeline will sit at "funded" and the user can retry.
                  });
                })
              }
            >
              Research this market ({quote.budgetUsdc} USDC)
            </button>
            {!wallet.address && (
              <span className="sub">Register a passkey first to research.</span>
            )}
          </div>
        </div>
      )}

      {trackedJob && (
        <div style={{ marginTop: 20 }}>
          <JobTimeline job={trackedJob} />
        </div>
      )}

      {busy && (
        <div className="status" style={{ marginTop: 14 }}>
          <span className="spinner" /> {hireStatus || "Working…"}
        </div>
      )}

      {error && (
        <div className="status" style={{ marginTop: 14, color: "#f5a623" }}>
          Error: {error}
        </div>
      )}
    </div>
  );
}
