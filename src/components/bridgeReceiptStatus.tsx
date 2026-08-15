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

/** The receipt shape, as projected by /api/bridge-receipts. Deliberately loose: this component
 *  must render SOMETHING truthful for a receipt from an older deploy, not throw. */
export type BridgeReceiptView = {
  state?: string;
  netPredicted?: number;
  amountDelivered?: number | null;
  delivery?: string;
  destinationKey?: string | null;
  destinationLabel?: string | null;
  verifyFailure?: { reason?: string } | null;
  submitFailureDetail?: string | null;
  reconcileAttempts?: number;
  provisional?: { band?: string } | null;
  mintRecovery?: { cause?: string; exhausted?: boolean; verifyFailureCount?: number } | null;
};

export function BridgeReceiptStatus({ r }: { r: BridgeReceiptView }) {
  const measured = r.delivery === "measured" && r.amountDelivered != null;
  return (
    <>
      {/* ⚠️ SUBMITTED IS NOT IN FLIGHT. The burn was sent to Circle and has not
          been confirmed on Arc — it may still land, or may never have. Saying
          "in flight" here would promise a burn we have not observed.

          ⭐⭐ AND IT IS NOT ONE SENTENCE, BECAUSE IT WAS NOT ONE SITUATION. This row
          previously said "has not been confirmed YET" for the entire life of the
          record — forever, since nothing resolves a provisional receipt. "Yet" tells
          the reader someone is still waiting. Nobody is: there is no sweeper, no
          settler and no reconcile job for a `tx-` record. ⚠️ THAT MATTERS BECAUSE A
          USER WHO BELIEVES A PROCESS IS WATCHING WILL NOT GO LOOK THEMSELVES — the
          copy was quietly discouraging the only action that could resolve it.
          The band comes from the server (provisionalStatus), so the age cap has ONE
          definition and the panel cannot drift from the sweeper's census. */}
      {r.state === "burn_submitted" && r.provisional?.band === "settling" && (
        <span style={{ color: "var(--warn)" }}>
          submitted — the Arc burn has not been confirmed yet. Nothing has been
          observed leaving your wallet.
        </span>
      )}
      {r.state === "burn_submitted" && r.provisional?.band === "unwitnessed" && (
        <span style={{ color: "var(--warn)" }}>
          submitted, still unconfirmed — and <b>nothing is checking this
          automatically</b>. Nothing has been observed leaving your wallet. If it
          matters now, check the transaction with Circle rather than waiting.
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
      {r.state === "burn_confirmed" && (
        <span>
          in flight — <b>estimated</b> {Number(r.netPredicted).toFixed(4)} USDC to arrive
        </span>
      )}
      {r.state === "minted" && measured && (
        <span style={{ color: "var(--emerald)" }}>
          ✓ arrived — <b>exactly {Number(r.amountDelivered).toFixed(4)} USDC</b>, read from
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
          , so we will not claim it as measured. Estimated{" "}
          {Number(r.netPredicted).toFixed(4)} USDC.{" "}
          <b>This most likely arrived</b> — the gap is in our verification, not the bridge.
          {r.mintRecovery.exhausted && <> We have stopped re-checking automatically.</>}
        </span>
      )}
      {r.state === "mint_unconfirmed" && r.mintRecovery?.cause !== "chain_unreadable" && (
        <span style={{ color: "var(--warn)" }}>
          not confirmed in time — the Arc burn is real and final; the destination mint is{" "}
          <b>unproven</b> and has not been reported by Circle either. Estimated{" "}
          {Number(r.netPredicted).toFixed(4)} USDC.{" "}
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
    </>
  );
}
