import { useState, useEffect, useRef } from "react";
import type { useWallet } from "../wallet/useWallet";
import { JobTimeline, isTerminal, receiptInFlight } from "./jobTimeline";
import type { TrackedJob } from "./jobTimeline";
import { approveProposal as approve } from "../lib/approveProposal";
import { mergeJobStatus } from "../lib/mergeJobStatus";
import { readJson } from "../lib/readJson";

type UnifiedWallet = ReturnType<typeof useWallet>;

export default function ResearchPanel({ wallet }: { wallet: UnifiedWallet }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hireStatus, setHireStatus] = useState("");

  const [hireQuestion, setHireQuestion] = useState("");
  const [quote, setQuote] = useState<{ budgetUsdc: number; reasoning: string } | null>(
    null
  );
  // Set when the quote endpoint declines a question (advice/opinion, not research).
  // Mutually exclusive with `quote` — each new quote request clears the other.
  const [quoteDeclined, setQuoteDeclined] = useState<{ reason: string } | null>(null);

  // The job whose deliver→settle timeline we're currently tracking (null = none).
  const [trackedJob, setTrackedJob] = useState<TrackedJob | null>(null);
  // Session token captured at hire time, used to poll the (auth-gated) status.
  const pollTokenRef = useRef<string>("");

  // Proposal-loop approve state. `approving` disables the button optimistically on click
  // — the UX half of the double-approve mitigation (the server's optimistic lock is the
  // other half; neither fully closes the eventual-consistency window).
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState("");

  // Small local async runner: toggles busy + surfaces errors. This panel owns
  // its own busy/error so research progress doesn't clobber other panels.
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

  // Poll the run status every 5s while the tracked job is non-terminal. The whole
  // lifecycle runs server-side on the user's OWN wallet, so we poll job-run-status
  // by runId (auth-gated — only the run's owner may read it).
  useEffect(() => {
    if (!trackedJob) return;
    // Keep polling PAST a terminal research status while a receipt is still moving —
    // otherwise the timeline freezes on `burn_confirmed` and never shows the mint that
    // the background verifier is, at that moment, proving.
    if (isTerminal(trackedJob.status) && !receiptInFlight(trackedJob.receipt)) return;

    const runId = trackedJob.runId;
    if (!runId) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`/.netlify/functions/job-run-status?runId=${runId}`, {
          headers: { Authorization: `Bearer ${pollTokenRef.current}` },
        });
        const data = await r.json();
        if (!r.ok) return;
        if (!data.status || data.status === "not_found") return;
        // ⭐ SPREAD-WITH-OMIT, never a hand-written field list. The include-list version of this
        // merge silently dropped `synthesis`/`secondOpinion` in every commit that ever existed,
        // so the killed-proposal card never rendered once. See src/lib/mergeJobStatus.ts.
        setTrackedJob((prev) =>
          prev && prev.runId === runId ? mergeJobStatus(prev, data) : prev
        );
      } catch {
        // Transient network error — leave state alone and try again next tick.
      }
    }, 5000);

    return () => clearInterval(id);
  }, [trackedJob?.runId, trackedJob?.status, trackedJob?.receipt?.state]);

  // APPROVE the server-authored proposal. A money-path write.
  //
  // We POST only { runId }. Not the amount, not the destination, not a hash. The server
  // reads those from the proposal IT wrote, re-resolves the session, re-prices the fee
  // live, and re-checks the cap before anything signs — nothing survives this round-trip.
  // (This is stricter than agent-bridge's turn-2, which must re-accept
  // {amountUsdc, destination} because agent-act keeps no proposal server-side.)
  async function approveProposal() {
    const runId = trackedJob?.runId;
    const proposal = trackedJob?.proposal;
    if (!runId || !proposal || approving) return;
    setApproving(true);
    setApproveError("");
    try {
      const token = await wallet.ensureSession();
      // Routed by proposal.action (bridge → job-bridge-approve, swap → job-swap-approve).
      // Still posts ONLY { runId } — see src/lib/approveProposal.ts.
      const { receipt } = await approve({ runId, proposal, token });
      // The receipt also arrives via the poll (which keeps running past `completed`).
      if (receipt) setTrackedJob((prev) => (prev ? { ...prev, receipt } : prev));
    } catch (e: any) {
      setApproveError(e.message || "Approve failed");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Research</div>
      <h2>Ask your agent a factual question</h2>
      <div className="sub">
        Ask anything with a factual, sourceable answer. You'll see the price
        first — your agent researches and delivers a cited brief only if you
        approve it.
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          placeholder="e.g. What drove the 2023 rise in global egg prices?"
          value={hireQuestion}
          onChange={(e) => setHireQuestion(e.target.value)}
        />
        <button
          disabled={busy || !hireQuestion}
          onClick={() =>
            run(async () => {
              const r = await fetch("/.netlify/functions/job-quote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: hireQuestion }),
              });
              const data = await r.json();
              if (!r.ok) throw new Error(data.error || "Quote failed");
              // A new quote request always clears prior state, so a good
              // question after a declined one (or vice versa) shows fresh.
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
          {busy ? "Pricing…" : "Get a price"}
        </button>
      </div>

      {quoteDeclined && (
        <div className="status" style={{ marginTop: 12, color: "var(--warn)" }}>
          {quoteDeclined.reason && <div>{quoteDeclined.reason}</div>}
          <div style={{ marginTop: 4 }}>
            Your agent does factual research with cited sources, not personal
            advice. Try rephrasing as a factual question — e.g. "what are the
            historical returns of index funds" instead of "what should I invest
            in".
          </div>
        </div>
      )}

      {quote && (
        <div
          className="status"
          style={{
            marginTop: 14,
            padding: "16px 18px",
            background: "var(--field)",
            border: "1px solid var(--line)",
            borderRadius: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ color: "var(--muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Price to research this
            </span>
            <span style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--paper)" }}>
              {quote.budgetUsdc} USDC
            </span>
          </div>
          {/* Neutral, question-agnostic line — accurate for any accepted question
              (factual lookup, analytical synthesis, on-chain, market). Replaces the
              per-question quote.reasoning, which read price-specific for price
              questions ("…single current price source"). */}
          <div style={{ marginTop: 6, color: "var(--paper-dim)" }}>
            A research task answered from real, cited sources.
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="emerald"
              disabled={busy || !wallet.address}
              onClick={() =>
                run(async () => {
                  // Authenticate (one signature, no funds move) — the session
                  // proves which wallet is yours; the server runs the ENTIRE job
                  // on YOUR OWN agent wallet (create → fund → research → settle),
                  // gasless. No client-side signing of job txs anymore.
                  setHireStatus("Authorizing…");
                  const token = await wallet.ensureSession();
                  pollTokenRef.current = token;

                  setHireStatus("Starting your agent…");
                  const r = await fetch("/.netlify/functions/job-run", {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      Authorization: `Bearer ${token}`,
                    },
                    body: JSON.stringify({
                      question: hireQuestion,
                      budgetUsdc: quote.budgetUsdc,
                    }),
                  });
                  const data = await readJson(r);

                  if (r.status === 402) {
                    // Empty/underfunded wallet — clean message, no fallback.
                    throw new Error(
                      `${data.error || "Insufficient funds."}${
                        data.need != null
                          ? ` Need ${data.need} USDC, have ${data.have} USDC.`
                          : ""
                      }`
                    );
                  }
                  // ⭐ Provisioning is now 503 with `retryable: true` (walletProvisioningRefusal),
                  // NOT 202 — 202 on this endpoint means a run STARTED. The old branch matched
                  // `202 + status:"provisioning"` and would now never fire; a dead check that looks
                  // like protection is worse than none, so it is replaced rather than left.
                  if (r.status === 503 && data.reason === "wallet-provisioning") {
                    throw new Error(data.error || "Your agent wallet is still being set up — try again in a few seconds.");
                  }
                  if (!r.ok || !data.runId) {
                    throw new Error(data.error || "Could not start the job");
                  }

                  setHireStatus("");
                  // Track by runId; the poller resolves jobId + brief as it runs.
                  setTrackedJob({ runId: data.runId, status: "starting" });
                })
              }
            >
              Run research · {quote.budgetUsdc} USDC
            </button>
            {!wallet.address && (
              <span className="sub" style={{ margin: 0 }}>
                Continue with your passkey above first.
              </span>
            )}
          </div>
        </div>
      )}

      {trackedJob && (
        <div style={{ marginTop: 20 }}>
          <JobTimeline
            job={trackedJob}
            onApprove={approveProposal}
            approving={approving}
            approveError={approveError}
          />
        </div>
      )}

      {busy && (
        <div className="status" style={{ marginTop: 14 }}>
          <span className="spinner" /> {hireStatus || "Working…"}
        </div>
      )}

      {error && (
        <div className="status" style={{ marginTop: 14, color: "var(--warn)" }}>
          Error: {error}
        </div>
      )}
    </div>
  );
}
