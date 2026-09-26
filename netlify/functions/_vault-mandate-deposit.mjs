// _vault-mandate-deposit.mjs — piece 4: the vault mandate's PRE-DEPOSIT path. The first mandate piece that
// MOVES MONEY, and it ships DISARMED. Design: PROGRESS.md "VAULT MANDATE — PIECE 4" (2026-09-26).
//
// ═══ R2 (T): OFF BY A CODE CONSTANT, CHECKED AT THE WRITE ═══════════════════════════════════════
// A scheduled tick that deposits on its first run after deploy is a fund-moving run nobody approved. So
// (the RECLAIM_ARMED + ARMED_FROM_SEC precedent, escrow-reclaim-sweep.mjs):
//   · MANDATE_DEPOSIT_ARMED = false and MANDATE_ARMED_FROM = null, flipped TOGETHER in their own commit.
//   · Checked inside depositForMandate, just before the intent — NOT at the tick. Any caller hits it.
//   · ⭐ Decision 3 (T): the DISARMED tick still SIGNS its check. It runs anchor → signed report → verify →
//     readings → decide, records "WOULD DEPOSIT X", writes no intent and never reaches the executor. That
//     proves the whole path, signing leg included, at ~0 USDC.
//   · ⭐ Decision 4 (T): MANDATE_CHECK_FRESHNESS_MS is UNSET. It is set from the measured anchor → signed +
//     verified latency the disarmed tick records (receipt.timing.signingLatencyMs). Until then an ARMED run
//     REFUSES: arming requires the measurement first.
//   · No catch-up: next due = max(due, MANDATE_ARMED_FROM); one deposit per window, never a backlog.
//
// ═══ WHERE THE CHECK CANNOT BE SKIPPED ═══════════════════════════════════════════════════════════
// depositForMandate is the ONE place a mandate deposit is issued (test:mandatedeposit's source guard). It
// never trusts a passed decision: it re-runs decideMandateAction on the check it is given, and refuses
// unless that check carries a report whose verification is `valid === true`, for this vault, at the anchor,
// with the anchor inside the freshness window.
//
// ═══ ORDER OF OPERATIONS (per mandate, per due window) ════════════════════════════════════════════
//   0 RECOVER FIRST (armed only — a disarmed run never touches the intent store) · 1 free gates · 2 limit
//   preflight (reads; a miss SKIPS, no check, no signature) · 3 CHECK · 4 DECIDE (exit → pause until
//   piece 5) · 5 INTENT (create-only, before any signing) · 6 DEPOSIT with the STORED ack token · 7 the
//   post-deposit ASSERTION · 8 COMMIT.
// ⛔ The daily limit is the user's own budget, not a vault finding: it SKIPS, it never pauses.

import { createHash } from "node:crypto";
import { verifyMandateRecord, MANDATE_STATUS } from "../../shared/vault-mandate/record.mjs";
import { decideMandateAction, ACTION, FLAG } from "../../shared/vault-mandate/decide.mjs";
import { CADENCE_MS, MANDATE_DEPOSIT_MAX_USDC, mandateDayRoom, effectiveDepositUsdc } from "../../shared/vault-mandate/limits.mjs";
import { depositVerdict, DEPOSIT_VERDICT } from "../../shared/vault-mandate/assertion.mjs";
import { classifyIntent, RECOVERY_STATE, RECOVERY_MAX_TRIES } from "../../shared/vault-mandate/recovery.mjs";
import { vaultMandateIntentKey } from "./_vault-mandate-store.mjs";
import { amountFloorViolation } from "./_amount-floor.mjs";

// ═══ THE ARMING CONSTANTS — flipped only in their own reviewed commit ═════════════════════════════
export const MANDATE_DEPOSIT_ARMED = false;
/** Epoch ms of the arming moment, set in the SAME commit that flips MANDATE_DEPOSIT_ARMED. */
export const MANDATE_ARMED_FROM = null;
/** Max age (ms) of a check's anchor at the write. null until measured on the disarmed tick (decision 4). */
export const MANDATE_CHECK_FRESHNESS_MS = null;

const SHIPPED = Object.freeze({ armed: MANDATE_DEPOSIT_ARMED, armedFrom: MANDATE_ARMED_FROM, freshnessMs: MANDATE_CHECK_FRESHNESS_MS });

export const REFUSED = Object.freeze({
  DISARMED: "disarmed", FRESHNESS_UNSET: "freshness-window-unset", ARMED_FROM_UNSET: "armed-from-unset",
  NOT_YET_ARMED: "before-armed-from", RECORD: "record-may-not-act", NO_CHECK: "no-check",
  UNSIGNED: "report-not-verified", STALE_CHECK: "stale-check", DECISION: "decision-not-deposit", AMOUNT: "amount",
  READINGS: "readings-unagreed", PREVIEW: "preview-unreadable", NO_ROOM: "no-room", INTENT_EXISTS: "intent-exists",
  INTENT_UNWRITABLE: "intent-unwritable", EXECUTOR: "executor-refused", OUTCOME_UNKNOWN: "outcome-unknown",
});
/** Pause flags this path adds to decide.mjs's FLAG set. */
export const PAUSE_FLAG = Object.freeze({
  DISCLOSURE_CHANGED: "DISCLOSURE_CHANGED", EXIT_UNAVAILABLE: "EXIT_UNAVAILABLE", DEPOSIT_MISMATCH: "DEPOSIT_MISMATCH",
  INCONCLUSIVE: FLAG.INCONCLUSIVE,
});

