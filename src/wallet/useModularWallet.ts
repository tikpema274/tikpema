import { useState, useCallback, useEffect } from "react";
import {
  toPasskeyTransport,
  toWebAuthnCredential,
  toModularTransport,
  toCircleSmartAccount,
  encodeTransfer,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient, formatUnits, encodeFunctionData } from "viem";
import {
  createBundlerClient,
  toWebAuthnAccount,
} from "viem/account-abstraction";
import { arcTestnet } from "../config/chain";
import { CONTRACTS, USDC_DECIMALS } from "../config/contracts";

// -- Client-plane config. CLIENT_KEY is browser-safe (domain restricted). --
const clientKey = import.meta.env.VITE_CLIENT_KEY as string;
const clientUrl = import.meta.env.VITE_CLIENT_URL as string;

// Built once at module load.
const passkeyTransport = toPasskeyTransport(clientUrl, clientKey);
const modularTransport = toModularTransport(`${clientUrl}/arcTestnet`, clientKey);
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: modularTransport,
});

// Arc's bundler requires a minimum priority fee. We treat this as a FLOOR, not
// a fixed value: static fees previously stranded userOps in SENT when the live
// priority requirement drifted above the hardcoded number and the bundler tx
// got dropped from the mempool. The floor does NOT break Gas Station
// sponsorship (verified on-chain).
const ARC_PRIORITY_FEE_FLOOR = 1_000_000_000n; // 1 gwei

// Compute fees from live chain state each send: enforce the floor as a minimum,
// add headroom on priority, and size maxFee to survive base-fee swings.
async function computeArcFees() {
  const [block, suggested] = await Promise.all([
    publicClient.getBlock({ blockTag: "latest" }),
    publicClient
      .estimateMaxPriorityFeePerGas()
      .catch(() => ARC_PRIORITY_FEE_FLOOR),
  ]);
  const baseFee = block.baseFeePerGas ?? 0n;
  const priority =
    suggested > ARC_PRIORITY_FEE_FLOOR ? suggested : ARC_PRIORITY_FEE_FLOOR;
  const maxPriorityFeePerGas = (priority * 12n) / 10n; // +20% headroom
  // 2x base fee + priority absorbs base-fee growth between estimate and inclusion.
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas;
  return { maxPriorityFeePerGas, maxFeePerGas };
}

// Minimal ERC-20 read for the USDC balance display.
const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

// ERC-20 approve + the prediction contract's placeBet — used by placeBetAsUser.
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

