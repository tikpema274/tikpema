import { json, parseBody } from "./_arc.mjs";
import { executeAction, valueOfStep } from "./_actions.mjs";
import { requireSession } from "./_auth.mjs";

// POST /api/agent-execute-plan { plan: [ {type, ...}, ... ] }
//
// Executes a confirmed multi-step plan on the agent's SCA wallet. This is turn 2
// of the plan->confirm->execute flow: the client holds the plan from turn 1
// (agent-act returned it with needsConfirm) and POSTs it here after the user
// confirms. The server is stateless; the plan travels in the request.
//
// Design (decisions locked earlier):
//   - TOTAL cap: sum the USD value of ALL steps, check against the cap ONCE,
//     before executing any. If the total exceeds the cap, nothing runs.
//   - STOP-ON-FAILURE: run steps in order; on the first failure, stop and
//     report which completed and which didn't. No rollback (on-chain can't).
//   - Batched settlement: a pay_for_service step settles in a Gateway batch on a
//     delay, so executeAction returns state "submitted" (via _pay's 1098 catch),
//     NOT a confirmed on-chain success. We treat "submitted" as success and
//     continue, but record each step's real state so the report is honest about
//     what's settled vs still batching.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

  // Auth gate: only an authenticated session may execute an agent-spend plan.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { plan } = parseBody(event);
  if (!Array.isArray(plan) || plan.length === 0) {
    return json(400, { error: "Provide a non-empty 'plan' array" });
  }

  const walletAddress = process.env.AGENT_WALLET_ADDRESS;
  if (!walletAddress) {
    return json(400, { error: "AGENT_WALLET_ADDRESS not set — run agent-init." });
  }

  // ── Total-cap check (once, before any execution) ──────────────────────────
  const maxSpend = Number(process.env.AGENT_MAX_SPEND_USDC || "1");
  let totalUsdc = 0;
  try {
    for (const step of plan) {
      totalUsdc += await valueOfStep(step);
    }
  } catch (e) {
    return json(200, { executed: false, blocked: `cannot value plan: ${e.message}` });
  }
  if (totalUsdc > maxSpend) {
    return json(200, {
      executed: false,
      totalUsdc,
      blocked: `plan total ~${totalUsdc.toFixed(2)} exceeds AGENT_MAX_SPEND_USDC (${maxSpend})`,
    });
  }

  // ── Execute in order, stop on first failure ───────────────────────────────
  const results = [];
  let stoppedAt = null;

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    try {
      const r = await executeAction(step, { walletAddress });
      if (!r.ok) {
        results.push({ index: i, step, ok: false, blocked: r.blocked });
        stoppedAt = i;
        break;
      }
      // Success (may be confirmed OR submitted-in-batch). Record real state.
      const state =
        r.pay?.state || r.swap?.state || (r.tx ? "completed" : "submitted");
      results.push({ index: i, step, ok: true, kind: r.kind, state, swap: r.swap, pay: r.pay, tx: r.tx });
    } catch (e) {
      // A thrown error (incl. TxPendingError) stops the plan. Record and halt.
      results.push({ index: i, step, ok: false, error: e.message, pending: e.name === "TxPendingError" });
      stoppedAt = i;
      break;
    }
  }

  const allOk = stoppedAt === null;
  return json(200, {
    executed: true,
    completed: allOk,
    totalUsdc,
    stoppedAt,          // null if all ran; else the index that failed
    stepsRun: results.length,
    stepsTotal: plan.length,
    results,
  });
}
