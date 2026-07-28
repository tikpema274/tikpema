// settle-gate.mjs — the ONE place that decides whether a request may be charged.
//
// ═══ ⭐ THE RULE: CHARGE FOR ANSWERS, NOT OUTAGES ═════════════════════════════════════════════
// Money is strictly DOWNSTREAM of the answer. The decision keys on "did the engine produce an
// answer about the subject", never on "did the caller pay". An EIP-3009 authorization is a signed
// PERMISSION, not a transfer — nothing moves until someone broadcasts it — which is what makes
// run-then-settle possible structurally rather than by discipline.
//
// ═══ 🚨 WHY THE GATE IS *NOT* "DID analyze() RETURN A REPORT OBJECT" ══════════════════════════
// That is the intuitive line and it is WRONG — it would charge for a total outage. analyze() throws
// on exactly two things, both programmer error (a missing client, a malformed address); EVERY other
// outcome, INCLUDING an unreachable chain, comes back as a report object. That is deliberate:
// "a refusal is a report, not an exception… a thrown error reads as 'the service broke', which
// invites a retry, a fallback, or a shrug, and none of those are the finding."
//
// The consequence for billing is exact: THE RETURN/THROW BOUNDARY CARRIES ZERO INFORMATION ABOUT
// ANSWER-VS-OUTAGE. So this gate reads the report's own structure instead, and requires ALL of:
//
//   1. a report object at all                    (nothing came back → nothing to sell)
//   2. a coverage manifest that ACCOUNTS FOR THE WHOLE CATALOGUE
//   3. refusal === null
//   4. a VERIFIABLE SIGNED ATTESTATION
//
// (2) and (3) independently catch an outage, which is the point of having both. A `chain-unreachable`
// report carries an EMPTY manifest (baseReport's skeleton, never populated because nothing ran), so
// it fails (2) even before (3) is consulted. Two structural facts, one conclusion.
//
// ═══ ⭐ WHY (4): SETTLING ON AN UNSIGNED REPORT SELLS X AND DELIVERS NOT-X ════════════════════
// The 402 challenge advertises "a signed on-chain due-diligence report… ERC-1271, verifiable against
// the on-chain owner of agentId 851891". Signing is a live Circle round trip, and attachAttestation
// DEGRADES to {status:"unsigned"} rather than failing — deliberately, so a signer outage cannot
// destroy an otherwise-good report. But "do not destroy the report" and "charge full price for it"
// are different decisions, and only the first one was ever made.
//
// A signer outage is OUR failure, in exactly the same category as the RPC outage that already does
// not settle. Charging for it is charging for our own outage. And the caller who paid for a signed
// report and received an unsigned one has been given the phantom-charge treatment this codebase
// prevents everywhere else — the same advertised-vs-delivered defect class as x402-quote's
// "real-time feed" label over canned values.
//
// FAIL-CLOSED, therefore: attestation ABSENT, `unsigned`, indeterminate, or any status this gate does
// not recognise → DOES NOT SETTLE. Only a positively-established signed attestation settles, and
// "signed" means the artifact actually carries what a verifier needs to check it — a status field
// with no signature behind it is a claim, not an attestation, and must never be enough.
//
// ⚠️ WHAT THIS PREDICATE CANNOT DO. It is pure and synchronous, so it cannot call isValidSignature
// and does not pretend to. It establishes that the artifact is VERIFIABLE — every field a verifier
// needs is present and well-formed — never that the signature is valid. That check belongs to the
// verifier (scripts/dd/verify-attestation.mjs, eth_call → 0x1626ba7e), and stating the boundary here
// is what stops "the gate checked it" being read as "the signature is good".
//
// ═══ WHY THIS IS AN ALLOWLIST, NOT A DENYLIST ═════════════════════════════════════════════════
// The gate settles only on a positively-established answer. A denylist ("settle unless the reason is
// one of these known outages") would mean a refusal reason added NEXT YEAR silently starts billing —
// charging for a failure mode nobody considered. Fail-closed here means: unrecognised → do not charge.
//
// ⚠️ THIS FILE HOLDS NO KEY, OPENS NO CONNECTION, AND MOVES NO MONEY. It is a pure predicate over a
// report plus an orchestrator that takes an injected settle function. Real facilitator integration is
// deliberately deferred so the ordering rule is testable without moving funds — the same spike-first
// discipline used for the ERC-1271 binding.

import { POWER_SIGS } from "../onchain-facts/index.mjs";

