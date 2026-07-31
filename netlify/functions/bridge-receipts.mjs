import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { listByOwner, isPastDeadline, isRecheckable } from "./_bridge-receipts.mjs";

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
  const stranded = receipts.filter(
    (r) => !r.settlingSince && ((r.state === "burn_confirmed" && isPastDeadline(r)) || isRecheckable(r))
  );
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
    })),
    degraded,
  });
}
