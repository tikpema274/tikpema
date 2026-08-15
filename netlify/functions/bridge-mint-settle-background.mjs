import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { requireInternal } from "./_auth.mjs";
import { bridgeMintStatus, BRIDGE_DESTINATIONS } from "./_bridge.mjs";
import { verifyMintOnChain } from "./_receipt.mjs";
import { readWithRetry, saveReceipt, isPastDeadline, isRecheckable, RESOLVED_STATES } from "./_bridge-receipts.mjs";

// POST /.netlify/functions/bridge-mint-settle-background { owner, burnHash }  (INTERNAL ONLY)
//
// Settles a DIRECT-path bridge receipt: proves the destination mint landed, or records
// honestly that it did not. The plan path has its own verifier
// (job-bridge-receipt-background.mjs); this is the same discipline applied to the
// BridgePanel path, sharing the two verification primitives rather than re-implementing
// them — bridgeMintStatus() for IRIS and verifyMintOnChain() for the chain read.
//
// ══ INTERNAL ONLY, FROM LINE ONE ═══════════════════════════════════════════════════
// Every file under netlify/functions is a PUBLIC URL whether or not netlify.toml gives
// it a friendly route, and this one MUTATES receipt state. `requireInternal` is checked
// before anything else runs. There is deliberately NO /api/* redirect for it.
//
// ══ NEVER TRUSTS ITS CALLER ════════════════════════════════════════════════════════
// The body carries `owner` and `burnHash` — KEYS, not claims. Destination, recipient
// and every amount come from the receipt agent-bridge.mjs wrote from executeAction's
// own return. No hash, address or amount enters this system from outside; the worst a
// caller could do (if requireInternal were bypassed) is ask us to re-verify a receipt
// we already own.
//
// ══ WHY A SETTLER STILL EXISTS AFTER THE FORWARDING SERVICE ════════════════════════
// Circle's Forwarding Service performs the destination mint and exposes completion, so
// nothing here DRIVES the mint. What it does not do is apply a deadline: IRIS reports
// `failed` only on an explicit forwardState==="FAILED", and a true stall simply stays
// `pending` forever. Client-side polling cannot cover that — the UI invites the user to
// leave, and a closed tab polls nothing. So the server keeps its own clock.
//
// ══ THREE RESOLVED STATES, ONE PROVISIONAL ═════════════════════════════════════════
//   minted           — IRIS says minted AND we read the mint on the destination chain.
//                      ONLY here does delivery become "measured".            RESOLVED
//   mint_failed      — IRIS reported an explicit failure.                    RESOLVED
//   mint_unverified  — IRIS claims minted, the chain disagrees. LOUD. Never auto-retried
//                      into `minted`; a human must look.                     RESOLVED
//   mint_unconfirmed — WE STOPPED WAITING. Not a verdict about the mint.  PROVISIONAL
//
// ⭐ THE DISTINCTION IS LOAD-BEARING. `mint_unconfirmed` was treated as resolved, so once
// written it could never be revisited — and a mint that landed AFTER we stopped waiting
// stayed labelled "unproven" forever. It is re-checkable now (rate limited), because
// "we stopped waiting" and "it did not arrive" are different claims.
//
// In three of the four, `delivery` stays "predicted". A failed or absent chain read must
// never silently promote an arithmetic estimate into an observation.

const POLL_MS = Number(process.env.BRIDGE_SETTLE_POLL_MS || 5000);
const MAX_POLLS = Number(process.env.BRIDGE_SETTLE_MAX_POLLS || 48); // ~4 min at 5s
// ⚠️ Those two env knobs exist so the fault-injection suite can reach the deadline
// branch in milliseconds instead of four real minutes. They are safe to expose: this
// function submits NO transaction and moves NO money — it reads IRIS, reads a
// destination RPC, and writes receipt state. Shortening its loop can only make it give
// up EARLIER (a conservative direction: `mint_unconfirmed` claims nothing).