/** Closed outcome set. Anything not here is a programming error, not a new billing case. */
export const SETTLE_REASON = Object.freeze({
  ANSWERED: "answered",
  NO_REPORT: "no-report",
  NO_COVERAGE_MANIFEST: "no-coverage-manifest",
  COVERAGE_UNACCOUNTED: "coverage-unaccounted",
  REFUSED: "refused",
  UNSIGNED: "unsigned-attestation",
  ATTESTATION_UNVERIFIABLE: "attestation-unverifiable",
});

/** The ONLY attestation status that may be charged for. A set, not a truthiness check, so a status
 *  nobody anticipated is refused rather than coerced into meaning "fine". */
const CHARGEABLE_ATTESTATION_STATUS = new Set(["signed"]);

/** Fields a verifier MUST have to check the signature at all. Their presence does not make the
 *  signature valid — it makes the claim checkable, which is the most a pure predicate can establish. */
const REQUIRED_ATTESTATION_FIELDS = ["signature", "agentId", "verifyingContract", "chainId"];

/**
 * Decide whether this report may be charged for.
 *
 * @param {unknown} report  whatever the analysis produced — including nothing at all
 * @returns {{settle: boolean, reason: string, detail: string, evidence: object}}
 *          `settle` is a strict boolean and defaults to FALSE on every path.
 */
export function settleDecision(report) {
  const no = (reason, detail, evidence = {}) => ({ settle: false, reason, detail, evidence });

  // 1 — is there a report at all?
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return no(SETTLE_REASON.NO_REPORT,
      "the analysis produced no report object — there is nothing to sell, so there is nothing to charge for",
      { received: report === undefined ? "undefined" : report === null ? "null" : typeof report });
  }

  // 2 — is there a coverage manifest, and does it account for the whole catalogue?
  //     An outage report carries baseReport's EMPTY skeleton: it never ran, so nothing was recorded.
  const cov = report.coverage;
  if (!cov || !Array.isArray(cov.checked) || !Array.isArray(cov.notChecked)) {
    return no(SETTLE_REASON.NO_COVERAGE_MANIFEST,
      "the report carries no coverage manifest, so the caller could not see what was and was not checked",
      { coverage: cov === undefined ? "absent" : typeof cov });
  }
  const entries = [...cov.checked, ...cov.notChecked].filter((e) => e?.kind === "power");
  const seen = new Set(entries.map((e) => e.group));
  const missing = Object.keys(POWER_SIGS).filter((g) => !seen.has(g));
  if (missing.length) {
    return no(SETTLE_REASON.COVERAGE_UNACCOUNTED,
      "the coverage manifest does not account for every power group, so this report cannot be trusted not to be a false clean bill",
      { missing, accountedFor: seen.size, catalogue: Object.keys(POWER_SIGS).length });
  }

  // 3 — did the engine answer, or did it refuse?
  //     Every refusal currently reachable is our instrument failing or our invariant breaking:
  //       chain-unreachable   — we never got to ask
  //       shape-unclassified  — a read DID NOT COMPLETE (both paths set effectiveCode: UNREADABLE)
  //       coverage-incomplete — the catalogue grew and something was left unwired
  //     A genuine "no bytecode here" is shape.class "eoa" with refusal null, and settles correctly.
  if (report.refusal) {
    return no(SETTLE_REASON.REFUSED,
      `the engine refused: ${report.refusal.reason}. That is our instrument reporting it could not conclude, not a finding about the subject.`,
      { refusalReason: report.refusal.reason });
  }

  // 4 — is the artifact the SIGNED one we advertised?
  //     Checked LAST, after refusal, so the more specific cause wins: a refusal report is unsigned by
  //     design (signing anonymous malformed input would make this a signing oracle), and reporting
  //     that as "unsigned" instead of "refused" would name our symptom rather than the real reason.
  const att = report.attestation;
  if (!att || typeof att !== "object" || !CHARGEABLE_ATTESTATION_STATUS.has(att.status)) {
    return no(SETTLE_REASON.UNSIGNED,
      "the report could not be signed on this run, so it is not the signed attestation that was quoted. " +
      "A signer outage is OUR failure, in the same category as an unreachable chain — charging for it " +
      "would be charging for our own outage, and delivering an unsigned report against a price quoted " +
      "for a signed one would be selling one thing and handing over another. No charge; retry.",
      { attestationStatus: att && typeof att === "object" ? (att.status ?? "absent-status") : att === undefined ? "absent" : typeof att });
  }
  const missingFields = REQUIRED_ATTESTATION_FIELDS.filter((f) => {
    const v = att[f];
    return v === undefined || v === null || String(v).trim() === "";
  });
  const sigWellFormed = typeof att.signature === "string" && /^0x[0-9a-fA-F]+$/.test(att.signature);
  if (missingFields.length || !sigWellFormed) {
    // ⭐ status:"signed" is a CLAIM. Without the fields a verifier needs, nobody can ever check it,
    // and an unverifiable attestation is worth exactly as much as no attestation — so it is priced
    // the same. Refusing here also means a bug in the signing path cannot silently start billing.
    return no(SETTLE_REASON.ATTESTATION_UNVERIFIABLE,
      "the report claims to be signed but does not carry what a verifier needs to check it, so the " +
      "attestation cannot be validated by anyone. That is not a signed report, whatever the status " +
      "field says. No charge; retry.",
      { status: att.status, missingFields, signatureWellFormed: sigWellFormed });
  }

  return {
    settle: true,
    reason: SETTLE_REASON.ANSWERED,
    detail: "the engine produced an answer about the subject, with a manifest accounting for every power group",
    evidence: {
      checked: cov.totals?.checked ?? cov.checked.length,
      notChecked: cov.totals?.notChecked ?? cov.notChecked.length,
      // ⭐ THIN COVERAGE STILL SETTLES. An honest "here is what I could and could not check" IS the
      // product, and the manifest ships INSIDE the settled artifact (and inside the signature), so
      // the caller sees exactly the gaps they paid for. Surfaced as a ratio so they can judge for
      // themselves rather than infer — deliberately NOT a minimum-coverage threshold, which would
      // put a tunable number on the money path.
      // Computed over EVERY manifest entry, not just power groups. Scoping it to powers reported 1.0
      // for a report whose owner read was defeated — the ratio must reflect what the caller actually
      // did not get, or it is decoration.
      coverageRatio: (cov.checked.length + cov.notChecked.length)
        ? +(cov.checked.length / (cov.checked.length + cov.notChecked.length)).toFixed(3)
        : 0,
      // Recorded so the settled artifact says WHAT was charged for — a signed report — and names the
      // binding a verifier must check it against. ⚠️ `verifiable` means the fields are present and
      // well-formed, NOT that isValidSignature returned the magic value; this predicate never calls
      // the chain. Saying "verifiable" where a reader might hear "verified" is worth being precise
      // about, because the whole point of the field is that someone goes and checks.
      attestation: {
        status: att.status,
        method: att.method ?? null,
        agentId: att.agentId ?? null,
        verifyingContract: att.verifyingContract ?? null,
        verifiable: true,
        verifiedHere: false,
      },
    },
  };
}

