import { useState, useCallback } from "react";
import {
  toPasskeyTransport,
  toWebAuthnCredential,
  toModularTransport,
  toCircleSmartAccount,
  encodeTransfer,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import { createPublicClient } from "viem";
import {
  createBundlerClient,
  toWebAuthnAccount,
} from "viem/account-abstraction";
import { arcTestnet } from "../config/chain";
import { CONTRACTS } from "../config/contracts";

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

  const connect = useCallback(async (mode: WebAuthnMode, username = "tikpema-user-2") => {
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

  // TEMP (orphan flush): replace a stuck userOp at its EXACT nonce so it mines
  // and frees a bundler mempool slot. A same-(sender,nonce) op is a replacement,
  // not a new op, so the bundler accepts it even when the unstaked 4-op cap is
  // full. Fees are bumped well above the orphans' old 1 gwei / 50 gwei so the
  // replacement both qualifies (>+10%) and is mineable. callData is a harmless
  // 0-value self-transfer — its only job is to consume the nonce.
  const flushNonce = useCallback(
    async (nonce: bigint) => {
      if (!account) throw new Error("Connect a wallet first");
      setBusy(true);
      try {
        setStatus(`Flushing nonce ${nonce}…`);
        const bundler = createBundlerClient({
          account,
          chain: arcTestnet,
          transport: modularTransport,
        });
        const hash = await bundler.sendUserOperation({
          calls: [encodeTransfer(account.address, CONTRACTS.USDC as `0x${string}`, 0n)],
          paymaster: true,
          nonce,
          maxPriorityFeePerGas: 2_000_000_000n, // 2 gwei
          maxFeePerGas: 80_000_000_000n, // 80 gwei
        });
        const { receipt } = await bundler.waitForUserOperationReceipt({ hash, timeout: 60000 });
        setStatus(`Flushed: ${receipt.transactionHash}`);
        return receipt.transactionHash;
      } catch (e: any) {
        setStatus(`Flush error: ${e.message}`);
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
    connectRegister: () => connect(WebAuthnMode.Register),
    connectLogin: () => connect(WebAuthnMode.Login),
    sendUsdc,
    flushNonce,
  };
}
