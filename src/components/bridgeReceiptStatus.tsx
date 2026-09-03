// bridgeReceiptStatus.tsx — WHAT A BRIDGE RECEIPT SAYS, as a pure function of the receipt.
//
// ═══ 🚨 WHY THIS IS ITS OWN FILE ═════════════════════════════════════════════════════════════
// This copy lived inline in BridgePanel's row map, and the only guard on it was a SOURCE REGEX.
// That guard broke FOUR TIMES ACROSS FOUR COMMITS — and every single break was text MOVING, never
// meaning changing:
//   · JSX wrapped "could not be / determined" across two lines, so the phrase existed on screen
//     and not in the source as one string
//   · the `unresolved` row grew an attempt-count branch and pushed the matched phrase past the
//     regex's character window (twice)
//   · a comment block between two anchors did the same to the settler check
// ⭐⭐ FOUR FALSE ALARMS AND ZERO TRUE ONES. That ratio is not a flaky test, it is a guard aimed at
// the wrong thing: the SOURCE is not the artifact, the RENDERED TEXT is. A regex cannot see text
// built from variables, cannot see wrapping, and would happily pass a `<span>` that never renders.
//
// ⚠️ AND THE COST WAS NOT ONLY NOISE. A guard that cries wolf gets its window widened each time it
// fails — which is exactly what happened here, twice — so it was being progressively LOOSENED by
// its own false positives, in a file whose whole job is telling a user whether their money moved.
//
// So the copy is extracted here as a pure component: no hooks, no wallet, no fetch, no props but
// the receipt. `scripts/verify-bridge-copy.tsx` renders it with react-dom/server and asserts on
// TEXT CONTENT — what a browser actually paints. The `assert-on-rendered-output-not-source-regex`
// rule finally has a mechanism in this panel instead of a note saying it should.
//
// ⚠️ THIS FILE HOLDS NO LOGIC OF ITS OWN. Every band, cause and cap is computed SERVER-SIDE
// (_bridge-receipts.mjs) and arrives on the receipt. If a decision looks like it belongs here,
// it belongs there — a second copy of the age cap in the client is the duplicate-source-of-truth
// bug this receipt system keeps designing around.

import { USDC_DP } from "../lib/formatUsdc";
import { bridgeMechanicCopy, bridgeMechanicOf } from "../../shared/bridge-mechanic.mjs";

/** The receipt shape, as projected by /api/bridge-receipts. Deliberately loose: this component
 *  must render SOMETHING truthful for a receipt from an older deploy, not throw. */
export type BridgeReceiptView = {
  state?: string;
  netPredicted?: number;
  // ⭐ BOTH FEES, NAMED FOR WHAT THEY ARE. `feeCharged` is what was actually taken; `feeDisclosed`
  // is what the consent decision was made against. They differ only when the fee moved between the
  // gate and the signature — and a receipt that carries both is the only place that gap is VISIBLE
  // rather than silently averaged away.
  // ⚠️ `feeCharged` is null when the signing call threw and the value is genuinely unknown.
  feeCharged?: number | null;
  feeDisclosed?: number | null;
  // ⭐⭐ THE POST-BURN FEE RECONCILIATION — a DETECTOR's verdict, computed server-side and stored
  // once. `undefined`/`null` means the reconciler never ran, which is a DIFFERENT reader state from
  // `unreadable` ("it ran and could not tell") and must never render as a tick.
  feeReconciliation?: {
    verdict?: string;
    reason?: string | null;
    detail?: string | null;
    feeObservedUsdc?: number | null;
    feeReconciledUsdc?: number | null;
  } | null;
  amountDelivered?: number | null;
  debitDisclosed?: number | null;
  // ⭐⭐ WHERE THE FEE WAS CHARGED. This row's list MIXES both paths — a promoted self-signed
  // receipt is written by the same writer into the same owner prefix — so `netPredicted` is
  // unreadable without it: the same number means "what arrives" on one path and "the amount, with
  // the fee on top" on the other. ⛔ Absent/unrecognised normalises to `unknown`, whose copy claims
  // NEITHER mechanic. See shared/bridge-mechanic.mjs.
  feeMechanic?: string | null;
  origin?: string | null;
  delivery?: string;
  destinationKey?: string | null;
  destinationLabel?: string | null;
  verifyFailure?: { reason?: string } | null;
  submitFailureDetail?: string | null;
  reconcileAttempts?: number;
  provisional?: { band?: string } | null;
  mintRecovery?: { cause?: string; exhausted?: boolean; verifyFailureCount?: number } | null;
};

