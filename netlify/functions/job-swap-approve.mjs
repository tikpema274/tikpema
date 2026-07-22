import { connectLambda, getStore } from "@netlify/blobs";
import { formatUnits } from "viem";
import { json, parseBody, CONTRACTS, USDC_DECIMALS, swapCapUsdc } from "./_arc.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { executeAction } from "./_actions.mjs";
import { SWAP_TOKENS, valueInUsdc } from "./_swap.mjs";
import { publicClient } from "./_predict.mjs";

// POST /api/job-swap-approve { runId }   (auth)
//
// The APPROVE half of the proposal loop for SWAPS — the twin of job-bridge-approve, minus
// the cross-chain machinery. Same trust boundary, and it is the boundary that matters:
//
//   ⚠️ THE ONLY FIELD READ FROM THE CLIENT IS `runId`.
// Tokens, amount and rate all come from the proposal THE SERVER ITSELF WROTE
// (_proposal.mjs validateSwapProposal), and the txHash comes from executeAction's OWN
// return. A hostile body cannot choose what gets swapped, how much, or claim it succeeded.
//
// WHY A SWAP CANNOT REUSE THE BRIDGE'S RECEIPT. The bridge receipt tracks a CCTP burn →
// attestation → destination mint, and is verified against IRIS. A same-chain swap has no
// destination, no burn and no attestation — it either lands on Arc or it does not. So the
// receipt here is a small same-chain twin (job-swap-receipt-background), not a reuse.
//
// ⚠️ THE NULL-HASH PROBLEM, AND WHY WE SNAPSHOT BALANCES.
// _swap.mjs returns `txHash: … ?? null` — the Circle SCA submits asynchronously and App Kit
// can throw the 1098 "transaction hash is required" quirk even though the swap lands. So a
// receipt keyed ONLY on a tx hash is unverifiable exactly when it matters. We therefore
// record the tokenIn/tokenOut balances BEFORE executing. The verifier can then confirm the
// swap by BALANCE DELTA when no hash exists — the chain is the witness, not the SDK.
const RECEIPT_TERMINAL = new Set(["confirmed", "failed", "unconfirmed"]);

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const tokenAddress = (sym) => (String(sym).toUpperCase() === "EURC" ? CONTRACTS.EURC : CONTRACTS.USDC);
const resolveToken = (t) => SWAP_TOKENS.find((x) => x.toUpperCase() === String(t || "").toUpperCase()) ?? null;