const LEASE_MS = 5 * 60 * 1000; // > the poll window, so a live loop always holds it
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handler(event) {
  // ⚠️ A BACKGROUND FUNCTION'S RETURN VALUE IS DISCARDED. Netlify answers every caller
  // 202 with an empty body — including a caller with no token, a bogus token, or the
  // wrong HTTP method. So the `json(401)` below is NEVER TRANSMITTED, and an external
  // probe cannot tell "refused" from "ran to completion": both look like 202.
  //
  // That is not a hole — requireInternal still runs, before any read or write — but it
  // makes the guard UNOBSERVABLE from outside, and an unobservable guard is one nobody
  // can prove still works.
  //
  // 🚨 THESE LOG LINES DO NOT CLOSE THAT. Measured 2026-07-31: unauthenticated probes of
  // THIS function appear in `netlify logs` as EMPTY `INFO` lines — the invocation is
  // listed, the message text never is.
  //
  // ⚠️ NARROWLY: it is *-background functions whose console output is dropped, NOT every
  // function. The same `netlify logs` query against agent-bridge returns full text
  // ("[bridge-receipt] settle trigger sent … status=202"), and both appeared side by side
  // in one output on 2026-08-01. An earlier note here generalised this to all functions;
  // that was wrong and would have discouraged logging where logging works.
  // job-bridge-receipt-background.mjs:50-54 records the same constraint for the same
  // reason, and is why that verifier attaches telemetry to the RECORD instead.
  //
  // They are kept because they cost nothing and would become useful behind a log drain,
  // but they are NOT evidence. ⭐ THE ONLY SOUND PROOF IS BEHAVIOURAL AND NEGATIVE:
  // invoke this function unauthenticated with a REAL receipt's owner/burnHash and
  // confirm the record does NOT change — no `settlingSince`, no state transition. That
  // reads the guard through the one surface this platform does expose: the store.
  // ⚠️ A refused call must never WRITE anything to prove it was refused — that would put
  // a write on the unauthenticated path, which is the thing being guarded against.
  if (event.httpMethod !== "POST") {
    console.warn(`[bridge-settle] REFUSED — method ${event.httpMethod} (POST only)`);
    return json(405, { error: "POST only" });
  }
  if (!requireInternal(event)) {
    console.warn("[bridge-settle] REFUSED — no valid x-internal-token; nothing was read or written");
    return json(401, { error: "internal only" });
  }
  console.log("[bridge-settle] ACCEPTED — internal token valid, proceeding");
  if (event.blobs) connectBlobs(event);

  const { owner, burnHash } = parseBody(event); // KEYS, not claims
  if (!owner || !burnHash) return json(400, { error: "'owner' and 'burnHash' required" });

  // A 404 inside the ~11s Blobs window is not absence — poll for it.
  const { receipt: found } = await readWithRetry(owner, burnHash);
  if (!found) return json(404, { error: "no receipt to settle" });
  let receipt = found;

  // RESOLVED means nothing left to learn. `mint_unconfirmed` is NOT resolved — it records
  // that we stopped waiting, and a mint can land after we stop waiting. Refusing to look
  // again is what made a mislabel permanent, so a provisional receipt is re-checked (rate
  // limited, so a page load cannot hammer IRIS).
  if (RESOLVED_STATES.has(receipt.state)) {
    return json(200, { state: receipt.state, note: "already resolved" });
  }
  if (receipt.state === "mint_unconfirmed") {
    if (!isRecheckable(receipt)) {
      return json(200, { state: receipt.state, note: "provisional — re-checked too recently" });
    }
    console.log(`[bridge-settle] RE-CHECKING provisional receipt burnHash=${burnHash}`);
  } else if (receipt.state !== "burn_confirmed") {
    return json(200, { state: receipt.state, note: "nothing to do" });
  }
  if (!BRIDGE_DESTINATIONS[receipt.destinationKey]) {
    return json(500, { error: "receipt has an unsupported destinationKey" });
  }

  // ── SINGLE-FLIGHT LEASE ──────────────────────────────────────────────────────────
  // This settler is idempotent — it submits nothing — so a duplicate can never
  // double-mint. What it can do is run a second multi-minute loop beside a live one:
  // pure waste. A FRESH lease means someone is already polling; a STALE lease means
  // that loop died and this one may take over, which doubles as the recovery hook.
  // Blobs lag means two near-simultaneous invocations can both miss the lease; both
  // then read the same chain and write the same terminal value, so the cost is wasted
  // polling, never a wrong receipt.
  const heldSince = receipt.settlingSince ? Date.parse(receipt.settlingSince) : 0;
  const leaseAgeMs = heldSince ? Date.now() - heldSince : Infinity;
  if (heldSince && leaseAgeMs < LEASE_MS) {
    return json(200, { state: receipt.state, note: "lease held — another settler is polling", leaseAgeMs });
  }
  if (heldSince) {
    console.warn(`[bridge-settle] reclaiming stale lease burnHash=${burnHash} (age ${Math.round(leaseAgeMs / 1000)}s)`);
  }
  receipt = { ...receipt, settlingSince: new Date().toISOString() };
  await saveReceipt(receipt);

  // Terminal write helper — releases the lease so a finished receipt never looks
  // in-flight, and keeps `delivery` explicit on every single exit.
  const finish = async (patch) => {
    const next = { ...receipt, ...patch, settlingSince: undefined, settledAt: new Date().toISOString() };
    await saveReceipt(next);
    return next;
  };

  // ⭐ ASK BEFORE DECIDING. THE DEADLINE BOUNDS WAITING, NOT CHECKING.
  //
  // 🚨 THE BUG THIS ORDERING FIXES. The deadline used to be evaluated at the TOP of the
  // loop, before IRIS was ever consulted. A stranded receipt is past deadline BY
  // DEFINITION — that is the condition recovery selects on — so a recovered settler wrote
  // `mint_unconfirmed` on its first iteration without ever asking whether the mint had
  // landed. It had: burn 0x0175cf7b… shows 0.946797 USDC minted on Base while its receipt
  // said "unproven". And because `mint_unconfirmed` was treated as resolved, every later
  // invocation returned "already terminal", so the mislabel was PERMANENT. Recovery did not
  // heal a stranded receipt; it foreclosed one.
  //
  // Now every iteration asks first and only lets the deadline speak about a mint that is
  // still UNRESOLVED. A late answer is still an answer.
  for (let i = 0; i < MAX_POLLS; i++) {
    // No sleep on entry: a recovery invocation must check IMMEDIATELY. Sleeping first cost
    // a wasted round trip on exactly the path that already waited hours.
    if (i) await sleep(POLL_MS);

    let status;
    try {
      status = await bridgeMintStatus({ burnHash: receipt.burnHash, destinationKey: receipt.destinationKey });
    } catch {
      // Transient IRIS hiccup. Fall through to the deadline check — being unable to ask is
      // not evidence the mint failed, but it must not spin forever either.
      status = null;
      if (isPastDeadline(receipt)) {
        await finish({ state: "mint_unconfirmed", delivery: "predicted", lastCheckedAt: new Date().toISOString() });
        return json(200, { state: "mint_unconfirmed", reason: "deadline_passed_iris_unreachable" });
      }
      continue;
    }

    if (status.state === "failed") {
      await finish({ state: "mint_failed", delivery: "predicted", failedAt: new Date().toISOString() });
      return json(200, { state: "mint_failed" });
    }
    if (status.state !== "minted") {
      // Genuinely still pending. NOW the deadline may speak — we asked, and the answer was
      // "not yet". Checked every iteration so a late stale-lease takeover cannot start a
      // fresh 4-minute budget on a burn that is already hours old.
      if (isPastDeadline(receipt)) {
        await finish({ state: "mint_unconfirmed", delivery: "predicted", lastCheckedAt: new Date().toISOString() });
        return json(200, { state: "mint_unconfirmed", reason: "deadline_passed" });
      }
      continue;
    }

    // IRIS claims the mint landed. CHECK IT OURSELVES before believing it.
    const chk = await verifyMintOnChain({
      destinationKey: receipt.destinationKey,
      mintTxHash: status.mintTxHash,
      recipient: receipt.recipient,
    });

    if (!chk.verified) {
      // rpc_error / receipt_not_found can just mean the destination node has not caught
      // up — not disagreement, so keep polling. Anything else IS disagreement: stop and
      // escalate to a human.
      if (chk.reason === "rpc_error" || chk.reason === "receipt_not_found") {
        // ⚠️ IRIS says minted but we could not READ it. That is unresolved, not resolved —
        // so the deadline applies here too, and the result stays re-checkable rather than
        // asserting an arrival we never measured.
        if (isPastDeadline(receipt)) {
          await finish({
            state: "mint_unconfirmed",
            delivery: "predicted",
            lastCheckedAt: new Date().toISOString(),
            lastVerifyFailure: chk.reason,
            // 🚨 THE THIRD THING THIS LINE THREW AWAY. `verifyMintOnChain` has always returned a
            // `detail` and this branch has always stored only the one-word `reason`. So the record
            // said `rpc_error` for twelve days while the actual message — a DNS failure naming a
            // host that no longer exists — was computed, discarded, and recomputed ~1,730 times.
            // ⭐ THE DIAGNOSIS WAS IN HAND ON EVERY SINGLE ATTEMPT AND WAS NEVER WRITTEN DOWN.
            // `failureKind` is the discriminator: `unreachable` is a config fault we own, and
            // `transient` is a node having a bad minute. They were the same word before today.
            lastVerifyFailureDetail: chk.detail ?? null,
            lastVerifyFailureKind: chk.failureKind ?? null,
            lastVerifyRpc: chk.rpc ?? null,
            // 🚨 THE ONE DATUM A HUMAN NEEDS, PREVIOUSLY DISCARDED ON THIS EXACT PATH. IRIS has
            // just handed us the mint hash it claims landed, and this branch used to drop it —
            // ~1,730 times over twelve days for `0xccc02035…`, once per retry. A record that ends
            // up telling someone "check this by hand" had thrown away the thing they would check.
            // ⚠️ `irisClaimedMintTxHash`, never `mintTxHash`: we did NOT read it, IRIS asserted it,
            // and the field name is the only thing keeping that distinction alive downstream.
            irisClaimedMintTxHash: status.mintTxHash ?? null,
            // ⭐ EVIDENCE, NOT INFERENCE. With a streak, "we failed to read the chain 1,730 times"
            // is a measurement; without one it can only be guessed at from the record's age — and
            // a guess cannot distinguish a persistent RPC fault from a settler that never ran.
            verifyFailureCount: (Number.isInteger(receipt.verifyFailureCount) ? receipt.verifyFailureCount : 0) + 1,
          });
          return json(200, { state: "mint_unconfirmed", reason: "deadline_passed_chain_unreadable" });
        }
        continue;
      }

      await finish({
        state: "mint_unverified",
        delivery: "predicted", // the chain read FAILED — nothing was measured
        irisClaimedMintTxHash: status.mintTxHash, // CLAIMED, deliberately not `mintTxHash`
        verifyFailure: chk,
        flaggedAt: new Date().toISOString(),
      });
      // 200: the function did its job correctly. The RECEIPT is the alarm.
      return json(200, { state: "mint_unverified", reason: chk.reason, needsHumanReview: true });
    }

    // ── The ONLY path that may promote predicted → measured. ──
    // amountDelivered is read from the destination-chain Transfer log, so it is an
    // OBSERVATION. netPredicted stays alongside it: keeping both is what lets the UI
    // show an estimate before and an exact figure after, and lets anyone audit the gap.
    await finish({
      state: "minted",
      delivery: "measured",
      amountDelivered: chk.usdcAmount,
      mintTxHash: status.mintTxHash,
      mintTx: status.mintTx,
      mintVerifiedBy: ["iris", "destination-rpc"],
      mintChainId: chk.chainId,
      mintBlockNumber: chk.blockNumber,
      usdcAddress: chk.usdcAddress,
      mintedAt: new Date().toISOString(),
    });
    return json(200, { state: "minted", amountDelivered: chk.usdcAmount, mintTxHash: status.mintTxHash });
  }

  // Poll window elapsed with no confirmation. Burn real, mint unproven.
  await finish({ state: "mint_unconfirmed", delivery: "predicted", lastCheckedAt: new Date().toISOString() });
  return json(200, { state: "mint_unconfirmed", reason: "polls_exhausted" });
}