/**
 * ⭐⭐ THE STATES THIS COMPONENT CAN SPEAK. Anything else gets the fallback below.
 *
 * ⚠️ THIS IS A TRANSCRIBED COPY OF `ALL_RECEIPT_STATES` (_bridge-receipts.mjs), AND THAT IS A
 * DUPLICATE SOURCE OF TRUTH — the bug this codebase keeps re-learning. It is unavoidable here: that
 * module is server code importing @netlify/blobs and cannot be pulled into the browser bundle.
 * ⭐ SO THE DUPLICATION IS MADE SAFE BY A TEST THAT READS BOTH SIDES rather than by hoping. A guard
 * can only be trusted ACROSS what it binds, so `verify-bridge-copy.tsx` asserts both directions:
 * every server state renders a status here, and every `state:` literal any writer emits is known
 * here. Change one list without the other and that suite goes red.
 */
export const KNOWN_RECEIPT_STATES = [
  "burn_submitted",
  "submit_failed",
  "burn_confirmed",
  "minted",
  "mint_unconfirmed",
  "mint_failed",
  "mint_unverified",
] as const;

/**
 * ⭐⭐ A MONEY FIGURE, OR NOTHING — never a fabricated one.
 *
 * 🚨 FOUND BY RENDERING, 2026-08-15. `Number(null)` is **0**, not NaN, so a receipt whose
 * `netPredicted` is null rendered "in flight — estimated 0.0000 USDC to arrive": a confident,
 * specific, WRONG number for an amount nobody ever recorded. An absent field rendered "NaN".
 * ⚠️ THE NULL CASE IS THE DANGEROUS ONE AND THE REACHABLE ONE — `recordPendingBridge` writes
 * `netPredicted: c.netUsdc ?? null` when there is no consent context, and the reconcile job carries
 * that null into the DURABLE receipt. So a recovered bridge could show a user 0.0000 USDC as an
 * estimate. NaN at least looks broken; 0.0000 looks like an answer.
 *
 * Returns null when there is no figure, so each call site can say something true instead.
 */
// ═══ 🚨 6dp, NOT 4 — "exactly" MUST NOT NAME A ROUNDED NUMBER ═══════════════════════════════════
// This rendered `toFixed(4)` while the row said "exactly … read from the destination chain". Today's
// bridges delivered 0.046725 and 0.946726; the panel claimed "exactly 0.0467" and "exactly 0.9467".
// ⚠️ The word is doing real work on the ONE surface whose whole claim is that the number was measured
// on-chain — so a reader who follows the mint-tx link finds a figure that does not match the row that
// sent them there. That is the "yet" class again: a single word claiming more than the render delivers.
//
// ⭐ THE PRECISION IS IMPORTED, NOT RETYPED. `USDC_DP` is the one definition of how many decimals USDC
// has; a second literal here is exactly how this file drifted from `formatUsdc` in the first place.
//
// ⚠️ AND THE NULL CONTRACT IS DELIBERATELY KEPT — it is NOT `formatUsdc`. That helper returns
// `NO_AMOUNT` ("—") for a missing figure, which is right for a column but WRONG here: three call sites
// below branch on this returning null, and "—" is truthy, so swapping it in would render
// "in flight — estimated — USDC to arrive". Same 6dp, different absence semantics, on purpose.
const usdc = (v?: number | null): string | null =>
  v == null || !Number.isFinite(Number(v)) ? null : Number(v).toFixed(USDC_DP);

