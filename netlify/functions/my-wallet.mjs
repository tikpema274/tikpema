// POST /api/my-wallet  (auth required)
//
// Returns the authenticated user's OWN agent wallet (address + USDC balance),
// resolved from the SESSION — provisioning one on first call. The owner is the
// server-verified session identity; the client cannot ask for anyone else's
// wallet. Sub-brick 2a: this wallet is provisioned + shown but NOT yet used by
// the job lifecycle (jobs still run on the shared env wallet — that's 2b).
import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { walletTokenBalances } from "./_balances.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return json(405, { error: "POST or GET only" });
  }
  // Blobs wiring for classic-Lambda handlers (see job-deliverable for the note).
  if (event.blobs) connectBlobs(event);

  // Owner = the verified session identity, never a client-supplied value.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  try {
    let wallet;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { wallet = await ensureOwnerWallet(session); }
  // ⚠️ ONLY the tagged external failure earns this diagnosis. Anything else — a TypeError from
  // a bad refactor, say — RE-THROWS and surfaces unclaimed, rather than borrowing a
  // "temporary, please retry" it cannot honour.
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }

    // Rare sub-convergence race: a mapping was just written by another request
    // but hasn't propagated to reads yet. Tell the client to retry shortly — no
    // duplicate wallet was mapped (the atomic write guarantees one per owner).
    if (wallet.pending) {
      return json(202, {
        status: "provisioning",
        message: "Your wallet is being set up — retry shortly.",
      });
    }

    // ═══ ⭐⭐ THE READ MOVED OUT, AND THAT IS THE POINT ══════════════════════════════════════
    // This function used to hold the only copy of "what does the agent wallet hold". The agent's
    // own `show_balance` answer needs exactly the same fact, and a second read written beside a
    // second .toFixed would eventually print a different number from the one this panel shows,
    // on the same screen. `walletTokenBalances` is now the single producer and this is a reader.
    //
    // ⛔ THE null CONTRACT IS UNCHANGED and load-bearing: a balance that could not be read stays
    // null so the client shows "…", never a fabricated 0. The producer keeps full 6-dp precision
    // for the same reason it was pushed down there — rounding at a producer is a loss no reader
    // can undo. [[duplicate-source-of-truth-is-the-recurring-bug]]
    const { usdc: balance, eurc: eurcBalance } = await walletTokenBalances({
      walletAddress: wallet.walletAddress,
    });

    // Expose only what the client needs. walletId (the Circle signer handle)
    // stays server-side. `balance` remains the USDC amount (back-compat);
    // `eurcBalance` is the new second amount.
    return json(200, {
      owner: session.address,
      method: session.method,
      address: wallet.walletAddress,
      balance,
      eurcBalance,
      provisioned: wallet.provisioned,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
