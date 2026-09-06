import { MINT_TIMING } from "../../shared/bridge-timing.mjs";
// ⛔ BOTH AXES COME FROM THE PRODUCER. This component states neither the fee placement nor the
// leave/stay instruction in its own words — it renders the copy keyed by what the quote declares.
import { bridgeMechanicCopy, bridgeSignerCopy } from "../../shared/bridge-mechanic.mjs";
import { displayAmount } from "../lib/formatAmount";
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
  { quote, destinationLabel, secondsLeft, mechanic, signer, heldFeeNote = true }:
    {
      quote: any | null; destinationLabel?: string; secondsLeft?: number | null;
      /** ⭐ Which arithmetic the three rows describe. From the producer, never from the caller's habit. */
      mechanic?: string;
      /** ⭐ Who signs the burn — INDEPENDENT of `mechanic`. See shared/bridge-mechanic.mjs. */
      signer?: string;
      /** ⚠️ The held-fee note is upfront-only TODAY, and only because its wording overstates.
       *  See the tripwire in verify-bridge-mechanic-pairing: this sentence must exist on ONE panel. */
      heldFeeNote?: boolean;
    },
): ReactNode {
  const em = "—";
  const mech = bridgeMechanicCopy(mechanic);
  const sign = bridgeSignerCopy(signer);
  const dp = 6;
  const n = (v: unknown) => Number(v);
  const has = (v: unknown) => Number.isFinite(Number(v));
  // ═══ ⭐⭐ THE SAME THREE LABELS SERVE BOTH MECHANICS. ONLY THE ARITHMETIC MOVES. ═══════════════
  //   upfront   fee 0.054000 · receive 1.000000 · leaves 1.054000
  //   deducted  fee 0.054300 · receive 0.945700 · leaves 1.000000
  // ⭐ THE MECHANIC IS VISIBLE IN *WHICH NUMBER MOVES*, which is a stronger statement than a
  // sentence because a reader checks it by arithmetic rather than by trusting the prose. The
  // sentence stays too — the table shows the arithmetic, the sentence names the rule.
  const isDeducted = mech === bridgeMechanicCopy("deducted");
  // ⛔⛔ DRIVEN BY THE MECHANIC, NOT BY WHICH FIELD HAPPENS TO EXIST. The first draft read
  // `netUsdc ?? netPredicted`, which picks the UPFRONT figure off any quote carrying both — right
  // in production only because the two producers happen to emit different field names today. That
  // is presence deciding meaning, and it broke the moment a fixture carried both.
  // ⭐ The agent quote names it `netUsdc`, the self-signed one `netPredicted`; both are read, but
  // WHICH arithmetic applies comes from the declared mechanic, mirroring bridgeNetUsdc /
  // bridgeNetDeducted. Under `upfront` the recipient gets the full amount, by definition.
  // ⭐ THE MECHANIC PICKS WHICH FIGURE IS AUTHORITATIVE; within that branch the SERVER's own number
  // wins over re-deriving it here. Re-deriving a value the producer already computed is the second
  // arithmetic site formatAmount.ts warns about — and `bridgeNetUsdc(amount) === amount` makes the
  // upfront preference equivalent, not a different answer.
  const receive = isDeducted
    ? (has(quote?.netPredicted) ? n(quote.netPredicted)
      : has(quote?.netUsdc) ? n(quote.netUsdc)
      : n(quote?.amountUsdc) - n(quote?.feeUsdc))
    : (has(quote?.netUsdc) ? n(quote.netUsdc) : n(quote?.amountUsdc));
  // ⭐⭐ "LEAVES YOUR WALLET" IS A REQUIREMENT FIGURE and rounds UP — a user planning against it
  // must not be told they need less than they do. ⚠️ ON THE DEDUCTED PATH THERE IS NOTHING TO ROUND:
  // the figure IS the amount the user typed, exact by construction, because the fee comes out of it.
  // Only the upfront sum (amount + fee) is arithmetic that could land beyond 6dp.
  const leaves = isDeducted
    ? n(quote?.amountUsdc)
    : (has(quote?.amountUsdc) && has(quote?.feeUsdc) ? n(quote.amountUsdc) + n(quote.feeUsdc) : NaN);
  return (
    <div className="summary-block">
      {/* ⭐ LABELLED ROWS, NOT PROSE. Facts a reader scans rather than parses. */}
      <div className="summary-row"><span>Fee</span>
        <b className="mono">{quote && has(quote.feeUsdc) ? `${displayAmount(quote.feeUsdc, dp)} USDC` : em}</b></div>
      {/* ⭐⭐ WHICH NUMBER MOVES IS THE MECHANIC. Under `upfront` the fee is charged on top, so
          "You receive" equals the amount and "Leaves your wallet" is amount + fee. Under `deducted`
          the fee comes out, so "You receive" is amount − fee and "Leaves your wallet" IS the amount.
          ⛔ Showing only "you receive" on the upfront path would be true and useless — it would
          equal the number they typed and the fee would appear nowhere in the outcome. */}
      <div className="summary-row"><span>You receive</span>
        <b className="mono">{quote && has(receive) ? `${displayAmount(receive, dp)} USDC` : em}</b></div>
      <div className="summary-row"><span>Leaves your wallet</span>
        <b className="mono">{quote && has(leaves) ? `${displayAmount(leaves, dp)} USDC` : em}</b></div>
      {/* ⛔⛔ THE CEILING QUALIFIER — THE MIRROR OF THE 'will be charged' NOTE, ON THE OTHER PATH.
          On `deducted` the Fee row shows `toUsdc(maxFee)`, a bound signed into the calldata, so the
          figure is a MAXIMUM and the real charge is set when the burn runs. On `upfront` the
          contract asserts collected == quoted, so there is nothing to qualify and this is empty.
          ⭐ Keyed at the producer, never written here — and it states the RELATIONSHIP rather than
          hedging: "may be lower" alone would be weaker than saying what the number IS.
          ⚠️ It deliberately claims no LIKELIHOOD: every on-chain fee verdict we hold is upfront
          (4 of 4), so no surplus distribution has ever been measured on this path. */}
      {quote && mech.feeCeilingNote && (
        <div className="summary-note">{mech.feeCeilingNote}</div>
      )}
      {/* ⭐ THE SENTENCE ALONGSIDE THE TABLE — the table shows the arithmetic, this names the rule.
          Both, not either: a reader who scans the numbers gets the mechanic, and a reader who reads
          the prose gets it too, without either having to derive it from the other. */}
      {quote && <div className="summary-note">The fee is {mech.feePlacement}.</div>}
      {/* ⭐⭐ THIS QUALIFIES THE TWO ROWS ABOVE, so it sits under them rather than becoming a peer
          row. It is not a value — it is a statement ABOUT the value — and a `Binding: held` row
          would be jargon while `Quote valid: 3 min` would say something true but different,
          dropping the part that matters: this figure is the one that gets signed. */}
      {quote && heldFeeNote && (
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
      {/* ⛔⛔ THE LEAVE/STAY INSTRUCTION IS KEYED ON `signer`, NOT ON `mechanic`. This used to be an
          UNCONDITIONAL "you can leave this page" — true only because this component served one
          panel. On the browser-signed path it is FALSE and harmful: the burn is signed in the tab
          and a SECOND request writes the receipt, so closing it loses the record (the money still
          moves). ⭐ The two panels give OPPOSITE instructions at the same moment and both are
          correct, which is exactly why neither may write its own version.
          ⚠️ Empty on `unknown` — telling someone they may leave when we do not know is the one
          direction that loses a record. */}
      {sign.pageInstruction && (
        <div className="summary-note">{sign.pageInstruction}</div>
      )}
    </div>
  );
}
