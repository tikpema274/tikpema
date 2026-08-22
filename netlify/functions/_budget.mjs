// _budget.mjs — the SAFETY SPINE for autonomous data purchases.
//
// Tikpema's research agent will (in a LATER phase) buy paid data mid-research,
// funded from a "data allowance" carved out of the user's job payment. This
// module governs that spend BEFORE any autonomous buying is wired. It enforces
// three caps and keeps an append-only audit trail, persisted in the Netlify
// Blobs store (same store pattern as predict-jobs).
//
// THREE CAPS (env-configurable; defaults below):
//   1. DATA_ALLOWANCE_PCT   (0.30) — per-job data allowance = jobPrice × pct.
//   2. PER_PURCHASE_PCT     (0.50) — max single buy   = jobAllowance × pct.
//   3. PERIOD_CEILING_USDC  (2.00) — max autonomous spend per rolling UTC day,
//                                    PER USER (per agent wallet). Each user's own
//                                    wallet has its own daily budget; one user's
//                                    spend never draws down another's ceiling.
//
// NOT WIRED into agent-act / the research engine / x402-pay in this phase. This
// is the module + its persistence + isolated tests only.
//
// STORE INJECTION. Every function takes an optional `store` (a tiny
// { getJSON, setJSON } adapter). Production defaults to the Netlify Blobs store;
// tests inject an in-memory store so the caps are provable with zero Netlify
// runtime. Callers inside a classic-Lambda handler must connectBlobs(event)
// before the Netlify-backed default is used.

import { getStore } from "@netlify/blobs";
import { connectBlobs } from "./_blobs.mjs";
import { AGENT, normalizeAgent } from "./_agents.mjs";

const BUDGET_STORE = "data-budget";
// The old single-array audit key. Entries are now per-key (see appendAudit) — this remains
// ONLY so a future migration can find the legacy array; nothing reads or writes it.
const LEGACY_AUDIT_KEY = "audit:log";

// ── Config ──────────────────────────────────────────────────────────────────
// Read at call time so env changes (and tests) take effect immediately. A
// non-finite or negative override falls back to the default (fail-safe): a
// garbled cap must never widen spending.
const cfgNum = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
export function budgetConfig() {
  return {
    DATA_ALLOWANCE_PCT: cfgNum(process.env.DATA_ALLOWANCE_PCT, 0.30),
    PER_PURCHASE_PCT: cfgNum(process.env.PER_PURCHASE_PCT, 0.50),
    PERIOD_CEILING_USDC: cfgNum(process.env.PERIOD_CEILING_USDC, 2.0),
  };
}

// ── USDC math in atomic 6-dp integers ─────────────────────────────────────────
// USDC is 6-decimal. Doing cap comparisons in micro-USDC integers avoids float
// drift (e.g. 0.35 × 0.30 landing at 0.10499999…). Human-facing totals are
// rounded back to 6dp on store/return.
const atomic = (usdc) => Math.round(Number(usdc) * 1e6);
const round6 = (usdc) => atomic(usdc) / 1e6;

// ── Time (rolling calendar day, UTC) ──────────────────────────────────────────
const utcDate = (at) => (at ? new Date(at) : new Date()).toISOString().slice(0, 10);
const isoTs = (at) => (at ? new Date(at) : new Date()).toISOString();

// ── Default (Netlify Blobs) store adapter — lazy, so tests never touch it ─────
//
// The adapter now exposes three things beyond get/set, because the naive read-modify-write it
// used to do was LOSING DATA under concurrency (see appendAudit / bumpCounter below):
//   · getWithEtag  — the version stamp a compare-and-set needs
//   · setIfMatch   — conditional write; `false` means someone else wrote first, so retry
//   · setIfNew     — create-only write; the primitive that makes an append un-clobberable
//   · list         — enumerate by key prefix (per-entry audit records)
// ═══ 🚨 STRONG CONSISTENCY — A CACHED COUNTER IS A WIDENED CAP ═══════════════════════════════
// Netlify Blobs reads default to consistency:"eventual" — a CDN-cached edge read, not the origin.
// For a SPEND COUNTER that fails in the permissive direction, and quietly:
//
//   spend $1.90 of a $2.00 daily ceiling  ->  written to ORIGIN
//   next spend reads the counter          ->  gets a CACHED, LOWER total
//   dayA + amtA > ceilA                   ->  FALSE when it should be TRUE  ->  SPEND ALLOWED
//
// ⚠️ AND THE MISS DEFAULTS TO ZERO, which is the worst possible value. Every reader does
// `rec?.spentUsdc ?? 0`, so a cache that has not yet seen today's key at all reports "nothing spent
// today" and hands over the ENTIRE ceiling. A stale read does not merely under-count; it can reset
// the day.
//
// This is the same defect measured on the DD canary health artifact (aca4d31) and fixed on the
// kill switch (da3aee0) — found by auditing every Blobs read after the first. The module's own
// header already names this exact failure from the concurrency angle: "a dropped spend is a
// WIDENED CAP — the one thing this module exists to prevent." A cached read drops it just as
// effectively as a lost update did, and neither throws.
//
// ⭐ THIS DOES NOT WEAKEN THE EXISTING FAIL-CLOSED BEHAVIOUR. `getJSON` deliberately has no catch:
// an unreadable counter THROWS, propagates out through daySpend -> canSpend/canSpendDay -> the
// caller, and the spend never happens. Adding a read option adds no catch and swallows nothing.
const READ_CONSISTENCY = "strong";

