// _dca.mjs — DCA MANDATE MODEL. The standing authorization for autonomous, custodial swaps.
//
// ⚠️ READ THIS BEFORE TOUCHING ANYTHING HERE. A DCA mandate is unlike every other object in
// this codebase: it authorizes the server to move a user's money WHEN NO USER SESSION EXISTS
// (a swap at 3am while they sleep). Every other fund-move has a human present at signing —
// the vault ack, the Executor proposal-approve, even the x402 buy inside a user-initiated
// job. This one does not. So the mandate IS the authorization, and its bounds ARE the only
// thing standing between "capped agent" and "unbounded autonomous spender". Treat the stored
// record as a security artifact, not config.
//
// ── WHAT AUTHORIZES A FILL (the trust chain) ─────────────────────────────────────────
//   1. The mandate is created ONLY through dca-create, under a VERIFIED session (user
//      present, passkey-authenticated). `owner` is the server-verified session address,
//      NEVER client-supplied — same rule as _agent-wallets.mjs.
//   2. `walletAddress` (the dev-controlled SCA to sign from) is resolved AT CREATION via
//      ensureOwnerWallet(session) and stored, so the scheduler never has to resolve a wallet
//      without a session. The owner→wallet map is 1:1 and permanent, so this is stable.
//   3. The scheduler (dca-tick) reads the mandate fresh each tick and routes the swap through
//      executeAction — which re-checks pause + per-swap cap + day ceiling on `walletAddress`.
//
// ── THE NON-NEGOTIABLE: NEVER call agentSwap directly from the scheduler. ─────────────
// Caps in this codebase are NOT ambient (see _pause.mjs / _arc.mjs: "the caller enforces
// it"). A scheduler that called agentSwap directly would bypass the per-swap cap, the day
// ceiling, AND the kill switch in one line — the documented "swap-cap trap". The fill MUST go
// through executeAction so it inherits all three, proven and fail-closed.

import { formatUnits } from "viem";
import { CONTRACTS, USDC_DECIMALS, swapCapUsdc } from "./_arc.mjs";
import { SWAP_TOKENS } from "./_swap.mjs";
import { publicClient } from "./_predict.mjs";
import { withRetry, isTransient } from "./_retry.mjs";
import { budgetConfig, dcaDaySpend } from "./_budget.mjs";

