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

import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
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
// ⚠️ HARDENED after job #155217, where the judge REFUNDED a correct brief for two
// reasons, BOTH outside its own rubric:
//   1. "does not actually execute or provide actionable transaction steps" — that is
//      neither (a) nor (b). It invented a criterion its prompt forbids, and penalised a
//      plan brief for correctly proposing rather than executing.
//   2. "cited sources cannot be verified as real existing resources" — the judge has NO
//      browsing. It asserted non-existence from ignorance. All six URLs were live (three
//      docs.arc.io pages, two GitHub repos returned 200; a Medium link 403'd on bot
//      block, which is not absence).
//
// The second is the load-bearing one: a source list CANNOT contain fabricated URLs.
// _research.mjs:419-422 OVERWRITES the model's `sources` with what was actually
// fetched (Exa results + purchased facts). Existence is guaranteed upstream. What CAN
// still go wrong is relevance — a real source that has nothing to do with the question —
// and that is what (b) must actually police. Note some entries are deliberately NOT URLs:
// a purchased fact's `url` is a provenance label like "Arc Testnet RPC (QuickNode)".
//
// Do NOT overcorrect: a brief that answers a different question, or cites sources with no
// bearing on it, must still FAIL.
export const EVALUATOR_SYSTEM_PROMPT = `You are an impartial work evaluator for a paid research job.
You receive the original question and the submitted brief (answer, reasoning, sources).

Judge EXACTLY TWO things, and nothing else:
(a) Does the brief responsively answer the question that was asked?
(b) Are the cited sources relevant to that question?

RULES YOU MUST FOLLOW:

1. These two criteria are EXHAUSTIVE. You may not invent, import, or apply any other
   standard. Do NOT judge completeness, depth, actionability, execution, next steps,
   whether the work should have gone further, whether it is the best possible analysis,
   or whether it took an action. A brief that ANSWERS the question is responsive even if
   it recommends, proposes, declines to recommend, or concludes that nothing should be
   done. If your reason for failing does not name (a) or (b) explicitly, the verdict is
   "pass".

2. You CANNOT browse the web and CANNOT check whether a URL exists. You therefore must
   NEVER fail a brief on the grounds that a source "cannot be verified", "may not exist",
   "appears fabricated", or that you do not recognise it. Not recognising a source is a
   fact about you, not about the source. Unfamiliar documentation sites, GitHub
   repositories, and blog posts are ordinarily real. Some entries are provenance labels
   rather than links (e.g. "Arc Testnet RPC (QuickNode)") — these are legitimate.

3. You SHOULD still fail under (b) when the sourcing is genuinely bad in a way visible
   from the text alone: the sources are plainly off-topic and bear no relation to the
   question, the source list is empty, or the answer's claims are wholly unsupported by
   any cited source. Judge relevance, never existence.

4. You SHOULD still fail under (a) when the brief answers a different question than the
   one asked, is empty, or is evasive to the point of saying nothing.

Respond with ONLY JSON: {"verdict": "pass" | "fail", "reason": "<one sentence naming (a) or (b)>"}
with no markdown, no fences, and no preamble.`;

// PLAN-FLOW clause — APPENDED to the base prompt ONLY when the job carries a validated
// proposal (isPlanFlow). It is NOT part of EVALUATOR_SYSTEM_PROMPT, so a research-flow
// evaluation sends the base prompt BYTE-FOR-BYTE unchanged. That is the regression
// guarantee: this clause cannot leak into research-flow judgment, because for research
// flow it is never concatenated at all.
//
// Fixes job #155332, where the judge failed a valid plan brief for "answers a question
// about bridging mechanics rather than the task of bridging" — technically naming (a),
// but applying an execution standard to a brief whose correct job is to PROPOSE. The clause
// redefines "responsive" for plan flow (propose, don't execute) WITHOUT lowering (a)/(b),
// and explicitly forecloses judging whether the proposal is a good idea — that is the
// user's call, enforced by the ProposalCard, not the judge's.
export const PLAN_FLOW_CLAUSE = `

THIS IS AN ACTION-PLANNING JOB. The brief's job is to research a proposed on-chain action
and recommend a concrete plan — NOT to execute it. Execution happens later, and only after
the user separately approves the proposal. Therefore, for THIS brief:
- Under (a): a brief is responsive if it researches the requested action and presents its
  findings/recommendation. Do NOT fail it for "not executing", "not performing the
  transfer", "answering a question about mechanics rather than doing the task", or lacking
  transaction steps. Proposing rather than executing is the CORRECT and COMPLETE behavior.
- Under (b): judge the sources exactly as you would otherwise — they must be relevant to
  the action researched. Off-topic or empty sourcing still fails.
- You are NOT assessing whether the proposed action is wise, well-reasoned, correctly
  sized, or a good financial decision. That judgment belongs to the user, not to you.
  Assess only that the research is responsive (a) and the sources are relevant (b).`;