// ═══ 🚨🚨 THE HANDLE IS REBUILT WHEN THE BLOBS CONTEXT CHANGES — MEASURED WEDGE, 2026-08-22 ═══
//
// This adapter used to be memoised UNCONDITIONALLY (`if (_defaultAdapter) return _defaultAdapter`),
// which binds it to whatever Blobs token existed the FIRST time it was built. In a warm container
// that token expires (~15 min TTL) and every subsequent budget read/write fails with
// "Netlify Blobs has generated an internal error (Failed to decode token: Token exp…)" — forever,
// because nothing ever rebuilds the handle.
//
// ⭐ OBSERVED ON PROD: a DCA fill at 17:12:06 succeeded and built the adapter. The next fill came
// due at 18:00 and every tick from 18:00:44 onward DEFERRED on that error. The discriminator was
// decisive and is worth keeping: in the SAME invocation, dca-tick's OWN stores worked (it calls
// getStore inside the handler, so they are fresh) while every budget call failed — and the tick's
// injected token was fresh, `tokenExp.remainingAtStartMs` ~899 000. Same Blobs, same live token,
// one path working and one not. The only difference was this memo.
//
// 🚨 AND IT SILENTLY VOIDED A CORRECTNESS ARGUMENT MADE ELSEWHERE. dca-tick's transient-defer
// handler says a deferral is safe because "the next tick redoes the identical, idempotent step
// with a FRESH injected token". The next tick IS handed a fresh token — this module just never
// used it. A retry that cannot possibly get a new credential is not a retry, so the defer loop
// could never terminate. ⚠️ A cached handle can invalidate a guarantee written in another file.
//
// ⭐ THE KEY IS THE CONTEXT ITSELF, not a timer or a TTL guess. connectLambda builds the four-field
// context and hands it to setEnvironmentContext, which OVERWRITES NETLIFY_BLOBS_CONTEXT wholesale
// — so a new token means a new string, and a string compare is exact, cheap, and needs no
// knowledge of the token's format or lifetime. Undefined (tests, local) compares equal to
// undefined, so behaviour there is unchanged.
let _defaultAdapter = null;
let _defaultAdapterContext = null;
function defaultStore() {
  const ctx = process.env.NETLIFY_BLOBS_CONTEXT ?? null;
  if (_defaultAdapter && _defaultAdapterContext === ctx) return _defaultAdapter;
  const s = getStore(BUDGET_STORE);
  _defaultAdapterContext = ctx;
  _defaultAdapter = {
    async getJSON(key) {
      return (await s.get(key, { type: "json", consistency: READ_CONSISTENCY })) ?? null;
    },
    async setJSON(key, value) {
      await s.setJSON(key, value);
    },
    // Returns { value, etag }. etag is undefined when the key does not exist yet.
    //
    // ⭐ Strong here too, for a LIVENESS reason rather than a safety one — worth stating, because
    // the safety argument does NOT apply and someone will check. A cached read here is already
    // SAFE: it yields a stale etag, `setIfMatch` therefore fails, and casUpdate re-reads and
    // retries, so no wrong total can be committed. But it retries against the same stale cache up
    // to CAS_TRIES, then throws "could not update after 24 attempts (contention)" — diagnosing as
    // write contention something that is actually a cold read. Reading origin makes the retry loop
    // converge on the first attempt instead of burning 24 and failing loud for the wrong reason.
    //
    // ⚠️ `readable` EXISTS BECAUSE THE OLD `.catch(() => null)` COLLAPSED TWO DIFFERENT STATES.
    // A missing key and an UNREADABLE STORE both produced {value:null, etag:undefined}, and
    // `mutate(null)` builds a FRESH record — i.e. today's spend counted from zero. That never
    // actually committed, but only because `setIfMatch` degrades to `onlyIfNew` without an etag and
    // an existing key rejects the write. The guard was one layer BELOW the defect, and it turned a
    // store outage into "could not update after 24 attempts (contention)" — a false cause, after
    // ~19 full-backoff retries against a store that was never going to answer, on a request with a
    // 10s ceiling. The likely user-visible result was a timeout, not the intended loud error.
    async getWithEtag(key) {
      try {
        const res = await s.getWithMetadata(key, { type: "json", consistency: READ_CONSISTENCY });
        // ⭐ A SUCCESSFUL READ OF AN ABSENT KEY IS `value:null` WITH `readable:true`. That is the
        // first spend of the day and it MUST still build a fresh record. Only the catch below is
        // "unreadable" — conflating the two in either direction breaks something real.
        return { value: res?.data ?? null, etag: res?.etag, readable: true };
      } catch {
        return { value: null, etag: undefined, readable: false };
      }
    },
    // Compare-and-set. Returns true iff WE wrote it. A false means another writer landed
    // between our read and our write — the caller must re-read and retry.
    async setIfMatch(key, value, etag) {
      const res = etag
        ? await s.setJSON(key, value, { onlyIfMatch: etag })
        : await s.setJSON(key, value, { onlyIfNew: true }); // no etag ⇒ the key must be new
      return res?.modified !== false;
    },
    async setIfNew(key, value) {
      const res = await s.setJSON(key, value, { onlyIfNew: true });
      return res?.modified !== false;
    },
    async list(prefix) {
      const res = await s.list({ prefix });
      return (res?.blobs ?? []).map((b) => b.key);
    },
  };
  return _defaultAdapter;
}
const pickStore = (store) => store ?? defaultStore();

// ── Compare-and-set counter bump ─────────────────────────────────────────────
// THE BUG THIS FIXES (money-safety, not bookkeeping): recordSpend/recordAgentSpend used to
// read `spentUsdc`, add, and write it back. Two concurrent spends BOTH read X and BOTH write
// X+amount — so one spend vanishes from the running total and the PERIOD_CEILING_USDC gate
// silently under-counts. The ceiling did not actually hold under concurrency.
//
// Brick 2 (two analysts, both buying data, both ledgering) is exactly that concurrency.
//
// `mutate` receives the current record (or null) and returns the next one. We retry on a lost
// CAS. The retry count is bounded — a hot key that cannot settle must FAIL LOUDLY rather than
// silently drop a spend, because a dropped spend is a widened cap.
// Retries are generous and BACKED OFF WITH JITTER. Without jitter, N writers that collide
// once tend to collide again on every retry in lockstep — they livelock rather than converge.
// A plain 6-try loop dies at ~25 concurrent writers on one key; with jitter it settles easily.
const CAS_TRIES = 24;
const CAS_BASE_MS = 4;

async function casUpdate(s, key, mutate) {
  // Stores injected by tests may not implement CAS. Fall back to the old read-modify-write
  // rather than crash — such stores are single-threaded fixtures with nothing to race.
  if (typeof s.getWithEtag !== "function" || typeof s.setIfMatch !== "function") {
    const next = mutate((await s.getJSON(key)) ?? null);
    await s.setJSON(key, next);
    return next;
  }

  for (let i = 0; i < CAS_TRIES; i++) {
    const { value, etag, readable } = await s.getWithEtag(key);

    // 🚨 DEFAULTS TO NOT-READABLE. `!readable`, NEVER `readable === false`: an adapter that predates
    // this field returns `undefined`, and `undefined` must mean UNKNOWN — which is refused. Writing
    // the comparison the other way would let exactly the adapters that cannot report readability
    // sail through, reproducing the `!!null`-renders-as-false defect this field exists to fix.
    //
    // Refuse IMMEDIATELY rather than retrying: an unreadable store is not a race, so the retry loop
    // cannot help, and spending the backoff budget on it converts a clear refusal into a timeout.
    // A refused spend is the safe direction — a dropped spend is a widened cap.
    if (!readable) {
      throw new Error(
        `budget: ${key} is UNREADABLE (the store did not answer) — refusing the spend. This is NOT ` +
          `contention: no read succeeded, so the current total is unknown and proceeding would count ` +
          `today's spend from zero.`
      );
    }

    const next = mutate(value);
    if (await s.setIfMatch(key, next, etag)) return next;

    // Lost the race: someone wrote between our read and our write. Re-read, re-apply — the
    // increment is recomputed from the WINNER's value, so nothing is lost. Back off with
    // jitter so contending writers spread out instead of colliding again in lockstep.
    const backoff = CAS_BASE_MS * 2 ** Math.min(i, 5) * (0.5 + Math.random());
    await new Promise((r) => setTimeout(r, backoff));
  }

  // FAIL LOUD. A dropped spend is a WIDENED CAP — the one thing this module exists to
  // prevent. Never swallow this: the caller must know the ledger did not record the spend.
  throw new Error(`budget: could not update ${key} after ${CAS_TRIES} attempts (contention)`);
}

const jobKey = (jobId) => `job:${jobId}`;
// The daily ceiling is PER-USER: the day total is namespaced by the owner — the
// SERVER-RESOLVED agent wallet address (never client-supplied). One wallet's
// spend no longer counts against every other wallet's ceiling. A missing owner
// falls back to a shared "_global" bucket, which only the isolated unit tests
// hit; every production caller passes its session-resolved wallet address.
const ownerKey = (owner) =>
  typeof owner === "string" && owner ? owner.toLowerCase() : "_global";
const dayKey = (owner, date) => `day:${ownerKey(owner)}:${date}`;

// ── Core: the per-job allowance ───────────────────────────────────────────────
export function jobAllowance(jobPriceUsdc) {
  const { DATA_ALLOWANCE_PCT } = budgetConfig();
  return round6(Number(jobPriceUsdc) * DATA_ALLOWANCE_PCT);
}

