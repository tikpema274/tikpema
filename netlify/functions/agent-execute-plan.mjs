import { json, parseBody, sendCapUsdc, bridgeCapUsdc, vaultDepositCapUsdc } from "./_arc.mjs";
import { resolveVault } from "./_vault.mjs";
import { depositDisclosure } from "./_vault-disclosure.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { executeAction, valueOfStep } from "./_actions.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal, isWalletUnresolvable } from "./_agent-wallets.mjs";
import { daySpend, budgetConfig } from "./_budget.mjs";
import { recordBridge, recordPendingBridge } from "./_bridge-record.mjs";
import { TxPendingError } from "./_circle.mjs";
import { resolveDestination, bridgeFee, bridgeFeeBand, bridgeAckToken, openBridgeQuote, sealBridgeQuote, quoteWindowMs } from "./_bridge.mjs";
import { bridgeMechanicOf } from "../../shared/bridge-mechanic.mjs";
import { safeQuoteId, markQuoteUsed } from "./_quote-record.mjs";

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

  // ackTokens: { [stepIndex]: token } — the band acknowledgement per bridge/vault step.
  // quoteTokens: { [stepIndex]: token } — the SEALED fee quote per bridge step, issued by agent-act
  //   with the figure the panel rendered. Opened below before step 1; never trusted as data.
  // quoteOnly: true — re-price every bridge step, seal, return fresh disclosures, execute NOTHING.
  //   The panel's "Quote expired — price it again" press; it must never reach the executor.
  const { plan, ackTokens, quoteTokens, quoteId: rawQuoteId, quoteOnly } = parseBody(event);
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
  const actx = { walletAddress, session };

  // ── Value every step up front (for the total + to fail fast on an unvaluable
  //    step). Values are USD: transfer/pay face value; swap = USD of the input. ─
  const atomic = (usdc) => Math.round(Number(usdc) * 1e6); // micro-USDC (no float drift)
  const usd2 = (usdc) => (Math.round(Number(usdc) * 100) / 100).toFixed(2);

  // ══ PRE-FLIGHT: RE-PRICE EVERY BRIDGE STEP BEFORE EXECUTING ANY OF THEM ═══════════════════════
  // ══ …AND BEFORE VALUING THEM, BECAUSE VALUATION NEEDS THE FEE ═════════════════════════════════
  //
  // 🚨 THE DEFECT THIS CLOSES. `valueOfStep` gained a REQUIRED fee for bridge steps in f760077
  // (a bridge is valued at amount + fee, because under upfront fees the fee leaves the user's
  // control too). That commit threaded the fee at its OWN call site in _actions.mjs and left this
  // one calling `valueOfStep(step)` with one argument — so `resolved.bridgeFee` was undefined,
  // valuation threw, and EVERY plan containing a bridge step was blocked from 2026-09-03 22:35
  // until it was found on 2026-09-05. Nothing noticed because a single bridge does not come
  // through here, and no guard crossed from the callee to this caller.
  //
  // ⛔ ONE FETCH, TWO READERS — NOT A SECOND SOURCE. These same `fees[i]` are handed to the
  // acknowledge pre-flight below; that loop no longer prices anything itself. Two fee lookups in
  // one handler is precisely what the upfront-fee migration spent days removing: they can disagree,
  // and then the figure the ceiling used is not the figure the user acknowledged.
  //
  // ⚠️ THE ORDER MOVED AND THAT IS DELIBERATE. Step-count, destination and pricing-reachability now
  // refuse BEFORE "cannot value plan". All three are more specific than a valuation failure, so a
  // caller learns the real reason; the band/acknowledge decision did NOT move and still sits below,
  // so consent is still asked for last and only for a plan that has cleared everything cheaper.
  const MAX_PREFLIGHT_BRIDGE_STEPS = 4;
  const bridgeIdx = plan.map((s, i) => (s?.type === "bridge_usdc" ? i : -1)).filter((i) => i >= 0);
  if (bridgeIdx.length > MAX_PREFLIGHT_BRIDGE_STEPS) {
    return json(200, { executed: false, blocked: `too many bridge steps (${bridgeIdx.length}); ${MAX_PREFLIGHT_BRIDGE_STEPS} is the most one plan may contain` });
  }

  const dests = {};
  for (const i of bridgeIdx) {
    const dest = resolveDestination(plan[i].destination);
    if (!dest) return json(200, { executed: false, blocked: `step ${i + 1}: unsupported destination "${plan[i].destination}"` });
    dests[i] = dest;
  }

  // ═══ ⭐⭐ RE-QUOTE: PRICE EVERY BRIDGE STEP, SEAL, DISCLOSE — AND EXECUTE NOTHING ════════════════
  // One builder for the two moments a fresh figure is owed: the panel's explicit "price it again"
  // (`quoteOnly`) and a confirm that arrived with a missing or expired seal (below). Both return the
  // same `stepDisclosures` shape agent-act's proposal carries, each step re-sealed, so the panel
  // re-renders the proposal with the new figures and asks again. ⛔ Never called on the path that
  // executes: the figure that reaches calldata comes only from an OPENED token.
  const requote = async (reason) => {
    const stepDisclosures = {};
    for (const i of bridgeIdx) {
      const s = plan[i];
      const amt = Number(s.amountUsdc);
      const dest = dests[i];
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
      if (fee.feeMinor >= fee.amountMinor) {
        return json(200, {
          executed: false,
          blocked: `step ${i + 1}: the fee to ${dest.label} is ~${fee.feeUsdc.toFixed(4)} USDC — as much as or more than the ${amt} USDC being moved. Nothing was executed.`,
        });
      }
      const band = bridgeFeeBand({ amountUsdc: amt, feeUsdc: fee.feeUsdc, netUsdc: fee.netUsdc });
      stepDisclosures[i] = {
        amountUsdc: amt,
        destinationKey: dest.key,
        destinationLabel: dest.label,
        feeUsdc: Number(fee.feeUsdc.toFixed(6)),
        netUsdc: Number(fee.netUsdc.toFixed(6)),
        mechanic: bridgeMechanicOf(fee.mechanic),
        feeRatio: band.feeRatio,
        band: band.band,
        ackToken: band.band === "acknowledge"
          ? bridgeAckToken({ owner: session.address, destinationKey: dest.key, amountUsdc: amt, band: band.band })
          : null,
        quoteToken: sealBridgeQuote({ owner: session.address, destinationKey: dest.key, amountUsdc: amt, fee }),
        expiresInMs: quoteWindowMs(fee),
      };
    }
    // 409 for a stale/missing seal on a CONFIRM (the caller expected execution and must re-confirm);
    // 200 for the panel's own re-price press, which expected exactly this.
    return json(reason === "quoteOnly" ? 200 : 409, {
      executed: false, needsConfirm: true, requoted: true,
      quoteExpired: reason === "expired", quoteRequired: reason === "missing",
      ...(reason === "quoteOnly" ? {} : { blocked: reason === "expired"
        ? "the bridge quote you were shown has expired — here is a fresh one; nothing was executed. Confirm the new figure to run the plan."
        : "this plan's bridge step has no sealed quote — here is one; nothing was executed. Confirm the figure to run the plan." }),
      stepDisclosures,
    });
  };
  if (quoteOnly) return requote("quoteOnly");

  // ═══ ⛔⛔ THE FEE THAT REACHES CALLDATA IS AN OPENED SEAL, NEVER A PRICE TAKEN HERE ═════════════
  // Until 2026-09-13 this loop called `bridgeFee()` — a SECOND quote after the one agent-act showed
  // — and then the executor, handed no token, priced a THIRD and signed it. Three quotes; the one
  // charged was the one nobody saw. Now each bridge step's `quoteTokens[i]` is OPENED (HMAC over
  // owner, destination, amount, fee, Circle's signedQuote and expiry) and that object is what the
  // valuation, the band gate and — via `step.quoteToken` — the executor's calldata all read.
  // ⛔ ALL OPENED BEFORE STEP 1. A plan whose bridge sits at step 3 must be refused before step 1
  // moves money, or the re-confirm would be asked for after a partial execution.
  // ⛔ A MISSING OR EXPIRED SEAL REFUSES THE WHOLE PLAN WITH FRESH QUOTES — never a silent re-price.
  const fees = {};
  for (const i of bridgeIdx) {
    const s = plan[i];
    const token = (quoteTokens || {})[i];
    if (typeof token !== "string" || !token) return requote("missing");
    try {
      fees[i] = openBridgeQuote(token, { owner: session.address, destinationKey: dests[i].key, amountUsdc: Number(s.amountUsdc) });
    } catch (e) {
      console.log(`[agent-plan] step ${i + 1} quote refused: ${e.message}`);
      return requote("expired");
    }
  }

  let totalUsdc = 0;
  const values = [];
  try {
    // ⚠️ `vi`, NOT `i`. The execution loop below is `for (let i = 0; i < plan.length; i++)` and a
    // guard anchors on that exact header to prove consent is refused BEFORE execution. Reusing the
    // header here gave `indexOf` two matches and it silently took this one — the guard went red on
    // correct code. An anchor that is not unique is not an anchor.
    for (let vi = 0; vi < plan.length; vi++) {
      // ⭐ `fees[vi]` is undefined for every non-bridge step, and valueOfStep ignores `resolved`
      // for those — so this is the same call for all step types, with the fee present exactly
      // where the valuation requires one.
      const v = await valueOfStep(plan[vi], { bridgeFee: fees[vi] });
      values.push(v);
      // ⛔⛔ `values[i]` IS FEE-INCLUSIVE, `totalUsdc` IS NOT — and the split is deliberate.
      // The CAPS and the day ceiling bound what LEAVES the wallet, so they read `values[i]`
      // (amount + fee), matching _actions.mjs exactly. But `totalUsdc` is recorded BESIDE
      // `totalFeeUsdc` and is shown to the user as "a N-step plan totaling ~X USDC" — so if it
      // absorbed the fee, any reader adding the two fields would DOUBLE-COUNT it, and the
      // sentence would silently start meaning something new. The fee is subtracted from the same
      // resolved `fees[i]` that produced the value, so there is still ONE valuation formula.
      totalUsdc += v - Number(fees[vi]?.feeUsdc ?? 0);
    }
  } catch (e) {
    return json(200, { executed: false, blocked: `cannot value plan: ${e.message}` });
  }

  // ── Cap config ────────────────────────────────────────────────────────────
  const cap = sendCapUsdc();                       // per-action (send/swap) cap
  const bcap = bridgeCapUsdc();                    // per-bridge cap (its own bound)
  // A bridge step is bounded by the per-BRIDGE cap; everything else by the send
  // cap. Same per-step caps agent-act's proposal and executeAction enforce.
  const vcap = vaultDepositCapUsdc();               // per-vault-deposit cap (its own bound)
  // 🚨 SAME FIX AS agent-act's capFor, AND IT HAS TO BE THE SAME FIX. This mapped every non-bridge
  // step to the SEND cap, so a vault step was bounded here by one number and by
  // vaultDepositCapUsdc() inside executeAction. A pre-flight that bounds a different quantity than
  // the executor is not a pre-flight — it either refuses what would have run, or passes what will
  // be refused MID-RUN once earlier steps have already moved money.
  // ⚠️ Both call sites are changed together on purpose: fixing one and proving it is exactly how
  // the two came to disagree. [[guard-belongs-on-the-caller-set]]
  // ⭐ ONE SELECTION, TWO VIEWS. `capUsdcFor` picks the bound; `capForA` is the same bound in
  // micro-USDC for the comparison, and the refusal message reads `capUsdcFor` for display. Two
  // independent selections — one for the check, one for the sentence — is how a refusal comes to
  // name a cap it did not apply.
  const capUsdcFor = (step) =>
    step?.type === "bridge_usdc" ? bcap : step?.type === "vault_deposit" ? vcap : cap;
  const capForA = (step) => atomic(capUsdcFor(step));
  const capLabelForA = (step) =>
    step?.type === "bridge_usdc" ? "bridge" : step?.type === "vault_deposit" ? "vault-deposit" : "transaction";
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

  // ══ PRE-FLIGHT, PART 2: THE ACKNOWLEDGE DECISION ═════════════════════════════════
  // ⭐ The fee this reads is the OPENED SEAL from above — the figure agent-act showed, not a
  // re-price. A plan that sat on screen past the quote window never reaches here: the open
  // refused it with fresh quotes. So the band here cannot have drifted from the band shown;
  // a changed fee arrives only as a re-quote → new disclosure → new ack.
  //
  // 🚨 STILL NOT REDUNDANT WITH THE MONOTONIC ACK RULE:
  // IT PREVENTS A MID-PLAN ABORT AFTER FUNDS HAVE MOVED. The executor stops at the first refusal, so an unacknowledged bridge at
  // step 3 aborts steps 3+ — with steps 1-2 already on-chain and irreversible. Consent
  // collected after a partial execution is not consent. Checking here means the refusal costs
  // nothing. (Its former second purpose — re-pricing a stale plan — is now the seal's job.)
  //
  // The monotonic rule itself needs no code: `acknowledge` is the top band and the only
  // one that gates, so an exact token match in _actions already means "current band is no
  // worse than the one acknowledged". An improvement simply stops gating.
  //
  // ⭐ NO PRICING HERE, NO I/O. `dests` and `fees` come from the opened seals above, and the
  // fee the day-ceiling counted is the SAME figure the user is asked to acknowledge. The
  // step-count guard, the destination check and the seal checks all ran up there.
  const ackFor = {};
  for (const i of bridgeIdx) {
    const s = plan[i];
    const amt = Number(s.amountUsdc);
    const dest = dests[i];
    const fee = fees[i];

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

  // ═══ ⭐⭐ THE SAME PRE-FLIGHT, FOR VAULT STEPS — AND ON A FRESH READ ═════════════════════════
  // A vault deposit is gated on an ackToken bound to the disclosure the user SAW. That token is a
  // hash of the vault's CURRENT disclosure, so re-inspecting here is not belt-and-braces: it is
  // the only thing that can tell "they accepted these terms" from "they accepted terms that have
  // since changed". [[stale-read-then-act]]
  //
  // ⛔ REFUSED BEFORE STEP 1, LIKE THE BRIDGE LOOP ABOVE. A vault step refused mid-run is refused
  // after earlier steps have already moved money, and the acceptance it is asking for can no
  // longer be declined freely — the user would be choosing between accepting terms they did not
  // want and abandoning a half-executed plan.
  //
  // ⚠️ IT DOES NOT TRUST THE PROPOSAL. This endpoint accepts a plan array directly, so it recomputes
  // the disclosure itself rather than reading anything agent-act sent. Nothing client-supplied
  // decides whether an ack was required.
  const vaultIdxA = plan.map((s, i) => (s?.type === "vault_deposit" ? i : -1)).filter((i) => i >= 0);
  for (const i of vaultIdxA) {
    const vv = resolveVault(plan[i].vault);
    if (!vv) {
      return json(200, { executed: false, blocked: `step ${i + 1}: unsupported vault "${plan[i].vault}". Nothing was executed.` });
    }
    let vdisc;
    try {
      vdisc = await depositDisclosure({ vault: vv, owner: walletAddress, event });
    } catch (e) {
      // ⛔ FAIL CLOSED. An unreadable vault is not an acceptable one.
      return json(200, {
        executed: false,
        blocked: `step ${i + 1}: could not read that vault's terms, so the acknowledgement could not be checked (${e.message}). Nothing was executed.`,
      });
    }
    if (!vdisc.depositable) {
      const why = vdisc.gate.blocks.map((b) => b.detail).join(" ");
      return json(200, {
        executed: false,
        blocked: `step ${i + 1}: that vault failed a safety check — no acknowledgement can override it. Nothing was executed. ${why}`.trim(),
      });
    }
    if (vdisc.ackRequired) {
      if ((ackTokens || {})[i] !== vdisc.ackToken) {
        // Either never acknowledged, or the vault's disclosure MOVED since the quote. Either way
        // the whole plan stops and the FRESH disclosure travels back, so the panel can render the
        // "your acknowledgement no longer applies" recovery rather than a bare refusal.
        return json(200, {
          executed: false,
          blocked:
            `step ${i + 1} deposits into ${vdisc.vault.label}, whose owner holds powers over your deposit. ` +
            `That has to be acknowledged before the plan runs. Nothing was executed.`,
          needsAck: true,
          vaultDisclosures: { [i]: vdisc },
        });
      }
      ackFor[i] = vdisc.ackToken;
    }
  }

  // ── Execute in order; STOP at the first cap/ceiling breach or failure ──────
  const results = [];
  let stoppedAt = null;
  let runningA = 0;                                // micro-USDC committed by THIS plan

  // ═══ ⭐⭐ PROTECT THE QUOTE BEFORE THE FIRST STEP RUNS ═══════════════════════════════════════════
  // Receipts are permanent; quotes expire at 14 days. So an EXECUTED plan's join dies on a timer
  // unless the quote is marked — and the mark must happen BEFORE any receipt is written, so every
  // receipt can carry whether it succeeded.
  //
  // ⚠️ MARKED AT COMMITMENT, NOT AT SUCCESS. The quote has been used the moment we pass the pre-flight
  // and begin executing, regardless of whether a step later fails: a plan that burned and then blocked
  // still has receipts pointing here. Marking on success would leave exactly the partial runs — the
  // ones most worth investigating — with the join unprotected.
  //
  // 🚨 A FAILED MARK MUST NOT ABORT THE PLAN. This is bookkeeping; money movement does not get
  // unwound by it, and refusing to bridge because a marker write failed would be a far worse trade.
  // The failure is LOUD in the log (markQuoteUsed warns) and RECORDED on each receipt below, so a
  // later reader can distinguish "the quote expired despite protection" — a real anomaly — from "the
  // quote was never protected", which is explained. An absent quote makes those look identical.
  const quotePromoted = quoteId ? await markQuoteUsed(session.address, quoteId) : null;
  if (quoteId && !quotePromoted) {
    console.warn(`[agent-plan] QUOTE NOT PROTECTED quoteId=${quoteId} — receipts will record quotePromoted=false`);
  }

  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    const vA = atomic(values[i]);

    // (1) PER-ACTION cap — each step by its own type (bridge → per-bridge cap, vault deposit →
    //     per-vault-deposit cap, else send cap). Stop here, never skip-and-continue.
    // ⛔ THE MESSAGE READS THE SAME HELPER THE CHECK DID. It used to re-derive the bound inline as
    // `isBridge ? bcap : cap` — a SECOND copy of the selection, sitting one line from the first,
    // and one that would go on naming the send cap for a vault step after capForA stopped doing so.
    // A refusal must report the quantity the test actually compared.
    // [[refusal-reports-compared-quantity]] · [[duplicate-source-of-truth-is-the-recurring-bug]]
    if (vA > capForA(step)) {
      results.push({ index: i, step, ok: false, blocked: `step ~${usd2(values[i])} exceeds per-${capLabelForA(step)} limit of ${capUsdcFor(step)} USDC` });
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
      // ⭐ AND THE OPENED SEAL'S TOKEN — the executor opens it again (pure, no I/O) and signs THAT
      // fee. Without it a session caller is refused (`quoteRequired`), by design.
      const stepIn = step?.type === "bridge_usdc" ? { ...step, quoteToken: (quoteTokens || {})[i] } : step;
      const r = await executeAction(ackFor[i] ? { ...stepIn, ackToken: ackFor[i] } : stepIn, actx);
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
        await recordBridge({ r, session, event, amountRequested: step.amountUsdc, quoteId, stepIndex: i, quotePromoted });
      }
      runningA += vA;                              // commit: decrement remaining daily budget
    } catch (e) {
      // ⭐ A PENDING BRIDGE INSIDE A PLAN HAS THE SAME GAP AS THE DIRECT PATH, AND IT IS
      // WORSE HERE: the plan halts, so the step renders ✗ with an error while a userOp may
      // still be in flight. Without this write, the plan reports a failure for a bridge that
      // was SUBMITTED — and the consent the user gave for it is recorded nowhere.
      // Keyed on the txId and joined to the quote, exactly like the confirmed path.
      if (e instanceof TxPendingError) {
        await recordPendingBridge({ e, session, amountRequested: step.amountUsdc, quoteId, stepIndex: i, quotePromoted });
      }
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
  const stepsRun = results.filter((r) => r.ok).length;
  return json(200, {
    // ═══ ⛔⛔ TRUE IN EVERY CASE — IT WAS A HARDCODED `true` ═══════════════════════════════════
    // This literal meant "the executor phase was entered", which is not what the word says. A plan
    // refused at the FIRST step answered `executed: true` having moved nothing — measured live
    // 2026-09-05: `executed:true, stepsRun:0, stoppedAt:0, completed:false`, receipts unchanged.
    // ⭐ The name was false in exactly the case a reader most needs it true, and a monitor keyed on
    // it would have reported a healthy run during a total refusal. plan-path-watch had to route
    // around the field entirely; this is the field catching up to its own name.
    // ⚠️ NOT A RENAME. Renaming would break every client for a field whose MEANING was the bug —
    // the honest fix is to make the existing name true. [[field-name-must-be-true-in-every-case]]
    executed: stepsRun > 0,
    completed: allOk,
    quoteId,
    totalUsdc,
    ceiling,
    stoppedAt,          // null if all ran; else the index that stopped the plan
    stepsRun,
    stepsTotal: plan.length,
    // ⭐⭐ THE STOPPING REASON, HOISTED — AND THIS WAS A USER-FACING HOLE. It lived only in
    // `results[stoppedAt].blocked`, and the panel renders a TOP-LEVEL `blocked` which this response
    // never carried. So a plan refused at the per-bridge cap told the user "Stopped at step 1" and
    // NEVER SAID WHY, while the reason sat in the payload unread.
    // ⚠️ Null when every step ran, so its presence means "something stopped this" rather than
    // needing a reader to compare it against `completed`.
    blocked: stoppedAt === null ? null : (results[stoppedAt]?.blocked ?? results[stoppedAt]?.error ?? null),
    results,
  });
}
