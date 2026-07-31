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
// Kick the settler. The FETCH IS AWAITED; only its FAILURE is swallowed.
//
// 🚨 THE BUG THIS FIXES (burn 0x0175cf7b…, 2026-07-31). This used to be
// `fetch(...).catch(...)` with no await, on the reasoning that not awaiting keeps the
// trigger off the request's critical path. It keeps it off the critical path by never
// happening: A NETLIFY FUNCTION CAN FREEZE THE MOMENT THE HANDLER RETURNS, so an
// un-awaited fetch is often never sent. That receipt sat at `burn_confirmed` for three
// hours with `settlingSince` never set — the settler was never invoked — while the mint
// had in fact landed on Base. The UI rendered "in flight" indefinitely: the exact
// "Still bridging forever" failure this whole design existed to remove, reintroduced
// through a different door.
//
// ⚠️ The identical warning was already written twelve lines below, over the receipt
// write ("an un-awaited write may simply never happen"), and the repo's own precedent
// awaits its trigger (job-submit-background.mjs:208, `const evalRes = await fetch(...)`).
// The lesson was applied to the write and violated for the trigger in the same function.
//
// Awaiting costs one in-region round trip to a function that returns 202 immediately —
// it does NOT wait for the settling itself. Errors stay swallowed: the settler is an
// optimisation over the client's own polling, never a precondition for the bridge
// having worked, so a trigger failure must not fail a bridge whose money already moved.
//
// The body carries KEYS ONLY — owner and burnHash. Everything the settler acts on it
// reads from the receipt WE wrote. Same discipline as the plan-path verifier: no hash
// or amount ever enters that system from a caller.
async function triggerSettle({ event, owner, burnHash }) {
  try {
    const base =
      process.env.DEPLOY_URL ||
      `${event.headers?.["x-forwarded-proto"] || "https"}://${event.headers?.host}`;
    const r = await fetch(`${base}/.netlify/functions/bridge-mint-settle-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ owner, burnHash }),
    });
    console.log(`[bridge-receipt] settle trigger sent burnHash=${burnHash} status=${r.status}`);
    return true;
  } catch (e) {
    console.warn(`[bridge-receipt] settle trigger FAILED (swallowed) burnHash=${burnHash}: ${e?.message}`);
    return false;
  }
}

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
    return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
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
        // ⭐ THE GATE LEAVES EVIDENCE. Without these the receipt could not answer "was the
        // user warned, and did they accept?" — for a disclosure whose whole purpose is
        // consent to lose most of the amount, that belonged in the record rather than in
        // someone's memory of what the screen said. All server-sourced: `feeBand` is what
        // we priced, `acknowledged` is true only because the token we recomputed matched.
        feeRatio: r.feeRatio ?? null,
        ackBand: r.feeBand ?? null,
        ackRequired: r.ackRequired ?? false,
        ackAcceptedAt: r.acknowledged ? burnedAt : null,
        ackToken: r.ackToken ?? null,
      });
      // AWAIT THE TRIGGER — see the block comment on triggerSettle. This waits only for
      // the background function to ACK (202, immediate); it does not host the 4-minute
      // poll, which still runs off this request. An un-awaited call here is not "fire
      // and continue", it is "fire and maybe never send".
      await triggerSettle({ event, owner: session.address, burnHash: r.burnHash });
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
