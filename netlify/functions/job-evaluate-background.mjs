// job-evaluate-background.mjs — the async evaluate-and-settle plane for ERC-8183 jobs.
//
// This is brick C2: the evaluator. job-submit-background.mjs (C1) researched the
// question, serialized a canonical brief, hashed it (keccak256), persisted the
// exact bytes to Blobs, and submitted the hash on-chain via submit(). C2 reads
// that record back, PROVES the canonical-bytes determinism by re-hashing, judges
// the brief with a separate Anthropic call, and settles the escrow on-chain:
// pass → complete() (provider paid), fail → reject() (client refunded).
//
// The "-background" suffix makes Netlify run this asynchronously (returns 202,
// body runs up to 15 min) — the Anthropic judge + on-chain settle take time.
// There is no useful HTTP response; results are persisted to Blobs under jobId.
//
// Input (POST body): { jobId }
// Output: written to Blobs store "job-deliverables" under key `jobId`.

import { connectLambda, getStore } from "@netlify/blobs";
import { keccak256, toBytes } from "viem";
import { ARC, CONTRACTS, parseBody } from "./_arc.mjs";
import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { extractJson } from "./_research.mjs";
import { publicClient } from "./_predict.mjs";
import { requireInternal } from "./_auth.mjs";

// The evaluator is a JUDGE, not a researcher — it weighs an already-written brief
// against its question. So we deliberately do NOT use _research.mjs's callAnthropic
// (which hardcodes the web_search tool): a judge with web search is slow, can drift
// into re-researching, and bills for searches we don't want. This is a slim,
// tools-less call, mirroring job-quote.mjs's pricing call.
const EVALUATOR_SYSTEM_PROMPT = `You are an impartial work evaluator for a paid research job.
You receive the original question and the submitted brief (answer, reasoning, sources).
Judge two things ONLY: (a) does the brief responsively answer the question, and
(b) does it cite real, relevant sources? You are NOT judging whether it is the best
possible analysis — only whether it adequately addresses the question with real sources.
Respond with ONLY JSON: {"verdict": "pass" | "fail", "reason": "<one sentence>"}
with no markdown, no fences, and no preamble.`;

async function evaluate(apiKey, model, question, brief) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system: EVALUATOR_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `Original question:\n${question}\n\n` +
            `Submitted brief:\n` +
            `Answer: ${brief.answer}\n` +
            `Reasoning: ${brief.reasoning}\n` +
            `Sources: ${JSON.stringify(brief.sources)}`,
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Anthropic evaluator call failed");
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return extractJson(text);
}

// Minimal getJob ABI — only the status field we cross-check. ERC-8183 status enum:
// Open(0), Funded(1), Submitted(2), Completed(3), Rejected(4), Expired(5). C2 only
// settles a job that's actually Submitted on-chain. NOTE: the job struct does NOT
// expose the submitted deliverable hash, so the on-chain cross-check is status-only;
// the hash determinism is proven off-chain by the re-hash assertion below.
const JOB_STATUS_SUBMITTED = 2;
const GET_JOB_ABI = [
  {
    type: "function",
    name: "getJob",
    stateMutability: "view",
    inputs: [{ name: "jobId", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "id", type: "uint256" },
          { name: "client", type: "address" },
          { name: "provider", type: "address" },
          { name: "evaluator", type: "address" },
          { name: "description", type: "string" },
          { name: "budget", type: "uint256" },
          { name: "expiredAt", type: "uint256" },
          { name: "status", type: "uint8" },
          { name: "hook", type: "address" },
        ],
      },
    ],
  },
];

