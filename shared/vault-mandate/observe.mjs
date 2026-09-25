// observe.mjs — the VAULT MANDATE's adapter: a DD report + our own vault reads → one observation per
// rule, in the closed vocabulary decide.mjs consumes. Pure: no chain, no store, no clock.
//
// ═══ WHY THIS FILE IS WHERE THE DANGER IS ════════════════════════════════════════════════════
// decide.mjs exits only on `violated` with evidence. So an exit on a failure to read can only be
// born HERE, by an adapter that turns "could not tell" into "found", or into "clear". Every branch
// below that cannot establish a value returns UNESTABLISHED with a cause, never a guess:
//   OUTAGE        our instrument failed: no/unsigned/refused/wrong-subject/stale report; fewer than
//                 two independent reads at the anchor block. Retry.
//   INCONCLUSIVE  the instruments answered and could not establish it: a power group the report
//                 could not check, an unreadable owner(), endpoints that disagree, a declared fee its
//                 own preview contradicts, a redemption state of `unknown`.
//
// ═══ TWO SOURCES, JUDGED SEPARATELY (T, 2026-09-25: an unreadable rule does not veto an exit) ═══
//   · VERIFIED — the SIGNED DD report: power rules (via evaluatePolicy, the one derivation the
//     deposit gate and the card already share) and owner-changed (report.owner).
//   · MONITORED — our own UNSIGNED reads: exit fee, deposit fee, redemption. A value counts only
//     when TWO DIFFERENT endpoints return it at the SAME block hash (the anchor, EIP-1898). One
//     provider silently serving `latest` then shows up as a hash mismatch, not as a reading.
// A broken source blanks only the rules it serves. The DD engine being down must not cancel an exit
// rule on a fee two endpoints agree was raised, and the reverse.
//
// ⚠️ NOT DONE HERE (the transport piece's job): fetching and SIGNING the report, verifying the
// signature, pinning the anchor, reading both endpoints. This file checks attestation.status is
// "signed"; it does not check who signed. Evidence is copied into each finding so the receipt can
// show it: `signed: true` for the report's, `signed: false` for ours.

import { POWER_SIGS } from "../onchain-facts/index.mjs";
import { evaluatePolicy, RULE, POLICY_REASON } from "../onchain-analyze/policy.mjs";
import { OBSERVED, CAUSE, STATE_RULES } from "./decide.mjs";
import { classifyRedeemSimulation, REDEEM_SIM_CLASS } from "./redeem-sim.mjs";

