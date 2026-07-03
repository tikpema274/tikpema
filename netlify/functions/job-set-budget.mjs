import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, json, parseBody } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";

// POST /api/job-set-budget { jobId: number|string, budgetUsdc: number }
//
// EXECUTES. The agent's dev-controlled SCA wallet (the job's provider) sets the
// budget on an ERC-8183 job via setBudget(jobId, amount, optParams) on the
// AgenticCommerce contract (gas sponsored by Gas Station). One on-chain step.
// Writes go through Circle (_circle.mjs). Reads are not needed here.

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  // Auth gate: setting a job budget signs an agent-wallet tx — require a session.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { jobId, budgetUsdc } = parseBody(event);

  // ── Input validation ────────────────────────────────────────────────────
  if (jobId === undefined || jobId === null) {
    return json(400, { error: "Provide 'jobId'" });
  }
  if (budgetUsdc === undefined || budgetUsdc === null) {
    return json(400, { error: "Provide 'budgetUsdc'" });
  }

  const walletAddress = process.env.AGENT_WALLET_ADDRESS;
  if (!walletAddress) {
    return json(400, { error: "AGENT_WALLET_ADDRESS not set — run agent-init." });
  }

  try {
    // ── Execute: setBudget ────────────────────────────────────────────────
    const circleClient = circle();
    const units = BigInt(Math.round(budgetUsdc * 10 ** USDC_DECIMALS)).toString();

    const tx = await circleClient.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.AGENTIC_COMMERCE,
      abiFunctionSignature: "setBudget(uint256,uint256,bytes)",
      abiParameters: [String(jobId), units, "0x"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const hash = await waitForTx(circleClient, tx.data?.id);

    return json(200, {
      jobId,
      budget: budgetUsdc,
      tx: `${ARC.explorer}/tx/${hash}`,
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