// ═══ 🚧 CREATE IS GATED — DCA ACCEPTS NO NEW AUTHORIZATIONS (decision 2026-08-21) ════════════
//
// ⭐ WHY A CONSTANT AND NOT AN ENV VAR. Flipping this must cost a commit and a review, not a
// dashboard click — the same reasoning budget-sweep.mjs uses for staying inert ("turning it on is
// a deliberate, reviewable act"). An env toggle would also inherit the trap recorded in
// [[caps-from-deployed-env-not-code-defaults]]: an UNSET var reads as "no value" at exit 0, so the
// gate could silently be off while everything reported fine.
//
// ⚠️ WHAT THIS FIXES IS A STATE NOBODY CHOSE. #/dca was REACHABLE BUT UNLINKED — route live,
// redirects live, cron live, and nothing anywhere in src/ pointing at it (measured: every sibling
// nav-less route has a Dashboard/MyAgent quick-card; dca alone had none, while App.tsx and
// DcaPanel.tsx both CLAIMED it was "reached from the swap area"). Exposure was near zero only
// because nobody navigates there. 🚨 THAT IS THE EXACT CONFIGURATION THAT HID A 22-DAY OUTAGE IN
// THIS SAME SURFACE — nobody visits, so nobody notices anything about it, working or broken.
// This makes "unreachable" ENFORCED rather than incidental.
//
// ── ⭐⭐ THE UNBLOCK CONDITION — WITHOUT ONE, A GATE BECOMES PERMANENT BY DRIFT ───────────────
// This is a debt ratchet unless it names its own horizon, so: UN-GATE WHEN ALL FOUR HOLD.
//
//   1. FINDING A is fixed — a submitted-but-unconfirmed spend is no longer treated as "no money
//      moved". Today agent-send.mjs discards the pending txId entirely and dca-tick's
//      SwapPendingConfirm branch ledgers nothing, so an unconfirmed fill is never counted and the
//      day ceiling UNDERSTATES for every later swap — the user's own manual sends included.
//   2. FINDING B is fixed — budget-sweep (its own header: "THE PRIMARY HANDLER, NOT A BACKSTOP")
//      is running, or its role is reassigned. Measured 2026-08-21: 119 audit entries since
//      2026-07-12, 21 of them unresolved submit-time charges, ZERO reversals ever.
//   3. THE CONSENT SENTENCE MATCHES THE CODE — DcaPanel's cap/ceiling clause is corrected in the
//      same commit as (1), because fixing the ledger makes the current exception text WRONG.
//   4. ⭐⭐ AN ENTRY POINT EXISTS. UN-GATING IS NOT COMPLETE WITHOUT ONE. #/dca has NEVER had a
//      Dashboard or MyAgentPanel card — every nav-less sibling route has one. Flip this flag
//      without adding a card and the result is unlinked-by-omission WITH THE DEFECTS FIXED: a
//      surface nobody can reach, which is the exact state that hid the 22-day outage. The gate
//      would read as lifted and the reachability would not have changed at all.
//
// ⚠️ (4) IS THE ONE MOST LIKELY TO BE FORGOTTEN, AND UNTIL NOW IT WAS NOT WRITTEN WHERE THE FLIP
// HAPPENS. App.tsx and DcaPanel.tsx once FALSELY claimed the route was "reached from the swap
// area"; both were corrected, and both now carry an explicit re-link reminder. ⭐ But those are
// VIEW files, and this flag is flipped HERE — a reader can un-gate without ever opening either.
// The reminder was one file away from the only line that matters, which is the same distance as
// not existing. A condition that depends on the reader happening to open a different file is not
// a condition. Hence (4), stated in the place the decision is actually made.
//
// ⚠️ (1) and (2) are DONE as of 2026-08-22 — findings A and B are fixed and budget-sweep drained
// its 21-charge queue live (10, 10, 1 -> 0). So (3) and (4) are what actually remain, and (4) is
// the one no code path will remind anyone about.
//
// ⚠️ Findings A and B are recorded in PROGRESS.md 2026-08-21; the parked ledger design is in
// docs/dca-submit-time-budget-design.md.
//
// ── ⚠️ SCOPE — WHAT THIS GATE DELIBERATELY DOES NOT TOUCH ────────────────────────────────────
// It blocks NEW authorizations ONLY.
//   · dca-cancel  — NEVER gated. Cancel is reclaim-class: "pause/cap bind what the agent may
//     SPEND, never what the user may STOP or RECLAIM" (dca-cancel.mjs). A gate that blocked cancel
//     would trap a user inside an authorization they are trying to leave.
//   · dca-list    — NEVER gated. A user must still see what is running in order to cancel it.
//   · dca-tick    — ⭐ KEEPS FILLING an ACTIVE mandate. STATED AS A DECISION, not inherited from
//     where the gate happens to sit: an existing mandate is money the user already committed to,
//     and refusing to honour it would be the gate reaching past its purpose (and would strand a
//     schedule the user can still see but no longer have served). Zero ACTIVE mandates exist as
//     of 2026-08-21, so nothing is affected today — the rule is written for the case where one is.
export const CREATE_GATED = true;

export const MANDATE_STORE = "dca-mandates";
export const FILLS_STORE = "dca-fills";       // idempotency claims + per-fill audit
export const HEARTBEAT_STORE = "dca-heartbeat"; // unconditional proof-of-liveness

// A mandate lives at `mandate:<owner>:<id>`. Owner-prefixed so a user's mandates list cheaply
// and one user can never read/cancel another's (the cancel endpoint re-derives owner from the
// session and only touches that prefix).
export const mandateKey = (owner, id) => `mandate:${String(owner).toLowerCase()}:${id}`;
export const ownerPrefix = (owner) => `mandate:${String(owner).toLowerCase()}:`;

