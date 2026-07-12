// jobTimeline.tsx — shared paid-research-job rendering primitives.
//
// Extracted from ResearchPanel so both ResearchPanel and PredictPanel render
// the SAME deliver→settle timeline, brief, and tx links without duplicating
// them. The lifecycle (quote → create → fund → submit → poll job-deliverable)
// lives in each panel; this file owns only the shared types + presentation.

// The live deliver→settle record we poll after a hire+fund. The backend
// auto-chains submit→evaluate→settle, so the browser fires submit once then
// polls job-deliverable for the merged status.
// A server-VALIDATED bridge proposal. The model suggested it; the server resolved the
// destination, bounded the amount, and priced the fee itself. `indicativeFeeUsdc` is a
// courtesy, NOT a quote — the fee is re-priced again at execution.
// Two proposable actions, discriminated on `action` — the SAME field the server normalizes
// in _proposal.mjs and the same field job-*-approve dispatches on. A new action type must
// extend this union, so TypeScript forces every surface to handle it rather than silently
// falling through to the bridge card.
export type BridgeProposal = {
  action: "bridge_usdc";
  destination: string;
  destinationLabel: string;
  amountUsdc: number;
  cap: number;
  indicativeFeeUsdc: number;
  indicativeNetUsdc: number;
  reasoning?: string;
};
export type SwapProposal = {
  action: "swap_tokens";
  tokenIn: "USDC" | "EURC";
  tokenOut: "USDC" | "EURC";
  amountIn: number;
  valueUsdc: number;
  cap: number;
  indicativeAmountOut: number;
  reasoning?: string;
};
export type Proposal = BridgeProposal | SwapProposal;

// A server-PROVEN receipt. Every field is server-sourced; the client never supplies one.
// `state` is the ONLY field to branch on — never render "minted" without a mintTxHash.
// One receipt shape covering BOTH actions. A bridge's states track a CCTP burn → attestation
// → destination mint; a swap's track a same-chain tx that either lands on Arc or does not.
// They never overlap, so `state` alone tells you which action produced the receipt.
export type Receipt = {
  state:
    // bridge
    | "approving" | "burn_pending" | "burn_confirmed"
    | "minted" | "mint_failed" | "mint_unconfirmed" | "mint_unverified"
    // swap — `submitted_no_hash` is the 1098 async-waiter quirk (the swap landed, but the
    // SDK returned no hash), and it is confirmed by BALANCE DELTA, never by an invented hash.
    | "submitted" | "submitted_no_hash" | "confirmed" | "failed" | "unconfirmed";
  amountUsdc?: number;
  destinationKey?: string;
  feeUsdc?: number;
  netUsdc?: number;
  burnHash?: string;
  burnTx?: string;
  mintTxHash?: string;
  mintTx?: string;
  usdcAmount?: number;
  // swap
  tokenIn?: "USDC" | "EURC";
  tokenOut?: "USDC" | "EURC";
  amountIn?: number;
  amountOut?: number;
  txHash?: string | null;
  tx?: string | null;
  verifiedBy?: "balance-delta";
  indicativeAmountOut?: number;
};

export type TrackedJob = {
  runId?: string;
  jobId?: string;
  status: string;
  brief?: { answer?: string; reasoning?: string; sources?: any[]; confidence?: number };
  proposal?: Proposal;
  receipt?: Receipt;
  verdict?: string;
  reason?: string;
  settleTx?: string;
  settleTxUrl?: string;
  error?: string;
};

// A receipt is "still moving" while the burn or the mint is unresolved — the panel must
// keep polling past `completed` until it settles, or the UI would freeze on
// burn_confirmed and never show the mint.
export const RECEIPT_PENDING = ["approving", "burn_pending", "burn_confirmed"];
export const receiptInFlight = (r?: Receipt) => !!r && RECEIPT_PENDING.includes(r.state);

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

// The approvable action the research produced. Rendering it is a money-path surface, so
// the copy is deliberately unflattering: the fee is indicative, the move is one-way.
//
// ⚠️ THE REASONING IS LOAD-BEARING, NOT DECORATION.
// validateProposal proves a proposal is well-FORMED (a known destination, an amount under
// the cap) and ECONOMICAL (fee priced live, fee-floor enforced). It does NOT prove the
// proposal is well-REASONED — an economically valid bridge can still be a bad idea. Until
// a reasoning/vetting gate exists (a slotted future brick), the HUMAN is that gate. So the
// agent's "why" is rendered FIRST, in body text, above the numbers and above the button —
// the user must read the argument before they can reach the thing that spends their money.
type ProposalCardProps = {
  proposal: Proposal;
  receipt?: Receipt;
  approving?: boolean;
  onApprove?: () => void;
  error?: string;
};

