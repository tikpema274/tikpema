import { json, parseBody, ubSpendCapUsdc, ubSpendFloorUsdc } from "./_arc.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal } from "./_agent-wallets.mjs";
import { canSpendDay, recordAgentSpend } from "./_budget.mjs";
import { AGENT } from "./_agents.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { ubSpend } from "./_ubspend.mjs";

// POST /api/agent-ub-spend { recipientAddress, amountUsdc, destinationChain? }  (auth)
//
// Unified Balance SPEND (write): a cross-chain spend of the CALLER'S OWN Arc unified
// balance to a recipient on Base Sepolia via the Forwarding Service.
//
// PER-USER: the source is resolved from the VERIFIED SESSION (ensureOwnerWallet), never
// from env. A caller can only spend the balance their own session owns. The delegate
// (env, one shared EOA) merely SIGNS — it can only move a balance that SCA has authorized
// it over via addDelegate, so it cannot reach another user's funds.
//
// ⚠️ THE CAP IS ENFORCED HERE, AT THE TOP, BEFORE ANY UB CALL / before signing.
// _ubspend.mjs / kit.unifiedBalance.spend are UNCAPPED — reaching them from an
// unguarded path would bypass the cap (the swap-cap trap). Reject-not-clamp: an
// over-cap request returns 400 and NO funds move (we return before ubSpend runs).
//
// ⚠️ DAY-CEILING. The per-spend cap bounds ONE spend; it does not bound the DAY. Without
// canSpendDay this was the only money path that ignored PERIOD_CEILING_USDC — you could
// repeat an in-cap spend indefinitely. The gate below runs BEFORE ubSpend (reject, no
// funds move) and the ledger writes AFTER a successful spend, both keyed to the SAME owner
// (this session's SCA) so they read/write one bucket.
const DESTINATIONS = new Set(["Base_Sepolia"]); // first proof: Base Sepolia only

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event); // Blobs wiring — the day-ledger lives there

  // Auth gate — only an authenticated session may move funds.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { recipientAddress, amountUsdc, destinationChain = "Base_Sepolia" } = parseBody(event);
  if (!/^0x[0-9a-fA-F]{40}$/.test(recipientAddress || "")) {
    return json(400, { error: "valid 'recipientAddress' required" });
  }
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });
  if (!DESTINATIONS.has(destinationChain)) {
    return json(400, { error: "unsupported destinationChain (first proof: Base_Sepolia only)" });
  }

  // ── THE FLOOR + CAP — both enforced BEFORE any UB call. Reject, never clamp;
  // nothing signs. Valid range is floor <= amount <= cap. The floor exists because the
  // cross-chain forwarder fee is FLAT (~0.2 USDC), so smaller spends are uneconomical. ──
  const floor = ubSpendFloorUsdc();
  if (amount < floor) {
    return json(400, {
      error: `below minimum spend of ${floor} USDC — cross-chain fee (~0.2 flat) makes smaller amounts uneconomical`,
      floor,
    });
  }
  const cap = ubSpendCapUsdc();
  if (amount > cap) {
    return json(400, { error: `exceeds per-spend limit of ${cap} USDC`, cap });
  }

  // The spender: THIS session's own agent SCA — holds the unified balance being spent.
  let wallet;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { wallet = await ensureOwnerWallet(session); }
  catch (e) { return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e)); }
  if (wallet.pending) {
    return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  }
  const owner = wallet.walletAddress;

  // ── THE DAY-CEILING GATE — a real gate, BEFORE any signing. Over-ceiling ⇒ 400 and
  // NOTHING moves (we return before ubSpend). Owner-keyed, so one user's day of spending
  // never eats another's ceiling. Mirrors the bridge/send path in _actions.mjs. ──
  // ── THE KILL SWITCH. This path moves funds WITHOUT executeAction, so it checks the pause
  // ITSELF — otherwise a paused Executor could still spend the unified balance from here.
  // Fail-closed: an unreadable switch refuses. ──
  const paused = await assertNotPaused({ owner, agent: AGENT.EXECUTOR });
  if (paused) return json(409, { error: paused, paused: true });

  const day = await canSpendDay({ amountUsdc: amount, owner });
  if (!day.allowed) return json(400, { error: day.reason, blocked: true });

  try {
    const r = await ubSpend({
      recipientAddress,
      amountUsdc: amount.toFixed(2),
      destinationChain,
      sourceAccount: owner,
    });

    // Ledger AFTER success, against the SAME owner the gate read. "submitted" counts: the
    // source burn has landed (only the destination mint is still in flight), so the funds
    // ARE gone from the unified balance — not ledgering it would let a caller repeat
    // submitted-but-unconfirmed spends past the ceiling.
    await recordAgentSpend({
      agent: AGENT.EXECUTOR,
      owner,
      amountUsdc: amount,
      source: "ub_spend",
      justification: `cross-chain UB spend to ${recipientAddress} on ${destinationChain}`,
    }).catch(() => {});

    return json(200, {
      executed: true,
      state: r.state,            // "completed" | "submitted"
      transferId: r.transferId ?? null,
      txHash: r.txHash ?? null,
      tx: r.explorerUrl ?? null,
      recipientAddress,
      amountUsdc: amount,
      destinationChain,
      spender: owner,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
