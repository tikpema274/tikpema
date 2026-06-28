// job-submit-background.mjs — the async research-and-submit plane for ERC-8183 jobs.
//
// The "-background" suffix makes Netlify run this asynchronously: it returns 202
// immediately and the body runs up to 15 minutes (Pro plan), free of the sync
// ceiling. Web search + multi-round reasoning can take minutes, so the caller
// fires this and polls a status store rather than blocking. There is no useful
// HTTP response — results are persisted to Netlify Blobs under the jobId.
//
// What it does: research the job's question into a client-ready brief, serialize
// it canonically (deterministic bytes), hash it (keccak256), persist the exact
// bytes to Blobs so the evaluator (C2) can fetch and verify them, then submit the
// hash on-chain via submit() as the provider (the agent wallet).
//
// Input (POST body): { jobId, question }
// Output: written to Blobs store "job-deliverables" under key `jobId`.

import { connectLambda, getStore } from "@netlify/blobs";
import { keccak256, toBytes } from "viem";
import { ARC, CONTRACTS, parseBody, dateAnchor } from "./_arc.mjs";
import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { research } from "./_research.mjs";
import { publicClient } from "./_predict.mjs";

// Research-brief prompt — NOT the prediction-market analyst prompt. The agent is
// a paid research analyst; the deliverable must be evidence-backed and cite real
// sources, since a brief with no sources is one we can't stand behind on-chain.
const BRIEF_SYSTEM_PROMPT = `You are a research analyst producing a brief for a paying client.
Use web search for real evidence, then respond with ONLY JSON:
{ "answer": "<direct answer to the question>", "reasoning": "<2-5 sentences>",
  "sources": [{"title": "<title>", "url": "<url>"}], "confidence": <decimal 0..1> }
Include only real source URLs from searches you actually performed — never invent, guess, or construct a URL. If your searches do not surface evidence that answers the question — especially for a specific past date, price, or outcome — say so plainly in "answer" (state what you could not verify) and set "confidence" low, rather than presenting an unconfirmed answer as fact. An honest "I could not verify this from available sources" is correct; fabricating sources to appear complete is never acceptable.`;

// Exa-grounded variant: the same brief contract, but the evidence is supplied to
// the model (retrieved by Exa) rather than gathered via web search — so the
// prompt doesn't tell the model to "use web search," keeping it honest.
const BRIEF_SYSTEM_PROMPT_EXA = `You are a research analyst producing a brief for a paying client.
Ground your brief on the sources provided to you, then respond with ONLY JSON:
{ "answer": "<direct answer to the question>", "reasoning": "<2-5 sentences>",
  "sources": [{"title": "<title>", "url": "<url>"}], "confidence": <decimal 0..1> }
Use only the supplied sources as evidence; do not invent URLs.
Cite ONLY sources from the supplied set — never invent, guess, or modify a URL. If the supplied sources do not let you answer confidently — especially for a specific past date, price, or outcome — say so plainly in "answer" (state what you could not verify), set "confidence" low, and include only the real sources you do have. An honest "the available sources do not confirm this" is correct and acceptable; a fabricated source is never acceptable.`;

const BRIEF_USER_INSTRUCTION =
  "Research this question and produce a client-ready brief with web search, " +
  "respond in the exact JSON format specified, and include real source URLs " +
  "from the searches you performed.";

// Canonical JSON: sort keys at EVERY level (recursive) so identical content
// always yields identical bytes — the evaluator hashes the same bytes we did.
// Mirrors the quickstart's recursive key-sorting replacer (an array replacer
// would recurse into nested objects and strip their keys, so we can't use one).
function canonicalize(obj) {
  return JSON.stringify(obj, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val)
            .sort()
            .map((k) => [k, val[k]])
        )
      : val
  );
}

// Minimal getJob ABI — only the status field we gate on. The ERC-8183 job/escrow
// status enum: Open(0), Funded(1), Submitted(2), Completed(3), Rejected(4),
// Expired(5). A deliverable can only be submitted against a Funded job; any
// other state means it's already been submitted (or the job moved on), so a
// redundant trigger must not re-research and double-submit.
const JOB_STATUS_FUNDED = 1;
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

// Don't clobber a good deliverable with a failure. A redundant trigger — or a
// transient error after a prior run already submitted — must not overwrite a
// record that holds a real submitted deliverable + hash. Only persist the
// failure when there's no prior successful deliverable to protect.
async function persistFailed(store, jobId, record) {
  const prior = await store.get(jobId, { type: "json" }).catch(() => null);
  if (prior?.status === "submitted" && prior.deliverableHash) return;
  await store.setJSON(jobId, record);
}

