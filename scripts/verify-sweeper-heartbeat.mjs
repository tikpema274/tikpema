import assert from "node:assert/strict";
import {
  SWEEPER_CRON_MS, STALE_AFTER_MS, HB_REASON, OBSERVED_REASONS,
  judgeHeartbeat, observeSweeper, composeVerdict, sweeperPrev, sweeperMessage, SWEEPER_CRON,
} from "../shared/strong-read-watch/sweeper-heartbeat.mjs";
import { GUARDED_SCHEDULES } from "./verify-watch-promotion-gate.mjs";
import { decideNotify, REMINDER_MS } from "../shared/strong-read-watch/watch.mjs";

// verify-sweeper-heartbeat — the watcher's watcher.
//
// ═══ 🚨 WHAT THIS SUITE EXISTS FOR, ABOVE EVERYTHING ELSE ════════════════════════════════════
// strong-read-watch is 212/0 and load-bearing: it is the only thing watching the kill switch and
// the spend ceiling. Bolting a second concern onto it can only be justified if that concern
// CANNOT degrade the first. "Wrapped, never throws" is a promise; section 1 turns it into an
// assertion. If this file goes red, the heartbeat check has become able to take the money path's
// monitor down with it and must come straight back out.

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n   ${e.message}`); } };
const ta = async (name, fn) => { try { await fn(); pass++; } catch (e) { fail++; console.error(`✗ ${name}\n   ${e.message}`); } };

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const hbAt = (ms) => ({ at: new Date(NOW - ms).toISOString(), open: 0, totalKeys: 1 });

// ═══ 1. THE ADDITIVE PROPERTY — the reason this suite exists ═════════════════════════════════

const MONEY = [
  { ok: true, reason: "verified" },
  { ok: false, reason: "unreachable" },
  { ok: false, reason: "hotfix" },
];

// Every way the heartbeat read can misbehave, including the ones that would throw.
const HOSTILE_READS = [
  ["throws synchronously", () => { throw new Error("boom"); }],
  ["rejects", () => Promise.reject(new Error("nope"))],
  ["rejects with a non-Error", () => Promise.reject("a string")],
  ["returns null", async () => null],
  ["returns undefined", async () => undefined],
  ["returns a string", async () => "not an object"],
  ["returns a number", async () => 42],
  ["returns {} with no `at`", async () => ({})],
  ["returns a garbage `at`", async () => ({ at: "not-a-date" })],
  ["returns a future `at`", async () => ({ at: new Date(NOW + 86400000).toISOString() })],
  ["returns a fresh heartbeat", async () => hbAt(60 * 1000)],
  ["returns a stale heartbeat", async () => hbAt(STALE_AFTER_MS + 60 * 1000)],
];

for (const [label, read] of HOSTILE_READS) {
  await ta(`⭐ observeSweeper never rejects — ${label}`, async () => {
    const o = await observeSweeper({ read, now: NOW });
    assert.equal(typeof o, "object", "must resolve to an object");
    assert.equal(typeof o.sweeperOk, "boolean", "must always land on a boolean verdict");
    assert.ok(Object.values(HB_REASON).includes(o.reason), `reason ${o.reason} is outside the closed set`);
  });

  await ta(`⭐⭐ a ${label} read CANNOT change ok`, async () => {
    const o = await observeSweeper({ read, now: NOW });
    for (const m of MONEY) {
      const v = composeVerdict({ moneyJudgement: m, sweeperObservation: o });
      assert.equal(v.ok, m.ok,
        `ok moved from ${m.ok} to ${v.ok} when the sweeper read ${label} — the heartbeat check has ` +
        `become able to degrade the money path's verdict`);
      assert.equal(v.reason, m.reason, "reason must also come from the money path alone");
    }
  });

  await ta(`⭐⭐ the observation has NO \`ok\` field to clobber — ${label}`, async () => {
    const o = await observeSweeper({ read, now: NOW });
    // The failure this makes unspellable: `{...record, ...observation}` overwriting the verdict.
    assert.ok(!("ok" in o), "observation must expose sweeperOk, never ok");
    const merged = { ok: true, reason: "verified", ...o };
    assert.equal(merged.ok, true, "a naive spread must not be able to flip the money verdict");
  });
}

await ta("⭐ composeVerdict tolerates a missing observation entirely", async () => {
  for (const m of MONEY) {
    assert.equal(composeVerdict({ moneyJudgement: m, sweeperObservation: null }).ok, m.ok);
    assert.equal(composeVerdict({ moneyJudgement: m }).ok, m.ok);
  }
});

t("⭐ ok is never an AND/OR of the two — a healthy money path with a dead sweeper stays ok:true", () => {
  const dead = judgeHeartbeat({ hb: hbAt(STALE_AFTER_MS + 1), now: NOW });
  assert.equal(dead.sweeperOk, false);
  const v = composeVerdict({ moneyJudgement: { ok: true, reason: "verified" }, sweeperObservation: dead });
  assert.equal(v.ok, true, "a dead sweeper must not make this monitor claim strong reads are broken");
  assert.equal(v.sweeper.sweeperOk, false, "…while still carrying the sweeper's real verdict");
});

