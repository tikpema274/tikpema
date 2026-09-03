import { MINT_TIMING } from "../../shared/bridge-timing.mjs";
import type { ReactNode } from "react";

// BridgeQuoteSummary — the four things a bridge will cost and do, shown BEFORE the action.
//
// ═══ ⭐⭐ ALWAYS PRESENT, WITH EM-DASHES WHERE A VALUE IS NOT YET KNOWN ═════════════════════════
// This used to appear only once a quote existed, so the panel read as sparse and the user could not
// tell what they were about to be told. Showing the ROWS before the VALUES makes the shape of the
// answer visible in advance — the question "what will this cost me" has a place to land before it
// has an answer.
//
// ⭐ AND TWO OF THE FOUR ARE KNOWN WITHOUT A QUOTE. Settlement is static; Route follows from the
// destination select. So the pre-quote state shows two real values and two dashes — "waiting on a
// price", not "nothing here yet". Filling all four with dashes would have understated what the
// panel already knows.
//
// ⛔ THE HELD-QUOTE NOTE IS CONDITIONAL, DELIBERATELY. "This is the fee that will be charged" must
// never render beside an em-dash: it asserts a binding on a figure, and with no figure there is no
// binding to assert. It appears with the quote and not before.
// [[absence-must-never-read-as-safe]]
export function BridgeQuoteSummary(
  { quote, destinationLabel, secondsLeft }:
    { quote: any | null; destinationLabel?: string; secondsLeft?: number | null },
): ReactNode {
  const em = "—";
  return (
    <div className="summary-block">
      {/* ⭐ LABELLED ROWS, NOT PROSE. Facts a reader scans rather than parses. */}
      <div className="summary-row"><span>Fee</span>
        <b className="mono">{quote ? `${Number(quote.feeUsdc).toFixed(4)} USDC` : em}</b></div>
      {/* ⭐⭐ THE FEE IS CHARGED ON TOP, SO THE RECIPIENT GETS THE FULL AMOUNT — and the row that
          matters flipped with it. "You receive" used to be amount − fee; under upfront fees it is
          the amount, and the figure a user actually needs to plan around is what LEAVES THE WALLET.
          ⛔ Showing only "you receive" now would be true and useless: it would equal the number they
          typed, and the fee would appear nowhere in the outcome. */}
      <div className="summary-row"><span>You receive</span>
        <b className="mono">{quote ? `${Number(quote.netUsdc).toFixed(4)} USDC` : em}</b></div>
      <div className="summary-row"><span>Leaves your wallet</span>
        <b className="mono">{quote && Number.isFinite(Number(quote.feeUsdc)) && Number.isFinite(Number(quote.amountUsdc))
          ? `${(Number(quote.amountUsdc) + Number(quote.feeUsdc)).toFixed(4)} USDC` : em}</b></div>
      {/* ⭐⭐ THIS QUALIFIES THE TWO ROWS ABOVE, so it sits under them rather than becoming a peer
          row. It is not a value — it is a statement ABOUT the value — and a `Binding: held` row
          would be jargon while `Quote valid: 3 min` would say something true but different,
          dropping the part that matters: this figure is the one that gets signed. */}
      {quote && (
        <div className="summary-note">
          This is the fee that will be charged — quoted just now and held for this bridge, not
          re-read when it runs.{" "}
          {/* ═══ ⭐⭐ THE REMAINING TIME, WHEN THE SERVER SENT ONE ═════════════════════════════════
              "Price it again if you wait" was untimed advice while the only deadline was our own
              3-minute seal, whose expiry costs a re-quote and nothing else.
              🚨 UNDER CCTP UPFRONT FEES IT STOPS BEING ADVICE. The quote carries its own ~120s
              deadline and a burn submitted past it REVERTS on chain — after the approve has already
              confirmed. So the sentence that used to say "you may want to" now has to say HOW LONG,
              because a human confirm step can genuinely exhaust that window.
              ⛔ AND THE UNTIMED SENTENCE STAYS FOR THE CASE WHERE WE DO NOT KNOW. A missing window
              must not silently drop the warning — absence of a number is not absence of a deadline.
              [[absence-must-never-read-as-safe]] */}
          {typeof secondsLeft === "number"
            ? (secondsLeft > 0
                ? <>This price holds for <b>{secondsLeft}s</b> — after that it must be priced again.</>
                : <><b>This price has expired.</b> Price it again before bridging.</>)
            : <>Price it again if you wait.</>}
        </div>
      )}
      <div className="summary-row"><span>Settlement</span>
        <span>{MINT_TIMING}</span></div>
      <div className="summary-row"><span>Route</span>
        <span>{destinationLabel ? `Arc to ${destinationLabel} via CCTP` : em}</span></div>
      {/* ⭐⭐ PERMISSION, NOT EXPLANATION — and said BEFORE the press, which is exactly where the
          manual panel says its OPPOSITE. That panel warns "stay on this page until the burn
          confirms" because its burn is signed in the BROWSER and the receipt is written by a SECOND
          request; close the tab between and the record is lost. Here the server burns and writes the
          receipt in ONE request, so no such window exists (verify-user-bridge-recovery.mjs §3). Two
          panels, opposite instructions, both correct — and a user who has seen both needs the
          difference AT THE MOMENT, not below the fold.
          ⭐ Unconditional: it is true whether or not a figure exists, unlike the note above. */}
      <div className="summary-note">
        You can leave this page once it starts — the bridge completes on its own.
      </div>
    </div>
  );
}
