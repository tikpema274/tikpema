import { connectLambda } from "@netlify/blobs";
import { TxPendingError } from "./_circle.mjs";
import { json, parseBody } from "./_arc.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveDestination } from "./_bridge.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";

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
  if (event.blobs) connectLambda(event); // Blobs for the budget-spine day ledger

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { amountUsdc, destination } = parseBody(event);
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });
  const dest = resolveDestination(destination);
  if (!dest) return json(400, { error: `unsupported destination "${destination || ""}"` });

  // Resolve the caller's OWN agent wallet from the session (never client-supplied).
  const owner = await ensureOwnerWallet(session);
  if (owner.pending) {
    return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  }
  const walletAddress = owner.walletAddress;

  const step = { type: "bridge_usdc", amountUsdc: amount, destination: dest.key, reasoning: `bridge ${amount} USDC to ${dest.label}` };

  try {
    const r = await executeAction(step, { walletAddress, session });
    if (!r.ok) return json(200, { executed: false, blocked: r.blocked });
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
    });
  } catch (e) {
    // A still-pending Arc burn is submitted-but-slow, not failed.
    if (e instanceof TxPendingError) {
      return json(202, { executed: true, pending: true, txId: e.txId, error: e.message });
    }
    return json(500, { error: e.message });
  }
}
