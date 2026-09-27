// record.mjs — the VAULT MANDATE RECORD: the rules the user set, the disclosure BUILT FROM them, and
// the fingerprint the user acknowledges. Pure: no store, no chain, no clock (callers pass `now`).
//
// ═══ WHAT THIS RECORD AUTHORISES ═════════════════════════════════════════════════════════════
// An agent depositing into a vault, and on an established finding WITHDRAWING, while no user is
// present. Like the DCA mandate, the stored record IS the authorisation, so it is a security
// artefact, not config. Four properties hold here and nowhere else:
//   1. NOTHING IS DEFAULTED. Every rule states `pause` or `exit`, written by the user (the UI may
//      pre-select pause; the record only stores what was sent). decide.mjs's validator runs on
//      every build, amend, verify and store write, so "exit" on a pause-only rule is refused at
//      WRITE time, not first at decide time.
//   2. THE BASELINE IS THE SERVER'S. The owner-changed rule compares against the owner recorded when
//      the mandate was made, from a signed DD report whose signer was verified. A client-supplied
//      baselineOwner is refused: otherwise a caller picks the owner the rule compares to.
//   3. THE DISCLOSURE IS DERIVED, NEVER STORED BESIDE. renderDisclosure(record) is the only writer;
//      verify re-renders and refuses a record whose stored disclosure differs from its rules.
//   4. THE ACKNOWLEDGEMENT BINDS BOTH. The fingerprint covers the rules AND the disclosure text. A
//      mandate may act only when `ack.fingerprint` equals the fingerprint recomputed NOW, so any rule
//      change (even one written back with a consistent disclosure and fingerprint) leaves the old
//      acknowledgement stale, and a stale mandate does not act.

import { createHash } from "node:crypto";
import { validateMandateRules, STATE_RULES, ON_FINDING } from "./decide.mjs";
import { validateMandateTerms, EXIT_AVAILABLE, MANDATE_DAY_SHARE, MANDATE_AUTONOMOUS_MAX_SHARE } from "./limits.mjs";
import { isOperatorOwner } from "./operators.mjs";
import {
  EXIT_NOT_GUARANTEED, EXIT_FEE_RISE, VERIFIED_PARAGRAPH, MONITORED_PARAGRAPH, CHECKED_AFTER_PARAGRAPH,
  PAYOUT_NOT_GUARANTEED,
} from "./copy.mjs";

