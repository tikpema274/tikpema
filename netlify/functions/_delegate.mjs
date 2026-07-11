import { ARC, CONTRACTS } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";
import { circle, waitForTx } from "./_circle.mjs";
import { publicClient } from "./_predict.mjs";

// DELEGATE AUTHORIZATION PLANE — the one-time grant that lets the shared EOA signer spend
// a user's OWN Gateway balance.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────
// A Circle dev-controlled SCA CANNOT sign its own Gateway spend (ecrecover rejects the
// SCA's ERC-1271 signature), so DELEGATE_ADDRESS — a plain EOA — signs while funds are
// sourced from the SCA (see _pay.mjs / _ubspend.mjs).
//
// That authority is NOT ambient. It is granted per-depositor, on-chain, by
// `addDelegate(address token, address delegate)` on the Gateway Wallet, and read back with
// `isAuthorizedForBalance(address token, address depositor, address addr)`.
//
// PROVEN (scripts/probe-delegate-status.mjs): the shared agent SCA reads `true` — which is
// why spend works there today — while ALL 48 other SCAs on the entity read `false`. The
// authority does NOT carry over to a freshly-provisioned per-user wallet. Each user's SCA
// must grant it for ITSELF, exactly once.
//
// This is also the per-user SAFETY property: one shared signer cannot touch a wallet that
// has not authorized it. The Gateway itself enforces that — not our code.
//
// ── THE ORDERING (load-bearing — do not reorder) ─────────────────────────────────────
//   fund (hop A) → ensureDelegate → deposit → spend
//
// `addDelegate` is a gas-paying tx, and on Arc gas IS USDC. On a brand-new, EMPTY SCA that
// would be a chicken-and-egg. It isn't one, because this runs from INSIDE ubDeposit, AFTER
// its insufficient-funds check — so by construction the SCA already holds at least the
// deposit amount when we get here. There is NO code path that attempts addDelegate on an
// empty wallet: the balance check throws first.
//
// GAS SOURCE, concretely: per-user SCA userOps on Arc are paymaster-sponsored — decoded
// from real EntryPoint UserOperationEvents, paymaster 0x7ceA357B5AC0639F89F9e378a1f03Aa5005C0a25,
// across different wallets AND different wallet-sets (scripts/probe-addDelegate-gas.mjs).
// So the paymaster pays and the user's balance is untouched. BUT we do not depend on that:
// Gas Station policies can be contract-scoped, and we have not proven GatewayWallet is in
// scope. If it isn't, the SCA self-pays from the USDC it was just funded with (~0.07). The
// ordering above is what makes BOTH outcomes fine — that is the whole point of it.

const GATEWAY_ABI = [
  {
    type: "function",
    name: "isAuthorizedForBalance",
    stateMutability: "view",
    inputs: [
      { name: "token", type: "address" },
      { name: "depositor", type: "address" },
      { name: "addr", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
];

// Is `delegate` already authorized to spend `owner`'s Gateway USDC? A pure read — this is
// the SOURCE OF TRUTH for authorization, never a cached flag. A Blobs mirror could go stale
// against the chain (or lie after a failed tx); the chain cannot.
export async function isDelegateAuthorized(owner, delegate = process.env.DELEGATE_ADDRESS) {
  if (!owner) throw new Error("isDelegateAuthorized requires an owner");
  if (!delegate) throw new Error("Missing DELEGATE_ADDRESS");
  return publicClient().readContract({
    address: GATEWAY.WALLET,
    abi: GATEWAY_ABI,
    functionName: "isAuthorizedForBalance",
    args: [CONTRACTS.USDC, owner, delegate],
  });
}

export class DelegateAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "DelegateAuthError";
    this.recoverable = true; // no funds moved; retrying the deposit re-runs this
  }
}

// Grant the delegate authority over `owner`'s Gateway balance — ONCE. Idempotent: reads
// first, and only writes if the chain says the delegate is not yet authorized. Safe to call
// on every deposit; a no-op (one eth_call) once authorized.
//
// RACE-SAFETY, without a lock: two concurrent deposits could both read `false` and both fire
// addDelegate. We do NOT take a Blobs mutex for this — a lock introduces a worse failure
// (a crash between claim and tx would strand the claim, permanently blocking the user).
// Instead the CHAIN arbitrates: if our addDelegate fails, we RE-READ. If a concurrent call
// already authorized us, the read says `true` and we succeed anyway. A duplicate grant is
// harmless (it sets an already-true mapping); a lost race is invisible. The only state that
// matters is on-chain, and we always re-derive it rather than trusting our own attempt.
export async function ensureDelegate({ owner, delegate = process.env.DELEGATE_ADDRESS }) {
  if (!owner) throw new Error("ensureDelegate requires an owner (the session's agent SCA)");
  if (!delegate) throw new Error("Missing DELEGATE_ADDRESS");

  // 1. Already authorized? Then this is a no-op — the common case on every deposit after
  //    the first.
  if (await isDelegateAuthorized(owner, delegate)) {
    return { authorized: true, alreadyAuthorized: true, txHash: null };
  }

  // 2. Not authorized — grant it. Direct contract execution polled by Circle tx id
  //    (waitForTx), the same path ubDeposit/agent-send use: it returns the REAL hash and
  //    cannot hit the App Kit 1098 async-hash race.
  const client = circle();
  try {
    const tx = await client.createContractExecutionTransaction({
      walletAddress: owner,
      blockchain: ARC.blockchain,
      contractAddress: GATEWAY.WALLET,
      abiFunctionSignature: "addDelegate(address,address)",
      abiParameters: [CONTRACTS.USDC, delegate],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txHash = await waitForTx(client, tx.data?.id);
    return { authorized: true, alreadyAuthorized: false, txHash };
  } catch (e) {
    // 3. The tx failed — but did the STATE still end up right? A concurrent deposit may
    //    have granted it (our tx would then revert as a duplicate), or the tx may have
    //    landed while our poll timed out. Re-derive from the chain before calling it a
    //    failure. This is what makes the lock-free design safe.
    if (await isDelegateAuthorized(owner, delegate).catch(() => false)) {
      return { authorized: true, alreadyAuthorized: true, txHash: null, raced: true };
    }
    // Genuinely not authorized. NO FUNDS HAVE MOVED — ubDeposit calls this BEFORE any
    // approve/deposit, so the user's USDC is still plain in their own SCA. This is a clean,
    // retryable state, not a stranded one: running the deposit again re-runs ensureDelegate.
    throw new DelegateAuthError(
      `Could not authorize the spender for your Gateway balance: ${e.message}. ` +
        `No funds moved — your USDC is still in your wallet. Retry the deposit.`
    );
  }
}
