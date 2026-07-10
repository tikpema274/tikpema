import { parseBody, json, dateAnchor } from "./_arc.mjs";

// plan-quote.mjs — price an ACTION-PLANNING task before it runs.
//
// The sibling of job-quote.mjs, with a DIFFERENT guardrail. Same contract:
//   Input  (POST): { task }
//   Output: { declined:false, budgetUsdc, reasoning } | { declined:true, reason }
// Stateless, unauthenticated, moves no money — it only prices.
//
// ══ WHY A SEPARATE CLASSIFIER ══════════════════════════════════════════════════
// job-quote declines anything that reads as personal advice ("should I…"), because a
// research brief must have a sourceable factual answer. That is the right rule for
// research and the WRONG rule here: an action plan is, by construction, a
// recommendation about what to do.
//
// So this flow is ADVICE-PERMISSIVE — but only for advice the system can BOUND, PRICE,
// and REFUSE. The line is EXECUTABILITY, not opinion:
//   • "bridge some USDC to Base"        → a concrete action. The server resolves the
//                                          destination against an 8-chain registry,
//                                          bounds the amount by the deployed cap, prices
//                                          the fee live, and refuses it outright if the
//                                          fee would eat the amount. ACCEPT.
//   • "what's the best chain?"          → unbounded opinion. Nothing to price, nothing to
//                                          refuse, no action to approve. DECLINE.
//
// The guardrail is NOT "no advice". It is "no advice we cannot bound, price, and refuse."
// Downstream, `validateProposal` enforces that in code: it returns null for any proposal
// it cannot resolve, bound, or price, and a null proposal renders as a brief with no
// approve button. The model cannot recommend the unrecommendable.
//
// ⚠️ HONEST LIMIT (surfaced in the UI, not hidden): validateProposal checks that a
// proposal is well-FORMED and ECONOMICAL — never that it is well-REASONED. A model may
// propose an economically valid bridge for a bad reason. Brick 1's mitigation is human:
// the proposal card shows the agent's reasoning prominently so the USER can judge what
// the system cannot. A reasoning/vetting gate is a slotted future brick.

const SYSTEM_PROMPT = `You are pricing an ACTION-PLANNING task for an AI agent that can execute on-chain actions.

The agent researches the real economics of an action, then proposes a concrete plan the USER approves before anything executes. It is allowed — expected — to make a recommendation. What it cannot do is answer an unbounded opinion question.

First, CLASSIFY the task. The test is EXECUTABILITY: can this resolve into a concrete, checkable action the agent could bound, price, and either execute or refuse?

- ACCEPT if it describes an on-chain action, even loosely, even as a question:
  "bridge some USDC to Base", "move 5 USDC to Arbitrum", "should I bridge to Optimism or
  stay on Arc?", "what would it cost to move funds to Base and is it worth it?".
  These name an action whose economics can be researched and whose parameters the server
  can bound and price. Asking "should I" is FINE here — the agent proposes, the user decides.
  The only supported action today is bridging USDC off Arc to: Ethereum, Base, Arbitrum,
  Optimism, Avalanche, Polygon, Unichain, or Linea (all testnets).

- DECLINE if there is no executable action to bound:
  "what's the best chain?", "what should I invest in?", "is crypto a good idea?",
  "which token will go up?". These are opinion with nothing to price, nothing to refuse,
  and nothing to approve. Also DECLINE actions the agent cannot perform (swapping to an
  arbitrary token, anything off the supported-destination list, anything not on-chain).
  When declining, say plainly that it needs a concrete action, and give one example of a
  task that would work. Keep any example amount SMALL (a few USDC) — the agent enforces a
  per-bridge cap and would refuse a large one, so never suggest an amount you cannot know
  is allowed.

Then, for ACCEPTED tasks, assess research complexity: how much source-gathering and
synthesis is needed to reason honestly about the action's economics.

Return ONLY a JSON object, with no markdown, no fences, and no preamble:
- if accepted: {"declined": false, "budgetUsdc": <number between 0.20 and 0.60>, "reasoning": "<one short sentence>"}
- if declined: {"declined": true, "reason": "<one sentence: what's missing, plus one concrete example that would work>"}

You may use up to 2 decimal places for budgetUsdc (e.g. 0.25, 0.40) — do not restrict yourself to whole numbers.`;

async function callAnthropic(apiKey, model, messages) {
  const system = `${SYSTEM_PROMPT}\n\n${dateAnchor()}`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 256, system, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic call failed");
  return data;
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  const { task } = parseBody(event);
  if (!task || !String(task).trim()) return json(400, { error: "task required" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(400, { error: "Missing ANTHROPIC_API_KEY (server env)" });
  const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";

  const data = await callAnthropic(apiKey, model, [{ role: "user", content: String(task) }]);
  const text = (data.content?.[0]?.text || "").replace(/```json|```/g, "").trim();

  let quote;
  try {
    quote = JSON.parse(text);
  } catch {
    // FAIL CLOSED — and note this DIFFERS from job-quote, which falls back to a default
    // budget and prices the job anyway. Accepting here means spending the user's USDC to
    // run a flow that can end in a proposal to move MORE of it. An unreadable classifier
    // verdict is not permission; refuse and let them rephrase.
    return json(200, {
      declined: true,
      reason: "Could not classify that task. Describe a concrete on-chain action — for example, \"bridge 2 USDC to Base\".",
    });
  }

  if (quote.declined === true) {
    return json(200, {
      declined: true,
      reason:
        quote.reason ||
        "That needs a concrete on-chain action the agent can price and execute — for example, \"bridge 2 USDC to Base\".",
    });
  }

  // Accepted: validate + clamp to the same contracted [0.20, 0.60] range as job-quote.
  let budgetUsdc = Number(quote.budgetUsdc);
  if (!Number.isFinite(budgetUsdc)) budgetUsdc = 0.3;
  budgetUsdc = Math.min(0.6, Math.max(0.2, budgetUsdc));
  budgetUsdc = Math.round(budgetUsdc * 100) / 100;

  return json(200, { declined: false, budgetUsdc, reasoning: quote.reasoning || "action plan" });
}
