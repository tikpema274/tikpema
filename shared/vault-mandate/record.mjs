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
import {
  EXIT_NOT_GUARANTEED, EXIT_FEE_RISE, VERIFIED_PARAGRAPH, MONITORED_PARAGRAPH, CHECKED_AFTER_PARAGRAPH,
  PAYOUT_NOT_GUARANTEED,
} from "./copy.mjs";

// vault-mandate/2 (piece 4): + the deposit TERMS, the vault disclosure token the user acknowledged
// (baseline.vaultAckToken), a `paused` status with its flags, and `progress`. No /1 record was ever
// stored (there is no create endpoint), so there is nothing to migrate.
export const MANDATE_SCHEMA = "vault-mandate/2";
/** Anything not listed may not act. `paused` is consistent but may not act until the user acts. */
export const MANDATE_STATUS = Object.freeze({ AWAITING_ACK: "awaiting-ack", ACTIVE: "active", PAUSED: "paused" });
const KNOWN_STATUS = new Set(Object.values(MANDATE_STATUS));
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
export const freshProgress = () => ({ depositedUsdc: 0, depositCount: 0, nextSeq: 1, nextDueAt: null, lastDepositAt: null });

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
    schema: record.schema, id: record.id, owner: record.owner, walletAddress: record.walletAddress,
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
 */
export function buildMandateRecord({ owner, walletAddress, vault, terms, rules, baseline, now, id, exitAvailable = EXIT_AVAILABLE } = {}) {
  const errors = [];
  if (!isAddr(owner)) errors.push("no owner: a mandate is created only under a verified session");
  if (!isAddr(walletAddress)) errors.push("no agent wallet address");
  if (!isObj(vault) || typeof vault.key !== "string" || !isAddr(vault.address) || !Number.isInteger(vault.chainId)) errors.push("no allowlisted vault");
  if (typeof id !== "string" || !id) errors.push("no mandate id");
  if (!Number.isFinite(now)) errors.push("no creation time");
  errors.push(...checkBaseline(baseline));
  const tv = validateMandateTerms(terms);
  if (!tv.ok) errors.push(...tv.errors);
  if (errors.length) return { ok: false, errors };

  const n = normalizeInputRules(rules, baseline.owner?.address, exitAvailable);
  if (n.errors) return { ok: false, errors: n.errors };

  const record = {
    schema: MANDATE_SCHEMA, id,
    owner: owner.toLowerCase(), walletAddress: walletAddress.toLowerCase(),
    vault: { key: vault.key, address: vault.address, chainId: vault.chainId, label: vault.label ?? vault.key },
    terms: tv.terms,
    rules: n.rules,
    baseline: {
      owner: isAddr(baseline.owner?.address) ? baseline.owner.address : null,
      ownerKind: baseline.owner?.kind ?? null,
      reportBlock: baseline.reportBlock,
      maxFeeBps: Number.isInteger(baseline.maxFeeBps) ? baseline.maxFeeBps : null,
      vaultAckToken: baseline.vaultAckToken,
    },
    status: MANDATE_STATUS.AWAITING_ACK, ack: null, pause: null,
    progress: freshProgress(),
    createdAt: new Date(now).toISOString(),
  };
  record.disclosure = renderDisclosure(record);
  record.fingerprint = mandateFingerprint(record);
  return { ok: true, record };
}

/**
 * Re-derive everything. `ok` = the record is internally consistent (valid rules, disclosure matches,
 * fingerprint matches). `mayAct` = ok AND active AND acknowledged against the fingerprint of NOW.
 * @returns {{ok:boolean, mayAct:boolean, fingerprint:string|null, errors:string[]}}
 */
export function verifyMandateRecord(record) {
  if (!isObj(record)) return { ok: false, mayAct: false, fingerprint: null, errors: ["no record"] };
  const errors = [];
  if (record.schema !== MANDATE_SCHEMA) errors.push(`unknown schema ${JSON.stringify(record.schema)}`);
  if (!isAddr(record.owner) || !isAddr(record.walletAddress)) errors.push("owner or wallet address missing");
  if (!isObj(record.vault) || !isAddr(record.vault.address)) errors.push("vault missing");
  const v = validateMandateRules(record.rules);
  if (!v.ok) errors.push(...v.errors);
  const tv = validateMandateTerms(record.terms);
  if (!tv.ok) errors.push(...tv.errors);
  else if (tv.terms.cadence !== record.terms.cadence) errors.push("the stored terms name no cadence");
  if (!isAckToken(record.baseline?.vaultAckToken)) errors.push("the record carries no acknowledged vault disclosure token");
  if (!KNOWN_STATUS.has(record.status)) errors.push(`unknown status ${JSON.stringify(record.status)}`);
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

  const actErrors = [];
  if (ok) {
    if (record.status === MANDATE_STATUS.AWAITING_ACK) actErrors.push("awaiting the user's acknowledgement");
    else if (record.status === MANDATE_STATUS.PAUSED) actErrors.push(`paused (${(record.pause?.flags ?? []).join(", ") || "no flags"}): ${record.pause?.reason ?? "no reason recorded"}`);
    else if (record.status !== MANDATE_STATUS.ACTIVE) actErrors.push(`status ${JSON.stringify(record.status)} may not act`);
    else if (!isObj(record.ack) || record.ack.fingerprint !== fingerprint) {
      actErrors.push("stale acknowledgement: the user acknowledged a different set of rules and disclosure");
    }
  }
  return { ok, mayAct: ok && actErrors.length === 0, fingerprint, errors: [...errors, ...actErrors] };
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
 * New rules → a new version AWAITING a fresh acknowledgement. The baseline (and its vault ack token) and
 * the terms are carried over, never re-read from input. `exitAvailable`: see buildMandateRecord.
 */
export function amendMandateRules(record, rules, now, { exitAvailable = EXIT_AVAILABLE } = {}) {
  const v = verifyMandateRecord(record);
  if (!v.ok) return { ok: false, errors: v.errors };
  const b = record.baseline;
  const built = buildMandateRecord({
    owner: record.owner, walletAddress: record.walletAddress, vault: record.vault, terms: record.terms, rules, id: record.id, now, exitAvailable,
    baseline: { ok: true, reportSigned: true, signerVerified: true, owner: { address: b.owner, kind: b.ownerKind }, reportBlock: b.reportBlock, maxFeeBps: b.maxFeeBps, vaultAckToken: b.vaultAckToken },
  });
  if (!built.ok) return built;
  // Recomputed with createdAt kept and amendedAt added; neither is in the fingerprint.
  // ⭐ PROGRESS IS CARRIED: a fresh one would re-open the budget already deposited and reuse intent seqs.
  return { ok: true, record: { ...built.record, progress: record.progress ?? freshProgress(), createdAt: record.createdAt, amendedAt: new Date(now).toISOString() } };
}
