// src/wallet/connectors/metamask.ts
//
// MetaMask (EOA) execution path. Unlike the passkey/modular path, MetaMask is an
// external EIP-1193 EOA: the user signs and pays their own gas. On Arc, gas is
// paid in native USDC at CONTRACTS.USDC — the SAME token that funds the job — so
// a single balanceOf is the whole spendable pool (stake + gas come from it).
//
// EOAs use linear native nonces, handled by viem. We deliberately do NOT carry
// over any 2D-nonce / nonce-key-0 logic from the modular path (that exists only
// to tame the bundler's per-userOp mempool slots and is meaningless for an EOA).
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  formatUnits,
  parseEventLogs,
} from "viem";
import { arcTestnet, ARC_CHAIN_HEX } from "../../config/chain";
import { CONTRACTS, USDC_DECIMALS } from "../../config/contracts";

// The agent wallet — provider + evaluator for user-created ERC-8183 jobs. Read
// from the browser-exposed env var (VITE_-prefixed so Vite bundles it).
const AGENT_WALLET_ADDRESS = import.meta.env
  .VITE_AGENT_WALLET_ADDRESS as `0x${string}`;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// Gas headroom on top of any spend. Gas is native USDC, so a fund of N USDC
// actually needs N + a little to cover the approve + fund transaction fees.
const GAS_HEADROOM_USDC = 0.05;

// --- ABIs: copied verbatim from useModularWallet.ts so the on-chain calls are
// byte-identical to the proven passkey path. Only the signer/gas model differs.

// Minimal ERC-20 read for the USDC balance + spend pre-checks.
const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

// ERC-20 transfer — used by sendUsdc (the wallet card's Send box).
const TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// ERC-20 approve — lets AgenticCommerce pull the job budget.
const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// AgenticCommerce createJob + the JobCreated event we parse the jobId from.
const CREATE_JOB_ABI = [
  {
    type: "function",
    name: "createJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "provider", type: "address" },
      { name: "evaluator", type: "address" },
      { name: "expiredAt", type: "uint256" },
      { name: "description", type: "string" },
      { name: "hook", type: "address" },
    ],
    outputs: [{ name: "jobId", type: "uint256" }],
  },
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      { indexed: true, name: "jobId", type: "uint256" },
      { indexed: true, name: "client", type: "address" },
      { indexed: true, name: "provider", type: "address" },
      { indexed: false, name: "evaluator", type: "address" },
      { indexed: false, name: "expiredAt", type: "uint256" },
      { indexed: false, name: "hook", type: "address" },
    ],
    anonymous: false,
  },
] as const;

