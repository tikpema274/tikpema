import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, json, parseBody } from "./_arc.mjs";

// POST /api/agent-init
// One-time bootstrap. Creates the agent's developer-controlled SCA wallet and
// registers its ERC-8004 identity on Arc Testnet. Persist the returned ids in
// Netlify env (AGENT_WALLET_ID / AGENT_WALLET_ADDRESS / AGENT_ID) so the agent
// is reused on later calls — re-running this creates a brand new agent.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  try {
    const { metadataUri } = parseBody(event);
    const client = circle();

    // 1. Create a wallet set and one SCA wallet for the agent.
    const walletSet = await client.createWalletSet({ name: "Tikpema Agent" });
    const walletSetId = walletSet.data?.walletSet?.id ?? "";

    const wallets = await client.createWallets({
      blockchains: [ARC.blockchain],
      count: 1,
      walletSetId,
      accountType: "SCA",
    });
    const agentWallet = wallets.data?.wallets?.[0];
    if (!agentWallet) throw new Error("Wallet creation returned no wallet");

    // 2. Register ERC-8004 identity: register(string metadataURI).
    const METADATA_URI =
      metadataUri ||
      "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";

    const registerTx = await client.createContractExecutionTransaction({
      walletAddress: agentWallet.address,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.IDENTITY_REGISTRY,
      abiFunctionSignature: "register(string)",
      abiParameters: [METADATA_URI],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txHash = await waitForTx(client, registerTx.data?.id);

    return json(200, {
      ok: true,
      note: "Persist these in Netlify env to reuse this agent.",
      AGENT_WALLET_ID: agentWallet.id,
      AGENT_WALLET_ADDRESS: agentWallet.address,
      registrationTx: `${ARC.explorer}/tx/${txHash}`,
      metadataUri: METADATA_URI,
    });
  } catch (e) {
    return json(500, { error: e.message });
  }
}
