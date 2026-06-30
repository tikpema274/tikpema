import { json, parseBody } from "./_arc.mjs";
import { agentPay } from "./_pay.mjs";

// POST /api/pay-service { recipientAddress, amountUsdc }
// Standalone proof of the delegate-signed Gateway spend. Guards enforced HERE,
// not by any model. Later wired into agent-act as a "pay_for_service" action.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { recipientAddress, amountUsdc } = parseBody(event);

  if (!recipientAddress || !/^0x[a-fA-F0-9]{40}$/.test(recipientAddress)) {
    return json(400, { error: "Provide a valid recipientAddress (0x...)" });
  }
  const amount = Number(amountUsdc);
  if (!(amount > 0)) {
    return json(400, { error: "Provide a positive amountUsdc" });
  }
  const maxSpend = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
  if (amount > maxSpend) {
    return json(200, {
      executed: false,
      blocked: `amount ${amount} exceeds AGENT_MAX_SPEND_USDC (${maxSpend})`,
    });
  }

  try {
    const pay = await agentPay({ recipientAddress, amountUsdc: amount.toFixed(2) });
    return json(200, { executed: true, pay });
  } catch (e) {
    return json(500, { executed: false, error: e.message });
  }
}