const micro = (usdc) => Math.round(Number(usdc) * 1e6);
const round6 = (usdc) => micro(usdc) / 1e6;
const iso = (ms) => new Date(ms).toISOString();
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const bigJson = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x));
const digest = (v) => createHash("sha256").update(bigJson(v ?? null)).digest("hex");

/** Both endpoints' readings, only where they agree: the check's deposit fee and our position. */
function agreedReading(readings) {
  const ok = Array.isArray(readings) ? readings.filter((r) => r?.ok === true) : [];
  if (ok.length < 2 || ok.length !== readings.length) return null;
  const fees = new Set(ok.map((r) => r.depositFeeBps)), pos = new Set(ok.map((r) => r.redemption?.positionShares));
  if (fees.size !== 1 || pos.size !== 1) return null;
  const depositFeeBps = ok[0].depositFeeBps, positionShares = ok[0].redemption?.positionShares;
  if (!Number.isInteger(depositFeeBps) || typeof positionShares !== "string" || !/^\d+$/.test(positionShares)) return null;
  return { depositFeeBps, positionShares };
}

/**
 * Is there room for this deposit right now? Reads only. The vault cap, the daily ceiling (canSpendDay),
 * the mandate's day share and mandate + DCA together, and the SCA's USDC. Any unreadable input → no room.
 */
async function depositRoom({ record, amountUsdc, deps }) {
  const L = deps.limits, wallet = record.walletAddress;
  try {
    // The shared floor (the refusal-quantity census): below one USDC atomic unit is nothing to deposit.
    const floor = amountFloorViolation(amountUsdc, { field: "amountUsdc" });
    if (floor) return { ok: false, reason: floor };
    const cap = Number(L.vaultCapUsdc());
    if (!Number.isFinite(cap) || micro(amountUsdc) > micro(cap)) return { ok: false, reason: `above the per-vault-deposit limit of ${cap} USDC` };
    const day = await L.canSpendDay({ amountUsdc, owner: wallet });
    if (day?.allowed !== true) return { ok: false, reason: day?.reason ?? "the daily ceiling could not be read" };
    const [mine, dca] = await Promise.all([L.mandateDaySpend(wallet), L.dcaDaySpend(wallet)]);
    const room = mandateDayRoom({ ceilingUsdc: L.ceilingUsdc(), userReserveFraction: L.userReserveFraction(),
      mandateTodayUsdc: mine, dcaTodayUsdc: dca, amountUsdc });
    if (!room.ok) return { ok: false, reason: room.reason };
    const bal = await L.scaUsdcBalanceMinor(wallet);
    if (typeof bal !== "bigint") return { ok: false, reason: "the agent wallet's USDC balance could not be read" };
    if (bal < BigInt(micro(amountUsdc))) return { ok: false, reason: `the agent wallet holds ${Number(bal) / 1e6} USDC, less than the ${amountUsdc} USDC deposit` };
    return { ok: true, usdcBeforeMinor: bal };
  } catch (e) {
    return { ok: false, reason: `a limit could not be read: ${String(e?.message ?? e)}` };
  }
}

/** CAS-update a stored mandate: re-read, apply, write on the etag just read; retry a conflict. */
async function mutateMandate({ deps, owner, id, mutate }) {
  for (let i = 0; i < 3; i++) {
    const r = await deps.mandates.read({ owner, id });
    if (!r?.readable || !r.record) return { ok: false, why: r?.errors?.join("; ") || "the mandate could not be read" };
    const next = mutate(structuredClone(r.record));
    if (next === null) return { ok: true, unchanged: true };
    const w = await deps.mandates.update({ owner, id, record: next, etag: r.etag });
    if (w?.ok) return { ok: true, record: next };
    if (!w?.conflict) return { ok: false, why: (w?.errors ?? []).join("; ") || "the mandate could not be written" };
  }
  return { ok: false, why: "the mandate kept changing while it was being updated" };
}

function pauseMandate({ deps, owner, id, flags, reason, now }) {
  return mutateMandate({ deps, owner, id, mutate: (rec) => {
    const prev = rec.status === MANDATE_STATUS.PAUSED ? rec.pause?.flags ?? [] : [];
    rec.status = MANDATE_STATUS.PAUSED;
    rec.pause = { flags: [...new Set([...prev, ...flags])], reason, at: iso(now) };
    return rec;
  } });
}

/**
 * COMMIT (step 8), idempotent on the seq: a record whose nextSeq has already moved past this intent is left
 * alone. `deposited` false = the seq is consumed without a deposit (recovery found it not deposited).
 */
