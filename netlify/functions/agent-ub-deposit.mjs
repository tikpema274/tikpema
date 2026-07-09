import { json, parseBody, ubDepositCapUsdc } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ubDeposit } from "./_ubdeposit.mjs";

// POST /api/agent-ub-deposit { amountUsdc }  (auth)
//
// FUNDING endpoint for the Unified Balance: the agent SCA moves its own plain Arc USDC
// into its own Gateway/unified balance. Self-custody — the funds stay owned by the SCA.
// No recipient: the depositor and the credited account are both AGENT_WALLET_ADDRESS,
// which is why this is deposit() and not depositFor().
//
// ⚠️ THE CAP IS ENFORCED HERE, AT THE TOP, BEFORE ANY TX / before any approve.
// _ubdeposit.mjs is UNCAPPED — reaching it from an unguarded path would bypass the cap
// (the swap-cap trap). Reject-not-clamp: an over-cap request returns 400 and NOTHING
// signs (we return before ubDeposit runs, so not even the approve is sent).
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  // Auth gate — only an authenticated session may move the agent's funds.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { amountUsdc } = parseBody(event);
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });

  // ── THE CAP — enforced BEFORE any contract call. Reject, never clamp. ──
  const cap = ubDepositCapUsdc();
  if (amount > cap) {
    return json(400, { error: `exceeds per-deposit limit of ${cap} USDC`, cap });
  }

  try {
    const r = await ubDeposit({ amountUsdc: amount });
    return json(200, {
      executed: true,
      state: r.state,
      amountUsdc: r.amountUsdc,
      depositedTo: r.depositedTo,
      approveTxHash: r.approveTxHash,
      depositTxHash: r.depositTxHash,
      tx: r.tx,
    });
  } catch (e) {
    // A dangling allowance is an operational fact, not just an error string — surface
    // it distinctly so the caller (and any log scraper) can act on it.
    if (e.allowanceDangling) {
      return json(500, { error: e.message, allowanceDangling: true });
    }
    return json(500, { error: e.message, allowanceRevoked: e.allowanceRevoked === true });
  }
}