const PLACE_BET_ABI = [
  {
    type: "function",
    name: "placeBet",
    stateMutability: "nonpayable",
    inputs: [
      { name: "marketId", type: "uint256" },
      { name: "isYes", type: "bool" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// EntryPoint.getNonce(sender, key) — used to pin the 2D-nonce key to 0.
const GET_NONCE_ABI = [
  {
    type: "function",
    name: "getNonce",
    stateMutability: "view",
    inputs: [
      { name: "sender", type: "address" },
      { name: "key", type: "uint192" },
    ],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
] as const;

// toCircleSmartAccount derives a FRESH timestamp-based nonce key per userOp, so
// every op lands in its own mempool slot and a stuck/underpriced op can never be
// replaced — orphaned ops pile up until an unstaked account hits the bundler's
// max-in-flight cap (4) and rejects everything. Pinning the key to 0 makes sends
// sequential and REPLACEABLE: at most one op in flight, and a resend (with higher
// fees) replaces a stuck one at the same nonce instead of orphaning a new slot.
async function nonceKeyZero(
  account: Awaited<ReturnType<typeof toCircleSmartAccount>>
) {
  return publicClient.readContract({
    address: account.entryPoint.address,
    abi: GET_NONCE_ABI,
    functionName: "getNonce",
    args: [account.address, 0n],
  });
}

export type ModularWallet = ReturnType<typeof useModularWallet>;

export function useModularWallet() {
  const [account, setAccount] = useState<Awaited<
    ReturnType<typeof toCircleSmartAccount>
  > | null>(null);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);

  // Read the connected smart account's USDC balance and format it (e.g. "12.50").
  const refreshBalance = useCallback(async () => {
    if (!account) return;
    const raw = (await publicClient.readContract({
      address: CONTRACTS.USDC as `0x${string}`,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    const formatted = Number(formatUnits(raw, USDC_DECIMALS)).toFixed(2);
    setUsdcBalance(formatted);
    return formatted;
  }, [account]);

  // Refresh whenever the account connects (or changes); clear when disconnected.
  useEffect(() => {
    if (!account) {
      setUsdcBalance(null);
      return;
    }
    refreshBalance().catch(() => setUsdcBalance(null));
  }, [account, refreshBalance]);

  const connect = useCallback(async (mode: WebAuthnMode, username: string) => {
    setBusy(true);
    try {
      setStatus("Waiting for passkey…");
      const credential = await toWebAuthnCredential({
        transport: passkeyTransport,
        mode,
        username,
      });
      const smartAccount = await toCircleSmartAccount({
        client: publicClient,
        owner: toWebAuthnAccount({ credential }),
      });
      setAccount(smartAccount);
      setStatus(`Connected: ${smartAccount.address}`);
      return smartAccount;
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  // Gasless USDC transfer (Gas Station sponsors gas via paymaster: true).
  const sendUsdc = useCallback(
    async (to: `0x${string}`, amount: bigint) => {
      if (!account) throw new Error("Connect a wallet first");
      setBusy(true);
      try {
        setStatus("Estimating fees…");
        const bundler = createBundlerClient({
          account,
          chain: arcTestnet,
          transport: modularTransport,
        });
        const [{ maxPriorityFeePerGas, maxFeePerGas }, nonce] = await Promise.all([
          computeArcFees(),
          nonceKeyZero(account),
        ]);
        setStatus("Sending…");
        const hash = await bundler.sendUserOperation({
          calls: [encodeTransfer(to, CONTRACTS.USDC as `0x${string}`, amount)],
          paymaster: true,
          nonce,
          maxPriorityFeePerGas,
          maxFeePerGas,
        });
        const { receipt } = await bundler.waitForUserOperationReceipt({ hash, timeout: 60000 });
        setStatus(`Done: ${receipt.transactionHash}`);
        return receipt.transactionHash;
      } catch (e: any) {
        setStatus(`Error: ${e.message}`);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [account]
  );

  // Stake USDC on a prediction market as the USER (passkey-signed, gasless).
  // Mirrors sendUsdc's mechanism and predict-bet.mjs's approve→placeBet sequence:
  // two sequential user-ops at nonce-key 0, the second sent only after the
  // approve confirms (so its nonce/allowance are settled). Returns the placeBet
  // tx hash. Separate from sendUsdc — does not touch the Send path.
  const placeBetAsUser = useCallback(
    async (marketId: number, isYes: boolean, amountUsdc: number) => {
      if (!account) throw new Error("Connect a wallet first");
      setBusy(true);
      try {
        const bundler = createBundlerClient({
          account,
          chain: arcTestnet,
          transport: modularTransport,
        });
        const units = BigInt(Math.round(amountUsdc * 1e6));

        // 1. Approve the prediction contract to pull the stake. Wait for confirm.
        setStatus("Approving stake…");
        const approveData = encodeFunctionData({
          abi: APPROVE_ABI,
          functionName: "approve",
          args: [CONTRACTS.TIKPEMA_PREDICTION as `0x${string}`, units],
        });
        {
          const [{ maxPriorityFeePerGas, maxFeePerGas }, nonce] = await Promise.all([
            computeArcFees(),
            nonceKeyZero(account),
          ]);
          const approveHash = await bundler.sendUserOperation({
            calls: [{ to: CONTRACTS.USDC as `0x${string}`, data: approveData }],
            paymaster: true,
            nonce,
            maxPriorityFeePerGas,
            maxFeePerGas,
          });
          await bundler.waitForUserOperationReceipt({ hash: approveHash, timeout: 60000 });
        }

        // 2. Place the bet. Fresh nonce/fees now that the approve has settled.
        setStatus("Placing bet…");
        const betData = encodeFunctionData({
          abi: PLACE_BET_ABI,
          functionName: "placeBet",
          args: [BigInt(marketId), isYes, units],
        });
        const [{ maxPriorityFeePerGas, maxFeePerGas }, nonce] = await Promise.all([
          computeArcFees(),
          nonceKeyZero(account),
        ]);
        const betHash = await bundler.sendUserOperation({
          calls: [{ to: CONTRACTS.TIKPEMA_PREDICTION as `0x${string}`, data: betData }],
          paymaster: true,
          nonce,
          maxPriorityFeePerGas,
          maxFeePerGas,
        });
        const { receipt } = await bundler.waitForUserOperationReceipt({ hash: betHash, timeout: 60000 });
        setStatus(`Bet placed: ${receipt.transactionHash}`);
        return receipt.transactionHash;
      } catch (e: any) {
        setStatus(`Error: ${e.message}`);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [account]
  );

  return {
    account,
    address: account?.address ?? null,
    status,
    busy,
    // Register requires a unique username per passkey — the authenticator
    // rejects a duplicate handle ("username is duplicated"), so the user
    // chooses one on the Register screen. We append a short time-based suffix
    // as a safety net so two users picking the same handle don't collide; the
    // chosen name still leads the displayed credential. Login uses discoverable
    // credentials (the user picks a passkey at the OS prompt), so the username
    // is only a hint there and a stable default is fine.
    connectRegister: (username: string) =>
      connect(
        WebAuthnMode.Register,
        `${username}-${Date.now().toString(36).slice(-4)}`
      ),
    connectLogin: () => connect(WebAuthnMode.Login, "tikpema-user"),
    sendUsdc,
    placeBetAsUser,
    usdcBalance,
    refreshBalance,
  };
}
