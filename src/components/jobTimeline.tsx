// jobTimeline.tsx — shared paid-research-job rendering primitives.
//
// Extracted from ResearchPanel so both ResearchPanel and PredictPanel render
// the SAME deliver→settle timeline, brief, and tx links without duplicating
// them. The lifecycle (quote → create → fund → submit → poll job-deliverable)
// lives in each panel; this file owns only the shared types + presentation.

// The live deliver→settle record we poll after a hire+fund. The backend
// auto-chains submit→evaluate→settle, so the browser fires submit once then
// polls job-deliverable for the merged status.
export type TrackedJob = {
  runId?: string;
  jobId?: string;
  status: string;
  brief?: { answer?: string; reasoning?: string; sources?: any[]; confidence?: number };
  verdict?: string;
  reason?: string;
  settleTx?: string;
  settleTxUrl?: string;
  error?: string;
};

// Status values that end the timeline — once reached, stop polling.
export const TERMINAL_STATUSES = ["completed", "rejected", "eval-error", "failed"];
export const isTerminal = (s: string) => TERMINAL_STATUSES.includes(s);

export function TxLink({ url, label }: { url: string; label?: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {label ?? "View transaction ↗"}
    </a>
  );
}

// Render the research brief: answer, reasoning, and sources as clickable links.
// Sources may be {title, url} objects or bare URL strings — handle both.
export function Brief({ brief }: { brief: NonNullable<TrackedJob["brief"]> }) {
  return (
    <div style={{ marginTop: 8 }}>
      {brief.answer && (
        <div>
          <b>Answer:</b> {brief.answer}
        </div>
      )}
      {brief.reasoning && <div style={{ marginTop: 4 }}>{brief.reasoning}</div>}
      {Array.isArray(brief.sources) && brief.sources.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <b>Sources:</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {brief.sources.map((s: any, i: number) => {
              const url = typeof s === "string" ? s : s?.url;
              const title = typeof s === "string" ? s : s?.title || s?.url;
              if (!url) return null;
              return (
                <li key={i}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {title}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// The live deliver→settle timeline. Maps the merged job status to four stages
// (Funded → Researching → Evaluating → Settled), showing a checkmark for passed
// stages and a spinner for the active one, then a terminal result block.
export function JobTimeline({ job }: { job: TrackedJob }) {
  const STAGES = ["Funding", "Researching", "Evaluating", "Settled"];

  // Map a status to how many stages are complete/active. -1 = errored (no stage
  // spinner; the error block below carries the message instead).
  const stageIndex = (status: string): number => {
    switch (status) {
      // Server-driven create + fund on the user's own wallet (Brick 2b).
      case "starting":
      case "creating":
      case "funding":
      case "funded":
        return 0;
      case "submitting":
      case "submitted":
        return 1;
      case "evaluating":
        return 2;
      case "settling":
      case "pending":
        return 3;
      case "completed":
      case "rejected":
        return 4; // every stage done
      default:
        return -1; // eval-error / failed / unknown
    }
  };

  const idx = stageIndex(job.status);
  const errored = job.status === "eval-error" || job.status === "failed";

  return (
    <div className="status" style={{ margin: 0 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        {job.jobId ? `Job #${job.jobId}` : "Starting your job…"}
      </div>

      <div className="row" style={{ gap: 16, marginBottom: 4, flexWrap: "wrap" }}>
        {STAGES.map((label, i) => {
          const done = !errored && idx > i;
          const active = !errored && idx === i;
          return (
            <span
              key={label}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: done || active ? 1 : 0.4 }}
            >
              {active ? <span className="spinner" /> : <span>{done ? "✓" : "•"}</span>}
              {label}
            </span>
          );
        })}
      </div>

      {job.status === "completed" && (
        <div style={{ marginTop: 8 }}>
          <div>✓ Delivered &amp; settled — agent paid.</div>
          {job.brief && <Brief brief={job.brief} />}
          {job.settleTxUrl && (
            <div style={{ marginTop: 4 }}>
              <TxLink url={job.settleTxUrl} label="View settlement ↗" />
            </div>
          )}
        </div>
      )}

      {job.status === "rejected" && (
        <div style={{ marginTop: 8 }}>
          <div>Refunded — deliverable didn't meet the bar.</div>
          {job.reason && <div style={{ marginTop: 4 }}>{job.reason}</div>}
          {job.brief && <Brief brief={job.brief} />}
          {job.settleTxUrl && (
            <div style={{ marginTop: 4 }}>
              <TxLink url={job.settleTxUrl} label="View refund ↗" />
            </div>
          )}
        </div>
      )}

      {errored && (
        <div style={{ marginTop: 8, color: "#f5a623" }}>
          <div>
            Something went wrong while{" "}
            {job.status === "failed" ? "researching" : "evaluating"} this job.
          </div>
          {(job.reason || job.error) && (
            <div style={{ marginTop: 4 }}>{job.reason || job.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
