import { AppKit } from "@circle-fin/app-kit";
import { createCircleWalletsAdapter } from "@circle-fin/adapter-circle-wallets";

// PAY PLANE. The agent pays USDC from its Gateway (Unified Balance) to any
// recipient on Arc Testnet. The agent wallet is a dev-controlled SCA, which
// CANNOT sign Gateway spends (ecrecover rejects the SCA's ERC-1271 signature).
// So an authorized EOA delegate (DELEGATE_ADDRESS) signs the spend while funds
// are sourced from the SPENDER'S OWN SCA (sourceAccount). Same-chain Arc->Arc,
// NO forwarder — this is the exact shape proven on-chain (0.1 USDC delivered,
// tx 0xbf56e6be...7133501).
//
// The Circle Wallets adapter submits async; App Kit's waitForTransaction throws
// (code 1098 / "transaction hash required", sometimes surfaced as a 5001 mint
// "error" whose nested cause is 1098) EVEN THOUGH the spend lands on-chain. We
// catch that family and report submitted-pending, mirroring _swap.mjs.
//
// ⚠️ NO ENV FALLBACK for the source. `sourceAccount` is REQUIRED and comes from the
// caller's server-resolved session wallet (executeAction's ctx.walletAddress). This
// function previously read AGENT_WALLET_ADDRESS, which meant a per-user pay would have
// drawn down the SHARED Gateway balance — the cap-bypass seam. Missing ⇒ throw.
export async function agentPay({ recipientAddress, amountUsdc, sourceAccount }) {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  const owner = sourceAccount;                      // SCA depositor (holds balance)
  const delegate = process.env.DELEGATE_ADDRESS;    // EOA signer
  if (!apiKey || !entitySecret) throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET");
  if (!owner) throw new Error("agentPay requires a `sourceAccount` (the session's agent SCA)");
  if (!delegate) throw new Error("Missing DELEGATE_ADDRESS (run the delegate authorization)");

  const amount = String(amountUsdc);
  const kit = new AppKit();
  const adapter = createCircleWalletsAdapter({ apiKey, entitySecret });

  const params = {
    amount,
    token: "USDC",
    from: [{
      adapter,
      address: delegate,        // delegate signs
      sourceAccount: owner,     // funds drawn from the SCA's Gateway balance
      allocations: [{ amount, chain: "Arc_Testnet" }],
    }],
    to: {
      adapter,
      chain: "Arc_Testnet",
      address: recipientAddress,
      recipientAddress,
    },
  };

  try {
    const result = await kit.unifiedBalance.spend(params);
    return { state: "completed", recipientAddress, amountUsdc: amount, result };
  } catch (e) {
    const msg = e?.message || "";
    const causeStr = JSON.stringify(e?.cause || {});
    const isAsyncWaiterQuirk =
      e?.code === 1098 ||
      /transaction hash is required/i.test(msg) ||
      (e?.code === 5001 && /transaction hash is required/i.test(causeStr));
    if (isAsyncWaiterQuirk) {
      // Spend submitted; the mint lands shortly. Not a failure.
      return { state: "submitted", pending: true, recipientAddress, amountUsdc: amount };
    }
    throw e;
  }
}
