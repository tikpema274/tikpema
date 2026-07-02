import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, json, parseBody } from "./_arc.mjs";
import { GATEWAY } from "./_gateway.mjs";

// POST /api/gateway-deposit { amountUsdc: number }
//
// EXECUTES. The agent's dev-controlled wallet deposits its OWN USDC into the
// Circle Gateway Wallet on Arc Testnet, growing its crosschain unified balance.
// Two on-chain steps:
//   1. approve the Gateway Wallet to pull USDC from the agent wallet
//   2. deposit(usdcAddress, amount) on the Gateway Wallet
//
// This is the Gateway deposit method — NOT a plain ERC-20 transfer. A transfer
// would move USDC into the contract without crediting the unified balance.
//
// Guards are enforced HERE, not by any model:
//   - amountUsdc must be > 0 and <= AGENT_MAX_SPEND_USDC
// Read the resulting balance back with /api/gateway-balance.

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { amountUsdc } = parseBody(event);

  // ── Input validation ──────────────────────────────────────────────────────
  const amount = Number(amountUsdc);
  if (!(amount > 0)) {
    return json(400, { error: "Provide a positive number 'amountUsdc'" });
  }

  const walletAddress = process.env.AGENT_WALLET_ADDRESS;
  if (!walletAddress) {
    return json(400, { error: "AGENT_WALLET_ADDRESS not set — run agent-init." });
  }

  // ── Spend guard ─────────────────────────────────────────────────────────────
  const maxSpend = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
  if (amount > maxSpend) {
    return json(200, {
      executed: false,
      blocked: `amount ${amount} exceeds AGENT_MAX_SPEND_USDC (${maxSpend})`,
    });
  }

  // Track which on-chain step is in flight so a Circle 400 can be attributed
  // to approve vs deposit (both use the same SDK call shape). Declared outside
  // the try so the catch block can read it.
  let step = "approve";

  try {
    const circleClient = circle();
    const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();

    // 1. Approve the Gateway Wallet to pull the deposit from the agent wallet.
    const approveTx = await circleClient.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [GATEWAY.WALLET, units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const approveHash = await waitForTx(circleClient, approveTx.data?.id);

    // 2. Deposit USDC into the Gateway Wallet — credits the unified balance.
    step = "deposit";
    const depositTx = await circleClient.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: GATEWAY.WALLET,
      abiFunctionSignature: "deposit(address,uint256)",
      abiParameters: [CONTRACTS.USDC, units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const depositHash = await waitForTx(circleClient, depositTx.data?.id);

    return json(200, {
      executed: true,
      deposit: { amountUsdc: amount, depositor: walletAddress },
      tx: {
        approve: `${ARC.explorer}/tx/${approveHash}`,
        deposit: `${ARC.explorer}/tx/${depositHash}`,
      },
    });
  } catch (e) {
    // A still-pending tx is submitted-but-slow, not failed — report 202 with the
    // id so callers can poll rather than treat it as an error.
    if (e instanceof TxPendingError) {
      return json(202, { executed: true, pending: true, txId: e.txId, error: e.message });
    }

    // The Circle SDK throws axios errors. The useful detail (code, message, and
    // per-field `errors`) lives in e.response.data, which a bare e.message
    // ("Request failed with status code 400") swallows. Surface it so we can see
    // WHICH step failed and WHY.
    const status = e.response?.status;
    const detail = e.response?.data ?? null;
    console.error(
      `gateway-deposit failed at step="${step}" status=${status ?? "?"}:`,
      JSON.stringify(detail) || e.message
    );

    return json(status && status < 500 ? 400 : 500, {
      executed: false,
      step,
      error: e.message,
      circleStatus: status,
      // Full Circle payload — includes code/message and any field-level errors.
      circleError: detail,
    });
  }
}