async function readBalance(token, wallet) {
  const raw = await publicClient().readContract({
    address: tokenAddress(token),
    abi: BALANCE_OF_ABI,
    functionName: "balanceOf",
    args: [wallet],
  });
  return Number(formatUnits(raw, USDC_DECIMALS)); // USDC and EURC are both 6-dp on Arc
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectLambda(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  // ⚠️ THE ONLY FIELD READ FROM THE CLIENT. There is no second destructure in this file.
  const { runId } = parseBody(event);
  if (!runId || typeof runId !== "string") return json(400, { error: "'runId' required" });

  const runs = getStore("job-runs");
  const run = await runs.get(`run:${runId}`, { type: "json" }).catch(() => null);
  if (!run) return json(404, { error: "unknown runId" });

  // Ownership — a session may only approve ITS OWN run. Per-user, no shared pipeline.
  if (run.owner?.toLowerCase() !== session.address.toLowerCase()) {
    return json(403, { error: "not your job" });
  }
  if (!run.jobId) return json(409, { error: "job not yet created — nothing to approve" });

  const store = getStore("job-deliverables");
  const entry = await store.get(run.jobId, { type: "json" }).catch(() => null);
  if (!entry) return json(404, { error: "no deliverable for this job" });

  if (entry.status !== "completed") {
    return json(409, { error: `research is '${entry.status}', not 'completed' — cannot approve` });
  }

  const proposal = entry.proposal;
  if (!proposal || proposal.action !== "swap_tokens") {
    return json(409, { error: "this brief carries no swap proposal" });
  }

  // Idempotency: never swap twice for one proposal.
  if (entry.receipt) {
    const s = entry.receipt.state;
    if (s === "approving") return json(409, { error: "approval already in flight" });
    if (RECEIPT_TERMINAL.has(s) || s === "submitted" || s === "submitted_no_hash") {
      return json(409, { error: `already approved (receipt state: ${s})`, receipt: entry.receipt });
    }
  }

  // ── RE-VALIDATE at execution time. We wrote the proposal, but the deployed caps may have
  // changed since — a stale proposal must not outrank a current guard. ──
  const tokenIn = resolveToken(proposal.tokenIn);
  const tokenOut = resolveToken(proposal.tokenOut);
  if (!tokenIn || !tokenOut || tokenIn === tokenOut) {
    return json(409, { error: "proposal tokens are no longer valid" });
  }
  const amountIn = Number(proposal.amountIn);
  if (!(amountIn > 0)) return json(409, { error: "proposal amount is not > 0" });

  const owner = await ensureOwnerWallet(session);
  if (owner.pending) {
    return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  }
  const walletAddress = owner.walletAddress;

  // Cap re-check, in USDC-EQUIVALENT — amountIn may be EURC and EURC != $1. Re-priced now,
  // not trusted from the proposal (the stored valueUsdc could be stale).
  let valueUsdc;
  try {
    valueUsdc = await valueInUsdc({ token: tokenIn, amount: amountIn });
  } catch (e) {
    return json(409, { error: `cannot price ${tokenIn} right now — not approving blind: ${e.message}` });
  }
  const cap = swapCapUsdc();
  if (valueUsdc > cap) {
    return json(409, { error: `proposal exceeds current per-swap limit of ${cap} USDC`, cap, valueUsdc });
  }

  // ── PRE-FLIGHT BALANCE GATE — before the lock, before anything signs. Mirrors
  // job-bridge-approve: a clean 402 rather than an on-chain revert. Checked against the
  // INPUT token (which may be EURC), not USDC. ──
  let before;
  try {
    const [inBal, outBal] = await Promise.all([readBalance(tokenIn, walletAddress), readBalance(tokenOut, walletAddress)]);
    if (inBal < amountIn) {
      return json(402, {
        error: `Insufficient funds to swap. Have ${inBal.toFixed(2)} ${tokenIn}, need ${amountIn.toFixed(2)}.`,
        need: Number(amountIn.toFixed(2)),
        have: Number(inBal.toFixed(2)),
        token: tokenIn,
        walletAddress,
      });
    }
    // The snapshot the verifier falls back on when no tx hash comes back (see header).
    before = { [tokenIn]: inBal, [tokenOut]: outBal };
  } catch {
    /* read hiccup — proceed; executeAction's own insufficient-funds is the backstop. But we
       then have NO snapshot, so the verifier must rely on the hash. Recorded as null. */
    before = null;
  }

  const approvedAt = new Date().toISOString();
  const base = {
    approvedBy: session.address,
    approvedAt,
    tokenIn,
    tokenOut,
    amountIn,
    valueUsdc: Number(valueUsdc.toFixed(6)),
    // The wallet the swap runs from — recorded so the background verifier can read balances
    // WITHOUT trusting anything in its own request body (it only gets a jobId).
    walletAddress,
    balancesBefore: before,
  };

  // Optimistic lock BEFORE any money moves (narrows the double-approve window).
  await store.setJSON(run.jobId, { ...entry, receipt: { ...base, state: "approving" } });

  try {
    // executeAction re-applies the per-swap cap (in USDC-equivalent) AND the day-ceiling,
    // and ledgers the spend. It is the only thing that may move money.
    const r = await executeAction(
      { type: "swap_tokens", tokenIn, tokenOut, amountIn, reasoning: proposal.reasoning || "approved swap proposal" },
      { walletAddress, session }
    );

    if (!r.ok) {
      // Blocked by a guard — release the lock, no receipt, no money moved.
      await store.setJSON(run.jobId, { ...entry, receipt: undefined });
      return json(200, { executed: false, blocked: r.blocked });
    }

    // ⚠️ The hash comes from OUR OWN response object, never from the client. It MAY be null
    // (the 1098 quirk) — which is honest incompleteness, not a failure: the swap was
    // submitted. `submitted_no_hash` tells the verifier to confirm by balance delta instead.
    const txHash = r.swap?.txHash ?? null;
    const receipt = {
      ...base,
      state: txHash ? "submitted" : "submitted_no_hash",
      txHash,
      // The AUTHORITATIVE Circle id for this submit. Persisted so the verifier can name the exact
      // day-ceiling charge to reverse when it finds the swap failed — without it the verifier knows
      // a swap failed but not WHICH charge it created.
      // ⚠️ Since the B1 refactor this path returns txHash:null ALWAYS (manual = submit-and-return),
      // so `submitted_no_hash` is now the only state here and the circleId is the only handle.
      // ⚠️ GENERATIONAL BOUNDARY: receipts written before this line carry no circleId — the verifier
      // cannot reverse those, and they fall to the scheduled backstop instead. That is exactly the
      // orphan case the backstop exists for; never guess an id for them.
      circleId: r.swap?.circleId ?? null,
      tx: r.tx ?? null,
      indicativeAmountOut: proposal.indicativeAmountOut ?? null,
    };
    await store.setJSON(run.jobId, { ...entry, receipt });

    const verifierTriggered = await triggerVerifier(event, run.jobId);
    return json(200, { executed: true, receipt, verifierTriggered });
  } catch (e) {
    await store.setJSON(run.jobId, { ...entry, receipt: undefined }); // release the lock
    return json(500, { error: e.message });
  }
}

// Trigger the background verifier. AWAITED, not fire-and-forget — Netlify freezes a
// synchronous function the moment it responds, so an un-awaited fetch can die before the
// request leaves (the bug that stranded job #155262; see job-bridge-approve's note).
// Returns true iff the platform ACKNOWLEDGED the invocation.
async function triggerVerifier(event, jobId) {
  const base =
    process.env.DEPLOY_URL ||
    `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
  try {
    const res = await fetch(`${base}/.netlify/functions/job-swap-receipt-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": internalToken() },
      // Only the KEY to find the receipt. The verifier re-reads everything it needs from
      // the persisted record — this body cannot tell it what to believe.
      body: JSON.stringify({ jobId }),
    });
    return res.ok;
  } catch {
    return false; // the receipt is already durable; the sweep can re-fire
  }
}
