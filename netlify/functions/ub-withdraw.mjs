import { randomUUID } from "node:crypto";
import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet, WALLET_PROVISIONING_STATUS, walletProvisioningRefusal, WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal } from "./_agent-wallets.mjs";
import { readExitState, ubInitiateWithdrawal } from "./_ubwithdraw.mjs";
import { createRecord, patchRecord, listByOwner, STATE, blocksNewWithdrawal } from "./_ubwithdraw-record.mjs";

// UB WITHDRAW — the front door for the unified-balance EXIT.
//
//   GET  /api/ub-withdraw   → this caller's exit state + their open withdrawals
//   POST /api/ub-withdraw   { amountUsdc } → starts the ~7 day clock
//
// ═══ ⭐ THIS IS A RECLAIM, NOT A SPEND — so the agent's controls do NOT apply ══════════
// Deliberately does NOT call assertNotPaused, canSpendDay, sendCapUsdc or recordAgentSpend.
// Those bound what the AGENT may spend; they must never bound what the USER may RECLAIM.
// A PAUSED agent must not be able to trap someone's money — that would rebuild the custody
// problem one layer down. Exactly the reasoning agent-withdraw already states for the SCA's
// plain balance; this is the same argument one layer up, for the Gateway balance.
//
// ⚠️ REMOVING THOSE GUARDS NARROWS THE SURFACE RATHER THAN WIDENING IT. There is no `to`
// parameter and no destination of any kind: `withdraw(address)` takes no beneficiary, so the
// funds can only ever land in the caller's OWN SCA. There is nowhere in this file for a
// caller-supplied address to enter, so a stolen session gains nothing it did not already have.
//
// ═══ 🚨 THE RECORD IS WRITTEN BEFORE THE CHAIN CALL ══════════════════════════════════
// The sweeper scans RECORDS, not the chain. An initiation with no record is a clock running
// that nothing will finish — the user believes they are leaving and nobody completes it.
// So: record first, chain call second. If this function dies between them (or Netlify's 10s
// ceiling cuts it), the record survives in `initiating` and the sweeper RECONCILES it
// against the chain on its next tick. The natural order loses exactly the case that costs
// the user their exit.
// ⭐ That reconcile path is why this can stay SYNCHRONOUS despite the 10s ceiling: a timeout
// is not a lost withdrawal, it is a record the sweeper picks up.
//
// ═══ ⚠️ WHAT "SUCCESS" HERE DOES NOT MEAN ════════════════════════════════════════════
// A 202 from this endpoint means the clock has STARTED. It does not mean the money moved,
// and completion does not mean the money reached the user — `withdraw` lands funds in the
// SCA, and returning them to the login wallet is a separate step (agent-withdraw). Every
// response below says so, because this is the exact place a reassuring half-truth would be
// most tempting and most damaging.

const parseBody = (event) => { try { return JSON.parse(event.body || "{}"); } catch { return {}; } };

/** One place, so GET and POST cannot describe the wait differently. */
const disclosure = (s) => ({
  waitDescription: "about seven days",
  // ⚠️ DERIVED AND APPROXIMATE. withdrawalDelay is in BLOCKS; 1209600 = 14 × 86400 is a
  // COINCIDENCE that has misled a reader before. Never render a precise duration.
  waitProvenance: s?.delayProvenance ?? null,
  delayBlocks: s?.delayBlocks ?? null,
  steps: [
    "1. you ask to withdraw — this starts a delay set by the Gateway contract, not by us",
    "2. after about seven days the amount becomes withdrawable",
    "3. we complete it automatically — you do NOT need to come back",
    "4. the funds arrive in your agent wallet; moving them to your login wallet is a separate step you control",
  ],
  automatic: "step 3 runs on a schedule. You do not need to return to finish leaving.",
});

