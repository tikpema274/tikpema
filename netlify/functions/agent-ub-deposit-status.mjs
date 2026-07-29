import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";

// GET/POST /api/agent-ub-deposit-status?depositId=…  (auth)
//
// Poll a UB deposit kicked off by agent-ub-deposit. Read-only — it cannot move money.
//
// OWNERSHIP: a depositId is a random UUID, but it is NOT a capability. We check that the
// record's owner IS the calling session, so knowing (or guessing) someone else's depositId
// tells you nothing — the tx hashes and the wallet address are their business, not yours.
// Mismatch answers 404, not 403: a 403 would confirm the id exists.
export async function handler(event) {
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const depositId = event.queryStringParameters?.depositId || parseBody(event).depositId;
  if (!depositId) return json(400, { error: "depositId required" });

  const store = getStore("ub-deposits");
  const rec = await store.get(`dep:${depositId}`, { type: "json" }).catch(() => null);

  // Blobs is eventually consistent, so a poll landing right after the trigger can miss the
  // record it just wrote. "starting" is the honest answer — keep polling, don't 404.
  if (!rec) return json(200, { depositId, status: "starting" });

  if (String(rec.owner).toLowerCase() !== session.address.toLowerCase()) {
    return json(404, { error: "not found" });
  }

  return json(200, {
    depositId,
    status: rec.status, // starting | executing | completed | failed
    amountUsdc: rec.amountUsdc,
    walletAddress: rec.walletAddress,
    // Present once completed.
    depositedTo: rec.depositedTo ?? null,
    approveTxHash: rec.approveTxHash ?? null,
    depositTxHash: rec.depositTxHash ?? null,
    tx: rec.tx ?? null,
    // The one-time spender authorization. delegateTxHash is non-null ONLY on the deposit
    // that actually granted it (the user's first) — null thereafter, which is how the
    // grant-once idempotence is visible from the outside.
    delegateAuthorized: rec.delegateAuthorized ?? null,
    delegateAlreadyAuthorized: rec.delegateAlreadyAuthorized ?? null,
    delegateTxHash: rec.delegateTxHash ?? null,
    // Failure shape, when it failed.
    error: rec.error ?? null,
    delegateAuthFailed: rec.delegateAuthFailed ?? false,
    allowanceDangling: rec.allowanceDangling ?? false,
    allowanceRevoked: rec.allowanceRevoked ?? false,
    fundsMoved: rec.fundsMoved,
    createdAt: rec.createdAt ?? null,
    updatedAt: rec.updatedAt ?? null,
  });
}
