import { internalToken } from "./_auth.mjs";
import { usdcDecimalToMinorExact } from "./_fee-reconcile.mjs";
import { writeReceiptNeverThrows, writePendingReceiptNeverThrows, SUBMITTED_STATE, PENDING_STAGES, ackTokenFingerprint, readPendingReceipt, retirePendingReceipt } from "./_bridge-receipts.mjs";

// RECORD A BRIDGE — the write-and-trigger pair, in ONE place, called from the HTTP
// boundaries that own it.
//
// ══ WHY THIS IS AT THE BOUNDARY AND NOT IN executeAction ═══════════════════════════
// The obvious move is to put this inside the shared executor so every bridge is covered
// automatically. That is WRONG here, and the reason is worth keeping:
//
// 🚨 `job-bridge-approve` ALREADY HAS A COMPLETE RECEIPT SYSTEM — its own record in the
// `job-deliverables` store, its own verifier (job-bridge-receipt-background.mjs), its own
// four states, and an `approving` lock, all adversarially proven. It also calls
// executeAction. So a write inside the executor would give every plan-path bridge a
// SECOND receipt in a SECOND store, drifting independently — the duplicate-source-of-truth
// failure introduced one layer down, where it is harder to see.
//
// The exclusion is deliberate, which is exactly why the boundary is the right home: only
// the callers that DON'T already record a bridge call this.
//
//   agent-bridge.mjs        → calls this (Bridge page + agent single-action)
//   agent-execute-plan.mjs  → calls this (multi-step plans)
//   job-bridge-approve.mjs  → does NOT, and must not: it has its own
//
// ⚠️ It also cannot live in executeAction mechanically: the settle trigger needs a base
// URL from the request, and `ctx` carries {walletAddress, session} with no `event`.
// Threading `event` into a shared money-path executor for one branch's benefit is the
// wrong direction.
//
// ══ WHAT THIS GUARANTEES ══════════════════════════════════════════════════════════
// · The write CANNOT fail the caller. It runs after the burn has landed, so an error
//   surfacing here would report a failure for a bridge that succeeded — and the user
//   would retry and burn twice. Everything is swallowed; callers must NOT branch on the
//   return except for logging.
// · Every field is SERVER-SOURCED: amounts and fee from executeAction's own return
//   (priced live inside it), owner from the verified session, recipient from the
//   server-resolved agent wallet. Nothing a client sent lands in a receipt.
// · `delivery: "predicted"` is the honest state at this instant — netPredicted is
//   arithmetic (amount − maxFee), not an observation. ONLY the settler's
//   destination-chain read may promote it to "measured".

/** Kick the settler and wait only for its 202 ack. See the block comment in
 *  agent-bridge.mjs history: an UN-AWAITED fetch is often never sent, because a Netlify
 *  function can freeze the moment the handler returns. That bug stranded a receipt for
 *  7h58m. Awaiting costs one in-region round trip; the 4-minute poll still runs off the
 *  request, inside the background function. */
