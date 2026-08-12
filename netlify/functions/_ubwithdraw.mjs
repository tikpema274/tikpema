import { formatUnits, parseUnits } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";
import { circle, waitForTx } from "./_circle.mjs";
import { publicClient } from "./_predict.mjs";
import { withRetry } from "./_retry.mjs";

// UB WITHDRAW PLANE — the EXIT side of Unified Balance. Moves the agent SCA's Gateway
// balance back into the SCA's own plain Arc USDC. Hop 3 (SCA → the user's login wallet)
// already exists as agent-withdraw and is deliberately NOT duplicated here.
//
// ═══ 🚨 WHY THIS EXISTS AT ALL ═══════════════════════════════════════════════════════
// Until 2026-08-12 there was no exit. The page said so honestly, and on testnet that was
// defensible. It is not defensible with real user money: A POCKET WITH NO EXIT THAT THE
// USER WAS TOLD ABOUT IS STILL A POCKET WITH NO EXIT — disclosure changes who is
// culpable, not what the user can do. Mainnet is 2026-09-16.
//
// ═══ ⭐ THE SHAPE: TWO CALLS, ~7 DAYS APART ══════════════════════════════════════════
//   1. initiateWithdrawal(token, amount)  — starts the delay. Nothing moves yet.
//   2. …withdrawalDelay() blocks later…   — MEASURED 1,209,600 blocks ≈ 7.1 days
//   3. withdraw(token)                    — the funds land in the SCA
//
// ⚠️ THE DELAY IS IN BLOCKS, NOT SECONDS. `1209600 = 14 × 86400` is a COINCIDENCE and has
// misled a reader before. ~7.1 days is DERIVED from measured block time (0.5097 s/block),
// so every user-facing string must say "about seven days" and never a precise figure.
//
// ═══ 🚨 WHY BOTH HALVES SHIP TOGETHER, AND WHY A SWEEPER DRIVES STEP 3 ═══════════════
// Building only step 1 is WORSE THAN BUILDING NOTHING: it starts a clock nobody finishes
// while the user believes they are leaving. An exit that exists only up to the point of
// commitment is not an exit, it is a delay with a UI.
//
// ⭐ And "the user comes back in a week and clicks again" is the same failure wearing a
// nicer face. This repo already measured it on the bridge: recovery that rode a live
// session needed a human to be looking, and a receipt sat stranded for 7h58m with its
// mint already landed. THE CASE ONLY A CRON COVERS IS A USER WHO LEAVES AND NEVER
// RETURNS — which, for a withdrawal, is the ordinary case rather than the edge one.
// So step 3 is driven by a scheduled sweeper; a manual "complete now" may exist but must
// never be REQUIRED.
//
// ═══ ⚠️ READS ARE RETRIED, WRITES ARE NOT — the same rule as _ubdeposit ══════════════
// Every retry re-runs the thunk. That is safe for eth_call because it is idempotent. A
// retried createContractExecutionTransaction is a DOUBLE SPEND. Keep the writes bare.

/** Gateway's own delay, read from chain — never hardcoded, never cached across runs. */
export const WITHDRAWAL_DELAY_SIG = "withdrawalDelay()";

/** Measured on Arc over 20,000 blocks (2026-07-31). Used ONLY to render an approximation. */
export const ARC_SECONDS_PER_BLOCK = 0.5097;

const read = (label, fn) => withRetry(fn, { label });

/** One direct contract call through the Circle dev-controlled client, polled by tx id.
 *  ⚠️ DELIBERATELY NOT WRAPPED IN withRetry — see the header. */
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

const GATEWAY_ABI = [
  { name: "availableBalance", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "withdrawableBalance", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "withdrawalDelay", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ type: "uint256" }] },
];

/**
 * What the chain says about this owner's exit, right now. READ-ONLY.
 *
 * ⭐ TRI-STATE ON PURPOSE: an unreadable chain returns `readable:false`, NEVER zero. "I could
 * not read your balance" and "your balance is zero" are different facts, and only one of them
 * should ever be shown to someone asking where their money is. Same rule as the vault
 * inspector's UNREADABLE and _dd-health's readable flag.
 */
export async function readExitState({ owner }) {
  if (!owner) throw new Error("readExitState requires an `owner`");
  const pc = publicClient();
  try {
    const [available, withdrawable, delayBlocks] = await read("ub-exit-state", () =>
      pc.multicall({
        allowFailure: false,
        contracts: [
          { address: GATEWAY.WALLET, abi: GATEWAY_ABI, functionName: "availableBalance", args: [CONTRACTS.USDC, owner] },
          { address: GATEWAY.WALLET, abi: GATEWAY_ABI, functionName: "withdrawableBalance", args: [CONTRACTS.USDC, owner] },
          { address: GATEWAY.WALLET, abi: GATEWAY_ABI, functionName: "withdrawalDelay", args: [] },
        ],
      }));
    const approxDays = Number(delayBlocks) * ARC_SECONDS_PER_BLOCK / 86400;
    return {
      readable: true,
      availableAtomic: available.toString(),
      availableUsdc: formatUnits(available, USDC_DECIMALS),
      withdrawableAtomic: withdrawable.toString(),
      withdrawableUsdc: formatUnits(withdrawable, USDC_DECIMALS),
      delayBlocks: delayBlocks.toString(),
      // ⚠️ APPROXIMATE AND DERIVED. Never render this as an exact duration.
      approxDelayDays: Math.round(approxDays * 10) / 10,
      delayProvenance:
        `${delayBlocks} BLOCKS (not seconds — 1209600 = 14 × 86400 is a coincidence), converted at ` +
        `a measured ${ARC_SECONDS_PER_BLOCK} s/block, so this is an ESTIMATE of about ` +
        `${Math.round(approxDays)} days and must be described that way.`,
    };
  } catch (e) {
    // ⭐ UNREADABLE, not zero. The caller must refuse to draw a conclusion from this.
    return {
      readable: false,
      error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 200),
      detail:
        "the Gateway balance could not be read, so nothing can be said about this exit — this is " +
        "INDETERMINATE, and must never be shown as a zero balance or as 'nothing to withdraw'.",
    };
  }
}