function commitSeq({ deps, owner, id, seq, amountUsdc, deposited, verdict, now }) {
  return mutateMandate({ deps, owner, id, mutate: (rec) => {
    const p = rec.progress ?? {};
    if (!Number.isInteger(p.nextSeq) || p.nextSeq > seq) return null;
    rec.progress = { ...p, nextSeq: seq + 1 };
    if (deposited) {
      rec.progress.depositedUsdc = round6((p.depositedUsdc ?? 0) + amountUsdc);
      rec.progress.depositCount = (p.depositCount ?? 0) + 1;
      // ⭐ No backlog: the next window starts from NOW, not from the missed due time.
      rec.progress.nextDueAt = now + CADENCE_MS[rec.terms.cadence];
      rec.progress.lastDepositAt = now;
      if (verdict && verdict.verdict !== DEPOSIT_VERDICT.MATCHED) {
        const flag = verdict.verdict === DEPOSIT_VERDICT.MISMATCHED ? PAUSE_FLAG.DEPOSIT_MISMATCH : PAUSE_FLAG.INCONCLUSIVE;
        rec.status = MANDATE_STATUS.PAUSED;
        rec.pause = { flags: [flag], reason: `post-deposit assertion ${verdict.verdict}: ${verdict.detail}`, at: iso(now) };
      }
    }
    return rec;
  } });
}

/**
 * THE ONE FUNCTION THAT ISSUES A MANDATE DEPOSIT.
 * @param {{record, etag, checked, amountUsdc, deps, now:number, config?}} a
 *   `checked` = runMandateCheck's result (+ timing). A `decision` passed alongside is IGNORED: it re-decides.
 *   `config` defaults to the shipped constants. ⛔ Only the test suite passes it (source-guarded).
 */
