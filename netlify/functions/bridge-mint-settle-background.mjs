import { connectBlobs } from "./_blobs.mjs";
import { json, parseBody } from "./_arc.mjs";
import { requireInternal } from "./_auth.mjs";
import { bridgeMintStatus, BRIDGE_DESTINATIONS } from "./_bridge.mjs";
import { verifyMintOnChain } from "./_receipt.mjs";
import { readWithRetry, saveReceipt, isPastDeadline, TERMINAL_STATES } from "./_bridge-receipts.mjs";

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
// ══ THE FOUR TERMINAL STATES ═══════════════════════════════════════════════════════
//   minted           — IRIS says minted AND we read the mint on the destination chain.
//                      ONLY here does delivery become "measured".
//   mint_failed      — IRIS reported an explicit failure.
//   mint_unconfirmed — the deadline passed with no confirmation. The burn is real; the
//                      mint is unproven. NOT a success and NOT a failure.
//   mint_unverified  — IRIS claims minted, the chain disagrees. LOUD. Never auto-retried
//                      into `minted`; a human must look.
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
  // 🚨 THESE LOG LINES DO NOT CLOSE THAT, AND THE REPO ALREADY KNEW IT. Measured
  // 2026-07-31 on deploy 6a6cbce03b33755e6be09601: two unauthenticated probes appear in
  // `netlify logs --source functions --function bridge-mint-settle-background` as EMPTY
  // `INFO` lines — the invocation is listed, the message text never is. See
  // job-bridge-receipt-background.mjs:50-54, which records the same constraint
  // ("the console.log content does not surface through `netlify logs`") and is exactly
  // why that verifier attaches its telemetry to the RECORD instead of logging it.
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

  if (TERMINAL_STATES.has(receipt.state)) {
    return json(200, { state: receipt.state, note: "already terminal" });
  }
  if (receipt.state !== "burn_confirmed") {
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

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);

    // ⚠️ THE DEADLINE IS CHECKED ON EVERY ITERATION, not only after the loop bound.
    // A settler that was restarted late (stale-lease takeover) would otherwise start a
    // fresh 4-minute budget on a burn that is already an hour old, and "Still bridging"
    // would outlive any honest claim to it.
    if (isPastDeadline(receipt)) {
      await finish({ state: "mint_unconfirmed", delivery: "predicted", lastCheckedAt: new Date().toISOString() });
      return json(200, { state: "mint_unconfirmed", reason: "deadline_passed" });
    }

    let status;
    try {
      status = await bridgeMintStatus({ burnHash: receipt.burnHash, destinationKey: receipt.destinationKey });
    } catch {
      continue; // transient IRIS hiccup — keep polling
    }

    if (status.state === "failed") {
      await finish({ state: "mint_failed", delivery: "predicted", failedAt: new Date().toISOString() });
      return json(200, { state: "mint_failed" });
    }
    if (status.state !== "minted") continue; // pending — keep polling

    // IRIS claims the mint landed. CHECK IT OURSELVES before believing it.
    const chk = await verifyMintOnChain({
      destinationKey: receipt.destinationKey,
      mintTxHash: status.mintTxHash,
      recipient: receipt.recipient,
    });

    if (!chk.verified) {
      // rpc_error / receipt_not_found can just mean the destination node has not caught
      // up — not disagreement, so keep polling (the deadline check above still bounds
      // us). Anything else IS disagreement: stop and escalate to a human.
      if (chk.reason === "rpc_error" || chk.reason === "receipt_not_found") continue;

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
