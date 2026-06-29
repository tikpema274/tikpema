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
  "action": "transfer_usdc" | "needs_confirmation" | "none",
  "to": "0x... (required if action is transfer_usdc)",
  "amountUsdc": number (required if action is transfer_usdc),
  "unmetCondition": "string (required if action is needs_confirmation) — the part of the task you cannot fulfill",
  "reasoning": "one sentence"
}
Choose "none" if the task is unclear, unsafe, or not a transfer.
You can ONLY execute an immediate USDC transfer. You CANNOT schedule payments for a future time, set up recurring/conditional payments, or wait.
If a task asks for a transfer but attaches a condition you cannot fulfil — a specific time ("at 23.25", "tonight", "in an hour"), a recurring schedule, or a trigger ("when X happens") — you MUST choose action "needs_confirmation", put the unfulfillable part in "unmetCondition", and do NOT choose transfer_usdc. Only choose transfer_usdc when the transfer is unconditional and can run right now.`;

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

    // The agent cannot schedule or condition payments. If the brain flagged an
    // unfulfillable condition, stop and ask — never silently drop it and send.
    if (decision.action === "needs_confirmation") {
      return json(200, {
        executed: false,
        decision,
        needsConfirmation: true,
        message:
          `I can only send USDC immediately — I can't schedule or set conditions. ` +
          `This task asked for: "${decision.unmetCondition || "a condition I can't fulfil"}". ` +
          `Resend the task without that part if you'd like me to send now.`,
      });
    }

    // Backstop: even if the brain chose transfer_usdc, refuse if the raw task
    // contains a scheduling/conditional cue the agent cannot honor. The model is
    // the first classifier; this is the code not trusting a silent drop.
    if (decision.action === "transfer_usdc") {
      const schedulePattern =
        /\b((at|by)\s+(\d{1,2}([:.]\d{1,2})?\s*(am|pm)?|noon|midnight|midday|morning|afternoon|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tonight|tomorrow|later|in \d+\s*(min|minute|hour|hr|day)|every|when|after|before|schedule|recurring|daily|weekly)\b/i;
      if (schedulePattern.test(task)) {
        return json(200, {
          executed: false,
          decision,
          needsConfirmation: true,
          message:
            `This task looks like it has a time or condition ("${task}"). ` +
            `I can only send USDC immediately, so I've held off. ` +
            `Resend without the timing if you want it sent now.`,
        });
      }
    }

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
