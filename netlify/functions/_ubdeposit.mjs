import { formatUnits } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";
import { circle, waitForTx } from "./_circle.mjs";
import { ensureDelegate } from "./_delegate.mjs";
import { publicClient } from "./_predict.mjs";
import { withRetry } from "./_retry.mjs";

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
//
// ⚠️ NO ENV FALLBACK. `owner` is a REQUIRED param — the caller resolves it from the
// verified session (ensureOwnerWallet). This deliberately does NOT read
// process.env.AGENT_WALLET_ADDRESS: an env fallback here would silently deposit into the
// SHARED agent wallet whenever a caller forgot to thread the session's address, which is
// exactly the per-user leak we are closing. Missing owner ⇒ throw, never guess.

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

// Just the one Gateway view we batch here. The write path (addDelegate) and its own ABI stay
// in _delegate.mjs — this is only the read we fold into ubDeposit's pre-write multicall, and
// it must match _delegate.mjs's GATEWAY_ABI shape exactly (named inputs, bool out).
const GATEWAY_AUTH_ABI = [
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

const toUnits = (amountUsdc) => BigInt(Math.round(Number(amountUsdc) * 10 ** USDC_DECIMALS));

// ── EVERY READ ON THIS PATH GOES THROUGH HERE. ───────────────────────────────────────
// Arc's public RPC rate-limits at a few calls/sec and answers "request limit reached"
// (see _retry.mjs for the full evidence and why viem does not retry it). This path makes
// FOUR reads — three below plus isAuthorizedForBalance inside ensureDelegate — and the
// limiter does not care which one it hits.
//
// ⚠️ THE LESSON THAT PUT THIS HELPER HERE. The first version of this fix wrapped only the
// two reads that appeared in the logs (the delegate reads). The very next deposit throttled
// on `allowance` instead (record dep:07fdbcb0, 2026-07-17 09:58) — the throttle simply moved
// to the nearest unprotected read, and because nothing wrapped it, the failure was recorded
// with `transient: false` while its own errorDetail said "request limit reached". Fixing the
// observed read rather than the CLASS of read bought nothing and produced a lying flag.
// So: no bare `pc.readContract` on this path. Add a read, wrap it.
//
// ⚠️ READS ONLY — NEVER `execute`. Every retry re-runs the thunk, so this is safe exactly
// because eth_call is idempotent. A retried createContractExecutionTransaction is a
// double-spend. The writes below are deliberately NOT wrapped; keep it that way.
const read = (label, fn) => withRetry(fn, { label });

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

export async function ubDeposit({ amountUsdc, owner }) {
  // The session's OWN SCA — payer AND credited account. Caller-supplied, never env.
  if (!owner) throw new Error("ubDeposit requires an `owner` (the session's agent SCA)");

  const units = toUnits(amountUsdc);
  if (!(units > 0n)) throw new Error("amountUsdc must be > 0");

  const client = circle();
  const pc = publicClient();

  // ── THE ONE PRE-WRITE BATCH. ─────────────────────────────────────────────────────────
  // balanceOf(owner) and isAuthorizedForBalance(USDC, owner, delegate) are the only two reads
  // on this path that are genuinely SIMULTANEOUS — both read state before any write, and the
  // sole intervening write (addDelegate, inside ensureDelegate) touches a DIFFERENT mapping on
  // a DIFFERENT contract, so neither read depends on it. They collapse into ONE Multicall3
  // round-trip instead of two, against Arc's rate-limited RPC. (The post-grant balance re-read
  // below CANNOT join this batch: it exists precisely to observe the change addDelegate may
  // have made — batching it here would read stale pre-grant state.)
  //
  // Multicall3 is verified on Arc testnet at 0xcA11…CA11 (3808 bytes of code; an aggregate3 of
  // these exact calls was cross-checked against the direct reads and agreed on both contracts).
  // The whole batch is wrapped in withRetry, so a throttle on it is retried and, if it
  // exhausts, surfaces as one honest TransientChainError — same class as before, half the calls.
  // Guard the env BEFORE the batch. A missing DELEGATE_ADDRESS would make
  // isAuthorizedForBalance read against the zero address and quietly return a WRONG `false`,
  // which would then drive a needless addDelegate. ensureDelegate makes the same check; do it
  // here too, because here is where the value first enters a chain read.
  const delegateAddr = process.env.DELEGATE_ADDRESS;
  if (!delegateAddr) throw new Error("Missing DELEGATE_ADDRESS");
  const [balance, alreadyAuthorized] = await read("check your wallet balance", () =>
    pc.multicall({
      allowFailure: false, // any sub-call failure throws — withRetry then classifies it
      contracts: [
        { address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] },
        {
          address: GATEWAY.WALLET,
          abi: GATEWAY_AUTH_ABI,
          functionName: "isAuthorizedForBalance",
          args: [CONTRACTS.USDC, owner, delegateAddr],
        },
      ],
    })
  );

  // Insufficient-funds check BEFORE any tx, so a doomed deposit never approves.
  if (balance < units) {
    throw new Error(
      `Insufficient funds. Have ${formatUnits(balance, USDC_DECIMALS)} USDC, need ${amountUsdc}.`
    );
  }

  // ── 0. THE DELEGATE GRANT — the ordering hinge (fund → delegate → deposit → spend). ──
  //
  // This sits AFTER the insufficient-funds check above and BEFORE any approve/deposit
  // below. Both halves of that placement are load-bearing; do NOT reorder:
  //
  //  · AFTER the funds check ⇒ the SCA provably holds >= the deposit amount right now, so
  //    addDelegate (a gas-paying tx; gas IS USDC on Arc) can always be paid for. There is
  //    NO path to attempting addDelegate on an empty wallet — the check throws first. That
  //    is what defuses the empty-wallet chicken-and-egg, structurally rather than by
  //    convention.
  //
  //  · BEFORE the approve/deposit ⇒ if the grant fails, NO funds have moved. The user's
  //    USDC is still plain in their own SCA — a clean, retryable state. Granting AFTER the
  //    deposit would instead park their USDC inside Gateway with no authorized spender,
  //    which is recoverable but strictly worse.
  //
  // Idempotent: reads isAuthorizedForBalance first and only writes when false, so this is a
  // single eth_call on every deposit after the first.
  // Pass the authorization we just read in the batch above — ensureDelegate skips its own read
  // and either no-ops (already authorized) or writes the grant. The value is same-block fresh.
  const grant = await ensureDelegate({ owner, knownAuthorized: alreadyAuthorized });

  // The grant MAY have cost gas (it's paymaster-sponsored on Arc today, but Gas Station
  // policies can be contract-scoped and we don't depend on GatewayWallet being in scope).
  // If it was NOT sponsored, the fee came out of this SCA's USDC — which could drop the
  // balance below the amount we just validated. Re-read rather than letting the deposit
  // revert with an opaque error.
  const afterGrant = await read("re-check your wallet balance", () =>
    pc.readContract({
      address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [owner],
    })
  );
  if (afterGrant < units) {
    throw new Error(
      `Authorizing the Gateway spender used ${formatUnits(balance - afterGrant, USDC_DECIMALS)} USDC ` +
        `in gas (a one-time, first-deposit cost), leaving ${formatUnits(afterGrant, USDC_DECIMALS)} USDC — ` +
        `less than the ${amountUsdc} you asked to deposit. No funds moved into Gateway. ` +
        `Retry with a smaller amount; the authorization is already done, so it won't cost again.`
    );
  }

  // ── 1. Approve the EXACT amount. Unconditionally. ──
  //
  // ⚠️ THERE USED TO BE AN `allowance()` READ HERE, AND IT IS DELIBERATELY GONE. It read the
  // standing allowance to decide whether to approve at all, and to reset a non-zero-but-short
  // one to 0 first. Both are unnecessary, and it cost an RPC round-trip on Arc's rate-limited
  // endpoint — it is the read that throttled on 2026-07-17 09:58 (record dep:07fdbcb0,
  // selector 0xdd62ed3e).
  //
  // WHY REMOVING IT IS SAFE — PROVEN ON-CHAIN, not assumed from the old comment here (which
  // asserted "USDC's approve() is a plain setter" without evidence):
  //   · USDC on Arc is FiatTokenV2 — name() = "USDC", version() = "2".
  //   · Multicall3 aggregate3 executes sequentially in one context, so an eth_call of
  //     [approve(GW,100), approve(GW,200), allowance(mc3,GW)] proves the semantics with no tx
  //     and no money: both approves SUCCEEDED and the final allowance read 200. A non-zero →
  //     non-zero approve overwrites directly. There is no USDT-style require(allowance == 0),
  //     so the reset-to-0 dance was defending against a hazard this token does not have.
  //   · Re-run that probe if the token is ever swapped or upgraded — it is the whole basis
  //     for this being one write instead of a read plus a conditional write.
  //
  // WHY IT COSTS US ~NOTHING: a successful deposit consumes the allowance (depositFor pulls
  // exactly `units`), and a failed one revokes it below. So the standing allowance is ~always
  // 0 and the old code approved anyway — the read was paying a round-trip to skip a write that
  // almost never got skipped. It reads 0n on the live wallet today.
  //
  // AND IT MAKES THE CLEANUP STRICTLY SAFER: `approveTxHash` is now always set, so the
  // failure path below can no longer take its "we skipped the approve, don't clobber
  // pre-existing state" branch — because there is no such case. We always granted it, so
  // revoking it on failure is always the right move.
  const approveTxHash = await execute(client, owner, CONTRACTS.USDC, "approve(address,uint256)", [
    GATEWAY.WALLET,
    units.toString(),
  ]);

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
      // The one-time spender authorization. `delegateTxHash` is non-null ONLY on the
      // deposit that actually granted it (the user's first), null on every later deposit —
      // which is how you can see the idempotence working on-chain.
      delegateAuthorized: grant.authorized,
      delegateAlreadyAuthorized: grant.alreadyAuthorized,
      delegateTxHash: grant.txHash,
    };
  } catch (depositError) {
    // We ALWAYS granted the allowance above (the conditional approve is gone), so cleaning it
    // up on failure is always correct — there is no "someone else's pre-existing allowance" to
    // clobber, because we set it ourselves this call. `approveTxHash` is always truthy here;
    // the guard is kept as a belt-and-braces invariant, not a real branch.
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