async function triggerSettle({ event, owner, burnHash }) {
  try {
    const base =
      process.env.DEPLOY_URL ||
      `${event?.headers?.["x-forwarded-proto"] || "https"}://${event?.headers?.host}`;
    const res = await fetch(`${base}/.netlify/functions/bridge-mint-settle-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ owner, burnHash }),
    });
    console.log(`[bridge-receipt] settle trigger sent burnHash=${burnHash} status=${res.status}`);
    return true;
  } catch (e) {
    // Swallowed: the settler is an optimisation over the client's own polling, never a
    // precondition for the bridge having worked. A trigger failure must not fail a bridge
    // whose money already moved — and the sweeper will pick it up within 10 minutes.
    console.warn(`[bridge-receipt] settle trigger FAILED (swallowed) burnHash=${burnHash}: ${e?.message}`);
    return false;
  }
}

/**
 * Kick the post-burn FEE RECONCILIATION. Same awaited-202 shape as `triggerSettle` and for the
 * same measured reason: an un-awaited fetch from a handler that then returns may never be sent.
 *
 * ⭐ A SEPARATE TRIGGER, NOT A STAGE OF THE SETTLER. The settler polls the DESTINATION for up to
 * four minutes and may exit early (lease held, already resolved); the fee reading is one source-
 * chain receipt fetch that should not wait behind that, or be skipped when the settler returns
 * early. And the settler writes back a t0 snapshot of the receipt at the end of its poll, which is
 * why the verdict lives under its own key rather than on the record.
 *
 * ⚠️ SWALLOWED, LIKE THE SETTLE TRIGGER. This is a DETECTOR: the burn already happened and the
 * money already moved. A failed trigger must never fail a bridge that succeeded — and an
 * unreconciled receipt is exactly what every receipt looked like before today.
 *
 * ═══ ⛔ `job-bridge-approve` IS OUT OF SCOPE, AND IT IS THE SAME EXCLUSION AS THE ONE ABOVE ═════
 * The plan path has its own receipt system in its own store, with its own verifier and its own
 * four states. Reconciling its bridges from here would need a second reader over a second record
 * shape — a duplicate of this whole mechanism, drifting independently, which is precisely the
 * reasoning that keeps the receipt write itself at this boundary rather than in the executor.
 * ⚠️ SO ITS BRIDGES CARRY NO FEE VERDICT AT ALL, AND THAT IS A DECISION, NOT AN OVERSIGHT.
 * Extending the reconciliation to that path is a separate piece of work; whoever does it should
 * add the trigger where THAT system writes its receipt, not here.
 */
async function triggerFeeReconcile({ event, owner, burnHash }) {
  try {
    const base =
      process.env.DEPLOY_URL ||
      `${event?.headers?.["x-forwarded-proto"] || "https"}://${event?.headers?.host}`;
    const res = await fetch(`${base}/.netlify/functions/bridge-fee-reconcile-background`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken() },
      body: JSON.stringify({ owner, burnHash }),
    });
    console.log(`[bridge-receipt] fee-reconcile trigger sent burnHash=${burnHash} status=${res.status}`);
    return true;
  } catch (e) {
    console.warn(`[bridge-receipt] fee-reconcile trigger FAILED (swallowed) burnHash=${burnHash}: ${e?.message}`);
    return false;
  }
}

/**
 * Write the receipt for a completed bridge and ask the settler to verify it.
 *
 * @param r        executeAction's bridge return ({ burnHash, tx, destination, feeUsdc,
 *                 netUsdc, recipient, feeBand, feeCharged, feeDisclosed, ackRequired, acknowledged,
 *                 ackToken })
 * @param session  the verified session — `session.address` is the receipt's owner
 * @param event    the request, for the settle trigger's base URL
 * @param amountRequested  the amount the caller asked to bridge
 * @param quoteId  OPTIONAL join key to the priced plan in the `agent-quotes` store, or null
 *                 on a path that had no quote (the direct Bridge page). See below.
 * @param stepIndex which step of that plan this was, or null outside a plan.
 *
 * No-ops without a burnHash: the 202 TxPendingError path has no hash to key on, so there
 * is nothing to record and today's behaviour is preserved.
 */
