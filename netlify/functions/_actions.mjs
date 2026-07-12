import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, sendCapUsdc, bridgeCapUsdc, swapCapUsdc } from "./_arc.mjs";
import { agentSwap, valueInUsdc, SWAP_TOKENS } from "./_swap.mjs";
import { agentPay } from "./_pay.mjs";
import { agentBridge, bridgeFee, resolveDestination } from "./_bridge.mjs";
import { canSpendDay, recordAgentSpend } from "./_budget.mjs";
import { AGENT } from "./_agents.mjs";
import { assertNotPaused } from "./_pause.mjs";

// Shared action layer. Both agent-act (single action) and agent-execute-plan
// (a sequence) run actions through these helpers so the execution logic lives
// in ONE place.
//
// IMPORTANT: the spend cap is NOT enforced here. The caller enforces it —
// agent-act checks the single action against the cap; the plan path sums the
// USD value of ALL steps and checks the TOTAL against the cap before executing
// any of them. valueOfStep() is the shared valuation used for both.

const VALID_TOKENS = SWAP_TOKENS.map((t) => t.toUpperCase());

// USD value of a step, for cap math. Transfer/pay are face USDC; a swap is the
// USD value of its input token (EURC != $1, so value, not units).
export async function valueOfStep(step) {
  const type = step?.type;
  if (type === "transfer_usdc") return Number(step.amountUsdc);
  if (type === "pay_for_service") return Number(step.payAmountUsdc);
  if (type === "swap_tokens") {
    return await valueInUsdc({ token: String(step.tokenIn).toUpperCase(), amount: Number(step.amountIn) });
  }
  // A bridge moves its full face amount OFF Arc (the fee is deducted from it on
  // the destination), so the full amount is what counts against the day-ceiling.
  if (type === "bridge_usdc") return Number(step.amountUsdc);
  throw new Error(`unknown step type "${type}"`);
}

// Validate a step's SHAPE (not the cap). Returns null if ok, or a reason string.
export function validateStepShape(step) {
  const type = step?.type;
  if (type === "transfer_usdc") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(step.to || ""))) return "invalid recipient";
    if (!(Number(step.amountUsdc) > 0)) return "amountUsdc must be > 0";
    return null;
  }
  if (type === "pay_for_service") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(step.payTo || ""))) return "invalid payTo address";
    if (!(Number(step.payAmountUsdc) > 0)) return "payAmountUsdc must be > 0";
    return null;
  }
  if (type === "swap_tokens") {
    const tIn = String(step.tokenIn || "").toUpperCase();
    const tOut = String(step.tokenOut || "").toUpperCase();
    if (!VALID_TOKENS.includes(tIn) || !VALID_TOKENS.includes(tOut)) return "unsupported token (USDC/EURC only)";
    if (tIn === tOut) return "tokenIn and tokenOut must differ";
    if (!(Number(step.amountIn) > 0)) return "amountIn must be > 0";
    return null;
  }
  if (type === "bridge_usdc") {
    if (!(Number(step.amountUsdc) > 0)) return "amountUsdc must be > 0";
    if (!resolveDestination(step.destination)) return `unsupported destination "${step.destination}"`;
    return null;
  }
  return `unknown step type "${type}"`;
}

