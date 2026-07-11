import { connectLambda } from "@netlify/blobs";
import { json, parseBody, ubDepositCapUsdc } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { ubDeposit } from "./_ubdeposit.mjs";

// POST /api/agent-ub-deposit { amountUsdc }  (auth)
//
// FUNDING endpoint for the Unified Balance: the CALLER'S OWN agent SCA moves its own plain
// Arc USDC into its own Gateway/unified balance. Self-custody — the funds stay owned by
// that SCA. No recipient: depositor and credited account are the SAME per-user SCA, which
// is why this is deposit() and not depositFor().
//
// PER-USER: the depositor is resolved from the VERIFIED SESSION (ensureOwnerWallet), never
// from env and never from the request body. A caller can only ever deposit into the wallet
// their session proves ownership of.
//
// ⚠️ THE CAP IS ENFORCED HERE, AT THE TOP, BEFORE ANY TX / before any approve.
// _ubdeposit.mjs is UNCAPPED — reaching it from an unguarded path would bypass the cap
// (the swap-cap trap). Reject-not-clamp: an over-cap request returns 400 and NOTHING
// signs (we return before ubDeposit runs, so not even the approve is sent).
//
// NOTE: a deposit is NOT ledgered against the day-ceiling. It moves the user's own USDC
// into the user's own Gateway balance — self-custody, not a spend. The SPEND side
// (agent-ub-spend / pay_for_service) is what draws down the ceiling.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectLambda(event); // Blobs wiring for classic-Lambda handlers

  // Auth gate — only an authenticated session may move funds.
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

  // The depositor: THIS session's own agent SCA. Provisioned on first touch.
  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) {
    return json(202, { status: "provisioning", message: "Your wallet is being set up — retry shortly." });
  }

  try {
    const r = await ubDeposit({ amountUsdc: amount, owner: wallet.walletAddress });
    return json(200, {
      executed: true,
      state: r.state,
      amountUsdc: r.amountUsdc,
      depositedTo: r.depositedTo,
      approveTxHash: r.approveTxHash,
      depositTxHash: r.depositTxHash,
      tx: r.tx,
      // One-time spender authorization for THIS user's Gateway balance. delegateTxHash is
      // non-null only on the deposit that granted it (their first); null thereafter.
      delegateAuthorized: r.delegateAuthorized,
      delegateAlreadyAuthorized: r.delegateAlreadyAuthorized,
      delegateTxHash: r.delegateTxHash,
    });
  } catch (e) {
    // The delegate grant failed. This is a CLEAN state, not a stranded one: the grant runs
    // BEFORE any approve/deposit, so no funds moved — the user's USDC is still plain in
    // their own wallet, and retrying the deposit re-runs the grant. Say so explicitly
    // rather than returning a bare 500 that reads like lost money.
    if (e.name === "DelegateAuthError") {
      return json(503, { error: e.message, delegateAuthFailed: true, recoverable: true, fundsMoved: false });
    }
    // A dangling allowance is an operational fact, not just an error string — surface
    // it distinctly so the caller (and any log scraper) can act on it.
    if (e.allowanceDangling) {
      return json(500, { error: e.message, allowanceDangling: true });
    }
    return json(500, { error: e.message, allowanceRevoked: e.allowanceRevoked === true });
  }
}
