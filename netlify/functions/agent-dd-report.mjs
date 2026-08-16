// agent-dd-report.mjs — POST /api/agent-dd-report { address, chain, policy? }  (session required)
//
// READ-ONLY. Signs an attestation over a chain observation; moves no money, writes no store.
//
// ═══ ⭐⭐ WHAT THIS IS: THE SAME REPORT, A DIFFERENT GATE ═════════════════════════════════════
// This is `evaluatePolicy`'s first consumer. It was built, tested 36/0 and mutation-tested with
// nothing calling it, and a policy evaluator with no consumer is a claim nobody has had to stand
// behind.
//
// The design constraint that makes it worth anything: the artifact evaluated here is the SAME
// artifact a paying buyer receives. Same schema, same quorum, same attestation, same completeness
// invariant — produced by the SAME code, `makeProduceReport` in _dd-rungs.mjs, not by a parallel
// in-app implementation that happens to look similar.
//
// ⚠️ THAT IS THE WHOLE POINT, AND IT IS EASY TO LOSE. A policy verdict is only worth something if
// the thing it evaluated can be INDEPENDENTLY CHECKED. If the card evaluated an in-app-only summary,
// the user's rules would be applied to an object that exists nowhere else, that no buyer can
// reproduce, and that no attestation covers. The rule would be real and the evidence would not be.
//
// ═══ ⭐ NO "LITE" REPORT ══════════════════════════════════════════════════════════════════════
// The full report goes back untouched. If the card needs less, the card renders less. A trimmed
// server-side variant is the first step toward two schemas, and the second is a card that shows a
// verdict derived from fields the buyer's copy does not contain.
//
// ═══ THE RUNGS THIS PATH SKIPS, AND WHY EACH IS A DIFFERENT QUESTION ══════════════════════════
//   · EXPOSURE — `DD_PUBLIC_ENABLED` governs whether an ANONYMOUS caller may reach a signed
//     attestation endpoint published under agentId 851891. This caller is session-authed and is
//     asking about a vault they are about to deposit into. Gating the card on the public flag would
//     mean shipping the service disabled — the correct, deliberate default — also silently removes
//     the deposit disclosure from the app.
//   · RETRIEVE   — redemption of a paid handle. There is no payment, so there is no handle.
//   · DISCOVERY  — the public human-facing page telling a stranger how to buy a report. This
//     route's only caller is our own fetch, which never asks for HTML and never needs selling to.
//   · PAYTO      — nothing is being sold, so there is no price to quote payable to nowhere.
//
// ═══ 🚨 HEALTH IS NOT SKIPPED, AND IT IS UNSKIPPABLE BY CONSTRUCTION ══════════════════════════
// `UNSKIPPABLE` in _dd-rungs.mjs throws if any entry point tries. The in-app path has a STRONGER
// reason to respect the health gate than a buyer does: a buyer who receives a report from an
// unverified detector loses the price of a report; a user who deposits on one loses the deposit.
// A detector that fails its own known-shape fixtures must not be the thing that tells someone their
// vault is fine.
//
// ═══ ⭐ QUORUM, AND NO CACHE UNTIL IT IS MEASURED ═════════════════════════════════════════════
// Byte-identical to a buyer's means quorum, which means the real per-render RPC load. It is NOT
// hidden behind a cache on this first cut, deliberately: Arc's public RPC has throttled this repo
// before, and the load is worth KNOWING before it is worth hiding. scripts/dd/verify-dd-report.mjs
// counts the calls against a counting transport and prints the measured number.
// ⚠️ Any cache added later inherits the CDN lesson: `no-store` stops new storage and CANNOT evict
// what is already stored.

import { json } from "./_arc.mjs";
import { connectBlobs } from "./_blobs.mjs";
import { requireSession } from "./_auth.mjs";
import { RUNG, runLadder, makeProduceReport, newCorrelationId, refusalReport } from "./_dd-rungs.mjs";
import { evaluatePolicy, POLICY_CEILING } from "../../shared/onchain-analyze/policy.mjs";

