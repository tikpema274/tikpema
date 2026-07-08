import { json, parseBody, ubSpendCapUsdc } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ubSpend } from "./_ubspend.mjs";

// POST /api/agent-ub-spend { recipientAddress, amountUsdc, destinationChain? }  (auth)
//
// FIRST-PROOF endpoint for the Unified Balance SPEND (write) half: a cross-chain spend
// of the agent's Arc unified balance to a recipient on Base Sepolia via the Forwarding
// Service. Delegate is already 'ready' on Arc, so NO addDelegate / depositFor here.
//
// ⚠️ THE CAP IS ENFORCED HERE, AT THE TOP, BEFORE ANY UB CALL / before signing.
// _ubspend.mjs / kit.unifiedBalance.spend are UNCAPPED — reaching them from an
// unguarded path would bypass the cap (the swap-cap trap). Reject-not-clamp: an
// over-cap request returns 400 and NO funds move (we return before ubSpend runs).
const DESTINATIONS = new Set(["Base_Sepolia"]); // first proof: Base Sepolia only

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  // Auth gate — only an authenticated session may move the agent's funds.
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

  // ── THE CAP — enforced BEFORE any UB call. Reject, never clamp; nothing signs. ──
  const cap = ubSpendCapUsdc();
  if (amount > cap) {
    return json(400, { error: `exceeds per-spend limit of ${cap} USDC`, cap });
  }

  try {
    const r = await ubSpend({ recipientAddress, amountUsdc: amount.toFixed(2), destinationChain });
    return json(200, {
      executed: true,
      state: r.state,            // "completed" | "submitted"
      transferId: r.transferId ?? null,
      txHash: r.txHash ?? null,
      tx: r.explorerUrl ?? null,
      recipientAddress,
      amountUsdc: amount,
      destinationChain,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