export async function handler(event) {
  // Classic Lambda-signature background functions don't get Blobs auto-wired, so
  // getStore() would throw "environment has not been configured to use Netlify
  // Blobs". connectLambda hands the client the request-scoped siteID + token
  // Netlify injects into event.blobs. Guard on event.blobs: absent under local
  // `netlify dev` (which configures Blobs globally), and connectLambda throws on it.
  if (event.blobs) connectLambda(event);

  // Internal-only: this settles escrow (complete/reject). It is called solely by
  // job-submit-background's server-to-server chain, never by the browser, so it
  // requires the internal token — a direct/anonymous call is rejected.
  if (!requireInternal(event)) return { statusCode: 401, body: "unauthorized" };

  // The forced-reject signal arrives EXPLICITLY in the POST body (set only by
  // C1's triggerRefund), not via the eventually-consistent Blob `refund` flag.
  // `reason` is aliased to `refundReason` to avoid colliding with the judge's
  // own `reason` declared later in the try block.
  const {
    jobId,
    forceReject,
    failHash,
    reason: refundReason,
    walletAddress,
    // Deliverable data threaded from job-submit so we DON'T read it back from
    // Blobs (eventual-read lag ~11s intermittently returned a stale record →
    // spurious "no submitted deliverable" eval-error). Store read is a fallback.
    canonicalReport: bodyReport,
    deliverableHash: bodyHash,
    brief: bodyBrief,
  } = parseBody(event);
  if (!jobId) {
    // Without a jobId there is nowhere to read from or write to — nothing to do.
    return { statusCode: 400, body: "jobId required" };
  }
  // The user's OWN agent wallet (the job's evaluator), threaded from job-submit —
  // settlement runs on THIS wallet, never the shared env wallet.
  if (!walletAddress) {
    return { statusCode: 400, body: "walletAddress required" };
  }

  const store = getStore("job-deliverables");

  // Deliverable base from the threaded body (race-free). Seeds persist so the
  // brief/canonicalReport are never lost to a stale merge read.
  const threaded =
    bodyReport && bodyHash
      ? { status: "submitted", canonicalReport: bodyReport, deliverableHash: bodyHash, brief: bodyBrief }
      : null;

  // Merge eval results onto the existing record so we never lose the brief,
  // canonicalReport, or submit tx the C1 writer persisted.
  const persist = async (patch) => {
    const prior = (await store.get(jobId, { type: "json" }).catch(() => null)) || {};
    await store.setJSON(jobId, { ...(threaded || {}), ...prior, ...patch });
  };

  try {
    // 1. Get the deliverable. Prefer the threaded body (race-free); otherwise
    // read from Blobs, RETRYING to ride out eventual-read lag rather than
    // concluding "no submitted deliverable" on a stale read.
    let entry = threaded;
    if (!entry && forceReject !== true) {
      for (let i = 0; i < 8 && !(entry && entry.status === "submitted"); i++) {
        if (i) await new Promise((r) => setTimeout(r, 1500));
        entry = await store.get(jobId, { type: "json" }).catch(() => null);
      }
    }

    // FORCED-REFUND PATH. C1 (job-submit-background) sets `forceReject: true` in
    // the POST body ONLY on a delivery failure, after submitting a failure-marker
    // deliverable that moved the job FUNDED → SUBMITTED. Here we force-reject to
    // refund the client — SKIPPING the status guard, the re-hash determinism
    // check, the canonicalReport parse, and the Anthropic judge entirely, because
    // there is no real brief to verify. The marker hash (`failHash`) and the
    // failure `reason` come from the body too, so this branch reads NOTHING from
    // the eventually-consistent Blob (which isn't reliably readable yet).
    //
    // SAFETY: this branch is reachable ONLY when `forceReject === true` is
    // explicitly present in the POST body, which ONLY C1's triggerRefund sends.
    // Normal success-path triggers send just { jobId }, so forceReject is
    // undefined and a genuine deliverable ALWAYS falls through to the full
    // re-hash + judge path below. Do not key this on anything but the body flag.
    if (forceReject === true) {
      const circleClient = circle();
      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress,
        blockchain: ARC.blockchain,
        contractAddress: CONTRACTS.AGENTIC_COMMERCE,
        abiFunctionSignature: "reject(uint256,bytes32,bytes)",
        abiParameters: [String(jobId), failHash, "0x"],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      });
      const settleTx = await waitForTx(circleClient, tx.data?.id);

      await persist({
        status: "rejected",
        refunded: true,
        refund: true,
        reason: refundReason,
        settleTx,
        settleTxUrl: `${ARC.explorer}/tx/${settleTx}`,
      });
      return { statusCode: 202 };
    }

    if (!entry || entry.status !== "submitted" || !entry.canonicalReport || !entry.deliverableHash) {
      await persist({ status: "eval-error", evalStatus: "error", reason: "no submitted deliverable" });
      return { statusCode: 202 };
    }

    // Timeline now shows the evaluation stage (the main status was stuck on
    // "submitted" because only evalStatus was being written below).
    await persist({ status: "evaluating" });

    // 2. PROVE determinism end-to-end: re-hash the persisted canonical bytes and
    // assert they reproduce the stored hash. If C1's writer and C2's reader hash
    // the same bytes differently, this catches it HERE — before an on-chain
    // complete() reverts on a hash mismatch. Abort without settling on mismatch.
    const rehash = keccak256(toBytes(entry.canonicalReport));
    if (rehash !== entry.deliverableHash) {
      await persist({
        status: "eval-error",
        evalStatus: "error",
        reason: "hash mismatch",
        rehash,
        expected: entry.deliverableHash,
      });
      return { statusCode: 202 };
    }

    // 3. Cross-check on-chain (best-effort): the job must actually be Submitted(2).
    // The struct doesn't expose the submitted hash, so we can't compare it on-chain
    // — the re-hash above is the determinism proof. A non-Submitted status means
    // the job already settled or never reached us; don't double-settle.
    const job = await publicClient().readContract({
      address: CONTRACTS.AGENTIC_COMMERCE,
      abi: GET_JOB_ABI,
      functionName: "getJob",
      args: [BigInt(jobId)],
    });
    if (Number(job.status) !== JOB_STATUS_SUBMITTED) {
      await persist({
        status: "eval-error",
        evalStatus: "error",
        reason: `job not in submitted state on-chain (status ${Number(job.status)})`,
      });
      return { statusCode: 202 };
    }

    // 4. Judge the brief with the slim, tools-less evaluator call. It receives the
    // original question and the brief (answer, reasoning, sources).
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY (server env)");
    const model = process.env.PREDICT_MODEL || "claude-sonnet-4-6";
    const question = JSON.parse(entry.canonicalReport).question;

    const judgment = await evaluate(apiKey, model, question, entry.brief);
    const verdict = judgment?.verdict === "pass" ? "pass" : "fail";
    const reason = judgment?.reason || "no reason returned";

    // 5. Settle on-chain from the user's OWN agent wallet (the evaluator role,
    // threaded in from job-submit). The bytes32 second arg is the contract's
    // `reason` field — we pass the verified deliverableHash, tying settlement to
    // the exact bytes judged. complete() pays the provider; reject() refunds the
    // client (both the same wallet here, per the self-agent model).
    const circleClient = circle();
    const tx = await circleClient.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.AGENTIC_COMMERCE,
      abiFunctionSignature:
        verdict === "pass" ? "complete(uint256,bytes32,bytes)" : "reject(uint256,bytes32,bytes)",
      abiParameters: [String(jobId), entry.deliverableHash, "0x"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const settleTx = await waitForTx(circleClient, tx.data?.id);

    // 6. Persist the final settled state (hashVerified records that determinism held).
    await persist({
      status: verdict === "pass" ? "completed" : "rejected",
      evalStatus: "settled",
      verdict,
      reason,
      settleTx,
      settleTxUrl: `${ARC.explorer}/tx/${settleTx}`,
      hashVerified: true,
    });
  } catch (e) {
    // A still-pending settle tx is settling-but-slow, not failed — record the id
    // so the poller can distinguish "slow" from "reverted".
    if (e instanceof TxPendingError) {
      await persist({ status: "settling", evalStatus: "pending", settleTxId: e.txId, reason: e.message });
    } else {
      await persist({ status: "eval-error", evalStatus: "error", reason: e.message });
    }
  }
  // 202 is conventional for an accepted-and-finished background invocation.
  return { statusCode: 202 };
}
