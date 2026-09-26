// limits.mjs — the vault mandate's OWN caps: pure code constants, no env, no imports.
//
// ═══ R1 (T, 2026-09-26): THE CAP LIVES OFF THE DD SURFACE ═══════════════════════════════════════
// Nothing here may sit under DD_SURFACE_DIRS / DD_SURFACE_FILES (scripts/stamp-build.mjs): ddTree is a
// CONTENT hash, so a cap edited there would rotate it and open a deposit-refusal window. And NO ENV VAR:
// reading one would pull in _arc.mjs / _env-assert.mjs (both on the surface). Changing a value below
// costs a commit and a review, never a dashboard click. test:mandatedeposit asserts all three.
//
// The deployed caps these sit UNDER are read, never edited: `vaultDepositCapUsdc()` (25, _arc.mjs),
// `PERIOD_CEILING_USDC` (60), `DCA_CEILING_RESERVE_FRACTION` (0.5) — measured 2026-09-26 with
// `netlify env:get --context production`. executeAction re-enforces its own caps on every deposit.
//
// ═══ THE VALUES (T decided 2026-09-26; the reasoning is in PROGRESS, "PIECE 4") ═════════════════

/** One deposit. Below the 25 vault cap and ≤ ⅔ of the mandate's 15/day, so one deposit never exhausts its share. */
export const MANDATE_DEPOSIT_MAX_USDC = 10;
/** The whole mandate. Bounded while unproven: xylo's single-EOA owner holds emergencyWithdraw. */
export const MANDATE_TOTAL_MAX_USDC = 100;
/** The mandate's OWN day share of the daily ceiling (15 of 60 today), so it cannot starve DCA. */
export const MANDATE_DAY_SHARE = 0.25;
/**
 * Mandate + DCA TOGETHER (30 of 60 today). The user's reserve applies to ALL autonomous spend combined:
 * DCA and a mandate each taking half would lock the user out. The effective share is the SMALLER of this
 * and (1 − DCA's user reserve), so a reserve raised in env narrows it and one lowered never widens it.
 */
export const MANDATE_AUTONOMOUS_MAX_SHARE = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Each deposit costs a signed check; nothing about a deposit schedule needs sub-daily. */
export const MANDATE_MIN_CADENCE_MS = DAY_MS;
export const CADENCE_MS = Object.freeze({ daily: DAY_MS, weekly: 7 * DAY_MS });
export const DEFAULT_CADENCE = "weekly";

/**
 * ⛔ Decision 2 (T): creation REFUSES exit rules until piece 5 ships. The disclosure must not say
 * "if found: exit." while nothing can exit. Checked at creation and amendment (record.mjs); the executor
 * treats an EXIT decision as a pause regardless. Flipped in piece 5's own commit, with its copy.
 */
export const EXIT_AVAILABLE = false;

// ── USDC in micro-units, so no comparison ever drifts (0.1 + 0.2 ≠ 0.3 in floats) ─────────────
const micro = (usdc) => Math.round(Number(usdc) * 1e6);
const fromMicro = (m) => m / 1e6;
const isExact6dp = (n) => Math.abs(n * 1e6 - Math.round(n * 1e6)) < 1e-6;

/**
 * The deposit terms a user may set. Nothing is guessed except the cadence, whose default (weekly) is
 * STORED explicitly so the record and its disclosure state it.
 * @returns {{ok:true, terms:{amountPerDepositUsdc, maxTotalUsdc, cadence}} | {ok:false, errors:string[]}}
 */
