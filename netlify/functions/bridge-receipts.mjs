import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { listByOwner } from "./_bridge-receipts.mjs";

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
    })),
    degraded,
  });
}