// vault-mandate/2 (piece 4): + the deposit TERMS, the vault disclosure token the user acknowledged
// (baseline.vaultAckToken), a `paused` status with its flags, and `progress`.
// ═══ vault-mandate/3 (2026-09-27, PROGRESS "FINDING A" §2 + "PIECE 5 DECISIONS") — ONE BUMP, THREE CHANGES ═══
//   1. THE SPLIT. A pause means DEPOSITS paused, never "stopped watching". The record carries three halves:
//        status      awaiting-ack | active | exiting | exit-blocked | closed | cancelled   (the mandate's lifecycle)
//        deposits    running | paused {flags, reason, at}                                   (latched by findings /
//                                                                                            inconclusive, NEVER by an outage)
//        monitoring  watching | degraded {since, consecutiveFailures} | stopped {why}      (piece 5 / monitoring)
//      and the single `mayAct` splits: `mayDeposit` (active, acknowledged against NOW, deposits running) and
//      `mayMonitor` (consistent, not closed or cancelled). A stale acknowledgement keeps monitoring able to
//      notify but removes the authority to deposit (and, in piece 5, to exit).
//   2. ORIGIN ("user" | "operator"), INSIDE the fingerprint: flipping it in the store leaves the acknowledgement
//      stale, so a relabelled mandate cannot act. Only the operator path may write "operator" (a source guard in
//      test:mandaterecord); the create core defaults to "user" and refuses it in a request body.
//   3. TRACKED SHARES (Finding B: an exit redeems min(tracked, live), never what the user deposited by hand).
//      `progress.sharesTrackedRaw` = shares the mandate's own deposits RECEIVED, as established by the post-deposit
//      assertion (event = share delta). A deposit whose shares could not be established adds a GAP
//      (`sharesTrackedGaps`), never 0 and never a guess — piece 5 must refuse to treat a gapped figure as exact.
// No /2 record was ever stored (no create endpoint exists), so nothing migrates: a /2 record reads "unknown
// schema" and can do nothing.
export const MANDATE_SCHEMA = "vault-mandate/3";
/** The lifecycle. Anything not listed is inconsistent. */
export const MANDATE_STATUS = Object.freeze({
  AWAITING_ACK: "awaiting-ack", ACTIVE: "active", EXITING: "exiting", EXIT_BLOCKED: "exit-blocked", CLOSED: "closed", CANCELLED: "cancelled",
});
const KNOWN_STATUS = new Set(Object.values(MANDATE_STATUS));
/** Terminal: neither deposits nor monitoring. */
const TERMINAL_STATUS = new Set([MANDATE_STATUS.CLOSED, MANDATE_STATUS.CANCELLED]);
/** A rule change re-opens the mandate for acknowledgement; these must never be re-opened or re-authorised that way. */
const NOT_AMENDABLE = new Set([MANDATE_STATUS.CLOSED, MANDATE_STATUS.CANCELLED, MANDATE_STATUS.EXITING, MANDATE_STATUS.EXIT_BLOCKED]);
export const DEPOSITS_STATE = Object.freeze({ RUNNING: "running", PAUSED: "paused" });
export const MONITORING_STATE = Object.freeze({ WATCHING: "watching", DEGRADED: "degraded", STOPPED: "stopped" });
/** Who made the mandate. ⛔ Only the operator path writes OPERATOR (source guard, test:mandaterecord). */
export const MANDATE_ORIGIN = Object.freeze({ USER: "user", OPERATOR: "operator" });
const KNOWN_ORIGIN = new Set(Object.values(MANDATE_ORIGIN));
const CADENCE_TEXT = Object.freeze({ daily: "once a day", weekly: "once a week" });

// ── The day shares, in WORDS rendered from the constants (T, 2026-09-26), so the disclosure cannot drift
// from the caps it describes. ⛔ An unmapped value THROWS rather than falling back to a decimal nobody
// approved: changing MANDATE_DAY_SHARE or MANDATE_AUTONOMOUS_MAX_SHARE fails this module's import until its
// words are written here. (Changing a share also changes every disclosure → every fingerprint → existing
// acknowledgements go stale and those mandates stop until the user reads the new limit. That is intended.)
const SHARE_WORDS = Object.freeze({ 0.25: "a quarter", 0.5: "half" });
export function shareWords(fraction) {
  const w = Object.prototype.hasOwnProperty.call(SHARE_WORDS, String(fraction)) ? SHARE_WORDS[String(fraction)] : undefined;
  if (typeof w !== "string") throw new Error(`no approved words for the share ${JSON.stringify(fraction)}: add them to SHARE_WORDS (record.mjs) before changing the constant`);
  return w;
}
// Resolved at import, so a bad constant fails on load, not first at a user's disclosure.
const DAY_SHARE_WORDS = shareWords(MANDATE_DAY_SHARE);
const AUTONOMOUS_SHARE_WORDS = shareWords(MANDATE_AUTONOMOUS_MAX_SHARE);
/** Every deposit advances this; it is deliberately OUTSIDE the fingerprint, so the ack survives it. */
export const freshProgress = () => ({ depositedUsdc: 0, depositCount: 0, nextSeq: 1, nextDueAt: null, lastDepositAt: null,
  sharesTrackedRaw: "0", sharesTrackedGaps: 0 });