// ═══ ⭐⭐ THE FEE PAIR — ONE PLACE, SO NO WRITER CAN MIX SOURCES ═══════════════════════════════
// Every write path takes its fees through here. Three writers each mapping fields by hand is how
// `feeUsdc` came from one quote and `feeRatio` from another in the first place.
//
//   feeCharged   — what was actually taken: the fee signed into the calldata. `null` when the
//                  signing call threw and the value is genuinely unknown — never a stand-in.
//   feeDisclosed — what the consent decision was made against: the fee the band gate evaluated.
//
// ⚠️ NOT "feeAcknowledged": at band `none` nothing is acknowledged, so that name would be false on
// most receipts. "Disclosed" is true at every band.
//
// 🚨 NO `feeRatio` IS STORED. It is `feeDisclosed / amountRequested`, both already on the record.
// Storing it duplicated a derivable value, and the defect was that duplicate disagreeing with its
// source. Derived at read time by `bridgeReceiptRatio` below.
//
// ⭐ THE INVARIANT, ASSERTED BEFORE ANYTHING ENFORCES IT: you may be charged less than you were
// shown, never more. Nothing enforces `feeCharged <= feeDisclosed` yet — consent-fee-binding is the
// work that will. Checking it HERE means a violation is a loud finding today rather than a surprise
// when that lands. ⛔ It does NOT refuse: a receipt must be written even when it is surprising, or
// the money moves with no record at all. It shouts and stores the truth.
function feePair(src, { burnHash } = {}) {
  const charged = src?.feeCharged ?? null;
  const disclosed = src?.feeDisclosed ?? null;
  if (typeof charged === "number" && typeof disclosed === "number" && charged > disclosed) {
    console.error(
      `[bridge-receipt] 🚨 FEE INVARIANT VIOLATED — charged ${charged} > disclosed ${disclosed}` +
      `${burnHash ? ` on ${burnHash}` : ""}. The user was charged MORE than they were shown.`
    );
  }
  // 🚨🚨 THE TWO DISCLOSED FIGURES MUST BE THE SAME QUANTITY IN TWO UNITS — CHECKED AT THE WRITE.
  //
  // `feeDisclosed` (decimal, what the user saw) and `feeDisclosedMinor` (integer, what the post-burn
  // reconciliation compares) come from ONE quote object. They cannot legitimately disagree.
  //
  // ⛔ THE INVERSION THIS CATCHES IS AHEAD OF US. Under CCTP upfront fees the burn's `maxFee` becomes
  // EMPTY_MAX_FEE — zero, measured on-chain — and the real fee moves to the quote's
  // `feeTotalAmount`. A migration that leaves this writer pointed at `maxFee` would store `"0"` here
  // beside a real decimal, and EVERY bridge would reconcile MISMATCHED: a permanent alarm blaming
  // Circle for our own field drift. ⭐ The reader turns that into `disclosed_incoherent`
  // (an `unreadable`, not a `mismatched`); this shouts at the point the record is CREATED, which is
  // the only place the writer can be identified.
  // ⛔ IT DOES NOT REFUSE, for the same reason the charged>disclosed check does not: the money has
  // already moved, and a receipt must be written even when it is surprising.
  const minorStr = typeof src?.feeDisclosedMinor === "string" ? src.feeDisclosedMinor : null;
  if (minorStr !== null && typeof disclosed === "number") {
    const fromDecimal = usdcDecimalToMinorExact(disclosed);
    if (fromDecimal !== null && fromDecimal !== BigInt(minorStr)) {
      console.error(
        `[bridge-receipt] 🚨 DISCLOSED FEE INCOHERENT — feeDisclosed ${disclosed} USDC is ` +
        `${fromDecimal} minor, but feeDisclosedMinor says ${minorStr}` +
        `${burnHash ? ` on ${burnHash}` : ""}. The two are one quantity in two units and a writer ` +
        `has pointed them at different fields. The fee reconciliation will read this as ` +
        `\`disclosed_incoherent\` rather than as an overcharge.`
      );
    }
  }
  return {
    feeCharged: charged,
    feeDisclosed: disclosed,
    // ⭐⭐ THE DISCLOSED FIGURE IN MINOR UNITS — THE QUANTITY THE POST-BURN COMPARISON IS MADE IN.
    // A chain log's value is an integer of minor units; `feeDisclosed` is a decimal Number. Storing
    // the quote's OWN integer means the reconciliation never converts, so there is no rounding to
    // get right and no float to be off by one in. [[compute conversions, never type them]] is best
    // satisfied by not converting at all.
    // ⚠️ NULL, NEVER A CONVERSION MADE HERE. A record that predates this field is handled by
    // `disclosedFeeMinor` in _fee-reconcile.mjs, which converts EXACTLY or refuses — and a refusal
    // there is a visible `disclosed_not_exact` verdict rather than a quiet rounding in this writer.
    feeDisclosedMinor: typeof src?.feeDisclosedMinor === "string" ? src.feeDisclosedMinor : null,
  };
}