// Dispatch on the SAME discriminant the server normalizes and the approve endpoints use.
// Adding a proposable action means adding a branch here — TypeScript will not let a new
// action silently render as a bridge.
export function ProposalCard(props: ProposalCardProps) {
  return props.proposal.action === "swap_tokens"
    ? <SwapProposalBody {...props} proposal={props.proposal} />
    : <BridgeProposalBody {...props} proposal={props.proposal} />;
}

// Shared chrome so the two cards cannot drift apart: the same eyebrow, the same
// reasoning-first layout, the same "we cannot judge whether this is a good idea" disclaimer,
// and the same approve button that disappears once a receipt exists.
function ProposalShell({
  headline, terms, reasoning, receipt, approving, onApprove, error, cta,
}: {
  headline: React.ReactNode;
  terms: React.ReactNode;
  reasoning?: string;
  receipt?: Receipt;
  approving?: boolean;
  onApprove?: () => void;
  error?: string;
  cta: { idle: string; busy: string };
}) {
  // Once a receipt exists the proposal is spent — never offer approve twice.
  const alreadyActed = !!receipt;
  return (
    <div
      className="status"
      style={{ marginTop: 12, padding: "14px 16px", background: "var(--field)", border: "1px solid var(--line)", borderRadius: 12 }}
    >
      <div style={{ color: "var(--muted)", fontSize: "0.72rem", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
        Proposed action · you decide
      </div>

      <div style={{ fontSize: "1.05rem", color: "var(--paper)" }}>{headline}</div>

      {/* The agent's argument, first and prominent. The system cannot judge whether this
          reasoning is sound; the user must. */}
      {reasoning && (
        <div
          style={{
            marginTop: 10, padding: "10px 12px", borderRadius: 10,
            borderLeft: "3px solid var(--amber)", background: "var(--amber-soft)",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.7rem", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>
            Why the agent proposes this
          </div>
          <div style={{ color: "var(--paper)" }}>{reasoning}</div>
        </div>
      )}

      <div className="sub" style={{ margin: "10px 0 0" }}>{terms}</div>

      <div className="sub" style={{ margin: "8px 0 0", fontStyle: "italic" }}>
        Your agent checked that this action is possible and economical. It did not, and cannot,
        check that it is a <em>good idea</em> — read the reasoning above and decide for yourself.
      </div>

      {!alreadyActed && (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="emerald" disabled={approving} onClick={onApprove}>
            {approving ? cta.busy : cta.idle}
          </button>
        </div>
      )}
      {error && <div className="sub" style={{ margin: "8px 0 0", color: "var(--danger, #e5484d)" }}>{error}</div>}
    </div>
  );
}

function BridgeProposalBody({ proposal, ...rest }: ProposalCardProps & { proposal: BridgeProposal }) {
  return (
    <ProposalShell
      {...rest}
      reasoning={proposal.reasoning}
      cta={{ idle: `Approve — bridge ${proposal.amountUsdc} USDC`, busy: "Bridging…" }}
      headline={
        <>
          Bridge <span className="mono">{proposal.amountUsdc}</span> USDC from Arc to{" "}
          <b>{proposal.destinationLabel}</b>.
        </>
      }
      terms={
        <>
          The cross-chain fee is taken <b>out of</b> the amount — about{" "}
          <span className="mono">{proposal.indicativeFeeUsdc}</span> USDC right now, so roughly{" "}
          <span className="mono">{proposal.indicativeNetUsdc}</span> USDC would arrive. This is an
          indicative price, not a quote: the fee is re-checked at execution, and the bridge is
          refused if it no longer makes sense. Bridging is one-way.
        </>
      }
    />
  );
}

// SWAP — a stablecoin FX conversion (USDC↔EURC on Arc). Deliberately NOT framed as a trade
// or a call on the market: the agent proposes a conversion, the user approves it. The rate is
// INDICATIVE, exactly like the bridge's fee — it is re-estimated at execution and a 1%
// slippage cap makes the swap revert rather than fill at a bad rate.
function SwapProposalBody({ proposal, ...rest }: ProposalCardProps & { proposal: SwapProposal }) {
  return (
    <ProposalShell
      {...rest}
      reasoning={proposal.reasoning}
      cta={{
        idle: `Approve — convert ${proposal.amountIn} ${proposal.tokenIn}`,
        busy: "Converting…",
      }}
      headline={
        <>
          Convert <span className="mono">{proposal.amountIn}</span> {proposal.tokenIn} to{" "}
          <b>{proposal.tokenOut}</b> on Arc.
        </>
      }
      terms={
        <>
          You would receive roughly{" "}
          <span className="mono">{proposal.indicativeAmountOut}</span> {proposal.tokenOut} at the
          current rate. This is an indicative price, not a quote: the rate is re-checked at
          execution, and the swap reverts rather than filling more than 1% worse. Both are
          stablecoins, so this is a currency conversion (USD↔EUR exposure) — not a trade.
        </>
      }
    />
  );
}

// The server-proven record. Each state is rendered honestly — a pending mint is NOT a
// success, and mint_unverified is an alarm, not a spinner.
export function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const s = receipt.state;

  // SWAP states. A swap has no burn and no destination mint — it either lands on Arc or it
  // does not. `unconfirmed` is honest incompleteness, NEVER a fabricated success.
  const isSwap =
    s === "submitted" || s === "submitted_no_hash" || s === "confirmed" ||
    s === "failed" || s === "unconfirmed";

  const line = isSwap
    ? s === "confirmed" ? "✓ Converted and confirmed on Arc."
      : s === "failed" ? "The swap FAILED on-chain — it reverted, and no funds were converted."
      : s === "submitted" ? "Swap submitted — waiting for the chain to confirm it…"
      : s === "submitted_no_hash" ? "Swap submitted — confirming it against your balance…"
      : "⚠ The swap was submitted, but could not be confirmed. Your balance is the source of truth — check it before retrying. This has NOT been recorded as complete."
    : s === "minted" ? "✓ Bridged and confirmed on both chains."
    : s === "burn_confirmed" ? "Burn confirmed on Arc — waiting for the destination mint…"
    : s === "burn_pending" ? "Burn submitted — waiting for its transaction hash…"
    : s === "approving" ? "Approving…"
    : s === "mint_failed" ? "The destination mint FAILED."
    : s === "mint_unconfirmed" ? "Burn confirmed, but the mint could not be confirmed in time. The funds are not lost — check the burn below."
    : "⚠ The mint could not be independently verified on the destination chain. This needs a human — it has NOT been recorded as complete.";

  const alarm = s === "mint_unverified" || s === "mint_failed" || s === "failed" || s === "unconfirmed";

  return (
    <div
      className="status"
      style={{
        marginTop: 12, padding: "12px 14px", background: "var(--field)",
        border: `1px solid ${alarm ? "var(--danger, #e5484d)" : "var(--line)"}`,
        borderRadius: 12,
      }}
    >
      <div style={{ color: "var(--muted)", fontSize: "0.72rem", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
        Action receipt · server-verified
      </div>
      <div>{line}</div>

      {/* A CONFIRMED swap reports what ACTUALLY arrived, read from the chain — not the
          indicative estimate shown at approve time. When there was no tx hash (the SDK's 1098
          quirk), the confirmation came from the balance delta, and we say so rather than
          quietly implying a hash we never had. */}
      {isSwap && s === "confirmed" && receipt.amountOut !== undefined && (
        <div className="sub" style={{ margin: "6px 0 0" }}>
          <span className="mono">{receipt.amountIn}</span> {receipt.tokenIn} →{" "}
          <span className="mono">{receipt.amountOut}</span> {receipt.tokenOut} arrived
          {receipt.verifiedBy === "balance-delta" && (
            <> — the SDK returned no transaction hash, so this was verified by reading your
            balance on-chain</>
          )}
          .
        </div>
      )}

      {!isSwap && s === "minted" && receipt.usdcAmount !== undefined && (
        <div className="sub" style={{ margin: "6px 0 0" }}>
          <span className="mono">{receipt.usdcAmount}</span> USDC arrived (fee{" "}
          <span className="mono">{receipt.feeUsdc}</span>). Verified by Circle's attestation{" "}
          <b>and</b> an independent read of the destination chain.
        </div>
      )}

      <div className="row" style={{ marginTop: 8, gap: 14, flexWrap: "wrap" }}>
        {receipt.burnTx && <TxLink url={receipt.burnTx} label="Burn on Arc ↗" />}
        {/* Only ever link a mint we PROVED. mint_unverified deliberately shows no link. */}
        {receipt.mintTx && s === "minted" && <TxLink url={receipt.mintTx} label="Mint on destination ↗" />}
        {/* Swaps often have NO hash (the 1098 quirk) — link only when one genuinely exists. */}
        {isSwap && receipt.tx && <TxLink url={receipt.tx} label="Swap on Arc ↗" />}
      </div>
    </div>
  );
}

// The live deliver→settle timeline. Maps the merged job status to four stages
// (Funded → Researching → Evaluating → Settled), showing a checkmark for passed
// stages and a spinner for the active one, then a terminal result block.
export function JobTimeline({
  job, onApprove, approving, approveError,
}: {
  job: TrackedJob;
  // Optional: only ResearchPanel wires the proposal loop. PredictPanel passes none and
  // renders exactly as before.
  onApprove?: () => void;
  approving?: boolean;
  approveError?: string;
}) {
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
          {/* The proposal loop. Only a SETTLED brief may carry an approvable action —
              you cannot act on research that was rejected or refunded. */}
          {job.proposal && onApprove && (
            <ProposalCard
              proposal={job.proposal}
              receipt={job.receipt}
              approving={approving}
              onApprove={onApprove}
              error={approveError}
            />
          )}
          {job.receipt && <ReceiptCard receipt={job.receipt} />}
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