/** Independent reads a MONITORED value needs before it can be a finding or a clear. */
export const STATE_READ_QUORUM = 2;
/** Declared vs measured exit fee: integer rounding in previewRedeem, the same 1 bp _vault.mjs allows. */
const FEE_AGREEMENT_BPS = 1;
const REDEMPTION_STATES = new Set(["full", "partial", "blocked", "unknown"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isHash = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isBps = (v) => Number.isInteger(v) && v >= 0;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const clear = (evidence) => ({ status: OBSERVED.CLEAR, ...(evidence ? { evidence } : {}) });
const violated = (evidence) => ({ status: OBSERVED.VIOLATED, evidence });
const outage = (why) => ({ status: OBSERVED.UNESTABLISHED, cause: CAUSE.OUTAGE, why });
const inconclusive = (why) => ({ status: OBSERVED.UNESTABLISHED, cause: CAUSE.INCONCLUSIVE, why });

/**
 * @param {{rules:Array, vault:{address,chainId}, anchor:{blockNumber:number, blockHash:string},
 *          maxReportAgeBlocks:number, report:object|null, reportFailure?:string|null, stateReadings:Array}} input
 * @returns {{outage:{reason:string}|null, observations:Object<string,object>, anchor:object|null}}
 *          exactly the `check` decideMandateAction consumes.
 */
export function observeMandateCheck({ rules, vault, anchor, maxReportAgeBlocks, report, reportFailure = null, stateReadings } = {}) {
  // ── a malformed CALL establishes nothing at all ────────────────────────────────────────────
  const whole = (reason) => ({ outage: { reason }, observations: {}, anchor: anchor ?? null });
  if (!Array.isArray(rules)) return whole("no rule list was supplied");
  if (!isObj(vault) || !isAddr(vault.address) || !Number.isInteger(vault.chainId)) return whole("no vault (address + chainId) was supplied");
  if (!isObj(anchor) || !Number.isInteger(anchor.blockNumber) || !isHash(anchor.blockHash)) {
    return whole("no anchor block (number + hash) was supplied, so no reading can be pinned");
  }
  if (!Number.isInteger(maxReportAgeBlocks) || maxReportAgeBlocks < 0) {
    return whole("maxReportAgeBlocks was not supplied; a report's staleness has no default");
  }

  // `reportFailure`: the transport's reason there is no report (signing failed, signer not verified …),
  // so the OUTAGE says why instead of a bare "no DD report was produced".
  const reportState = report === null && typeof reportFailure === "string" && reportFailure
    ? { usable: false, why: reportFailure }
    : judgeReport(report, { vault, anchor, maxReportAgeBlocks });
  const quorum = judgeReadings(stateReadings, anchor);

  // Power rules go through evaluatePolicy in ONE call, so the manifest semantics (notChecked before
  // present; an incomplete manifest refuses) are the shared ones, not a second copy.
  const powerRules = rules.filter((r) => r?.kind === "power" && r.subject in POWER_SIGS);
  let policy = null;
  if (reportState.usable && powerRules.length) {
    policy = evaluatePolicy(report, { rules: Object.fromEntries(powerRules.map((r) => [r.subject, RULE.REFUSE])) });
  }

  const observations = {};
  for (const r of rules) {
    if (!isObj(r) || typeof r.id !== "string") continue; // the decider refuses the rule set as malformed
    if (r.kind === "power") observations[r.id] = observePower(r, { reportState, report, policy });
    else if (r.subject === "owner-changed") observations[r.id] = observeOwner(r, { reportState, report });
    else if (r.kind === "state" && r.subject in STATE_RULES) observations[r.id] = observeState(r, quorum, anchor);
    // anything else: no observation → the decider sees it as missing (OUTAGE) or the set as malformed.
  }
  return { outage: null, observations, anchor };
}

// ── the VERIFIED source ────────────────────────────────────────────────────────────────────
function judgeReport(report, { vault, anchor, maxReportAgeBlocks }) {
  const no = (why) => ({ usable: false, why });
  if (!isObj(report)) return no("no DD report was produced");
  if (report.refusal) return no(`the DD engine refused (${report.refusal.reason ?? "unspecified"})`);
  if (report.attestation?.status !== "signed") return no("the DD report is not signed");
  const s = report.subject;
  if (!isObj(s) || !same(s.address, vault.address)) return no("the DD report is about a different address");
  if (Number(s.chainId) !== vault.chainId) return no("the DD report is about a different chain");
  if (!Number.isInteger(s.blockNumber)) return no("the DD report names no block");
  if (s.blockNumber > anchor.blockNumber) return no(`the DD report (block ${s.blockNumber}) is from after the anchor block ${anchor.blockNumber}`);
  if (anchor.blockNumber - s.blockNumber > maxReportAgeBlocks) {
    return no(`the DD report (block ${s.blockNumber}) is more than ${maxReportAgeBlocks} blocks older than the anchor ${anchor.blockNumber}`);
  }
  return { usable: true, block: s.blockNumber };
}

function observePower(rule, { reportState, report, policy }) {
  if (!reportState.usable) return outage(reportState.why);
  if (!policy || policy.reason === POLICY_REASON.REPORT_UNUSABLE || policy.reason === POLICY_REASON.MALFORMED_POLICY) {
    return outage(`the DD report could not be evaluated: ${policy?.detail ?? "no evaluation"}`);
  }
  const unreadable = policy.unreadableFailures.find((f) => f.group === rule.subject);
  if (unreadable) return inconclusive(unreadable.detail);
  const found = policy.failures.find((f) => f.group === rule.subject);
  if (found) {
    const p = report.powers?.find?.((x) => x.power === rule.subject);
    return violated({
      source: "dd-report", signed: true, reportBlock: reportState.block,
      group: rule.subject, matched: p?.matched ?? [], readId: p?.evidence?.readId ?? null,
      reading: found.detail,
    });
  }
  // Not found and not unreadable: evaluatePolicy checked this group. "No selector found", which is
  // what a pass can mean (POLICY_CEILING), not "the contract cannot do this".
  return clear();
}

function observeOwner(rule, { reportState, report }) {
  if (!reportState.usable) return outage(reportState.why);
  const o = report.owner;
  if (!isObj(o) || !isAddr(o.address)) {
    return inconclusive(`the DD report could not establish the owner (${o?.kind ?? "no owner field"}), so whether it changed is unknown`);
  }
  const evidence = {
    source: "dd-report", signed: true, reportBlock: reportState.block,
    baselineOwner: rule.baselineOwner, observedOwner: o.address, observedKind: o.kind ?? null,
  };
  return same(o.address, rule.baselineOwner) ? clear() : violated({ ...evidence, reading: `owner is ${o.address}, was ${rule.baselineOwner}` });
}

// ── the MONITORED source ───────────────────────────────────────────────────────────────────
function judgeReadings(readings, anchor) {
  if (!Array.isArray(readings)) return { ok: false, why: "no state readings were supplied" };
  const byEndpoint = new Map();
  let offAnchor = 0;
  for (const r of readings) {
    if (!isObj(r) || r.ok === false || typeof r.endpoint !== "string" || !r.endpoint) continue;
    if (!same(r.blockHash, anchor.blockHash)) { offAnchor++; continue; }
    if (!byEndpoint.has(r.endpoint)) byEndpoint.set(r.endpoint, r);
  }
  if (byEndpoint.size < STATE_READ_QUORUM) {
    return { ok: false, why: `${byEndpoint.size} independent read(s) at the anchor block, ${STATE_READ_QUORUM} needed` +
      (offAnchor ? ` (${offAnchor} reading(s) were at a different block)` : "") };
  }
  return { ok: true, readings: [...byEndpoint.values()].slice(0, STATE_READ_QUORUM) };
}

/** One reading's exit fee: measured and declared must agree when both exist; neither → null. */
function exitFeeOf(r) {
  const d = r.exitFee?.declaredBps, m = r.exitFee?.measuredBps;
  const hasD = isBps(d), hasM = isBps(m);
  if (hasD && hasM && Math.abs(d - m) > FEE_AGREEMENT_BPS) {
    return { disagree: `the vault declares ${d} bps but its own preview measures ${m} bps at ${r.endpoint}` };
  }
  if (hasM) return { value: m };
  if (hasD) return { value: d };
  return { value: null };
}

function observeState(rule, quorum, anchor) {
  if (!quorum.ok) return outage(quorum.why);
  const [a, b] = quorum.readings;
  const base = { source: "tikpema-read", signed: false, blockNumber: anchor.blockNumber, blockHash: anchor.blockHash, endpoints: [a.endpoint, b.endpoint] };

  if (rule.subject === "exit-fee-above" || rule.subject === "deposit-fee-above") {
    const what = rule.subject === "exit-fee-above" ? "exit fee" : "deposit fee";
    const of = rule.subject === "exit-fee-above" ? exitFeeOf : (r) => ({ value: isBps(r.depositFeeBps) ? r.depositFeeBps : null });
    const fa = of(a), fb = of(b);
    if (fa.disagree || fb.disagree) return inconclusive(fa.disagree ?? fb.disagree);
    if (fa.value === null || fb.value === null) return inconclusive(`the ${what} could not be read at one or both endpoints`);
    // Rounding slack applies only between a vault's declared and measured figure, never between
    // endpoints: two providers reading the same block must return the same number.
    if (fa.value !== fb.value) return inconclusive(`the endpoints disagree on the ${what}: ${fa.value} vs ${fb.value} bps`);
    const evidence = { ...base, valueBps: fa.value, limitBps: rule.limitBps };
    return fa.value > rule.limitBps
      ? violated({ ...evidence, reading: `${what} ${fa.value} bps is above your limit of ${rule.limitBps} bps` })
      : clear(evidence);
  }

  if (rule.subject === "redemption-restricted") {
    const sa = a.redemption?.state, sb = b.redemption?.state;
    if (!REDEMPTION_STATES.has(sa) || !REDEMPTION_STATES.has(sb)) return inconclusive(`unrecognised redemption state (${sa} / ${sb})`);
    if (sa !== sb) return inconclusive(`the endpoints disagree on redemption: ${sa} vs ${sb}`);
    if (sa === "unknown") return inconclusive("whether you can redeem could not be read");
    // With no position there is nothing to withhold. Clear, and the evidence says it was vacuous so a
    // receipt never presents it as a tested exit.
    if (a.redemption?.positionShares === "0" && b.redemption?.positionShares === "0") {
      return clear({ ...base, note: "no position held yet, so there was nothing to restrict; this is not a test of the exit" });
    }
    if (sa === "partial" || sa === "blocked") return violated({ ...base, redemptionState: sa, reading: `redemption is ${sa}` });
    return clear({ ...base, redemptionState: sa });
  }
  if (rule.subject === "vault-cannot-pay") return observeCannotPay(a, b, base);
  return outage(`no reader for state rule "${rule.subject}"`);
}

/**
 * vault-cannot-pay (PAUSE-ONLY; why: decide.mjs STATE_RULES). Two readings, chosen by position:
 *   · HOLDING shares → a simulated redeem of exactly those shares from the holder, per endpoint,
 *     sorted by classifyRedeemSimulation. Only SHORTFALL at BOTH endpoints is a finding.
 *   · NO position   → cash vs counter (USDC.balanceOf(vault) vs totalAssets). Valid ONLY on a vault
 *     profiled cash-only (`cashOnly: true`, xylo: no strategy ever moves funds); elsewhere the counter
 *     includes positions that are not cash, and the comparison means nothing → INCONCLUSIVE.
 * The wrong reading for the position is our instrument's mistake → OUTAGE.
 */
function observeCannotPay(a, b, base) {
  const pa = a.payability, pb = b.payability;
  if (!isObj(pa) || !isObj(pb)) return outage("whether the vault can pay was not read at one or both endpoints");
  const holding = [a, b].map((r) => r.redemption?.positionShares);
  if (holding[0] !== holding[1] || typeof holding[0] !== "string" || !/^[0-9]+$/.test(holding[0])) {
    return outage("the position size was not read consistently, so the right payability reading cannot be chosen");
  }
  const want = holding[0] === "0" ? "aggregate" : "simulated-redeem";
  if (pa.mode !== want || pb.mode !== want) {
    return outage(want === "simulated-redeem"
      ? "you hold shares, so your own redeem must be simulated; the aggregate figure does not say whether YOU can be paid"
      : "no position is held, so there is nothing to simulate; the aggregate figure is needed");
  }

  if (want === "simulated-redeem") {
    if (pa.sharesRaw !== holding[0] || pb.sharesRaw !== holding[0]) return outage("the simulated share amount is not the position read at the anchor block");
    const ca = classifyRedeemSimulation(pa.outcome), cb = classifyRedeemSimulation(pb.outcome);
    const cls = [ca.class, cb.class];
    const why = `${a.endpoint}: ${ca.why}; ${b.endpoint}: ${cb.why}`;
    if (cls.some((k) => k === REDEEM_SIM_CLASS.OUR_ERROR || k === REDEEM_SIM_CLASS.RPC_FAILURE)) return outage(why);
    if (cls.some((k) => k === REDEEM_SIM_CLASS.UNRECOGNISED)) return inconclusive(why);
    if (ca.class !== cb.class) return inconclusive(`the endpoints disagree: ${why}`);
    const evidence = { ...base, method: "simulated-redeem", sharesRaw: holding[0] };
    return ca.class === REDEEM_SIM_CLASS.SHORTFALL
      ? violated({ ...evidence, revertReason: ca.reason, reading: `a redeem of your shares reverts: "${ca.reason}"` })
      : clear({ ...evidence, note: "the vault could pay you at this block; that can change in the next one" });
  }

  if (pa.cashOnly !== true || pb.cashOnly !== true) {
    return inconclusive("this vault is not profiled as holding its assets as cash, so cash vs totalAssets does not show whether it can pay");
  }
  const num = (v) => (typeof v === "string" && /^[0-9]+$/.test(v) ? BigInt(v) : null);
  const [cashA, cntA, cashB, cntB] = [num(pa.cashRaw), num(pa.counterRaw), num(pb.cashRaw), num(pb.counterRaw)];
  if ([cashA, cntA, cashB, cntB].some((x) => x === null)) return inconclusive("the vault's cash or what it owes could not be read");
  if (cashA !== cashB || cntA !== cntB) return inconclusive("the endpoints disagree on the vault's cash or what it owes");
  const evidence = { ...base, method: "cash-vs-counter", cashRaw: pa.cashRaw, counterRaw: pa.counterRaw };
  return cashA < cntA
    ? violated({ ...evidence, reading: `the vault holds ${pa.cashRaw} but owes ${pa.counterRaw} (raw units)` })
    : clear(evidence);
}
