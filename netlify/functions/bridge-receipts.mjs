import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { listByOwner, isPastDeadline, isRecheckable, provisionalStatus, mintRecoveryStatus } from "./_bridge-receipts.mjs";

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

  // ── SELF-HEALING: RE-TRIGGER A STRANDED SETTLE ───────────────────────────────────
  // A single fire-and-forget trigger is one lost request away from a receipt that sits
  // at `burn_confirmed` forever — which the panel renders as "in flight" indefinitely,
  // the exact failure this design exists to remove. Burn 0x0175cf7b… proved it: three
  // hours stranded while the mint had actually landed.
  //
  // Awaiting the trigger (agent-bridge.mjs) fixes the common case; this covers the rest
  // — a trigger that was sent and lost, a settler that died mid-poll, a deploy that
  // interrupted one. The client already calls this endpoint on mount, so recovery costs
  // no cron and happens exactly when someone is looking.
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
      feeUsdc: r.feeUsdc,
      netPredicted: r.netPredicted,
      delivery: r.delivery,
      amountDelivered: r.amountDelivered ?? null,
      mintTx: r.mintTx ?? null,
      mintTxHash: r.mintTxHash ?? null,
      // Surfaced so the UI can be loud about the state that needs a human.
      irisClaimedMintTxHash: r.irisClaimedMintTxHash ?? null,
      verifyFailure: r.verifyFailure ?? null,
      // The disclosure that was shown and (if required) accepted.
      feeRatio: r.feeRatio ?? null,
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
      // resolver — no sweeper, no settler, no reconcile job — so "not confirmed yet" was a claim
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
    })),
    degraded,
  });
}