// ── Reads (cheap: per-job and per-day totals are their own keys) ──────────────
export async function jobSpend(jobId, { store } = {}) {
  const rec = await pickStore(store).getJSON(jobKey(jobId));
  return rec?.spentUsdc ?? 0;
}
// Per-user day total. `owner` is the agent wallet address; omit only in tests
// (falls back to the shared "_global" bucket). `date` or `at` select the UTC day.
export async function daySpend({ owner, date, at, store } = {}) {
  const d = date ?? utcDate(at);
  const rec = await pickStore(store).getJSON(dayKey(owner, d));
  return rec?.spentUsdc ?? 0;
}

// ── DCA'S DAILY SHARE — a per-owner-per-day sub-counter, so an autonomous DCA tick can be
// bounded to a FRACTION of the daily ceiling and the rest stays reserved for the user's own
// actions. This is a PARALLEL counter to the day-ledger above, not a replacement: the day-ledger
// stores one per-owner TOTAL with no per-source split, so DCA's share cannot be read from it.
// It reuses the SAME per-owner-per-day keying and the SAME casUpdate atomic increment (so it
// inherits the concurrency-safe accounting, never the read-modify-write under-count). The
// scheduler increments this on each successful DCA fill; the hard `canSpendDay` (total ≤ full
// ceiling) remains the absolute backstop underneath.
const dcaDayKey = (owner, date) => `dca-day:${ownerKey(owner)}:${date}`;

export async function dcaDaySpend({ owner, date, at, store } = {}) {
  const d = date ?? utcDate(at);
  const rec = await pickStore(store).getJSON(dcaDayKey(owner, d));
  return rec?.spentUsdc ?? 0;
}

export async function recordDcaSpend({ owner, amountUsdc, at, store } = {}) {
  const s = pickStore(store);
  const amt = round6(amountUsdc);
  const date = utcDate(at);
  const rec = await casUpdate(s, dcaDayKey(owner, date), (cur) => {
    const r = cur ?? { date, owner: ownerKey(owner), spentUsdc: 0 };
    return { ...r, spentUsdc: round6((r.spentUsdc ?? 0) + amt) };
  });
  return rec.spentUsdc;
}

// ── The gate: canSpend ────────────────────────────────────────────────────────
// Checks in order and returns the FIRST failing reason:
//   (a) amount ≤ per-purchase sub-cap
//   (b) job's cumulative data spend + amount ≤ job allowance
//   (c) today's cumulative autonomous spend + amount ≤ period ceiling
export async function canSpend({ jobId, jobPriceUsdc, amountUsdc, store, at, owner }) {
  const s = pickStore(store);
  const cfg = budgetConfig();

  // ── (0) THE GATE PROTECTS ITSELF. ──────────────────────────────────────────
  // Every check below is a `>` comparison, and EVERY comparison against NaN is false — so a
  // non-finite input made all three pass vacuously and this function returned {allowed: true}.
  // That is the fail-open cap pattern, and it has bitten this project twice (see the removed
  // /api/gateway-deposit, whose `Number(process.env.X || "1")` yielded NaN so `amount > NaN`
  // let every spend through).
  //
  // It was previously survivable ONLY because the caller happened to guard first
  // (_research.mjs:262). Safety that lives in the caller is not safety: the next caller
  // inherits none of it, and forgets silently. So the refusal moves INTO the gate.
  //
  // Refuse, do not throw: canSpend's contract is a verdict, and every caller already branches
  // on `allowed`. Throwing would turn a bad input into an unhandled 500 on a money path.
  // `atomic()` is Math.round(Number(x) * 1e6) — check BEFORE it, since Math.round(NaN) is NaN
  // and the NaN would simply reappear downstream.
  // `show` prints the value as the caller actually passed it. JSON.stringify(NaN) is "null",
  // which would send a reader debugging a garbled price hunting for a null instead of a NaN.
  const show = (v) => (typeof v === "string" ? JSON.stringify(v) : String(v));
  if (!Number.isFinite(Number(amountUsdc)) || Number(amountUsdc) <= 0) {
    return { allowed: false, reason: `amount ${show(amountUsdc)} is not a positive finite number; refusing to spend` };
  }
  // jobPrice may legitimately be 0 (a free job buys no data — the allowance is then 0 and the
  // per-purchase check refuses anyway), but it can never be negative or garbled. Left unguarded,
  // a NaN here vacuously defeated checks (a) and (b), leaving only the day ceiling standing.
  if (!Number.isFinite(Number(jobPriceUsdc)) || Number(jobPriceUsdc) < 0) {
    return { allowed: false, reason: `jobPrice ${show(jobPriceUsdc)} is not a non-negative finite number; refusing to spend` };
  }

  const amtA = atomic(amountUsdc);
  if (amtA <= 0) return { allowed: false, reason: `amount ${amountUsdc} must be > 0` };

  const allowanceA = atomic(jobAllowance(jobPriceUsdc));
  const perPurchaseA = Math.floor(allowanceA * cfg.PER_PURCHASE_PCT);

  // (a) per-purchase sub-cap
  if (amtA > perPurchaseA) {
    return {
      allowed: false,
      reason:
        `per-purchase cap: ${round6(amtA / 1e6)} > ${round6(perPurchaseA / 1e6)} USDC ` +
        `(${cfg.PER_PURCHASE_PCT} of job allowance ${round6(allowanceA / 1e6)})`,
    };
  }

  // (b) per-job allowance
  const jobSpentA = atomic(await jobSpend(jobId, { store: s }));
  if (jobSpentA + amtA > allowanceA) {
    return {
      allowed: false,
      reason:
        `job allowance: ${round6((jobSpentA + amtA) / 1e6)} > ${round6(allowanceA / 1e6)} USDC ` +
        `(already spent ${round6(jobSpentA / 1e6)} on job ${jobId})`,
    };
  }

  // (c) period ceiling (rolling UTC day, PER USER — this owner's own budget)
  const dayA = atomic(await daySpend({ owner, at, store: s }));
  const ceilA = atomic(cfg.PERIOD_CEILING_USDC);
  if (dayA + amtA > ceilA) {
    return {
      allowed: false,
      reason:
        `period ceiling: ${round6((dayA + amtA) / 1e6)} > ${cfg.PERIOD_CEILING_USDC} USDC ` +
        `daily (already spent ${round6(dayA / 1e6)} today ${utcDate(at)})`,
    };
  }

  return { allowed: true };
}