export const freshDeposits = () => ({ state: DEPOSITS_STATE.RUNNING });
export const freshMonitoring = () => ({ state: MONITORING_STATE.WATCHING });

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isAddr = (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isFp = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isAckToken = isFp; // ackTokenFor (_vault.mjs): sha256 hex
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;

// The fields a client may send per rule. Anything else (an id, a baselineOwner) is refused by name.
const INPUT_RULE_FIELDS = new Set(["kind", "subject", "onFinding", "limitBps"]);

const POWER_TEXT = Object.freeze({
  emergencyWithdraw: "can pull funds out of the vault (emergencyWithdraw)",
  feesSettable: "can change the vault's fees",
  setStrategy: "can point the vault at a different strategy",
  setFeeRecipient: "can change who receives the vault's fees",
  transferOwnership: "can hand control of the vault to someone else",
  pausable: "can pause the vault",
  upgradeable: "can replace the vault's code (it is upgradeable)",
  denylist: "can block addresses from using the vault",
  withdrawalDelay: "can make withdrawals wait",
});
const SOURCE = Object.freeze({ VERIFIED: "verified by the signed report", MONITORED: "monitored by Tikpema" });
const sourceOf = (r) => (r.kind === "power" || r.subject === "owner-changed" ? SOURCE.VERIFIED : SOURCE.MONITORED);

function describeRule(r) {
  if (r.kind === "power") return `The vault's owner ${POWER_TEXT[r.subject] ?? `holds the "${r.subject}" power`}`;
  switch (r.subject) {
    // A limit of 0 is zero tolerance: "rises above 0.00%" reads as a threshold; the rule is "any fee at all".
    case "exit-fee-above": return r.limitBps === 0 ? "The vault charges any exit fee at all" : `The exit fee rises above ${pct(r.limitBps)}`;
    case "deposit-fee-above": return r.limitBps === 0 ? "The vault charges any deposit fee at all" : `The deposit fee rises above ${pct(r.limitBps)}`;
    case "owner-changed": return `The vault's owner changes from ${r.baselineOwner}`;
    case "redemption-restricted": return "You can redeem only part of your shares, or none";
    case "vault-cannot-pay": return "The vault cannot pay you: it holds less USDC than it owes, or a test redeem of your shares fails for lack of cash";
    default: return `Rule "${r.subject}"`;
  }
}

/** The disclosure, derived from the record alone. The ONLY writer of `record.disclosure`. */
export function renderDisclosure(record) {
  const v = record.vault ?? {};
  const ruleLines = (record.rules ?? []).map((r, i) => {
    const pauseOnly = r.kind === "state" && STATE_RULES[r.subject]?.exitAllowed === false ? " (this rule can only pause)" : "";
    return `${i + 1}. ${describeRule(r)} [${sourceOf(r)}]${pauseOnly} — if found: ${r.onFinding}.`;
  });
  const cap = record.baseline?.maxFeeBps;
  const capSentence = Number.isInteger(cap)
    ? `This vault's exit fee cap is ${pct(cap)}, from our reading when this mandate was made.`
    : "This vault's exit fee cap could not be read when this mandate was made.";
  const t = record.terms ?? {};
  // Wording by T, 2026-09-26. The vault ack token stays in the record (baseline.vaultAckToken, inside the
  // fingerprint) and out of the text. The two shares are rendered from limits.mjs (SHARE_WORDS above).
  const termsSentence = `We deposit ${t.amountPerDepositUsdc} USDC ${CADENCE_TEXT[t.cadence] ?? `on cadence "${t.cadence}"`}, never more than ` +
    `${t.maxTotalUsdc} USDC in total. A mandate can use at most ${DAY_SHARE_WORDS} of your daily agent limit, and all your ` +
    `autonomous agents together at most ${AUTONOMOUS_SHARE_WORDS} — so this never spends your whole day's room. When there is no room, ` +
    "the deposit is skipped, not forced.";
  // ⭐ THE EXIT PARAGRAPHS ARE CONDITIONAL (T, 2026-09-26). Decision 2 exists so a disclosure never talks about
  // exiting while nothing can exit. Placement follows copy.mjs (T, 2026-09-25):
  //   · the fee-rise sentence (+ the cap it names) — beside a rule set to EXIT;
  //   · "An exit is not guaranteed" — beside any exit rule;
  //   · "Getting your USDC back is not guaranteed" — beside vault-cannot-pay when NO rule exits (T, 2026-09-26).
  // An exit rule wins where both apply; never both paragraphs. A pause-only mandate without vault-cannot-pay
  // renders none of them.
  const rules = record.rules ?? [];
  const hasExit = rules.some((r) => r.onFinding === ON_FINDING.EXIT);
  const hasCannotPay = rules.some((r) => r.kind === "state" && r.subject === "vault-cannot-pay");
  const exitLines = [
    ...(hasExit ? [`${EXIT_FEE_RISE} ${capSentence}`] : []),
    ...(hasExit ? [EXIT_NOT_GUARANTEED] : hasCannotPay ? [PAYOUT_NOT_GUARANTEED] : []),
  ];
  const ackSentence = "You acknowledged this vault's disclosure as it read when you made this mandate. If the vault's terms " +
    "change, your mandate pauses and nothing is deposited until you have read them again.";
  const text = [
    // "at <address>", not "(<address>)": allowlist labels already end in "(xyUSDC)" and the parens doubled.
    `Vault mandate for ${v.label ?? v.key} at ${v.address} on chain ${v.chainId}. ${termsSentence}`,
    ackSentence,
    "Before every deposit we check the rules you set:",
    ...ruleLines,
    "",
    VERIFIED_PARAGRAPH,
    MONITORED_PARAGRAPH,
    CHECKED_AFTER_PARAGRAPH,
    ...(exitLines.length ? ["", ...exitLines] : []),
  ].join("\n");
  return { ruleLines, text };
}

const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);

