import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { ARC, CONTRACTS, USDC_DECIMALS, json, parseBody, maxSpendUsdc, dateAnchor } from "./_arc.mjs";

// POST /api/agent-act { task: string }
//
// The autonomous loop, pattern 1+2:
//   1. The agent's Claude brain reads the task and returns a STRUCTURED decision.
//   2. We validate the decision against an allow-list and a spend guard.
//   3. Only then does the dev-controlled SCA wallet execute on-chain (gas
//      sponsored by Gas Station). The agent spends ITS OWN treasury — it never
//      pulls from a user's wallet (that needs session keys, not yet GA).
//
// The brain decides; this function — not the model — enforces what is allowed.

const SYSTEM_PROMPT = `You are Tikpema's autonomous on-chain agent on Arc Testnet.
You control your own developer-controlled smart-account wallet and may act with its funds only.
Given a task, respond with ONLY a JSON object, no prose, no markdown fences:
{
  "action": "transfer_usdc" | "none",
  "to": "0x... (required if action is transfer_usdc)",
  "amountUsdc": number (required if action is transfer_usdc),
  "reasoning": "one sentence"
}
Choose "none" if the task is unclear, unsafe, or not a transfer.`;

async function decide(task) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
  const model = process.env.AGENT_MODEL || "claude-haiku-4-5-20251001";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: `${SYSTEM_PROMPT}\n\n${dateAnchor()}`,
      messages: [{ role: "user", content: task }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic call failed");

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();

  try {
    return JSON.parse(text);
  } catch {
    return { action: "none", reasoning: "Brain returned unparseable output" };
  }
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { task } = parseBody(event);
  if (!task) return json(400, { error: "Provide a 'task' string" });

  const walletAddress = process.env.AGENT_WALLET_ADDRESS;
  if (!walletAddress) {
    return json(400, { error: "AGENT_WALLET_ADDRESS not set — run agent-init." });
  }

  try {
    // 1. Brain decides.
    const decision = await decide(task);

    if (decision.action !== "transfer_usdc") {
      return json(200, { executed: false, decision });
    }

    // 2. Guard rails — enforced HERE, not by the model.
    const maxSpend = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
    const amount = Number(decision.amountUsdc);
    const to = String(decision.to || "");

    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      return json(200, { executed: false, decision, blocked: "invalid recipient" });
    }
    if (!(amount > 0) || amount > maxSpend) {
      return json(200, {
        executed: false,
        decision,
        blocked: `amount ${amount} exceeds AGENT_MAX_SPEND_USDC (${maxSpend})`,
      });
    }

    // 3. Execute: agent's own SCA wallet transfers USDC (gas sponsored).
    const client = circle();
    const units = BigInt(Math.round(amount * 10 ** USDC_DECIMALS)).toString();

    const tx = await client.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.USDC,
      abiFunctionSignature: "transfer(address,uint256)",
      abiParameters: [to, units],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txHash = await waitForTx(client, tx.data?.id);

    return json(200, {
      executed: true,
      decision,
      tx: `${ARC.explorer}/tx/${txHash}`,
    });
  } catch (e) {
    // A still-pending tx is submitted-but-slow, not failed: report it as
    // accepted with its id so callers can poll rather than treat it as an error.
    if (e instanceof TxPendingError) {
      return json(202, { executed: true, pending: true, txId: e.txId, error: e.message });
    }
    return json(500, { error: e.message });
  }
}