// ── Append-only audit trail — PER-ENTRY KEYS, never a shared array ────────────
//
// THE BUG THIS FIXES: appending used to read the WHOLE audit array, push, and write it back.
// Two concurrent appends both read the same array and both write their own copy — one entry
// is silently LOST. The record of what your agent spent was itself unreliable, exactly when
// the agent was busiest.
//
// Now every entry is its OWN immutable key, written create-only (`setIfNew`). An append
// cannot clobber another append because it never touches another append's key. There is no
// read-modify-write left to race.
//
// KEY SHAPE:  audit:<owner>:<date>:<ts>-<rand>
//   owner + date in the KEY  → list({prefix}) gives one user's day, cheaply and scoped
//   agent in the VALUE       → the per-agent breakdown the Agents page renders
//
// ⚠️ `agent` (WHO acted) is deliberately separate from `source` (WHICH tool/action). One
// agent uses many sources. See _agents.mjs.
const auditKey = (owner, date) =>
  `audit:${ownerKey(owner)}:${date}:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

// `dedupeKey` (OPTIONAL) — write at a DETERMINISTIC suffix instead of a random one, where
// "the key already exists" is SUCCESS, not a collision to retry. That inverts the usual meaning of
// setIfNew here on purpose: a random-suffix entry must never be lost (retry with a new key), but a
// deterministic MARKER must never be duplicated (a second writer is a no-op). It is what makes the
// sweeper's resolve-marking safe against two ticks racing the same charge, with no lock — and it lets
// handled-ness be read from KEYS ALONE, without fetching a single value.
async function appendAudit(s, { owner, at, dedupeKey, ...entry }) {
  const date = utcDate(at);
  const value = {
    ...entry,
    owner: ownerKey(owner),
    agent: normalizeAgent(entry.agent),
    date,
    timestamp: isoTs(at),
  };

  // Stores injected by tests may not implement setIfNew — fall back to a plain write.
  const write = async (key) =>
    typeof s.setIfNew === "function" ? s.setIfNew(key, value) : (await s.setJSON(key, value), true);

  if (dedupeKey) {
    await write(`audit:${ownerKey(owner)}:${date}:${dedupeKey}`);
    return; // already-exists => another writer got there first => nothing to do
  }

  // A key collision (same ms + same random suffix) is vanishingly unlikely, but if it happens
  // the entry must NOT be dropped — retry with a fresh key rather than lose the record.
  for (let i = 0; i < 3; i++) {
    if (await write(auditKey(owner, date))) return;
  }
  throw new Error("budget: could not write audit entry (key collision)");
}

// ── Record an ALLOWED spend against job total + day total, and audit it ───────
//
// `agent` = WHO spent (_agents.mjs). Defaults to RESEARCHER because every recordSpend caller
// today is the research/data-purchase path — but pass it explicitly; the default exists so an
// un-updated caller degrades to a plausible attribution rather than "unattributed".
export async function recordSpend({
  jobId, jobPriceUsdc, amountUsdc, source, justification, store, at, owner,
  agent = AGENT.RESEARCHER,
}) {
  const s = pickStore(store);
  const amt = round6(amountUsdc);
  const allowanceUsdc = jobAllowance(jobPriceUsdc);

  // Both counters are now COMPARE-AND-SET. A concurrent spend can no longer read the same
  // total and overwrite the other's increment — which used to silently widen the ceiling.
  const jRec = await casUpdate(s, jobKey(jobId), (cur) => {
    const rec = cur ?? { jobId, jobPriceUsdc: Number(jobPriceUsdc), allowanceUsdc, spentUsdc: 0 };
    return {
      ...rec,
      jobPriceUsdc: Number(jobPriceUsdc),
      allowanceUsdc,
      spentUsdc: round6((rec.spentUsdc ?? 0) + amt),
    };
  });

  // per-day running total (rolling UTC day, keyed to THIS owner's wallet)
  const date = utcDate(at);
  const dRec = await casUpdate(s, dayKey(owner, date), (cur) => {
    const rec = cur ?? { date, owner: ownerKey(owner), spentUsdc: 0 };
    return { ...rec, spentUsdc: round6((rec.spentUsdc ?? 0) + amt) };
  });

  await appendAudit(s, {
    owner, at, agent,
    jobId,
    amountUsdc: amt,
    source,
    justification,
    allowed: true,
  });

  return { jobSpentUsdc: jRec.spentUsdc, daySpentUsdc: dRec.spentUsdc, allowanceUsdc };
}

// ── ⭐⭐ REFUSAL REASON CODES — the structured half of "it tried, and the cap stopped it" ──────
//
// `reason` is prose for a human. `code` is the same fact as DATA: stable, enumerable, and
// aggregatable, so "how often does the day ceiling stop us?" is a filter rather than a grep over
// English that changes whenever the copy improves.
//
// ⭐ ADOPTED FROM CIRCLE'S SUBSTRATE (evaluated 2026-08-22), which is stronger than what was here:
// their DENIED is a first-class TERMINAL STATE carrying an `errorReason` enum, filterable
// (`--state denied`) and webhook-notified. We already had the record and the UI; what we lacked was
// the enum. ⚠️ We deliberately did NOT take their model wholesale — see
// [[circle-agent-wallets-vs-tikpema]]: their spending policies are mainnet-only and their budget
// reversal is undocumented. This is the one piece worth having, and it is adoptable on its own.
//
// ⚠️ ADDITIVE AND OPTIONAL. Entries written before this existed carry no `code`, and callers that
// pass none still work — a missing code means "unclassified", never "no refusal".
export const REFUSAL = {
  NO_WALLET:        "REFUSED_NO_WALLET",        // no agent wallet resolved for the caller
  PAUSED:           "REFUSED_PAUSED",           // the agent's kill switch is on
  SHAPE:            "REFUSED_SHAPE",            // the step failed validation
  PER_TX_CAP:       "REFUSED_PER_TX_CAP",       // over the per-transaction limit
  PER_BRIDGE_CAP:   "REFUSED_PER_BRIDGE_CAP",   // over the per-bridge limit
  PER_VAULT_CAP:    "REFUSED_PER_VAULT_CAP",    // over the per-vault-deposit limit
  PER_SWAP_CAP:     "REFUSED_PER_SWAP_CAP",     // over the per-swap limit
  DAY_CEILING:      "REFUSED_DAY_CEILING",      // over the rolling daily ceiling
  JOB_ALLOWANCE:    "REFUSED_JOB_ALLOWANCE",    // over the per-job data allowance
  ABSOLUTE_CEILING: "REFUSED_ABSOLUTE_CEILING", // over the absolute per-purchase ceiling
  CANNOT_VALUE:     "REFUSED_CANNOT_VALUE",     // the step could not be priced — fail-closed
  CANNOT_READ:      "REFUSED_CANNOT_READ",      // a balance or contract read failed — fail-closed
  UNCONFIRMED:      "REFUSED_UNCONFIRMED",      // submitted but not witnessed; NOT a "did not happen"
  DISCLOSURE:       "REFUSED_DISCLOSURE",       // a required disclosure gate was not satisfied
  UNKNOWN_STEP:     "REFUSED_UNKNOWN_STEP",     // unrecognised step type
};

// ── Record a REFUSED action (no spend; audit only) ────────────────────────────
// A refusal is as much a part of the record as a spend — "your agent tried to buy X and the
// cap stopped it" is exactly what the Agents page should show.
//
// 🚨 IT WRITES NO COUNTER, AND THAT IS THE POINT. A refusal spent nothing, so nothing may advance:
// `agentBreakdown` reads `allowed:false` into its `blocked` tally and never adds `amountUsdc` to
// `spentUsdc`. `amountUsdc` is carried anyway because "tried to send 30, cap is 25" is the useful
// half of the record — the number is EVIDENCE here, not a debit.
//
// ⚠️ AND THE STEP-8 SWEEPER MUST NEVER SEE IT AS AN OPEN CHARGE. `listUnresolvedCharges` selects on
// `confirmation === "submitted"`; a refusal carries no `confirmation`, so it is filtered out. That
// is load-bearing rather than incidental — pinned by an assertion in the suite, because a refusal
// mistaken for an open charge would be handed to a reverser that could credit budget for a spend
// that never happened.
export async function recordBlocked({
  jobId, amountUsdc, source, reason, code, store, at, owner, agent = AGENT.RESEARCHER,
}) {
  const s = pickStore(store);
  await appendAudit(s, {
    owner, at, agent,
    jobId,
    amountUsdc: round6(amountUsdc),
    source,
    reason,
    ...(code ? { code } : {}), // conditional: absent => unclassified, never a fabricated code
    allowed: false,
  });
  return { logged: true };
}

// ── ⭐⭐ BIND A REFUSER TO A HANDLER — one definition, N handlers ─────────────────────────────
//
// executeAction got a private `refuse()` choke point on 2026-08-22. The DIRECT-ACTION handlers
// (agent-send, agent-ub-deposit, agent-ub-spend, job-run) do NOT route through executeAction —
// they enforce their own caps and returned a bare `json(400, …)`, recording nothing. So the paths
// a user actually presses were exactly the ones with no refusal record, which is how a proof of
// the round trip failed on 2026-08-22 despite a 19/0 suite: the suite drove executeAction, and the
// Send button does not.
//
// ⭐ THE MESSAGE COMES *FROM* THE RECORDER, and that is the point. The refuser RETURNS the reason
// string, so the idiom is:
//     return json(400, { error: await refuse(REFUSAL.PER_TX_CAP, `exceeds …`), cap });
// You cannot produce the error text without going through the write. Recording is no longer a
// second step a caller can forget — it is on the only path to the value the caller needs.
//
// ⭐ `resolveOwner` IS LAZY, AND THAT IS WHY ENFORCEMENT ORDER DID NOT HAVE TO CHANGE. The audit
// trail is keyed by the AGENT WALLET address (agents.mjs reads `wallet.walletAddress`), but several
// handlers check the cap BEFORE resolving that wallet — deliberately, so an over-cap request gets
// the cap message rather than a wallet error, and so an obviously-invalid amount costs no lookup.
// Reordering to suit the logger would have changed which refusal a user sees. Instead the owner is
// resolved ONLY when a refusal actually fires.
//
// ⚠️ AN UNATTRIBUTABLE REFUSAL IS LOGGED, NOT DROPPED. If the owner cannot be resolved there is no
// per-user trail to write to — but silence would make it indistinguishable from no refusal at all.
export function makeRefuser({ owner, resolveOwner, agent = AGENT.EXECUTOR, source, store }) {
  return async (code, reason, amountUsdc = 0) => {
    try {
      const o = owner ?? (typeof resolveOwner === "function" ? await resolveOwner() : null);
      if (o) {
        await recordBlocked({ owner: o, agent, source, reason, code, amountUsdc, store });
      } else {
        console.warn("[budget][refusal-unattributed] " + JSON.stringify({
          source, code,
          note: "refused, but no owner could be resolved — enforced and NOT recorded to any trail",
        }));
      }
    } catch (err) {
      // 🚨 A FAILED RECORD MUST NEVER BECOME AN ALLOW. The refusal is already decided; this write
      // is observability. Swallowed so an audit-store hiccup cannot turn into a permitted action.
      console.warn("[budget][refusal-record-failed] " + String(err?.message ?? err).slice(0, 120));
    }
    return reason;
  };
}

// ── Read the audit trail ─────────────────────────────────────────────────────
//
// Entries now live under their own keys, so a read is a prefix list + fetch. Scoped by OWNER:
// there is no "read everyone's audit" path, because the observability surface is per-user and
// a global read would be a leak waiting to happen.
//
// `date` narrows to one UTC day (what the Agents page shows); omit it for the owner's whole
// history. `jobId` filters in-memory, as before.
export async function auditLog({ owner, date, jobId, store } = {}) {
  const s = pickStore(store);

  // Stores injected by tests may not implement list(). Nothing to enumerate ⇒ empty trail.
  if (typeof s.list !== "function") return [];

  const prefix = date
    ? `audit:${ownerKey(owner)}:${date}:`
    : `audit:${ownerKey(owner)}:`;
  const keys = await s.list(prefix);
  const entries = await Promise.all(keys.map((k) => s.getJSON(k).catch(() => null)));

  // ═══ 🚨 AN UNREADABLE ROW WAS DISAPPEARING FROM THE TRAIL WITHOUT TRACE ═════════════════════
  // `.catch(() => null)` then `.filter(Boolean)` drops a row that will not read or parse. The page
  // renders fine — it just renders a SHORTER list than the truth, and agentBreakdown derives the
  // per-agent spend TOTALS from this same call, so a dropped row silently reduces someone's
  // recorded spend. One such row was observed in ~114 on 2026-08-19.
  //
  // ⭐ SAME SHAPE AS THE LEDGER-WRITE SWALLOW, ONE LAYER LATER: the write could fail invisibly and
  // the read could drop a row invisibly, so a spend could vanish at either end with the page
  // looking normal both times. The count is KNOWABLE here and was simply discarded.
  // ⚠️ Still skipped, never thrown — one corrupt row must not blank an entire audit trail, which
  // would turn a data defect into an availability one. Skipped LOUDLY is the fix.
  const unreadable = entries.filter((e) => e === null).length;
  if (unreadable > 0) {
    console.error(
      "[budget][audit-row-unreadable] " +
        JSON.stringify({ prefix, unreadable, total: keys.length,
          note: "row(s) could not be read or parsed and are EXCLUDED from the trail and from every total derived from it (agentBreakdown). The displayed spend is lower than the recorded spend by those rows." })
    );
  }

  return entries
    .filter(Boolean)
    .filter((e) => (jobId ? e.jobId === jobId : true))
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

// The per-agent breakdown the Agents page renders: what did each agent spend today, and what
// did it try to spend and get refused? Derived from the AUDIT (the immutable record), never
// from a counter — a counter can only tell you a total, not who spent it.
export async function agentBreakdown({ owner, date, store } = {}) {
  const entries = await auditLog({ owner, date: date ?? utcDate(), store });
  const by = new Map();
  for (const e of entries) {
    const id = normalizeAgent(e.agent);
    const cur = by.get(id) ?? { agent: id, spentUsdc: 0, actions: 0, blocked: 0, reversals: 0 };
    if (e.kind === "resolution") {
      // Sweeper bookkeeping, not money — it retires a charge from the queue and says nothing about
      // spending. Skipped FIRST so it can never fall through to the allowed/blocked branches and be
      // mis-counted as an action or a refusal.
      continue;
    }
    if (e.kind === "reversal") {
      // A reversal SUBTRACTS from the total but is NOT an action — the agent did not do another
      // thing, a previous thing was undone. Counting it as an action would inflate the activity
      // count; carrying a negative amountUsdc instead (the rejected alternative) would have done
      // BOTH: inflate actions AND make the trail read as a negative "spend". Kept a positive
      // amount + an explicit kind so the record stays legible to a human.
      cur.spentUsdc = round6(cur.spentUsdc - Number(e.amountUsdc || 0));
      cur.reversals += 1;
    } else if (e.allowed) {
      cur.spentUsdc = round6(cur.spentUsdc + Number(e.amountUsdc || 0));
      cur.actions += 1;
    } else {
      cur.blocked += 1;
    }
    by.set(id, cur);
  }
  return [...by.values()];
}

// ── Free-form agent actions (Brick C): per-DAY ceiling only ───────────────────
// agent-act / execute-plan spends aren't tied to a job price, so the per-job
// allowance doesn't apply — but they DO count against the same rolling-UTC-day
// PERIOD_CEILING_USDC as research purchases (one unified daily safety cap),
// scoped PER USER by `owner` (the caller's agent wallet). Pair canSpendDay (gate)
// with recordAgentSpend (ledger) around each executed action — pass the SAME
// owner to both so the gate and the ledger read/write the one per-user bucket.
export async function canSpendDay({ amountUsdc, store, at, owner }) {
  const cfg = budgetConfig();
  const amtA = atomic(amountUsdc);
  if (amtA <= 0) return { allowed: false, reason: `amount ${amountUsdc} must be > 0` };
  const dayA = atomic(await daySpend({ owner, at, store }));
  const ceilA = atomic(cfg.PERIOD_CEILING_USDC);
  if (dayA + amtA > ceilA) {
    return {
      allowed: false,
      reason:
        `daily agent-spend ceiling: ${round6((dayA + amtA) / 1e6)} > ${cfg.PERIOD_CEILING_USDC} USDC ` +
        `(already spent ${round6(dayA / 1e6)} today ${utcDate(at)})`,
    };
  }
  return { allowed: true };
}

// `agent` defaults to EXECUTOR: every recordAgentSpend caller is a fund-moving action
// (send / swap / bridge / pay / UB-spend). Pass it explicitly anyway.
//
// ⚠️ NOTE the field this REPLACES. The old audit entry set `agent: ownerKey(owner)` — the
// WALLET ADDRESS. The field was already called `agent` and was already lying: it recorded
// WHOSE wallet, never WHICH agent. `owner` now carries the wallet; `agent` carries the actor.
// `confirmation` (OPTIONAL) — what the caller knows about the on-chain outcome AT LEDGER TIME:
// "submitted" (spend authorized + counted, chain outcome not yet verified) or "confirmed" (witnessed
// on-chain before this call). Recorded so the audit never asserts more than was observed. It is
// forwarded ONLY when present, so callers that don't pass it (transfers, pays, vault deposits, sends)
// keep byte-identical audit entries rather than gaining an `undefined` field.
//
// `circleId` (OPTIONAL) — the AUTHORITATIVE Circle transaction id this charge belongs to, so a later
// reconcile can RESOLVE the charge's real outcome (getTransaction({id})) instead of inferring it.
// ⚠️ GENERATIONAL BOUNDARY: entries written BEFORE this field existed carry no id and are therefore
// PERMANENTLY UNRESOLVABLE. A reconcile must SKIP + REPORT those — never guess an outcome for them,
// because guessing wrong reverses a charge for a spend that actually happened (a fail-OPEN error that
// widens the cap). Same conditional-forward rule as `confirmation`.
// ⚠️ NAMED `circleId`, not a generic `txId`, deliberately: it says WHICH RESOLVER applies. bridge_usdc
// carries a chain burnHash, not a Circle id — a single overloaded field would let a sweeper call the
// wrong resolver on it. Bridge adds its own field in its own pass.
// `chargeId` (OPTIONAL) — makes THIS CHARGE IDEMPOTENT. ⭐ THE MIRROR OF `reversedIds`, and it is
// deliberately the same shape: membership test and arithmetic inside ONE casUpdate mutate, so a
// concurrent or repeated charge of the same id loses the CAS race, re-reads the winner, finds its
// id already in `chargedIds`, and becomes a no-op. There is no window between "check" and "write"
// for a double-charge, exactly as GUARD 2 achieves for the reversal direction.
//
// ⚠️ WHY IT WAS NEEDED (2026-08-22): DCA now charges the day ceiling AT SUBMIT, and the same fill
// is charged again by dca-tick's reconcile when it confirms. Without idempotency that is a DOUBLE
// CHARGE of every slow fill. ⭐ The alternative — the reconcile checking a flag before calling —
// is check-then-write across two stores and races with itself; this cannot.
//
// ⚠️ OMITTING IT KEEPS THE OLD BEHAVIOUR EXACTLY. No chargeId => no membership test, no
// `chargedIds` field written, byte-identical records for every existing caller. This is not a
// migration and no record needs one: a day record with no `chargedIds` reads as an empty set.
//
// 🚨 A SUPPRESSED CHARGE MUST NOT APPEND AN AUDIT ENTRY EITHER. The counter and the trail have to
// agree — a second audit row for a charge that was not applied would make agentBreakdown report
// spending that never advanced the ceiling, and would hand the step-8 sweeper a second "open"
// charge for one transaction, which it would then resolve or reverse independently.
export async function recordAgentSpend({
  owner, amountUsdc, source, justification, store, at, agent = AGENT.EXECUTOR, confirmation, circleId,
  chargeId,
}) {
  const s = pickStore(store);
  const amt = round6(amountUsdc);
  const date = utcDate(at);

  let applied = true;

  // COMPARE-AND-SET (see casUpdate). This is the counter the daily ceiling reads, so a lost
  // update here does not just misreport — it WIDENS the cap.
  const dRec = await casUpdate(s, dayKey(owner, date), (cur) => {
    const rec = cur ?? { date, owner: ownerKey(owner), spentUsdc: 0 };
    // Defensive read — NOT a migration. Records written before this field existed have no
    // `chargedIds` and must keep working untouched.
    const charged = rec.chargedIds ?? [];
    if (chargeId && charged.includes(chargeId)) {
      applied = false;
      return rec; // no-op: this id has already been charged
    }
    applied = true;
    return {
      ...rec,
      spentUsdc: round6((rec.spentUsdc ?? 0) + amt),
      ...(chargeId ? { chargedIds: [...charged, chargeId] } : {}),
    };
  });

  // ⭐ ALREADY CHARGED IS A SUCCESS, NOT A FAILURE. The caller asked for the charge to be in place;
  // it is. Returning an error here would make dca-tick's reconcile treat a correctly-idempotent
  // re-charge as a ledger failure and STOP the mandate.
  if (!applied) return { daySpentUsdc: dRec.spentUsdc, applied: false, alreadyCharged: true };

  // ⚠️ ORDER: counter FIRST, audit SECOND — and it stays that way. A crash between them leaves a
  // charge that is COUNTED but carries no audit row, so no sweeper can reverse it: an over-count,
  // which NARROWS the cap. Appending first would invert that into a row the sweeper can reverse
  // for a charge that never landed — a credit for nothing, which WIDENS it. ⭐ Submit-time
  // ledgering makes this window the norm path rather than a rarity (design §0.5), so the choice
  // is now load-bearing: it is kept because the survivor is the safe direction, not by inheritance.
  await appendAudit(s, {
    owner, at, agent,
    amountUsdc: amt,
    source,
    justification,
    allowed: true, // authorized + counted against the ceiling — NOT a claim about the chain
    ...(confirmation ? { confirmation } : {}), // conditional: absent for callers that don't know
    ...(circleId ? { circleId } : {}), // conditional: absent => unresolvable, a reconcile must skip it
  });
  return { daySpentUsdc: dRec.spentUsdc, applied: true };
}

/**
 * ═══ 🚨 A LOST LEDGER WRITE WIDENS THE DAY CEILING — SWALLOW, BUT SHOUT ════════════════════════
 *
 * `recordAgentSpend` writes TWO things: the CAS day-counter the ceiling reads, and the audit entry.
 * A lost write does not just misreport — it WIDENS the cap.
 *
 * ⭐ THE FIX IS NOT TO STOP SWALLOWING. Letting it throw would fail the action AFTER the money has
 * moved — reporting failure for a transfer that happened, which is strictly worse than an
 * unrecorded one. The swallow is correct; the SILENCE was the defect.
 *
 * ⚠️ MOVED HERE FROM _actions.mjs ON 2026-08-21, and the move IS the point: it lived beside ONE
 * call site while `agent-send.mjs` kept the original `.catch(() => {})` — the silent form this
 * helper exists to replace. A remedy that only one caller can reach leaves the others looking fixed.
 * It belongs with the ledger it reports on, so every future ledger call site finds it by import
 * rather than by remembering that _actions.mjs has a private copy.
 *
 * ⚠️ Fire-and-forget and never awaited: an alerting failure must not compound a ledger failure.
 */
export function shoutLedgerFailure({ agent, owner, amountUsdc, source, err }) {
  const detail = {
    agent, source,
    amountUsdc: Number(amountUsdc),
    owner: String(owner ?? "").slice(0, 10) + "…",   // ⚠️ truncated: an owner address is an identity
    err: String(err?.message ?? err).slice(0, 160),
  };
  console.error(
    "[budget][ledger-write-failed] " +
      JSON.stringify({ ...detail,
        note: "the spend EXECUTED but was NOT ledgered — the day ceiling did not advance and the audit row is missing. The cap is now wider than configured by this amount until the next successful write." })
  );
  const url = process.env.DD_WATCH_WEBHOOK; // ⚠️ service-integrity channel, NOT the money siren
  if (!url) return;
  fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content:
      `🚨 **[budget]** LEDGER WRITE FAILED — the day ceiling did NOT advance\n` +
      `agent \`${detail.agent}\` · source \`${detail.source}\` · amount \`${detail.amountUsdc}\` USDC\n` +
      `The spend EXECUTED. The cap is wider than configured by this amount until the next successful ` +
      `write, and the Agents-page audit row for it is missing.\n` +
      `Error: \`${detail.err}\`` }),
  }).catch(() => {});
}

