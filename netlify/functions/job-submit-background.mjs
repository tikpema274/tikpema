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

import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { keccak256, toBytes } from "viem";
import { ARC, CONTRACTS, USDC_DECIMALS, parseBody, dateAnchor } from "./_arc.mjs";
import { circle, waitForTx, TxPendingError } from "./_circle.mjs";
import { validateProposal } from "./_proposal.mjs";
import { analystB } from "./_analystb.mjs";
import { compareAnalyses } from "./_synthesis.mjs";
import { research } from "./_research.mjs";
import { publicClient } from "./_predict.mjs";
import { requireInternal, internalToken } from "./_auth.mjs";
import { assertNotPaused } from "./_pause.mjs";
import { AGENT } from "./_agents.mjs";

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
  "sources": [{"title": "<title>", "url": "<url>"}], "confidence": <decimal 0..1>,
  "proposal": null | { "action": "bridge", "destination": "<chain name>", "amountUsdc": <number>, "reasoning": "<why this destination and amount>" }
              | { "action": "swap", "tokenIn": "USDC"|"EURC", "tokenOut": "USDC"|"EURC", "amountIn": <number>, "reasoning": "<why this direction and size>" } }
Use only the supplied sources as evidence; do not invent URLs.
Reference each source you rely on INLINE in "answer" / "reasoning" using its supplied number, e.g. [1] or [2], and list in "sources" ONLY the sources you actually relied on. A source you did not use must NOT appear — breadth is not evidence, and an uncited source listed as a source misrepresents the work.
Cite ONLY sources from the supplied set — never invent, guess, or modify a URL. If the supplied sources do not let you answer confidently — especially for a specific past date, price, or outcome — say so plainly in "answer" (state what you could not verify), set "confidence" low, and include only the real sources you do have. An honest "the available sources do not confirm this" is correct and acceptable; a fabricated source is never acceptable.

PROPOSAL: set "proposal" to null unless the question asks for ONE of the two actions below AND your research supports one concrete recommendation.

  • BRIDGE — the question asks whether/where/how much USDC to move CROSS-CHAIN off Arc. Supported destinations: Ethereum, Base, Arbitrum, Optimism, Avalanche, Polygon, Unichain, Linea (all testnets). Do NOT propose a fee — you cannot know it; the server prices it live and will reject an uneconomical bridge.

  • SWAP — the question asks whether/which direction/how much to convert between USDC and EURC on Arc (a stablecoin FX conversion: USD↔EUR exposure). Only USDC and EURC exist; tokenIn and tokenOut must differ. Do NOT propose a rate or an output amount — you cannot know them; the server prices the swap live against the user's own wallet and will reject one that returns nothing.

