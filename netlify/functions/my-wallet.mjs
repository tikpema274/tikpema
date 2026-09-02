// POST /api/my-wallet  (auth required)
//
// Returns the authenticated user's OWN agent wallet (address + USDC balance),
// resolved from the SESSION — provisioning one on first call. The owner is the
// server-verified session identity; the client cannot ask for anyone else's
// wallet. Sub-brick 2a: this wallet is provisioned + shown but NOT yet used by
// the job lifecycle (jobs still run on the shared env wallet — that's 2b).
import { formatUnits } from "viem";
import { connectBlobs } from "./_blobs.mjs";
import { json, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { publicClient } from "./_predict.mjs";

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

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

    // Best-effort balance reads; a transient RPC hiccup on either token shouldn't
    // fail the call. USDC and EURC are both 6-decimal ERC-20s on Arc. They are
    // returned as TWO distinct amounts (EURC != $1, so no summed total here).
    async function readBalance(token) {
      try {
        const raw = await publicClient().readContract({
          address: token,
          abi: BALANCE_OF_ABI,
          functionName: "balanceOf",
          args: [wallet.walletAddress],
        });
          // ═══ ⭐⭐ A PRODUCER EMITS FULL PRECISION. ONLY A RENDER ROUNDS. ═════════════════════
          // This returned .toFixed(2) on a 6-dp token, so every consumer of this response — eight
          // display sites and one that does ARITHMETIC on it — received a value that had already
          // lost four digits. A displayed 0.40 EURC is anywhere in [0.395, 0.405), and the only way
          // to learn what an agent swap returned was to diff this number across a refresh.
          // ⛔ THE ROUNDING CANNOT LIVE HERE. A producer that rounds makes the loss unrecoverable
          // for every consumer at once, including consumer nine. Rounding at a render is a decision
          // each surface can make and revisit; rounding at the source is one decision made
          // invisibly for all of them.
          // ⚠️ AND A VALUE USED IN ARITHMETIC IS NEVER READ FROM A ROUNDED ONE — BridgePanel's
          // 25/50/75 buttons computed a send amount from this very string.
          return formatUnits(raw, USDC_DECIMALS);
      } catch {
        return null; // client shows "…" for a null balance
      }
    }
    const [balance, eurcBalance] = await Promise.all([
      readBalance(CONTRACTS.USDC),
      readBalance(CONTRACTS.EURC),
    ]);

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