/** sha256 over everything the user acknowledges: the rules AND the disclosure, plus what they bind to. */
export function mandateFingerprint(record) {
  const bound = {
    schema: record.schema, id: record.id, origin: record.origin, owner: record.owner, walletAddress: record.walletAddress,
    vault: record.vault, terms: record.terms, rules: record.rules, baseline: record.baseline,
    disclosure: { ruleLines: record.disclosure?.ruleLines ?? null, text: record.disclosure?.text ?? null },
  };
  return createHash("sha256").update(canonical(bound)).digest("hex");
}

function normalizeInputRules(input, baselineOwner, exitAvailable) {
  if (!Array.isArray(input)) return { errors: ["rules must be a list"] };
  const errors = [], rules = [];
  input.forEach((r, i) => {
    if (!isObj(r)) { errors.push(`rule[${i}]: not an object`); return; }
    const extra = Object.keys(r).filter((k) => !INPUT_RULE_FIELDS.has(k));
    if (extra.length) {
      errors.push(`rule[${i}]: field(s) ${extra.join(", ")} cannot be sent` +
        (extra.includes("baselineOwner") ? " (the baselineOwner is recorded by the server from the signed report)" : "") +
        (extra.includes("id") ? " (rule ids are assigned by the server)" : ""));
      return;
    }
    // ⛔ Decision 2 (T): no rule may say exit while nothing can exit (EXIT_AVAILABLE, limits.mjs).
    if (r.onFinding === ON_FINDING.EXIT && exitAvailable !== true) {
      errors.push(`rule[${i}]: "${r.subject}" cannot exit yet — autonomous exit is not available until it ships (piece 5); choose pause`);
      return;
    }
    const rule = { id: `r${i + 1}`, kind: r.kind, subject: r.subject, onFinding: r.onFinding };
    if (r.limitBps !== undefined) rule.limitBps = r.limitBps;
    if (r.kind === "state" && r.subject === "owner-changed") {
      if (!isAddr(baselineOwner)) { errors.push(`rule[${i}]: the vault's owner could not be read when the mandate was made, so an owner-change rule has nothing to compare to`); return; }
      rule.baselineOwner = baselineOwner;
    }
    rules.push(rule);
  });
  if (errors.length) return { errors };
  const v = validateMandateRules(rules);
  return v.ok ? { rules } : { errors: v.errors };
}

/**
 * THE BODY'S TERMS AND RULES, checked once, for BOTH the builder and the preflight — one set of rules, not two.
 * `baselineOwner` is the owner the signed baseline recorded; the preflight passes a placeholder (see below).
 * @returns {{errors:string[], terms?:object, rules?:Array}}
 */
function termsAndRules({ terms, rules, baselineOwner, exitAvailable }) {
  const errors = [];
  const tv = validateMandateTerms(terms);
  if (!tv.ok) errors.push(...tv.errors);
  const n = normalizeInputRules(rules, baselineOwner, exitAvailable);
  if (n.errors) errors.push(...n.errors);
  return errors.length ? { errors } : { errors, terms: tv.terms, rules: n.rules };
}

