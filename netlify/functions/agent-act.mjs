import { TxPendingError } from "./_circle.mjs";
import { json, parseBody, dateAnchor } from "./_arc.mjs";
import { SWAP_TOKENS } from "./_swap.mjs";
import { executeAction, valueOfStep } from "./_actions.mjs";

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
  "action": "transfer_usdc" | "swap_tokens" | "pay_for_service" | "plan" | "needs_confirmation" | "none",
  "to": "0x... (required if action is transfer_usdc)",
  "amountUsdc": number (required if action is transfer_usdc),
  "tokenIn": "USDC | EURC (required if action is swap_tokens)",
  "tokenOut": "USDC | EURC (required if action is swap_tokens)",
  "amountIn": number (required if action is swap_tokens),
  "payTo": "0x... (required if action is pay_for_service)",
  "payAmountUsdc": number (required if action is pay_for_service),
  "steps": [ { "type": "transfer_usdc"|"swap_tokens"|"pay_for_service", ...that action's fields } ] (required if action is plan; 2+ ordered steps),
  "unmetCondition": "string (required if action is needs_confirmation) — the part of the task you cannot fulfill",
  "reasoning": "one sentence"
}
Choose "none" if the task is unclear, unsafe, or not a transfer.
You can execute immediate USDC transfers and same-chain token swaps. You CANNOT schedule payments for a future time, set up recurring/conditional payments, or wait.
If a task asks for a transfer but attaches a condition you cannot fulfil — a specific time ("at 23.25", "tonight", "in an hour"), a recurring schedule, or a trigger ("when X happens") — you MUST choose action "needs_confirmation", put the unfulfillable part in "unmetCondition", and do NOT choose transfer_usdc. Only choose transfer_usdc when the transfer is unconditional and can run right now.
For a swap (e.g. "swap 5 USDC to EURC", "convert 2 EURC into USDC"), choose action "swap_tokens" with tokenIn, tokenOut, and amountIn. Only these tokens are supported: USDC, EURC. tokenIn and tokenOut must differ.
A plain "send/pay X USDC to 0x..." is a transfer_usdc (your regular balance). Choose "pay_for_service" ONLY when the task explicitly says to pay FROM the Gateway / unified balance, or to pay FOR a service, with payTo and payAmountUsdc. When unsure between the two, prefer transfer_usdc.
If a task asks for MULTIPLE actions in sequence (e.g. "swap 2 USDC to EURC then pay 1 USDC to 0x...", "send A then swap B"), choose action "plan" with an ordered "steps" array, each step being one transfer_usdc/swap_tokens/pay_for_service with that action's own fields. Use plan ONLY for genuinely multi-action tasks; a single action stays its own action. A multi-step task is NOT a needs_confirmation — needs_confirmation is only for scheduling/conditional/timing you cannot fulfil.`;

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

    // Multi-step: propose a plan for confirmation (does NOT execute here).
    // The client holds the returned plan and POSTs it to agent-execute-plan
    // after the user confirms. Total cap is checked here so we never offer an
    // over-cap plan; the executor re-checks it authoritatively at run time.
    if (decision.action === "plan") {
      const steps = Array.isArray(decision.steps) ? decision.steps : [];
      if (steps.length < 2) {
        return json(200, { executed: false, decision, blocked: "a plan needs 2+ steps" });
      }
      const KINDS = new Set(["transfer_usdc", "swap_tokens", "pay_for_service"]);
      for (const s of steps) {
        if (!KINDS.has(s?.type)) {
          return json(200, { executed: false, decision, blocked: `unknown step type "${s?.type}"` });
        }
      }
      const maxSpendPlan = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
      let totalUsdc = 0;
      try {
        for (const s of steps) totalUsdc += await valueOfStep(s);
      } catch (e) {
        return json(200, { executed: false, decision, blocked: `cannot value plan: ${e.message}` });
      }
      if (totalUsdc > maxSpendPlan) {
        return json(200, {
          executed: false,
          decision,
          blocked: `plan total ~${totalUsdc.toFixed(2)} exceeds AGENT_MAX_SPEND_USDC (${maxSpendPlan})`,
        });
      }
      return json(200, {
        executed: false,
        needsConfirm: true,
        decision,
        plan: steps,
        totalUsdc,
        message: `This is a ${steps.length}-step plan totaling ~${totalUsdc.toFixed(2)}. Confirm to execute.`,
      });
    }

    // Backstop: even if the brain chose transfer_usdc, refuse if the raw task
    // contains a scheduling/conditional cue the agent cannot honor. The model is
    // the first classifier; this is the code not trusting a silent drop.
    if (decision.action === "transfer_usdc" || decision.action === "swap_tokens") {
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

    if (decision.action === "swap_tokens") {
      const tokenIn = String(decision.tokenIn || "").toUpperCase();
      const tokenOut = String(decision.tokenOut || "").toUpperCase();
      const amountIn = Number(decision.amountIn);
      const step = { type: "swap_tokens", tokenIn, tokenOut, amountIn };

      // Shape guards stay explicit so cap valuation only runs on a supported
      // token, and a bad token blocks with its own message (not a value error).
      const VALID = SWAP_TOKENS.map((t) => t.toUpperCase());
      if (!VALID.includes(tokenIn) || !VALID.includes(tokenOut)) {
        return json(200, { executed: false, decision, blocked: "unsupported token (USDC/EURC only)" });
      }
      if (tokenIn === tokenOut) {
        return json(200, { executed: false, decision, blocked: "tokenIn and tokenOut must differ" });
      }
      const maxSpend = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
      if (!(amountIn > 0)) {
        return json(200, { executed: false, decision, blocked: "amountIn must be > 0" });
      }
      // Spend cap stays HERE (the caller owns the cap). Cap on USD VALUE of the
      // input, not raw token units (EURC ~$1.14, so unit-capping would
      // under-count). Fail-safe: if we can't value it, block.
      let usdValue;
      try {
        usdValue = await valueOfStep(step);
      } catch (e) {
        return json(200, { executed: false, decision, blocked: `cannot value ${tokenIn}: ${e.message}` });
      }
      if (usdValue > maxSpend) {
        return json(200, {
          executed: false,
          decision,
          blocked: `swap value ~${usdValue.toFixed(2)} exceeds AGENT_MAX_SPEND_USDC (${maxSpend})`,
        });
      }

      const r = await executeAction(step, { walletAddress });
      if (!r.ok) return json(200, { executed: false, decision, blocked: r.blocked });
      return json(200, { executed: true, decision, swap: r.swap, tx: r.tx });
    }

    if (decision.action === "pay_for_service") {
      const payTo = String(decision.payTo || "");
      const payAmount = Number(decision.payAmountUsdc);
      const step = { type: "pay_for_service", payTo, payAmountUsdc: payAmount };
      const maxSpendPay = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
      if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
        return json(200, { executed: false, decision, blocked: "invalid payTo address" });
      }
      if (!(payAmount > 0)) {
        return json(200, { executed: false, decision, blocked: "payAmountUsdc must be > 0" });
      }
      if (payAmount > maxSpendPay) {
        return json(200, { executed: false, decision, blocked: "payAmountUsdc " + payAmount + " exceeds AGENT_MAX_SPEND_USDC (" + maxSpendPay + ")" });
      }
      const r = await executeAction(step, { walletAddress });
      if (!r.ok) return json(200, { executed: false, decision, blocked: r.blocked });
      return json(200, { executed: true, decision, pay: r.pay });
    }
    if (decision.action !== "transfer_usdc") {
      return json(200, { executed: false, decision });
    }

    // 2. Guard rails — enforced HERE, not by the model.
    const maxSpend = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
    const amount = Number(decision.amountUsdc);
    const to = String(decision.to || "");
    const step = { type: "transfer_usdc", to, amountUsdc: amount };

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

    // 3. Execute: agent's own SCA wallet transfers USDC (gas sponsored). A still-
    // pending tx surfaces as a TxPendingError that executeAction lets propagate,
    // so the outer catch can map it to 202 (unchanged behavior).
    const r = await executeAction(step, { walletAddress });
    if (!r.ok) return json(200, { executed: false, decision, blocked: r.blocked });
    return json(200, { executed: true, decision, tx: r.tx });
  } catch (e) {
    // A still-pending tx is submitted-but-slow, not failed: report it as
    // accepted with its id so callers can poll rather than treat it as an error.
    if (e instanceof TxPendingError) {
      return json(202, { executed: true, pending: true, txId: e.txId, error: e.message });
    }
    return json(500, { error: e.message });
  }
}
