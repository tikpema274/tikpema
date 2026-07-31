import { TxPendingError } from "./_circle.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { executeAction } from "./_actions.mjs";
import { resolveDestination } from "./_bridge.mjs";
import { requireSession, internalToken } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { writeReceiptNeverThrows } from "./_bridge-receipts.mjs";

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
// Kick the settler and DO NOT WAIT. Failures are logged and swallowed: the settler is
// an optimisation over the client's own polling, not a precondition for the bridge
// having worked. `.catch()` on the promise (rather than await in a try) is what keeps
// this off the request's critical path.
//
// The body carries KEYS ONLY — owner and burnHash. Everything the settler acts on it
// reads from the receipt WE wrote. Same discipline as the plan-path verifier: no hash
// or amount ever enters that system from a caller.
function triggerSettle({ event, owner, burnHash }) {
  try {
    const base =
      process.env.DEPLOY_URL ||
      `${event.headers?.["x-forwarded-proto"] || "https"}://${event.headers?.host}`;
    fetch(`${base}/.netlify/functions/bridge-mint-settle-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ owner, burnHash }),
    }).catch((e) => console.warn(`[bridge-receipt] settle trigger failed (swallowed): ${e?.message}`));
  } catch (e) {
    console.warn(`[bridge-receipt] settle trigger threw (swallowed): ${e?.message}`);
  }
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event); // Blobs for the budget-spine day ledger

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

    // ── RECEIPT: written AFTER the burn landed, and it MUST NOT be able to fail this
    //    request. The money has already moved by the time we get here, so a Blobs
    //    hiccup surfacing as an error would tell the user their bridge failed when it
    //    succeeded — and they would retry and burn twice. writeReceiptNeverThrows
    //    swallows everything; we deliberately do NOT branch on its result.
    //
    //    Every field is SERVER-SOURCED: amounts and fee come from executeAction's own
    //    return (priced live inside it), owner from the session, recipient from the
    //    resolved agent wallet. The client supplies nothing that lands here.
    //
    //    delivery:"predicted" is the honest state at this instant — netPredicted is
    //    arithmetic (amount − maxFee), not an observation. Only the settler's
    //    destination-chain read may promote it to "measured".
    if (r.burnHash) {
      const burnedAt = new Date().toISOString();
      await writeReceiptNeverThrows({
        schema: "bridge-receipt/1",
        owner: session.address,
        burnHash: r.burnHash,
        burnTx: r.tx,
        burnedAt,
        state: "burn_confirmed",
        destinationKey: r.destination?.key,
        destinationLabel: r.destination?.label,
        recipient: r.recipient,
        amountRequested: amount,
        feeUsdc: r.feeUsdc,
        netPredicted: r.netUsdc,
        // The discriminator constraint 2 turns on. It NEVER advances on its own.
        delivery: "predicted",
        amountDelivered: null,
      });
      // Fire-and-continue: hand the 4-minute poll to a background function. We never
      // await its completion — a ~10s sync handler must not host a 4-minute loop.
      triggerSettle({ event, owner: session.address, burnHash: r.burnHash });
    }

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
