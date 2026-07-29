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
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
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
    const wallet = await ensureOwnerWallet(session);

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
        return Number(formatUnits(raw, USDC_DECIMALS)).toFixed(2);
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