export async function evaluate(apiKey, model, question, brief, isPlanFlow = false) {
  const system = isPlanFlow ? EVALUATOR_SYSTEM_PROMPT + PLAN_FLOW_CLAUSE : EVALUATOR_SYSTEM_PROMPT;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      system,
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
  if (event.blobs) connectBlobs(event);

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
    // Threaded from C1's triggerRefund. A CLOSED SET — see job-submit-background. The UI
    // derives its headline from this, never from parsing `reason`.
    refundClass: forcedRefundClass,
    walletAddress,
    // Deliverable data threaded from job-submit so we DON'T read it back from
    // Blobs (eventual-read lag ~11s intermittently returned a stale record →
    // spurious "no submitted deliverable" eval-error). Store read is a fallback.
    canonicalReport: bodyReport,
    deliverableHash: bodyHash,
    brief: bodyBrief,
    // ⭐ Threaded from job-submit for the same reason canonicalReport is: rebuilding the record from
    // the body must not DROP fields the submit pass wrote. dataPurchase is a sibling of `brief`, and
    // omitting it here is what made job #181056 settle with dataPurchase: null.
    dataPurchase: bodyDataPurchase,
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
      ? { status: "submitted", canonicalReport: bodyReport, deliverableHash: bodyHash, brief: bodyBrief,
          // ⚠️ `?? undefined`, never `?? null`: undefined lets the merge below preserve whatever the
          // submit pass already stored, while null would OVERWRITE it with an absence — which is the
          // exact failure being fixed.
          ...(bodyDataPurchase !== undefined ? { dataPurchase: bodyDataPurchase } : {}) }
      : null;

  // Merge eval results onto the existing record so we never lose the brief,
  // canonicalReport, submit tx, or PROPOSAL the C1 writer persisted.
  //
  // ⚠️ THE BUG THIS FIXES (job #155200). `prior` was read ONCE, with `|| {}` on miss.
  // Blobs reads are eventually consistent (~11s — see agent-execute-plan.mjs:82-90), so a
  // miss made `threaded` the base record and SILENTLY DESTROYED every field not in it:
  // the validated `proposal` (→ no approve button, ever) and `txHash`/`tx` (→ settled
  // briefs quietly lost their on-chain submit link, long before the proposal existed).
  // We now RETRY the read, exactly as the `entry` read below already does (:157-162).
  //
  // ⚠️ WHY WE DO NOT SIMPLY THREAD THE PROPOSAL THROUGH THE BODY.
  // `threaded` arrives in the internal POST body. The validated `proposal` has exactly ONE
  // origin today: validateProposal() running server-side in job-submit-background, written
  // straight to Blobs. job-bridge-approve reads that object for the destination and amount
  // it executes — that single origin IS the trust boundary. Threading it over the wire
  // would create a second, weaker origin for the one field that decides where money goes.
  // Keep `threaded` minimal; make `prior` authoritative instead.
  //
  // FAIL-CLOSED: if `prior` never converges we fall back to the old seed. The proposal is
  // then LOST (no approve button) rather than reconstructed from an untrusted source.
  // A missing proposal is a fine outcome; a forgeable one is not.
  // The ONLY keys the wire-supplied body may ever contribute to a persisted record. The
  // seed is rebuilt from this whitelist rather than spread from `threaded`, so the
  // guarantee is STRUCTURAL, not a side effect of how `threaded` happens to be built:
  // a body carrying `proposal` / `txHash` can never have them reach the store, no matter
  // what a future edit adds to the destructure above.
  const SEED_KEYS = ["status", "canonicalReport", "deliverableHash", "brief"];
  const seed = () =>
    threaded ? Object.fromEntries(SEED_KEYS.filter((k) => threaded[k] !== undefined).map((k) => [k, threaded[k]])) : {};

  const readPrior = async () => {
    // Only wait when a record is EXPECTED (the normal submit path threads one). On the
    // forced-refund path there may legitimately be nothing to find — don't stall 12s.
    const tries = threaded ? 8 : 1;
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500));
      const p = await store.get(jobId, { type: "json" }).catch(() => null);
      if (p) return p;
    }
    return null;
  };

  const persist = async (patch) => {
    const prior = await readPrior();
    if (!prior) {
      // Never converged. Fail-closed: brief + report survive, but `proposal` and `txHash`
      // are LOST rather than reconstructed from the wire. No approve button beats a
      // forgeable one.
      console.warn(`[evaluate] prior record never converged for job ${jobId}; seeding from threaded (proposal/txHash lost)`);
      await store.setJSON(jobId, { ...seed(), ...patch });
      return;
    }
    // Unchanged merge order: seed is only a floor, `prior` wins, `patch` wins over both.
    await store.setJSON(jobId, { ...seed(), ...prior, ...patch });
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
        // null when C1 didn't characterise it → the UI falls to its vaguest headline.
        refundClass: forcedRefundClass ?? null,
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

    // isPlanFlow is derived from the SERVER-VALIDATED proposal, never a client flag. The
    // threaded body may not carry the top-level `proposal` (SEED_KEYS omits it), so fall
    // back to the persisted record — which the readPrior retry has already made visible.
    let isPlanFlow = !!entry.proposal;
    if (!isPlanFlow) {
      const persisted = await store.get(jobId, { type: "json" }).catch(() => null);
      isPlanFlow = !!persisted?.proposal;
    }
    const judgment = await evaluate(apiKey, model, question, entry.brief, isPlanFlow);
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
      // ⭐ THE ONE PATH WHERE "didn't meet the bar" IS TRUE: a judge read the deliverable
      // and failed it on merit. The old headline said this about EVERY refund, including
      // ones where no judgement happened at all.
      ...(verdict === "fail" ? { refundClass: "judge-rejected" } : {}),
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
