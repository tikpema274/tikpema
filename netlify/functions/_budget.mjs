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

const BUDGET_STORE = "data-budget";
const AUDIT_KEY = "audit:log";

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
  };
  return _defaultAdapter;
}
const pickStore = (store) => store ?? defaultStore();

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

// ── The gate: canSpend ────────────────────────────────────────────────────────
// Checks in order and returns the FIRST failing reason:
//   (a) amount ≤ per-purchase sub-cap
//   (b) job's cumulative data spend + amount ≤ job allowance
//   (c) today's cumulative autonomous spend + amount ≤ period ceiling
export async function canSpend({ jobId, jobPriceUsdc, amountUsdc, store, at, owner }) {
  const s = pickStore(store);
  const cfg = budgetConfig();

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

// ── Append-only audit trail ───────────────────────────────────────────────────
// CONCURRENCY (known limitation): appending reads the whole audit array, pushes,
// and writes it back — last-write-wins. Two concurrent appends can drop an
// entry, and likewise two concurrent recordSpend calls on the same job/day can
// race on the running total. Acceptable for this phase (testnet, low volume);
// harden later with per-entry keys or an atomic-append/compare-and-set path.
async function appendAudit(s, entry) {
  const log = (await s.getJSON(AUDIT_KEY)) ?? [];
  log.push(entry);
  await s.setJSON(AUDIT_KEY, log);
}

// ── Record an ALLOWED spend against job total + day total, and audit it ───────
export async function recordSpend({ jobId, jobPriceUsdc, amountUsdc, source, justification, store, at, owner }) {
  const s = pickStore(store);
  const amt = round6(amountUsdc);
  const allowanceUsdc = jobAllowance(jobPriceUsdc);

  // per-job running total
  const jRec = (await s.getJSON(jobKey(jobId))) ?? {
    jobId,
    jobPriceUsdc: Number(jobPriceUsdc),
    allowanceUsdc,
    spentUsdc: 0,
  };
  jRec.jobPriceUsdc = Number(jobPriceUsdc);
  jRec.allowanceUsdc = allowanceUsdc;
  jRec.spentUsdc = round6(jRec.spentUsdc + amt);
  await s.setJSON(jobKey(jobId), jRec);

  // per-day running total (rolling UTC day, keyed to THIS owner's wallet)
  const date = utcDate(at);
  const dRec = (await s.getJSON(dayKey(owner, date))) ?? { date, owner: ownerKey(owner), spentUsdc: 0 };
  dRec.spentUsdc = round6(dRec.spentUsdc + amt);
  await s.setJSON(dayKey(owner, date), dRec);

  // audit
  await appendAudit(s, {
    jobId,
    amountUsdc: amt,
    source,
    justification,
    allowed: true,
    timestamp: isoTs(at),
  });

  return { jobSpentUsdc: jRec.spentUsdc, daySpentUsdc: dRec.spentUsdc, allowanceUsdc };
}

// ── Record a REFUSED purchase (no spend; audit only) ──────────────────────────
export async function recordBlocked({ jobId, amountUsdc, source, reason, store, at }) {
  const s = pickStore(store);
  await appendAudit(s, {
    jobId,
    amountUsdc: round6(amountUsdc),
    source,
    reason,
    allowed: false,
    timestamp: isoTs(at),
  });
  return { logged: true };
}

// ── Read the audit trail (all, or filtered by job) ────────────────────────────
export async function auditLog(jobId, { store } = {}) {
  const log = (await pickStore(store).getJSON(AUDIT_KEY)) ?? [];
  return jobId ? log.filter((e) => e.jobId === jobId) : log;
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

export async function recordAgentSpend({ owner, amountUsdc, source, justification, store, at }) {
  const s = pickStore(store);
  const amt = round6(amountUsdc);
  const date = utcDate(at);
  const dRec = (await s.getJSON(dayKey(owner, date))) ?? { date, owner: ownerKey(owner), spentUsdc: 0 };
  dRec.spentUsdc = round6(dRec.spentUsdc + amt);
  await s.setJSON(dayKey(owner, date), dRec);
  await appendAudit(s, {
    agent: ownerKey(owner),
    amountUsdc: amt,
    source,
    justification,
    allowed: true,
    timestamp: isoTs(at),
  });
  return { daySpentUsdc: dRec.spentUsdc };
}
