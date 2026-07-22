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
// runtime. Callers inside a classic-Lambda handler must connectLambda(event)
// before the Netlify-backed default is used.

import { getStore } from "@netlify/blobs";
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
let _defaultAdapter = null;
function defaultStore() {
  if (_defaultAdapter) return _defaultAdapter;
  const s = getStore(BUDGET_STORE);
  _defaultAdapter = {
    async getJSON(key) {
      return (await s.get(key, { type: "json" })) ?? null;
    },
    async setJSON(key, value) {
      await s.setJSON(key, value);
    },
    // Returns { value, etag }. etag is undefined when the key does not exist yet.
    async getWithEtag(key) {
      const res = await s.getWithMetadata(key, { type: "json" }).catch(() => null);
      return { value: res?.data ?? null, etag: res?.etag };
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
    const { value, etag } = await s.getWithEtag(key);
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

async function appendAudit(s, { owner, at, ...entry }) {
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

// ── Record a REFUSED purchase (no spend; audit only) ──────────────────────────
// A refusal is as much a part of the record as a spend — "your agent tried to buy X and the
// cap stopped it" is exactly what the Agents page should show.
export async function recordBlocked({
  jobId, amountUsdc, source, reason, store, at, owner, agent = AGENT.RESEARCHER,
}) {
  const s = pickStore(store);
  await appendAudit(s, {
    owner, at, agent,
    jobId,
    amountUsdc: round6(amountUsdc),
    source,
    reason,
    allowed: false,
  });
  return { logged: true };
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
    const cur = by.get(id) ?? { agent: id, spentUsdc: 0, actions: 0, blocked: 0 };
    if (e.allowed) {
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
export async function recordAgentSpend({
  owner, amountUsdc, source, justification, store, at, agent = AGENT.EXECUTOR, confirmation,
}) {
  const s = pickStore(store);
  const amt = round6(amountUsdc);
  const date = utcDate(at);

  // COMPARE-AND-SET (see casUpdate). This is the counter the daily ceiling reads, so a lost
  // update here does not just misreport — it WIDENS the cap.
  const dRec = await casUpdate(s, dayKey(owner, date), (cur) => {
    const rec = cur ?? { date, owner: ownerKey(owner), spentUsdc: 0 };
    return { ...rec, spentUsdc: round6((rec.spentUsdc ?? 0) + amt) };
  });

  await appendAudit(s, {
    owner, at, agent,
    amountUsdc: amt,
    source,
    justification,
    allowed: true, // authorized + counted against the ceiling — NOT a claim about the chain
    ...(confirmation ? { confirmation } : {}), // conditional: absent for callers that don't know
  });
  return { daySpentUsdc: dRec.spentUsdc };
}
