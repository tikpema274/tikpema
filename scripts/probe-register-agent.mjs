// PROBE SCAFFOLD — register ONE throwaway ERC-8004 agent from the DEV-CONTROLLED SCA.
//
// Why this exists: the question under test is "can a user's passkey MSCA call giveFeedback
// gaslessly?" — nothing more. Getting an agentId is scaffolding, and the previous probe made
// that scaffolding a SECOND variable: it registered from a fresh, undeployed passkey MSCA, so
// the very first userOp had to get its own account-deployment sponsored as well. Confounded.
//
// So we get the agentId the boring way: the dev-controlled SCA calls register() and pays its
// own gas from its own USDC balance. NO paymaster is involved here, by design. This removes an
// unknown rather than testing one.
//
// This registers a THROWAWAY agent. It does NOT touch the Researcher, Second Opinion, or
// Executor agents.
//
// ⚠️ ALREADY RUN — DO NOT RE-RUN IT. This is committed as the RECORD of how the throwaway agent
// came to exist, not as a thing to execute. It produced:
//
//     agentId : 850337
//     owner   : 0xc54D47211997aCA90Ef4fCfBc742a3b511B4e621   (the dev-controlled SCA)
//     tx      : 0x1ba87277…aa1e3337
//
// Running it again MINTS ANOTHER AGENT ON-CHAIN and costs real testnet USDC. There is no reason
// to: 850337 already answered the question it was scaffolding for (a passkey MSCA CAN call
// ReputationRegistry.giveFeedback gaslessly — control and test both sponsored by Gas Station,
// paymaster 0x03dF76C8c30A88f424CF3CBBC36A1Ca02763103b, the MSCA's balance unchanged).
//
// Run (only if you truly need a NEW throwaway agent):
//   node --env-file=.env scripts/probe-register-agent.mjs
import { createPublicClient, http, parseEventLogs } from "viem";
import { circle, waitForTx } from "../netlify/functions/_circle.mjs";
import { ARC } from "../netlify/functions/_arc.mjs";
import { CONTRACTS } from "../netlify/functions/_arc.mjs";

const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const AGENT_URI = "ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei";
const RPC = "https://rpc.testnet.arc.network";
const ARC_CHAIN = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

// ERC-721 mint log — the only way to learn the agentId (register's return value is not
// available from a transaction receipt).
const TRANSFER_ABI = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "tokenId", type: "uint256", indexed: true },
  ],
}];

const ZERO = "0x0000000000000000000000000000000000000000";

const walletAddress = process.env.AGENT_WALLET_ADDRESS;
if (!walletAddress) throw new Error("AGENT_WALLET_ADDRESS missing from .env");

console.log("dev-controlled SCA :", walletAddress);
console.log("IdentityRegistry   :", IDENTITY_REGISTRY);
console.log("agent URI          :", AGENT_URI);
console.log("gas                : SELF-PAID from the SCA's own USDC (no paymaster)\n");

const client = circle();

// Same execution path the app already uses for every dev-SCA write (see agent-withdraw.mjs).
const tx = await client.createContractExecutionTransaction({
  walletAddress,
  blockchain: ARC.blockchain,
  contractAddress: IDENTITY_REGISTRY,
  abiFunctionSignature: "register(string)",
  abiParameters: [AGENT_URI],
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
});

console.log("Circle tx id:", tx.data?.id, "— waiting for it to settle…");
const txHash = await waitForTx(client, tx.data?.id);
console.log("tx hash     :", txHash);
console.log("explorer    :", `${ARC.explorer}/tx/${txHash}`);

// Read the agentId out of the mint log.
const pub = createPublicClient({ chain: ARC_CHAIN, transport: http(RPC) });
const receipt = await pub.getTransactionReceipt({ hash: txHash });
const minted = parseEventLogs({ abi: TRANSFER_ABI, eventName: "Transfer", logs: receipt.logs })
  .filter((e) => e.args.from === ZERO);

if (!minted.length) {
  console.error("\n!! no ERC-721 mint log found — could not determine agentId");
  process.exit(1);
}

const agentId = minted[0].args.tokenId;
const owner = minted[0].args.to;

console.log("\n════════════ RESULT ════════════");
console.log("agentId :", agentId.toString());
console.log("owner   :", owner);
console.log(
  owner.toLowerCase() === walletAddress.toLowerCase()
    ? "        ✓ owned by the dev SCA (so a passkey MSCA is NOT the owner — the\n          self-feedback guard cannot fire when that MSCA attests)"
    : "        !! owner is NOT the dev SCA — unexpected"
);
console.log("\nNext: paste this agentId into the browser probe.");