// Execute ONE validated action. The per-transaction cap is still enforced by the
// CALLER (agent-act / execute-plan). This function adds the shared budget-spine
// guardrails around the (unchanged) execution:
//   - per-DAY ceiling check (canSpendDay) before spending,
//   - ledger the spend (recordAgentSpend) after success.
//
// EVERY money-moving branch below sources funds from ctx.walletAddress — the CALLER'S OWN
// agent SCA, server-resolved from the verified session. No branch reads a wallet from env.
// ctx = { walletAddress, store? }. Returns { ok, kind, ... } or { ok:false, blocked }.
export async function executeAction(step, ctx) {
  const { walletAddress, store } = ctx;
  if (!walletAddress) return { ok: false, blocked: "no agent wallet resolved for this caller" };

  // ── THE KILL SWITCH — checked FIRST, before any cap, any valuation, any signing. ──
  // This is the MAIN chokepoint (agent-act, execute-plan, agent-bridge, and both approve
  // endpoints all land here), but it is NOT the only one: agent-send and agent-ub-spend move
  // funds without ever calling executeAction, so they check it themselves. A pause that one
  // path routes around is not a pause.
  //
  // Fail-closed: if the switch cannot be READ, _pause.mjs returns a reason and we refuse.
  const paused = await assertNotPaused({ owner: walletAddress, agent: AGENT.EXECUTOR });
  if (paused) return { ok: false, blocked: paused };

  const shapeErr = validateStepShape(step);
  if (shapeErr) return { ok: false, blocked: shapeErr };

  // Per-transaction SEND cap (transfers only). Checked FIRST so an over-cap send
  // returns the cap message rather than the day-ceiling one. Applies to BOTH
  // user-directed and autonomous transfers routed through here.
  if (step.type === "transfer_usdc") {
    const cap = sendCapUsdc();
    if (Number(step.amountUsdc) > cap) {
      return { ok: false, blocked: `exceeds per-transaction limit of ${cap} USDC` };
    }
  }

  // Per-BRIDGE cap — cross-chain is the highest-stakes action (funds leave Arc),
  // so it has its own bound, checked first (like the send cap) so an over-cap
  // bridge returns the cap message rather than the day-ceiling one.
  if (step.type === "bridge_usdc") {
    const bcap = bridgeCapUsdc();
    if (Number(step.amountUsdc) > bcap) {
      return { ok: false, blocked: `exceeds per-bridge limit of ${bcap} USDC` };
    }
  }

  // NOTE: pay_for_service used to be BLOCKED here whenever a session was present, because
  // agentPay read the shared AGENT_WALLET_ADDRESS and a per-user pay would have drained the
  // shared Gateway balance. That fallback is gone — agentPay now REQUIRES a sourceAccount,
  // which we thread from ctx.walletAddress below. The block is therefore obsolete: a
  // per-user pay draws from the user's OWN Gateway balance, or fails.
  //
  // A caller with NO session (the internal/autonomous path) still supplies its own
  // ctx.walletAddress, so there is no unowned spend either way.

  // Budget spine: per-day ceiling backstop (shared with research purchases).
  let dayValue;
  try {
    dayValue = await valueOfStep(step);
  } catch (e) {
    return { ok: false, blocked: `cannot value step: ${e.message}` };
  }

  // Per-SWAP cap. Unlike send/bridge (checked above, before valuation), this MUST run here —
  // AFTER valueOfStep — because a swap's amountIn may be EURC, and EURC != $1. valueOfStep
  // has already converted it to USDC-equivalent; bounding the raw amountIn would silently
  // mis-bound every EURC→USDC swap. But it still runs BEFORE canSpendDay, so an over-cap swap
  // returns the CAP message rather than the day-ceiling one — same behaviour as send/bridge.
  //
  // Swap was the only executable action with no per-transaction bound (day-ceiling only).
  // Reject, never clamp: nothing signs.
  if (step.type === "swap_tokens") {
    const scap = swapCapUsdc();
    if (dayValue > scap) {
      return {
        ok: false,
        blocked: `exceeds per-swap limit of ${scap} USDC (${Number(step.amountIn)} ${String(step.tokenIn).toUpperCase()} ≈ ${dayValue.toFixed(2)} USDC)`,
      };
    }
  }

  // Per-user day ceiling: keyed to THIS caller's own agent wallet (server-
  // resolved), so one user's spend never blocks another's. The gate and the
  // ledger below MUST use the same owner (walletAddress) to read/write one bucket.
  const day = await canSpendDay({ amountUsdc: dayValue, store, owner: walletAddress });
  if (!day.allowed) return { ok: false, blocked: day.reason };

  // On any successful spend below, ledger it against today's ceiling + audit.
  const ledger = () =>
    recordAgentSpend({
      agent: AGENT.EXECUTOR,
      owner: walletAddress,
      amountUsdc: dayValue,
      source: step.type,
      justification: step.reasoning,
      store,
    }).catch(() => {});

  if (step.type === "swap_tokens") {
    const tokenIn = String(step.tokenIn).toUpperCase();
    const tokenOut = String(step.tokenOut).toUpperCase();
    const swap = await agentSwap({
      walletAddress,
      tokenIn: SWAP_TOKENS.find((t) => t.toUpperCase() === tokenIn),
      tokenOut: SWAP_TOKENS.find((t) => t.toUpperCase() === tokenOut),
      amountIn: Number(step.amountIn).toFixed(2),
    });
    await ledger();
    return {
      ok: true,
      kind: "swap_tokens",
      swap,
      tx: swap.explorerUrl || (swap.txHash ? `${ARC.explorer}/tx/${swap.txHash}` : null),
    };
  }

  if (step.type === "pay_for_service") {
    // sourceAccount = the caller's OWN agent SCA (server-resolved from the session by
    // agent-act / agent-execute-plan). agentPay has NO env fallback, so if a caller ever
    // fails to thread a wallet here this throws rather than quietly draining the shared
    // Gateway balance. The delegate must be authorized on THIS SCA — ensureDelegate runs
    // at deposit time, and the Gateway itself rejects an unauthorized delegate.
    const pay = await agentPay({
      recipientAddress: String(step.payTo),
      amountUsdc: Number(step.payAmountUsdc).toFixed(2),
      sourceAccount: walletAddress,
    });
    await ledger();
    return { ok: true, kind: "pay_for_service", pay };
  }

  if (step.type === "transfer_usdc") {
    const client = circle();
    const amount = Number(step.amountUsdc);
    const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();
    const tx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "transfer(address,uint256)",
      abiParameters: [String(step.to), units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txHash = await waitForTx(client, tx.data?.id);
    await ledger();
    return { ok: true, kind: "transfer_usdc", tx: `${ARC.explorer}/tx/${txHash}` };
  }

  if (step.type === "bridge_usdc") {
    const dest = resolveDestination(step.destination);
    const amount = Number(step.amountUsdc);
    // FEE-FLOOR refusal: the (volatile) forwarder fee is taken OUT of the amount.
    // If it meets/exceeds the amount, the recipient nets ≤ 0 and the bridge is
    // un-settleable — refuse BEFORE any funds move. This re-checks live at
    // execution time (the fee may have moved since the proposal).
    let fee;
    try {
      fee = await bridgeFee({ amountUsdc: amount, cctpDomain: dest.cctpDomain });
    } catch (e) {
      return { ok: false, blocked: `cannot price bridge to ${dest.label}: ${e.message}` };
    }
    if (fee.maxFee >= fee.amountMinor) {
      return {
        ok: false,
        blocked: `amount too small — the bridge fee to ${dest.label} is ~${fee.feeUsdc.toFixed(2)} USDC right now (≥ your ${amount} USDC), so nothing would arrive`,
      };
    }
    const r = await agentBridge({ walletAddress, destination: dest.key, amountUsdc: amount });
    await ledger();
    // Async two-stage: the Arc burn is done; the destination mint is completed by
    // Circle's relayer. Caller polls agent-bridge-status for the mint tx.
    return {
      ok: true,
      kind: "bridge_usdc",
      state: "submitted",
      burnHash: r.burnHash,
      tx: r.burnTx,
      destination: r.destination,
      feeUsdc: r.feeUsdc,
      netUsdc: r.netUsdc,
      recipient: r.recipient,
    };
  }

  return { ok: false, blocked: `unknown step type "${step.type}"` };
}
