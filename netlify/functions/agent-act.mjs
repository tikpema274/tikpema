import { TxPendingError } from "./_circle.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody, dateAnchor, sendCapUsdc, bridgeCapUsdc, swapCapUsdc, maxSpendUsdc } from "./_arc.mjs";
import { SWAP_TOKENS } from "./_swap.mjs";
import { executeAction, valueOfStep } from "./_actions.mjs";
import { resolveDestination, bridgeFee, SUPPORTED_DESTINATION_LABELS, bridgeFeeBand, bridgeAckToken } from "./_bridge.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { budgetConfig } from "./_budget.mjs";
import { mintQuoteId, recordQuoteNeverThrows } from "./_quote-record.mjs";

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

// Bounded per plan: each priced bridge step costs a live IRIS round trip inside a ~10s
// sync handler that has already called the model. Beyond this, refuse loudly rather than
// time out mid-quote — a timeout reads as the plan failing, not the pricing.
const MAX_PRICED_BRIDGE_STEPS = 4;

const SYSTEM_PROMPT = `You are Tikpema's autonomous on-chain agent on Arc Testnet.
You control your own developer-controlled smart-account wallet and may act with its funds only.
Given a task, respond with ONLY a JSON object, no prose, no markdown fences:
{
  "action": "transfer_usdc" | "swap_tokens" | "pay_for_service" | "bridge_usdc" | "plan" | "needs_confirmation" | "none",
  "to": "0x... (required if action is transfer_usdc)",
  "amountUsdc": number (required if action is transfer_usdc),
  "tokenIn": "USDC | EURC (required if action is swap_tokens)",
  "tokenOut": "USDC | EURC (required if action is swap_tokens)",
  "amountIn": number (required if action is swap_tokens),
  "payTo": "0x... (required if action is pay_for_service)",
  "payAmountUsdc": number (required if action is pay_for_service),
  "destination": "chain name (required if action is bridge_usdc) — e.g. Ethereum, Base, Arbitrum, Optimism, Avalanche, Polygon",
  "steps": [ { "type": "transfer_usdc"|"swap_tokens"|"pay_for_service"|"bridge_usdc", ...that action's fields } ] (required if action is plan; 2+ ordered steps),
  "unmetCondition": "string (required if action is needs_confirmation) — the part of the task you cannot fulfill",
  "reasoning": "one sentence"
}
Choose "none" if the task is unclear, unsafe, or not a transfer.
You can execute immediate USDC transfers and same-chain token swaps. You CANNOT schedule payments for a future time, set up recurring/conditional payments, or wait.
If a task asks for a transfer but attaches a condition you cannot fulfil — a specific time ("at 23.25", "tonight", "in an hour"), a recurring schedule, or a trigger ("when X happens") — you MUST choose action "needs_confirmation", put the unfulfillable part in "unmetCondition", and do NOT choose transfer_usdc. Only choose transfer_usdc when the transfer is unconditional and can run right now.
For a swap (e.g. "swap 5 USDC to EURC", "convert 2 EURC into USDC"), choose action "swap_tokens" with tokenIn, tokenOut, and amountIn. Only these tokens are supported: USDC, EURC. tokenIn and tokenOut must differ.
A plain "send/pay X USDC to 0x..." is a transfer_usdc (your regular balance). Choose "pay_for_service" ONLY when the task explicitly says to pay FROM the Gateway / unified balance, or to pay FOR a service, with payTo and payAmountUsdc. When unsure between the two, prefer transfer_usdc.
For a cross-chain move (e.g. "bridge 20 USDC to Ethereum", "send 5 USDC to Base", "move 10 USDC over to Arbitrum"), choose action "bridge_usdc" with amountUsdc and destination (the chain name). This burns USDC on Arc and mints it on the destination chain. Supported destinations: Ethereum, Base, Arbitrum, Optimism, Avalanche, Polygon, Unichain, Linea. A bridge is DIFFERENT from transfer_usdc: transfer stays on Arc to a 0x address; bridge crosses to another chain. Only choose bridge_usdc when the task names another chain to move funds TO.
If a task asks for MULTIPLE actions in sequence (e.g. "swap 2 USDC to EURC then pay 1 USDC to 0x...", "send A then swap B", "swap 2 to EURC then bridge 3 to Base"), choose action "plan" with an ordered "steps" array, each step being one transfer_usdc/swap_tokens/pay_for_service/bridge_usdc with that action's own fields (a bridge_usdc step needs amountUsdc + destination). Use plan ONLY for genuinely multi-action tasks; a single action stays its own action. A multi-step task is NOT a needs_confirmation — needs_confirmation is only for scheduling/conditional/timing you cannot fulfil.`;

