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
  const save = async (receipt) => {
    const cur = await load();
    if (!cur) return;
    // NOTE: `receipt` is a SIBLING of canonicalReport, never inside it. Mutating the
    // canonical bytes would break the re-hash determinism proof at
    // job-evaluate-background.mjs:214 and the on-chain deliverableHash.
    await store.setJSON(String(jobId), { ...cur, receipt });
  };

  const entry = await load();
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
