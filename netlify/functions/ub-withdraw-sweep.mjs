import { connectBlobs } from "./_blobs.mjs";
import { json } from "./_arc.mjs";
import { listAllOpen, patchRecord, STATE } from "./_ubwithdraw-record.mjs";
import { readExitState, ubCompleteWithdrawal } from "./_ubwithdraw.mjs";

// SCHEDULED — the UB withdrawal sweeper. Drives HOP 2 of the exit: the `withdraw(address)`
// call that lands a matured Gateway balance back in the user's agent SCA.
//
// ═══ 🚨 THIS FUNCTION IS WHAT MAKES THE EXIT AN EXIT ══════════════════════════════════
// The exit is two on-chain calls ~7 days apart. If the second one requires the user to
// come back and click, the design collapses into the option we explicitly rejected: a
// clock started that nobody finishes, while the user believes they are leaving. An exit
// that exists only up to the point of commitment is not an exit, it is a delay with a UI.
//
// ⭐ THE CASE ONLY A CRON COVERS IS THE ORDINARY ONE HERE. On the bridge, "a user who
// bridges once and never comes back" was the edge case. For a WITHDRAWAL it is the
// EXPECTED behaviour — someone asking for their money back is, by definition, leaving.
// Requiring them to return in seven days to finish leaving is not a design, it is a trap.
//
// ═══ ⚠️ WHAT THIS MEANS, STATED PLAINLY ══════════════════════════════════════════════
// This moves user funds UNATTENDED, ~7 days after the request, with no human present at
// the moment of movement. That is deliberate and it is bounded: it can only ever call
// `withdraw(token)` for an owner who ALREADY initiated, it takes no amount (the contract
// decides what has matured), and `withdraw` sends to msg.sender — the user's own SCA. It
// cannot pay a third party, cannot choose an amount, and cannot start anything.
//
// ⭐ THE STRONGEST GUARANTEE HERE IS ABSENCE OF MECHANISM: there is no code path in this
// function that can move money anywhere except back to the account that asked.
//
// ═══ ⚠️ NOT HTTP-INVOKABLE ═══════════════════════════════════════════════════════════
// Netlify 403s HTTP invocation of a scheduled function, and crons do not fire on drafts.
// ⚠️ Do NOT add a token guard keyed on `httpMethod` — Netlify delivers SCHEDULED
// invocations WITH an httpMethod, so that check refuses the cron itself. dd-watch shipped
// exactly that bug on 2026-08-11: five scheduled runs, nothing written, no error anywhere.
// A sweeper must never be able to refuse itself.

/** Bounded per tick. ⚠️ The remainder is REPORTED, never dropped silently — a cap that
 *  hides its own truncation reads as "we covered everything". */
const MAX_PER_TICK = 10;

export const handler = async (event) => {
  connectBlobs(event);
  const started = Date.now();

  const listing = await listAllOpen({ limit: MAX_PER_TICK });

  // 🚨 AN UNREADABLE STORE IS NOT AN EMPTY QUEUE. A sweeper that treats a read failure as
  // "nothing to do" silently stops sweeping and looks perfectly healthy doing it.
  if (!listing.readable) {
    console.error(`[ub-withdraw-sweep] DEGRADED — store unreadable; this tick proves NOTHING: ${listing.error}`);
    return json(200, { ok: false, reason: "store-unreadable", detail: listing.error });
  }

  if (listing.open.length === 0) {
    console.log(`[ub-withdraw-sweep] clean — scanned=${listing.scanned} open=0 totalKeys=${listing.totalKeys}`);
    return json(200, { ok: true, scanned: listing.scanned, open: 0, completed: 0, remaining: listing.remaining });
  }

  const out = { completed: 0, waiting: 0, reconciled: 0, failed: 0, details: [] };

  for (const rec of listing.open) {
    const { owner, withdrawalId, state } = rec;
    const note = (result, extra = {}) => out.details.push({ withdrawalId, owner, result, ...extra });

    try {
      // ── INITIATING: the record was written BEFORE the chain call, so we do not know
      // whether that call landed. ⭐ Ask the CHAIN rather than assuming either way — this is
      // the case persist-before-broadcast exists to preserve, and guessing here would either
      // strand a real withdrawal or double-initiate one.
      if (state === STATE.INITIATING) {
        const s = await readExitState({ owner });
        if (!s.readable) { out.failed++; note("chain-unreadable"); continue; }
        // A pending or matured withdrawal means the initiation DID land. Nothing else in this
        // system calls initiateWithdrawal, so this is a sound inference for this owner.
        const landed = BigInt(s.withdrawableAtomic) > 0n || BigInt(s.availableAtomic) < BigInt(rec.amountAtomic ?? "0");
        if (landed) {
          await patchRecord({ owner, withdrawalId, fields: { state: STATE.WAITING, reconciledAt: new Date().toISOString() } });
          out.reconciled++; note("reconciled-to-waiting");
        } else {
          // ⚠️ Left INITIATING deliberately. It is NOT marked failed here: "we cannot see it
          // yet" is not "it did not happen", and a record marked failed stops being swept.
          out.waiting++; note("initiation-not-visible-yet");
        }
        continue;
      }

      // ── WAITING / COMPLETING: try to finish it. `ubCompleteWithdrawal` returns
      // `not-yet-matured` as a NORMAL result, which is what stops this alarming every tick
      // for a week — the ack-gate lesson applied before it bites.
      const res = await ubCompleteWithdrawal({ owner });

      if (res.step === "not-yet-matured") { out.waiting++; note("waiting", { withdrawableUsdc: res.withdrawableUsdc }); continue; }

      await patchRecord({ owner, withdrawalId, fields: {
        state: STATE.COMPLETED,
        completeTxHash: res.txHash,
        landedIn: res.landedIn,
        completedAt: new Date().toISOString(),
        // ⭐ The funds are in the SCA, NOT with the user. Recorded so nothing downstream can
        // render "your money is back" from `state === completed` alone.
        stillNeedsAgentWithdraw: true,
      } });
      out.completed++;
      note("completed", { txHash: res.txHash, movedUsdc: res.movedUsdc });
      console.log(`[ub-withdraw-sweep] COMPLETED ${withdrawalId} owner=${owner} moved=${res.movedUsdc} tx=${res.txHash} — funds are in the SCA, hop 3 (agent-withdraw) still pending`);
    } catch (e) {
      // ⚠️ A failure here leaves the record OPEN on purpose, so the next tick retries. The
      // contract refuses a premature or duplicate `withdraw` (measured revert "N;O"), so
      // retrying cannot double-pay — idempotence is the chain's, and we do not fake our own.
      out.failed++;
      const msg = String(e?.reason ?? e?.message ?? e).slice(0, 200);
      await patchRecord({ owner, withdrawalId, fields: { lastError: msg } }).catch(() => {});
      note("error", { error: msg });
      console.error(`[ub-withdraw-sweep] ERROR ${withdrawalId} owner=${owner}: ${msg}`);
    }
  }

  const body = {
    ok: true,
    scanned: listing.scanned,
    open: listing.open.length,
    totalKeys: listing.totalKeys,
    // ⭐ Reported so a truncated tick cannot read as full coverage.
    remaining: listing.remaining,
    unreadableRecords: listing.unreadable,
    ...out,
    ms: Date.now() - started,
  };
  console.log(`[ub-withdraw-sweep] scanned=${body.scanned} open=${body.open} completed=${body.completed} waiting=${body.waiting} reconciled=${body.reconciled} failed=${body.failed} remaining=${body.remaining} ms=${body.ms}`);
  return json(200, body);
};