/**
 * STEP 1 — start the clock. Nothing moves on-chain except the request itself.
 *
 * 🚨 THE CALLER MUST HAVE PERSISTED A RECORD BEFORE CALLING THIS. If this succeeds and the
 * record is missing, the clock is running and NOTHING KNOWS TO FINISH IT — the sweeper scans
 * records, not the chain, so an unrecorded initiation is precisely the half-built exit this
 * design exists to avoid. Same persist-before-broadcast ordering as _dd-x402's pending handle
 * and dd-watch's alert state: the natural order fails in the direction that costs the user.
 */
export async function ubInitiateWithdrawal({ owner, amountUsdc }) {
  if (!owner) throw new Error("ubInitiateWithdrawal requires an `owner` (the session's agent SCA)");
  const units = parseUnits(String(amountUsdc), USDC_DECIMALS);
  if (!(units > 0n)) throw new Error("amountUsdc must be > 0");

  const state = await readExitState({ owner });
  // ⭐ REFUSE ON UNREADABLE. Starting a 7-day clock against a balance we could not read is
  // exactly the fail-open this codebase keeps closing: an absence must never satisfy a check.
  if (!state.readable) {
    const err = new Error("cannot start a withdrawal: the Gateway balance is UNREADABLE right now");
    err.reason = "balance-unreadable";
    err.detail = state.detail;
    throw err;
  }
  if (units > BigInt(state.availableAtomic)) {
    const err = new Error(
      `cannot withdraw ${amountUsdc} USDC — the unified balance holds ${state.availableUsdc} USDC`);
    err.reason = "insufficient-balance";
    throw err;
  }

  const client = circle();
  const txHash = await execute(
    client, owner, GATEWAY.WALLET, "initiateWithdrawal(address,uint256)",
    [CONTRACTS.USDC, units.toString()],
  );
  return {
    step: "initiated",
    txHash,
    amountUsdc: String(amountUsdc),
    amountAtomic: units.toString(),
    delayBlocks: state.delayBlocks,
    approxDelayDays: state.approxDelayDays,
  };
}

/**
 * STEP 3 — complete it. Moves the matured balance into the SCA's plain USDC.
 *
 * ⚠️ `withdraw(address)` TAKES NO BENEFICIARY: the recipient is msg.sender, i.e. the SCA
 * itself. So this does NOT return funds to the user's login wallet — that is hop 3
 * (agent-withdraw), which already exists. Anything telling the user "your money is back"
 * after only this call would be false.
 *
 * ⭐ IDEMPOTENCE IS THE CHAIN'S, NOT OURS. With nothing matured, `withdraw` REVERTS (measured:
 * "N;O"). So a double-run is refused by the contract rather than double-paying — which is why
 * the sweeper may retry safely. Do not add a second guard that pretends to be the real one.
 */
export async function ubCompleteWithdrawal({ owner }) {
  if (!owner) throw new Error("ubCompleteWithdrawal requires an `owner`");

  const state = await readExitState({ owner });
  if (!state.readable) {
    const err = new Error("cannot complete a withdrawal: the Gateway balance is UNREADABLE right now");
    err.reason = "balance-unreadable";
    err.detail = state.detail;
    throw err;
  }
  // Not yet matured is a NORMAL state, not an error — the sweeper sees it on every tick until
  // the delay elapses. It must be distinguishable from a failure, or the sweeper logs alarm
  // every ten minutes for a week and trains everyone to ignore it.
  if (BigInt(state.withdrawableAtomic) === 0n) {
    return {
      step: "not-yet-matured",
      withdrawableUsdc: state.withdrawableUsdc,
      approxDelayDays: state.approxDelayDays,
      detail: "nothing has matured yet — this is the expected state during the delay, not a failure",
    };
  }

  const client = circle();
  const txHash = await execute(
    client, owner, GATEWAY.WALLET, "withdraw(address)", [CONTRACTS.USDC],
  );
  return {
    step: "completed",
    txHash,
    movedUsdc: state.withdrawableUsdc,
    // ⚠️ Say where the money actually IS, so no caller can imply it reached the user.
    landedIn: owner,
    stillNeeded:
      "the funds are now plain USDC in the agent SCA. Returning them to the user's own login " +
      "wallet is a SEPARATE step (agent-withdraw) and has not happened yet.",
  };
}
