import { connectLambda } from "@netlify/blobs";
import { json, parseBody, sendCapUsdc } from "./_arc.mjs";
import { executeAction, valueOfStep } from "./_actions.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { daySpend, budgetConfig } from "./_budget.mjs";

// POST /api/agent-execute-plan { plan: [ {type, ...}, ... ] }
//
// Executes a confirmed multi-step plan on the agent's SCA wallet. This is turn 2
// of the plan->confirm->execute flow: the client holds the plan from turn 1
// (agent-act returned it with needsConfirm) and POSTs it here after the user
// confirms. The server is stateless; the plan travels in the request.
//
// GUARDRAILS THAT HOLD ACROSS THE CHAIN (the whole point of this endpoint):
//   - PER-ACTION cap: every step's USD value ≤ sendCapUsdc(), checked before the
//     step runs. Applies to ALL step types (transfer/swap/pay), not just sends.
//   - CUMULATIVE day-ceiling: the plan's spend accumulates on top of what the
//     agent already spent today and is bounded by PERIOD_CEILING_USDC. This is
//     the CHAINED-DRAIN guard — many small steps that each pass the per-action
//     cap still cannot COLLECTIVELY exceed the daily bound. Critically, the
//     running total is tracked IN MEMORY across the loop: Netlify Blobs is
//     eventually consistent (~11s), so a step's ledger write is NOT visible to
//     the next step's store read within this fast loop — relying on canSpendDay's
//     store read alone would let a chained plan blow past the ceiling. We seed a
//     one-time baseline from the store (prior requests) and decrement in memory.
//   - STOP-ON-LIMIT: the first step that would breach a cap/ceiling STOPS the
//     plan there — recorded, no execution, no silent skip-and-continue, no
//     partial-drain beyond the steps that already ran. No rollback (on-chain).
//   - Batched settlement: a pay_for_service step settles in a Gateway batch on a
//     delay, so executeAction returns state "submitted" (via _pay's 1098 catch),
//     NOT a confirmed on-chain success. We treat "submitted" as success and
//     continue, but record each step's real state so the report is honest about
//     what's settled vs still batching.
export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (event.blobs) connectLambda(event); // Blobs for the budget-spine day ledger

  // Auth gate: only an authenticated session may execute an agent-spend plan.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { plan } = parseBody(event);
  if (!Array.isArray(plan) || plan.length === 0) {
    return json(400, { error: "Provide a non-empty 'plan' array" });
  }

  // Resolve the caller's OWN agent wallet from the session (never client-supplied,
  // never the shared env wallet).
  const owner = await ensureOwnerWallet(session);
  if (owner.pending) {
    return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  }
  const walletAddress = owner.walletAddress;
  const actx = { walletAddress, session };

  // ── Value every step up front (for the total + to fail fast on an unvaluable
  //    step). Values are USD: transfer/pay face value; swap = USD of the input. ─
  const atomic = (usdc) => Math.round(Number(usdc) * 1e6); // micro-USDC (no float drift)
  const usd2 = (usdc) => (Math.round(Number(usdc) * 100) / 100).toFixed(2);

  let totalUsdc = 0;
  const values = [];
  try {
    for (const step of plan) {
      const v = await valueOfStep(step);
      values.push(v);
      totalUsdc += v;
    }
  } catch (e) {
    return json(200, { executed: false, blocked: `cannot value plan: ${e.message}` });
  }

  // ── Cap config ────────────────────────────────────────────────────────────
  const cap = sendCapUsdc();                       // per-action cap (e.g. 10)
  const capA = atomic(cap);
  const ceiling = budgetConfig().PERIOD_CEILING_USDC; // cumulative daily bound
  const ceilingA = atomic(ceiling);

  // Cumulative baseline: what THIS user's wallet has ALREADY spent today (prior
  // sends/plans/research), read ONCE from the store — keyed to their own wallet,
  // so the chained-drain guard bounds THIS user's daily budget, not a shared one.
  // The plan's spend accumulates on top of this IN MEMORY (runningA), so the
  // ceiling holds across the chain even though this loop's own ledger writes
  // haven't propagated back to store reads. executeAction ledgers against the
  // same owner (walletAddress), so the baseline and the writes stay consistent.
  const baselineA = atomic(await daySpend({ owner: walletAddress }));

  // ── Execute in order; STOP at the first cap/ceiling breach or failure ──────
  const results = [];
  let stoppedAt = null;
  let runningA = 0;                                // micro-USDC committed by THIS plan

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const vA = atomic(values[i]);

    // (1) PER-ACTION cap — each step, any type. Stop here, never skip-and-continue.
    if (vA > capA) {
      results.push({ index: i, step, ok: false, blocked: `step ~${usd2(values[i])} exceeds per-transaction limit of ${cap} USDC` });
      stoppedAt = i;
      break;
    }

    // (2) CUMULATIVE day-ceiling — authoritative in-memory running total. THIS is
    //     the chained-drain guard: small steps that each pass (1) still cannot
    //     collectively exceed the daily bound. Checked BEFORE the step executes,
    //     so an over-ceiling step never moves funds.
    if (baselineA + runningA + vA > ceilingA) {
      results.push({
        index: i,
        step,
        ok: false,
        blocked: `would exceed daily agent-spend ceiling of ${ceiling} USDC (already committed ~${usd2((baselineA + runningA) / 1e6)} today)`,
        dayCeiling: true,
      });
      stoppedAt = i;
      break;
    }

    // (3) Execute via the ONE shared executor (re-checks shape/send-cap/day + ledgers).
    try {
      const r = await executeAction(step, actx);
      if (!r.ok) {
        results.push({ index: i, step, ok: false, blocked: r.blocked });
        stoppedAt = i;
        break;
      }
      // Success (may be confirmed OR submitted-in-batch). Record real state.
      const state =
        r.pay?.state || r.swap?.state || (r.tx ? "completed" : "submitted");
      results.push({ index: i, step, ok: true, kind: r.kind, state, swap: r.swap, pay: r.pay, tx: r.tx });
      runningA += vA;                              // commit: decrement remaining daily budget
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
    ceiling,
    stoppedAt,          // null if all ran; else the index that stopped the plan
    stepsRun: results.filter((r) => r.ok).length,
    stepsTotal: plan.length,
    results,
  });
}