// ═══ 2. TWO CONCERNS, TWO PREVS ══════════════════════════════════════════════════════════════

t("⭐⭐ a RECOVERING money path does not silence a still-stale sweeper", () => {
  // prev: money failing, sweeper already alerted-stale. now: money recovered, sweeper still stale.
  const prev = { ok: false, lastNotifiedAt: new Date(NOW - 60_000).toISOString(),
                 sweeper: { sweeperOk: false }, sweeperLastNotifiedAt: null };
  const money = decideNotify({ prevOk: prev.ok, ok: true, lastNotifiedAt: prev.lastNotifiedAt, now: NOW });
  assert.equal(money.kind, "recovered");

  const sp = sweeperPrev(prev);
  const sw = decideNotify({ prevOk: sp.prevOk, ok: false, lastNotifiedAt: sp.lastNotifiedAt, now: NOW });
  // ⭐ never-delivered ⇒ must notify NOW rather than wait out a window it never earned.
  assert.equal(sw.notify, true, "the sweeper's alert must survive the money path recovering");
  assert.equal(sw.kind, "still-failing");
});

t("⭐⭐ the reverse — a recovering sweeper does not silence a money-path regression", () => {
  const prev = { ok: true, lastNotifiedAt: null, sweeper: { sweeperOk: false },
                 sweeperLastNotifiedAt: new Date(NOW - 60_000).toISOString() };
  const money = decideNotify({ prevOk: prev.ok, ok: false, lastNotifiedAt: prev.lastNotifiedAt, now: NOW });
  assert.equal(money.notify, true, "the money path must still page");
  assert.equal(money.kind, "regressed");

  const sp = sweeperPrev(prev);
  const sw = decideNotify({ prevOk: sp.prevOk, ok: true, lastNotifiedAt: sp.lastNotifiedAt, now: NOW });
  assert.equal(sw.kind, "recovered");
});

t("⭐ the two suppression clocks are independent", () => {
  // Money notified 1 min ago; sweeper never. Both still failing.
  const prev = { ok: false, lastNotifiedAt: new Date(NOW - 60_000).toISOString(),
                 sweeper: { sweeperOk: false }, sweeperLastNotifiedAt: null };
  const money = decideNotify({ prevOk: false, ok: false, lastNotifiedAt: prev.lastNotifiedAt, now: NOW });
  assert.equal(money.notify, false, "money is inside its reminder window");
  const sp = sweeperPrev(prev);
  const sw = decideNotify({ prevOk: sp.prevOk, ok: false, lastNotifiedAt: sp.lastNotifiedAt, now: NOW });
  assert.equal(sw.notify, true, "the sweeper's own clock has never started, so it must page");
});

t("sweeperPrev returns null — not false — when there is no prior sweeper observation", () => {
  assert.equal(sweeperPrev(null).prevOk, null);
  assert.equal(sweeperPrev({ ok: true }).prevOk, null, "a record from before this feature must read as UNKNOWN");
  assert.equal(sweeperPrev({ sweeper: { sweeperOk: "yes" } }).prevOk, null, "a non-boolean is not a verdict");
  assert.equal(sweeperPrev({ sweeper: { sweeperOk: false } }).prevOk, false);
});

t("⭐ a first observation that is FAILING notifies; a first observation that is HEALTHY stays quiet", () => {
  assert.equal(decideNotify({ prevOk: null, ok: false, lastNotifiedAt: null, now: NOW }).kind, "first-failure");
  assert.equal(decideNotify({ prevOk: null, ok: true, lastNotifiedAt: null, now: NOW }).notify, false);
});

// ═══ 3. THE JUDGEMENT ITSELF ═════════════════════════════════════════════════════════════════

t("⭐⭐ SWEEPER_CRON matches the gate's row — a third copy of a schedule is a drift waiting to happen", () => {
  const row = GUARDED_SCHEDULES.find((g) => g.functionName === "ub-withdraw-sweep");
  assert.ok(row, "ub-withdraw-sweep must still be a guarded schedule");
  assert.equal(SWEEPER_CRON, row.expectedCron,
    "this module's idea of the sweeper's period has drifted from the gate's — the staleness " +
    "threshold would then be derived from a schedule that no longer runs");
});

t("⭐ the threshold is DERIVED from the sweeper's cron — one missed tick tolerated, two not", () => {
  assert.equal(STALE_AFTER_MS, SWEEPER_CRON_MS * 2 + 10 * 60 * 1000);
  assert.equal(judgeHeartbeat({ hb: hbAt(SWEEPER_CRON_MS + 60_000), now: NOW }).sweeperOk, true,
    "one missed tick must NOT page — that is ordinary scheduler jitter");
  assert.equal(judgeHeartbeat({ hb: hbAt(SWEEPER_CRON_MS * 2 + 11 * 60_000), now: NOW }).sweeperOk, false,
    "two missed ticks must page");
});

