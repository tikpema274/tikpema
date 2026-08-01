import { json, parseBody, sendCapUsdc, bridgeCapUsdc } from "./_arc.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { executeAction, valueOfStep } from "./_actions.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { daySpend, budgetConfig } from "./_budget.mjs";
import { recordBridge } from "./_bridge-record.mjs";
import { resolveDestination, bridgeFee, bridgeFeeBand, bridgeAckToken } from "./_bridge.mjs";
import { safeQuoteId } from "./_quote-record.mjs";

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
  if (event.blobs) connectBlobs(event); // Blobs for the budget-spine day ledger

  // Auth gate: only an authenticated session may execute an agent-spend plan.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { plan, ackTokens, quoteId: rawQuoteId } = parseBody(event); // ackTokens: { [stepIndex]: token }
  if (!Array.isArray(plan) || plan.length === 0) {
    return json(400, { error: "Provide a non-empty 'plan' array" });
  }

  // ── THE JOIN KEY, AND EXACTLY WHAT IT IS WORTH ────────────────────────────────────────
  // `quoteId` names the priced plan agent-act recorded (store `agent-quotes`). It rides on
  // every bridge receipt this run produces, which is what makes "proposed vs ran" one lookup
  // instead of a reconstruction from a screenshot.
  //
  // 🚨 IT AUTHORIZES NOTHING, AND THE SERVER TRUSTS NOTHING IN IT. It is client-echoed and
  // unverifiable — a client could send an id belonging to a different quote. That is
  // acceptable BECAUSE it is only ever a pointer: the record it points at holds the priced
  // steps, so a false join is DETECTABLE on inspection rather than authoritative. Every gate
  // below re-prices and recomputes independently of this value.
  //
  // Normalized to a well-formed id or null so a client cannot push arbitrary bytes into a
  // receipt field. That is hygiene, not a security check.
  const quoteId = safeQuoteId(rawQuoteId);
  console.log(`[agent-plan] RUN quoteId=${quoteId ?? "none"} steps=${plan.length}`);

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
  const cap = sendCapUsdc();                       // per-action (send/swap) cap
  const bcap = bridgeCapUsdc();                    // per-bridge cap (its own bound)
  // A bridge step is bounded by the per-BRIDGE cap; everything else by the send
  // cap. Same per-step caps agent-act's proposal and executeAction enforce.
  const capForA = (step) => atomic(step?.type === "bridge_usdc" ? bcap : cap);
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

  // ══ PRE-FLIGHT: RE-PRICE EVERY BRIDGE STEP BEFORE EXECUTING ANY OF THEM ═══════════
  //
  // 🚨 THIS IS NOT REDUNDANT WITH THE MONOTONIC ACK RULE. It serves TWO purposes, and
  // removing it because the rule "already handles band changes" reintroduces both:
  //
  //   1. IT PREVENTS A MID-PLAN ABORT AFTER FUNDS HAVE MOVED. The executor stops at the
  //      first refusal, so an unacknowledged bridge at step 3 aborts steps 3+ — with
  //      steps 1-2 already on-chain and irreversible. Consent collected after a partial
  //      execution is not consent. Checking here means the refusal costs nothing.
  //   2. IT RE-PRICES A PLAN THAT SAT UNCONFIRMED ON SCREEN. The quote is a snapshot; a
  //      user can leave it open for an hour. The fee is VOLATILE — 0.0541 / 0.053520 /
  //      0.053196 / 0.053635 in one day, and 0.203065 three weeks earlier — so a plan
  //      quoted below the acknowledge band can genuinely reach execution above it. The
  //      monotonic rule decides WHETHER that is acceptable; this decides WHEN we find out.
  //
  // The monotonic rule itself needs no code: `acknowledge` is the top band and the only
  // one that gates, so an exact token match in _actions already means "current band is no
  // worse than the one acknowledged". An improvement simply stops gating.
  //
  // ⚠️ BOUNDED — one live IRIS round trip per bridge step inside a ~10s sync handler that
  // must still execute the plan. agent-act refuses to quote more bridge steps than this,
  // so a plan reaching here is already within budget; the guard is repeated because this
  // endpoint accepts a plan array directly and must not trust that it came from a quote.
  const MAX_PREFLIGHT_BRIDGE_STEPS = 4;
  const bridgeIdx = plan.map((s, i) => (s?.type === "bridge_usdc" ? i : -1)).filter((i) => i >= 0);
  if (bridgeIdx.length > MAX_PREFLIGHT_BRIDGE_STEPS) {
    return json(200, { executed: false, blocked: `too many bridge steps (${bridgeIdx.length}); ${MAX_PREFLIGHT_BRIDGE_STEPS} is the most one plan may contain` });
  }

  const ackFor = {};
  for (const i of bridgeIdx) {
    const s = plan[i];
    const amt = Number(s.amountUsdc);
    const dest = resolveDestination(s.destination);
    if (!dest) return json(200, { executed: false, blocked: `step ${i + 1}: unsupported destination "${s.destination}"` });

    let fee;
    try {
      fee = await bridgeFee({ amountUsdc: amt, cctpDomain: dest.cctpDomain });
    } catch (e) {
      // ⚠️ DISTINCT FROM A BAND REFUSAL. Unreachable pricing is transient and upstream;
      // telling the user to reconsider their amount would be wrong advice. Nothing has
      // executed at this point, so retrying is safe and is the right response.
      return json(200, {
        executed: false,
        blocked: `step ${i + 1}: cannot reach the bridge pricing service right now (${e.message}) — nothing was executed; try again shortly`,
        priceUnavailable: true,
      });
    }

    const band = bridgeFeeBand({ amountUsdc: amt, feeUsdc: fee.feeUsdc, netUsdc: fee.netUsdc });
    if (band.band === "acknowledge") {
      const expected = bridgeAckToken({ owner: session.address, destinationKey: dest.key, amountUsdc: amt, band: band.band });
      if ((ackTokens || {})[i] !== expected) {
        // Either never acknowledged, or the band WORSENED since the quote. Refuse the
        // WHOLE plan with a fresh disclosure — before step 1 — so acceptance is asked
        // for while it can still be given freely.
        return json(200, {
          executed: false,
          blocked:
            `step ${i + 1} would lose ${(band.feeRatio * 100).toFixed(1)}% to fees — the fee to ${dest.label} is ` +
            `~${fee.feeUsdc.toFixed(4)} USDC of ${amt} USDC, so only ~${fee.netUsdc.toFixed(4)} would arrive. ` +
            `Nothing was executed. Confirm you accept that and run the plan again.`,
          needsAck: true,
          stepDisclosures: {
            [i]: {
              amountUsdc: amt,
              destinationKey: dest.key,
              destinationLabel: dest.label,
              feeUsdc: Number(fee.feeUsdc.toFixed(6)),
              netUsdc: Number(fee.netUsdc.toFixed(6)),
              feeRatio: band.feeRatio,
              band: band.band,
              ackToken: expected,
            },
          },
        });
      }
      ackFor[i] = expected;
    }
  }

  // ── Execute in order; STOP at the first cap/ceiling breach or failure ──────
  const results = [];
  let stoppedAt = null;
  let runningA = 0;                                // micro-USDC committed by THIS plan

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const vA = atomic(values[i]);

    // (1) PER-ACTION cap — each step by its own type (bridge → per-bridge cap,
    //     else send cap). Stop here, never skip-and-continue.
    const isBridge = step?.type === "bridge_usdc";
    if (vA > capForA(step)) {
      results.push({ index: i, step, ok: false, blocked: `step ~${usd2(values[i])} exceeds per-${isBridge ? "bridge" : "transaction"} limit of ${isBridge ? bcap : cap} USDC` });
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
      // The token the PRE-FLIGHT verified, not one the client handed us for this step —
      // _actions recomputes and compares it again, so this is belt-and-braces rather than
      // trust, and it keeps the executor's gate identical on both bridge paths.
      const r = await executeAction(ackFor[i] ? { ...step, ackToken: ackFor[i] } : step, actx);
      if (!r.ok) {
        results.push({ index: i, step, ok: false, blocked: r.blocked });
        stoppedAt = i;
        break;
      }
      // Success (confirmed, submitted-in-batch, or a fire-and-continue bridge
      // whose Arc burn landed but destination mint is still pending). Record the
      // real state; for a bridge, carry the async fields so the client can poll
      // the destination mint inline (Option A — don't block the plan on it).
      const state =
        r.state || r.pay?.state || r.swap?.state || (r.tx ? "completed" : "submitted");
      results.push({
        index: i, step, ok: true, kind: r.kind, state,
        swap: r.swap, pay: r.pay, tx: r.tx,
        // bridge fire-and-continue payload (undefined for other step types):
        burnHash: r.burnHash, destination: r.destination, feeUsdc: r.feeUsdc, netUsdc: r.netUsdc,
      });

      // 🚨 A BRIDGE INSIDE A PLAN USED TO LEAVE NO RECORD AT ALL. The receipt write lived
      // in agent-bridge.mjs — the HTTP handler — not in executeAction, so a bridge reached
      // this way wrote no receipt, triggered no settler, was invisible to the sweeper, and
      // could never show a measured delivery. Everything built for the direct path simply
      // did not apply here: it fired, polled IRIS, showed a checkmark, and forgot.
      // ⭐ Same helper as agent-bridge, deliberately NOT inside executeAction — see the
      // block comment in _bridge-record.mjs for why job-bridge-approve must stay excluded.
      // It cannot fail this step: the burn has already landed, and the plan must continue.
      if (r.kind === "bridge_usdc" && r.burnHash) {
        await recordBridge({ r, session, event, amountRequested: step.amountUsdc, quoteId, stepIndex: i });
      }
      runningA += vA;                              // commit: decrement remaining daily budget
    } catch (e) {
      // A thrown error (incl. TxPendingError) stops the plan. Record and halt.
      results.push({ index: i, step, ok: false, error: e.message, pending: e.name === "TxPendingError" });
      stoppedAt = i;
      break;
    }
  }

  const allOk = stoppedAt === null;
  // ⚠️ THE JOIN IS COMPLETE ONLY FOR BRIDGE STEPS. A bridge lands `quoteId` on a durable
  // receipt; every other step type has no receipt to carry it, so a plan that stopped before
  // its first bridge leaves only the log line above. That is a real remaining gap, stated
  // rather than papered over — "the plan ran" is not itself persisted anywhere.
  return json(200, {
    executed: true,
    completed: allOk,
    quoteId,
    totalUsdc,
    ceiling,
    stoppedAt,          // null if all ran; else the index that stopped the plan
    stepsRun: results.filter((r) => r.ok).length,
    stepsTotal: plan.length,
    results,
  });
}
