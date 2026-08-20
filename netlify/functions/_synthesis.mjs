// SYNTHESIS — reconcile two independent analysts. Disagreement is the SIGNAL.
//
// ⚠️ THE COMPARISON IS PLAIN CODE. NO MODEL DECIDES THIS.
// A synthesizer LLM that adjudicates re-introduces the single point of failure the second
// analyst exists to remove — and, worse, it will smooth over exactly the disagreement you
// built this to surface. Models are agreeable. So:
//
//     STRUCTURE decides   (this file: agree / caution / refuse — deterministic)
//     the MODEL explains  (_research.mjs's synthesizer: prose, cited, no authority)
//
// ⚠️ A CONFIDENCE SCORE IS NOT A SAFETY PROPERTY. A number the user can ignore does not stop
// a bad action. So disagreement changes WHETHER something is proposed, not just how it is
// decorated:
//
//   AGREE        → propose. Both analysts cited.
//   CAUTION      → propose, but the tension is stated plainly ABOVE the approve button.
//   HARD DISAGREE→ NO PROPOSAL. The agent declines and shows both analyses.
//
// That last rule is idiomatic here: _proposal.mjs is reject-never-clamp throughout, and the
// brief prompt already says "a null proposal is always an acceptable outcome; a poorly
// justified one is not."

// B's verdicts, in order of severity.
const REFUSE = "refuse";
const CAUTION = "caution";
const PROCEED = "proceed";
const CANNOT_VERIFY = "cannot_verify";
const NO_ACTION = "no_action";

/**
 * @param {object|null} proposalA  A's RAW proposal (may be null — A may honestly decline).
 * @param {object} analysisB       B's verdict (see _analystb.mjs).
 * @returns {{ agreement: string, proposalSurvives: boolean, headline: string, detail: string }}
 */
export function compareAnalyses(proposalA, analysisB) {
  const bSays = analysisB?.verdict ?? NO_ACTION;

  // ── A proposed nothing. ──
  // This is NOT a disagreement — it is A honestly declining, which the system treats as a
  // fine outcome. B had nothing to price. There is simply no action.
  if (!proposalA) {
    return {
      agreement: "no_action",
      proposalSurvives: false,
      headline: "Your analyst did not recommend an action.",
      detail: "There was nothing to act on, so nothing was proposed. That is a valid outcome, not a failure.",
    };
  }

  // ── B REFUSES. This OVERRIDES A, always. ──
  // B refuses on FACTS A cannot see: the route does not exist, the rate is far off fair, the
  // fee eats the amount. A narrative — however confident — cannot conjure liquidity. This is
  // the whole reason B exists, and the reason its refusal must be able to kill the proposal.
  if (bSays === REFUSE) {
    // ═══ ⭐⭐ A REFUSAL HAS THREE DIFFERENT CAUSES AND THEY ARE NOT THE SAME FACT ══════════════════
    // All three used to return agreement:"hard_disagree" with the copy "Your two analysts disagree"
    // and the reassurance "this is the safeguard working, not a failure". For an OUTAGE both are
    // FALSE: nobody disagrees (A wants the trade, B says the venue is down), and something IS
    // failing — just not us. Measured on five consecutive swap jobs, every one an outage wearing a
    // disagreement's label.
    //
    // 🚨 THE CAUSE IS READ FROM B'S TYPED FIELD, NEVER MATCHED OUT OF ITS PROSE. Re-deriving state
    // by searching the headline for "cannot execute" breaks the first time B rewords, and re-derives
    // downstream what is known exactly at the throw site. See _analystb.mjs.
    // ⚠️ An untagged refusal falls to `should-not-execute` — the pre-existing behaviour — rather
    // than to a new state it was never classified into. A missing tag must not silently become an
    // outage claim.
    const cause = analysisB?.cause ?? "should-not-execute";

    if (cause === "cannot-execute") {
      return {
        agreement: "cannot_execute",
        proposalSurvives: false,
        headline: "This action cannot be carried out right now — the venue is unavailable.",
        // ⭐ DIFFERENT COPY, NOT JUST A DIFFERENT ENUM. Renaming the state and keeping the
        // disagreement wording would have renamed the problem, not fixed it.
        detail:
          `Both of your analysts agree this is not something the agent can do at the moment. ` +
          `${analysisB.headline} This is not a disagreement about whether the action is wise, and it ` +
          `is not something you did — the venue that would carry it out is not currently accepting it. ` +
          `It is usually temporary; nothing has been spent and nothing is stuck.`,
      };
    }

    if (cause === "malformed-proposal") {
      return {
        agreement: "not_actionable",
        proposalSurvives: false,
        headline: "The proposed action was not well-formed, so there was nothing to price.",
        detail:
          `${analysisB.headline} No judgement was made about whether the action is a good idea — ` +
          `there was not enough of a proposal to check.`,
      };
    }

    // should-not-execute: the venue WORKS and B judges the economics bad. A REAL disagreement.
    return {
      agreement: "hard_disagree",
      proposalSurvives: false,
      headline: "Your two analysts disagree — so nothing is proposed.",
      detail:
        `One analyst argued for the action. The other priced it against the live market and the chain, and refuses: ` +
        `${analysisB.headline} When they disagree this hard, the agent does not act.`,
    };
  }

  // ── B CANNOT VERIFY. ──
  // Not a disagreement — an ABSENCE of a second opinion. Proposing on a single unchecked
  // analyst would quietly re-create the one-analyst system this brick replaces. Refuse.
  if (bSays === CANNOT_VERIFY) {
    return {
      agreement: "unverified",
      proposalSurvives: false,
      headline: "The action could not be independently checked, so it is not proposed.",
      detail:
        `${analysisB.headline} A proposal backed by only one analyst is exactly what the second analyst exists to prevent, ` +
        `so the agent declines rather than act on an unchecked recommendation.`,
    };
  }

  // ── B says the mechanics are fine, but expensive. ──
  // Both analysts point the same way; they differ on COST, not on direction. The proposal
  // survives — with the tension stated where the user cannot miss it.
  if (bSays === CAUTION) {
    return {
      agreement: "caution",
      proposalSurvives: true,
      headline: "Your analysts agree on the action, but not on the price.",
      detail:
        `One analyst makes the case for acting. The other checked what it would actually cost: ${analysisB.headline} ` +
        `The action is still proposed — you decide whether the cost is worth it.`,
    };
  }

  // ── AGREE. ──
  if (bSays === PROCEED) {
    return {
      agreement: "agree",
      proposalSurvives: true,
      headline: "Both analysts agree.",
      detail:
        `One made the case for acting; the other independently priced it against the live market and the chain and found ` +
        `the mechanics sound. ${analysisB.headline}`,
    };
  }

  // B had no action to price although A proposed one — a shape mismatch we do not understand.
  // Unknown state ⇒ do not act. Fail closed, as everything in this codebase does.
  return {
    agreement: "unverified",
    proposalSurvives: false,
    headline: "The second analyst could not review this action, so it is not proposed.",
    detail: "The agent declines rather than propose an action only one analyst has seen.",
  };
}
