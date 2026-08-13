// POST /api/agent-withdraw { amountUsdc }  (auth required)
//
// Move USDC OUT of the caller's agent wallet, back to the caller's OWN login wallet.
// This is the user reclaiming their own float — it is NOT an agent action.
//
// ── WHY THIS IS NOT agent-send ───────────────────────────────────────────────────────
// The agent wallet is a Circle dev-controlled SCA: only the server can move it. That is
// deliberate (it is the agent's operational float, so the user's exposure is bounded and
// self-chosen). But it means that WITHOUT this endpoint the float is custodial with no
// exit — the user could only get funds back through agent-send, which is governed by the
// AGENT's controls: the per-transaction send cap, the rolling day-ceiling, and the pause
// kill-switch.
//
// Those three bound what the AGENT may SPEND. They must never bound what the USER may
// RECLAIM. In particular: a PAUSED agent must not be able to trap the user's money. If it
// could, we would have rebuilt the custody problem one layer down — the exact thing the
// user-funded-MSCA model exists to prevent.
//
// So this endpoint deliberately does NOT call assertNotPaused, canSpendDay, or
// sendCapUsdc. Pausing the agent stops the agent; it does not lock the door.
//
// It also does NOT call recordAgentSpend: a withdrawal is not spend, and ledgering it
// would let the user's own exit consume the agent's daily budget.
//
// ── WHY REMOVING THE GUARDRAILS DOES NOT WIDEN THE ATTACK SURFACE ────────────────────
// It NARROWS it. There is no `to` parameter. The destination is the SESSION's own verified
// identity address (`session.address` — the value _agent-wallets.mjs keys the wallet map
// on), so a withdrawal can only ever pay the wallet the caller proved they control. A
// stolen session can already spend through agent-act/agent-send; it gains nothing here
// that it could not already do, and it cannot redirect funds to an attacker's address,
// because there is nowhere in this file for a caller-supplied address to enter.
//
// What we KEEP: session auth (401 without it) and the live balance pre-check.
//
// ── WHAT THIS DOES NOT COVER ─────────────────────────────────────────────────────────
// balanceOf(SCA) is the SCA's PLAIN USDC only. USDC the agent has deposited into the Circle
// Gateway unified balance is NOT here, and — say this precisely, because getting it slightly
// wrong here poisoned the whole UI — IT CANNOT BE RETURNED TO THE USER AT ALL TODAY.
//
// ⚠️ THIS COMMENT WAS THE SOURCE OF A FALSE CLAIM THAT REACHED PRODUCTION. It used to say the
// Gateway balance "needs initiateWithdrawal + withdraw on the GatewayWallet, after
// `withdrawalDelay` blocks" — describing the CONTRACT's capability. Every downstream reader
// (Dashboard, UnifiedBalancePanel, _arc.mjs, agent-parameters) took that to mean a release
// path EXISTS and is merely slow, and shipped copy telling users their money could be
// released, just not instantly. IT CANNOT. The distinction:
//
//   Circle's GatewayWallet CONTRACT  → does expose a delayed-withdrawal mechanism.
//   THIS APPLICATION                 → implements NO part of it. There is no
//                                      initiateWithdrawal call, no withdraw call, no delay
//                                      handling, no endpoint, anywhere in this codebase.
//                                      _gateway.mjs holds an address; the only Gateway write
//                                      path (_ubspend.mjs) SPENDS the balance cross-chain.
//
// And the user cannot reach the contract themselves: the agent wallet is a dev-controlled SCA,
// so only the server can move it. So: deposited Gateway funds are SPENDABLE CROSS-CHAIN ONLY.
// A capability the contract has and we never built is not a capability the user has. Do not
// describe it as one, and do not let a user discover this by finding money missing.
import { formatUnits } from "viem";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody, ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
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
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  // THE DESTINATION. Server-resolved from the verified session — the user's own login
  // wallet (passkey MSCA or MetaMask EOA). Read the body ONLY for the amount; there is
  // deliberately no `to` field, so no client input can reach this value.
  const to = session.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to || "")) {
    return json(400, { error: "Your session has no valid wallet address — sign in again." });
  }

  const { amountUsdc } = parseBody(event);
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });

  // The SOURCE — the caller's own agent wallet, also server-resolved.
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
  if (wallet.pending) {
    return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  }
  const walletAddress = wallet.walletAddress;

  // A wallet withdrawing to itself is a no-op that still burns gas — refuse it. This can
  // only happen if the identity map is corrupt (login wallet == agent wallet), never from
  // client input, but a silent self-send would be a confusing way to find that out.
  if (walletAddress.toLowerCase() === to.toLowerCase()) {
    return json(400, { error: "Your agent wallet and login wallet are the same address — nothing to withdraw to." });
  }

  // Live balance pre-check: a clean 402 instead of a raw on-chain revert. This reads
  // PLAIN USDC only — see the header note about the Gateway unified balance.
  try {
    const raw = await publicClient().readContract({
      address: CONTRACTS.USDC,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [walletAddress],
    });
    const have = Number(formatUnits(raw, USDC_DECIMALS));
    if (have < amount) {
      return json(402, {
        error:
          `Insufficient withdrawable balance. Your agent wallet holds ${have.toFixed(2)} USDC in plain USDC, ` +
          `need ${amount.toFixed(2)}. Funds in the Gateway unified balance are not withdrawable here.`,
        have: Number(have.toFixed(2)),
      });
    }
  } catch {
    /* balance read hiccup — let the transfer attempt surface any real failure */
  }

  try {
    const client = circle();
    const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
    const tx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "transfer(address,uint256)",
      abiParameters: [to, units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txHash = await waitForTx(client, tx.data?.id);
    return json(200, {
      txHash,
      tx: `${ARC.explorer}/tx/${txHash}`,
      from: walletAddress,
      to,
      amountUsdc: amount,
    });
  } catch (e) {
    if (e instanceof TxPendingError) {
      return json(202, { pending: true, txId: e.txId, message: e.message });
    }
    return json(500, { error: e.message });
  }
}
