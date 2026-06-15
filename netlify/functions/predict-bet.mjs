import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, json, parseBody } from "./_arc.mjs";
import { publicClient, readMarket, isBettable } from "./_predict.mjs";

// POST /api/predict-bet { marketId: number, isYes: boolean, amountUsdc: number }
//
// EXECUTES. The agent's dev-controlled SCA wallet stakes its OWN USDC on a
// market (gas sponsored by Gas Station). Two on-chain steps: approve the
// prediction contract to pull USDC, then placeBet.
//
// Guards are enforced HERE, not by any model:
//   - market must exist, be OPEN, and be before its betting deadline
//   - amountUsdc must be > 0 and <= AGENT_MAX_SPEND_USDC
// Reads come from the public RPC (_predict.mjs); writes go through Circle
// (_circle.mjs). The brain in predict-analyze.mjs only advises — this is where
// a human/caller commits funds with explicit parameters.

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { marketId, isYes, amountUsdc } = parseBody(event);

  // ── Input validation ────────────────────────────────────────────────────
  if (marketId === undefined || marketId === null || !Number.isInteger(Number(marketId)) || Number(marketId) < 0) {
    return json(400, { error: "Provide a non-negative integer 'marketId'" });
  }
  if (typeof isYes !== "boolean") {
    return json(400, { error: "Provide a boolean 'isYes' (true = YES, false = NO)" });
  }
  const amount = Number(amountUsdc);
  if (!(amount > 0)) {
    return json(400, { error: "Provide a positive number 'amountUsdc'" });
  }

  const walletAddress = process.env.AGENT_WALLET_ADDRESS;
  if (!walletAddress) {
    return json(400, { error: "AGENT_WALLET_ADDRESS not set — run agent-init." });
  }

  // ── Spend guard ─────────────────────────────────────────────────────────
  const maxSpend = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
  if (amount > maxSpend) {
    return json(200, {
      executed: false,
      blocked: `amount ${amount} exceeds AGENT_MAX_SPEND_USDC (${maxSpend})`,
    });
  }

  try {
    // ── Market guard (read on-chain, compare to chain time) ───────────────
    const client = publicClient();
    const [snapshot, block] = await Promise.all([
      readMarket(client, marketId),
      client.getBlock(),
    ]);

    if (!snapshot) {
      return json(404, { error: `Market #${marketId} not found` });
    }
    const now = Number(block.timestamp);
    if (!isBettable(snapshot, now)) {
      return json(200, {
        executed: false,
        market: snapshot,
        blocked:
          snapshot.statusCode !== 0
            ? `market is ${snapshot.status}, not OPEN`
            : `betting deadline passed (deadline ${snapshot.bettingDeadline}, now ${now})`,
      });
    }

    // ── Execute: approve, then placeBet ───────────────────────────────────
    const circleClient = circle();
    const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();

    // 1. Approve the prediction contract to pull the stake from the agent wallet.
    const approveTx = await circleClient.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [CONTRACTS.TIKPEMA_PREDICTION, units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const approveHash = await waitForTx(circleClient, approveTx.data?.id);

    // 2. Place the bet.
    const betTx = await circleClient.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.TIKPEMA_PREDICTION,
      abiFunctionSignature: "placeBet(uint256,bool,uint256)",
      abiParameters: [String(marketId), isYes, units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const betHash = await waitForTx(circleClient, betTx.data?.id);

    return json(200, {
      executed: true,
      market: snapshot,
      bet: { marketId: Number(marketId), isYes, amountUsdc: amount },
      tx: {
        approve: `${ARC.explorer}/tx/${approveHash}`,
        placeBet: `${ARC.explorer}/tx/${betHash}`,
      },
    });
  } catch (e) {
    // A still-pending tx is submitted-but-slow, not failed — report 202 with
    // the id so callers can poll rather than treat it as an error.
    if (e instanceof TxPendingError) {
      return json(202, { executed: true, pending: true, txId: e.txId, error: e.message });
    }
    return json(500, { error: e.message });
  }
}