// AgenticCommerce fund — pulls job.budget from the client (no amount param).
const FUND_JOB_ABI = [
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "uint256" },
      { name: "optParams", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

// Is an injected EIP-1193 provider (MetaMask et al.) present?
export function isMetaMaskAvailable() {
  return typeof window !== "undefined" && !!(window as any).ethereum;
}

// Connect MetaMask, ensure it's on Arc Testnet, and return an object that
// implements the same job verbs the passkey wallet exposes. The user signs and
// pays gas themselves; there is no paymaster / Gas Station on this path.
export async function connectMetaMask() {
  if (!isMetaMaskAvailable()) {
    throw new Error("MetaMask is not available");
  }
  const provider = (window as any).ethereum;

  // 1. Request accounts.
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.length) throw new Error("No account returned from MetaMask");
  const address = getAddress(accounts[0]);

  // 2. Ensure the active chain is Arc Testnet. Switch first; if the chain isn't
  // known to the wallet (error 4902) add it from our hand-rolled arcTestnet def.
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_CHAIN_HEX }],
    });
  } catch (e: any) {
    if (e?.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: ARC_CHAIN_HEX,
            chainName: arcTestnet.name,
            nativeCurrency: arcTestnet.nativeCurrency,
            rpcUrls: arcTestnet.rpcUrls.default.http,
            blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
          },
        ],
      });
    } else {
      throw e;
    }
  }

  // 3. Build viem clients over the injected provider on Arc.
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: custom(provider),
  });
  const walletClient = createWalletClient({
    account: address,
    chain: arcTestnet,
    transport: custom(provider),
  });

  // Raw on-chain USDC balance (base units).
  async function readBalanceRaw(): Promise<bigint> {
    return (await publicClient.readContract({
      address: CONTRACTS.USDC as `0x${string}`,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
  }

  // Formatted balance string (e.g. "12.50"), matching the modular path.
  async function refreshBalance(): Promise<string> {
    const raw = await readBalanceRaw();
    return Number(formatUnits(raw, USDC_DECIMALS)).toFixed(2);
  }

  // Pre-spend guard. Gas also comes out of USDC, so require the spend PLUS a
  // small headroom buffer. Throws an explicit, user-readable error otherwise.
  async function ensureBalance(amountUsdc: number): Promise<void> {
    const raw = await readBalanceRaw();
    const have = Number(formatUnits(raw, USDC_DECIMALS));
    const need = amountUsdc + GAS_HEADROOM_USDC;
    if (have < need) {
      throw new Error(
        `Insufficient USDC: need ~${need.toFixed(2)} (stake + gas), have ${have.toFixed(2)}`
      );
    }
  }

  // Create an ERC-8183 job as the USER (EOA-signed, user pays gas). Single tx —
  // no funds move yet, so no balance pre-check; only the agent-wallet env is
  // required. provider == evaluator == the agent wallet; hook is the zero
  // address. Returns the new jobId, parsed from the JobCreated event.
  async function createJobAsUser(question: string): Promise<bigint> {
    if (!AGENT_WALLET_ADDRESS) {
      throw new Error("Missing VITE_AGENT_WALLET_ADDRESS");
    }
    const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 86400); // +24h
    const hash = await walletClient.writeContract({
      address: CONTRACTS.AGENTIC_COMMERCE as `0x${string}`,
      abi: CREATE_JOB_ABI,
      functionName: "createJob",
      args: [
        AGENT_WALLET_ADDRESS, // provider
        AGENT_WALLET_ADDRESS, // evaluator
        expiredAt,
        question, // description
        ZERO_ADDRESS, // hook (none)
      ],
      account: address,
      chain: arcTestnet,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({
      abi: CREATE_JOB_ABI,
      eventName: "JobCreated",
      logs: receipt.logs,
    });
    if (!created) throw new Error("Could not parse JobCreated event");
    return created.args.jobId;
  }

  // Fund an ERC-8183 job as the USER (its client). Two sequential txs, the
  // second only after the first confirms: (1) approve AgenticCommerce to pull
  // the budget, (2) fund() — which pulls job.budget (no amount param). Returns
  // the fund tx hash.
  // Return type is inferred (txHash: `0x${string}`) so it matches the modular
  // path exactly — the panels are typed against the modular wallet's shape.
  async function fundJobAsUser(jobId: number, amountUsdc: number) {
    await ensureBalance(amountUsdc);
    const units = BigInt(Math.round(amountUsdc * 1e6));

    // 1. Approve, then wait for confirmation.
    const approveHash = await walletClient.writeContract({
      address: CONTRACTS.USDC as `0x${string}`,
      abi: APPROVE_ABI,
      functionName: "approve",
      args: [CONTRACTS.AGENTIC_COMMERCE as `0x${string}`, units],
      account: address,
      chain: arcTestnet,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // 2. Fund, only after the approve has settled.
    const fundHash = await walletClient.writeContract({
      address: CONTRACTS.AGENTIC_COMMERCE as `0x${string}`,
      abi: FUND_JOB_ABI,
      functionName: "fund",
      args: [BigInt(jobId), "0x"],
      account: address,
      chain: arcTestnet,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: fundHash,
    });
    return { txHash: receipt.transactionHash };
  }

  // NOTE: the client-side `sendUsdc` was removed — all user sends go through the
  // single secure server endpoint /api/agent-send (auth + per-user wallet + cap +
  // day-ceiling). No client-side USDC-move path remains.

  // Sign a plain message with the EOA (personal_sign). Used as the session auth
  // proof — the server verifies it off-chain via ecrecover. Moves no funds.
  async function signMessage(message: string) {
    return walletClient.signMessage({ account: address, message });
  }

  return {
    kind: "metamask" as const,
    address,
    refreshBalance,
    createJobAsUser,
    fundJobAsUser,
    signMessage,
    // EIP-1193 has no programmatic disconnect; the user manages this in the
    // extension. No-op to satisfy the wallet shape.
    disconnect() {},
  };
}

export type MetaMaskWallet = Awaited<ReturnType<typeof connectMetaMask>>;