/** Origin and owner, for the builder and the preflight alike. */
function originErrors({ owner, origin }) {
  const errors = [];
  if (!KNOWN_ORIGIN.has(origin)) errors.push(`origin ${JSON.stringify(origin)} is not one of ${[...KNOWN_ORIGIN].join(", ")}`);
  else if (origin === MANDATE_ORIGIN.OPERATOR && !isOperatorOwner(owner)) errors.push("origin operator requires an owner in OPERATOR_MANDATE_OWNERS");
  if (!isAddr(owner)) errors.push("no owner: a mandate is created only under a verified session");
  return errors;
}

/** The fields a create request may carry. The owner is the session and the origin is the path's; neither is sent. */
export const CREATE_INPUT_FIELDS = Object.freeze(["vault", "rules", "amountPerDepositUsdc", "maxTotalUsdc", "cadence"]);

// A well-formed address that is never anyone's owner: what an owner-changed rule is validated against BEFORE the
// baseline exists. It lives only inside preflightMandateInput and is never returned or stored.
const PREFLIGHT_OWNER_PLACEHOLDER = "0x" + "0".repeat(39) + "1";

/**
 * ═══ THE PREFLIGHT (2026-09-27): every check on a create BODY that does not need the baseline, run BEFORE it ═══
 * The baseline read SIGNS a DD report. Until this existed, a body creation refuses (an exit rule, bad terms) cost
 * that signature first — on the operator path and on piece 6's future user endpoint alike. So the create core and
 * the operator handler run this first, and nothing is read until it passes.
 * ⭐ It shares the builder's code (termsAndRules, originErrors, the field list): the builder is still the authority
 * and re-checks everything; test:mandaterecord proves the two agree on a corpus of bodies.
 * ⚠️ One check CANNOT move: an owner-changed rule on a vault whose owner the baseline could not read. Only the signed
 * read knows, so that refusal still comes after it.
 * @param {{owner:string, origin?:string, input:object, exitAvailable?:boolean}} a  `exitAvailable`: test seam only.
 * @returns {{ok:true} | {ok:false, errors:string[]}}  — never a record, never rules.
 */
export function preflightMandateInput({ owner, origin = MANDATE_ORIGIN.USER, input, exitAvailable = EXIT_AVAILABLE } = {}) {
  if (!isObj(input)) return { ok: false, errors: ["the request body must be an object"] };
  const errors = [];
  const extra = Object.keys(input).filter((k) => !CREATE_INPUT_FIELDS.includes(k));
  if (extra.length) errors.push(`field(s) ${extra.join(", ")} cannot be sent: the owner is the signed-in session, and the origin is set by the server`);
  errors.push(...originErrors({ owner, origin }));
  const tr = termsAndRules({
    terms: { amountPerDepositUsdc: input.amountPerDepositUsdc, maxTotalUsdc: input.maxTotalUsdc, cadence: input.cadence },
    rules: input.rules, baselineOwner: PREFLIGHT_OWNER_PLACEHOLDER, exitAvailable,
  });
  errors.push(...tr.errors);
  return errors.length ? { ok: false, errors } : { ok: true };
}

function checkBaseline(b) {
  if (!isObj(b)) return ["no baseline was read for this vault"];
  if (b.ok !== true) return [`the baseline could not be read: ${b.why ?? "unspecified"}`];
  const e = [];
  if (b.reportSigned !== true) e.push("the baseline must come from a signed DD report");
  if (b.signerVerified !== true) e.push("the baseline report's signer was not verified");
  if (!Number.isInteger(b.reportBlock)) e.push("the baseline names no report block");
  if (b.maxFeeBps !== null && b.maxFeeBps !== undefined && !Number.isInteger(b.maxFeeBps)) e.push("the baseline fee cap is not an integer");
  // ⭐ The vault disclosure the user acknowledged. The deposit sends THIS token, never one minted from the
  // day's inspection (that would be the mandate acknowledging its own disclosure).
  if (!isAckToken(b.vaultAckToken)) e.push("the baseline carries no vault disclosure token for the user to acknowledge");
  return e;
}

