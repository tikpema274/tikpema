// POST /api/user-bridge-promote  { intentId, burnHash }
//
// Step 2: the user has signed. Verify the burn ON CHAIN, then promote the pending intent into a
// real receipt and hand it to the same settler the agent path uses — after which the existing
// sweeper owns it.
//
// ═══ 🚨 THE SECURITY QUESTION OF THIS FEATURE, ANSWERED HERE ═══════════════════════════════════
// "What stops someone posting a burnHash they don't own to make us settle a stranger's bridge?"
//
// `verifyBurnOnArc` requires the tx to have been sent BY the session address. A session holder
// posting a stranger's hash is rejected with `not_sent_by_session_owner` — the ownership proof is
// the chain, not the claim. The other three conditions (exists, succeeded, called the BridgingKit
// contract with the burn selector) stop a reverted tx, an unrelated tx, and an APPROVE from being
// promoted into a money-movement record.
//
// ⚠️ AND THE OWNER IS NEVER READ FROM THE BODY. Both the receipt key and the verification target
// come from `requireSession(event)`, so the worst a forged body can do is name an intentId that
// does not belong to the caller — which reads as not-found, not as someone else's receipt.

import { json, ARC } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { verifyBurnOnArc } from "./_user-bridge.mjs";
import { promoteUserBridge } from "./_bridge-record.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) (await import("./_blobs.mjs")).connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "invalid JSON body" }); }
  const { intentId, burnHash } = body;
  if (!intentId) return json(400, { error: "intentId required" });

  // ══ THE CHAIN IS THE AUTHORITY, NOT THE CALLER ══════════════════════════════════════════════
  const chk = await verifyBurnOnArc({ burnHash, owner: session.address });
  if (!chk.verified) {
    // ⚠️ `not_found_or_unreadable` is RETRYABLE, not a verdict. A hash the node has not seen yet
    // and one that never existed look identical from here, so the client is told to retry rather
    // than told the burn failed — and the pending intent is left intact for the sweeper.
    const retryable = chk.reason === "not_found_or_unreadable" || chk.reason === "receipt_not_found";
    return json(retryable ? 202 : 400, { error: chk.reason, retryable, detail: chk.detail ?? null, ...chk });
  }

  const out = await promoteUserBridge({
    session, intentId, burnHash,
    burnTx: `${ARC.explorer}/tx/${burnHash}`,
    event,
  });
  if (!out.ok) return json(out.status ?? 400, { error: out.reason, ...out });

  return json(200, {
    state: out.state,
    burnHash,
    burnTx: `${ARC.explorer}/tx/${burnHash}`,
    verifiedFrom: chk.from,
    blockNumber: chk.blockNumber,
    // ⭐ The same vocabulary the agent panel uses. `predicted` now, `measured` once the
    // destination-chain read lands — the settler is the only thing allowed to promote it.
    delivery: "predicted",
    netPredicted: out.netPredicted,
    note: "The delivered amount is read from the destination chain once the mint lands. Until then this is an estimate.",
  });
}
