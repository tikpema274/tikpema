import { connectLambda, getStore } from "@netlify/blobs";
import { json, parseBody } from "./_arc.mjs";
import { requireInternal } from "./_auth.mjs";
import { circle, waitForTx } from "./_circle.mjs";
import { bridgeMintStatus, BRIDGE_DESTINATIONS } from "./_bridge.mjs";
import { verifyMintOnChain } from "./_receipt.mjs";

// POST /.netlify/functions/job-bridge-receipt-background { jobId }   (INTERNAL ONLY)
//
// Promotes a `burn_confirmed` receipt to a TERMINAL state by proving — or failing to
// prove — that the destination mint actually landed. This is the only place a receipt
// may be marked `minted`.
//
// ══ NEVER TRUSTS ITS CALLER ════════════════════════════════════════════════════
// The invocation body carries ONLY `jobId` — a key, not a claim. burnHash,
// destinationKey, and recipient are read from the PERSISTED receipt that
// job-bridge-approve.mjs wrote from its own executeAction return. No hash ever enters
// this system from outside. `requireInternal` rejects any non-server caller outright,
// but even if that were bypassed, an attacker could at most ask us to re-verify a
// receipt we already own — they cannot inject one.
//
// ══ DOUBLE VERIFICATION ════════════════════════════════════════════════════════
//   1. IRIS (bridgeMintStatus) must report the forward CONFIRMED/COMPLETE with a hash.
//   2. verifyMintOnChain() must independently READ the destination chain and find that
//      exact tx: right chainId, status 0x1, and a Transfer to our recipient.
// Both, or it is not `minted`.
//
// If IRIS says minted and the chain does not agree → `mint_unverified`. That is a LOUD
// state meaning a human must look. It is NEVER auto-retried into `minted` — we stop
// polling immediately and leave it for a person. Either our read is wrong or the
// attestation is; silently retrying would eventually paper over whichever it is.