// Idempotency claim key. ONE fill per (mandate, period) — a double-invocation of the schedule
// finds the claim already written and skips, so it cannot double-spend. See dca-tick.
export const fillClaimKey = (id, period) => `fill:${id}:${period}`;

// Status vocabulary. `active` is the only one the scheduler acts on; the rest are terminal or
// paused-by-the-user and are skipped (and, for terminal ones, could be swept/hidden later).
export const STATUS = {
  ACTIVE: "active",
  CANCELLED: "cancelled",       // user killed it (dca-cancel) — permanent, always available
  COMPLETE: "complete",         // total budget spent
  EXPIRED: "expired",           // past endDate
  STOPPED_FAILED: "stopped-failed", // a genuine failure, or too many transient ones — see below
};

// ── PER-TICK OUTCOME — written durably every time a due mandate is acted on. The heartbeat
// proves the SCHEDULER fired; this proves what happened to each SWAP, so "is my DCA actually
// working?" is answerable and a failure never reads as a success (the withdraw-reporting rule).
export const OUTCOME = {
  SWAPPED: "swapped",                 // filled AND witnessed on-chain, tx recorded
  PENDING_CONFIRM: "pending-confirm", // submitted; awaiting the on-chain witness (budget NOT yet spent)
  SKIPPED_PAUSED: "skipped-paused",   // kill switch — normal, retry next period
  SKIPPED_CEILING: "skipped-ceiling", // yielded headroom to the user — normal, retry
  SKIPPED_CAPPED: "skipped-capped",   // per-tick now exceeds the swap cap — needs attention
  SKIPPED_FUNDS: "skipped-funds",     // wallet underfunded — needs attention, retry
  SKIPPED_BLOCKED: "skipped-blocked", // executeAction refusal / cannot value — retry, fail-closed
  FAILED_TRANSIENT: "failed-transient", // throttle/network — retry, counts toward the stop limit
  FAILED_UNCONFIRMED: "failed-unconfirmed", // submitted but the witness never confirmed within grace —
  //                                     BUDGET INTACT (no decrement). Never a phantom fill.
  STOPPED_FAILED: "stopped-failed",   // genuine failure, or N transient/unconfirmed in a row — stopped
};

// ── CONFIRMATION GATE — the budget (spentAmount) advances ONLY when the on-chain witness confirms
// a fill landed; a submit alone never spends it. These bound how long we wait and how many blind
// submits we tolerate before pulling in a human. ─────────────────────────────────────────────────
//
// A submitted fill has this long to be witnessed on-chain before it is declared unconfirmed. It is
// deliberately larger than the ~5s async lag observed on a real fill AND spans more than one
// reconcile tick (the scheduler runs every 60s), so a healthy-but-slow tx gets multiple chances to
// be seen; short enough that any over-buy is tightly bounded when paired with the stop below.
export const CONFIRM_GRACE_MS = 2 * 60 * 1000; // 120s

// N submitted-but-never-witnessed fills IN A ROW stops the mandate. This bounds the worst case —
// a swap that actually landed but we could not confirm, so spentAmount never advanced and the
// mandate keeps buying — to at most N ticks before it halts and flags for a human.
export const MAX_CONSECUTIVE_UNCONFIRMED = 3;