/**
 * The caller-facing body when nothing is charged. Explicit, never silent.
 *
 * The authorization was never broadcast, so it is unspent and the caller may retry with it. There is
 * deliberately NO deferred-settlement queue: settling later for an outage IS charging for an outage.
 */
export function noChargeResponse(decision, report = null) {
  return {
    settled: false,
    charged: false,
    retryable: true,
    reason: decision.reason,
    detail: decision.detail,
    payment: "your payment authorization was NOT used and remains valid until its validBefore — it is unspent, and retrying with it is safe. No settlement was attempted and none will be attempted later.",
    report,
  };
}

/**
 * Run the analysis, THEN decide, THEN settle. The ordering is the product.
 *
 * `settle` is injected and is called AT MOST ONCE, only after a positive decision. Facilitator
 * integration lives in the caller, so this stays testable without moving money.
 *
 * @param {{produceReport: Function, settle: Function}} io
 * @returns {{report: object|null, decision: object, settlement: object|null, body: object}}
 */
export async function runThenSettle({ produceReport, settle }) {
  if (typeof produceReport !== "function") throw new Error("runThenSettle(): produceReport is required");
  if (typeof settle !== "function") throw new Error("runThenSettle(): settle is required — injected so this module never broadcasts");

  // The analysis runs FIRST, unconditionally, and its failure is caught rather than propagated:
  // an engine that throws must still produce a no-charge answer, not a 500 that kept the money.
  let report = null;
  try {
    report = await produceReport();
  } catch (e) {
    const decision = { settle: false, reason: SETTLE_REASON.NO_REPORT, detail: `the analysis threw: ${e?.message ?? e}`, evidence: { threw: true } };
    return { report: null, decision, settlement: null, body: noChargeResponse(decision, null) };
  }

  const decision = settleDecision(report);
  if (!decision.settle) {
    return { report, decision, settlement: null, body: noChargeResponse(decision, report) };
  }

  // Only now does anything touch money.
  const settlement = await settle(report);
  return { report, decision, settlement, body: { settled: true, charged: true, settlement, report } };
}