export async function handler(event) {
  // Classic Lambda-signature functions don't get Blobs auto-wired, and
  // background functions in particular run without it, so getStore() would throw
  // "environment has not been configured to use Netlify Blobs". connectLambda
  // hands the client the request-scoped siteID + token Netlify injects into
  // event.blobs. Guard on event.blobs: absent under local `netlify dev` (which
  // already configures Blobs via the global env), and connectLambda throws on it.
  if (event.blobs) connectLambda(event);

  const { jobId, question } = parseBody(event);
  if (!jobId) {
    // Without a jobId there is nowhere to write the result — nothing to do.
    return { statusCode: 400, body: "jobId required" };
  }

  const store = getStore("job-deliverables");

  // Fire-and-forget evaluation trigger — shared by the normal delivery path and
  // the refund path. Warn-only: a trigger failure must never throw, since the
  // on-chain submit it follows has already succeeded. The optional `extra`
  // payload carries the forced-reject signal ({ forceReject, failHash, reason })
  // EXPLICITLY in the POST body — the evaluator must not depend on the
  // eventually-consistent Blob flag, which isn't reliably readable when it spins
  // up. The normal path passes nothing, so forceReject stays undefined.
  const triggerEvaluate = async (extra = {}) => {
    const base = process.env.DEPLOY_URL ||
      `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}`;
    try {
      const evalRes = await fetch(`${base}/.netlify/functions/job-evaluate-background`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, ...extra }),
      });
      if (evalRes.status !== 202) {
        console.warn(`[job-submit] evaluate trigger for ${jobId} returned ${evalRes.status}`);
      }
    } catch (err) {
      console.warn(`[job-submit] failed to trigger evaluate for ${jobId}: ${err.message}`);
    }
  };

  // On a delivery failure, don't leave the escrow stuck at FUNDED. Submit a
  // failure-marker deliverable (keccak256("RESEARCH_FAILED:<jobId>")) via the
  // SAME submit() tx a normal delivery uses — moving FUNDED → SUBMITTED — then
  // let the evaluator force-reject it (→ client refunded). Only a submit() that
  // ITSELF throws is genuinely stuck; there we fall back to a "failed" record
  // and log loudly. This helper never throws, so callers can await it safely
  // (the catch below must not re-enter the refund path on its own error).
  const triggerRefund = async (reason) => {
    const walletAddress = process.env.AGENT_WALLET_ADDRESS;
    if (!walletAddress) {
      // No wallet → can't submit the marker → genuinely stuck. Record and bail.
      console.error(`[job-submit] REFUND for job ${jobId} cannot proceed — AGENT_WALLET_ADDRESS not set`);
      await persistFailed(store, jobId, { status: "failed", error: "AGENT_WALLET_ADDRESS not set — run agent-init." });
      return;
    }
    const failHash = keccak256(toBytes("RESEARCH_FAILED:" + jobId));
    try {
      const circleClient = circle();
      const tx = await circleClient.createContractExecutionTransaction({
        walletAddress,
        blockchain: ARC.blockchain,
        contractAddress: CONTRACTS.AGENTIC_COMMERCE,
        abiFunctionSignature: "submit(uint256,bytes32,bytes)",
        abiParameters: [String(jobId), failHash, "0x"],
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      });
      const submitTx = await waitForTx(circleClient, tx.data?.id);

      // Mark the record for refund. This Blob write feeds the UI timeline only —
      // the evaluator's reject decision now comes from the explicit POST body
      // below, NOT this eventually-consistent flag (which isn't reliably
      // readable when the evaluator spins up).
      await store.setJSON(jobId, {
        status: "refunding",
        refund: true,
        deliverableHash: failHash,
        canonicalReport: null,
        reason,
        submitTx,
      });

      // Pass the forced-reject signal EXPLICITLY in the body so the evaluator
      // doesn't have to read it back from the Blob.
      await triggerEvaluate({ forceReject: true, failHash, reason });
    } catch (e) {
      // The failure-marker submit ITSELF failed — the escrow stays FUNDED with
      // no way to refund from here. This is the genuinely-stuck case: log loudly.
      console.error(`[job-submit] REFUND SUBMIT FAILED for job ${jobId} — escrow stuck at FUNDED: ${e.message}`);
      await persistFailed(store, jobId, { status: "failed", error: e.message });
    }
  };

  try {
    // 0. Idempotency guard: read the job's on-chain state before doing any work.
    // A deliverable can only be submitted against a Funded job. If the job has
    // already moved past Funded (Submitted/Completed/Rejected/Expired), a
    // redundant trigger must NOT re-research and double-submit — record a skip
    // and bail before spending on research or a second submit().
    const job = await publicClient().readContract({
      address: CONTRACTS.AGENTIC_COMMERCE,
      abi: GET_JOB_ABI,
      functionName: "getJob",
      args: [BigInt(jobId)],
    });
    if (Number(job.status) !== JOB_STATUS_FUNDED) {
      await store.setJSON(jobId, {
        status: "skipped",
        reason: "job not in submittable state",
      });
      return { statusCode: 202 };
    }

    // 1. Research the question into a brief via the shared engine. Opt into the
    // Exa retrieval path so the brief is grounded on real retrieved sources;
    // _research falls back to web search if Exa is unavailable. Pass the Exa
    // system-prompt variant to match (it doesn't mention web search).
    const result = await research(
      question,
      `${BRIEF_SYSTEM_PROMPT_EXA}\n\n${dateAnchor()}`,
      BRIEF_USER_INSTRUCTION,
      { useExa: true }
    );
    let decision = result.decision;

    // 2. Guard: never submit a brief we can't stand behind. Abort if the model
    // returned nothing parseable, or a brief with no real sources.
    if (
      decision == null ||
      !Array.isArray(decision.sources) ||
      decision.sources.length === 0
    ) {
      // No usable brief — don't leave the escrow stuck at FUNDED. Submit a
      // failure marker and let the evaluator force-reject it (client refunded).
      await triggerRefund("research returned no usable brief (missing decision or sources)");
      return { statusCode: 202 };
    }

    // 3. Build the canonical report and hash its exact bytes in memory.
    const report = {
      question: result.question,
      model: result.model,
      answer: decision.answer,
      reasoning: decision.reasoning,
      sources: decision.sources,
      confidence: decision.confidence,
      generatedAt: new Date().toISOString(),
    };
    const canonicalReport = canonicalize(report);
    const deliverableHash = keccak256(toBytes(canonicalReport));

    // 4. Persist the exact bytes BEFORE submitting, so the evaluator (C2) can
    // fetch the deliverable and re-hash it, and the user can read the brief.
    await store.setJSON(jobId, {
      status: "submitting",
      canonicalReport,
      deliverableHash,
      brief: decision,
    });

    // 5. Submit on-chain as the provider (the agent wallet) — submit() records
    // the deliverable hash against the job. Reuses Circle's dev-controlled
    // wallet path (gas sponsored), mirroring job-set-budget.mjs.
    const walletAddress = process.env.AGENT_WALLET_ADDRESS;
    if (!walletAddress) {
      throw new Error("AGENT_WALLET_ADDRESS not set — run agent-init.");
    }
    const circleClient = circle();
    const tx = await circleClient.createContractExecutionTransaction({
      walletAddress,
      blockchain: ARC.blockchain,
      contractAddress: CONTRACTS.AGENTIC_COMMERCE,
      abiFunctionSignature: "submit(uint256,bytes32,bytes)",
      abiParameters: [String(jobId), deliverableHash, "0x"],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txHash = await waitForTx(circleClient, tx.data?.id);

    // 6. Persist the final state with the on-chain submit tx.
    await store.setJSON(jobId, {
      status: "submitted",
      canonicalReport,
      deliverableHash,
      brief: decision,
      txHash,
      tx: `${ARC.explorer}/tx/${txHash}`,
    });

    // 7. Fire-and-forget: kick off evaluation so deliver→settle runs
    // automatically. The submit already succeeded on-chain, so a trigger
    // failure must only warn — never throw and clobber the submitted state.
    await triggerEvaluate();
  } catch (e) {
    // A still-pending submit tx is submitted-but-slow, not failed — record the
    // id so the poller can distinguish "slow" from "reverted".
    if (e instanceof TxPendingError) {
      await store.setJSON(jobId, { status: "pending", txId: e.txId, error: e.message });
    } else {
      // A real failure (research threw, etc.) — don't leave the escrow stuck at
      // FUNDED. Submit a failure marker and let the evaluator refund the client.
      await triggerRefund(e.message);
    }
  }
  // 202 is conventional for an accepted-and-finished background invocation.
  return { statusCode: 202 };
}
