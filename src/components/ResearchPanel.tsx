import { useState, useEffect } from "react";
import type { useWallet } from "../wallet/useWallet";
import { JobTimeline, isTerminal } from "./jobTimeline";
import type { TrackedJob } from "./jobTimeline";

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

  return (
    <div className="plane">
      <div className="panel-eyebrow">Step 03 · The research desk</div>
      <h2>Ask your question</h2>
      <div className="sub">
        Ask anything with a factual, sourceable answer. You'll see a price
        first — hire the analyst only if it looks right.
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
            The analyst does factual research with cited sources, not personal
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
          {quote.reasoning && (
            <div style={{ marginTop: 6, color: "var(--paper-dim)" }}>{quote.reasoning}</div>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="emerald"
              disabled={busy || !wallet.address}
              onClick={() =>
                run(async () => {
                  setHireStatus("Creating job…");
                  const jobId = await wallet.createJobAsUser(hireQuestion);

                  // Authenticate now — the account is deployed by createJob, so
                  // the passkey/MetaMask signature can prove ownership. One sign,
                  // no funds move; the token gates the server spend calls below.
                  setHireStatus("Authorizing…");
                  const token = await wallet.ensureSession();
                  const authHeaders = {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                  };

                  setHireStatus("Setting budget…");
                  const r = await fetch("/.netlify/functions/job-set-budget", {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({
                      jobId: jobId.toString(),
                      budgetUsdc: quote.budgetUsdc,
                    }),
                  });
                  if (!r.ok) {
                    const data = await r.json().catch(() => ({}));
                    throw new Error(data.error || "Setting budget failed");
                  }

                  setHireStatus("Funding…");
                  await wallet.fundJobAsUser(Number(jobId), quote.budgetUsdc);

                  setHireStatus("");

                  // Option B: funding is done — start the deliver→settle
                  // timeline and let it poll separately (non-blocking). Fire
                  // submit once; the backend auto-chains submit→evaluate→settle.
                  // Fire-and-forget: it returns 202 immediately, so don't await.
                  setTrackedJob({ jobId: jobId.toString(), status: "funded" });
                  fetch("/.netlify/functions/job-submit", {
                    method: "POST",
                    headers: authHeaders,
                    body: JSON.stringify({
                      jobId: jobId.toString(),
                      question: hireQuestion,
                    }),
                  }).catch(() => {
                    // The submit trigger failing doesn't undo funding; the
                    // timeline will simply sit at "funded" and the user can retry.
                  });
                })
              }
            >
              Hire the analyst · {quote.budgetUsdc} USDC
            </button>
            {!wallet.address && (
              <span className="sub" style={{ margin: 0 }}>
                Create your wallet above first.
              </span>
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
        <div className="status" style={{ marginTop: 14, color: "var(--warn)" }}>
          Error: {error}
        </div>
      )}
    </div>
  );
}