// ── TICK BOUNDING — cap the slow, throttle-prone on-chain work per invocation so the request-scoped
// Netlify Blobs token (injected per-invocation, short-lived) is far less likely to age out between
// acquisition and the reconcile WRITE. Belt to dca-tick's braces: when the token DOES expire, the
// write is caught as Blobs-transient and DEFERS to the next tick rather than freezing the mandate.
export const CONFIRM_RPC_TIMEOUT_MS = 6 * 1000;   // hard cap on ONE confirmSwapLanded call
export const MAX_RECONCILES_PER_TICK = 1;         // chain-witnessing reconciles per invocation; rest defer
// A fill pending this long with NO usable witness (persistent throttle/timeouts — we keep being
// unable to LOOK, which is not the same as "did not land") escalates to failed-unconfirmed +
// needsAttention: budget intact, a human looks. So an un-witnessable fill can never sit pending
// forever. Well above CONFIRM_GRACE_MS so a healthy-but-slow tx is never prematurely failed.
export const MAX_PENDING_AGE_MS = 60 * 60 * 1000; // 1h

// Upper bound on the reconcile log-scan window: toBlock = min(snapshotBlock + this, head). A swap
// lands within seconds of submit (~10 blocks observed for fill 495663: snapshot 52457045 -> tx
// 52457055), so a 500-block window (~4 min at ~0.5s/block, well past the 120s CONFIRM_GRACE_MS)
// always contains a landed fill with margin. DEFENCE-IN-DEPTH against Arc's 10,000-block eth_getLogs
// cap (-32614) — NOT a correctness fix: a DCA fill ages out at MAX_PENDING_AGE_MS (~7,200 blocks)
// BEFORE an unbounded snapshotBlock->latest scan could reach 10k (~83 min), so the cap is never
// actually hit today; the bound guards a faster block time or a raised age-out. (fb7adf9's message
// overclaimed this as fixing a live "aged fills permanently unconfirmable" bug — corrected here.) It
// does NOT fix the throttle either: that is a request-RATE limit (see WITNESS_RPC_URL, Part B), not
// query size. 500 is well under 10,000. Only dca-tick passes this; the research->swap job-verifier
// omits it (keeps toBlock:"latest" over its own <=10,000 lookback), so its behaviour is unchanged.
export const SCAN_WINDOW_BLOCKS = 500;

// A single Arc throttle must not kill a healthy mandate; N transient failures IN A ROW must not
// be invisible. On the Nth consecutive transient failure the mandate STOPS (stopped-failed) so a
// persistently-broken DCA doesn't silently pretend to run forever. A genuine failure stops on the
// FIRST occurrence.
export const MAX_CONSECUTIVE_FAILURES = 3;

// Fraction of the daily ceiling RESERVED FOR THE USER — the agent's autonomous DCA may never
// consume it. So a 3am tick can never lock the user out of their own money: they always retain
// at least `ceiling × reserve` for their own swaps/sends. Fail-closed: garbled or outside (0,1)
// → 0.5, and any error direction reserves MORE for the user, never less.
export function userReserveFraction() {
  const n = Number(process.env.DCA_CEILING_RESERVE_FRACTION);
  if (!Number.isFinite(n) || n <= 0 || n >= 1) return 0.5;
  return n;
}

const TOKENS = SWAP_TOKENS.map((t) => t.toUpperCase()); // ["USDC","EURC"]

// A cadence floor. The cron fires every minute, but a mandate must not; this is the smallest
// interval a user may configure, so a fat-fingered "every minute" can't drain a budget in an
// hour. 1h on testnet is already aggressive for DCA; raise for prod.
export const MIN_CADENCE_MS = 60 * 60 * 1000; // 1 hour