export function BridgeReceiptStatus({ r }: { r: BridgeReceiptView }) {
  // ⭐ ONE DERIVATION, AT THE TOP. Every sentence below reads from `mech`; none composes its own
  // wording. A surface that wrote its own could render a true sentence for the WRONG path and
  // nothing about it would look wrong — which is exactly how the two vocabularies would drift.
  const mech = bridgeMechanicOf(r.feeMechanic);
  const copy = bridgeMechanicCopy(mech);
  const measured = r.delivery === "measured" && r.amountDelivered != null;
  const known = (KNOWN_RECEIPT_STATES as readonly string[]).includes(r.state ?? "");
  return (
    <>
      {/* ⚠️ SUBMITTED IS NOT IN FLIGHT. The burn was sent to Circle and has not
          been confirmed on Arc — it may still land, or may never have. Saying
          "in flight" here would promise a burn we have not observed.

          ⭐⭐ AND IT IS NOT ONE SENTENCE, BECAUSE IT WAS NOT ONE SITUATION. This row
          previously said "has not been confirmed YET" for the entire life of the
          record — forever, since nothing resolves a provisional receipt. "Yet" tells
            the reader someone is still waiting. ⭐ WHEN THIS WAS WRITTEN nobody was: there was no
            sweeper, no settler and no reconcile job for a `tx-` record, and the copy was quietly
            discouraging the only action that could resolve it.
            ⚠️ THAT IS NO LONGER THE SITUATION — bridge-mint-sweep.mjs:94 triggers a reconcile for
            every non-terminal provisional, so something IS waiting now. The `settling` copy below
            still avoids "yet" regardless: "yet" claims a specific someone is waiting on a specific
            answer, which is a stronger claim than "a job will look again", and the weaker one is
            all this row can honestly make.
          The band comes from the server (provisionalStatus), so the age cap has ONE
          definition and the panel cannot drift from the sweeper's census. */}
      {r.state === "burn_submitted" && r.provisional?.band === "settling" && (
        <span style={{ color: "var(--warn)" }}>
          submitted — the Arc burn has not been confirmed yet. Nothing has been
          observed leaving your wallet.
        </span>
      )}
        {/* 🚨 THIS SAID "nothing is checking this automatically" AND THAT BECAME FALSE. It was
            true when written — _bridge-receipts.mjs recorded that a `tx-` record had NO sweeper,
            NO cron and NO reconcile job. `bridge-reconcile-background` was then BUILT and wired
            into the ten-minute sweep (bridge-mint-sweep.mjs:94, cron in netlify.toml), which reconciles every NON-TERMINAL
            provisional — `settling` AND `unwitnessed` — by asking Circle about the txId.
            ⛔ A sentence that outlives the condition it describes is worse than a vague one: this
            one sent a user to check by hand, confidently, for a receipt the system was already
            resolving. [[duplicate-source-of-truth-is-the-recurring-bug]]
            ⭐ THE ATTEMPT COUNT IS SHOWN RATHER THAN A SCHEDULE, mirroring the `unresolved` branch
            below. "Every ten minutes" would couple copy to a cron expression and go stale the same
            way; the count is a fact the record carries. Zero-vs-nonzero also preserves the
            distinction that branch already draws — asked-and-unanswered is different from
            never-asked, and the second is the more alarming one. */}
      {r.state === "burn_submitted" && r.provisional?.band === "unwitnessed" && (
        <span style={{ color: "var(--warn)" }}>
          submitted, still unconfirmed — nothing has been observed leaving your wallet.{" "}
          {(r.reconcileAttempts ?? 0) > 0 ? (
            <>
              We have re-checked it with Circle <b>{r.reconcileAttempts}</b> times and not had a
              confirmation yet, and we keep re-checking.
            </>
          ) : (
            <>
              We are <b>re-checking it with Circle automatically</b>.
            </>
          )}{" "}
          Nothing is required of you. If it is still unconfirmed after 24 hours it becomes a
          <b> needs review</b> row, and only then does it need you.
        </span>
      )}
      {/* ⭐ THE AGED-OUT ROW NOW REPORTS WHAT WAS TRIED. `reconcileAttempts > 0` means we
          asked Circle repeatedly and never got an answer — a genuine dead end. A count of
          ZERO means nobody ever asked, which is a DIFFERENT and more alarming problem (the
          reconcile job is not running), and the two must not read alike. */}
      {r.state === "burn_submitted" && r.provisional?.band === "unresolved" && (
        <span style={{ color: "var(--warn)" }}>
          ⚠ <b>needs review</b> — submitted over 24h ago and never confirmed.{" "}
          {(r.reconcileAttempts ?? 0) > 0 ? (
            <>
              We asked Circle {r.reconcileAttempts} times and never got a confirmation.
            </>
          ) : (
            <>
              <b>Nothing ever checked it automatically</b> — that itself needs looking at.
            </>
          )}{" "}
          {/* 🚨 RESTORED — THIS SENTENCE WAS SILENTLY DELETED, AND THE SOURCE REGEX PASSED ANYWAY.
              `7622cd3` shipped "This will not resolve on its own"; `d8483f1` rewrote the row to add
              the attempt count and dropped it. The guard only asserted the phrase that SURVIVED
              ("reconcile this transaction against Circle"), and its window had just been widened in
              that same commit — so a load-bearing claim vanished with a green suite.
              ⭐⭐ IT IS LOAD-BEARING: "reconcile by hand" is an instruction, but only this says that
              WAITING IS FUTILE. Without it a user can still reasonably decide to sit and wait for a
              record that nothing will ever resolve. Caught on the FIRST run of the rendering test. */}
          This will <b>not</b> resolve on its own: reconcile this transaction against
          Circle's record by hand. Nothing has been observed leaving your wallet.
        </span>
      )}
      {/* ⭐⭐ THE OUTCOME THE RECONCILE JOB CAN NOW PROVE: Circle says the submission is
          over and no burn exists. This is the one provisional ending that is genuinely
          GOOD NEWS — nothing was burned, so nothing is lost — and it must not be dressed
          in the warning grammar the unresolved case earns. */}
      {r.state === "submit_failed" && (
        <span>
          not submitted — {r.submitFailureDetail ?? "the transaction never landed"}.{" "}
          <b>No funds left your wallet.</b> Nothing to recover.
        </span>
      )}
      {/* Defensive: `burn_submitted` with no band means the server did not project one
          (an older deploy, or a shape change). Say the true, weaker thing rather than
          fall through to NO status line at all — a row that renders an amount and no
          state reads as normal, which is the failure this whole panel exists to avoid. */}
      {r.state === "burn_submitted" && !r.provisional?.band && (
        <span style={{ color: "var(--warn)" }}>
          submitted — the Arc burn has not been confirmed, and its age could not be
          determined. Nothing has been observed leaving your wallet.
        </span>
      )}
      {/* ⭐⭐ "ESTIMATED N TO ARRIVE" WAS AN ESTIMATE BECAUSE THE FEE CAME OUT OF THE AMOUNT.
          Under upfront fees the fee is charged on the source and the recipient receives the FULL
          amount, so the arrival is no longer an arithmetic guess — it is the amount that was
          requested. ⚠️ The word "estimated" stays for the older, deducted receipts, whose
          `netPredicted` genuinely was amount − fee; it is the RECORD that says which mechanic
          applied, not this component, so both must render truthfully from the same field. */}
      {r.state === "burn_confirmed" && (
        <span>
          {usdc(r.netPredicted)
            ? <>in flight — {copy.arrivalPrefix ? <><b>{copy.arrivalPrefix.trim()}</b>{" "}</> : null}
                {usdc(r.netPredicted)} USDC {copy.arrivalSuffix}</>
            : <>in flight — the Arc burn is confirmed; <b>the arrival amount was not recorded</b></>}
          {/* ⭐ THE DEBIT LINE IS UPFRONT-ONLY, AND THAT IS THE POINT OF GATING IT. On the deducted
              path the wallet parts with exactly the amount, so "N USDC left your wallet" beside an
              arrival of N − fee would be two numbers that look like a contradiction. On `unknown`
              we do not know which, so we say nothing rather than guess. */}
          {mech === "upfront" && r.debitDisclosed != null && (
            <span className="sub"> · {usdc(r.debitDisclosed)} USDC left your wallet</span>
          )}
        </span>
      )}
      {/* ═══ ⭐⭐ THE FEE, AND THE GAP BETWEEN SHOWN AND CHARGED ═══════════════════════════════
          Added 2026-08-30 with the two-fee record. Rendering it is not decoration: the record now
          carries `feeDisclosed` and `feeCharged` precisely so the drift between them can be SEEN,
          and a field written but never rendered is the third instance of that shape this week.
          ⚠️ The two are usually identical, so the second clause fires rarely — which is exactly why
          it must be here rather than left to whoever reads the raw record. */}
      {(r.feeCharged != null || r.feeDisclosed != null) && (
        <span className="sub" style={{ display: "block" }}>
          {r.feeCharged != null
            ? <>fee <b>{usdc(r.feeCharged)} USDC</b> charged</>
            : <>fee <b>not recorded</b> — the signing call did not return, so what was charged is unknown</>}
          {r.feeDisclosed != null && r.feeCharged != null && r.feeDisclosed !== r.feeCharged && (
            <> · you were shown <b>{usdc(r.feeDisclosed)} USDC</b></>
          )}
          {r.feeDisclosed != null && r.feeCharged != null && r.feeCharged > r.feeDisclosed && (
            <span style={{ color: "var(--warn)" }}>
              {" "}⚠️ you were charged MORE than you were shown
            </span>
          )}
        </span>
      )}
      {/* ═══ ⭐⭐ EXPLAIN A DERIVATION, NEVER A MEASUREMENT ═══════════════════════════════════════
          Rendered from the mechanic, never composed here — and shown for `unknown` too, whose copy
          claims NEITHER mechanic, because a record that does not say must not be made to say.

          🚨 BUT NOT ON EVERY ROW, AND THAT WAS FOUND BY LOOKING AT THE LIST RATHER THAN A FIXTURE.
          Rendered unconditionally it put a 40-word disclaimer on all 57 existing receipts, verbatim
          and identical — wall-to-wall boilerplate that buries the one row saying something
          different. A caveat repeated on every row is one nobody reads, which defeats the reason
          for showing it.
          ⛔ AND ON THOSE ROWS IT WAS ALSO IRRELEVANT. Every sampled receipt is `minted` with
          `delivery: "measured"` and an `amountDelivered` READ FROM THE DESTINATION CHAIN. The
          mechanic explains how a DERIVED figure was reached; it says nothing about a measured one.
          The disclaimer was explaining an ambiguity the chain read had already resolved.
          ⭐ SO IT RENDERS WHERE A FIGURE DEPENDS ON IT — an in-flight `netPredicted`, an unconfirmed
          estimate — and stays silent where the number is an observation. */}
      {(r.feeCharged != null || r.feeDisclosed != null) && !measured && (
        <span className="sub" style={{ display: "block" }}>{copy.summary}</span>
      )}
      {/* ═══ ⭐⭐ WHAT THE CHAIN SAYS THE FEE WAS — THREE OUTCOMES, NEVER TWO ═════════════════════
          The line above reports what our own record says. THIS one reports what actually moved on
          Arc, read back from the burn's logs after the fact.

          ⛔ `unreadable` IS RENDERED, NOT HIDDEN. It is the COMMON verdict — public-RPC retention
          makes an older burn unreadable by design, and every bridge predating the upfront-fee path
          reconciles `not_upfront_fee_path` — so hiding it would let "we could not check" look
          exactly like "we checked and it was fine". That is the absence-reads-as-safe failure on
          the one surface where it costs money.

          ⚠️ AND THE ABSENT CASE IS DELIBERATELY SILENT. No `feeReconciliation` at all means the
          reconciler never ran; there is nothing truthful to say beyond what the fee line above
          already says, and inventing a fourth sentence for it would imply a check took place. */}
      {r.feeReconciliation?.verdict === "matched" && (
        <span className="sub" style={{ display: "block", color: "var(--emerald)" }}>
          ✓ fee confirmed on chain — <b>{usdc(r.feeReconciliation.feeObservedUsdc)} USDC</b> moved,
          the figure you were shown
        </span>
      )}
      {r.feeReconciliation?.verdict === "mismatched" && (
        <span className="sub" style={{ display: "block", color: "var(--warn)" }}>
          ⚠️ <b>fee mismatch</b> — you were charged{" "}
          <b>{usdc(r.feeReconciliation.feeObservedUsdc)} USDC</b> on chain, and were shown{" "}
          <b>{usdc(r.feeReconciliation.feeReconciledUsdc)} USDC</b>. The burn is final; this is a
          detector, not a gate.
        </span>
      )}
      {r.feeReconciliation?.verdict === "unreadable" && (
        <span className="sub" style={{ display: "block" }}>
          fee not reconciled against the chain
          {r.feeReconciliation.reason === "not_upfront_fee_path"
            ? <> — this bridge did not use the upfront-fee path, so there is no separate fee transfer to read</>
            : <> — we could not read it{r.feeReconciliation.reason ? <> (<span className="mono">{r.feeReconciliation.reason}</span>)</> : null}</>}
          . <b>This is not evidence of a wrong charge</b>, and it is not evidence of a right one.
        </span>
      )}
      {r.state === "minted" && measured && (
        <span style={{ color: "var(--emerald)" }}>
          ✓ arrived — <b>exactly {usdc(r.amountDelivered)} USDC</b>, read from
          the destination chain
        </span>
      )}
      {/* Defensive: `minted` without a measured amount should be unreachable — the
          server only writes that state after a verified read. If it ever appears,
          say so rather than presenting the estimate as an arrival. */}
      {r.state === "minted" && !measured && (
        <span style={{ color: "var(--warn)" }}>
          ✓ mint reported, but no measured amount was recorded — treat the figure as an
          estimate
        </span>
      )}
      {/* ⭐⭐ TWO DIFFERENT FAILURES THAT RENDERED IDENTICALLY FOR TWELVE DAYS.
          `lastVerifyFailure` is written on exactly one line of the settler, reachable
          ONLY after IRIS reported the mint as `minted` — so `cause: "chain_unreadable"`
          means THE MINT WAS REPORTED AS LANDED and our own read of the destination chain
          failed. The old single sentence said "unproven … it may still land" about a mint
          IRIS had already said landed: wrong in both halves, and it filed an rpc fault on
          our side as a pending bridge. */}
      {r.state === "mint_unconfirmed" && r.mintRecovery?.cause === "chain_unreadable" && (
        <span style={{ color: "var(--warn)" }}>
          the Arc burn is real and final, and Circle reported the destination mint as
          completed — but <b>our own read of {r.destinationLabel ?? r.destinationKey} has
          never succeeded</b>
          {(r.mintRecovery.verifyFailureCount ?? 0) > 0
            ? ` (${r.mintRecovery.verifyFailureCount} failed reads)`
            : ""}
          , so we will not claim it as measured. {copy.arrivalIsEstimate ? "Estimated" : "Expected"}{" "}
{usdc(r.netPredicted) ? <>{usdc(r.netPredicted)} USDC. </> : <>not recorded. </>}
          <b>This most likely arrived</b> — the gap is in our verification, not the bridge.
          {r.mintRecovery.exhausted && <> We have stopped re-checking automatically.</>}
        </span>
      )}
      {r.state === "mint_unconfirmed" && r.mintRecovery?.cause !== "chain_unreadable" && (
        <span style={{ color: "var(--warn)" }}>
          not confirmed in time — the Arc burn is real and final; the destination mint is{" "}
          <b>unproven</b> and has not been reported by Circle either. {copy.arrivalIsEstimate ? "Estimated" : "Expected"}{" "}
{usdc(r.netPredicted) ? <>{usdc(r.netPredicted)} USDC. </> : <>not recorded. </>}
          {r.mintRecovery?.exhausted ? (
            <>
              ⚠ <b>Needs review</b> — we have stopped re-checking automatically.
            </>
          ) : (
            <>This is not a failure — it may still land.</>
          )}
        </span>
      )}
      {r.state === "mint_failed" && (
        <span style={{ color: "var(--warn)" }}>bridge failed on the destination</span>
      )}
      {r.state === "mint_unverified" && (
        <span style={{ color: "var(--warn)" }}>
          ⚠ <b>needs review</b> — Circle reported a mint that our own read of the
          destination chain could not confirm
          {r.verifyFailure?.reason ? ` (${r.verifyFailure.reason})` : ""}. Deliberately not
          retried automatically.
        </span>
      )}
      {/* ⭐⭐ THE FALLBACK — because SILENCE WAS THE WORST AVAILABLE ANSWER.
          Before this, a receipt in an unrecognised state rendered NOTHING: the row still showed an
          amount and a destination, so it looked like every other ordinary row while saying nothing
          about the money. ⚠️ That is strictly worse than an error, because an error prompts someone
          to look and a blank does not. No source regex could ever detect it; rendering the component
          is what surfaced it.

          ⚠️ IT MUST CLAIM NOTHING IN EITHER DIRECTION. We do not know whether the funds moved — so
          this refuses to imply arrival OR failure, and says plainly that the page cannot interpret
          the record. Naming the raw state is deliberate: it is the one datum that makes the row
          actionable for whoever has to work out what happened.

          🚧 The realistic cause is not a typo but a legitimate new state added server-side that the
          client never learned. `KNOWN_RECEIPT_STATES` is bound to the server's `ALL_RECEIPT_STATES`
          by verify-bridge-copy.tsx, so that mistake now fails a suite instead of blanking a row. */}
      {!known && (
        <span style={{ color: "var(--warn)" }}>
          ⚠ <b>unrecognised status</b>
          {r.state ? (
            <> (<span className="mono">{r.state}</span>)</>
          ) : (
            <> — no status was recorded</>
          )}
          . This page cannot interpret this record, and it is <b>not</b> evidence that funds did or
          did not move. Check the burn transaction directly, or come back after the next update.
        </span>
      )}
    </>
  );
}