export async function handler(event) {
  if (event.blobs) connectBlobs(event);

  const session = requireSession(event);
  if (!session) return json(401, { error: "Authentication required" });

  let wallet;
  // ⭐ A THROW HERE IS A REFUSAL, NOT A CRASH. Unwrapped it surfaced as a bare 500 that said
  // nothing about retryability or whether anything happened. See walletUnresolvableRefusal.
  try { wallet = await ensureOwnerWallet(session); }
  catch (e) { return json(WALLET_UNRESOLVABLE_STATUS, walletUnresolvableRefusal(e)); }
  // ⭐ 503, NOT 202 — see walletProvisioningRefusal() in _agent-wallets.mjs for the full reasoning.
  // One status code must not mean both "retry freely" and "you cannot undo this"; the 202 below
  // means an IRREVERSIBLE ~7-day clock has started, and this one means nothing happened at all.
  if (wallet.pending) return json(WALLET_PROVISIONING_STATUS, walletProvisioningRefusal());
  const owner = wallet.walletAddress;

  // ── GET: what can this caller see about their own exit? ────────────────────────────
  if (event.httpMethod === "GET") {
    const [state, mine] = await Promise.all([readExitState({ owner }), listByOwner({ owner })]);
    return json(200, {
      owner,
      // ⭐ TRI-STATE PRESERVED TO THE EDGE. `readable:false` must never be rendered as a zero
      // balance or as "nothing to withdraw" — that is the one lie that matters here.
      balance: state,
      withdrawals: mine.readable
        ? mine.rows
        : { unreadable: true, detail: "your withdrawals could not be read just now — this is NOT a statement that you have none" },
      counts: { matchedKeys: mine.matchedKeys, returned: mine.returned, skipped: mine.skipped },
      disclosure: disclosure(state),
    });
  }

  if (event.httpMethod !== "POST") return json(405, { error: "GET or POST only" });

  const { amountUsdc } = parseBody(event);
  const amount = Number(amountUsdc);
  if (!(amount > 0)) return json(400, { error: "amountUsdc must be > 0" });
  // ═══ 🚨 VALIDATE THE CONVERTED UNITS, NOT THE DECIMAL ═══════════════════════════════════
  // `amount > 0` and `Math.round(amount * 1e6) > 0` DISAGREE below 1e-6. A sub-atomic input like
  // 0.0000001 passed the decimal check, rounded to ZERO atomic units, and then: createRecord wrote
  // a record, ubInitiateWithdrawal threw on `units > 0n` BEFORE reaching the chain, and the record
  // was left `initiating` — which the sweeper deliberately never clears and the 409 guard counts as
  // open. One malformed input would have LOCKED THE USER OUT OF THEIR OWN EXIT permanently.
  // ⭐ Two representations of one quantity must be validated as one. Checking the decimal and then
  // acting on the atomic value is the duplicate-source-of-truth failure inside a single function.
  const units = BigInt(Math.round(amount * 1e6));
  if (units <= 0n) {
    return json(400, {
      error: "That amount is too small to withdraw. The smallest is 0.000001 USDC.",
      reason: "amount-below-one-atomic-unit",
      // ⚠️ Say that nothing happened: this refusal lands BEFORE any record is written.
      whatHappened: "nothing. No record was written and no funds moved.",
    });
  }

  // Read BEFORE writing anything, so an unreadable chain refuses cheaply.
  const state = await readExitState({ owner });
  if (!state.readable) {
    // ⭐ REFUSE, do not guess. Starting a seven-day clock against a balance we could not read
    // is the fail-open this codebase keeps closing: an absence must never satisfy a check.
    return json(503, {
      error: "We could not read your unified balance just now, so we have not started anything.",
      reason: "balance-unreadable",
      detail: state.detail,
      retryable: true,
    });
  }
  if (units > BigInt(state.availableAtomic)) {
    return json(400, {
      error: `You asked to withdraw ${amount} USDC but your unified balance holds ${state.availableUsdc} USDC.`,
      availableUsdc: state.availableUsdc,
    });
  }

  // ═══ 🚨 ONE OPEN WITHDRAWAL AT A TIME — THE SERVER'S JOB, NOT THE BUTTON'S ═══════════════
  // Until now nothing stopped a second POST. `randomUUID()` mints a fresh id, `createRecord`
  // writes a fresh record, and the only bound was `amount <= available` — so a double press with
  // 1.51 available started a SECOND independent seven-day clock.
  //
  // ⭐⭐ AND THE COST IS WORSE THAN TWO CLOCKS. Hop 2 is `withdraw(address)`: it takes NO amount and
  // sweeps everything matured in ONE transaction. Two records maturing together are completed by a
  // single tx — the sweeper marks one COMPLETED, and the second then reads withdrawable:0 →
  // "not-yet-matured" FOREVER, until it trips the overdue alert as a stuck withdrawal that is not
  // stuck. A double press manufactures a permanently-open record and a false page.
  //
  // ⭐ A DISABLED BUTTON CANNOT DO THIS. A refresh, a second tab, a stale session or a direct call
  // all bypass client state. The guard has to live where the money moves.
  //
  // ⚠️ FAIL CLOSED ON AN UNREADABLE LIST. If the store cannot be read we do NOT know whether one is
  // open, and starting a second clock on a guess is exactly the fail-open this codebase keeps
  // closing. An absence of evidence is not evidence of absence — refuse and let the caller retry.
  const mine = await listByOwner({ owner });
  if (!mine.readable) {
    return json(503, {
      error: "We couldn’t check your existing withdrawals, so we haven’t started anything.",
      reason: "withdrawals-unreadable",
      retryable: true,
      whatHappened: "nothing. No record was written and no funds moved. Retrying is safe.",
    });
  }
  // ⭐⭐ blocksNewWithdrawal, NOT OPEN_STATES. OPEN_STATES answers "must the SWEEPER keep watching
  // this?" — deliberately generous. This asks "could this be running a CLOCK?" and must be
  // narrower, or one unconfirmable record denies the exit forever. See _ubwithdraw-record.mjs.
  const alreadyOpen = mine.rows.filter((r) => blocksNewWithdrawal(r));
  if (alreadyOpen.length > 0) {
    const first = alreadyOpen[0];
    return json(409, {
      error: "You already have a withdrawal on its way out. We haven’t started another.",
      reason: "withdrawal-already-open",
      // ⭐ NAME THE EXISTING ONE. "You already have one" without saying which is what sends a user
      // looking for a second withdrawal that does not exist.
      existing: {
        withdrawalId: first.withdrawalId,
        amountUsdc: first.amountUsdc,
        state: first.state,
        maturesApprox: first.maturesApprox,
      },
      openCount: alreadyOpen.length,
      whatHappened: "nothing new. Your existing withdrawal is unaffected and still on its way.",
      // ⚠️ 409, not 400: this is a state conflict a caller can resolve by WAITING, not a malformed
      // request they should fix. And explicitly NOT retryable — retrying changes nothing until the
      // open one completes.
      retryable: false,
    });
  }

  // ═══ RECORD FIRST. See the header — this ordering is the design, not bookkeeping. ═══
  const withdrawalId = randomUUID();
  await createRecord({ owner, amountUsdc: amount, withdrawalId });
  // ⭐ THE MATURITY DATE IS WRITTEN AT CREATION, not derived later. It is the one fact a human
  // needs a week from now, and "recompute it from createdAt + delayBlocks" is exactly what nobody
  // does at the moment it matters. ⚠️ APPROXIMATE — derived from a BLOCK count, so it drifts with
  // block time and must never be rendered as a precise deadline.
  const maturesApprox = new Date(Date.now() + state.approxDelayDays * 86400 * 1000).toISOString();
  await patchRecord({ owner, withdrawalId, fields: {
    amountAtomic: units.toString(),
    delayBlocks: state.delayBlocks,
    approxDelayDays: state.approxDelayDays,
    maturesApprox,
  } });

  try {
    const res = await ubInitiateWithdrawal({ owner, amountUsdc: amount });
    await patchRecord({ owner, withdrawalId, fields: {
      state: STATE.WAITING,
      initiateTxHash: res.txHash,
      initiatedAt: new Date().toISOString(),
    } });
    return json(202, {
      status: "started",
      withdrawalId,
      txHash: res.txHash,
      amountUsdc: String(amount),
      // ⚠️ Say precisely what has and has not happened. Nothing has moved yet.
      whatHappened: "the delay has started. No funds have moved yet.",
      maturesApprox,
      whatHappensNext:
        "after about seven days we complete this automatically and the funds arrive in your agent " +
        "wallet. Moving them on to your login wallet is a separate step you control.",
      disclosure: disclosure(state),
    });
  } catch (e) {
    // ⚠️ The record is LEFT OPEN in `initiating`, not marked failed. We do not know whether the
    // call landed — a thrown error can still leave a transaction confirmed — and the sweeper
    // resolves that against the chain. Marking it failed here would stop it being swept, which
    // is precisely how a real withdrawal would get stranded.
    const msg = String(e?.reason ?? e?.message ?? e).slice(0, 200);
    await patchRecord({ owner, withdrawalId, fields: { lastError: msg } }).catch(() => {});
    return json(502, {
      error: "We could not confirm the withdrawal started.",
      withdrawalId,
      reason: msg,
      // ⭐ INDETERMINATE, not failed — and say so, because "try again" on a request that DID
      // land would start a second clock.
      indeterminate: true,
      whatWeDo:
        "this request is recorded and will be checked automatically against the chain. Do NOT " +
        "retry immediately — if it did start, retrying would begin a second withdrawal.",
    });
  }
}
