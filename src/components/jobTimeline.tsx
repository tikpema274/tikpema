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
  /** ⭐ When estimateSwapOnly actually ran — see _proposal.mjs. Optional: older proposals lack it. */
  pricedAt?: string;
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

// Brick 2 — the SECOND, INDEPENDENT opinion. Analyst B never reads the web: it prices the
// same action against an independent market source AND the live chain. Its verdict can KILL a
// proposal the first analyst argued for.
export type SecondOpinion = {
  verdict: "proceed" | "caution" | "refuse" | "cannot_verify" | "no_action";
  headline: string;
  facts?: string[];
  fairRate?: number;
  executable?: number;
  spreadPct?: number;
  roundTrip?: number;
  feeUsdc?: number;
  netUsdc?: number;
};
// The reconciliation. ⚠️ Decided by PLAIN CODE, never a model — a synthesizer that adjudicates
// would smooth over exactly the disagreement this exists to surface.
export type Synthesis = {
  // ⭐ SIX STATES, EACH A DIFFERENT FACT. cannot_execute and not_actionable were previously
  // collapsed into hard_disagree, which told the buyer their analysts disagreed when nobody did.
  agreement: "agree" | "caution" | "hard_disagree" | "cannot_execute" | "not_actionable" | "unverified" | "no_action";
  proposalSurvives: boolean;
  headline: string;
  detail: string;
};

export type TrackedJob = {
  runId?: string;
  jobId?: string;
  status: string;
  brief?: {
    answer?: string; reasoning?: string; sources?: any[]; confidence?: number;
    // ⭐ WHAT THE BUYER IS TOLD ABOUT HOW THIS BRIEF WAS SOURCED. Optional because briefs
    // written before 2026-08-19 have none; absent renders nothing, present always renders.
    dataDisclosure?: string;
    // Retrieved but carrying no claim. SEPARATE from `sources` by design — merging them
    // is the defect this field exists to prevent. Optional: briefs written before the
    // derivation landed have no such field, and must still render.
    retrievedNotCited?: any[];
    // ⭐ Entries carry `n` — their 1-based position in the GROUNDING BLOCK the model read, not
    // their position in whichever list they landed in. Legacy briefs have no `n` and render
    // unnumbered rather than wrongly numbered.
    // A's RAW proposal — kept even when the server refused to author one, because the
    // KILLED case needs to show what A actually argued for.
    proposal?: { reasoning?: string; [k: string]: any } | null;
  };
  proposal?: Proposal;
  secondOpinion?: SecondOpinion;
  synthesis?: Synthesis;
  receipt?: Receipt;
  verdict?: string;
  reason?: string;
  // Which KIND of refusal this was. Optional: jobs refunded before the class existed
  // carry none, and must fall to the vaguest headline rather than borrow a specific one.
  refundClass?: string | null;
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

// ── THE REFUND HEADLINE ──────────────────────────────────────────────────────────────
// Every refund used to read "Refunded — deliverable didn't meet the bar." That sentence
// is TRUE for exactly one path — a judge read the deliverable and failed it on merit —
// and it was being said about paths where NO JUDGEMENT HAPPENED AT ALL: an uncited brief,
// an unparseable one, an internal throw. It implied a verdict we never reached.
//
// ⭐ SAME SHAPE AS THE WATCH ALERT'S cannot-verify / known-broken SPLIT. A failure to
// EVALUATE is not an evaluated failure, and the vaguer statement is the safe one: an
// UNRECOGNISED class must fall to the vaguest headline, NEVER to a specific one, because
// claiming a cause we did not establish is the costlier error. The map is exhaustive over
// the classes producers actually write, and `default` catches everything else — including
// jobs refunded before `refundClass` existed, which carry none.
const REFUND_HEADLINES: Record<string, string> = {
  uncited: "Refunded — we couldn't evidence this answer.",
  "no-brief": "Refunded — we couldn't produce a usable brief.",
  // We threw. The cause is ours and uncharacterised — say less, don't guess.
  "internal-error": "Refunded — this job didn't complete.",
  // The ONLY class for which a quality judgement was actually made.
  "judge-rejected": "Refunded — the deliverable didn't meet the bar.",
};
function refundHeadline(refundClass?: string | null): string {
  return (refundClass && REFUND_HEADLINES[refundClass]) || "Refunded.";
}

// ⭐⭐ THE GROUNDING NUMBER, RENDERED. The prose cites [n] against the block the model read; both
// lists are SUBSETS of that block, so numbering either from 1 creates a second coordinate system
// and the marker in the text stops pointing at anything (#181044 cited [8] against a bulleted list
// with no numbers at all; #180679 was the same at [5]/[6]).
// ⭐ The gaps ARE the information: cited [1],[3],[4] and not-used [2],[5],[8] are complementary by
// construction, so a reader can follow any marker into exactly one list and check the two against
// each other.
// ⚠️ Absent `n` renders NOTHING rather than a guessed position — a wrong number is worse than none.
function GroundingMark({ n }: { n?: number }) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>[{n}] </span>;
}