export async function depositForMandate({ record, etag, checked, amountUsdc, deps, now, config = SHIPPED }) {
  const t = Number.isFinite(now) ? now : Date.now();
  const refuse = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });
  const amount = Number(amountUsdc);

  // ═══ R2 — THE WRITE GATE. Nothing below runs, reads or writes while disarmed. ═══
  if (config?.armed !== true) {
    return refuse(REFUSED.DISARMED, "the vault mandate deposit path is disarmed (MANDATE_DEPOSIT_ARMED = false): nothing was written, nothing executed",
      { wouldDeposit: { amountUsdc: amount, vault: record?.vault?.key ?? null } });
  }
  /* ⟦rule:freshness-unset⟧ */
  if (!(typeof config.freshnessMs === "number" && Number.isFinite(config.freshnessMs) && config.freshnessMs > 0)) {
    return refuse(REFUSED.FRESHNESS_UNSET, "the check freshness window is unset: arming requires the measured signing latency first (decision 4)");
  }
  /* ⟦/rule:freshness-unset⟧ */
  if (!Number.isFinite(config.armedFrom)) return refuse(REFUSED.ARMED_FROM_UNSET, "armed with no MANDATE_ARMED_FROM: the two are set together");
  if (t < config.armedFrom) return refuse(REFUSED.NOT_YET_ARMED, "this moment is before the arming moment");

  // ── the record: consistent, active, acknowledged against the fingerprint of NOW ──
  const v = verifyMandateRecord(record);
  if (!v.mayAct) return refuse(REFUSED.RECORD, `the mandate may not act: ${v.errors.join("; ")}`);

  // ── the check: present, signed + verified, for THIS vault, AT the anchor, fresh ──
  if (!checked || typeof checked !== "object") return refuse(REFUSED.NO_CHECK, "no check was given; a deposit never goes ahead without one");
  const rep = checked.report, anchor = checked.anchor;
  if (!rep || checked.verification?.valid !== true || !same(rep.subject?.address, record.vault.address) ||
      !Number.isInteger(anchor?.blockNumber) || rep.subject?.blockNumber !== anchor.blockNumber ||
      !same(checked.check?.anchor?.blockHash, anchor.blockHash)) {
    return refuse(REFUSED.UNSIGNED, `the check carries no signed, verified report for this vault at its anchor (${checked.reportFailure ?? checked.verification?.reason ?? "missing"})`);
  }
  const anchoredAt = checked.timing?.anchoredAt, age = t - anchoredAt;
  // Written as !(age <= window) so a missing window or time can only refuse.
  if (!Number.isFinite(anchoredAt) || age < 0 || !(age <= config.freshnessMs)) {
    return refuse(REFUSED.STALE_CHECK, `the check's anchor is ${Number.isFinite(age) ? `${age} ms` : "of unknown age"} old; the window is ${config.freshnessMs} ms`);
  }
  // ⭐ RE-DECIDED HERE, from the record's rules and the check. Nothing passed in can say "deposit".
  const decision = decideMandateAction({ rules: record.rules, check: checked.check });
  if (decision.action !== ACTION.DEPOSIT) return refuse(REFUSED.DECISION, `the check decides ${decision.action}, not deposit (${decision.flags.join(", ")})`, { decision });

  // ── the amount: never above the record's, the mandate cap, or the budget left ──
  const remaining = record.terms.maxTotalUsdc - (record.progress?.depositedUsdc ?? 0);
  const limit = Math.min(micro(record.terms.amountPerDepositUsdc), micro(MANDATE_DEPOSIT_MAX_USDC), micro(remaining));
  if (!(Number.isFinite(amount) && micro(amount) > 0 && micro(amount) <= limit)) {
    return refuse(REFUSED.AMOUNT, `${amountUsdc} USDC is not a deposit this mandate allows (at most ${Math.max(0, limit) / 1e6} now)`);
  }
  const amountMinor = BigInt(micro(amount));

  // ── what the assertion will need, established BEFORE the intent (so it can never be missing after) ──
  const agreed = agreedReading(checked.readings);
  if (!agreed) return refuse(REFUSED.READINGS, "the two endpoints' readings do not agree on the deposit fee and position; the assertion would have nothing to compare to");
  let sharesPredicted = null;
  try { sharesPredicted = await deps.previewAtAnchor({ vault: record.vault, amountMinor, anchor }); } catch { sharesPredicted = null; }
  if (typeof sharesPredicted !== "bigint") return refuse(REFUSED.PREVIEW, "previewDeposit at the anchor could not be read on both endpoints");

  const room = await depositRoom({ record, amountUsdc: amount, deps });
  if (!room.ok) return refuse(REFUSED.NO_ROOM, room.reason);

  // ═══ 5. THE INTENT — create-only on the seq, BEFORE any signing ═══
  const seq = record.progress.nextSeq;
  const key = vaultMandateIntentKey(record.owner, record.id, seq);
  const receiptBase = { mandate: { owner: record.owner, id: record.id }, seq, intentKey: key, amountUsdc: amount,
    report: rep, verification: checked.verification, anchor, readings: checked.readings, decision, timing: checked.timing };
  let cur = {
    schema: "vault-mandate-intent/1", owner: record.owner, id: record.id, seq, status: "submitting", createdAt: iso(t),
    walletAddress: record.walletAddress, vault: record.vault.key,
    anchor: { blockNumber: anchor.blockNumber, blockHash: anchor.blockHash }, reportDigest: digest(rep),
    amountUsdc: amount, amountMinor: amountMinor.toString(), sharesPredicted: sharesPredicted.toString(),
    sharesBefore: agreed.positionShares, usdcBeforeMinor: room.usdcBeforeMinor.toString(), depositFeeBpsAtCheck: agreed.depositFeeBps,
    circleIds: {},
  };
  let curEtag;
  try {
    const c = await deps.intents.create(key, cur);
    if (c?.exists) return refuse(REFUSED.INTENT_EXISTS, `an intent already exists for deposit #${seq}; a seq is deposited at most once`);
    if (!c?.ok) return refuse(REFUSED.INTENT_UNWRITABLE, "the intent could not be written; nothing was signed");
    curEtag = c.etag;
  } catch (e) { return refuse(REFUSED.INTENT_UNWRITABLE, `the intent could not be written (${String(e?.message ?? e)}); nothing was signed`); }
  const warnings = [];
  const writeIntent = async (patch) => {
    const next = { ...cur, ...patch };
    try {
      const u = await deps.intents.update(key, next, curEtag);
      if (u?.ok) { cur = next; curEtag = u.etag; return; }
      warnings.push(`intent update to ${patch.status ?? "?"} lost a CAS race`);
    } catch (e) { warnings.push(`intent update to ${patch.status ?? "?"} failed: ${String(e?.message ?? e)}`); }
    cur = next;
  };

  // ═══ 6. THE DEPOSIT, with the STORED ack token ═══
  let res;
  try {
    res = await deps.executeAction(
      { type: "vault_deposit", vault: record.vault.key, amountUsdc: amount, ackToken: record.baseline.vaultAckToken,
        reasoning: `vault mandate ${record.id}: deposit #${seq}` },
      { walletAddress: record.walletAddress, chargeId: key,
        onVaultSubmitted: ({ stage, circleId }) => writeIntent({ status: "submitted", circleIds: { ...cur.circleIds, [stage]: circleId } }) },
    );
  } catch (e) {
    // ⛔ An exception is NOT a failed deposit: the tx may have landed. The intent stays open; the next tick's
    // recovery reads the chain.
    return refuse(REFUSED.OUTCOME_UNKNOWN, `the deposit's outcome is unknown (${String(e?.message ?? e)}); recovery will read the chain`,
      { intentKey: key, warnings, receipt: { ...receiptBase, outcome: "outcome-unknown" } });
  }
  if (!res?.ok) {
    await writeIntent({ status: "refused", refusal: res?.blocked ?? "refused" });
    // A disclosure refusal is a vault finding → pause. Anything else (the daily limit taken by another spend,
    // the kill switch, a cap) is not → skip: "checked, not deposited".
    if (res?.disclosure) {
      await pauseMandate({ deps, owner: record.owner, id: record.id, flags: [PAUSE_FLAG.DISCLOSURE_CHANGED], now: t,
        reason: `the vault's deposit disclosure no longer matches the one you acknowledged: ${res.blocked}` });
    }
    return refuse(REFUSED.EXECUTOR, `checked, not deposited: ${res?.blocked ?? "refused"}`,
      { intentKey: key, warnings, receipt: { ...receiptBase, outcome: "checked-not-deposited", refusal: res?.blocked ?? null } });
  }
  const txHash = res.depositHash ?? null;
  await writeIntent({ status: "deposited", txHash });

  // ═══ 7. THE ASSERTION ═══
  const verdict = await assertDeposit({ deps, record, txHash, amountMinor, feeAtCheckBps: agreed.depositFeeBps, sharesPredicted });
  await writeIntent({ status: "asserted", verdict });

  // ═══ 8. COMMIT ═══
  const commit = await commitSeq({ deps, owner: record.owner, id: record.id, seq, amountUsdc: amount, deposited: true, verdict, now: t });
  if (!commit.ok) warnings.push(`the record could not be committed: ${commit.why}`);
  try { await deps.recordMandateSpend({ owner: record.walletAddress, amountUsdc: amount, at: t, chargeId: key }); }
  catch (e) { warnings.push(`the mandate-day counter could not be charged: ${String(e?.message ?? e)}`); }
  return { ok: true, intentKey: key, txHash, verdict, warnings,
    receipt: { ...receiptBase, outcome: "deposited", txHash, assertion: verdict } };
}