const POLL_MS = 5000;
const MAX_POLLS = 48; // ~4 min; a forwarded mint is typically 1–2 min

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function handler(event) {
  if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
  if (!requireInternal(event)) return json(401, { error: "internal only" });
  if (event.blobs) connectLambda(event);

  const { jobId } = parseBody(event); // a KEY, not a claim
  if (!jobId) return json(400, { error: "'jobId' required" });

  const store = getStore("job-deliverables");
  const load = () => store.get(String(jobId), { type: "json" }).catch(() => null);

  // READ-ONLY TELEMETRY. Captured by loadWithRetry, attached to the receipt on the terminal
  // write so the margin is READABLE via job-deliverable instead of trapped in logs (the
  // console.log content does not surface through `netlify logs`). Purely additive: it does
  // not change the verifier's logic, timing, retry behavior, or the money path — it records
  // how long the read raced, nothing more.
  //   visibilityLagMs — write→visible Blobs lag (approvedAt → first successful read)
  //   readMarginMs    — headroom left under the RECEIPT_TRIES×RECEIPT_DELAY_MS window
  //   readAttempts    — which retry attempt finally saw the receipt
  let readTelemetry = null;

  // Terminal states release the lease: a finished receipt must never look "in flight".
  const TERMINAL = new Set(["minted", "mint_failed", "mint_unconfirmed", "mint_unverified"]);
  const save = async (receiptIn) => {
    const isTerminal = TERMINAL.has(receiptIn.state);
    const receipt = isTerminal
      ? { ...receiptIn, verifyingSince: undefined, ...(readTelemetry || {}) }
      : receiptIn;
    const cur = await load();
    if (!cur) return;
    // NOTE: `receipt` is a SIBLING of canonicalReport, never inside it. Mutating the
    // canonical bytes would break the re-hash determinism proof at
    // job-evaluate-background.mjs:214 and the on-chain deliverableHash.
    await store.setJSON(String(jobId), { ...cur, receipt });
  };

  // ⚠️ THE BUG THIS FIXES (jobs #155262 and #155315, two stranded receipts).
  // `load()` was read ONCE, and a miss returned 404 immediately. But approve writes the
  // receipt and then triggers us, and Blobs is eventually consistent (~11s — see
  // agent-execute-plan.mjs:82-90). The prod log shows the verifier being invoked 9s after
  // approvedAt: INSIDE that window. It read, saw no receipt, 404'd, and exited before
  // taking the lease — so every receipt stranded at `burn_confirmed` while the mint had
  // actually landed. The trigger was NOT being dropped; a read was losing the race.
  //
  // Same disease, same cure as job-evaluate-background.mjs:157-162 (`entry` retry) and its
  // readPrior(): poll for the record instead of concluding absence from one miss. BOUNDED —
  // a genuinely absent receipt must still 404 rather than retry-bomb.
  //
  // ⚠️ THE 15s WINDOW IS A GUESS, and this log is how it stops being one. It rests on ONE
  // data point (the verifier read at 9s and missed) plus a ~11s figure from a comment
  // elsewhere in the repo — never measured here. A run that PASSES tells us nothing about
  // margin: barely-won and comfortably-won look identical from outside, and barely-won
  // strands the NEXT receipt under load with the exact same symptom. So we log the real
  // numbers on BOTH paths — success and give-up — and let the data set the window.
  //
  // `visibilityLagMs` is the true write→visible lag: approve stamps `approvedAt` when it
  // writes the receipt, so the gap to our first successful read IS the Blobs lag (plus the
  // few hundred ms of trigger + cold start, which we log separately as `waitedMs`).
  const RECEIPT_TRIES = 10;
  const RECEIPT_DELAY_MS = 1500; // 10 x 1.5s = 15s > the ~11s consistency window
  const loadWithRetry = async () => {
    const t0 = Date.now();
    for (let i = 0; i < RECEIPT_TRIES; i++) {
      if (i) await sleep(RECEIPT_DELAY_MS);
      const e = await load();
      if (e?.receipt) {
        const waitedMs = Date.now() - t0;
        const approvedAt = Date.parse(e.receipt.approvedAt || "");
        const visibilityLagMs = Number.isFinite(approvedAt) ? Date.now() - approvedAt : null;
        const marginMs = RECEIPT_TRIES * RECEIPT_DELAY_MS - waitedMs;
        // Stash for the terminal write (readable via job-deliverable). READ-ONLY.
        readTelemetry = { visibilityLagMs, readMarginMs: marginMs, readAttempts: i + 1, readWaitedMs: waitedMs };
        console.log(
          `[receipt] READ OK job=${jobId} attempt=${i + 1}/${RECEIPT_TRIES} waitedMs=${waitedMs} ` +
            `visibilityLagMs=${visibilityLagMs} marginMs=${marginMs} state=${e.receipt.state}`
        );
        if (marginMs < 3000) {
          console.warn(`[receipt] ⚠️ NARROW MARGIN job=${jobId} — only ${marginMs}ms of retry window left; raise RECEIPT_TRIES`);
        }
        return e;
      }
    }
    console.warn(
      `[receipt] READ GAVE UP job=${jobId} after ${RECEIPT_TRIES} attempts / ${Date.now() - t0}ms — ` +
        `receipt never became visible (window too small, or genuinely absent)`
    );
    return null;
  };

  const entry = await loadWithRetry();
  if (!entry?.receipt) return json(404, { error: "no receipt to verify" });
  let receipt = entry.receipt;

  // ── burn_pending: we hold a Circle tx id but no hash yet. Resolve the REAL hash
  //    from Circle before anything else. Until then there is nothing to verify. ──
  if (receipt.state === "burn_pending") {
    if (!receipt.circleTxId) return json(409, { error: "burn_pending with no circleTxId" });
    try {
      const burnHash = await waitForTx(circle(), receipt.circleTxId);
      receipt = { ...receipt, state: "burn_confirmed", burnHash, burnTx: `https://testnet.arcscan.app/tx/${burnHash}` };
      await save(receipt);
    } catch (e) {
      // Still pending, or failed. Either way: NOT a receipt. Leave it honest.
      await save({ ...receipt, state: "burn_pending", lastError: e.message });
      return json(200, { state: "burn_pending", reason: e.message });
    }
  }

  if (receipt.state !== "burn_confirmed") {
    return json(200, { state: receipt.state, note: "nothing to do" });
  }

  // ── SINGLE-FLIGHT LEASE ────────────────────────────────────────────────────────
  // The verifier is idempotent — it submits NO transaction, only reads IRIS and the
  // destination chain — so a duplicate invocation can never double-mint. What it CAN do
  // is spawn a second 4-minute poll loop alongside a live one: pure waste.
  //
  // So a running loop takes a time-boxed lease on the receipt. A FRESH lease means
  // someone is already polling → exit. A STALE lease means that loop DIED (exactly what
  // stranded job #155262 at burn_confirmed) → take over. The staleness window doubles as
  // the recovery hook: a dead verifier is reclaimable without any manual intervention.
  //
  // ⚠️ Blobs is eventually consistent (~11s), so two near-simultaneous invocations can
  // both miss the lease and both poll. That is the same window as the double-approve race
  // and is bounded the same way: both loops read the SAME chain state and write the SAME
  // terminal value. The cost is wasted polling, never a wrong receipt.
  const LEASE_MS = 5 * 60 * 1000; // > the 4-min poll window, so a live loop always holds it
  const heldSince = receipt.verifyingSince ? Date.parse(receipt.verifyingSince) : 0;
  const leaseAgeMs = heldSince ? Date.now() - heldSince : Infinity;
  if (heldSince && leaseAgeMs < LEASE_MS) {
    return json(200, { state: receipt.state, note: "lease held — another verifier is polling", leaseAgeMs });
  }
  // Take (or reclaim) the lease. A stale lease is logged: it means a previous loop died.
  if (heldSince) console.warn(`[receipt] reclaiming stale verifier lease for job ${jobId} (age ${Math.round(leaseAgeMs / 1000)}s)`);
  receipt = { ...receipt, verifyingSince: new Date().toISOString() };
  await save(receipt);

  if (!BRIDGE_DESTINATIONS[receipt.destinationKey]) {
    return json(500, { error: "receipt has an unsupported destinationKey" });
  }

  // ── Poll IRIS for the forward, then independently verify on-chain. ──
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);

    let status;
    try {
      status = await bridgeMintStatus({ burnHash: receipt.burnHash, destinationKey: receipt.destinationKey });
    } catch {
      continue; // transient IRIS hiccup — keep polling
    }

    if (status.state === "failed") {
      await save({ ...receipt, state: "mint_failed", failedAt: new Date().toISOString() });
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
      // rpc_error / receipt_not_found can simply mean the destination node has not
      // caught up yet — that is not disagreement, so keep polling. Anything else IS
      // disagreement: stop, and escalate to a human.
      if (chk.reason === "rpc_error" || chk.reason === "receipt_not_found") continue;

      await save({
        ...receipt,
        state: "mint_unverified",
        irisClaimedMintTxHash: status.mintTxHash, // CLAIMED — deliberately not `mintTxHash`
        verifyFailure: chk,
        flaggedAt: new Date().toISOString(),
      });
      // Return 200: the function did its job correctly. The RECEIPT is the alarm.
      return json(200, { state: "mint_unverified", reason: chk.reason, needsHumanReview: true });
    }

    await save({
      ...receipt,
      state: "minted",
      mintTxHash: status.mintTxHash,
      mintTx: status.mintTx,
      mintVerifiedBy: ["iris", "destination-rpc"],
      mintChainId: chk.chainId,
      mintBlockNumber: chk.blockNumber,
      // ASSERTED, not observed: the Transfer came from this chain's PINNED USDC contract.
      usdcAmount: chk.usdcAmount,
      usdcAddress: chk.usdcAddress,
      mintedAt: new Date().toISOString(),
    });
    return json(200, { state: "minted", mintTxHash: status.mintTxHash });
  }

  // Poll window elapsed with no confirmation. The burn is real; the mint is unproven.
  // This is a legitimate, displayable outcome — NOT a success and NOT a failure.
  await save({ ...receipt, state: "mint_unconfirmed", lastCheckedAt: new Date().toISOString() });
  return json(200, { state: "mint_unconfirmed" });
}