export function validateMandateTerms(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["no deposit terms"] };
  const { amountPerDepositUsdc: a, maxTotalUsdc: t } = input;
  const cadence = input.cadence === undefined ? DEFAULT_CADENCE : input.cadence;
  const errors = [];
  if (typeof a !== "number" || !Number.isFinite(a) || a <= 0) errors.push("amountPerDepositUsdc must be a positive number of USDC");
  else if (!isExact6dp(a)) errors.push("amountPerDepositUsdc has more than 6 decimals; USDC cannot represent it");
  else if (micro(a) > micro(MANDATE_DEPOSIT_MAX_USDC)) errors.push(`amountPerDepositUsdc is above the mandate's per-deposit limit of ${MANDATE_DEPOSIT_MAX_USDC} USDC`);
  if (t === undefined || t === null) errors.push("maxTotalUsdc is required: a mandate states the most it will ever deposit");
  else if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) errors.push("maxTotalUsdc must be a positive number of USDC");
  else if (!isExact6dp(t)) errors.push("maxTotalUsdc has more than 6 decimals");
  else if (micro(t) > micro(MANDATE_TOTAL_MAX_USDC)) errors.push(`maxTotalUsdc is above the mandate limit of ${MANDATE_TOTAL_MAX_USDC} USDC`);
  else if (typeof a === "number" && Number.isFinite(a) && micro(t) < micro(a)) errors.push("maxTotalUsdc must allow at least one deposit");
  if (!Object.prototype.hasOwnProperty.call(CADENCE_MS, cadence)) errors.push(`cadence must be one of ${Object.keys(CADENCE_MS).join(", ")}`);
  if (errors.length) return { ok: false, errors };
  return { ok: true, terms: { amountPerDepositUsdc: a, maxTotalUsdc: t, cadence } };
}

/**
 * Is there room today for `amountUsdc` more of mandate deposits? Two shares, both measured on the
 * autonomous sub-counters (never on the user's own spending):
 *   mandateToday + amount            ≤ MANDATE_DAY_SHARE × ceiling
 *   mandateToday + dcaToday + amount ≤ min(MANDATE_AUTONOMOUS_MAX_SHARE, 1 − reserve) × ceiling
 * Any unreadable input → no room (fail-closed). The hard canSpendDay (all spend ≤ ceiling) is separate.
 */
export function mandateDayRoom({ ceilingUsdc, userReserveFraction, mandateTodayUsdc, dcaTodayUsdc, amountUsdc }) {
  const nums = [ceilingUsdc, userReserveFraction, mandateTodayUsdc, dcaTodayUsdc, amountUsdc].map(Number);
  if (!nums.every(Number.isFinite) || [ceilingUsdc, userReserveFraction, mandateTodayUsdc, dcaTodayUsdc, amountUsdc].some((v) => v === null || v === undefined)) {
    return { ok: false, reason: "a daily limit or counter could not be read, so there is no known room (refusing)" };
  }
  const [ceil, reserve, mine, dca, amt] = nums;
  const own = micro(ceil * MANDATE_DAY_SHARE);
  const combinedShare = Math.min(MANDATE_AUTONOMOUS_MAX_SHARE, 1 - reserve);
  const combined = micro(ceil * Math.max(0, combinedShare));
  if (micro(mine) + micro(amt) > own) {
    return { ok: false, reason: `the mandate's daily share is ${fromMicro(own)} of ${ceil} USDC; already deposited ${fromMicro(micro(mine))} today`, own: fromMicro(own), combined: fromMicro(combined) };
  }
  if (micro(mine) + micro(dca) + micro(amt) > combined) {
    return { ok: false, reason: `autonomous spend (mandates + DCA) may use ${fromMicro(combined)} of ${ceil} USDC a day; ${fromMicro(micro(mine) + micro(dca))} already used — the rest stays yours`, own: fromMicro(own), combined: fromMicro(combined) };
  }
  return { ok: true, own: fromMicro(own), combined: fromMicro(combined) };
}

/** min(record amount, MANDATE_DEPOSIT_MAX_USDC, the deployed vault cap, the budget remaining). Unreadable → 0. */
export function effectiveDepositUsdc({ recordAmountUsdc, vaultCapUsdc, remainingUsdc }) {
  const vals = [recordAmountUsdc, MANDATE_DEPOSIT_MAX_USDC, vaultCapUsdc, remainingUsdc].map(Number);
  if (!vals.every(Number.isFinite)) return 0;
  return fromMicro(Math.max(0, Math.min(...vals.map(micro))));
}