// ── REVERSE a submit-time day-ceiling charge that never confirmed (step 8) ─────────────────────
//
// 🚨 THIS IS THE ONLY FUNCTION IN THIS MODULE THAT CAN *WIDEN* A CAP. Everything else here
// over-restricts when it goes wrong — a NaN cap refuses, a lost CAS throws, an unconfirmed swap
// holds. A REVERSAL RUNS THE OTHER WAY: it credits budget back, so an over-reversal returns
// headroom the user never spent and lets them spend PAST the day ceiling. Read every guard below
// as money-safety, not hygiene, and keep the reflex: WHEN IN DOUBT, DON'T REVERSE.
//
// Takes the ORIGINAL audit entry (not loose numbers) so the amount, the id and the confirmation
// state are read from the record itself — never re-derived, never re-priced.
//
// GUARD 1 — REFUSES anything whose `confirmation` is not exactly "submitted".
//   The selection invariant lives HERE, inside the primitive, NOT only in the caller's filter. A
//   "confirmed" entry is a chain-witnessed spend; reversing one would decrement the day counter
//   while its paired mandate sub-ledger (recordDcaSpend, written in the same confirm-gated branch
//   of dca-tick) stayed put — desyncing the pair in the FAIL-OPEN direction. Enforcing it here
//   means a future sweeper bug that selected the wrong rows still CANNOT decrement a confirmed
//   fill: it is unreversible BY CONSTRUCTION.
//
// GUARD 2 — exactly-once is STRUCTURAL, not check-then-write. The id membership test and the
//   arithmetic happen INSIDE one CAS mutate(), so a concurrent second reversal of the same id
//   loses the race, re-reads the winner's record, finds its id already in `reversedIds`, and
//   becomes a no-op. There is no window between "check" and "write" for a double-credit.
//
// GUARD 3 — ZERO-CLAMP + needsAttention. A reversal must never push day-spend below zero (a
//   negative counter widens the cap outright). If it WOULD have gone negative we clamp AND raise
//   `needsAttention` on the record: that means a double-reverse or a reversal of something never
//   charged — a bug UPSTREAM. Surface it, never silently absorb it.
//
// APPEND-NEVER-NEGATE: the trail gets a NEW immutable `kind:"reversal"` entry pointing at what it
//   reverses. The original charge entry is left untouched — it is immutable by construction, and
//   erasing it would hide a real event. The charge DID happen and it WAS reversed; both are true.
//
// ⚠️ PRECONDITION FOR WHOEVER ADDS A NEW SUBMIT-TIME LEDGER: this primitive reverses the DAY
//   ledger ONLY. IF YOU ADD A PATH THAT LEDGERS AT SUBMIT *AND* WRITES A PAIRED SUB-LEDGER, THIS
//   FUNCTION MUST BE EXTENDED TO ATOMIC-PAIR SEMANTICS *BEFORE* THAT PATH SHIPS — a partial
//   reversal desyncs the two counters, and the desync direction is fail-open.
//
//   ⭐ THE RULE ABOVE IS GENERAL. It names no feature: the trigger is a SHAPE — an eager day-ceiling
//   charge plus a second counter that must move with it — and any path with that shape inherits it.
//   Do not narrow it to whichever caller prompted you to read it.
//
//   ⭐ WHY IT IS STILL SOUND — the list of submit-time chargers, re-traced 2026-08-22:
//     · manual-path swaps (_actions.mjs `swap_tokens`, confirm:false)
//     · `transfer_usdc` on the TxPendingError branch          ← added 2026-08-21 (finding A)
//     · agent-send.mjs on the TxPendingError branch           ← added 2026-08-21 (finding A)
//     · dca-tick's SwapPendingConfirm branch                  ← added 2026-08-22 (condition 1)
//   NONE of the four writes a paired sub-ledger AT SUBMIT. `recordDcaSpend` — the only sub-ledger
//   that exists — still has exactly two call sites (dca-tick.mjs), BOTH confirm-gated.
//   Re-verify this list before adding a fifth.
//
//   ⭐⭐ THE FOURTH ENTRY IS THE CASE THIS NOTE NAMED AS THE ONE THAT WOULD BREAK IT, SO READ WHY
//   IT DOES NOT. The hazard was never "DCA charges at submit" — it was a submit-time day charge
//   PAIRED WITH A SUB-LEDGER, which would make this function's day-only reversal a partial one.
//   ⭐ dca-tick charges ONLY the day ceiling at submit. `recordDcaSpend` and the mandate's
//   `spentAmount` stay confirm-gated exactly as before, so nothing is paired with the submit-time
//   charge and a day-only reversal remains COMPLETE rather than partial. The trigger is the
//   PAIRING, not the timing — and the pairing was not created.
//   ⚠️ SO THIS FUNCTION STILL DOES NOT NEED PAIR SEMANTICS, and was deliberately NOT extended.
//   The moment `recordDcaSpend` or `spentAmount` moves to submit time, it DOES — that is the
//   TRIPLE described in docs/dca-submit-time-budget-design.md §0.2, and that design stays parked
//   and unbuilt. ⚠️ Do not read "DCA already charges at submit" as evidence that the rest is safe
//   to move; the whole reason this one was safe is that the rest did not move with it.
export async function reverseAgentSpend({ entry, reason, store, at }) {
  const s = pickStore(store);

  // GUARD 1 — the refusal. Anything not explicitly a submit-time charge is untouchable.
  if (!entry || entry.confirmation !== "submitted") {
    return { reversed: false, refused: "not a submit-time charge (confirmation !== 'submitted')" };
  }
  const id = entry.circleId;
  if (!id) {
    // No authoritative id => the outcome was never resolvable => we cannot know it failed.
    return { reversed: false, refused: "no circleId — unresolvable entry, never guess an outcome" };
  }
  const amt = round6(entry.amountUsdc);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { reversed: false, refused: `unusable amount ${JSON.stringify(entry.amountUsdc)}` };
  }

  const owner = entry.owner;
  // ⚠️ THE DAY IS THE CHARGE'S, NEVER THE SWEEP'S. A charge from 23:58 swept at 00:03 must be
  // reversed against the day it LANDED in. Deriving the day from the sweep time would credit
  // today's counter for yesterday's charge — creating a phantom credit today AND leaving the real
  // charge standing yesterday. BOTH halves of that mistake are fail-open, so `at` (the sweep time)
  // must NOT participate in choosing the day key. It is recorded as `reversedAt` instead, so the
  // real reversal time is not lost.
  // The audit entry is filed in the SAME day bucket for the same reason: agentBreakdown({date})
  // sums per-day, so a reversal filed under the sweep day would leave the charge day's view
  // inflated while showing a stray negative on the sweep day.
  const date = utcDate(entry.timestamp);
  let applied = false;
  let clamped = false;

  const dRec = await casUpdate(s, dayKey(owner, date), (cur) => {
    const rec = cur ?? { date, owner: ownerKey(owner), spentUsdc: 0 };
    // Defensive read — NOT a migration. Day records written before this field existed simply
    // have no `reversedIds`, and must keep working untouched.
    const already = rec.reversedIds ?? [];

    // GUARD 2 — membership test and arithmetic in the SAME atomic mutate.
    if (already.includes(id)) {
      applied = false;
      return rec; // no-op: this id has already been reversed
    }

    // GUARD 3 — clamp at zero, and flag rather than hide.
    const raw = round6((rec.spentUsdc ?? 0) - amt);
    clamped = raw < 0;
    applied = true;
    return {
      ...rec,
      spentUsdc: clamped ? 0 : raw,
      reversedIds: [...already, id],
      ...(clamped ? { needsAttention: true } : {}),
    };
  });

  if (!applied) return { reversed: false, refused: "already reversed (id present in reversedIds)" };

  // APPEND — a new immutable entry; the original charge is never mutated.
  await appendAudit(s, {
    owner,
    at: entry.timestamp, // file it in the CHARGE's day bucket — see the note above
    dedupeKey: `reversal-${id}`, // deterministic: one reversal record per charge, ever
    agent: entry.agent,
    kind: "reversal",
    amountUsdc: amt,
    reverses: id,
    source: entry.source,
    justification: reason,
    reversedAt: isoTs(at), // when the reversal ACTUALLY ran — not lost, just not the bucket key
    allowed: true, // the REVERSAL itself is an authorized bookkeeping event
  });

  return { reversed: true, amountUsdc: amt, clamped, daySpentUsdc: dRec.spentUsdc };
}