/** The ratio the BAND was computed from, derived — never stored. Reads legacy records too.
 *  ⭐ It derives from the DISCLOSED fee, not the charged one, so the record explains its own
 *  `ackBand`: a ratio taken from the charged fee could not reproduce a band computed from the
 *  disclosed one. ⚠️ `feeUsdc` is the pre-2026-08-30 field name; older receipts carry only it. */
export function bridgeReceiptRatio(r) {
  const amount = Number(r?.amountRequested);
  const fee = r?.feeDisclosed ?? r?.feeUsdc ?? null;
  if (!Number.isFinite(amount) || amount <= 0 || typeof fee !== "number") return null;
  return fee / amount;
}

export async function recordBridge({ r, session, event, amountRequested, quoteId = null, stepIndex = null, quotePromoted = null }) {
  if (!r?.burnHash) return { recorded: false, reason: "no_burn_hash" };

  const burnedAt = new Date().toISOString();
  const write = await writeReceiptNeverThrows({
    schema: "bridge-receipt/1",
    owner: session.address,
    burnHash: r.burnHash,
    burnTx: r.tx,
    burnedAt,
    state: "burn_confirmed",
    destinationKey: r.destination?.key,
    destinationLabel: r.destination?.label,
    recipient: r.recipient,
    // ⭐⭐ WHICH WALLET PAID. NOT `owner` — the spender is the caller's SCA and the owner is the
    // session address, and nothing here can derive one from the other. The post-burn fee reading
    // scopes the Arc logs to this address, because a bundler may batch several userOps into one
    // transaction and the receipt would then carry another wallet's movements too.
    // ⚠️ NULL IS A REAL STATE AND MUST NOT READ AS SAFE: every receipt written before this field
    // existed carries null, and the reconciliation refuses those with `payer_unknown` rather than
    // guessing the owner. Absence must not read as safe — including the absence of a payer.
    payer: r.payer ?? null,
    amountRequested: Number(amountRequested),
    ...feePair(r, { burnHash: r.burnHash }),
    netPredicted: r.netUsdc,   // pairs with feeCharged; null when the signed quote is unknown
    delivery: "predicted",
    amountDelivered: null,
    // ⭐ THE GATE LEAVES EVIDENCE. Without these the receipt cannot answer "was the user
    // warned, and did they accept?" — for a disclosure whose whole purpose is consent to
    // lose most of the amount, that belongs in the record, not in someone's memory of
    // what the screen said. `acknowledged` is true only because the server recomputed the
    // token and it matched.
    //
    // 🚨 WHAT `ackAcceptedAt` ACTUALLY WITNESSES — READ THIS BEFORE TRUSTING IT AS CONSENT.
    // Its value is derived from the BAND at execution time (`acknowledged` is
    // `bandInfo.band === "acknowledge"` in _actions.mjs), NOT from the token. What makes it
    // mean "the user accepted" is that the caller could not have REACHED this line without a
    // matching token: _actions refuses on mismatch ~25 lines above, and on the plan path
    // agent-execute-plan's pre-flight refuses the whole plan before step 1. So the claim is
    // carried by a REFUSAL — one of them in a different module — and arrives here only
    // transitively, through control flow rather than through the value itself.
    //
    // ⭐ THE CONSEQUENCE: weaken or bypass either refusal and this field keeps being written,
    // keeps reading as acceptance, and silently stops being evidence of any. Nothing here
    // would change; no test of THIS module would fail. The name asserts something its own
    // derivation does not establish — the composite-claim shape, where the confidence comes
    // from one place and the value from another.
    // Pinned in verify-bridge-fee-band.mjs §9: the two refusals must PRECEDE the code that
    // can produce `acknowledged`, which is the property this field actually rests on.
    ackBand: r.feeBand ?? null,
    ackRequired: r.ackRequired ?? false,
    ackAcceptedAt: r.acknowledged ? burnedAt : null,
    // ⭐⭐ THE FINGERPRINT, NOT THE TOKEN — EVIDENCE WITHOUT CAPABILITY.
    // A receipt is permanent, and now that the token is HMAC-keyed it is a real bearer credential:
    // storing it raw would let every reader of a receipt satisfy the acknowledge gate for that exact
    // bridge shape, forever. The hash keeps what matters — anyone holding the token, or the server
    // able to recompute it, can prove THIS token was the one presented — while the record grants
    // nothing.
    // ⚠️ THE ARGUMENT WAS ALREADY WRITTEN AT agent-act, WHICH REFUSES TO STORE THE TOKEN ON THE QUOTE
    // ("a record is a poor place for a credential"). The receipt disagreed with the quote about the
    // same value; this ends that disagreement on the side of the DURABLE record, where it matters more.
    // ⚠️ null stays null: "no acknowledgment was required" must not become a real-looking hash of "".
    ackTokenHash: ackTokenFingerprint(r.ackToken ?? null),
    // ⭐ THE JOIN TO WHAT WAS PROPOSED. Every other field here says what the bridge DID; these
    // two say which priced plan it came from, so `agent-quotes` and this receipt can be read
    // together. Without a shared identifier they are two records nobody can correlate, which
    // is the state that left the 2026-08-01 ack anomaly unanswerable.
    //
    // 🚨 NULL IS NORMAL AND MEANS NOTHING BAD. The direct Bridge page and the agent
    // single-action panel produce no plan quote, so their receipts carry null here. An
    // absent join must never be read as a defect — and, like the rest of this pair, it is
    // DIAGNOSTIC: no gate anywhere reads `quoteId`.
    quoteId: quoteId ?? null,
    quoteStepIndex: Number.isInteger(stepIndex) ? stepIndex : null,
    // ⭐ DID THE QUOTE GET PROTECTED FROM THE PRUNE? Written from the ACTUAL result of the mark, not
    // from the intent to make one. `true` = the quote is exempt from the 14-day age prune, so a later
    // missing quote is a real anomaly. `false` = the mark failed and this join WILL break on schedule
    // — expected, explained, not a mystery. `null` means one of TWO things, disambiguated by
    // `quoteId`: with `quoteId: null` there was no quote at all (the direct Bridge page); with a
    // `quoteId` PRESENT it is a receipt written BEFORE this field existed (every receipt up to and
    // including 2026-08-17). ⚠️ Those are not the same, and the pair must be read together — a
    // three-state field whose null is overloaded is how a reader invents a fourth state.
    // 🚨 Without this field those three are indistinguishable once the quote is gone, and the reader
    // is left unable to tell a broken system from a working one.
    quotePromoted: typeof quotePromoted === "boolean" ? quotePromoted : null,
  });

  await triggerSettle({ event, owner: session.address, burnHash: r.burnHash });
  // ⭐ RUN ONCE, PROMPTLY. Retention only ever makes the burn harder to read, so the reading taken
  // now is the best one this system will ever have — and the verdict is stored rather than
  // re-derived, because re-deriving on every view would decay a real `matched` into `unreadable`
  // as the burn ages, the record getting worse while appearing to be checked each time.
  await triggerFeeReconcile({ event, owner: session.address, burnHash: r.burnHash });
  return { recorded: write.written === true, burnedAt };
}

