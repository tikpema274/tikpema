import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { formatUnits } from "viem";
import { TxPendingError } from "./_circle.mjs";
import { json, parseBody, bridgeCapUsdc, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveDestination } from "./_bridge.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { publicClient } from "./_predict.mjs";

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

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
  if (event.blobs) connectBlobs(event); // Blobs: deliverable store + day ledger

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

  let owner;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { owner = await ensureOwnerWallet(session); }
  // ⚠️ ONLY the tagged external failure earns this diagnosis. Anything else — a TypeError from
  // a bad refactor, say — RE-THROWS and surfaces unclaimed, rather than borrowing a
  // "temporary, please retry" it cannot honour.
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }
  if (owner.pending) return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  const walletAddress = owner.walletAddress;

  // ── PRE-FLIGHT BALANCE GATE — runs BEFORE the lock and BEFORE any burn is submitted. ──
  // job #155341 approved a 10 USDC bridge against a 6.30 wallet; the burn reverted on-chain
  // with INSUFFICIENT_TOKEN ("transfer amount exceeds balance"), surfacing as a raw 500
  // and leaving a standing allowance. This read turns that into a clean, pre-execution
  // rejection: read → reject-or-proceed → (only if funded) submit the burn. Nothing signs
  // on the reject path.
  //
  // REQUIRED = amount, NO BUFFER. The fee (~0.20) comes out of the MINTED side, not the
  // wallet — the wallet burns the full amount. And gas is SPONSORED: two prior successful
  // bridges each dropped the wallet by EXACTLY 10.000000 (balanceOf delta, measured).
  // ⚠️ ASSUMES Circle gas-sponsorship — proven, but it is PLATFORM behavior. If
  // INSUFFICIENT_TOKEN ever resurfaces on an amount the wallet appears to cover, sponsorship
  // may have changed; revisit whether a gas buffer is now needed.
  //
  // Mirrors agent-send.mjs:66-81, including its swallow: a transient read hiccup must NOT
  // block a funded user — executeAction's own INSUFFICIENT_TOKEN stays the final backstop.
  try {
    const raw = await publicClient().readContract({
      address: CONTRACTS.USDC, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [walletAddress],
    });
    const have = Number(formatUnits(raw, USDC_DECIMALS));
    if (have < amount) {
      // 402, mirroring job-run.mjs:80-87 { need, have, walletAddress }. No lock taken, no burn.
      return json(402, {
        error: `Insufficient funds to bridge. Have ${have.toFixed(2)} USDC, need ${amount.toFixed(2)}.`,
        need: Number(amount.toFixed(2)),
        have: Number(have.toFixed(2)),
        walletAddress,
      });
    }
  } catch {
    /* balance read hiccup — proceed; the burn's own INSUFFICIENT_TOKEN is the backstop */
  }

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
    // The receipt is DURABLE before the trigger exists. Nothing below can un-record the burn.
    await store.setJSON(run.jobId, { ...entry, receipt });

    // Hand off to the background verifier. It re-reads burnHash/destinationKey from the
    // PERSISTED receipt, not from this body — the body carries only the key to find it.
    const verifierTriggered = await triggerVerifier(event, run.jobId);

    return json(200, { executed: true, receipt, verifierTriggered });
  } catch (e) {
    if (e instanceof TxPendingError) {
      // Burn submitted but not yet confirmed → we have a Circle tx id, NOT a hash.
      // HONEST INCOMPLETENESS: this is recorded as burn_pending, never as a receipt.
      const receipt = { ...base, state: "burn_pending", circleTxId: e.txId };
      await store.setJSON(run.jobId, { ...entry, receipt });
      const verifierTriggered = await triggerVerifier(event, run.jobId);
      return json(202, { executed: true, pending: true, receipt, verifierTriggered });
    }
    await store.setJSON(run.jobId, { ...entry, receipt: undefined }); // release lock
    return json(500, { error: e.message });
  }
}

// Trigger the background verifier with the internal token (job-run-background.mjs:86-93
// pattern). Returns true iff the platform ACKNOWLEDGED the invocation.
//
// ⚠️ WHY THIS IS AWAITED (the bug that stranded job #155262).
// This used to be `fireVerifier(...).catch(() => {})` — fire-and-forget. Netlify FREEZES a
// synchronous function's execution the moment it responds, so the outbound fetch could die
// before the request ever left. The verifier was never invoked, and EVERY receipt stranded
// at `burn_confirmed` while the mint had actually landed. The stubbed write-path test
// missed it precisely because it stubbed `fetch`.
//
// We await the ACK ONLY — never the verifier's ~4-minute poll. Netlify acks a background
// invocation in ~0.3s (measured: 0.29s / 0.33s / 0.73s). The AbortController caps the wait
// at TRIGGER_TIMEOUT_MS so a hung platform cannot hang the caller.
const TRIGGER_TIMEOUT_MS = 3000; // ~4x the slowest observed ack

async function triggerVerifier(event, jobId) {
  // ⚠️ THIS FUNCTION MUST NEVER THROW.
  // By the time it runs, the burn has ALREADY landed on-chain, irreversibly, and the
  // receipt is ALREADY durable. The only thing that can fail here is a notification. If we
  // let that failure surface, the user is told their bridge failed while 10 USDC has left
  // their wallet — the worst lie this system could tell. So: swallow, and report the
  // trigger's fate as a hint (`verifierTriggered`), never as an error.
  //
  // Worst case the receipt stays `burn_confirmed`, which is RECOVERABLE: the verifier's
  // stale-lease reclaim (or a manual invocation) closes it later. The UI copy for that
  // state — "Burn confirmed on Arc — waiting for the destination mint…" — is TRUE either
  // way. `verifierTriggered:false` is a hint, NOT a failure; the UI must not render it as one.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIGGER_TIMEOUT_MS);
  try {
    const base =
      process.env.DEPLOY_URL ||
      `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
    const res = await fetch(`${base}/.netlify/functions/job-bridge-receipt-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ jobId }),
      signal: controller.signal,
    });
    // Netlify acks a background function with 202. Anything 2xx counts as delivered.
    return res.status >= 200 && res.status < 300;
  } catch (e) {
    console.warn(`[approve] verifier trigger failed for job ${jobId} (burn is SAFE and recorded): ${e.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
