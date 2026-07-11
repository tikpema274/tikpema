import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

// UB SPEND PLANE (cross-chain) — the WRITE side of Unified Balance. The agent spends
// USDC from its Arc unified/Gateway balance to a recipient on ANOTHER chain (Base
// Sepolia) via the Forwarding Service.
//
// Delegate-signed exactly like _pay.mjs (a Circle SCA can't sign its own Gateway
// spend): from.address = DELEGATE_ADDRESS (signer, 'ready' on Arc), from.sourceAccount
// = the SPENDER'S OWN SCA (the account that holds the balance), source chain Arc_Testnet.
// to = { chain: dest, recipientAddress, useForwarder:true } — NO destination adapter;
// the Forwarding Service submits the destination mint (async, like our bridge).
//
// SAME async-waiter quirk as _pay.mjs/_swap.mjs: the SCA submits async and App Kit's
// waitForTransaction can throw 1098 ("transaction hash required") though the spend
// lands — caught here and reported state:"submitted".
//
// ⚠️ NO CAP HERE. The caller (agent-ub-spend.mjs) MUST enforce the per-spend cap and
// reject BEFORE calling this. This executor validates shape + spends only.
//
// ⚠️ NO ENV FALLBACK for the source. `sourceAccount` is a REQUIRED param, resolved by the
// caller from the verified session. Reading AGENT_WALLET_ADDRESS here would let a caller
// that forgot to thread the session silently spend the SHARED wallet's balance — the
// cap-bypass/per-user leak. Missing sourceAccount ⇒ throw, never guess.
//
// The DELEGATE stays env-sourced on purpose: it is one shared EOA *signer*, not a source
// of funds. It can only move a balance it has been authorized over via addDelegate, which
// each user's SCA grants for ITSELF (see _delegate.mjs) — so a shared signer cannot reach
// a wallet that hasn't authorized it.
export async function ubSpend({ recipientAddress, amountUsdc, destinationChain = "Base_Sepolia", sourceAccount }) {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const owner = sourceAccount;                      // SCA — holds the unified balance
  const delegate = process.env.DELEGATE_ADDRESS;    // EOA signer (ready on Arc)
  if (!apiKey || !entitySecret) throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET");
  if (!owner) throw new Error("ubSpend requires a `sourceAccount` (the session's agent SCA)");
  if (!delegate) throw new Error("Missing DELEGATE_ADDRESS");

  const amount = String(amountUsdc);
  const kit = new AppKit();
  const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });

  const params = {
    amount,
    token: "USDC",
    from: [{
      adapter,
      address: delegate,        // delegate signs
      sourceAccount: owner,     // funds drawn from the SCA's Arc unified balance
      allocations: [{ amount, chain: "Arc_Testnet" }],
    }],
    to: {
      chain: destinationChain,  // e.g. Base_Sepolia
      recipientAddress,         // minted here by the Forwarding Service
      useForwarder: true,       // no destination adapter — the relayer mints
    },
  };

  try {
    const result = await kit.unifiedBalance.spend(params);
    return {
      state: "completed",
      recipientAddress, amountUsdc: amount, destinationChain,
      transferId: result?.transferId ?? null,
      txHash: result?.txHash ?? null,
      explorerUrl: result?.explorerUrl ?? null,
      result,
    };
  } catch (e) {
    const msg = e?.message || "";
    const causeStr = JSON.stringify(e?.cause || {});
    const isAsyncWaiterQuirk =
      e?.code === 1098 ||
      /transaction hash is required/i.test(msg) ||
      (e?.code === 5001 && /transaction hash is required/i.test(causeStr));
    if (isAsyncWaiterQuirk) {
      // Spend submitted; the source burn landed and the destination mint follows.
      return { state: "submitted", pending: true, recipientAddress, amountUsdc: amount, destinationChain };
    }
    throw e;
  }
}
