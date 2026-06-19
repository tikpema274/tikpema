import { useState } from "react";
import type { ModularWallet } from "../wallet/useModularWallet";

// FeedbackPanel — a plain in-app feedback form that relays to a Discord webhook
// via /api/submit-feedback. The webhook URL is a server-side secret; the
// browser only ever talks to our own function. If a passkey wallet is
// connected, its address rides along so feedback from someone who actually bet
// is distinguishable from a plain browser. Touches no agent/predict/bet logic.
export default function FeedbackPanel({ wallet }: { wallet: ModularWallet }) {
  const [thoughts, setThoughts] = useState("");
  const [confusion, setConfusion] = useState("");
  const [wouldReturn, setWouldReturn] = useState("maybe");
  const [handle, setHandle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  const canSubmit =
    !submitting && (thoughts.trim().length > 0 || confusion.trim().length > 0);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/submit-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thoughts,
          confusion,
          wouldReturn,
          handle,
          // Auto-include the connected wallet so you can tell bettors apart.
          walletAddress: wallet.address ?? "",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
      // Clear the form only once it's safely delivered.
      setThoughts("");
      setConfusion("");
      setWouldReturn("maybe");
      setHandle("");
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="plane">
      <h2>How was it? Leave feedback</h2>
      <div className="sub">
        A few words go straight to the team · totally optional
      </div>

      <label className="field">
        <span>What did you think?</span>
        <textarea
          rows={3}
          value={thoughts}
          onChange={(e) => {
            setThoughts(e.target.value);
            setDone(false);
          }}
          placeholder="The good, the bad, the surprising…"
        />
      </label>

      <label className="field">
        <span>What confused you, even a little?</span>
        <textarea
          rows={3}
          value={confusion}
          onChange={(e) => {
            setConfusion(e.target.value);
            setDone(false);
          }}
          placeholder="Anything that made you pause or guess"
        />
      </label>

      <label className="field">
        <span>Would you use this again?</span>
        <select
          value={wouldReturn}
          onChange={(e) => setWouldReturn(e.target.value)}
        >
          <option value="yes">Yes</option>
          <option value="maybe">Maybe</option>
          <option value="no">No</option>
        </select>
      </label>

      <label className="field">
        <span>Your name (optional)</span>
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="So we can thank you"
        />
      </label>

      <div className="row">
        <button className="emerald" disabled={!canSubmit} onClick={submit}>
          {submitting ? "Sending…" : "Submit feedback"}
        </button>
      </div>

      {done && (
        <div className="status" style={{ color: "var(--emerald)" }}>
          Thanks! Your feedback came through.
        </div>
      )}
      {error && (
        <div className="status" style={{ color: "#f5a623" }}>
          Couldn't send that — {error}. Your words are still here; try again.
        </div>
      )}
    </div>
  );
}