export async function handler(event) {
  const correlationId = newCorrelationId();
  try {
    if (event?.blobs) connectBlobs(event);

    // ── AUTH: the gate that replaces x402 ──────────────────────────────────────────────────────
    // ⚠️ AHEAD OF THE LADDER, not inside it. The ladder is about whether the SERVICE can answer;
    // this is about whether THIS CALLER may ask. Folding auth into the shared ladder would put a
    // rung in it that the public endpoint must skip, and every skippable rung is a rung some future
    // entry point can skip by accident. Keeping it here means the shared ladder has no auth concept
    // at all and cannot be misconfigured into having one.
    const session = requireSession(event);
    if (!session) return json(401, { error: "Authentication required" });

    // ── the ladder ─────────────────────────────────────────────────────────────────────────────
    // Named skips only. An unrecognised name throws rather than being ignored, and HEALTH cannot
    // appear here at all — assertSkipSet refuses it.
    const climbed = await runLadder({
      event,
      skip: [RUNG.EXPOSURE, RUNG.RETRIEVE, RUNG.DISCOVERY, RUNG.PAYTO],
      deps: {},
    });
    if (climbed.done) return climbed.done;
    const { addr, chain, body } = climbed;

    // ── the report — the SAME producer the paid path hands to runThenSettle ───────────────────
    const report = await makeProduceReport({ addr, chain, correlationId })();

    // ── the policy verdict ─────────────────────────────────────────────────────────────────────
    // ⚠️⚠️ THE POLICY IS CLIENT-SUPPLIED ON THIS CUT, SO THE VERDICT IS DISPLAY-ONLY. It must NOT
    // become an input to any gate, and nothing here writes it anywhere. The reason is the receipt
    // trust boundary this repo already established: every field of a record that carries authority
    // must be SERVER-SOURCED. A caller who can choose their own rules can choose rules that pass.
    //
    // ⭐ That is not a defect to fix by refusing — the rules ARE the user's, and showing them their
    // own rules applied to a verifiable artifact is exactly the feature. It is a defect only if the
    // verdict is ever allowed to authorise something. The next step in the chain closes it:
    // policy storage at `agent-policy` / `o/<owner>`, plus an override token binding the POLICY
    // DIGEST — without which a later edit makes a receipt claim a rule that no longer means the same.
    //
    // ⭐ AND `null` IS A FIRST-CLASS STATE, NOT A SHORTCUT. evaluatePolicy(report, null) returns
    // `passes:false, reason:"no-policy"` — "no rules set" is not "every rule satisfied". Passing
    // undefined through is therefore SAFE by construction rather than by this handler remembering
    // to special-case it.
    const policy = body?.policy ?? null;
    const verdict = evaluatePolicy(report, policy);

    return json(200, {
      subject: { address: addr, chain },
      // ⭐ THE FULL REPORT, UNMODIFIED. Not a projection, not a summary.
      report,
      policy: {
        ...verdict,
        // ⚠️ RIDES ON THE RESPONSE, machine-readable, for the same reason `severityMeaning` rides on
        // every report: so no consumer can claim it was not told. A UI rendering a green tick and
        // the word "safe" is contradicting a string handed to it in the same object.
        ceiling: POLICY_CEILING,
        // 🚨 STATED IN THE PAYLOAD, not only in this comment. A future reader of the JSON must be
        // able to see that this verdict authorises nothing.
        authority: "display-only",
        authorityNote:
          "This verdict was computed from a policy supplied in the request, so it is NOT server-sourced " +
          "and MUST NOT gate anything. It is shown so a user can see their own rules applied to a " +
          "report a buyer of this service could independently verify. Binding a policy to an action " +
          "requires server-side storage and a digest-bound override token, which do not exist yet.",
      },
      // The two things that make the artifact checkable by someone who was not in this session.
      verifiability: {
        attestation: report?.attestation?.status ?? null,
        note:
          "This is the same report, produced by the same code path, that /api/dd-analyze sells over " +
          "x402 — session auth replaces payment, nothing else differs. The attestation can be verified " +
          "against the on-chain owner of ERC-8004 agentId 851891.",
      },
    });
  } catch (e) {
    console.error(`[agent-dd-report ${correlationId}] unhandled:`, e);
    return json(500, refusalReport({
      reason: "internal-error",
      detail: `the request could not be processed. Reference: ${correlationId}`,
    }));
  }
}