// ── SWEEPER SUPPORT: the audit log INDEXES ITSELF ─────────────────────────────────────────────
// No separate claim store. A second store tracking "which charges are open" would be a SECOND
// SOURCE OF TRUTH that can desync from the log — re-creating the very phantom class step 8 exists
// to remove. Instead the log answers both questions: the charges are in it, and so are the markers
// that retire them.
//
// HANDLED-NESS IS READ FROM KEYS, NOT VALUES: `reversal-<id>` / `resolution-<id>` suffixes are
// deterministic, so one list() yields the retired set with zero value reads. Only genuinely open
// charges are fetched.
export async function listUnresolvedCharges({ store, at, olderThanMs = 0 } = {}) {
  const s = pickStore(store);
  if (typeof s.list !== "function") return []; // fixtures without list() ⇒ nothing to enumerate
  const keys = await s.list("audit:");

  const handled = new Set();
  const candidates = [];
  for (const k of keys) {
    const suffix = k.split(":").slice(3).join(":"); // audit:<owner>:<date>:<suffix>
    if (suffix.startsWith("reversal-")) handled.add(suffix.slice(9));
    else if (suffix.startsWith("resolution-")) handled.add(suffix.slice(11));
    else candidates.push(k);
  }

  const now = at ? new Date(at).getTime() : Date.now();
  const out = [];
  for (const k of candidates) {
    const e = await s.getJSON(k).catch(() => null);
    if (!e || e.kind) continue;                     // markers and non-charge kinds
    if (e.confirmation !== "submitted") continue;   // ⚠️ ONLY submit-time charges are ever candidates
    if (!e.circleId) continue;                      // unresolvable — never guess (see the field docs)
    if (handled.has(e.circleId)) continue;          // already reversed or resolved
    const ageMs = now - Date.parse(e.timestamp);
    if (!Number.isFinite(ageMs) || ageMs < olderThanMs) continue; // too young: a real swap may still be confirming
    out.push({ ...e, ageMs });
  }
  return out.sort((a, b) => b.ageMs - a.ageMs); // oldest first
}

