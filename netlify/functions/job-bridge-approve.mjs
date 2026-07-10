import { connectLambda, getStore } from "@netlify/blobs";
import { TxPendingError } from "./_circle.mjs";
import { json, parseBody, bridgeCapUsdc } from "./_arc.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveDestination } from "./_bridge.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";

// POST /api/job-bridge-approve { runId }   (auth required)
//
// The APPROVE half of the proposal loop: the user says yes to a bridge the SERVER
// proposed, and the server executes it and records what IT observed.
//
// ══ THE TRUST BOUNDARY — read this before changing anything ═════════════════════
// The client may REQUEST the bridge. It may not REPORT what happened.
//
// This handler reads exactly ONE field from the request body: `runId`. Not the amount,
// not the destination, not the fee, and above all not a txHash. Everything else is
// loaded from the proposal THE SERVER ITSELF WROTE, or captured from the server's own
// executeAction return, or re-derived live.
//
//   destination, amount → the persisted proposal (server-authored, server-validated)
//   fee, netUsdc        → re-priced LIVE inside executeAction at execution time
//   burnHash            → executeAction's OWN return value (_actions.mjs:191-201,
//                         sourced from _bridge.mjs:192 `await waitForTx(...)` — a
//                         CONFIRMED hash, not the racy App Kit waiter)
//   approvedBy          → session.address
//
// This is strictly stronger than agent-bridge.mjs's turn-2, which must re-accept
// {amountUsdc, destination} from the client because agent-act is stateless. Here the
// proposal is already on disk, so the client cannot even choose what gets bridged —
// only whether the proposed bridge happens. Do not "simplify" by accepting the amount
// from the body to save a read.
//
// A receipt is NEVER written as complete here. This handler can only ever produce
// `burn_pending` or `burn_confirmed`. Promotion to `minted` requires an independent
// on-chain re-verification, which happens in job-bridge-receipt-background.mjs.
//
// ══ KNOWN LIMIT (a): double-approve under eventual consistency ══════════════════
// The "already approved?" check is a read-then-write against Netlify Blobs, which is
// eventually consistent (~11s — see agent-execute-plan.mjs:82-90). Two near-simultaneous
// approvals could both read "no receipt" and both bridge. The `approving` lock written
// below NARROWS the window; it does not close it, because the lock write is subject to
// the same lag. Damage is BOUNDED by the per-bridge cap (_actions.mjs:89-94) and the
// day-ceiling ledger: at worst one extra capped bridge, never an unbounded drain. The
// real fix is a strongly-consistent idempotency key — DEFERRED, not solved. The UI
// should also disable the button on click as a mitigation for the common case.

