import type { ReactNode } from "react";

// BridgeQuoteSummary — the labelled rows shown BEFORE the burn.
//
// ⭐ EXTRACTED SO IT CAN BE RENDERED WITHOUT THE PANEL. It appears only once a quote exists, and
// `renderToStaticMarkup` emits the INITIAL state — so inside BridgePanel it is invisible to every
// copy suite and to any static preview. Same reason SendReviewBox, SwapReview and FeeDisclosureBox
// were extracted: a state behind a transition is untested, and unviewable, by default.
// [[state-behind-a-transition-is-untested-by-default]]
export function BridgeQuoteSummary({ quote }: { quote: any }): ReactNode {
  return (
    <div className="summary-block">
      {/* ⭐ LABELLED ROWS, NOT PROSE. Facts a reader scans rather than parses. */}
      <div className="summary-row"><span>Fee</span>
        <b className="mono">{Number(quote.feeUsdc).toFixed(4)} USDC</b></div>
      <div className="summary-row"><span>You receive</span>
        <b className="mono">{Number(quote.netUsdc).toFixed(4)} USDC</b></div>
      {/* ⭐⭐ THIS QUALIFIES THE TWO ROWS ABOVE, so it sits under them rather than becoming a
          peer row. It is not a value — it is a statement ABOUT the value — and a `Binding: held`
          row would be jargon while `Quote valid: 3 min` would say something true but different,
          dropping the part that matters: this figure is the one that gets signed. */}
      <div className="summary-note">
        This is the fee that will be charged — quoted just now and held for this bridge, not
        re-read when it runs. Price it again if you wait.
      </div>
      <div className="summary-row"><span>Settlement</span>
        <span>a few minutes (up to ~20 for some chains)</span></div>
      <div className="summary-row"><span>Route</span>
        <span>Arc to {quote.destination.label} via CCTP</span></div>
      {/* ⭐⭐ PERMISSION, NOT EXPLANATION — and said BEFORE the press, which is exactly where the
          manual panel says its OPPOSITE. That panel warns "stay on this page until the burn
          confirms" because its burn is signed in the BROWSER and the receipt is written by a
          SECOND request; close the tab between and the record is lost. Here the server burns and
          writes the receipt in ONE request, so no such window exists (verify-user-bridge-
          recovery.mjs §3). Two panels, opposite instructions, both correct — and a user who has
          seen both needs the difference AT THE MOMENT, not below the fold. */}
      <div className="summary-note">
        You can leave this page once it starts — the bridge completes on its own.
      </div>
    </div>
  );
}