/**
 * THE PROVISIONAL RECORD — written when the burn is SUBMITTED but not confirmed (202).
 *
 * 🚨 THE OUTCOME THAT USED TO WRITE NOTHING. Success wrote a receipt; a band refusal wrote
 * nothing because nothing happened; and PENDING — the only state that actually needs
 * someone to follow up — also wrote nothing. Observed live 2026-08-14: a user accepted a
 * 53% fee, the server verified the token and submitted, and no record of that acceptance
 * existed anywhere.
 *
 * It writes TWO things at once, which is why it is one change rather than two:
 *   1. THE CONSENT EVIDENCE — band, ratio, and `ackAcceptedAt` for a disclosure that was
 *      genuinely accepted and acted upon.
 *   2. THE RECOVERY HOOK — a durable key carrying the Circle `txId`, so a later job can ask
 *      Circle what became of it and backfill the burn hash if it landed.
 *
 * ⚠️ `ackAcceptedAt` HERE MEANS "ACCEPTED AND ACTED UPON", NOT "MONEY MOVED". The gate ran
 * and the submission followed; whether the burn lands is a different question this record
 * exists to keep askable. Same transitive caveat as the confirmed receipt (see above): the
 * value is derived from the BAND, and it is a refusal elsewhere that makes it mean consent.
 *
 * NO SETTLE TRIGGER. There is no burn hash, so there is nothing for the settler to settle
 * and nothing for IRIS to be asked about. Triggering here would have it chase a mint for a
 * burn that may never exist.
 */