t("⭐ ABSENCE IS NOT HEALTH — missing, unreadable and malformed all fail closed", () => {
  assert.equal(judgeHeartbeat({ hb: null, now: NOW }).reason, HB_REASON.MISSING);
  assert.equal(judgeHeartbeat({ hb: null, now: NOW }).sweeperOk, false);
  assert.equal(judgeHeartbeat({ hb: { at: "???" }, now: NOW }).sweeperOk, false);
  assert.equal(judgeHeartbeat({ hb: {}, now: NOW }).reason, HB_REASON.MALFORMED);
});

t("⭐ a FUTURE heartbeat is malformed, not fresh — a broken writer must not silence this check", () => {
  const j = judgeHeartbeat({ hb: hbAt(-(SWEEPER_CRON_MS + 60_000)), now: NOW });
  assert.equal(j.reason, HB_REASON.MALFORMED);
  assert.equal(j.sweeperOk, false);
  // …but ordinary clock skew inside one period is still fine.
  assert.equal(judgeHeartbeat({ hb: hbAt(-60_000), now: NOW }).sweeperOk, true);
});

t("a fresh heartbeat carries the sweeper's own counts through", () => {
  const j = judgeHeartbeat({ hb: { at: new Date(NOW - 60_000).toISOString(), open: 3, totalKeys: 4 }, now: NOW });
  assert.equal(j.sweeperOk, true);
  assert.equal(j.open, 3);
  assert.equal(j.heartbeatAt, new Date(NOW - 60_000).toISOString());
});

// ═══ 4. THE MESSAGE — a consequence claim must be EARNED ═════════════════════════════════════

t("⭐⭐ only an OBSERVED stale heartbeat may claim withdrawals are not completing", () => {
  const stale = judgeHeartbeat({ hb: hbAt(STALE_AFTER_MS + 60_000), now: NOW });
  const m = sweeperMessage({ kind: "first-failure", observation: stale });
  assert.match(m, /What this costs/, "an observed stall has earned its consequence paragraph");
  assert.match(m, /expired clock/);

  for (const hb of [null, {}, { at: "nope" }]) {
    const j = judgeHeartbeat({ hb, now: NOW });
    const msg = sweeperMessage({ kind: "first-failure", observation: j });
    assert.doesNotMatch(msg, /What this costs/,
      `${j.reason} did not OBSERVE a failure — it failed to observe — so it must not claim consequences`);
    assert.match(msg, /failed to observe/);
  }
});

t("an unreadable store gets the cannot-verify treatment too", async () => {
  const o = await observeSweeper({ read: () => { throw new Error("x"); }, now: NOW });
  assert.equal(o.reason, HB_REASON.UNREADABLE);
  assert.ok(!OBSERVED_REASONS.includes(o.reason), "unreadable must never be an observed failure");
  assert.doesNotMatch(sweeperMessage({ kind: "first-failure", observation: o }), /What this costs/);
});

t("⭐ every message discloses the eventual-consistency caveat and prints the timestamp it saw", () => {
  for (const hb of [null, {}, hbAt(STALE_AFTER_MS + 1)]) {
    const m = sweeperMessage({ kind: "first-failure", observation: judgeHeartbeat({ hb, now: NOW }) });
    assert.match(m, /eventually consistent/, "a cached read can look stale — the reader must know");
    assert.match(m, /Read as of/);
  }
});

t("⭐ headlines are distinct from the strong-read monitor's, so nobody misreads the concern", () => {
  for (const hb of [null, {}, hbAt(STALE_AFTER_MS + 1)]) {
    const m = sweeperMessage({ kind: "first-failure", observation: judgeHeartbeat({ hb, now: NOW }) });
    assert.match(m.split("\n")[0], /UB SWEEPER/, "the first line is what a human reads at 3am");
  }
});

t("⭐ recovery does NOT claim the missed withdrawals were handled", () => {
  const m = sweeperMessage({ kind: "recovered", observation: judgeHeartbeat({ hb: hbAt(60_000), now: NOW }) });
  assert.match(m, /REPORTING AGAIN/);
  assert.match(m, /not recovery of any withdrawal it missed/,
    "the sweeper coming back is not the same as the backlog being cleared");
});

t("a reminder is marked as one", () => {
  const j = judgeHeartbeat({ hb: hbAt(STALE_AFTER_MS + 1), now: NOW });
  assert.match(sweeperMessage({ kind: "still-failing", observation: j }), /reminder/);
  assert.doesNotMatch(sweeperMessage({ kind: "first-failure", observation: j }), /reminder —/);
});

t("the reminder window is the monitor's, not a second copy", () => {
  assert.equal(typeof REMINDER_MS, "number");
  assert.ok(REMINDER_MS > 0);
});

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-sweeper-heartbeat: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