/** Which brain priced this. ONE definition: `decide` calls it and the quote record names it.
 *  Reading the env var again at the record site would be a second copy of the same claim, and
 *  second copies drift — the quote would then name a model that did not produce the plan. */
export const agentModel = () => process.env.AGENT_MODEL || "claude-haiku-4-5-20251001";

async function decide(task) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
  const model = agentModel();

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
  if (event.blobs) connectBlobs(event); // Blobs for the budget-spine day ledger

  // Auth gate: only an authenticated session may trigger an agent spend.
  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  const { task } = parseBody(event);
  if (!task) return json(400, { error: "Provide a 'task' string" });

  // Resolve the caller's OWN agent wallet from the session (never client-supplied,
  // never the shared env wallet). Actions run on THIS wallet.
  let owner;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { owner = await ensureOwnerWallet(session); }
  // ⚠️ ONLY the tagged external failure earns this diagnosis. Anything else — a TypeError from
  // a bad refactor, say — RE-THROWS and surfaces unclaimed, rather than borrowing a
  // "temporary, please retry" it cannot honour.
  catch (e) {
    if (!isWalletUnresolvable(e)) throw e;
    return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e));
  }
  if (owner.pending) {
    return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  }
  const walletAddress = owner.walletAddress;
  // ctx passed to executeAction: session enables per-user guardrails (block pay,
  // budget day-ceiling, ledger); walletAddress is the per-user wallet.
  const actx = { walletAddress, session };

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
          `I can only send USDC right away — I can't schedule payments or wait for a condition. ` +
          `The part I can't act on is: ${decision.unmetCondition || "a condition I can't fulfil"}. ` +
          `Send the task again without it and I'll pay now.`,
      });
    }

    // Multi-step: propose a plan for confirmation (does NOT execute here).
    // The client holds the returned plan and POSTs it to agent-execute-plan
    // after the user confirms. The executor is the SINGLE authoritative
    // enforcement point (per-action cap + cumulative day-ceiling, stop-on-limit),
    // so we PROPOSE any shape-valid plan and let it stop mid-run if it would
    // breach the daily bound — we only reject up front for a clean early message
    // when a SINGLE step already exceeds the per-action cap.
    if (decision.action === "plan") {
      const steps = Array.isArray(decision.steps) ? decision.steps : [];
      if (steps.length < 2) {
        return json(200, { executed: false, decision, blocked: "a plan needs 2+ steps" });
      }
      const KINDS = new Set(["transfer_usdc", "swap_tokens", "pay_for_service", "bridge_usdc"]);
      for (const s of steps) {
        if (!KINDS.has(s?.type)) {
          return json(200, { executed: false, decision, blocked: `unknown step type "${s?.type}"` });
        }
      }
      const cap = sendCapUsdc();
      const bcap = bridgeCapUsdc();
      // A bridge step is bounded by the per-BRIDGE cap; everything else by the
      // per-transaction (send) cap. Same per-step caps the executor enforces.
      const capFor = (s) => (s?.type === "bridge_usdc" ? bcap : cap);
      const values = [];
      let totalUsdc = 0;
      try {
        for (const s of steps) {
          const v = await valueOfStep(s);
          values.push(v);
          totalUsdc += v;
        }
      } catch (e) {
        return json(200, { executed: false, decision, blocked: `cannot value plan: ${e.message}` });
      }
      const over = values.findIndex((v, idx) => v > capFor(steps[idx]));
      if (over >= 0) {
        const isBridge = steps[over]?.type === "bridge_usdc";
        return json(200, {
          executed: false,
          decision,
          blocked: `step ${over + 1} (~${values[over].toFixed(2)}) exceeds per-${isBridge ? "bridge" : "transaction"} limit of ${capFor(steps[over])} USDC`,
        });
      }
      const ceiling = budgetConfig().PERIOD_CEILING_USDC;
      const hasBridge = steps.some((s) => s?.type === "bridge_usdc");

      // ── PRICE EACH BRIDGE STEP AT PLAN TIME ──────────────────────────────────────
      // The quote used to sum `totalUsdc` from requested amounts and price NOTHING
      // per-step, so a plan disclosed no bridge fee at all — and a bridge step in the
      // acknowledge band was refused at EXECUTION with no disclosure and no way to
      // accept. Pricing here produces both: the per-step disclosure the panel renders,
      // and the fee the total was silently omitting.
      //
      // ⚠️ BOUNDED. Each priced step costs a live IRIS round trip, inside a ~10s sync
      // handler that has already called the model. A plan with many bridges would spend
      // its budget here and time out mid-quote, which reads to the user as a failure of
      // the plan rather than of the pricing. Refusing loudly is better than a timeout.
      const bridgeIdx = steps.map((s, i) => (s?.type === "bridge_usdc" ? i : -1)).filter((i) => i >= 0);
      if (bridgeIdx.length > MAX_PRICED_BRIDGE_STEPS) {
        return json(200, {
          executed: false,
          decision,
          blocked:
            `this plan has ${bridgeIdx.length} bridge steps; ${MAX_PRICED_BRIDGE_STEPS} is the most that can be priced ` +
            `and disclosed in one plan. Split it into smaller plans.`,
        });
      }

      const stepDisclosures = {};
      let totalFeeUsdc = 0;
      for (const i of bridgeIdx) {
        const s = steps[i];
        const amt = Number(s.amountUsdc);
        const dest = resolveDestination(s.destination);
        if (!dest) {
          return json(200, { executed: false, decision, blocked: `step ${i + 1}: unsupported destination "${s.destination}"` });
        }
        let fee;
        try {
          fee = await bridgeFee({ amountUsdc: amt, cctpDomain: dest.cctpDomain });
        } catch (e) {
          // ⚠️ SEPARATE FROM A BAND REFUSAL. "We could not reach the pricing service" and
          // "this bridge costs too much" are different facts, and collapsing them tells
          // the user to reconsider an amount when the real problem is upstream and
          // transient. Retrying is the right response to this one; changing the amount is
          // the right response to the other.
          return json(200, {
            executed: false,
            decision,
            blocked: `step ${i + 1}: cannot reach the bridge pricing service right now (${e.message}) — this is not a limit on your amount; try again shortly`,
            priceUnavailable: true,
          });
        }
        // Fee-floor at PLAN time — refuse to propose a bridge where nothing would arrive,
        // rather than letting the user confirm and be refused at execution.
        if (fee.maxFee >= fee.amountMinor) {
          return json(200, {
            executed: false,
            decision,
            blocked: `step ${i + 1}: amount too small — the fee to ${dest.label} is ~${fee.feeUsdc.toFixed(4)} USDC (≥ your ${amt} USDC), so nothing would arrive`,
          });
        }
        const band = bridgeFeeBand({ amountUsdc: amt, feeUsdc: fee.feeUsdc, netUsdc: fee.netUsdc });
        totalFeeUsdc += fee.feeUsdc;
        stepDisclosures[i] = {
          amountUsdc: amt,
          destinationKey: dest.key,
          destinationLabel: dest.label,
          feeUsdc: Number(fee.feeUsdc.toFixed(6)),
          netUsdc: Number(fee.netUsdc.toFixed(6)),
          feeRatio: band.feeRatio,
          band: band.band,
          // Present ONLY when acceptance is required, so its presence is the signal to
          // gate — the panel never re-derives a band from two numbers.
          ackToken:
            band.band === "acknowledge"
              ? bridgeAckToken({ owner: session.address, destinationKey: dest.key, amountUsdc: amt, band: band.band })
              : null,
        };
      }

      // ══ RECORD THE PLAN AS PRICED ════════════════════════════════════════════════════
      // Everything above this line was computed server-side and then handed to the browser
      // and forgotten. That is why "was an ack box shown for a step that never ran?" had no
      // server-side answer at all — see the block comment in _quote-record.mjs.
      //
      // ⭐ THE quoteId IS THE JOIN, AND THE JOIN IS THE POINT. Two records nobody can
      // correlate answer nothing. This id travels with the plan to agent-execute-plan and
      // lands on every bridge receipt that plan produces, so "proposed vs ran" is one lookup.
      //
      // 🚨 DIAGNOSTIC ONLY — nothing may ever read this back to authorize a bridge. The
      // pre-flight in agent-execute-plan RE-PRICES rather than trusting this, deliberately.
      //
      // ⚠️ FIRE-AND-CONTINUE. `recordQuoteNeverThrows` swallows everything: this is the quote
      // path, and losing the ability to propose a plan because diagnostics failed would trade
      // a capability for an observation. The return value is not branched on.
      const quotedAt = new Date().toISOString();
      const quoteId = mintQuoteId();
      await recordQuoteNeverThrows({
        schema: "agent-quote/1",
        note: "DIAGNOSTIC ONLY — never read back to authorize. Consent is the ackToken recomputation in _actions.mjs.",
        quoteId,
        quotedAt,
        owner: session.address,          // the login wallet — same key space as bridge receipts
        agentWallet: walletAddress,      // the wallet that would actually spend
        // The raw phrasing AND what the brain made of it, together. One of the three unresolved
        // shapes of the 2026-08-01 anomaly was "bridge 0.1 became 1.0 somewhere between the
        // phrasing and the quote" — only these two side by side can tell that apart from a step
        // that was priced and never ran.
        task,
        model: agentModel(),
        reasoning: decision.reasoning ?? null,
        stepCount: steps.length,
        steps: steps.map((s, i) => ({
          index: i,
          type: s?.type,
          step: s,
          valueUsdc: values[i],
          // Present only for bridge steps — the disclosure the panel rendered, verbatim, so the
          // record answers "what did the user SEE" and not merely "what did the server think".
          // The token itself is NOT stored: `ackTokenIssued` says whether the box appeared,
          // which is the fact in question, and a record is a poor place for a credential.
          ...(stepDisclosures[i]
            ? {
                bridge: {
                  destinationKey: stepDisclosures[i].destinationKey,
                  destinationLabel: stepDisclosures[i].destinationLabel,
                  feeUsdc: stepDisclosures[i].feeUsdc,
                  netUsdc: stepDisclosures[i].netUsdc,
                  feeRatio: stepDisclosures[i].feeRatio,
                  band: stepDisclosures[i].band,
                  ackTokenIssued: stepDisclosures[i].ackToken != null,
                },
              }
            : {}),
        })),
        totalUsdc,
        totalFeeUsdc: Number(totalFeeUsdc.toFixed(6)),
        // The bounds in force AT QUOTE TIME. They come from env and can change between a quote
        // and its execution; a stop-on-limit later reads very differently once you can see
        // which ceiling was quoted against.
        caps: { sendCapUsdc: cap, bridgeCapUsdc: bcap, periodCeilingUsdc: ceiling },
      });

      return json(200, {
        executed: false,
        needsConfirm: true,
        decision,
        // Echoed so the client can hand it back on confirm. It authorizes NOTHING — the
        // executor re-prices and recomputes every gate regardless of what comes with it.
        quoteId,
        plan: steps,
        totalUsdc,
        // The fee the total never disclosed. Keyed by step index so a plan with two
        // bridges in different bands is described correctly rather than averaged.
        totalFeeUsdc: Number(totalFeeUsdc.toFixed(6)),
        stepDisclosures,
        ceiling,
        message:
          `This is a ${steps.length}-step plan totaling ~${totalUsdc.toFixed(2)} USDC. ` +
          `Sends/swaps are capped at ${cap} USDC${hasBridge ? `, bridges at ${bcap} USDC` : ""}, ` +
          `and total agent spend is bounded to ${ceiling} USDC/day — the plan stops if a step would exceed that. ` +
          `${hasBridge ? "A bridge step burns on Arc and continues; its destination mint completes in the background. " : ""}Confirm to execute.`,
      });
    }

    // Backstop: even if the brain chose transfer_usdc, refuse if the raw task
    // contains a scheduling/conditional cue the agent cannot honor. The model is
    // the first classifier; this is the code not trusting a silent drop.
    if (decision.action === "transfer_usdc" || decision.action === "swap_tokens" || decision.action === "bridge_usdc") {
      const schedulePattern =
        /\b((at|by)\s+(\d{1,2}([:.]\d{1,2})?\s*(am|pm)?|noon|midnight|midday|morning|afternoon|evening|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tonight|tomorrow|later|in \d+\s*(min|minute|hour|hr|day)|every|when|after|before|schedule|recurring|daily|weekly)\b/i;
      if (schedulePattern.test(task)) {
        return json(200, {
          executed: false,
          decision,
          needsConfirmation: true,
          message:
            `This task looks like it has a time or condition attached, so I've held off. ` +
            `I can only send USDC right away, not on a schedule. ` +
            `Send it again without the timing and I'll pay now.`,
        });
      }
    }

    // Bridge is the highest-stakes action (funds LEAVE Arc, fee is volatile), so
    // it is PROPOSE-then-confirm — never immediate. We validate, price it live,
    // enforce the cap + fee-floor up front for a clean message, and return the
    // proposal (amount / destination / fee / net) for the user to confirm. The
    // client then POSTs to /api/agent-bridge, which is the single execute path.
    if (decision.action === "bridge_usdc") {
      const amount = Number(decision.amountUsdc);
      const dest = resolveDestination(decision.destination);
      if (!dest) {
        return json(200, {
          executed: false,
          decision,
          blocked: `unsupported destination "${decision.destination || ""}". Supported: ${SUPPORTED_DESTINATION_LABELS.join(", ")}`,
        });
      }
      if (!(amount > 0)) {
        return json(200, { executed: false, decision, blocked: "amountUsdc must be > 0" });
      }
      const bcap = bridgeCapUsdc();
      if (amount > bcap) {
        return json(200, { executed: false, decision, blocked: `exceeds per-bridge limit of ${bcap} USDC` });
      }
      // Live price. Fee-floor: refuse an un-settleable bridge with a clear message.
      let fee;
      try {
        fee = await bridgeFee({ amountUsdc: amount, cctpDomain: dest.cctpDomain });
      } catch (e) {
        return json(200, { executed: false, decision, blocked: `cannot price bridge to ${dest.label}: ${e.message}` });
      }
      if (fee.maxFee >= fee.amountMinor) {
        return json(200, {
          executed: false,
          decision,
          blocked: `amount too small — the bridge fee to ${dest.label} is ~${fee.feeUsdc.toFixed(4)} USDC right now, so ${amount} USDC wouldn't cover it (nothing would arrive)`,
        });
      }
      // The band, computed by the SAME helper the execution gate uses. The quote carries
      // the verdict and the ackToken; the UI renders them and hands the token back. No
      // surface re-derives a ratio from feeUsdc and amountUsdc — that is how three
      // renderings of one fact drifted apart in the first place.
      const band = bridgeFeeBand({ amountUsdc: amount, feeUsdc: fee.feeUsdc, netUsdc: fee.netUsdc });
      return json(200, {
        executed: false,
        needsBridgeConfirm: true,
        decision,
        bridge: {
          amountUsdc: amount,
          destination: { key: dest.key, label: dest.label },
          feeUsdc: Number(fee.feeUsdc.toFixed(6)),
          netUsdc: Number(fee.netUsdc.toFixed(6)),
          cap: bcap,
          feeDisclosure: {
            feeRatio: band.feeRatio,
            band: band.band,
            // Present only when acceptance is REQUIRED, so its presence is the signal to
            // gate the button rather than something the client infers from a number.
            ackToken:
              band.band === "acknowledge"
                ? bridgeAckToken({ owner: session.address, destinationKey: dest.key, amountUsdc: amount, band: band.band })
                : null,
          },
        },
        message:
          `Bridge ${amount} USDC from Arc to ${dest.label}. The cross-chain fee is ~${fee.feeUsdc.toFixed(4)} USDC ` +
          `(taken from the amount), so ~${fee.netUsdc.toFixed(4)} USDC arrives on ${dest.label}. ` +
          `The Arc burn is instant; the destination mint follows in ~1–2 min. Confirm to bridge.`,
      });
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
      if (!(amountIn > 0)) {
        return json(200, { executed: false, decision, blocked: "amountIn must be > 0" });
      }
      // ── THE SWAP CAP. Two bugs fixed here; both were live. ──
      //
      // 1. FAIL-OPEN. This was `Number(process.env.AGENT_MAX_SPEND_USDC || "1")` — a garbled
      //    env value yields NaN, and `usdValue > NaN` is ALWAYS FALSE, so every swap passed
      //    UNCAPPED. That is the exact bug that killed gateway-deposit.mjs. swapCapUsdc()
      //    THROWS on a misconfigured value instead (fail-closed): a typo can never silently
      //    remove the bound.
      //
      // 2. TWO CAPS FOR ONE ACTION. This path bounded swaps by AGENT_MAX_SPEND_USDC while the
      //    PROPOSAL path (_proposal.mjs → job-swap-approve → executeAction) bounds them by
      //    swapCapUsdc — and the proposal path, the one that executes on approval, was the
      //    LOOSER of the two. One action, one bound: both now use swapCapUsdc().
      //
      // The cap is on the USD VALUE of the input, not raw token units — EURC != $1, so
      // unit-capping would under-count. Fail-safe: if we cannot value it, we block.
      let usdValue;
      try {
        usdValue = await valueOfStep(step);
      } catch (e) {
        return json(200, { executed: false, decision, blocked: `cannot value ${tokenIn}: ${e.message}` });
      }
      const swapCap = swapCapUsdc();
      if (usdValue > swapCap) {
        return json(200, {
          executed: false,
          decision,
          blocked: `exceeds per-swap limit of ${swapCap} USDC (${amountIn} ${tokenIn} ≈ ${usdValue.toFixed(2)} USDC)`,
        });
      }

      const r = await executeAction(step, actx);
      if (!r.ok) return json(200, { executed: false, decision, blocked: r.blocked });
      return json(200, { executed: true, decision, swap: r.swap, tx: r.tx });
    }

    if (decision.action === "pay_for_service") {
      const payTo = String(decision.payTo || "");
      const payAmount = Number(decision.payAmountUsdc);
      const step = { type: "pay_for_service", payTo, payAmountUsdc: payAmount };
      if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
        return json(200, { executed: false, decision, blocked: "invalid payTo address" });
      }
      if (!(payAmount > 0)) {
        return json(200, { executed: false, decision, blocked: "payAmountUsdc must be > 0" });
      }
      // Same FAIL-OPEN bug as the swap cap above: this was
      // `Number(process.env.AGENT_MAX_SPEND_USDC || "1")`, so a garbled env value became NaN
      // and `payAmount > NaN` was always false — every pay passed UNCAPPED. maxSpendUsdc()
      // (_arc.mjs) has always been the fail-closed helper for this env var; this path just
      // never used it. It THROWS on a misconfigured value rather than silently uncapping.
      const maxSpendPay = maxSpendUsdc();
      if (payAmount > maxSpendPay) {
        return json(200, {
          executed: false,
          decision,
          blocked: `payAmountUsdc ${payAmount} exceeds the per-payment limit of ${maxSpendPay} USDC`,
        });
      }
      const r = await executeAction(step, actx);
      if (!r.ok) return json(200, { executed: false, decision, blocked: r.blocked });
      return json(200, { executed: true, decision, pay: r.pay });
    }
    if (decision.action !== "transfer_usdc") {
      return json(200, { executed: false, decision });
    }

    // 2. Guard rails — enforced HERE, not by the model. Per-action send cap is the
    // SAME sendCapUsdc used by the dedicated send + every plan step (one cap across
    // the user-directed surface); the executor's day-ceiling backstops cumulatively.
    const cap = sendCapUsdc();
    const amount = Number(decision.amountUsdc);
    const to = String(decision.to || "");
    const step = { type: "transfer_usdc", to, amountUsdc: amount };

    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      return json(200, { executed: false, decision, blocked: "invalid recipient" });
    }
    if (!(amount > 0) || amount > cap) {
      return json(200, {
        executed: false,
        decision,
        blocked: `amount ${amount} exceeds per-transaction limit of ${cap} USDC`,
      });
    }

    // 3. Execute: agent's own SCA wallet transfers USDC (gas sponsored). A still-
    // pending tx surfaces as a TxPendingError that executeAction lets propagate,
    // so the outer catch can map it to 202 (unchanged behavior).
    const r = await executeAction(step, actx);
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
