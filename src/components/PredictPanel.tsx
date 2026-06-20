import { useEffect, useState } from "react";
import type { ModularWallet } from "../wallet/useModularWallet";

// PredictPanel — the prediction-market plane.
//
// Two explicit steps, mirroring the backend's deliberate analyze/bet split:
//   1. "Analyze market" kicks off /api/predict-start, which fires the
//      predict-analyze-background Netlify function (web search can run minutes,
//      far longer than a sync function allows) and returns a jobId immediately.
//      We then poll /api/predict-status until the advisory decision lands.
//      READ ONLY — no funds move.
//   2. "Place agent's bet" hits the /api/predict-bet Netlify function, which
//      re-checks its own guards (OPEN, before deadline, ≤ spend cap) before the
//      agent's wallet stakes USDC. Enabled only once a decision suggests > 0.
//
// The browser never holds a key for either call.

// How often to poll the job status, and how long to keep polling before giving
// up. The background function may run up to ~15 min (Netlify Pro), so the
// ceiling is generous.
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

type Proposal = {
  outcome: "yes" | "no" | "undetermined";
  confidence: number; // decimal 0..1
  reasoning: string;
  sources: string[];
};

type ResolveResult = {
  market?: { question?: string; status?: string; resolutionTime?: number };
  proposal: Proposal | null;
  resolutionTimeReached?: boolean;
  resolutionWarning?: string;
  warning?: string;
  raw?: string;
};

// TikpemaPrediction on Arc Testnet. The oracle (deployer EOA) commits a
// resolution manually with `cast send`; the key lives in the contracts repo,
// never in this app. This string is display-only.
const PREDICTION_ADDRESS = "0xf38492403ce3f1c94ef6322b78c9024d26ed87e1";
const ARC_RPC = "https://rpc.testnet.arc.network";

// The exact command a human runs (in the contracts repo, where $PRIVATE_KEY is
// the oracle key) to commit a YES/NO resolution on-chain. Read-only here.
function castResolveCommand(id: string, yesWon: boolean) {
  return (
    `cast send ${PREDICTION_ADDRESS} "resolveMarket(uint256,bool)" ` +
    `${id} ${yesWon} --rpc-url ${ARC_RPC} --private-key $PRIVATE_KEY`
  );
}

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const signedPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
// List formatting: pool sizes are already in USDC, odds already in percent.
const usd = (n: number) => `${(n ?? 0).toFixed(2)} USDC`;
const odds = (n: number) => `${Math.round(n ?? 0)}%`;