/**
 * @param {{owner, walletAddress, vault:{key,address,chainId,label}, terms:object, rules:Array, baseline:object, now:number, id:string}} a
 *   `owner` is the SESSION address; `terms` + `rules` are the client's; `baseline` comes from the transport.
 *   `exitAvailable` defaults to EXIT_AVAILABLE. ⛔ Only the test suites pass it (a source guard in
 *   test:mandatedeposit refuses any other caller): it exists so piece 5's record shapes stay testable.
 *   `origin` defaults to "user". ⛔ Only the operator path passes "operator" (source guard, test:mandaterecord).
 */
export function buildMandateRecord({ owner, walletAddress, vault, terms, rules, baseline, now, id, exitAvailable = EXIT_AVAILABLE, origin = MANDATE_ORIGIN.USER } = {}) {
  const errors = [...originErrors({ owner, origin })];
  if (!isAddr(walletAddress)) errors.push("no agent wallet address");
  if (!isObj(vault) || typeof vault.key !== "string" || !isAddr(vault.address) || !Number.isInteger(vault.chainId)) errors.push("no allowlisted vault");
  if (typeof id !== "string" || !id) errors.push("no mandate id");
  if (!Number.isFinite(now)) errors.push("no creation time");
  errors.push(...checkBaseline(baseline));
  // The SAME terms-and-rules check the preflight runs, now against the owner the signed baseline recorded.
  const tr = termsAndRules({ terms, rules, baselineOwner: baseline?.owner?.address, exitAvailable });
  errors.push(...tr.errors);
  if (errors.length) return { ok: false, errors };

  const record = {
    schema: MANDATE_SCHEMA, id, origin,
    owner: owner.toLowerCase(), walletAddress: walletAddress.toLowerCase(),
    vault: { key: vault.key, address: vault.address, chainId: vault.chainId, label: vault.label ?? vault.key },
    terms: tr.terms,
    rules: tr.rules,
    baseline: {
      owner: isAddr(baseline.owner?.address) ? baseline.owner.address : null,
      ownerKind: baseline.owner?.kind ?? null,
      reportBlock: baseline.reportBlock,
      maxFeeBps: Number.isInteger(baseline.maxFeeBps) ? baseline.maxFeeBps : null,
      vaultAckToken: baseline.vaultAckToken,
    },
    status: MANDATE_STATUS.AWAITING_ACK, ack: null,
    deposits: freshDeposits(), monitoring: freshMonitoring(),
    progress: freshProgress(),
    createdAt: new Date(now).toISOString(),
  };
  record.disclosure = renderDisclosure(record);
  record.fingerprint = mandateFingerprint(record);
  return { ok: true, record };
}

const isIso = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const isText = (v) => typeof v === "string" && v.length > 0;

/** The operational halves' shapes. Each problem is named; a half that is not one of its states is inconsistent. */
function operationalErrors(record) {
  const e = [];
  const d = record.deposits;
  if (!isObj(d)) e.push("no deposits state");
  else if (d.state === DEPOSITS_STATE.RUNNING) { /* nothing more */ }
  else if (d.state === DEPOSITS_STATE.PAUSED) {
    if (!Array.isArray(d.flags) || d.flags.length === 0 || !d.flags.every(isText)) e.push("deposits are paused with no flags saying why");
    if (!isText(d.reason)) e.push("deposits are paused with no reason");
    if (!isIso(d.at)) e.push("deposits are paused with no time");
  } else e.push(`unknown deposits state ${JSON.stringify(d.state)}`);
  const m = record.monitoring;
  if (!isObj(m)) e.push("no monitoring state");
  else if (m.state === MONITORING_STATE.WATCHING) { /* nothing more */ }
  else if (m.state === MONITORING_STATE.DEGRADED) {
    if (!isIso(m.since)) e.push("monitoring is degraded with no start time");
    if (!(Number.isInteger(m.consecutiveFailures) && m.consecutiveFailures >= 1)) e.push("monitoring is degraded with no failure count");
  } else if (m.state === MONITORING_STATE.STOPPED) {
    if (!isText(m.why)) e.push("monitoring is stopped with no reason");
  } else e.push(`unknown monitoring state ${JSON.stringify(m.state)}`);
  const p = record.progress;
  // ⭐ A decimal STRING: shares are 18-decimal on some vaults, so a JS number would silently lose precision.
  if (!isObj(p) || typeof p.sharesTrackedRaw !== "string" || !/^\d+$/.test(p.sharesTrackedRaw)) e.push("the tracked shares are not a non-negative decimal string");
  if (!isObj(p) || !(Number.isInteger(p.sharesTrackedGaps) && p.sharesTrackedGaps >= 0)) e.push("the tracked-share gap count is not a non-negative integer");
  return e;
}

