import { randomUUID } from "node:crypto";
import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { requireSession } from "./_auth.mjs";
import { ensureOwnerWallet } from "./_agent-wallets.mjs";
import { readExitState, ubInitiateWithdrawal } from "./_ubwithdraw.mjs";
import { createRecord, patchRecord, listByOwner, STATE } from "./_ubwithdraw-record.mjs";

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

  const wallet = await ensureOwnerWallet(session);
  if (wallet.pending) {
    return json(202, { status: "provisioning", message: "Your agent wallet is being set up — retry shortly." });
  }
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
  if (BigInt(Math.round(amount * 1e6)) > BigInt(state.availableAtomic)) {
    return json(400, {
      error: `You asked to withdraw ${amount} USDC but your unified balance holds ${state.availableUsdc} USDC.`,
      availableUsdc: state.availableUsdc,
    });
  }

  // ═══ RECORD FIRST. See the header — this ordering is the design, not bookkeeping. ═══
  const withdrawalId = randomUUID();
  await createRecord({ owner, amountUsdc: amount, withdrawalId });
  await patchRecord({ owner, withdrawalId, fields: {
    amountAtomic: BigInt(Math.round(amount * 1e6)).toString(),
    delayBlocks: state.delayBlocks,
    approxDelayDays: state.approxDelayDays,
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
