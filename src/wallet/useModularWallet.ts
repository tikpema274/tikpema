import { useState, useCallback, useEffect, useRef } from "react";
import {
  toPasskeyTransport,
  toWebAuthnCredential,
  toModularTransport,
  toCircleSmartAccount,
  WebAuthnMode,
} from "@circle-fin/modular-wallets-core";
import {
  createPublicClient,
  formatUnits,
  encodeFunctionData,
  parseEventLogs,
} from "viem";
import {
  createBundlerClient,
  toWebAuthnAccount,
} from "viem/account-abstraction";
import { sign as signWebauthn } from "webauthn-p256";
import { arcTestnet } from "../config/chain";
import { CONTRACTS, USDC_DECIMALS } from "../config/contracts";

// -- Client-plane config. CLIENT_KEY is browser-safe (domain restricted). --
const clientKey = import.meta.env.VITE_CLIENT_KEY as string;
const clientUrl = import.meta.env.VITE_CLIENT_URL as string;

// The agent wallet — provider + evaluator for user-created ERC-8183 jobs. Read
// from the browser-exposed env var (VITE_-prefixed so Vite bundles it).
const AGENT_WALLET_ADDRESS = import.meta.env
  .VITE_AGENT_WALLET_ADDRESS as `0x${string}`;

// --- Passkey credential persistence (same-device returning login) -----------
// We persist ONLY non-secret fields: the credential id, the P-256 PUBLIC key,
// and the rpId. The passkey's PRIVATE key never leaves the device's secure
// enclave (that is the whole point of a passkey), so there is nothing sensitive
// to store here. Persisting these lets a returning user on the SAME device
// rebuild their EXACT smart account deterministically — with no dependence on
// Circle's blind discoverable lookup, which is what silently minted new wallets.
type StoredCredential = { id: string; publicKey: string; rpId?: string };
const CRED_STORAGE_KEY = "tikpema.passkey.credential.v1";