/**
 * Re-derive everything. `ok` = the record is internally consistent (valid rules, disclosure matches,
 * fingerprint matches, the operational halves well-formed).
 *   `mayDeposit` = ok AND active AND acknowledged against the fingerprint of NOW AND deposits running.
 *   `mayMonitor` = ok AND not closed or cancelled. (A stale acknowledgement or a deposits pause keeps it true:
 *                  watching the position is never switched off by a pause — Finding A.)
 * ⛔ There is no `mayAct`: a caller must say which authority it needs.
 * @returns {{ok:boolean, mayDeposit:boolean, mayMonitor:boolean, fingerprint:string|null, errors:string[]}}
 */
export function verifyMandateRecord(record) {
  if (!isObj(record)) return { ok: false, mayDeposit: false, mayMonitor: false, fingerprint: null, errors: ["no record"] };
  const errors = [];
  if (record.schema !== MANDATE_SCHEMA) errors.push(`unknown schema ${JSON.stringify(record.schema)}`);
  if (!KNOWN_ORIGIN.has(record.origin)) errors.push(`unknown origin ${JSON.stringify(record.origin)}`);
  // ⭐ Re-checked on EVERY read: a record relabelled "operator" in the store for anyone else is inconsistent, even
  // re-fingerprinted and re-acknowledged; and removing an address from the list stops that operator's mandates.
  else if (record.origin === MANDATE_ORIGIN.OPERATOR && !isOperatorOwner(record.owner)) errors.push("an operator-origin record whose owner is not in OPERATOR_MANDATE_OWNERS");
  if (!isAddr(record.owner) || !isAddr(record.walletAddress)) errors.push("owner or wallet address missing");
  if (!isObj(record.vault) || !isAddr(record.vault.address)) errors.push("vault missing");
  const v = validateMandateRules(record.rules);
  if (!v.ok) errors.push(...v.errors);
  const tv = validateMandateTerms(record.terms);
  if (!tv.ok) errors.push(...tv.errors);
  else if (tv.terms.cadence !== record.terms.cadence) errors.push("the stored terms name no cadence");
  if (!isAckToken(record.baseline?.vaultAckToken)) errors.push("the record carries no acknowledged vault disclosure token");
  if (!KNOWN_STATUS.has(record.status)) errors.push(`unknown status ${JSON.stringify(record.status)}`);
  errors.push(...operationalErrors(record));
  for (const r of Array.isArray(record.rules) ? record.rules : []) {
    if (r?.subject === "owner-changed" && (!isAddr(record.baseline?.owner) || String(r.baselineOwner).toLowerCase() !== record.baseline.owner.toLowerCase())) {
      errors.push("the owner-change rule does not compare to the owner recorded at creation");
    }
  }
  let fingerprint = null;
  if (!errors.length) {
    const rendered = renderDisclosure(record);
    if (rendered.text !== record.disclosure?.text || JSON.stringify(rendered.ruleLines) !== JSON.stringify(record.disclosure?.ruleLines)) {
      errors.push("the disclosure does not match its rules");
    }
    fingerprint = mandateFingerprint(record);
    if (fingerprint !== record.fingerprint) errors.push("the stored fingerprint does not match the rules and disclosure");
  }
  const ok = errors.length === 0;

  const depositErrors = [];
  if (ok) {
    if (record.status === MANDATE_STATUS.AWAITING_ACK) depositErrors.push("awaiting the user's acknowledgement");
    else if (record.status !== MANDATE_STATUS.ACTIVE) depositErrors.push(`status ${JSON.stringify(record.status)} may not deposit`);
    else if (!isObj(record.ack) || record.ack.fingerprint !== fingerprint) {
      depositErrors.push("stale acknowledgement: the user acknowledged a different set of rules and disclosure");
    }
    if (record.deposits.state === DEPOSITS_STATE.PAUSED) {
      depositErrors.push(`deposits paused (${record.deposits.flags.join(", ")}): ${record.deposits.reason}`);
    }
  }
  const mayMonitor = ok && !TERMINAL_STATUS.has(record.status);
  return { ok, mayDeposit: ok && depositErrors.length === 0, mayMonitor, fingerprint, errors: [...errors, ...depositErrors] };
}