async function assertDeposit({ deps, record, txHash, amountMinor, feeAtCheckBps, sharesPredicted }) {
  let facts;
  if (!txHash) facts = { readable: false, why: "no deposit transaction hash is known; the deposit was established without one" };
  else {
    try { facts = await deps.readDepositFacts({ vault: record.vault, holder: record.walletAddress, txHash, amountMinor }); }
    catch (e) { facts = { readable: false, why: `the deposit could not be read: ${String(e?.message ?? e)}` }; }
  }
  return depositVerdict({ feeAtCheckBps, sharesPredictedAtCheck: sharesPredicted, facts });
}

// ═══ 0. RECOVERY — reads the chain, never resubmits ═══════════════════════════════════════════════
async function recoveryFacts({ record, intent, deps }) {
  const r = deps.recovery;
  const depositId = intent.circleIds?.deposit;
  const [circle, event, shares] = await Promise.all([
    depositId ? r.circleState(depositId).catch(() => null) : Promise.resolve({ state: "NONE" }),
    r.findDepositEvent({ vault: record.vault, holder: record.walletAddress, fromBlock: intent.anchor?.blockNumber }).catch(() => null),
    r.shareBalance({ vault: record.vault, holder: record.walletAddress }).catch(() => null),
  ]);
  return { circle, event, shares };
}

async function recoverMandate({ record, deps, now }) {
  const open = await deps.intents.listOpen(record.owner, record.id);
  if (!open?.readable) return { blocking: true, why: open?.why ?? "the intent store could not be read" };
  if (!open.intents.length) return { blocking: false, resolved: 0, results: [] };
  const results = [];
  let blocking = false, resolved = 0;
  for (const { key, intent, etag } of open.intents) {
    const cls = intent.status === "deposited" && intent.txHash
      ? { state: RECOVERY_STATE.DEPOSITED, txHash: intent.txHash, by: "intent" }
      : classifyIntent({ intent, facts: await recoveryFacts({ record, intent, deps }), now });
    if (cls.state === RECOVERY_STATE.DEPOSITED) {
      const amount = Number(intent.amountUsdc);
      // The day-ceiling row executeAction writes after a deposit, keyed by the intent: a no-op if it landed.
      try { await deps.recordAgentSpend({ owner: record.walletAddress, amountUsdc: amount, source: "vault_deposit", chargeId: key, justification: `vault mandate ${record.id}: deposit #${intent.seq} (recovered)` }); }
      catch (e) { results.push({ key, warning: `day-ceiling re-charge failed: ${String(e?.message ?? e)}` }); }
      const verdict = await assertDeposit({ deps, record, txHash: cls.txHash, amountMinor: BigInt(intent.amountMinor ?? micro(amount)),
        feeAtCheckBps: intent.depositFeeBpsAtCheck, sharesPredicted: intent.sharesPredicted });
      await deps.intents.update(key, { ...intent, status: "asserted", txHash: cls.txHash ?? null, recoveredBy: cls.by, verdict }, etag).catch(() => null);
      await commitSeq({ deps, owner: record.owner, id: record.id, seq: intent.seq, amountUsdc: amount, deposited: true, verdict, now });
      try { await deps.recordMandateSpend({ owner: record.walletAddress, amountUsdc: amount, at: now, chargeId: key }); }
      catch (e) { results.push({ key, warning: `mandate-day re-charge failed: ${String(e?.message ?? e)}` }); }
      results.push({ key, state: cls.state, by: cls.by, verdict: verdict.verdict });
      resolved++;
      continue;
    }
    if (cls.state === RECOVERY_STATE.NOT_DEPOSITED) {
      await deps.intents.update(key, { ...intent, status: "not-deposited", closedBy: cls.by, closedAt: iso(now) }, etag).catch(() => null);
      // The seq is consumed; the next deposit uses a new one (create-only per seq).
      await commitSeq({ deps, owner: record.owner, id: record.id, seq: intent.seq, deposited: false, now });
      results.push({ key, state: cls.state, by: cls.by });
      resolved++;
      continue;
    }
    // PENDING or UNREADABLE: stays open and blocks. Unreadable too long → pause INCONCLUSIVE.
    blocking = true;
    const tries = (intent.recoveryTries ?? 0) + (cls.state === RECOVERY_STATE.UNREADABLE ? 1 : 0);
    if (tries !== (intent.recoveryTries ?? 0)) await deps.intents.update(key, { ...intent, recoveryTries: tries }, etag).catch(() => null);
    if (cls.state === RECOVERY_STATE.UNREADABLE && tries >= RECOVERY_MAX_TRIES) {
      await pauseMandate({ deps, owner: record.owner, id: record.id, flags: [PAUSE_FLAG.INCONCLUSIVE], now,
        reason: `deposit #${intent.seq}'s outcome could not be read after ${tries} tries: ${cls.why}` });
    }
    results.push({ key, state: cls.state, why: cls.why, tries });
  }
  return { blocking: blocking || resolved > 0, resolved, results };
}