const RECEIPT_TERMINAL = new Set(["minted", "mint_failed", "mint_unconfirmed", "mint_unverified"]);

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectLambda(event); // Blobs: deliverable store + day ledger

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  // ⚠️ THE ONLY FIELD READ FROM THE CLIENT. Anything else in the body is ignored by
  // construction — there is no second destructure anywhere in this file.
  const { runId } = parseBody(event);
  if (!runId || typeof runId !== "string") return json(400, { error: "'runId' required" });

  const runs = getStore("job-runs");
  const run = await runs.get(`run:${runId}`, { type: "json" }).catch(() => null);
  if (!run) return json(404, { error: "unknown runId" });

  // Ownership — a session may only approve ITS OWN run (job-run-status.mjs:25 pattern).
  if (run.owner?.toLowerCase() !== session.address.toLowerCase()) {
    return json(403, { error: "not your job" });
  }
  if (!run.jobId) return json(409, { error: "job not yet created — nothing to approve" });

  const store = getStore("job-deliverables");
  const entry = await store.get(run.jobId, { type: "json" }).catch(() => null);
  if (!entry) return json(404, { error: "no deliverable for this job" });

  // The research must have COMPLETED. You cannot approve an action derived from a
  // brief that was rejected, refunded, or never settled.
  if (entry.status !== "completed") {
    return json(409, { error: `research is '${entry.status}', not 'completed' — cannot approve` });
  }

  const proposal = entry.proposal;
  if (!proposal || proposal.action !== "bridge_usdc") {
    return json(409, { error: "this brief carries no bridge proposal" });
  }

  // Idempotency: never bridge twice for one proposal. (See KNOWN LIMIT (a) above —
  // this narrows, it does not close.)
  if (entry.receipt) {
    const s = entry.receipt.state;
    if (s === "approving") return json(409, { error: "approval already in flight" });
    if (RECEIPT_TERMINAL.has(s) || s === "burn_confirmed" || s === "burn_pending") {
      return json(409, { error: `already approved (receipt state: ${s})`, receipt: entry.receipt });
    }
  }

  // ── RE-VALIDATE the proposal at execution time. We wrote it, but the deployed caps
  // may have changed since, and a stale proposal must not outrank a current guard. ──
  const dest = resolveDestination(proposal.destination);
  if (!dest) return json(409, { error: `proposal destination '${proposal.destination}' is no longer supported` });
  const amount = Number(proposal.amountUsdc);
  if (!(amount > 0)) return json(409, { error: "proposal amount is not > 0" });
  const cap = bridgeCapUsdc();
  if (amount > cap) return json(409, { error: `proposal exceeds current per-bridge limit of ${cap} USDC`, cap });

  const owner = await ensureOwnerWallet(session);
  if (owner.pending) return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  const walletAddress = owner.walletAddress;

  const approvedAt = new Date().toISOString();
  const base = { approvedBy: session.address, approvedAt, amountUsdc: amount, destinationKey: dest.key };

  // Optimistic lock BEFORE any money moves (narrows the double-approve window).
  await store.setJSON(run.jobId, { ...entry, receipt: { ...base, state: "approving" } });

  try {
    // executeAction re-prices the fee live and re-applies the fee-floor
    // (_actions.mjs:177-190), and enforces the per-bridge cap (:89-94) + day-ceiling.
    const r = await executeAction(
      { type: "bridge_usdc", amountUsdc: amount, destination: dest.key, reasoning: proposal.reasoning || "approved bridge proposal" },
      { walletAddress, session }
    );

    if (!r.ok) {
      // Blocked by a guard — release the lock, no receipt, no money moved.
      await store.setJSON(run.jobId, { ...entry, receipt: undefined });
      return json(200, { executed: false, blocked: r.blocked });
    }

    // ⚠️ burnHash comes from OUR OWN response object. Never from the client.
    const receipt = {
      ...base,
      state: "burn_confirmed",
      feeUsdc: r.feeUsdc,
      netUsdc: r.netUsdc,
      recipient: r.recipient,
      burnHash: r.burnHash,
      burnTx: r.tx,
    };
    await store.setJSON(run.jobId, { ...entry, receipt });

    // Hand off to the background verifier. It re-reads burnHash/destinationKey from the
    // PERSISTED receipt, not from this body — the body carries only the key to find it.
    fireVerifier(event, run.jobId).catch(() => {});

    return json(200, { executed: true, receipt });
  } catch (e) {
    if (e instanceof TxPendingError) {
      // Burn submitted but not yet confirmed → we have a Circle tx id, NOT a hash.
      // HONEST INCOMPLETENESS: this is recorded as burn_pending, never as a receipt.
      const receipt = { ...base, state: "burn_pending", circleTxId: e.txId };
      await store.setJSON(run.jobId, { ...entry, receipt });
      fireVerifier(event, run.jobId).catch(() => {});
      return json(202, { executed: true, pending: true, receipt });
    }
    await store.setJSON(run.jobId, { ...entry, receipt: undefined }); // release lock
    return json(500, { error: e.message });
  }
}

// Trigger the background verifier with the internal token (job-run-background.mjs:86-93
// pattern). Fire-and-forget: a failure here leaves the receipt at burn_confirmed, which
// is honest — the burn DID land; we simply have not yet proven the mint.
async function fireVerifier(event, jobId) {
  const base =
    process.env.DEPLOY_URL ||
    `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
  await fetch(`${base}/.netlify/functions/job-bridge-receipt-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
    body: JSON.stringify({ jobId }),
  });
}
