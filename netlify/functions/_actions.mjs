import { circle, waitForTx } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS } from "./_arc.mjs";
import { agentSwap, valueInUsdc, SWAP_TOKENS } from "./_swap.mjs";
import { agentPay } from "./_pay.mjs";
import { canSpendDay, recordAgentSpend } from "./_budget.mjs";

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
  return `unknown step type "${type}"`;
}

// Execute ONE validated action. The per-transaction cap is still enforced by the
// CALLER (agent-act / execute-plan). This function adds the shared budget-spine
// guardrails around the (unchanged) execution:
//   - session present → block pay_for_service (Gateway/x402 can't run on the
//     user's own SCA yet: needs a Gateway deposit; an SCA can't be the x402 payer),
//   - per-DAY ceiling check (canSpendDay) before spending,
//   - ledger the spend (recordAgentSpend) after success.
// ctx = { walletAddress, session?, store? }. Returns { ok, kind, ... } or { ok:false, blocked }.
export async function executeAction(step, ctx) {
  const { walletAddress, session, store } = ctx;
  const shapeErr = validateStepShape(step);
  if (shapeErr) return { ok: false, blocked: shapeErr };

  // Per-user safety: don't let a Gateway pay fall back to the shared wallet.
  if (session && step.type === "pay_for_service") {
    return {
      ok: false,
      blocked: "pay_for_service isn't available on your own agent wallet yet (Gateway deposit required)",
    };
  }

  // Budget spine: per-day ceiling backstop (shared with research purchases).
  let dayValue;
  try {
    dayValue = await valueOfStep(step);
  } catch (e) {
    return { ok: false, blocked: `cannot value step: ${e.message}` };
  }
  const day = await canSpendDay({ amountUsdc: dayValue, store });
  if (!day.allowed) return { ok: false, blocked: day.reason };

  // On any successful spend below, ledger it against today's ceiling + audit.
  const ledger = () =>
    recordAgentSpend({
      address: session?.address ?? walletAddress,
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
    const pay = await agentPay({
      recipientAddress: String(step.payTo),
      amountUsdc: Number(step.payAmountUsdc).toFixed(2),
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

  return { ok: false, blocked: `unknown step type "${step.type}"` };
}