// ═══ THE TICK ═════════════════════════════════════════════════════════════════════════════════════
/** When is this mandate next due? max(recorded next-due or the ack, the arming moment); one window at a time. */
export function dueState({ record, now, config = SHIPPED }) {
  const cadenceMs = CADENCE_MS[record?.terms?.cadence];
  let base = Number.isFinite(record?.progress?.nextDueAt) ? record.progress.nextDueAt : Date.parse(record?.ack?.at ?? "");
  if (config?.armed === true && Number.isFinite(config.armedFrom)) base = Math.max(base, config.armedFrom);
  if (!Number.isFinite(base) || !cadenceMs) return { due: false, dueAt: null, why: "no due time can be computed" };
  if (now < base) return { due: false, dueAt: base };
  return { due: true, dueAt: base, window: Math.floor((now - base) / cadenceMs) };
}
const windowKey = (record, ds) => `w/${record.owner}/${record.id}/${ds.dueAt}-${ds.window}`;

async function tickOne({ owner, id, deps, config, now }) {
  const armed = config?.armed === true;
  let r = await deps.mandates.read({ owner, id });
  if (!r?.readable) return { owner, id, outcome: "unreadable", reason: (r?.errors ?? []).join("; ") };
  if (!r.record) return { owner, id, outcome: "absent" };

  // 0. RECOVER FIRST. ⭐ Armed only: a disarmed run never touches the intent store (T's requirement 1).
  if (armed) {
    const rec = await recoverMandate({ record: r.record, deps, now });
    if (rec.blocking) return { owner, id, outcome: rec.resolved ? "recovered" : "blocked-by-recovery", recovery: rec };
  }
  const record = r.record;

  // 1. FREE GATES
  const v = verifyMandateRecord(record);
  if (!v.mayAct) return { owner, id, outcome: "may-not-act", reason: v.errors.join("; ") };
  const paused = await deps.isPaused(record.walletAddress);
  if (paused) return { owner, id, outcome: "skipped", reason: paused };
  const ds = dueState({ record, now, config });
  if (!ds.due) return { owner, id, outcome: "not-due", dueAt: ds.dueAt };
  const remaining = record.terms.maxTotalUsdc - (record.progress?.depositedUsdc ?? 0);
  if (!(micro(remaining) > 0)) return { owner, id, outcome: "skipped", reason: "the mandate's total budget is fully deposited" };
  const wkey = windowKey(record, ds);
  if (await deps.receipts.exists(wkey)) return { owner, id, outcome: "observed-this-window", window: wkey };
  const receipt = async (body) => {
    const full = { at: iso(now), armed, window: wkey, ...body };
    await deps.receipts.write(wkey, full, { onlyIfNew: true }).catch(() => null);
    return full;
  };

  // 2. LIMIT PREFLIGHT — reads only; a miss SKIPS: no check run, no signature spent.
  let cap = NaN;
  try { cap = Number(deps.limits.vaultCapUsdc()); } catch { /* unreadable → 0 below */ }
  const amount = effectiveDepositUsdc({ recordAmountUsdc: record.terms.amountPerDepositUsdc, vaultCapUsdc: cap, remainingUsdc: remaining });
  const room = await depositRoom({ record, amountUsdc: amount, deps });
  if (!room.ok) {
    const body = { outcome: "skipped", amountUsdc: amount, reason: `${room.reason} — nothing checked, nothing deposited` };
    await receipt(body);
    return { owner, id, ...body };
  }

  // 3. CHECK — anchor, the report AT it, SIGNED, verified; both endpoints' readings by blockHash.
  const checked = await deps.runCheck(record);
  const base = { amountUsdc: amount, anchor: checked.anchor, report: checked.report, verification: checked.verification,
    reportFailure: checked.reportFailure, readings: checked.readings, timing: checked.timing, cost: checked.cost };

  // 4. DECIDE — an EXIT is a pause until piece 5 (EXIT_AVAILABLE).
  const decision = decideMandateAction({ rules: record.rules, check: checked.check });
  if (decision.action !== ACTION.DEPOSIT) {
    const flags = decision.action === ACTION.EXIT ? [...decision.flags, PAUSE_FLAG.EXIT_UNAVAILABLE] : decision.flags;
    const reason = decision.action === ACTION.EXIT
      ? "a rule you set to exit found something; autonomous exit is not available yet, so the mandate pauses"
      : `the check did not clear: ${flags.join(", ")}`;
    if (armed) await pauseMandate({ deps, owner, id, flags, reason, now });
    const full = await receipt({ ...base, outcome: armed ? "paused" : "would-pause", decision, flags, reason });
    return { owner, id, outcome: full.outcome, flags, receipt: full };
  }

  // 5–8. THE WRITE — the gate inside refuses while disarmed.
  const res = await depositForMandate({ record, etag: r.etag, checked, amountUsdc: amount, deps, now, config });
  if (res.code === REFUSED.DISARMED) {
    const full = await receipt({ ...base, outcome: "would-deposit", decision, note: `WOULD DEPOSIT ${amount} USDC — disarmed, nothing written, nothing executed` });
    return { owner, id, outcome: "would-deposit", amountUsdc: amount, receipt: full };
  }
  const full = await receipt({ ...base, decision, ...(res.receipt ?? {}), outcome: res.ok ? "deposited" : "not-deposited", code: res.code ?? null, reason: res.reason ?? null });
  return { owner, id, outcome: full.outcome, code: res.code ?? null, amountUsdc: amount, receipt: full };
}