/** The user acknowledges the fingerprint they were shown. Anything else refuses. */
export function acknowledgeMandate(record, fingerprint, now) {
  const v = verifyMandateRecord(record);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (record.status !== MANDATE_STATUS.AWAITING_ACK) return { ok: false, errors: [`a mandate that is ${record.status} is not awaiting acknowledgement`] };
  if (!isFp(fingerprint) || fingerprint !== v.fingerprint) {
    return { ok: false, errors: ["the acknowledgement is for a different set of rules and disclosure; review the mandate again"] };
  }
  return { ok: true, record: { ...record, status: MANDATE_STATUS.ACTIVE, ack: { fingerprint, at: new Date(now).toISOString() } } };
}

/**
 * Cancel: terminal, kept (never deleted — the record and its receipts are the audit trail). Refused when already
 * closed or cancelled, and while an exit is IN FLIGHT (`exiting`: a submitted redeem must resolve first). Monitoring
 * stops with it. `now` from the caller; `cancelledAt` is outside the fingerprint.
 */
export function cancelMandate(record, now) {
  const v = verifyMandateRecord(record);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (TERMINAL_STATUS.has(record.status)) return { ok: false, errors: [`the mandate is already ${record.status}`] };
  if (record.status === MANDATE_STATUS.EXITING) return { ok: false, errors: ["an exit is in flight; it must resolve before the mandate can be cancelled"] };
  if (!Number.isFinite(now)) return { ok: false, errors: ["no cancellation time"] };
  return { ok: true, record: { ...record, status: MANDATE_STATUS.CANCELLED, cancelledAt: new Date(now).toISOString(),
    monitoring: { state: MONITORING_STATE.STOPPED, why: "the mandate was cancelled" } } };
}

/**
 * New rules → a new version AWAITING a fresh acknowledgement. The baseline (and its vault ack token) and
 * the terms are carried over, never re-read from input. `exitAvailable`: see buildMandateRecord.
 */
export function amendMandateRules(record, rules, now, { exitAvailable = EXIT_AVAILABLE } = {}) {
  const v = verifyMandateRecord(record);
  if (!v.ok) return { ok: false, errors: v.errors };
  // ⭐ An amendment returns the record to awaiting-ack, and an ack makes it active: a closed or cancelled mandate
  // must not be re-opened that way, and one mid-exit must not be re-authorised by a rule change.
  if (NOT_AMENDABLE.has(record.status)) return { ok: false, errors: [`a mandate that is ${record.status} cannot be amended`] };
  const b = record.baseline;
  const built = buildMandateRecord({
    // ⭐ origin is CARRIED: an amendment cannot relabel who made the mandate.
    origin: record.origin,
    owner: record.owner, walletAddress: record.walletAddress, vault: record.vault, terms: record.terms, rules, id: record.id, now, exitAvailable,
    baseline: { ok: true, reportSigned: true, signerVerified: true, owner: { address: b.owner, kind: b.ownerKind }, reportBlock: b.reportBlock, maxFeeBps: b.maxFeeBps, vaultAckToken: b.vaultAckToken },
  });
  if (!built.ok) return built;
  // Recomputed with createdAt kept and amendedAt added; neither is in the fingerprint.
  // ⭐ PROGRESS IS CARRIED: a fresh one would re-open the budget already deposited and reuse intent seqs.
  // ⭐ MONITORING IS CARRIED too: a rule change says nothing new about the position. Deposits restart as running
  // (the fresh acknowledgement is the user's own act of resuming), exactly as the /2 amendment cleared its pause.
  return { ok: true, record: { ...built.record, progress: record.progress ?? freshProgress(), monitoring: record.monitoring,
    createdAt: record.createdAt, amendedAt: new Date(now).toISOString() } };
}