export async function recordPendingBridge({ e, session, amountRequested, quoteId = null, stepIndex = null, quotePromoted = null }) {
  const txId = e?.txId;
  if (!txId) return { recorded: false, reason: "no_tx_id" };
  const c = e?.consent || {};

  const submittedAt = new Date().toISOString();
  const write = await writePendingReceiptNeverThrows({
    schema: "bridge-receipt/1",
    owner: session.address,
    txId,
    // ⚠️ EXPLICITLY NULL, NOT ABSENT. A reader must be able to tell "no hash yet" from a
    // field nobody thought about — and the writer refuses any provisional receipt that
    // carries one, so this can never quietly become a confirmed receipt in place.
    burnHash: null,
    burnedAt: null,
    submittedAt,
    state: SUBMITTED_STATE,
    pendingReason: e?.message ?? null,
    // 🚨 WHICH AWAIT STALLED — the field a reconcile job cannot work without. `agentBridge` awaits
    // Circle twice (approve, then burn) and TxPendingError carries only an id, so without this the
    // txId cannot say whether its eventual txHash is an ALLOWANCE or a BURN. ⚠️ NULL WHEN UNKNOWN,
    // never defaulted to "burn": the reconcile job refuses an untagged record rather than guessing,
    // because a wrong guess writes a fabricated burnHash into a durable receipt.
    pendingStage: PENDING_STAGES.includes(e?.stage) ? e.stage : null,
    destinationKey: c.destinationKey ?? null,
    destinationLabel: c.destinationLabel ?? null,
    // Carried so a recovered receipt can be verified on the destination chain — see the note in
    // _actions.mjs on why its absence causes an unbounded re-check.
    recipient: c.recipient ?? null,
    // Carried on the provisional record too, so a bridge reconciled from a 202 gets the same fee
    // reading a confirmed one does. See the note on the confirmed writer above.
    payer: c.payer ?? null,
    amountRequested: Number(amountRequested),
    ...feePair(c, { burnHash: c.burnHash }),
    netPredicted: c.netUsdc ?? null,
    delivery: "predicted",
    amountDelivered: null,
    ackBand: c.feeBand ?? null,
    ackRequired: c.ackRequired ?? false,
    ackAcceptedAt: c.acknowledged ? submittedAt : null,
    // ⭐⭐ THE FINGERPRINT, NOT THE TOKEN — EVIDENCE WITHOUT CAPABILITY.
    // A receipt is permanent, and now that the token is HMAC-keyed it is a real bearer credential:
    // storing it raw would let every reader of a receipt satisfy the acknowledge gate for that exact
    // bridge shape, forever. The hash keeps what matters — anyone holding the token, or the server
    // able to recompute it, can prove THIS token was the one presented — while the record grants
    // nothing.
    // ⚠️ THE ARGUMENT WAS ALREADY WRITTEN AT agent-act, WHICH REFUSES TO STORE THE TOKEN ON THE QUOTE
    // ("a record is a poor place for a credential"). The receipt disagreed with the quote about the
    // same value; this ends that disagreement on the side of the DURABLE record, where it matters more.
    // ⚠️ null stays null: "no acknowledgment was required" must not become a real-looking hash of "".
    ackTokenHash: ackTokenFingerprint(c.ackToken ?? null),
    quoteId: quoteId ?? null,
    quoteStepIndex: Number.isInteger(stepIndex) ? stepIndex : null,
    // ⭐ DID THE QUOTE GET PROTECTED FROM THE PRUNE? Written from the ACTUAL result of the mark, not
    // from the intent to make one. `true` = the quote is exempt from the 14-day age prune, so a later
    // missing quote is a real anomaly. `false` = the mark failed and this join WILL break on schedule
    // — expected, explained, not a mystery. `null` means one of TWO things, disambiguated by
    // `quoteId`: with `quoteId: null` there was no quote at all (the direct Bridge page); with a
    // `quoteId` PRESENT it is a receipt written BEFORE this field existed (every receipt up to and
    // including 2026-08-17). ⚠️ Those are not the same, and the pair must be read together — a
    // three-state field whose null is overloaded is how a reader invents a fourth state.
    // 🚨 Without this field those three are indistinguishable once the quote is gone, and the reader
    // is left unable to tell a broken system from a working one.
    quotePromoted: typeof quotePromoted === "boolean" ? quotePromoted : null,
  });

  return { recorded: write.written === true, submittedAt, txId };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⭐⭐ THE USER-SIGNED PATH — ONE WRITER, A SECOND INPUT ADAPTER
// ══════════════════════════════════════════════════════════════════════════════════════════════
// `recordBridge` above takes a Circle-shaped `r`. The user-signed path produces a viem-shaped
// result instead. The choice made here is deliberately NOT a second writer:
//
//   ⛔ TWO WRITERS WOULD DRIFT. Every field in a receipt — `delivery`, `ackTokenHash`, the
//      predicted/measured split — is load-bearing for a reader who cannot see which path produced
//      it. A second copy of that shape is [[duplicate-source-of-truth-is-the-recurring-bug]] on a
//      permanent record.
//   ⭐ SO THESE FUNCTIONS ADAPT INPUTS AND DELEGATE. `promoteUserBridge` builds the same `r` the
//      agent path builds and calls `recordBridge` — the identical writer, the identical fields,
//      the identical settle trigger.
//
// 🚨 AND THE CONSENT PROPERTY TRAVELS WITH IT. `ackAcceptedAt` is written from `r.acknowledged`,
// which is evidence ONLY because a refusal made it unreachable without a matching token. For this
// path that refusal is `priceAndGate()` in _user-bridge.mjs, and it must precede every call below.
// scripts/verify-bridge-fee-band.mjs §9 pins that ordering for BOTH paths — a writer added outside
// that assertion silently unpins the property the field depends on.

/**
 * The intent record, written BEFORE the user signs.
 *
 * ⚠️ NO burnHash, AND THAT IS NOT AN OMISSION — nothing has been submitted. It reuses the
 * provisional `tx-` key layout, so it is excluded from mint recovery by name (a settler handed a
 * receipt with no burn hash would chase a mint for a burn that may never exist).
 *
 * ⭐ WHAT IT IS FOR: if the user signs and never returns, this is the only record that the attempt
 * happened, who owns it, what they consented to, and where the funds were going. Without it the
 * burn is on chain and unattributable.
 */
export async function recordUserPendingBridge({ session, amountRequested, consent }) {
  const submittedAt = new Date().toISOString();
  // A client-independent id: the intent is OURS, not something the caller may name.
  const intentId = `user-${Date.now().toString(36)}-${Math.abs(hashString(`${session.address}|${submittedAt}`)).toString(36)}`;
  const c = consent || {};

  const write = await writePendingReceiptNeverThrows({
    schema: "bridge-receipt/1",
    owner: session.address,
    txId: intentId,
    origin: "user-signed",           // ⭐ the discriminator a reader needs; agent receipts lack it
    burnHash: null,
    burnedAt: null,
    submittedAt,
    state: SUBMITTED_STATE,
    pendingReason: "awaiting user signature",
    pendingStage: "burn",            // there is no ambiguity here: the approve is a separate tx
    destinationKey: c.destinationKey ?? null,
    destinationLabel: c.destinationLabel ?? null,
    recipient: c.recipient ?? null,
    amountRequested: Number(amountRequested),
    ...feePair(c, { burnHash: c.burnHash }),
    netPredicted: c.netUsdc ?? null,
    delivery: "predicted",
    amountDelivered: null,
    ackBand: c.feeBand ?? null,
    ackRequired: c.ackRequired ?? false,
    ackAcceptedAt: c.acknowledged ? submittedAt : null,
    ackTokenHash: ackTokenFingerprint(c.ackToken ?? null),
  });
  return { recorded: write.written === true, intentId, submittedAt };
}

/**
 * Promote a signed intent into a real receipt.
 *
 * ⚠️ THE CALLER MUST HAVE VERIFIED THE BURN ON CHAIN FIRST (`verifyBurnOnArc`). This function does
 * not re-verify: it is the WRITER, and putting the chain check here as well would split the
 * security property across two modules. The endpoint refuses before reaching this line.
 *
 * ⭐ Write-then-retire, matching the existing rule: the durable receipt lands under the real burn
 * hash FIRST and the provisional key is removed after. Delete-first risks losing the record.
 */
export async function promoteUserBridge({ session, intentId, burnHash, burnTx, event }) {
  const pending = await readPendingReceipt(session.address, intentId);
  if (!pending) return { ok: false, status: 404, reason: "intent_not_found" };
  const lower = (a) => String(a || "").toLowerCase();
  if (pending.owner && lower(pending.owner) !== lower(session.address))
    return { ok: false, status: 403, reason: "intent_not_owned" };

  // Rebuild the SAME `r` the agent path builds — so one writer sees one shape.
  const r = {
    burnHash,
    tx: burnTx,
    destination: { key: pending.destinationKey, label: pending.destinationLabel },
    recipient: pending.recipient,
    // ⭐ THE MANUAL PATH PRICES ONCE. `priceAndGate` returns the burn calldata built from the SAME
    // quote it gated, so the charged and disclosed fees are the same number BY CONSTRUCTION — not
    // by coincidence, and not something that can drift. Both are set from it explicitly rather than
    // one being left to default, so a reader never has to infer which quote a blank meant.
    feeCharged: pending.feeCharged ?? pending.feeUsdc,
    feeDisclosed: pending.feeDisclosed ?? pending.feeUsdc,
    // ⭐ CARRIED FROM THE INTENT, NOT RE-PRICED. Same rule as the fee pair beside it: the figures a
    // promotion writes must be the ones the user was gated against, not a fresh quote taken now.
    feeDisclosedMinor: typeof pending.feeDisclosedMinor === "string" ? pending.feeDisclosedMinor : null,
    payer: pending.payer ?? null,
    netUsdc: pending.netPredicted,
    feeBand: pending.ackBand,
    ackRequired: pending.ackRequired,
    // ⭐ CARRIED FROM THE INTENT, NOT RECOMPUTED. The refusal that makes this meaningful ran in
    // user-bridge-start before the intent was written; recomputing it here would assert consent
    // from a request the user never saw a disclosure for.
    acknowledged: pending.ackAcceptedAt != null,
    // ⚠️ NO `ackToken` FIELD AT ALL, not even an explicit null — verify-ack-token-keyed.mjs
    // asserts that this module contains no raw `ackToken:` anywhere, and it is right to: the
    // property is "a raw token never reaches the durable record", and a null placeholder is a
    // slot someone later fills. recordBridge reads `r.ackToken ?? null` into the FINGERPRINT, so
    // omitting it yields exactly the same stored value with no field to misuse.
    // ⭐ The intent record already holds the fingerprint; this promotion does not re-derive it.
  };

  const rec = await recordBridge({ r, session, event, amountRequested: pending.amountRequested });
  if (!rec.recorded) return { ok: false, status: 500, reason: rec.reason ?? "receipt_write_failed" };

  await retirePendingReceipt(session.address, intentId);
  return { ok: true, state: "burn_confirmed", netPredicted: pending.netPredicted };
}

/** Small non-crypto id helper — used only to make an intent id unguessable-ish, never for auth. */
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}