/**
 * One scheduled run over every stored mandate. `config` defaults to the shipped constants; ⛔ only the
 * test suite passes it. Never throws for one mandate's failure: that mandate reports `error`.
 */
export async function runMandateTick({ deps, config = SHIPPED }) {
  const now = deps.now();
  let list;
  try { list = await deps.mandates.list(); }
  catch (e) { return { ok: false, armed: config?.armed === true, error: `mandates could not be listed: ${String(e?.message ?? e)}`, results: [] }; }
  const results = [];
  for (const { owner, id } of list) {
    try { results.push(await tickOne({ owner, id, deps, config, now })); }
    catch (e) { results.push({ owner, id, outcome: "error", reason: String(e?.message ?? e) }); }
  }
  return { ok: true, armed: config?.armed === true, results };
}

// ═══ PRODUCTION WIRING ═══════════════════════════════════════════════════════════════════════════
// Lazy imports, so the suite's offline run loads none of the chain / Circle / Blobs machinery.
const ERC20_BAL = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

/** @param {{getStore:Function, event?:object}} a */
export async function productionTickDeps({ getStore, event = null }) {
  const [{ createPublicClient, http, parseAbi, parseAbiItem, decodeEventLog }, { ARC_QUORUM_ENDPOINTS },
    store, check, budget, arc, dca, pause, agents, actions, vault, rungs, circleMod] = await Promise.all([
    import("viem"), import("../../shared/onchain-analyze/endpoints.mjs"),
    import("./_vault-mandate-store.mjs"), import("./_vault-mandate-check.mjs"), import("./_budget.mjs"), import("./_arc.mjs"),
    import("./_dca.mjs"), import("./_pause.mjs"), import("./_agents.mjs"), import("./_actions.mjs"), import("./_vault.mjs"),
    import("./_dd-rungs.mjs"), import("./_circle.mjs"),
  ]);
  const clients = ARC_QUORUM_ENDPOINTS.map((rpc) => createPublicClient({ transport: http(rpc) }));
  const VAULT_ABI = parseAbi(["function previewDeposit(uint256) view returns (uint256)", "function depositFee() view returns (uint256)", "function balanceOf(address) view returns (uint256)"]);
  const DEPOSIT_EVENT = parseAbiItem("event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)");
  // ⭐ Every figure acted on is read on BOTH endpoints and used only where they agree (the anchor's rule).
  const agreed = async (fn) => {
    const vals = await Promise.all(clients.map((c) => fn(c).catch(() => null)));
    return vals.length >= 2 && vals.every((x) => typeof x === "bigint") && new Set(vals.map(String)).size === 1 ? vals[0] : null;
  };
  const read = (address, functionName, args, at) => agreed((c) => c.readContract({ address, abi: VAULT_ABI, functionName, args, ...at }));
  const mstore = getStore(store.VAULT_MANDATE_STORE);
  const health = () => rungs.healthDisclosure(event ?? { headers: {} });

  return {
    now: () => Date.now(),
    mandates: store.mandateAdapter(mstore),
    intents: store.intentAdapter(mstore),
    receipts: store.receiptAdapter(getStore(store.VAULT_MANDATE_RECEIPT_STORE)),
    isPaused: (wallet) => pause.assertNotPaused({ owner: wallet, agent: agents.AGENT.VAULT }),
    limits: {
      ceilingUsdc: () => Number(budget.budgetConfig().PERIOD_CEILING_USDC),
      userReserveFraction: () => dca.userReserveFraction(),
      vaultCapUsdc: () => arc.vaultDepositCapUsdc(),
      canSpendDay: ({ amountUsdc, owner }) => budget.canSpendDay({ amountUsdc, owner }),
      mandateDaySpend: (owner) => budget.mandateDaySpend({ owner }),
      dcaDaySpend: (owner) => budget.dcaDaySpend({ owner }),
      scaUsdcBalanceMinor: (owner) => agreed((c) => c.readContract({ address: arc.CONTRACTS.USDC, abi: ERC20_BAL, functionName: "balanceOf", args: [owner] })),
    },
    runCheck: (record) => check.runMandateCheck({ record, deps: check.productionDeps({ health, resolveVault: vault.resolveVault }) }),
    previewAtAnchor: ({ vault: v, amountMinor, anchor }) => read(v.address, "previewDeposit", [amountMinor], { blockHash: anchor.blockHash }),
    executeAction: (step, ctx) => actions.executeAction(step, ctx),
    async readDepositFacts({ vault: v, holder, txHash, amountMinor }) {
      const receipts = await Promise.all(clients.map((c) => c.getTransactionReceipt({ hash: txHash }).catch(() => null)));
      if (!receipts.every(Boolean) || new Set(receipts.map((x) => String(x.blockHash))).size !== 1) return { readable: false, why: "the deposit receipt could not be read on both endpoints alike" };
      const rc = receipts[0];
      if (rc.status !== "success") return { readable: false, why: `the deposit transaction status is ${rc.status}` };
      const depositBlock = Number(rc.blockNumber), parentBlock = depositBlock - 1;
      const logs = rc.logs.filter((l) => same(l.address, v.address)).map((l) => { try { return decodeEventLog({ abi: [DEPOSIT_EVENT], data: l.data, topics: l.topics }); } catch { return null; } })
        .filter((e) => e?.eventName === "Deposit" && same(e.args.owner, holder));
      const at = { blockNumber: BigInt(parentBlock) }, atDep = { blockNumber: BigInt(depositBlock) };
      const [predictedAtParent, feeP, feeD, balP, balD] = await Promise.all([
        read(v.address, "previewDeposit", [amountMinor], at), read(v.address, "depositFee", [], at), read(v.address, "depositFee", [], atDep),
        read(v.address, "balanceOf", [holder], at), read(v.address, "balanceOf", [holder], atDep),
      ]);
      return { readable: true, depositBlock, parentBlock, predictedAtParent,
        eventShares: logs.length === 1 ? logs[0].args.shares : null,
        shareDelta: typeof balP === "bigint" && typeof balD === "bigint" ? balD - balP : null,
        feeAtParentBps: typeof feeP === "bigint" ? Number(feeP) : null, feeAtDepositBlockBps: typeof feeD === "bigint" ? Number(feeD) : null };
    },
    recordMandateSpend: (x) => budget.recordMandateSpend(x),
    recordAgentSpend: (x) => budget.recordAgentSpend({ agent: agents.AGENT.VAULT, ...x }),
    recovery: {
      async circleState(id) {
        const { data } = await circleMod.circle().getTransaction({ id });
        const s = data?.transaction?.state;
        if (s === "COMPLETE") return { state: "COMPLETE", txHash: data.transaction.txHash ?? null };
        if (s === "FAILED" || s === "CANCELLED" || s === "DENIED") return { state: "FAILED" };
        if (typeof s === "string") return { state: "PENDING" };
        throw new Error("no transaction state");
      },
      async findDepositEvent({ vault: v, holder, fromBlock }) {
        if (!Number.isInteger(fromBlock)) throw new Error("no anchor block to scan from");
        const sets = await Promise.all(clients.map((c) => c.getLogs({ address: v.address, event: DEPOSIT_EVENT, args: { owner: holder }, fromBlock: BigInt(fromBlock), toBlock: "latest" })));
        const hashes = sets.map((s) => s.map((l) => l.transactionHash).sort().join(","));
        // Endpoints at different heads may differ by a just-landed log: any hit on either is a positive.
        const hit = sets.flat()[0];
        if (hit) return { found: true, txHash: hit.transactionHash };
        if (new Set(hashes).size !== 1) throw new Error("the endpoints disagree on the Deposit logs");
        return { found: false };
      },
      async shareBalance({ vault: v, holder }) {
        const b = await read(v.address, "balanceOf", [holder], {});
        if (typeof b !== "bigint") throw new Error("share balance not agreed");
        return b;
      },
    },
  };
}