// Write only {id, publicKey, rpId} — never the raw credential or any secret.
function saveStoredCredential(c: { id: string; publicKey: string; rpId?: string }) {
  try {
    const blob: StoredCredential = { id: c.id, publicKey: c.publicKey };
    if (c.rpId) blob.rpId = c.rpId;
    localStorage.setItem(CRED_STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* private mode / storage disabled — falls back to discoverable login */
  }
}
function loadStoredCredential(): StoredCredential | null {
  try {
    const raw = localStorage.getItem(CRED_STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    // Accept ONLY the exact non-secret shape; ignore anything malformed/legacy.
    if (c && typeof c.id === "string" && typeof c.publicKey === "string") {
      return {
        id: c.id,
        publicKey: c.publicKey,
        rpId: typeof c.rpId === "string" ? c.rpId : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}
function clearStoredCredentialStorage() {
  try {
    localStorage.removeItem(CRED_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

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
  // The WebAuthn credential (id + P-256 public key + rpId) behind the smart
  // account. Used for OFF-CHAIN session auth (webauthn-p256) — no on-chain step.
  // rpId is the relying-party id Circle registered under; the assertion must be
  // requested under the SAME rpId or the browser won't find the credential.
  const [credential, setCredential] = useState<
    { id: string; publicKey: string; rpId?: string } | null
  >(null);
  // Synchronous mirror of `credential` so a just-restored login can sign its
  // auth challenge immediately, before React has flushed the state update.
  const credentialRef = useRef<{
    id: string;
    publicKey: string;
    rpId?: string;
  } | null>(null);

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

  // Sign the server's challenge hash with the passkey (a WebAuthn assertion).
  // The server verifies it OFF-CHAIN against the stored public key — no on-chain
  // ERC-1271, so this works for a fresh passkey whose smart account is not yet
  // deployed. Triggers a passkey tap; moves no funds.
  const signPasskeyChallenge = useCallback(
    async (hash: `0x${string}`) => {
      // Prefer the synchronous ref so a just-restored login can sign at once.
      const cred = credentialRef.current ?? credential;
      if (!cred) throw new Error("Connect a passkey first");
      // Request the assertion under the credential's own rpId so the browser
      // finds it (Circle may register under tikpema.xyz, not the exact origin).
      // This is a TARGETED assertion (allowCredentials = [cred.id]) — it works
      // even for a non-discoverable key, unlike the blind discoverable lookup.
      const { signature, webauthn } = await signWebauthn({
        hash,
        credentialId: cred.id,
        ...(cred.rpId ? { rpId: cred.rpId } : {}),
      });
      return { signature, webauthn };
    },
    [credential]
  );

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
      // Keep the credential (id + public key + rpId) for off-chain session auth.
      // Circle returns publicKey on BOTH register and login, so this works for a
      // returning user too (the server also has it stored from registration).
      const cred = {
        id: credential.id,
        publicKey: credential.publicKey,
        rpId: (credential as { rpId?: string }).rpId,
      };
      credentialRef.current = cred;
      setCredential(cred);
      // Persist the NON-SECRET credential so the next visit on THIS device can
      // restore this exact wallet directly (see restoreLogin), bypassing the
      // blind discoverable lookup. Also captures a new-device discoverable login
      // so its subsequent logins take the fast, deterministic path too.
      saveStoredCredential(cred);
      setStatus(`Connected: ${smartAccount.address}`);
      return smartAccount;
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  // Same-device returning login: rebuild the EXACT smart account from the stored
  // non-secret credential. Pure derivation (the SCA address is keccak of the
  // public key) — no passkey tap, no Circle round-trip — so it cannot "miss" the
  // way a blind discoverable lookup can. The passkey tap happens later, at
  // session auth (signPasskeyChallenge), as a TARGETED assertion. Returns the
  // restored context, or null if there is nothing stored on this device.
  const restoreLogin = useCallback(async () => {
    const stored = loadStoredCredential();
    if (!stored) return null;
    setBusy(true);
    try {
      setStatus("Restoring your wallet…");
      const smartAccount = await toCircleSmartAccount({
        client: publicClient,
        owner: toWebAuthnAccount({
          credential: {
            id: stored.id,
            publicKey: stored.publicKey as `0x${string}`,
          },
        }),
      });
      setAccount(smartAccount);
      credentialRef.current = stored;
      setCredential(stored);
      setStatus(`Connected: ${smartAccount.address}`);
      return {
        account: smartAccount,
        address: smartAccount.address,
        credentialId: stored.id,
        credentialPublicKey: stored.publicKey,
      };
    } finally {
      setBusy(false);
    }
  }, []);

  // Clear in-memory wallet state (does NOT touch the stored credential).
  const disconnect = useCallback(() => {
    setAccount(null);
    setCredential(null);
    credentialRef.current = null;
    setUsdcBalance(null);
    setStatus("");
  }, []);

  // Forget the persisted credential — used only by an explicit "start over".
  const clearStoredCredential = useCallback(() => {
    clearStoredCredentialStorage();
  }, []);

  // NOTE: the old client-side `sendUsdc` (login-wallet direct transfer) was
  // removed — ALL user sends now go through the single secure server endpoint
  // /api/agent-send (auth + per-user wallet + per-tx cap + day-ceiling). There is
  // no client-side USDC-move path anymore.

  // Stake USDC on a prediction market as the USER (passkey-signed, gasless).
  // Mirrors sendUsdc's mechanism — an approve→placeBet sequence of two
  // sequential user-ops at nonce-key 0, the second sent only after the
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
        setStatus("Placing prediction…");
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
        setStatus(`Prediction placed: ${receipt.transactionHash}`);
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

  // Create an ERC-8183 job as the USER (passkey-signed, gasless). Single user-op
  // — createJob needs no prior approve (escrow funding/approve come later) — so
  // unlike placeBetAsUser this is one send at nonce-key 0. provider == evaluator
  // == the agent wallet; hook is the zero address (default non-hooked path).
  // Returns the new jobId, parsed from the JobCreated event in the receipt.
  const createJobAsUser = useCallback(
    async (question: string) => {
      if (!account) throw new Error("Connect a wallet first");
      if (!AGENT_WALLET_ADDRESS)
        throw new Error("Missing VITE_AGENT_WALLET_ADDRESS");
      setBusy(true);
      try {
        const bundler = createBundlerClient({
          account,
          chain: arcTestnet,
          transport: modularTransport,
        });

        const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 86400); // +24h
        const createJobData = encodeFunctionData({
          abi: CREATE_JOB_ABI,
          functionName: "createJob",
          args: [
            AGENT_WALLET_ADDRESS, // provider
            AGENT_WALLET_ADDRESS, // evaluator
            expiredAt,
            question, // description
            "0x0000000000000000000000000000000000000000", // hook (none)
          ],
        });

        setStatus("Creating job…");
        const [{ maxPriorityFeePerGas, maxFeePerGas }, nonce] = await Promise.all(
          [computeArcFees(), nonceKeyZero(account)]
        );
        const hash = await bundler.sendUserOperation({
          calls: [
            { to: CONTRACTS.AGENTIC_COMMERCE as `0x${string}`, data: createJobData },
          ],
          paymaster: true,
          nonce,
          maxPriorityFeePerGas,
          maxFeePerGas,
        });
        const { receipt } = await bundler.waitForUserOperationReceipt({
          hash,
          timeout: 60000,
        });

        // Pull the jobId out of the JobCreated event the contract emits.
        const [created] = parseEventLogs({
          abi: CREATE_JOB_ABI,
          eventName: "JobCreated",
          logs: receipt.logs,
        });
        if (!created) throw new Error("Could not parse JobCreated event");
        const jobId = created.args.jobId;
        setStatus(`Job #${jobId} created: ${receipt.transactionHash}`);
        return jobId;
      } catch (e: any) {
        setStatus(`Error: ${e.message}`);
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [account]
  );

  // Fund an ERC-8183 job as the USER (the job's client, passkey-signed, gasless).
  // Mirrors placeBetAsUser: two sequential user-ops at nonce-key 0, the second
  // sent only after the approve confirms (so its nonce/allowance are settled).
  // fund() takes no amount — the contract pulls job.budget, so the approve must
  // cover at least that. Returns the fund tx hash.
  const fundJobAsUser = useCallback(
    async (jobId: number, amountUsdc: number) => {
      if (!account) throw new Error("Connect a wallet first");
      setBusy(true);
      try {
        const bundler = createBundlerClient({
          account,
          chain: arcTestnet,
          transport: modularTransport,
        });
        const units = BigInt(Math.round(amountUsdc * 1e6));

        // 1. Approve AgenticCommerce to pull the budget. Wait for confirm.
        setStatus("Approving escrow…");
        const approveData = encodeFunctionData({
          abi: APPROVE_ABI,
          functionName: "approve",
          args: [CONTRACTS.AGENTIC_COMMERCE as `0x${string}`, units],
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

        // 2. Fund the job. Fresh nonce/fees now that the approve has settled.
        setStatus("Funding job…");
        const fundData = encodeFunctionData({
          abi: FUND_JOB_ABI,
          functionName: "fund",
          args: [BigInt(jobId), "0x"],
        });
        const [{ maxPriorityFeePerGas, maxFeePerGas }, nonce] = await Promise.all([
          computeArcFees(),
          nonceKeyZero(account),
        ]);
        const fundHash = await bundler.sendUserOperation({
          calls: [{ to: CONTRACTS.AGENTIC_COMMERCE as `0x${string}`, data: fundData }],
          paymaster: true,
          nonce,
          maxPriorityFeePerGas,
          maxFeePerGas,
        });
        const { receipt } = await bundler.waitForUserOperationReceipt({ hash: fundHash, timeout: 60000 });
        setStatus(`Job funded: ${receipt.transactionHash}`);
        return { txHash: receipt.transactionHash };
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
    // Discoverable/usernameless login — the FALLBACK for a new device or cleared
    // storage, where there is no stored credential to restore from. May prompt
    // the user to pick a passkey; on success the credential is persisted so the
    // next login on that device takes the fast, deterministic restore path.
    connectLoginDiscoverable: () => connect(WebAuthnMode.Login, "tikpema-user"),
    restoreLogin,
    disconnect,
    clearStoredCredential,
    hasStoredCredential: () => loadStoredCredential() !== null,
    placeBetAsUser,
    createJobAsUser,
    fundJobAsUser,
    signPasskeyChallenge,
    credentialId: credential?.id ?? null,
    credentialPublicKey: credential?.publicKey ?? null,
    usdcBalance,
    refreshBalance,
  };
}