// ── REVERSE BY ID — for a caller that ALREADY KNOWS the outcome (the job-swap verifier). ──────
// The verifier holds a KNOWN-FAILED swap in hand, so it needs no age guess, no Circle re-query and
// no scan: it names the charge and reverses it. This resolves the audit-keyspace lookup HERE rather
// than teaching a second file the key format ([[duplicate-source-of-truth]]).
//
// Selection is deliberately narrow: `listUnresolvedCharges({olderThanMs:0})` returns ONLY entries
// that are `confirmation:"submitted"`, carry a circleId, and are not already reversed/resolved. So a
// confirmed fill, an already-handled charge, or an id-less legacy entry is unreachable from here —
// and `reverseAgentSpend` re-checks all of that again anyway.
export async function reverseChargeById({ circleId, reason, store, at } = {}) {
  if (!circleId) return { reversed: false, refused: "no circleId" };
  const open = await listUnresolvedCharges({ store, at, olderThanMs: 0 });
  const entry = open.find((e) => e.circleId === circleId);
  if (!entry) {
    // ⚠️ A MISS IS NOT ONE THING — and the caller must not treat it as one. Distinguish:
    //   BENIGN   — a marker already exists, i.e. the backstop (or an earlier attempt) already
    //              reversed or resolved this charge. Nothing to do, nothing to flag.
    //   ANOMALOUS — no charge AND no marker: the entry we expected is missing or unreadable. NEVER
    //              guess an outcome for it (that is the absence-as-safe family, in the fail-open
    //              direction). Report it so the caller can raise needsAttention instead.
    const s = pickStore(store);
    const keys = typeof s.list === "function" ? await s.list("audit:").catch(() => []) : [];
    const handled = keys.some((k) => k.endsWith(`reversal-${circleId}`) || k.endsWith(`resolution-${circleId}`));
    return handled
      ? { reversed: false, refused: "already handled (reversed or resolved)", anomalous: false }
      : { reversed: false, refused: "no charge found for this circleId", anomalous: true };
  }

  const r = await reverseAgentSpend({ entry, reason, store, at });
  const alreadyDone = r.reversed === false && /already reversed/.test(r.refused || "");
  // Mark on success OR on "already reversed" — the latter means a previous attempt reversed but died
  // before marking; without this the charge would stay queued for the backstop forever.
  if (r.reversed || alreadyDone) {
    await markChargeResolved({ entry, outcome: "FAILED", reason, store, at });
  }
  return { ...r, marked: r.reversed || alreadyDone };
}

// RETIRE a charge from the sweeper's queue. Append-only, like everything else in this log — the
// original entry is never mutated. Deterministic key ⇒ two ticks racing produce ONE marker.
// ⚠️ This records BOOKKEEPING, never money: amountUsdc is 0 and `allowed` is false, so even a future
// consumer that forgets the `kind === "resolution"` branch cannot add spend from it.
export async function markChargeResolved({ entry, outcome, reason, store, at } = {}) {
  const s = pickStore(store);
  if (!entry?.circleId) return { marked: false, refused: "no circleId" };
  await appendAudit(s, {
    owner: entry.owner,
    at: entry.timestamp,                            // the CHARGE's day bucket (instance-5 rule)
    dedupeKey: `resolution-${entry.circleId}`,
    agent: entry.agent,
    kind: "resolution",
    resolves: entry.circleId,
    outcome,                                        // what the resolver actually observed
    justification: reason,
    amountUsdc: 0,
    allowed: false,
    observedAt: isoTs(at),                          // when the sweeper looked
  });
  return { marked: true, outcome };
}
