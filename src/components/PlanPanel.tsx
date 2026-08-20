import { useState, useEffect, useRef } from "react";
import type { useWallet } from "../wallet/useWallet";
import { JobTimeline, isTerminal, receiptInFlight } from "./jobTimeline";
import type { TrackedJob } from "./jobTimeline";
import { approveProposal as approve } from "../lib/approveProposal";
import { mergeJobStatus } from "../lib/mergeJobStatus";
import { readJson } from "../lib/readJson";

type UnifiedWallet = ReturnType<typeof useWallet>;

const go = (id: string) => {
  window.location.hash = "/" + id;
};

// PlanPanel — the proposal loop's own front door. Nav-less at #/plan, reached from the
// Dashboard "Plan an action" card, mirroring #/bridge and #/unified: the 5-item nav stays
// reserved for working tools.
//
// ══ WHY A SEPARATE DOOR FROM RESEARCH ══════════════════════════════════════════
// #/research asks a FACTUAL question and declines anything that reads as advice
// ("should I…"). That guardrail is correct there and fatal here: an action plan IS a
// recommendation. So this surface prices through `plan-quote`, whose guardrail is not
// "no advice" but "no advice we cannot bound, price, and refuse" — the test is
// EXECUTABILITY.
//
// Everything downstream is REUSED, already proven and deployed: job-run → research +
// synthesis → validateProposal (server re-derives destination/amount, discards the
// model's fee) → the approve button → job-bridge-approve (the trust boundary, which
// reads only {runId}) → the double-verified receipt.
//
// ⚠️ THE USER IS THE REASONING GATE. The server proves a proposal is well-FORMED and
// ECONOMICAL, never that it is well-REASONED. ProposalCard renders the agent's "why"
// above the numbers and above the button for exactly that reason.
export default function PlanPanel({ wallet }: { wallet: UnifiedWallet }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runStatus, setRunStatus] = useState("");

  const [task, setTask] = useState("");
  const [quote, setQuote] = useState<{ budgetUsdc: number; reasoning: string } | null>(null);
  const [quoteDeclined, setQuoteDeclined] = useState<{ reason: string } | null>(null);

  const [trackedJob, setTrackedJob] = useState<TrackedJob | null>(null);
  const pollTokenRef = useRef<string>("");

  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState("");

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

  // Poll while the job runs — and keep polling PAST a terminal research status while a
  // receipt is still moving, or the timeline would freeze on `burn_confirmed` and never
  // show the mint the background verifier is proving.
  useEffect(() => {
    if (!trackedJob) return;
    if (isTerminal(trackedJob.status) && !receiptInFlight(trackedJob.receipt)) return;
    const runId = trackedJob.runId;
    if (!runId) return;

    const id = setInterval(async () => {
      try {
        const r = await fetch(`/.netlify/functions/job-run-status?runId=${runId}`, {
          headers: { Authorization: `Bearer ${pollTokenRef.current}` },
        });
        const data = await r.json();
        if (!r.ok || !data.status || data.status === "not_found") return;
        // ⭐ SPREAD-WITH-OMIT, never a hand-written field list. The include-list version of this
        // merge silently dropped `synthesis`/`secondOpinion` in every commit that ever existed,
        // so the killed-proposal card never rendered once. See src/lib/mergeJobStatus.ts.
        setTrackedJob((prev) =>
          prev && prev.runId === runId ? mergeJobStatus(prev, data) : prev
        );
      } catch {
        /* transient — retry next tick */
      }
    }, 5000);
    return () => clearInterval(id);
  }, [trackedJob?.runId, trackedJob?.status, trackedJob?.receipt?.state]);

  // Approve the SERVER-AUTHORED proposal. We POST only { runId } — not the amount, not
  // the destination, not a hash. The server reads those from the proposal it wrote,
  // re-resolves the session, re-prices the fee live, and re-checks the cap before
  // anything signs. Nothing survives this round-trip.
  async function approveProposal() {
    const runId = trackedJob?.runId;
    const proposal = trackedJob?.proposal;
    if (!runId || !proposal || approving) return;
    setApproving(true); // disables the button optimistically — the UX half of the
    setApproveError(""); // double-approve mitigation (the server lock is the other half)
    try {
      const token = await wallet.ensureSession();
      // Routed by proposal.action (bridge → job-bridge-approve, swap → job-swap-approve).
      // Still posts ONLY { runId } — see src/lib/approveProposal.ts.
      const { receipt } = await approve({ runId, proposal, token });
      if (receipt) setTrackedJob((prev) => (prev ? { ...prev, receipt } : prev));
    } catch (e: any) {
      setApproveError(e.message || "Approve failed");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div className="plane">
      <div className="panel-eyebrow">Plan an action</div>
      <h2>Describe an action. Your agent proposes; you decide.</h2>
      {/* ⭐⭐ "with live pricing" LIVED HERE FOR FOUR DEFERRALS AND WAS A MIS-SALE.
          This is the card a buyer reads BEFORE paying; the hedge ("fees may be
          disproportionately large", job #181044) is in the artifact they receive AFTER.
          That ordering is what made it a mis-sale rather than a disappointment.

          ⚠️ THE ASYMMETRY IS REAL AND MUST NOT BE FLATTENED IN EITHER DIRECTION:
            · BRIDGE — our own timestamped fee table is injected as grounding (8c1d1e9),
              so a bridge brief CAN state a measured figure.
            · SWAP  — Circle's createSwap has returned "No route available" for USDC↔EURC
              on Arc testnet since ~2026-08-14, so a swap cannot be priced AT ALL.
          Promising pricing flatly is false for swaps; promising none understates bridges.

          ⭐ SO THE CLAIM IS ABOUT CONDUCT, NOT COVERAGE — "measured where measurable,
          honest where not, never invented". That survives the outage ending, which a
          claim naming the swap drought would not. Copy with a shelf life is how the
          unified-balance guard came to enforce a lie twice; do not repeat it here. */}
      <div className="sub">
        Describe an on-chain action in plain language. Your agent researches its real
        economics from cited sources, then proposes a concrete plan. Where a fee can be
        measured, it is quoted as a measured figure with its timestamp; where it cannot,
        the agent says so rather than inventing a number.{" "}
        <b>Nothing moves until you approve it.</b> Today the agent can{" "}
        <b>bridge USDC off Arc</b> (Ethereum, Base, Arbitrum, Optimism, Avalanche, Polygon,
        Unichain, Linea) or <b>convert between USDC and EURC on Arc</b>.
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <input
          placeholder="e.g. Should I convert 5 USDC to EURC? Or bridge some USDC to Base?"
          value={task}
          onChange={(e) => setTask(e.target.value)}
        />
        <button
          disabled={busy || !task}
          onClick={() =>
            run(async () => {
              const r = await fetch("/.netlify/functions/plan-quote", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ task }),
              });
              const data = await r.json();
              if (!r.ok) throw new Error(data.error || "Quote failed");
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
            Your agent can plan an action it is able to bound, price, and refuse — not an
            open-ended opinion. "What's the best chain?" or "should I buy PEPE?" have nothing
            to approve; "bridge 2 USDC to Base" or "convert 5 USDC to EURC" do.
          </div>
        </div>
      )}

      {quote && (
        <div
          className="status"
          style={{ marginTop: 14, padding: "16px 18px", background: "var(--field)", border: "1px solid var(--line)", borderRadius: 12 }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ color: "var(--muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Price to research this action
            </span>
            <span style={{ fontSize: "1.2rem", fontWeight: 600, color: "var(--paper)" }}>{quote.budgetUsdc} USDC</span>
          </div>
          <div style={{ marginTop: 6, color: "var(--paper-dim)" }}>
            Your agent researches the action's economics from real sources. This fee is for the
            research only — any action it proposes needs your separate approval.
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button
              className="emerald"
              disabled={busy || !wallet.address}
              onClick={() =>
                run(async () => {
                  setRunStatus("Authorizing…");
                  const token = await wallet.ensureSession();
                  pollTokenRef.current = token;

                  setRunStatus("Starting your agent…");
                  // The SAME job-run the research flow uses. plan-quote priced it; nothing
                  // about the pipeline differs — only the classifier that let it through.
                  const r = await fetch("/.netlify/functions/job-run", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ question: task, budgetUsdc: quote.budgetUsdc }),
                  });
                  const data = await readJson(r);
                  if (r.status === 402) throw new Error(data.error || "Insufficient funds.");
                  if (!r.ok) throw new Error(data.error || "Could not start the plan");

                  setRunStatus("");
                  setQuote(null);
                  setTrackedJob({ runId: data.runId, status: "starting" });
                })
              }
            >
              {busy ? runStatus || "Working…" : `Research this action · ${quote.budgetUsdc} USDC`}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="status" style={{ marginTop: 12, color: "var(--danger, #e5484d)" }}>
          {error}
        </div>
      )}

      {trackedJob && (
        <div style={{ marginTop: 16 }}>
          <JobTimeline
            job={trackedJob}
            onApprove={approveProposal}
            approving={approving}
            approveError={approveError}
          />
        </div>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="linkbtn" onClick={() => go("dashboard")}>
          ← Back to dashboard
        </button>
      </div>
    </div>
  );
}