export default function PredictPanel({ wallet }: { wallet: ModularWallet }) {
  const [marketId, setMarketId] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [betting, setBetting] = useState(false);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState("");
  const [txOut, setTxOut] = useState<string>("");

  // User-bet plane: a connected passkey user can stake their OWN USDC on the
  // agent's suggested side. The editable amount defaults to the agent's
  // suggested stake (synced whenever a fresh decision lands).
  const [userStake, setUserStake] = useState("");

  // Browsable market list (replaces the old manual market-id input).
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [marketsLoading, setMarketsLoading] = useState(true);
  const [marketsError, setMarketsError] = useState("");

  // Resolution-proposal plane — independent of the analyze/bet flow above.
  const [resolveId, setResolveId] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<ResolveResult | null>(null);
  const [resolveError, setResolveError] = useState("");
  const [copied, setCopied] = useState(false);

  const idIsValid = /^\d+$/.test(marketId.trim());
  const resolveIdIsValid = /^\d+$/.test(resolveId.trim());
  const decision = result?.decision ?? null;
  const canBet =
    !!decision && decision.suggestedAmountUsdc > 0 && !analyzing && !betting;

  // Default the editable user stake to the agent's suggestion each time a new
  // decision arrives; the user is free to overwrite it before placing.
  useEffect(() => {
    if (decision && decision.suggestedAmountUsdc > 0) {
      setUserStake(String(decision.suggestedAmountUsdc));
    }
  }, [decision]);

  // A connected wallet + a positive, numeric stake are required to bet.
  const userStakeNum = Number(userStake);
  const userStakeValid =
    Number.isFinite(userStakeNum) && userStakeNum > 0;
  const canUserBet =
    !!wallet.address &&
    !!decision &&
    userStakeValid &&
    !wallet.busy &&
    !analyzing &&
    !betting;

  // Stake the connected user's OWN USDC (passkey-signed, gasless). The two-step
  // status — "Approving stake…" → "Placing bet…" → "Bet placed: 0x…" — is
  // surfaced via wallet.status below. Distinct from the agent's bet above.
  async function placeUserBet() {
    if (!canUserBet || !decision) return;
    try {
      await wallet.placeBetAsUser(
        Number(marketId),
        decision.side === "yes",
        userStakeNum
      );
      // Reflect the new balance after the stake leaves the user's wallet.
      wallet.refreshBalance().catch(() => {});
    } catch {
      // wallet.status already carries the error message for display.
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

  // Selecting a market drives BOTH the analyze/bet flow and the resolution
  // flow (which still work by id) at the chosen on-chain id, and clears any
  // stale results from a previously selected market.
  function selectMarket(id: number) {
    const s = String(id);
    setMarketId(s);
    setResolveId(s);
    setResult(null);
    setError("");
    setTxOut("");
    setResolveResult(null);
    setResolveError("");
    setCopied(false);
  }

  const selectedMarket = markets.find((m) => String(m.marketId) === marketId) ?? null;

  async function analyze() {
    if (!idIsValid) return;
    setAnalyzing(true);
    setError("");
    setResult(null);
    setTxOut("");
    try {
      // 1. Start the async job and get a jobId back immediately.
      const startRes = await fetch("/api/predict-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId: Number(marketId) }),
      });
      const start = await startRes.json();
      if (!startRes.ok) throw new Error(start?.error || `Request failed: ${startRes.status}`);
      const { jobId } = start;
      if (!jobId) throw new Error("No jobId returned");

      // 2. Poll until the background analysis finishes (or we time out).
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await sleep(POLL_INTERVAL_MS);
        const statusRes = await fetch("/api/predict-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });
        const status = await statusRes.json();
        if (!statusRes.ok) throw new Error(status?.error || `Request failed: ${statusRes.status}`);
        if (status.status === "done") {
          const data = status.result;
          // The job can finish with a server-side error (e.g. market not found).
          if (data?.error) throw new Error(data.error);
          setResult(data as AnalyzeResult);
          break;
        }
        if (Date.now() > deadline) throw new Error("Analysis timed out");
      }
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

  // Research-only: ask the agent what really happened and PROPOSE a resolution
  // with cited sources. This NEVER signs or sends — committing is a manual
  // `cast send` the human runs with the oracle key.
  async function proposeResolution() {
    if (!resolveIdIsValid) return;
    setResolving(true);
    setResolveError("");
    setResolveResult(null);
    setCopied(false);
    try {
      // 1. Start the async job (predict-resolve-background) and get a jobId.
      const startRes = await fetch("/api/predict-resolve-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketId: Number(resolveId) }),
      });
      const start = await startRes.json();
      if (!startRes.ok) throw new Error(start?.error || `Request failed: ${startRes.status}`);
      const { jobId } = start;
      if (!jobId) throw new Error("No jobId returned");

      // 2. Poll the shared predict-status until the research finishes (or times out).
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        await sleep(POLL_INTERVAL_MS);
        const statusRes = await fetch("/api/predict-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });
        const status = await statusRes.json();
        if (!statusRes.ok) throw new Error(status?.error || `Request failed: ${statusRes.status}`);
        if (status.status === "done") {
          const data = status.result;
          // The job can finish with a server-side error (e.g. market not found).
          if (data?.error) throw new Error(data.error);
          setResolveResult(data as ResolveResult);
          break;
        }
        if (Date.now() > deadline) throw new Error("Resolution research timed out");
      }
    } catch (e: any) {
      setResolveError(e.message);
    } finally {
      setResolving(false);
    }
  }

  const proposal = resolveResult?.proposal ?? null;
  // Never offer the commit command for a market whose resolution time hasn't
  // passed — a premature market shows research + warning only, no command.
  const castCmd =
    proposal &&
    resolveResult?.resolutionTimeReached !== false &&
    (proposal.outcome === "yes" || proposal.outcome === "no")
      ? castResolveCommand(resolveId.trim(), proposal.outcome === "yes")
      : null;

  return (
    <div className="plane">
      <h2>Prediction plane</h2>
      <div className="sub">
        Pick a market and let the agent analyze it · it reads the market,
        searches the web, and recommends a side · betting is a separate, explicit
        step
      </div>

      {/* Browsable market list — pick one to drive every action below. */}
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
            return (
              <button
                key={m.marketId}
                onClick={() => selectMarket(m.marketId)}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 8,
                  cursor: "pointer",
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

      <div className="row" style={{ marginTop: 14 }}>
        <button disabled={analyzing || betting || !idIsValid} onClick={analyze}>
          {idIsValid ? `Analyze market #${marketId}` : "Select a market to analyze"}
        </button>
      </div>

      {analyzing && (
        <div className="status" style={{ marginTop: 14 }}>
          <span className="spinner" /> Agent analyzing… (web search may take a minute or two)
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

              {/* ── Bet as yourself ──────────────────────────────────────────
                  The connected passkey user stakes their OWN USDC on the
                  agent's suggested side, with an editable amount. Shown only
                  when a wallet is connected. */}
              <div
                style={{
                  marginTop: 16,
                  paddingTop: 14,
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div className="status" style={{ margin: "0 0 8px", fontSize: 11 }}>
                  Or bet with your own passkey wallet
                </div>

                {wallet.address ? (
                  <>
                    <div
                      className="row"
                      style={{ alignItems: "center", gap: 10 }}
                    >
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        style={{ maxWidth: 120 }}
                        value={userStake}
                        onChange={(e) => setUserStake(e.target.value)}
                      />
                      <span className="status" style={{ margin: 0 }}>
                        USDC on {decision.side.toUpperCase()}
                      </span>
                      <button
                        className="emerald"
                        disabled={!canUserBet}
                        onClick={placeUserBet}
                        title={
                          userStakeValid
                            ? "Stake your own USDC on this side"
                            : "Enter a stake greater than 0"
                        }
                      >
                        {wallet.busy
                          ? "Placing…"
                          : `Place my bet (${userStakeValid ? userStakeNum : 0} USDC)`}
                      </button>
                    </div>
                    {wallet.status && (
                      <div className="status" style={{ marginTop: 8 }}>
                        {wallet.status}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="status" style={{ margin: 0 }}>
                    Register or log in with a passkey in the Human plane above to
                    bet with your own wallet.
                  </div>
                )}
              </div>
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

      {/* ── Propose resolution ─────────────────────────────────────────────
          Agent researches the real-world outcome and proposes YES/NO with
          sources. Committing is a manual `cast send` by the oracle-key holder;
          this app never signs or sends. */}
      <div
        style={{
          marginTop: 28,
          paddingTop: 20,
          borderTop: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        <h3 style={{ margin: "0 0 4px" }}>Propose resolution</h3>
        <div className="sub">
          Agent researches what actually happened and proposes a resolution with
          cited sources · a human commits it manually with <code>cast send</code>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <div className="status" style={{ margin: 0 }}>
            {selectedMarket
              ? `Target: market #${selectedMarket.marketId} — ${selectedMarket.question}`
              : "Select a market above first."}
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button disabled={resolving || !resolveIdIsValid} onClick={proposeResolution}>
            {resolving ? "Researching…" : "Research outcome"}
          </button>
        </div>

        {resolving && (
          <div className="status" style={{ marginTop: 14 }}>
            <span className="spinner" /> Researching the real-world outcome… (web
            search may take a minute or two)
          </div>
        )}

        {resolveError && (
          <pre
            className="mono status"
            style={{ whiteSpace: "pre-wrap", marginTop: 14 }}
          >
            Error: {resolveError}
          </pre>
        )}

        {resolveResult && !resolving && (
          <div style={{ marginTop: 16 }}>
            {resolveResult.market?.question && (
              <div style={{ fontSize: 15, marginBottom: 12 }}>
                {resolveResult.market.question}
              </div>
            )}

            {resolveResult.resolutionTimeReached === false && (
              <div className="status" style={{ marginBottom: 12, color: "#f5a623" }}>
                ⚠ Resolution time not reached — this proposal is premature.
              </div>
            )}

            {proposal ? (
              <>
                <div className="row" style={{ gap: 20, marginBottom: 10 }}>
                  <Stat label="Proposed outcome" value={proposal.outcome.toUpperCase()} />
                  <Stat label="Confidence" value={pct(proposal.confidence)} />
                </div>
                <div className="status" style={{ marginBottom: 14 }}>
                  {proposal.reasoning}
                </div>

                {proposal.sources?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div className="status" style={{ margin: "0 0 6px", fontSize: 11 }}>
                      Sources
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {proposal.sources.map((url, i) => (
                        <li key={i} style={{ fontSize: 13, wordBreak: "break-all" }}>
                          <a href={url} target="_blank" rel="noreferrer">
                            {url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {castCmd ? (
                  <div>
                    <div className="status" style={{ margin: "0 0 6px", fontSize: 11 }}>
                      Commit manually — run in the contracts repo where the oracle
                      key (<code>$PRIVATE_KEY</code>) lives:
                    </div>
                    <pre
                      className="mono status"
                      style={{ whiteSpace: "pre-wrap", margin: 0 }}
                    >
                      {castCmd}
                    </pre>
                    <button
                      style={{ marginTop: 8 }}
                      onClick={() => {
                        navigator.clipboard?.writeText(castCmd);
                        setCopied(true);
                      }}
                    >
                      {copied ? "Copied ✓" : "Copy command"}
                    </button>
                  </div>
                ) : proposal.outcome === "undetermined" ? (
                  <div className="status">
                    Outcome is <b>UNDETERMINED</b> — no resolution command to run yet.
                  </div>
                ) : (
                  <div className="status">
                    Resolution time not reached — no commit command until the
                    deadline passes.
                  </div>
                )}
              </>
            ) : (
              <div className="status">
                No proposal returned
                {resolveResult.warning ? ` — ${resolveResult.warning}` : ""}.
                {resolveResult.raw ? (
                  <pre
                    className="mono status"
                    style={{ whiteSpace: "pre-wrap", marginTop: 8 }}
                  >
                    {resolveResult.raw}
                  </pre>
                ) : null}
              </div>
            )}
          </div>
        )}
      </div>
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