// ── BOUND VALIDATION — FAIL-CLOSED, at CREATION. ─────────────────────────────────────
// A mandate that cannot pass these is REJECTED, never clamped — the same discipline as the
// caps in _arc.mjs. Rejecting at creation means the scheduler never has to reason about a
// malformed mandate: anything in the store is already within bounds (except the global caps,
// which are re-checked live at fill time because env can change under a live mandate).
//
// Returns { ok: true, mandate } or { ok: false, error } — a plain, user-facing reason.
export function validateAndBuildMandate({ owner, walletAddress, input, now }) {
  if (!owner) return { ok: false, error: "no verified owner" };
  if (!walletAddress) return { ok: false, error: "no agent wallet resolved" };

  const tokenIn = String(input?.tokenIn || "").toUpperCase();
  const tokenOut = String(input?.tokenOut || "").toUpperCase();
  // EURC↔USDC only — the only pair Arc testnet swaps (SWAP_TOKENS). Reject anything else
  // rather than let a mandate reference a pair that can never fill.
  if (!TOKENS.includes(tokenIn) || !TOKENS.includes(tokenOut) || tokenIn === tokenOut) {
    return { ok: false, error: `pair must be two distinct tokens from ${TOKENS.join("/")}` };
  }

  const perTickAmount = Number(input?.perTickAmount);
  if (!Number.isFinite(perTickAmount) || perTickAmount <= 0) {
    return { ok: false, error: "per-swap amount must be a positive number" };
  }
  // Per-tick must sit within the SAME per-swap cap a manual swap obeys. This is a create-time
  // convenience check; executeAction re-enforces swapCapUsdc live at every fill, so a later
  // cap change is still honoured. (tokenIn may be EURC; the cap is USDC-equivalent, so this
  // create-time check is approximate for EURC and the live check at fill time is authoritative.)
  const cap = swapCapUsdc();
  if (tokenIn === "USDC" && perTickAmount > cap) {
    return { ok: false, error: `per-swap amount ${perTickAmount} exceeds the per-swap limit of ${cap} USDC` };
  }

  const cadenceMs = Number(input?.cadenceMs);
  if (!Number.isFinite(cadenceMs) || cadenceMs < MIN_CADENCE_MS) {
    return { ok: false, error: `frequency must be at least ${MIN_CADENCE_MS / 3600000}h between swaps` };
  }

  const totalBudgetAmount = Number(input?.totalBudgetAmount);
  if (!Number.isFinite(totalBudgetAmount) || totalBudgetAmount < perTickAmount) {
    return { ok: false, error: "total budget must be at least one swap's amount" };
  }

  const endAt = Number(input?.endAt); // epoch ms
  if (!Number.isFinite(endAt) || endAt <= now) {
    return { ok: false, error: "end date must be in the future" };
  }

  const id = input?.id; // caller supplies a collision-free id (uuid) — kept simple, no Date/random here
  if (!id || typeof id !== "string") return { ok: false, error: "missing mandate id" };

  return {
    ok: true,
    mandate: {
      id,
      owner: String(owner).toLowerCase(),
      walletAddress,               // the SCA to sign from — resolved under session, stored now
      tokenIn,
      tokenOut,
      perTickAmount,
      cadenceMs,
      totalBudgetAmount,
      spentAmount: 0,                // running total; each fill decrements the remaining budget
      endAt,
      status: STATUS.ACTIVE,
      createdAt: now,
      lastFilledPeriod: null,      // idempotency + "already filled this period?" check
      lastFillAt: null,
      lastFillTx: null,
      lastSkip: null,              // why the most recent due tick did NOT swap (for the UI)
    },
  };
}

// The period bucket for idempotency: aligned to the mandate's cadence. Two ticks inside the
// same bucket compute the same period, so the fill-claim dedupes them. A fill is DUE when the
// current period differs from the last one we filled.
export function periodFor(mandate, nowMs) {
  return Math.floor(nowMs / mandate.cadenceMs);
}

// Is this mandate due to fill right now, on bounds we own here (NOT the global caps/pause —
// those are executeAction's, checked live at fill time)? Returns a decision the scheduler acts
// on: { due } or { due:false } with a terminal transition, or a skip reason.
export function evaluate(mandate, nowMs) {
  if (mandate.status !== STATUS.ACTIVE) return { due: false, reason: `not active (${mandate.status})` };
  if (nowMs >= mandate.endAt) return { due: false, terminal: STATUS.EXPIRED, reason: "reached end date" };
  const remaining = mandate.totalBudgetAmount - mandate.spentAmount;
  // Terminal when the remaining budget can't fund another full tick. Reject, never partial-fill.
  if (remaining + 1e-9 < mandate.perTickAmount) {
    return { due: false, terminal: STATUS.COMPLETE, reason: "total budget spent" };
  }
  const period = periodFor(mandate, nowMs);
  if (period === mandate.lastFilledPeriod) return { due: false, reason: "already filled this period" };
  return { due: true, period, remaining };
}

