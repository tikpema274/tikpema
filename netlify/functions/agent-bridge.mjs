import { TxPendingError } from "./_circle.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveDestination } from "./_bridge.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal } from "./_agent-wallets.mjs";
import { recordBridge } from "./_bridge-record.mjs";

// POST /api/agent-bridge { amountUsdc, destination }  (auth required)
//
// Turn 2 of the bridge propose→confirm→execute flow. agent-act returned a priced
// proposal (needsBridgeConfirm); the client POSTs here after the user confirms.
//
// ONE SECURE PATH — same enforcement as every other agent money action:
//   - auth-gated (401 without a session),
//   - the source wallet is the caller's OWN per-user agent wallet, resolved from
//     the SESSION (never client-supplied),
//   - guardrails (per-bridge cap, live fee-floor, day-ceiling, ledger) all live
//     inside the shared executeAction — there is NO second bridge path that
//     bypasses them.
// Returns after the Arc burn lands; the destination mint is async (poll
// /api/agent-bridge-status with the returned burnHash + destination key).
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event); // Blobs for the budget-spine day ledger

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { amountUsdc, destination, ackToken } = parseBody(event);
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });
  const dest = resolveDestination(destination);
  if (!dest) return json(400, { error: `unsupported destination "${destination || ""}"` });

  // Resolve the caller's OWN agent wallet from the session (never client-supplied).
  const owner = await ensureOwnerWallet(session);
  if (owner.pending) {
    return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  }
  const walletAddress = owner.walletAddress;

  // ackToken is the ONLY client-supplied value that reaches the gate, and it is not
  // trusted: _actions recomputes the expected token from the destination, amount and band
  // it priced ITSELF, and compares. A forged or stale token fails the comparison — the
  // same fail-closed shape as the vault deposit gate.
  const step = { type: "bridge_usdc", amountUsdc: amount, destination: dest.key, ackToken, reasoning: `bridge ${amount} USDC to ${dest.label}` };

  try {
    const r = await executeAction(step, { walletAddress, session });
    // A high-fee refusal carries its disclosure so the panel can render the band and
    // return the acknowledgment. The refusal is satisfiable, not terminal.
    if (!r.ok) return json(200, { executed: false, blocked: r.blocked, feeDisclosure: r.feeDisclosure ?? null });

    // The receipt write + settle trigger live in _bridge-record.mjs so the multi-step
    // plan path uses the SAME implementation rather than a second copy. It cannot fail
    // this request — the money has already moved — so we deliberately do not branch on it.
    await recordBridge({ r, session, event, amountRequested: amount });

    return json(200, {
      executed: true,
      kind: "bridge_usdc",
      state: r.state,
      burnHash: r.burnHash,
      tx: r.tx,
      destination: r.destination,
      feeUsdc: r.feeUsdc,
      netUsdc: r.netUsdc,
      recipient: r.recipient,
      // Labelled at the source so the UI cannot present arithmetic as an observation.
      delivery: "predicted",
    });
  } catch (e) {
    // A still-pending Arc burn is submitted-but-slow, not failed.
    if (e instanceof TxPendingError) {
      return json(202, { executed: true, pending: true, txId: e.txId, error: e.message });
    }
    return json(500, { error: e.message });
  }
}
