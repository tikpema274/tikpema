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

  // ⭐ EURC — a SECOND, DISTINCT balance, never summed with USDC (different unit, and EURC != $1).
  // The agent path gets this from /api/my-wallet; the MetaMask path had no EURC read at all, so a
  // panel that swaps EURC could not render the side the user is spending from.
  // ⚠️ NOT wired into `ensureBalance`: gas on Arc is USDC, so an EURC spend still needs USDC
  // headroom. The two are checked separately and deliberately.
  async function refreshEurcBalance(): Promise<string> {
    const raw = (await publicClient.readContract({
      address: CONTRACTS.EURC as `0x${string}`,
      abi: BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
    return Number(formatUnits(raw, USDC_DECIMALS)).toFixed(2); // EURC is 6-dp on Arc, like USDC
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

  // ── HOP A — fund the user's OWN agent SCA from their login wallet. ──────────────
  //
  // The MetaMask twin of the modular wallet's fundAgentWallet. One plain ERC-20 transfer
  // (the agent SCA doesn't pull, so no approve needed). This is NOT the removed `sendUsdc`
  // below: the destination is not arbitrary — it is the caller's own server-resolved agent
  // wallet, and we refuse anything else.
  //
  // SEAM: `toAgentSca` comes from /api/my-wallet (ensureOwnerWallet(session)), never a
  // constant. We explicitly refuse the SHARED agent wallet so a bad prop cannot route a
  // user's funds there.
  //
  // GUARDS are VALIDATION, not a cap — the user's own money into the user's own wallet.
  // ensureBalance covers amount + gas headroom (an EOA pays its own gas, unlike the
  // paymaster-sponsored passkey path).
  async function fundAgentWallet(toAgentSca: string, amountUsdc: number) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(toAgentSca)) {
      throw new Error("Your agent wallet isn't ready yet — try again in a moment.");
    }
    if (AGENT_WALLET_ADDRESS && toAgentSca.toLowerCase() === AGENT_WALLET_ADDRESS.toLowerCase()) {
      throw new Error("Refusing to fund the shared agent wallet — this must go to your own.");
    }
    if (toAgentSca.toLowerCase() === address.toLowerCase()) {
      throw new Error("That's your login wallet — funds would go nowhere.");
    }
    if (!(amountUsdc > 0)) throw new Error("Enter an amount greater than 0.");
    await ensureBalance(amountUsdc);

    const units = BigInt(Math.round(amountUsdc * 1e6));
    const hash = await walletClient.writeContract({
      address: CONTRACTS.USDC as `0x${string}`,
      abi: TRANSFER_ABI,
      functionName: "transfer",
      args: [toAgentSca as `0x${string}`, units],
      account: address,
      chain: arcTestnet,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    await refreshBalance().catch(() => {});
    return { txHash: receipt.transactionHash };
  }

  // ── MANUAL SEND — the user's own key, a CALLER-SUPPLIED destination. ───────────
  //
  // ═══ ⭐⭐ WHAT ACTUALLY CHANGES FROM fundAgentWallet, AND WHAT IT DOES TO THE GUARDS ══════════
  // Mechanically this is fundAgentWallet with the destination opened up. That one change inverts
  // the property fundAgentWallet's SEAM comment states outright — "the destination is not
  // arbitrary" — and it changes what the guards below MEAN, so they are re-justified here rather
  // than copied across with their old labels:
  //
  //   · refuse the SHARED agent wallet — STILL SAFETY, unchanged. A user's own funds must never
  //     be routed to the shared wallet, whoever supplied the address.
  //   · refuse SELF — ⚠️ A MISTAKE-CATCH, NOT A SAFETY PROPERTY. On fundAgentWallet this guard
  //     meant "funds would go nowhere"; here, sending to yourself is a no-op, not a danger.
  //     It is kept because it catches a paste error, and it is described honestly because calling
  //     it safety would inflate what it protects.
  //   · the ALLOWLIST is gone entirely. There is no server-resolved destination behind this call.
  //
  // 🚨 SO THE ONE GENUINELY NEW RISK IS A MISTYPED ADDRESS: a same-chain transfer is irreversible
  // and nothing server-side stands behind it. That is what the panel's confirm step is for, and
  // the only thing it is for — MetaMask already shows destination and amount before signing, so
  // ours earns its place by showing the address AS WE PARSED IT, catching a truncated or
  // whitespace-damaged paste before it ever reaches the extension.
  //
  // ⭐ NO RECEIPT IS WRITTEN, AND THAT IS A DECISION, NOT AN OMISSION. The bridge writes one
  // because delivery is on another chain, the delivered amount differs from the sent amount, and
  // an estimate has to advance to measured. None of the three survives here: delivery IS this
  // transaction, amount received == amount sent, and there is no estimate. A record would buy a
  // history list and COST the bridge's write-after-sign window — accepted there because the record
  // is load-bearing, unjustifiable here for a convenience with nothing recoverable inside it.
  // `waitForTransactionReceipt` below already returns a confirmed on-chain receipt.
  //
  // ⭐ AND NO ACK GATE. The bridge's bands are ratios of a fee TAKEN FROM THE AMOUNT; no fee is
  // deducted here, so there is no band. An ack TOKEN binds a server-computed number the client
  // must not be able to choose, and there is no server-computed number in this path at all.
  // See docs/manual-send-design-note.md — refused on the mechanism, not skipped by omission.
  async function sendUsdcManual(to: string, amountUsdc: number) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(to).trim())) {
      throw new Error("Enter a valid 0x… address (42 characters).");
    }
    const dest = String(to).trim();
    if (AGENT_WALLET_ADDRESS && dest.toLowerCase() === AGENT_WALLET_ADDRESS.toLowerCase()) {
      throw new Error("Refusing to send to the shared agent wallet — that is not your wallet.");
    }
    if (dest.toLowerCase() === address.toLowerCase()) {
      throw new Error("That's the wallet you're sending from — it would go nowhere.");
    }
    if (!(amountUsdc > 0)) throw new Error("Enter an amount greater than 0.");
    await ensureBalance(amountUsdc);

    const units = BigInt(Math.round(amountUsdc * 1e6));
    const hash = await walletClient.writeContract({
      address: CONTRACTS.USDC as `0x${string}`,
      abi: TRANSFER_ABI,
      functionName: "transfer",
      args: [dest as `0x${string}`, units],
      account: address,
      chain: arcTestnet,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    await refreshBalance().catch(() => {});
    return { txHash: receipt.transactionHash };
  }

  // ⚠️ CORRECTED 2026-08-29. This note used to end: "No client-side USDC-move path remains."
  // 🚨 THAT SENTENCE WAS ALREADY FALSE WHEN `manualBridgeBurn` SHIPPED — 14 lines below it, in
  // this same file, approving and burning the user's USDC from the browser. It was FOUND stale,
  // not MADE stale by the manual send above: a reader who met it any time since the manual bridge
  // landed was already misled about this file's actual shape.
  //
  // ⭐ WHAT REMAINS TRUE, stated narrowly so it survives: every send from the user's CIRCLE-CUSTODIED
  // AGENT wallet goes through /api/agent-send (auth + per-user wallet + per-tx cap + day ceiling),
  // and there is no client-side path to that wallet's funds. The user's OWN key is a different
  // regime — the caps bound what the agent may move unattended, never what the user may move
  // themselves — which is exactly why `sendUsdcManual` and `manualBridgeBurn` are allowed to exist.

  // ══ USER-SIGNED BRIDGE — approve (only if short) then the burn ═══════════════════════════════
  // ⭐ THE CALLDATA IS NOT BUILT HERE. It arrives from the server, which priced the fee and
  // computed the band from it: a client-assembled `maxFee` would let the caller choose the band
  // its own acknowledgment is checked against, making the ack gate theatre.
  //
  // 🚨 NO RECEIPT IS WRITTEN BETWEEN THE TWO TRANSACTIONS, AND THE ORDER MATTERS.
  // An approve that lands with a burn that does not leaves an ALLOWANCE sitting there — no money
  // has moved. That is benign and self-healing: the next attempt re-reads the allowance and skips
  // the approve. What would NOT be benign is recording the approve's hash as a burnHash, which
  // the agent path names outright as "a fabricated money-movement record for a burn that was
  // never submitted". The server refuses it independently — an approve goes to USDC, not the
  // BridgingKit, and carries a different selector — but the client does not offer it either.
  async function manualBridgeBurn({
    bridgeContract, usdc, amountMinor, calldata, onStatus,
  }: {
    bridgeContract: string; usdc: string; amountMinor: bigint;
    calldata: `0x${string}`; onStatus?: (s: string) => void;
  }): Promise<`0x${string}`> {
    const allowance = (await publicClient.readContract({
      address: usdc as `0x${string}`,
      abi: [{ type: "function", name: "allowance", stateMutability: "view",
              inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }],
              outputs: [{ type: "uint256" }] }],
      functionName: "allowance",
      args: [address as `0x${string}`, bridgeContract as `0x${string}`],
    })) as bigint;

    if (allowance < amountMinor) {
      onStatus?.("Approve the bridge to move your USDC…");
      const approveHash = await walletClient.writeContract({
        address: usdc as `0x${string}`,
        abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
                inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }],
                outputs: [{ type: "bool" }] }],
        functionName: "approve",
        args: [bridgeContract as `0x${string}`, amountMinor],
      });
      // Wait for the allowance to be real before spending against it. ⚠️ Nothing is recorded here.
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    onStatus?.("Sign the bridge…");
    // Raw calldata — the server built the tuple so it is byte-identical to the agent's burn.
    const burnHash = await walletClient.sendTransaction({
      account: address as `0x${string}`,
      to: bridgeContract as `0x${string}`,
      data: calldata,
    });
    return burnHash;
  }

  // ══ USER-SIGNED SWAP — exact-amount approve (only if short) then the swap ════════════════════
  //
  // ⭐ THE SAME SHAPE AS `manualBridgeBurn` ABOVE, DELIBERATELY. Allowance read → conditional
  // approve → wait → send server-built calldata. That shape runs in production on two paths already
  // (this file's bridge, and `agentSwap` server-side), which is exactly why it was chosen over the
  // one-transaction permit route — see docs/manual-swap-build-scope.md Part 1.
  //
  // 🚨 EXACT-AMOUNT APPROVE, NEVER STANDING. `agentSwap` approves a STANDING allowance bounded by
  // `swapCapUsdc()`; that bound does not exist here, because agent caps do not apply to a user
  // spending their own funds. An unbounded-in-time allowance to the adapter — an UPGRADEABLE proxy
  // with a live owner() — is not something to leave on a user's own wallet. Its rationale is also
  // absent: Design-2's standing allowance exists to amortise an approve-wait against Netlify's 10s
  // sync ceiling, and a browser has no such budget.
  //
  // 🚨 NOTHING IS RECORDED BETWEEN THE TWO TRANSACTIONS, and the order matters — identical to the
  // bridge. An approve that lands with a swap that does not leaves an ALLOWANCE and no movement:
  // benign, self-healing (the next attempt re-reads it and skips the approve), and never to be
  // recorded as a swap. The two txs go to DIFFERENT contracts (USDC vs the adapter) and carry
  // different selectors, so an approve hash can never be mistaken for a swap hash.
  //
  // ⛔ THE CALLDATA IS NOT BUILT HERE and its beneficiary is NOT taken on trust — the caller decodes
  // it (decodeAndVerifySwap) and refuses to reach this function at all if the output would land
  // anywhere but this wallet. See docs/swap-adapter-payer-beneficiary-unbound.md.
  async function manualSwap({
    adapter, tokenIn, amountMinor, calldata, onStatus,
  }: {
    adapter: string; tokenIn: string; amountMinor: bigint;
    calldata: `0x${string}`; onStatus?: (s: string) => void;
  }): Promise<{ swapHash: `0x${string}`; approveHash: `0x${string}` | null }> {
    const allowance = (await publicClient.readContract({
      address: tokenIn as `0x${string}`,
      abi: [{ type: "function", name: "allowance", stateMutability: "view",
              inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }],
              outputs: [{ type: "uint256" }] }],
      functionName: "allowance",
      args: [address as `0x${string}`, adapter as `0x${string}`],
    })) as bigint;

    let approveHash: `0x${string}` | null = null;
    if (allowance < amountMinor) {
      onStatus?.("Approve the swap to move your tokens…");
      approveHash = await walletClient.writeContract({
        address: tokenIn as `0x${string}`,
        abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
                inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }],
                outputs: [{ type: "bool" }] }],
        functionName: "approve",
        args: [adapter as `0x${string}`, amountMinor], // EXACT amount. Never max-uint, never a cap.
      });
      // The allowance must be REAL before spending against it. ⚠️ Nothing is recorded here.
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    onStatus?.("Sign the swap…");
    const swapHash = await walletClient.sendTransaction({
      account: address as `0x${string}`,
      to: adapter as `0x${string}`,
      data: calldata,
    });
    return { swapHash, approveHash };
  }

  // ⭐⭐ DELIBERATELY SEPARATE FROM `manualSwap`, NOT FOLDED INTO IT. If the receipt wait lived
  // inside manualSwap, a wait that threw would take the SWAP HASH down with it — the caller would
  // have money moved and no identifier for the transaction that moved it. Returning the hash first
  // and waiting second means a failed wait costs a display, never the record of the spend.
  // Same discipline as the manual bridge's split between signing and promoting.
  async function waitForSwapReceipt(hash: `0x${string}`) {
    return publicClient.waitForTransactionReceipt({ hash });
  }

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
    fundAgentWallet,
    sendUsdcManual,
    manualBridgeBurn,
    manualSwap,
    waitForSwapReceipt,
    refreshEurcBalance,
    signMessage,
    // EIP-1193 has no programmatic disconnect; the user manages this in the
    // extension. No-op to satisfy the wallet shape.
    disconnect() {},
  };
}

export type MetaMaskWallet = Awaited<ReturnType<typeof connectMetaMask>>;
