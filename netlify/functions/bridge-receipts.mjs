import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { listByOwner, isPastDeadline, isRecheckable, provisionalStatus, mintRecoveryStatus, readFeeVerdict } from "./_bridge-receipts.mjs";
import { bridgeReceiptRatio } from "./_bridge-record.mjs";
import { minorToUsdcString } from "./_fee-reconcile.mjs";

// GET|POST /api/bridge-receipts   (auth required)
//
// THE FORK THAT MAKES SERVER-SIDE RECEIPTS WORTH HAVING. Persistence keyed by
// burnHash is useless after a reload unless the client can NAME the key — without this
// endpoint the whole design collapses into localStorage with extra server code. So it
// ships with the write, not after it.
//
// Owner scope is taken from the SESSION and never from the request: there is no
// parameter here that selects whose receipts you see. `listByOwner` additionally
// re-checks `receipt.owner` against the session address, so the key prefix and the
// record must agree before anything is returned.
//
// Read-only: holds no store handle for writing, submits nothing, moves nothing.
export async function handler(event) {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return json(405, { error: "GET or POST only" });
  }
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { receipts, degraded } = await listByOwner(session.address);

  // ── THE FEE VERDICT, JOINED AT READ TIME ─────────────────────────────────────────
  // ⭐ A JOIN, NOT A DUPLICATE. The verdict lives under its own `fee/` prefix — outside `o/<owner>/`
  // so `listByOwner` cannot return it as a receipt (it would have no `state`, which is this panel's
  // documented render-nothing failure). Nothing here is a second copy of anything on the receipt.
  //
  // ⚠️ ABSENT IS ITS OWN READER STATE, NOT A TICK AND NOT `unreadable`. The reconciler ALWAYS writes
  // a record, so no verdict means it never ran — a pre-migration receipt, or a trigger that was
  // lost. Collapsing that into "we could not read the chain" would claim a check that never
  // happened. Four reader states, three verdicts.
  const feeVerdicts = new Map(
    await Promise.all(
      receipts
        .filter((r) => r?.burnHash)
        .map(async (r) => [r.burnHash, await readFeeVerdict(session.address, r.burnHash)])
    )
  );

  // ── SELF-HEALING: RE-TRIGGER A STRANDED SETTLE ───────────────────────────────────
  // A single fire-and-forget trigger is one lost request away from a receipt that sits
  // at `burn_confirmed` forever — which the panel renders as "in flight" indefinitely,
  // the exact failure this design exists to remove. Burn 0x0175cf7b… proved it: three
  // hours stranded while the mint had actually landed.
  //
  // Awaiting the trigger (agent-bridge.mjs) fixes the common case; this covers the rest
  // — a trigger that was sent and lost, a settler that died mid-poll, a deploy that
  // interrupted one. The client already calls this endpoint on mount, so THIS recovery costs
  // no cron and happens exactly when someone is looking.
  // ⚠️ THAT WAS ONCE THE ONLY RECOVERY. It is not now: bridge-mint-sweep.mjs:94 runs on a schedule
  // and reconciles provisionals without anyone looking. This path remains cron-free and remains
  // useful — it catches a stranded burn the moment a user opens the panel, ahead of the next tick —
  // but "recovery costs no cron" describes THIS endpoint, not the system.
  //
  // ⚠️ THIS ENDPOINT STILL WRITES NOTHING ITSELF. It asks the internal settler to run;
  // the settler owns every write and is idempotent and lease-guarded, so a duplicate
  // trigger costs a wasted read, never a wrong receipt. Only receipts PAST THE DEADLINE
  // and holding no lease qualify — a healthy in-flight bridge is left alone.
  // Two kinds qualify: a burn that was never settled (a lost trigger), and a PROVISIONAL
  // `mint_unconfirmed` — which only ever meant "we stopped waiting", and must be allowed to
  // resolve if the mint has since landed. Excluding the second is what made "unproven"
  // permanent for mints that had actually succeeded.
  console.log(
    `[bridge-receipt] READ owner=${session.address} receipts=${receipts.length} degraded=${degraded}`
  );
  const stranded = receipts.filter(
    (r) => !r.settlingSince && ((r.state === "burn_confirmed" && isPastDeadline(r)) || isRecheckable(r))
  );
  console.log(`[bridge-receipt] STRANDED candidates=${stranded.length} of ${receipts.length}`);
  for (const r of stranded.slice(0, 3)) { // bounded: a page load must not fan out
    try {
      const base =
        process.env.DEPLOY_URL ||
        `${event.headers?.["x-forwarded-proto"] || "https"}://${event.headers?.host}`;
      // Awaited for the same reason agent-bridge awaits it: an un-awaited fetch in a
      // handler that then returns may never be sent at all. The settler acks 202 at once.
      const res = await fetch(`${base}/.netlify/functions/bridge-mint-settle-background`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": internalToken() },
        body: JSON.stringify({ owner: session.address, burnHash: r.burnHash }),
      });
      console.log(`[bridge-receipt] RE-TRIGGERED stranded settle burnHash=${r.burnHash} status=${res.status}`);
    } catch (e) {
      // Swallowed: recovery is best-effort and must never break the read it rides on.
      console.warn(`[bridge-receipt] re-trigger failed (swallowed) burnHash=${r.burnHash}: ${e?.message}`);
    }
  }

  // ⚠️ `degraded` is the difference between "you have no bridges in flight" and "we
  // could not look". An empty list rendered as certainty is exactly the absence-reads-
  // as-safe failure this repo keeps re-learning, so the flag is carried to the client
  // rather than flattened into [].
  return json(200, {
    receipts: receipts.map((r) => ({
      burnHash: r.burnHash,
      burnTx: r.burnTx,
      burnedAt: r.burnedAt,
      state: r.state,
      destinationKey: r.destinationKey,
      destinationLabel: r.destinationLabel,
      amountRequested: r.amountRequested,
      // ⭐ BOTH FEES, NAMED FOR WHAT THEY ARE. `feeUsdc` is the pre-2026-08-30 name, read as a
      // fallback so older receipts still project — new records do not write it.
      feeCharged: r.feeCharged ?? r.feeUsdc ?? null,
      feeDisclosed: r.feeDisclosed ?? r.feeUsdc ?? null,
      netPredicted: r.netPredicted,
      // ⭐ DERIVED, NEVER STORED — so it cannot disagree with the fee it comes from. The disclosed
      // net is derived for the same reason, and covers the case where the signed quote is unknown
      // (a throw mid-flight) so `netPredicted` is null.
      // ⭐⭐ THE NET IS THE AMOUNT NOW. Under upfront fees the fee is charged on the SOURCE and the
      // recipient receives the FULL amount, so subtracting the fee here would understate nothing and
      // overstate everything: it would report an arrival smaller than the one the chain produces.
      // ⚠️ Kept as a DERIVED field rather than deleted, because older receipts still carry the
      // deducted mechanic and a reader comparing two receipts needs the same field on both.
      netDisclosed: Number.isFinite(Number(r.amountRequested)) ? Number(r.amountRequested) : null,
      // ⭐ AND WHAT LEFT THE WALLET, WHICH IS THE FIGURE THE OLD `netDisclosed` USED TO CARRY THE
      // WEIGHT OF. Without it the fee disappears from the outcome entirely: the amount arrives, the
      // amount was requested, and nothing on the receipt says the wallet paid more.
      debitDisclosed: (Number.isFinite(Number(r.amountRequested)) && typeof (r.feeDisclosed ?? r.feeUsdc) === "number")
        ? Number(r.amountRequested) + (r.feeDisclosed ?? r.feeUsdc) : null,
      delivery: r.delivery,
      amountDelivered: r.amountDelivered ?? null,
      mintTx: r.mintTx ?? null,
      mintTxHash: r.mintTxHash ?? null,
      // Surfaced so the UI can be loud about the state that needs a human.
      irisClaimedMintTxHash: r.irisClaimedMintTxHash ?? null,
      verifyFailure: r.verifyFailure ?? null,
      // The disclosure that was shown and (if required) accepted.
      feeRatio: bridgeReceiptRatio(r),
      ackBand: r.ackBand ?? null,
      ackRequired: r.ackRequired ?? false,
      ackAcceptedAt: r.ackAcceptedAt ?? null,
      // ⭐⭐ THE JOIN TO THE PRICED PLAN — WITHOUT THESE, `ackAcceptedAt` IS UNAUDITABLE HERE.
      // `recordBridge` has always persisted both; this projection omitted them, so the ONLY
      // supported way to read a receipt showed consent as accepted with no way to reach the quote
      // that authorised it. The quote is the independently-written second record — it says a token
      // was ISSUED for one step index, this says consent was ACCEPTED for one — and agreement
      // between two records written at different times by different code paths is the whole
      // evidentiary value. A projection is a claim about what matters; omitting the join said the
      // join did not.
      //
      // 🚨 THE OMISSION WAS INVISIBLE FROM OUTSIDE, WHICH IS WHY IT SURVIVED. `r.quoteId` is simply
      // `undefined` here, so any reader defaulting it renders "null" — indistinguishable from a
      // bridge that genuinely had no quote (the direct Bridge page, where null IS correct). On
      // 2026-08-17 that produced a FALSE FINDING: the first plan-path receipts ever written were
      // read through this endpoint and reported as carrying no quoteId, while the stored records
      // held `q_msxi20om_0d4cac7c226e6f49` steps 0 and 1 the whole time. An absent field and a
      // null field must not render alike when one of them is evidence.
      quoteId: r.quoteId ?? null,
      quoteStepIndex: Number.isInteger(r.quoteStepIndex) ? r.quoteStepIndex : null,
      // ⭐ WAS THE JOIN PROTECTED? true = the quote is exempt from the age prune, so a missing quote
      // later is a real anomaly. false = the mark failed and this join breaks on schedule — expected.
      // null = either no quote (`quoteId` also null — the direct Bridge page) or a receipt predating
      // this field (`quoteId` present); read the pair, not this alone. Projected because the
      // DISTINCTION is the point: without
      // it, an outsider seeing a dead quoteId cannot tell a broken system from a working one.
      quotePromoted: typeof r.quotePromoted === "boolean" ? r.quotePromoted : null,
      // ⭐ THE PROVISIONAL PAIR. A submitted-but-unconfirmed bridge has no burnHash, so the
      // UI needs its own identity (`txId`) and its own clock (`submittedAt`) — otherwise a
      // pending row is keyless and undateable, and React renders several of them as one.
      txId: r.txId ?? null,
      submittedAt: r.submittedAt ?? null,
      // ⭐ WHAT THE RECONCILE JOB LEARNED. `submitFailureDetail` is the sentence the panel shows
      // for a submission Circle has told us is over; the attempt count is what makes an aged-out
      // row EVIDENCE rather than inference — "we asked N times" versus a silent 0, which would mean
      // the reconcile job never ran at all. Those are different problems and must not look alike.
      submitFailureReason: r.submitFailureReason ?? null,
      submitFailureDetail: r.submitFailureDetail ?? null,
      reconcileAttempts: Number.isInteger(r.reconcileAttempts) ? r.reconcileAttempts : 0,
      lastReconciledAt: r.lastReconciledAt ?? null,
      // ⭐⭐ THE AGE CAP, DERIVED HERE AND NOT STORED. A provisional receipt has no automatic
      // resolver AT THE TIME THIS WAS WRITTEN — no sweeper, no settler, no reconcile job. ⭐ THAT
      // CHANGED: bridge-reconcile-background is triggered for every non-terminal provisional by
      // bridge-mint-sweep.mjs:94, so `settling` and `unwitnessed` ARE resolved automatically now.
      // The band is still derived per read, for the reasons below. Back then "not confirmed yet" was a claim
      // that aged into a falsehood the moment nobody was waiting, which was immediately. The band
      // is computed per read against the CURRENT clock, so it is right without a migration and
      // stops being consulted the day a reconcile job backfills a real burn hash.
      // ⚠️ The panel must key its copy on THIS, not on `state` alone — `state` is `burn_submitted`
      // for a 10-second-old record and a 10-month-old one alike.
      provisional: (() => {
        const p = provisionalStatus(r);
        return p.provisional ? { band: p.band, ageMs: p.ageMs, terminal: p.terminal, needsHuman: p.needsHuman, detail: p.detail } : null;
      })(),
      // ⭐⭐ WHY an unconfirmed mint is unconfirmed — the distinction the record could make all
      // along and never surfaced. `chain_unreadable` means IRIS REPORTED THE MINT AS LANDED and our
      // own read failed; `never_appeared` means nobody has seen it at all. Twelve days of the first
      // rendered as the second, which sent an infrastructure fault to the wrong owner entirely.
      mintRecovery: (() => {
        const m = mintRecoveryStatus(r);
        return m.applicable
          ? { cause: m.cause, exhausted: m.exhausted, ageMs: m.ageMs, verifyFailureCount: m.verifyFailureCount,
              irisClaimedMintTxHash: m.irisClaimedMintTxHash, detail: m.detail }
          : null;
      })(),
      // ⭐⭐ DID THE FEE THAT MOVED MATCH THE FEE WE SHOWED? A DETECTOR'S ANSWER, not a gate's.
      // ⚠️ The DECIMAL strings are derived here so the client never converts minor units itself —
      // a second conversion is a second thing that can be wrong about the same number. The minor
      // figures travel too, because they are what was actually compared, and a verdict whose input
      // is gone is unfalsifiable. `null` means the reconciler never ran; see the join above.
      feeReconciliation: (() => {
        const v = feeVerdicts.get(r.burnHash);
        if (!v) return null;
        return {
          verdict: v.verdict,
          reason: v.reason ?? null,
          detail: v.detail ?? null,
          reconciledAt: v.reconciledAt ?? null,
          feeObservedMinor: v.feeObservedMinor ?? null,
          feeDisclosedMinor: v.feeDisclosedMinor ?? null,
          feeObservedUsdc: v.feeObservedMinor != null ? Number(minorToUsdcString(v.feeObservedMinor)) : null,
          feeReconciledUsdc: v.feeDisclosedMinor != null ? Number(minorToUsdcString(v.feeDisclosedMinor)) : null,
        };
      })(),
    })),
    degraded,
  });
}