Do NOT propose an amount you cannot justify from the sources. If the honest answer is "do nothing", set "proposal" to null and say why in "answer". A null proposal is always an acceptable outcome; a poorly-justified one is not. You are proposing an action the user must then APPROVE — you are not executing it, and you are not giving investment advice.`;

const BRIEF_USER_INSTRUCTION =
  "Research this question and produce a client-ready brief with web search, " +
  "respond in the exact JSON format specified, and include real source URLs " +
  "from the searches you performed.";

// ── CITATION ENFORCEMENT FLAG ────────────────────────────────────────────────────────────────
// 🚨🚨 THE SAFE DEFAULT IS INVERTED HERE. READ THIS BEFORE "HARMONISING" IT.
//
// DD_PUBLIC_ENABLED: unset ⇒ REFUSE to serve ⇒ fail-CLOSED. Absence is the safe state.
// THIS FLAG:         unset ⇒ LOG-ONLY ⇒ SHIP the uncited brief ⇒ fail-OPEN. Absence is the
//                    PERMISSIVE state, and it is permissive ON PURPOSE, temporarily.
//
// Same STRUCTURE (only an explicit recognised value switches behaviour; anything else falls
// to the default), OPPOSITE safety direction. The two must NOT be made to match: a reader who
// notices "our other flag is fail-closed" and flips this one turns a measurement window into
// a live refund path with no data behind it. If you are here to make them consistent — don't.
//
// ⚠️ BECAUSE THE DEFAULT IS PERMISSIVE, A TYPO CANNOT FAIL CLOSED. `RESEARCH_CITATION_ENFORCE
// =enforcee` silently ships. So a set-but-unrecognised value is LOGGED LOUDLY — the absence
// of a fail-closed backstop is replaced by noise, which is the only defence left.
//
// ⏳ TIME-BOXED — THIS IS THE THIRD CHANCE TO KILL THIS GUARD, AND THE FIRST TWO SUCCEEDED.
//   1. dead by ACCIDENT: the old override always filled `sources`, so the branch never fired;
//   2. revived by the citation derivation (commit 1244aea);
//   3. ⚠️ dead by DRIFT if this flag is never flipped — log-only becomes permanent because
//      nobody owns the decision. Deliberate-by-inaction is still dead.
//
// 🚨 THE WINDOW RESTARTED. Production served the UNION derivation until the deploy that
// shipped PRECEDENCE (commit 9a93c10 + this change). Every [research][citation-shadow] and
// [research][citation-refusal] line emitted before that cutoff describes a derivation THAT NO
// LONGER EXISTS — the union cited sources the answer DISMISSED (job #160637), so its
// false-empty rate is not comparable. ⚠️ THE 50-BRIEF / <10% CRITERION MUST NOT BE MET WITH A
// BLEND: count only lines at or after the cutoff deploy id recorded in PROGRESS.md. If in
// doubt about a line's provenance, discard it — a mixed sample would satisfy the criterion
// without ever having measured the derivation being judged.
//
// EXIT CRITERION, fixed now while the reasoning is fresh — flip to "enforce" when BOTH hold:
//   · ≥50 evaluable briefs observed under this flag WITH at least one derivation signal
//     present (the backtest could only replay markers; live carries both), AND
//   · the false-empty rate among them is <10% — i.e. [research][citation-shadow] fires on
//     fewer than 1 in 10, and spot-checking the empties shows genuinely uncited answers
//     rather than good briefs that merely omitted markers.
// REVIEW BY 2026-08-31. If the data is not there by then, that is itself the finding:
// either traffic is too low to measure (decide on principle, don't keep waiting) or nobody
// is looking (assign it). Do not silently extend.
//
// Re-run scripts/backtest-citation-derivation.mjs against records written under this flag —
// unlike the historical corpus, those retain BOTH signals, so it measures rather than bounds.
const CITATION_ENFORCE_VALUE = "enforce";

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
  if (event.blobs) connectBlobs(event);

  // Internal-only: reached via the synchronous job-submit front door (which
  // authenticates the user), never directly by the browser. Requires the
  // internal token — a direct/anonymous call does no work. (Background functions
  // always return 202, so this early-return blocks the spend, not the status.)
  if (!requireInternal(event)) return { statusCode: 401, body: "unauthorized" };

  // walletAddress is the AUTHENTICATED user's OWN agent wallet, resolved from the
  // session by the job-run orchestrator and threaded through the internal chain
  // (never env, never client-supplied). All on-chain ops here run on THIS wallet.
  const { jobId, question, walletAddress } = parseBody(event);
  if (!jobId) {
    // Without a jobId there is nowhere to write the result — nothing to do.
    return { statusCode: 400, body: "jobId required" };
  }
  if (!walletAddress) {
    return { statusCode: 400, body: "walletAddress required" };
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
        headers: {
          "Content-Type": "application/json",
          // Server-to-server auth: proves this is the legitimate internal chain,
          // so job-evaluate can reject direct/anonymous calls.
          "x-internal-token": internalToken(),
        },
        // Thread the per-user wallet so settlement runs on the SAME wallet.
        body: JSON.stringify({ jobId, walletAddress, ...extra }),
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
  // ⭐ `refundClass` is a CLOSED SET, threaded explicitly — never inferred later by
  // parsing `reason`. The UI derives its headline from this, and a headline that names a
  // cause we did not establish is the costlier error (same rule as the watch alert:
  // an unknown reason goes to cannot-verify, never to known-broken). Classes:
  //   "uncited"        — a brief whose answer cites nothing we retrieved
  //   "no-brief"       — nothing parseable came back at all
  //   "internal-error" — we threw; the cause is ours and not characterised
  //   "judge-rejected" — set by the EVALUATOR, not here (the judge failed it on merit)
  const triggerRefund = async (reason, refundClass) => {
    // Refund runs on the user's OWN wallet (the job's client+provider), threaded
    // in from job-run — NOT the shared env wallet.
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
        refundClass: refundClass ?? null,
        submitTx,
      });

      // Pass the forced-reject signal EXPLICITLY in the body so the evaluator
      // doesn't have to read it back from the Blob.
      await triggerEvaluate({ forceReject: true, failHash, reason, refundClass: refundClass ?? null });
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

    // The funded budget IS the job price. getJob returns it as 6-decimal atomic
    // USDC (job-set-budget funds budgetUsdc * 10**USDC_DECIMALS), so convert back
    // to a USDC number. Phase 2a threads this into research() so a later step can
    // compute the per-job data allowance; it's surfaced only, not spent here.
    const jobPrice = Number(job.budget) / 10 ** USDC_DECIMALS;

    // 1. Research the question into a brief via the shared engine. Opt into the
    // Exa retrieval path so the brief is grounded on real retrieved sources;
    // _research falls back to web search if Exa is unavailable. Pass the Exa
    // system-prompt variant to match (it doesn't mention web search). Thread the
    // job context (jobId + jobPrice) for the later autonomous-purchase budget gate,
    // plus `owner` (this user's server-resolved wallet) so that gate's day ceiling
    // is keyed PER USER, not to a shared global total.
    const result = await research(
      question,
      `${BRIEF_SYSTEM_PROMPT_EXA}\n\n${dateAnchor()}`,
      BRIEF_USER_INSTRUCTION,
      { useExa: true, jobId, jobPrice, owner: walletAddress }
    );
    let decision = result.decision;

    // 2. Guard: never submit a brief we can't stand behind. Abort if the model
    // returned nothing parseable, or a brief with no real sources.
    //
    // 🚨 WHY AN UNCITED BRIEF REFUNDS — AND WHY THIS IS *NOT* THE SETTLE-GATE'S THIN CASE.
    // The DD settle-gate deliberately CHARGES for a THIN report (0/9 powers checked) and
    // refuses only an OUTAGE, on the reasoning that thin coverage is still an answer. It
    // is tempting to reconcile this guard with that rule and conclude we should ship an
    // uncited brief too. DO NOT. They are different products:
    //   · a thin DD report is the same deliverable with LESS of it — coverage is a dial;
    //   · a research brief with no citations is a DIFFERENT deliverable. THE CITATIONS ARE
    //     THE PRODUCT. An answer with no evidentiary basis is closer to FABRICATION than
    //     to thin coverage — the client is paying for "this is true, and here is why",
    //     and we would be billing for the first half with the second half absent.
    // ⚠️ This guard was DEAD before the citation derivation landed: the old override set
    // `sources` to the whole retrieval set, so it was never empty and this branch could
    // not fire. It went dead once by accident. Reconciling it with the settle-gate would
    // kill it again on purpose. See PROGRESS.md and scripts/verify-citation-derivation.mjs.
    const uncited =
      decision != null && Array.isArray(decision.sources) && decision.sources.length === 0;
    const noBrief = decision == null || !Array.isArray(decision.sources);

    // Only an explicit recognised value enforces. See the flag block at the top of this file
    // for WHY the default is permissive and why that is the opposite of DD_PUBLIC_ENABLED.
    const rawFlag = process.env.RESEARCH_CITATION_ENFORCE;
    const citationEnforcing = rawFlag === CITATION_ENFORCE_VALUE;
    if (rawFlag !== undefined && !citationEnforcing) {
      // A permissive default cannot fail closed on a typo, so make the typo audible.
      console.warn(
        `[research][citation-flag] RESEARCH_CITATION_ENFORCE is set to ${JSON.stringify(rawFlag)}, ` +
          `which is NOT the recognised value ${JSON.stringify(CITATION_ENFORCE_VALUE)} — ` +
          `falling back to LOG-ONLY (uncited briefs will SHIP). This is fail-OPEN by design; ` +
          `if you meant to enforce, the value is exactly "enforce".`
      );
    }

    // ⭐ RETENTION, LOGGED ON EVERY BRIEF — the second signal from the same instrumentation.
    // The backtest measured 174 → 112 sources retained (64.4%) on briefs that cited anything.
    // A live figure far from that after the "cite inline" prompt change means something else
    // moved (prompt, retrieval breadth, or model behaviour) and the derivation is not the only
    // variable — worth knowing BEFORE reading the false-empty rate as if it were clean.
    if (result.citation) {
      const c = result.citation;
      console.warn(
        "[research][citation-retention] " +
          JSON.stringify({
            jobId: String(jobId),
            retrieved: c.retrievedCount,
            cited: c.citedCount,
            retainedPct: c.retrievedCount ? +((c.citedCount / c.retrievedCount) * 100).toFixed(1) : null,
            backtestBaselinePct: 64.4,
            markers: c.inlineMarkers,
            modelSourceCount: c.modelSourceUrls.length,
          })
      );
    }

    if (noBrief || (uncited && citationEnforcing)) {
      // ⭐ INSTRUMENT THE RATE, DO NOT ESTIMATE IT. Every firing carries the full
      // derivation input set so a false empty can be reconstructed and counted, rather
      // than argued about. Stable prefix so the rate is greppable in function logs.
      console.warn(
        "[research][citation-refusal] " +
          JSON.stringify({
            jobId: String(jobId),
            cause: decision == null ? "no-decision" : "no-cited-sources",
            emptyReason: result.citation?.emptyReason ?? null,
            citation: result.citation ?? null,
            answer: decision?.answer ?? null,
            reasoning: decision?.reasoning ?? null,
            modelSources: decision?.sources ?? null,
            retrievedNotCited: decision?.retrievedNotCited?.map((s) => s?.url) ?? null,
          })
      );
      // No usable brief — don't leave the escrow stuck at FUNDED. Submit a
      // failure marker and let the evaluator force-reject it (client refunded).
      //
      // ⭐ THE REFUSAL MUST BE LEGIBLE. A bare refund reads as the product silently
      // breaking; a stated reason reads as the system doing its job. Same standard the
      // vault card holds — say what happened and what it means for the reader's money.
      await triggerRefund(
        uncited
          ? "We couldn't verify sources for this answer, so you weren't charged. " +
            "The research ran and produced an answer, but none of the sources we retrieved " +
            "actually supported it — and we don't bill for an answer we can't evidence."
          : "We couldn't produce a usable brief for this question, so you weren't charged.",
        uncited ? "uncited" : "no-brief"
      );
      return { statusCode: 202 };
    }

    // ── LOG-ONLY: uncited, but enforcement is off ────────────────────────────────────────
    // 🚨 SHIPPING `sources: []` WOULD NOT BE LOG-ONLY — IT WOULD BE A RELABELLED REFUND.
    // The judge is instructed to FAIL a brief under (b) when "the source list is empty"
    // (job-evaluate-background). So an uncited brief sent on with an empty list gets
    // rejected by the judge, refunds anyway, and lands under the WORST headline —
    // "the deliverable didn't meet the bar" — blaming the analyst for what is our own
    // derivation artifact. The measurement window would measure nothing and cost the
    // same refunds it exists to avoid.
    //
    // So during log-only we restore EXACTLY the pre-derivation behaviour for this case:
    // the full retrieval set as `sources`. ⚠️ That means the old retrieved≠supporting
    // defect persists — DELIBERATELY, TEMPORARILY, and ONLY for briefs that cite nothing.
    // Every brief that cites anything still gets the correct short list. This is the
    // narrowest possible carve-out, and it disappears the moment the flag flips.
    if (uncited) {
      console.warn(
        "[research][citation-shadow] " +
          JSON.stringify({
            jobId: String(jobId),
            wouldRefund: true,
            // ⭐ the CLASS it would have used, so the eventual rate is per-class, not aggregate
            wouldRefundClass: "uncited",
            // Sub-reason, NOT a separate refund class: the user-facing headline is the same
            // either way, but "named sources, none matched" (fabrication / normalisation bug)
            // and "named nothing" are different engineering events.
            emptyReason: result.citation?.emptyReason ?? null,
            enforcing: false,
            citation: result.citation ?? null,
            answer: decision.answer ?? null,
            reasoning: decision.reasoning ?? null,
            retrievedUrls: decision.retrievedNotCited?.map((s) => s?.url) ?? null,
          })
      );
      decision.sources = decision.retrievedNotCited ?? [];
      decision.retrievedNotCited = [];
    }

    // 2b. PROPOSAL — the model may have proposed a concrete bridge. Validate it the same
    // way _research.mjs:419-422 overwrites the model's `sources`: the model's word is
    // never the record. validateProposal() resolves the destination against OUR registry,
    // bounds the amount by the deployed cap (reject, never clamp), DISCARDS the model's
    // fee and re-prices it live, and refuses an un-settleable bridge. Any failure → null
    // → the brief renders with no proposal, which is a fine outcome. A wrong one is not.
    //
    // NOTE: a proposal must never be able to abort the research. It is strictly additive,
    // so a pricing hiccup degrades to "no proposal", never to a refund.
    // ── BRICK 2: THE SECOND, INDEPENDENT OPINION ────────────────────────────────────────
    //
    // Analyst A is the brief above (Exa-grounded narrative — it answers "SHOULD you?").
    // Analyst B (_analystb.mjs) never touches the web: it prices the SAME action against an
    // independent market source AND the live chain, and answers "is the rate you'd actually
    // GET fair, and can it even execute?" — a fact A structurally cannot see.
    //
    // ⚠️ B IS BLINDED TO A. It receives only WHICH action to price (the raw proposal's shape),
    // never A's prose or A's reasoning. Show B the argument and it anchors; anchor it and the
    // independence — the only thing that makes disagreement meaningful — collapses.
    //
    // ⚠️ THE COMPARISON IS PLAIN CODE (_synthesis.mjs). No model adjudicates. A synthesizer
    // LLM that decides would re-introduce the single point of failure B exists to remove, and
    // would smooth over precisely the disagreement we built this to surface. Structure
    // decides; the model only explains.
    //
    // A HARD DISAGREEMENT KILLS THE PROPOSAL. If B refuses (no route, rate far off fair, fee
    // eats the amount), the action is NOT proposed — whatever A argued. A confidence score
    // would not have stopped a bad action; a refusal does.
    // ── THE KILL SWITCH FOR THE SECOND ANALYST. ──────────────────────────────────────────
    // This check did not exist. The Agents page OFFERED a pause toggle for the Second opinion
    // and NOTHING HONOURED IT — analystB ran regardless. A control the UI presents and the code
    // ignores is worse than no control: the user believes they stopped the agent, and it kept
    // running. (Found while auditing metadata about to be recorded on-chain; `kill_switch: true`
    // would have made a dead switch permanent.)
    //
    // PAUSING THE REVIEWER MUST NOT LET AN UNREVIEWED PROPOSAL THROUGH. So a paused B maps to
    // `cannot_verify` — the SAME state as B crashing — which _synthesis.mjs already treats as
    // "no proposal at all" (proposalSurvives: false). Fail-closed, and it falls out of the
    // existing design rather than bolting a new branch onto it: pausing the second analyst
    // disables PROPOSALS, it does not silently disable the CHECK on them.
    //
    // The brief is unaffected. Only the proposal dies. That is the honest degradation.
    let secondOpinion = null;
    let synthesis = null;
    const bPaused = await assertNotPaused({ owner: walletAddress, agent: AGENT.ANALYST_B });
    if (bPaused) {
      console.log(`[analyst-b] PAUSED: ${bPaused} — no second opinion, so NO proposal.`);
      secondOpinion = {
        verdict: "cannot_verify",
        headline: `The second analyst is paused (${bPaused}), so this action could not be independently checked.`,
        facts: [],
      };
      synthesis = compareAnalyses(decision.proposal, secondOpinion);
    } else {
      try {
        secondOpinion = await analystB({ proposal: decision.proposal, walletAddress });
        synthesis = compareAnalyses(decision.proposal, secondOpinion);
      } catch (e) {
        // B failing is NOT a licence to act on one analyst. Unverified ⇒ no proposal.
        console.warn(`[analyst-b] failed: ${e.message}`);
        secondOpinion = { verdict: "cannot_verify", headline: `The second analyst could not run (${e.message}).`, facts: [] };
        synthesis = compareAnalyses(decision.proposal, secondOpinion);
      }
    }

    let proposal = null;
    try {
      // walletAddress = the AUTHENTICATED user's OWN agent SCA (resolved by the job spine
      // from requireSession → ensureOwnerWallet, never client-supplied). A SWAP proposal is
      // priced against THAT wallet, so the quote is the one that wallet would actually get —
      // per-user by construction, no shared pipeline. The bridge path ignores it.
      //
      // The second analyst gates this: a proposal only reaches validateProposal if BOTH
      // analysts leave it standing. validateProposal remains the final chokepoint (it
      // re-derives tokens, cap and rate server-side) — B does not weaken it, it precedes it.
      if (synthesis?.proposalSurvives) {
        proposal = await validateProposal(decision.proposal, { walletAddress });
      } else if (decision.proposal) {
        console.log(`[analyst-b] proposal KILLED by the second opinion: ${synthesis?.agreement} — ${secondOpinion?.headline}`);
      }
    } catch (e) {
      console.warn(`[research] proposal validation failed (no proposal, brief unaffected): ${e.message}`);
    }
    if (decision.proposal && !proposal) {
      console.log(
        "[research] model proposed an action; server REFUSED it " +
          "(bridge: unresolvable destination / over cap / unpriceable / fee ≥ amount — " +
          "swap: unknown token / same token / over cap in USDC-equivalent / unpriceable / zero out)"
      );
    }

    // 3. Build the canonical report and hash its exact bytes in memory.
    // ⚠️ The proposal is NOT part of the canonical report. The report's bytes are hashed
    // and anchored on-chain by submit(); adding a live-priced, server-derived field would
    // make the deliverable hash depend on IRIS at hash time. The proposal (and later the
    // receipt) live BESIDE it — two anchors, linked off-chain. See PROGRESS.
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
      ...(proposal ? { proposal } : {}),
      // The SECOND OPINION is persisted even when it KILLED the proposal — especially then.
      // "Your analysts disagreed, so nothing is proposed" is the most valuable thing this
      // brick produces, and it must be visible, not merely logged.
      ...(secondOpinion ? { secondOpinion } : {}),
      ...(synthesis ? { synthesis } : {}),
    });

    // 5. Submit on-chain as the provider (the user's OWN agent wallet, threaded
    // in from job-run) — submit() records the deliverable hash against the job.
    // Reuses Circle's dev-controlled wallet path (gas sponsored).
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
    // NOTE: this write REPLACES the record (it does not spread the prior one), so the
    // proposal must be re-included or it would be silently dropped between step 4 and
    // here — a brief would settle with its proposal gone and no error anywhere.
    await store.setJSON(jobId, {
      status: "submitted",
      canonicalReport,
      deliverableHash,
      brief: decision,
      ...(proposal ? { proposal } : {}),
      ...(secondOpinion ? { secondOpinion } : {}),
      ...(synthesis ? { synthesis } : {}),
      txHash,
      tx: `${ARC.explorer}/tx/${txHash}`,
    });

    // 7. Fire-and-forget: kick off evaluation so deliver→settle runs
    // automatically. Thread the deliverable data so the evaluator doesn't read
    // it back from Blobs (avoids the eventual-read race). The submit already
    // succeeded on-chain, so a trigger failure must only warn — never throw.
    await triggerEvaluate({ canonicalReport, deliverableHash, brief: decision });
  } catch (e) {
    // A still-pending submit tx is submitted-but-slow, not failed — record the
    // id so the poller can distinguish "slow" from "reverted".
    if (e instanceof TxPendingError) {
      await store.setJSON(jobId, { status: "pending", txId: e.txId, error: e.message });
    } else {
      // A real failure (research threw, etc.) — don't leave the escrow stuck at
      // FUNDED. Submit a failure marker and let the evaluator refund the client.
      // ⚠️ NOT a characterised failure — we threw, and the message is internal. It must
      // fall to the VAGUEST headline, never borrow a specific one.
      await triggerRefund(e.message, "internal-error");
    }
  }
  // 202 is conventional for an accepted-and-finished background invocation.
  return { statusCode: 202 };
}