// ── YIELD TO THE USER — DCA gets at most HALF the daily ceiling; the other half is always the
// user's. ────────────────────────────────────────────────────────────────────────────────────
// DCA and the user's own manual swaps/sends share ONE per-user daily ceiling. The rule is simple
// and predictable: DCA may consume at most `ceiling × (1 − reserve)` (reserve default 0.5 → 50%),
// measured against DCA'S OWN cumulative daily spend (dcaDaySpend, the parallel per-owner counter).
// A tick that would push DCA's daily total over its half SKIPS (skipped-ceiling), regardless of
// how much headroom the FULL ceiling still has — so the user's half is never consumable by the
// agent and they can never be locked out of their own money. This is the soft, user-protective
// gate; executeAction's hard `canSpendDay` (DCA + everything ≤ full ceiling) is the backstop
// beneath it.
//
// Measuring DCA's OWN share (not total spend) is deliberate: the user's manual spending does not
// shrink DCA's allowance, and DCA's spending does not shrink the user's — they are two halves.
// `fillValueUsdc` is priced by the caller. Fail-closed: an unreadable DCA total refuses the fill.
export async function yieldsToUser({ owner, fillValueUsdc, store, at }) {
  const reserve = userReserveFraction();
  const ceiling = Number(budgetConfig().PERIOD_CEILING_USDC); // garbled env → conservative 2.0 (restricts)
  const dcaShare = ceiling * (1 - reserve);
  const dcaToday = Number(await dcaDaySpend({ owner, store, at }));
  if (!Number.isFinite(dcaToday) || !Number.isFinite(fillValueUsdc)) {
    return { ok: false, reason: "cannot read DCA's daily spend or value the fill — refusing (fail-closed)" };
  }
  if (dcaToday + fillValueUsdc > dcaShare + 1e-9) {
    return {
      ok: false,
      reason: `yields to you: DCA's daily share is ${Math.round(dcaShare * 100) / 100} of ${ceiling} USDC (${Math.round((ceiling - dcaShare) * 100) / 100} stays reserved for your own actions); already used ${Math.round(dcaToday * 100) / 100} today`,
    };
  }
  return { ok: true };
}

// The failure window: how long a streak of transient failures may span before the mandate stops,
// even if it hasn't hit MAX_CONSECUTIVE_FAILURES. A daily-cadence mandate that fails once a day
// would take 3 days to hit the count; this stops it after one day of not working. Whichever
// trigger comes first stops it.
export const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

// Classify a THROWN fill error into skip-vs-stop, REUSING the shared isTransient from _retry.mjs
// (the exact classifier the deposit-throttle fix uses — NOT a new one). transient (throttle /
// network) → retryable; genuine (anything isTransient does not recognise, incl. slippage) → stop.
export function classifyFillError(err) {
  return isTransient(err) ? "transient" : "genuine";
}

// Live token balance for the funds pre-check, so an underfunded wallet is a SKIP (retryable —
// the wallet may get funded), never a "genuine failure" that stops a healthy mandate. Wrapped in
// withRetry so a throttle on THIS read is transient too, not a false funds-fail. USDC and EURC are
// both 6-dp on Arc. Mirrors job-swap-approve's reader; kept here so the scheduler owns its reads.
const BALANCE_OF_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
];
export async function readTokenBalance(token, wallet) {
  const address = String(token).toUpperCase() === "EURC" ? CONTRACTS.EURC : CONTRACTS.USDC;
  return withRetry(
    async () => {
      const raw = await publicClient().readContract({ address, abi: BALANCE_OF_ABI, functionName: "balanceOf", args: [wallet] });
      return Number(formatUnits(raw, USDC_DECIMALS));
    },
    { label: `read ${token} balance` }
  );
}