// Render the research brief: answer, reasoning, and sources as clickable links.
// Sources may be {title, url} objects or bare URL strings — handle both.
export function Brief({ brief }: { brief: NonNullable<TrackedJob["brief"]> }) {
  return (
    <div style={{ marginTop: 8 }}>
      {/* ═══ ⭐⭐ ABOVE THE ANSWER, NOT BELOW IT ══════════════════════════════════════════════
          A caveat placed under the thing it qualifies is read after the reader has already
          formed a view — the same reason the DD discovery page puts its warning above the curl
          rather than at the foot of the page. This states how the brief was sourced BEFORE the
          brief is read.
          🚨 AND IT EXISTS BECAUSE THE FIELD WAS ALREADY IN THE SIGNED BYTES AND NO ONE COULD SEE
          IT. dataDisclosure shipped inside the hashed report on 2026-08-19 with zero renderers —
          the errata_note failure exactly: present in the data, dropped by the projection. The
          hash covers transit tampering; it never covered rendering. */}
      {brief.dataDisclosure && (
        <div
          style={{
            marginBottom: 10, padding: "8px 10px", borderRadius: 8,
            background: "var(--field)", border: "1px solid var(--line)",
            color: "var(--paper-dim)", fontSize: "0.86rem",
          }}
        >
          {brief.dataDisclosure}
        </div>
      )}
      {brief.answer && (
        <div>
          <b>Answer:</b> {brief.answer}
        </div>
      )}
      {brief.reasoning && <div style={{ marginTop: 4 }}>{brief.reasoning}</div>}
      {/* ⚠️ "Sources:" ASSERTS SUPPORT. It must therefore list only what the answer
          actually cites — see _research.mjs, where the list is derived from the brief's
          own references rather than passed through from retrieval. Anything retrieved and
          NOT used renders below under its own heading, deliberately un-clickable-as-
          evidence in tone. Never merge the two lists: that is the exact defect this fixes
          (job #160108 listed six sources for an answer that referenced two, including two
          exchange FAQs matched on the word "Unified"). */}
      {Array.isArray(brief.sources) && brief.sources.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <b>Sources:</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {brief.sources.map((s: any, i: number) => {
              const url = typeof s === "string" ? s : s?.url;
              const title = typeof s === "string" ? s : s?.title || s?.url;
              if (!url && s?.kind !== "measured") return null;
              return (
                <li key={i} style={{ listStyle: s?.n ? "none" : undefined, marginLeft: s?.n ? -18 : undefined }}>
                  <GroundingMark n={s?.n} />
                  <a href={url} target="_blank" rel="noreferrer">
                    {title}
                  </a>
                  {s?.kind === "measured" && (
                    <span style={{ color: "var(--muted)" }}> — measured by us{s?.measuredAt ? `, ${String(s.measuredAt).replace("T", " ").replace(/\.\d+Z$/, "Z")}` : ""}</span>
                  )}

                </li>
              );
            })}
          </ul>
        </div>
      )}
      {Array.isArray(brief.retrievedNotCited) && brief.retrievedNotCited.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {/* ═══ ⭐⭐ THE HEADING ASSERTS WHAT WE MEASURED, NOT WHAT WE INFERRED ══════════════════
              "no claim above rests on them" is a claim about the PROSE — an inference we cannot
              check, and one job #181056 falsified: the body cited [7][8] for a price while both sat
              under this heading. `isCited` measures whether the MODEL LISTED a source, so that is
              what the heading may say.
              ⭐ Same rule as the DD policy ceiling: "nothing was found against your rules", never
              "safe". State the measurement; never upgrade it to the conclusion a reader wants. */}
          {/* ⭐ "Retrieved," DROPPED. Our own fee table is a MEASUREMENT, not a retrieval, and it
              sits in this partition like any other grounding entry so markers resolve. A heading
              saying "Retrieved" would assert the wrong provenance for it. The heading's job is to
              state what we measured about the MODEL'S output — which is unchanged — and provenance
              belongs on the entry. Same rule that replaced "no claim rests on them". */}
          <b style={{ color: "var(--muted)" }}>Not listed by the model as sources:</b>{" "}
          <span className="qd" style={{ color: "var(--muted)" }}>
            available to it; the model did not name them in its own source list.
          </span>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, color: "var(--muted)" }}>
            {brief.retrievedNotCited.map((s: any, i: number) => {
              const url = typeof s === "string" ? s : s?.url;
              const title = typeof s === "string" ? s : s?.title || s?.url;
              if (!url && s?.kind !== "measured") return null;
              return (
                <li key={i} style={{ listStyle: s?.n ? "none" : undefined, marginLeft: s?.n ? -18 : undefined }}>
                  <GroundingMark n={s?.n} />
                  <a href={url} target="_blank" rel="noreferrer" style={{ color: "var(--muted)" }}>
                    {title}
                  </a>
                  {s?.kind === "measured" && (
                    <span style={{ color: "var(--muted)" }}> — measured by us{s?.measuredAt ? `, ${String(s.measuredAt).replace("T", " ").replace(/\.\d+Z$/, "Z")}` : ""}</span>
                  )}

                  {/* ⭐ THE ANNOTATION COMPLETES THE HEADING RATHER THAN PATCHING IT. The heading says
                      what the list IS; this says why THIS entry looks odd — the prose cites it and
                      the model did not list it. Without it the reader meets a visible
                      self-contradiction with no account of it, which is worse than the invisible
                      version it replaced. */}
                  {s?.citedInProse && (
                    <span style={{ color: "var(--muted)", fontStyle: "italic" }}>
                      {" "}— cited in the text but not listed by the model as a source.
                    </span>
                  )}
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
  // Brick 2. A proposal only reaches the user if the SECOND analyst left it standing, so the
  // fact that it survived a real, independent check is part of the offer — not a footnote.
  secondOpinion?: SecondOpinion;
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
  headline, terms, reasoning, receipt, approving, onApprove, error, cta, secondOpinion,
}: {
  headline: React.ReactNode;
  terms: React.ReactNode;
  reasoning?: string;
  receipt?: Receipt;
  approving?: boolean;
  onApprove?: () => void;
  error?: string;
  cta: { idle: string; busy: string };
  secondOpinion?: SecondOpinion;
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

      {/* ⚠️ ABOVE THE BUTTON, deliberately. A second, independent analyst priced this and
          concurred — the user reaches that fact before they reach the thing that spends their
          money. A caveat ("agreed, but the spread is 2.3%") is preserved verbatim, NEVER
          averaged into a confidence score. */}
      {secondOpinion && <SecondOpinionConfirmed secondOpinion={secondOpinion} />}

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
// INDICATIVE, exactly like the bridge's fee — it is re-priced at execution, and the swap carries
// an ON-CHAIN MINIMUM below which the adapter reverts rather than filling.
//
// ⛔ THIS USED TO SAY "a 1% slippage cap makes the swap revert", AND THAT WAS WRONG. Our
// `slippageBps: 100` reaches only `estimateSwapOnly` — the free estimate. The EXECUTING path
// (the B1 `createSwap` HTTP quote in _swap.mjs) sends no slippage parameter at all, so the
// `minTokenOut` that actually binds is Circle's, not ours.
// ⚠️ AND NO PERCENTAGE REPLACES IT. A figure was measured, but from four quotes at one moment on
// one route — enough to prove the 1% claim false, not enough to assert a different constant.
// Naming the new number would repeat the original defect with a fresher value.
// See docs/swap-slippage-copy-overclaim.md.
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
          {/* ⭐ WHEN IT WAS PRICED, NOT JUST WHAT IT PRICED AT. An indicative number with no
              timestamp cannot be judged for freshness — the reader cannot tell a figure measured
              seconds ago from one measured before a long approval pause. CoinGecko's price already
              arrives as "usd-coin $0.999665 (as of …Z)"; our OWN measurement was the one without
              provenance, which is the wrong way round. `pricedAt` is set by _proposal.mjs at the
              moment estimateSwapOnly returns. Absent on older proposals → renders nothing. */}
          {proposal.pricedAt && (
            <> Priced against your wallet at{" "}
              <span className="mono">{String(proposal.pricedAt).replace("T", " ").replace(/\.\d+Z$/, "Z")}</span>.
            </>
          )}
        </>
      }
    />
  );
}

// ── BRICK 2 — THE DISAGREEMENT, RENDERED ────────────────────────────────────────────────
//
// ⚠️ THE KILLED CASE IS THE MOST IMPORTANT THING ON THIS PAGE, and it used to be INVISIBLE:
// the proposal simply did not appear, so a user would assume the agent had failed. It had
// not — it had PROTECTED them. Two analysts disagreed and the action was withdrawn.
//
// So this card renders WHEN THERE IS NOTHING TO APPROVE, and it must read as the system
// working, not breaking.
//
// ⚠️ THE DISAGREEMENT IS PRESERVED, NEVER AVERAGED. There is no "medium confidence" blend, no
// split-the-difference score. The user sees BOTH views — what A argued, and what B objected to
// — because a number that hides a conflict is worse than no number at all.
export function SecondOpinionCard({
  synthesis, secondOpinion, analystAReasoning,
}: {
  synthesis: Synthesis;
  secondOpinion?: SecondOpinion;
  analystAReasoning?: string;
}) {
  const killed = !synthesis.proposalSurvives && synthesis.agreement !== "no_action";
  // ⭐ AN OUTAGE IS NOT A WITHHELD ACTION. "Your analysts disagreed" and "this is the safeguard
  // working, not a failure" are both TRUE of a disagreement and both FALSE of a venue being down:
  // nobody disagreed, and something IS failing — just not us and not the user.
  const outage = synthesis.agreement === "cannot_execute";
  const notActionable = synthesis.agreement === "not_actionable";
  const tension = synthesis.agreement === "caution";

  // A killed proposal is a WITHHELD ACTION, not an error — amber (attention), not red (alarm).
  // Red would tell the user something broke. Nothing broke.
  const accent = killed ? "var(--amber)" : tension ? "var(--amber)" : "var(--line)";

  return (
    <div
      className="status"
      style={{
        marginTop: 12, padding: "14px 16px", background: "var(--field)",
        border: `1px solid ${accent}`, borderRadius: 12,
      }}
    >
      <div style={{ color: "var(--muted)", fontSize: "0.72rem", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
        {outage
          ? "No action taken · this cannot be carried out right now"
          : notActionable
          ? "No action taken · there was nothing to price"
          : killed
          ? "No action proposed · your analysts disagreed"
          : "Second opinion"}
      </div>

      <div style={{ fontSize: "1.05rem", color: "var(--paper)" }}>{synthesis.headline}</div>

      {/* ⚠️ THE REASSURANCE IS PER-STATE. Telling a user "the safeguard is working" during an
          outage is false comfort about a real failure — and telling them their analysts disagreed
          when both agreed is simply untrue. */}
      {outage && (
        <div className="sub" style={{ margin: "8px 0 0" }}>
          This is <b>not a disagreement</b> and <b>not something you did</b>. Both analysts agree the
          action is sound in principle — the venue that would carry it out is not currently accepting
          it. This is usually temporary. <b>Nothing has been spent and nothing is stuck</b>; you can
          try again later.
        </div>
      )}
      {notActionable && (
        <div className="sub" style={{ margin: "8px 0 0" }}>
          There was not enough of a proposal to check, so <b>no judgement was made</b> about whether
          the action is a good idea.
        </div>
      )}
      {killed && !outage && !notActionable && (
        <div className="sub" style={{ margin: "8px 0 0" }}>
          Your agent has <b>withheld the action</b>. Nothing will be proposed and nothing can be
          approved — this is the safeguard working, not a failure.
        </div>
      )}

      {/* BOTH VIEWS, SIDE BY SIDE. The user sees the actual disagreement, not a verdict. */}
      <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
        {analystAReasoning && (
          <View
            label="Your researcher argued"
            tone="neutral"
            body={analystAReasoning}
          />
        )}
        {secondOpinion && (
          <View
            label={
              secondOpinion.verdict === "refuse" ? "Your second opinion refused"
              : secondOpinion.verdict === "caution" ? "Your second opinion cautioned"
              : secondOpinion.verdict === "cannot_verify" ? "Your second opinion could not verify it"
              : "Your second opinion checked it"
            }
            tone={secondOpinion.verdict === "refuse" ? "objection" : "neutral"}
            body={secondOpinion.headline}
            facts={secondOpinion.facts}
          />
        )}
      </div>

      <div className="sub" style={{ margin: "10px 0 0", fontStyle: "italic" }}>
        Your second opinion never reads the web. It prices the action against an independent
        market source and against the live chain — so it can see things a research brief cannot.
      </div>
    </div>
  );
}

function View({
  label, body, facts, tone,
}: {
  label: string; body: string; facts?: string[]; tone: "neutral" | "objection";
}) {
  return (
    <div
      style={{
        padding: "10px 12px", borderRadius: 10,
        borderLeft: `3px solid ${tone === "objection" ? "var(--amber)" : "var(--line)"}`,
        background: tone === "objection" ? "var(--amber-soft)" : "transparent",
      }}
    >
      <div style={{ color: "var(--muted)", fontSize: "0.7rem", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ color: "var(--paper)" }}>{body}</div>
      {/* The NUMBERS B worked from. This is what makes the objection checkable rather than
          another opinion — the user can see the fair rate, the executable rate, the spread. */}
      {facts && facts.length > 0 && (
        <ul className="sub" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {facts.map((f, i) => (
            <li key={i} style={{ marginBottom: 2 }}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The AGREE case, shown ABOVE the approve button: a second, independent analyst priced this
// and concurred. Not buried — the user should know the proposal survived a real check.
export function SecondOpinionConfirmed({ secondOpinion }: { secondOpinion: SecondOpinion }) {
  const caution = secondOpinion.verdict === "caution";
  return (
    <div
      style={{
        marginTop: 10, padding: "10px 12px", borderRadius: 10,
        borderLeft: `3px solid ${caution ? "var(--amber)" : "var(--emerald, #74c29c)"}`,
        background: caution ? "var(--amber-soft)" : "transparent",
      }}
    >
      <div style={{ color: "var(--muted)", fontSize: "0.7rem", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 4 }}>
        {caution ? "⚠ Second opinion — agreed, with a caveat" : "✓ Second opinion confirmed"}
      </div>
      <div style={{ color: "var(--paper)" }}>{secondOpinion.headline}</div>
      {secondOpinion.facts && secondOpinion.facts.length > 0 && (
        <ul className="sub" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
          {secondOpinion.facts.map((f, i) => (
            <li key={i} style={{ marginBottom: 2 }}>{f}</li>
          ))}
        </ul>
      )}
      <div className="sub" style={{ margin: "6px 0 0", fontStyle: "italic" }}>
        Checked independently — against the market and the live chain, not the web.
      </div>
    </div>
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
              secondOpinion={job.secondOpinion}
            />
          )}

          {/* ⚠️ THE KILLED CASE. Rendered precisely BECAUSE there is no proposal.
              Without this the user sees nothing and concludes the agent failed — when in fact
              two independent analysts disagreed and the action was WITHHELD. The safeguard
              working must not look like the system breaking. */}
          {!job.proposal && job.synthesis && job.synthesis.agreement !== "no_action" && (
            <SecondOpinionCard
              synthesis={job.synthesis}
              secondOpinion={job.secondOpinion}
              analystAReasoning={job.brief?.proposal?.reasoning}
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
          <div>{refundHeadline(job.refundClass)}</div>
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
