import { formatUnits } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";
import { circle, waitForTx } from "./_circle.mjs";
import { publicClient } from "./_predict.mjs";

// UB DEPOSIT PLANE — the FUNDING side of Unified Balance. Moves the agent SCA's plain
// Arc USDC into the Gateway Wallet contract, credited to the SCA itself. Self-custody:
// the USDC stays owned by the SCA; it is NOT sent to a third party. (Getting it back
// out is withdraw/removeFund, which carries a delay — so this is not instantly
// reversible, even though nothing leaves the agent's control.)
//
// ── WHY NOT App Kit ──────────────────────────────────────────────────────────────
// kit.unifiedBalance.deposit() routes to the provider's depositWithApprove(), which is
// approve → deposit with an `adapter.waitForTransaction` after EACH. On a Circle
// dev-controlled SCA that waiter hits the async-hash race and throws code 1098
// ("Transaction hash is required") though the tx lands — the same failure that kills
// kit.bridge() (see scripts/bridge-direct.mjs). Worse: the SDK's approve step sits
// OUTSIDE its try/catch, so its own revokeAllowanceBestEffort is unreachable when
// approve throws — it strands a live allowance.
//
// So we go DIRECT, exactly like agent-send / bridge-direct: two
// createContractExecutionTransaction calls polled by Circle tx id (waitForTx), which
// return the REAL hash and cannot hit the 1098 race.
//
// ── NON-ATOMIC SAFETY ────────────────────────────────────────────────────────────
// approve + deposit is two transactions, so a failure between them would strand an
// allowance to the Gateway Wallet. We own that cleanup rather than trusting the SDK:
//   1. read the CURRENT allowance first — skip a redundant approve entirely;
//   2. approve the EXACT amount (never infinite, never increaseAllowance — a stacked
//      allowance is the failure mode a naive retry creates);
//   3. if the deposit fails, actively approve(gateway, 0) to revoke.
// The revoke is best-effort by nature (it is itself a tx), so its outcome is REPORTED
// in the thrown error rather than swallowed — an operator must know an allowance is
// dangling.
//
// ⚠️ NO CAP HERE. The caller (agent-ub-deposit.mjs) MUST enforce the per-deposit cap
// and reject BEFORE calling this. This executor validates funds + moves money.

const ERC20_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
];

const toUnits = (amountUsdc) => BigInt(Math.round(Number(amountUsdc) * 10 ** USDC_DECIMALS));

// One direct contract call through the Circle dev-controlled client, polled by tx id.
async function execute(client, walletAddress, contractAddress, abiFunctionSignature, abiParameters) {
  const tx = await client.createContractExecutionTransaction({
    walletAddress,
    blockchain: ARC.blockchain,
    contractAddress,
    abiFunctionSignature,
    abiParameters,
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  });
  return waitForTx(client, tx.data?.id);
}

// Revoke a dangling allowance: approve(gateway, 0). Returns null on success, or the
// Error — the caller surfaces it, because a failed revoke leaves real residue on-chain.
async function revokeAllowance(client, owner) {
  try {
    const txHash = await execute(client, owner, CONTRACTS.USDC, "approve(address,uint256)", [
      GATEWAY.WALLET,
      "0",
    ]);
    return { revoked: true, txHash };
  } catch (e) {
    return { revoked: false, error: e.message };
  }
}

export async function ubDeposit({ amountUsdc }) {
  const owner = process.env.AGENT_WALLET_ADDRESS; // SCA — payer AND credited account
  if (!owner) throw new Error("Missing AGENT_WALLET_ADDRESS");

  const units = toUnits(amountUsdc);
  if (!(units > 0n)) throw new Error("amountUsdc must be > 0");

  const client = circle();
  const pc = publicClient();

  // Insufficient-funds check BEFORE any tx, so a doomed deposit never approves.
  const balance = await pc.readContract({
    address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [owner],
  });
  if (balance < units) {
    throw new Error(
      `Insufficient funds. Have ${formatUnits(balance, USDC_DECIMALS)} USDC, need ${amountUsdc}.`
    );
  }

  // ── 1. Current allowance — don't blindly re-approve. ──
  const existing = await pc.readContract({
    address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: "allowance",
    args: [owner, GATEWAY.WALLET],
  });

  // ── 2. Approve the EXACT amount, only if the standing allowance is short. ──
  let approveTxHash = null;
  if (existing < units) {
    // A non-zero-but-short allowance must go to 0 first: USDC's approve() is a plain
    // setter here, but resetting makes the intent explicit and defeats any stacking.
    if (existing > 0n) {
      const reset = await revokeAllowance(client, owner);
      if (!reset.revoked) throw new Error(`Could not reset stale allowance: ${reset.error}`);
    }
    approveTxHash = await execute(client, owner, CONTRACTS.USDC, "approve(address,uint256)", [
      GATEWAY.WALLET,
      units.toString(),
    ]);
  }

  // ── 3. Deposit. On ANY failure, actively revoke the allowance we just granted. ──
  try {
    const depositTxHash = await execute(
      client, owner, GATEWAY.WALLET, "deposit(address,uint256)",
      [CONTRACTS.USDC, units.toString()]
    );
    return {
      state: "completed",
      amountUsdc: Number(amountUsdc),
      depositedTo: owner,
      approveTxHash,
      depositTxHash,
      tx: `${ARC.explorer}/tx/${depositTxHash}`,
    };
  } catch (depositError) {
    // Only clean up an allowance THIS call granted. If we skipped the approve (one was
    // already sufficient), revoking would clobber pre-existing state we didn't create.
    if (approveTxHash) {
      const cleanup = await revokeAllowance(client, owner);
      if (!cleanup.revoked) {
        const err = new Error(
          `Deposit failed (${depositError.message}) AND the allowance revoke ALSO failed ` +
          `(${cleanup.error}). A USDC allowance of ${amountUsdc} to ${GATEWAY.WALLET} is ` +
          `STILL LIVE and must be revoked manually.`
        );
        err.allowanceDangling = true;
        throw err;
      }
      const err = new Error(`Deposit failed: ${depositError.message} (allowance revoked, no funds moved)`);
      err.allowanceRevoked = true;
      throw err;
    }
    throw depositError;
  }
}
