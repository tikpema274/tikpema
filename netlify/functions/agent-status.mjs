import { createPublicClient, http, formatUnits, getContract } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS, json } from "./_arc.mjs";

const identityAbi = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "tokenURI",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
];

const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

// POST /api/agent-status — read-only, no secrets needed beyond the public RPC.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const address = process.env.AGENT_WALLET_ADDRESS;
  const agentId = process.env.AGENT_ID;
  if (!address) {
    return json(400, {
      error: "AGENT_WALLET_ADDRESS not set — run /api/agent-init first.",
    });
  }

  try {
    const publicClient = createPublicClient({
      chain: {
        id: ARC.chainId,
        name: "Arc Testnet",
        nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
        rpcUrls: { default: { http: [ARC.rpc] } },
      },
      transport: http(ARC.rpc),
    });

    const usdc = getContract({
      address: CONTRACTS.USDC,
      abi: erc20Abi,
      client: publicClient,
    });
    const rawBalance = await usdc.read.balanceOf([address]);

    const result = {
      agentWalletAddress: address,
      usdcBalance: formatUnits(rawBalance, USDC_DECIMALS),
    };

    // If we know the agent's token id, read its on-chain identity too.
    if (agentId) {
      const identity = getContract({
        address: CONTRACTS.IDENTITY_REGISTRY,
        abi: identityAbi,
        client: publicClient,
      });
      result.agentId = agentId;
      result.identityOwner = await identity.read.ownerOf([BigInt(agentId)]);
      result.metadataUri = await identity.read.tokenURI([BigInt(agentId)]);
    }

    return json(200, result);
  } catch (e) {
    return json(500, { error: e.message });
  }
}
