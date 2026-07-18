# DCA scheduler — seven-property live rehearsal

The DCA money path (`3676869`) is structurally + harness verified but has **never moved funds
on-chain**. This runbook proves each safety property against a **real deploy**, step by step,
before any DCA tab ships. Run it top to bottom; a failure at any step blocks the UI.

## Why this exists

DCA is the first Tikpema path that signs a swap with **no user session** (a 3am tick). Structural
verification proved the *logic*; it cannot prove that an autonomous swap actually lands on Arc,
that a paused agent's mandate actually stays quiet, or that a failure actually records as a
failure. Only a live run does. Each property below has: **setup**, **what you run**, **what
proves it** (on-chain tx / outcome record / heartbeat), and a **pass/fail criterion**.

## Legend

- 💸 **MOVES FUNDS — you run it.** Signs a real swap / needs your wallet. Per money-path
  discipline, the operator runs these, not the agent.
- 👁 **READ-ONLY CHECK.** Reads a Blob / chain state / heartbeat. Safe for anyone to run; moves
  nothing.

## Preconditions (once, before Property 1)

1. 💸 **Deploy the money path** to the branch/site under test:
   `npm run build && netlify deploy --prod --dir=dist` (git push does not deploy — see the prod
   deploy note in memory). The `dca-tick` schedule registers from `netlify.toml`.
2. 👁 **Confirm the schedule fires.** Wait ~2 min, then read the heartbeat:
   `netlify blobs:get dca-heartbeat last`
   **Pass:** `tickAt` is within the last ~90s and advances on re-read. **Fail:** absent or stale
   → the schedule did not register; stop and fix before any property.
3. 💸 **Fund the test agent wallet** with a small amount of test USDC (Circle faucet, Arc
   Testnet) — enough for several `perTickAmount` swaps plus gas. Note the agent SCA address
   (`/api/my-wallet` under your session, or the Wallet page).
4. 👁 **Record the cap/ceiling in force** so later math is checkable:
   `netlify env:get AGENT_SWAP_CAP_USDC --context production` (unset ⇒ 25 default)
   `netlify env:get PERIOD_CEILING_USDC --context production`
   `netlify env:get DCA_CEILING_RESERVE_FRACTION --context production` (unset ⇒ 0.5)

> Mandates are created via `/api/dca-create` (session-gated). Until the UI ships, create them
> with an authenticated POST — grab a session token from the app (DevTools → the `Authorization:
> Bearer …` a wallet call sends) and `curl` the endpoints. Every create/cancel below assumes that.

---

## Property 1 — A due mandate FILLS on-chain, proven by BALANCE DELTA 💸

**Proves:** the autonomous path actually *moves tokens* with no session present — not merely that
a transaction was submitted. A tx can be sent, land, and still not do what we think; the witness
is the on-chain balance change on **both** tokens, not the SDK's word (the same
"chain-is-the-witness, not the SDK" discipline as `job-swap-receipt`).

- **Setup:** create a mandate with the **shortest cadence** (1h floor), a tiny `perTickAmount`
  (e.g. 1 USDC → EURC), `totalBudgetAmount` covering ~2–3 fills, `endAt` a few days out. A fresh
  mandate's `lastFilledPeriod` is null, so the **next tick is due immediately**.
- **Run:**
  - 👁 **BEFORE:** record the agent SCA's `balanceOf` for **both** USDC and EURC (explorer, or an
    `eth_call` to each token). Note the block/time.
  - 💸 POST `/api/dca-create`. Wait for the next minute tick.
  - 👁 **AFTER:** re-read both balances once the mandate record shows a fill.
- **Proves it (all four must hold):**
  1. 👁 Mandate record: `recentOutcomes[0].outcome == "swapped"`, `lastFillTx` set,
     `spentAmount == perTickAmount`.
  2. 👁 `lastFillTx` on the Arc explorer: a confirmed (not pending/reverted) swap tx **from the
     agent SCA**.
  3. 👁 **USDC delta:** SCA USDC decreased by ≈ `perTickAmount` (+ gas, since Arc gas is USDC) —
     i.e. `usdcBefore − usdcAfter ≥ perTickAmount`.
  4. 👁 **EURC delta:** SCA EURC **increased** by a positive amount within ~1% of the swap
     estimate (stablecoin pair, 1% slippage cap) — i.e. `eurcAfter > eurcBefore`.
- **Pass:** outcome `swapped` **AND** a confirmed tx **AND** USDC fell by ≥ perTickAmount **AND**
  EURC rose. The record and the two deltas agree.
- **Fail — any of:** no tx; a tx that reverted; USDC did not fall or EURC did not rise (the swap
  didn't move tokens); or `spentAmount` advanced with no matching on-chain delta (the record is
  lying) → **stop**; the fill path is not honest.

## Property 2 — A PAUSED agent's mandate does NOT fire 💸 (pause) + 👁 (verify)

**Proves:** the kill switch is enforced in the scheduler, before signing — not just offered in
UI (the analyst_b lesson).

- **Setup:** an active mandate that is currently due (reuse Property 1's, or create one).
- **Run:** 💸 pause the **Executor** agent for this owner (the same pause the vault/Executor
  honor — via the Agents page or the pause endpoint). Then wait for the next due tick.
- **Proves it:**
  - 👁 mandate record → newest `recentOutcomes[0].outcome == "skipped-paused"`, `spentAmount`
    unchanged, `lastFilledPeriod` NOT advanced.
  - 👁 no new on-chain swap tx after the pause timestamp.
  - 👁 heartbeat `skipped` incremented, `fired` did not.
- **Pass:** the due tick recorded `skipped-paused` and **no swap tx** exists for that period.
- **Fail:** any swap after the pause, or an outcome other than `skipped-paused` → **stop**; the
  kill switch does not reach the scheduler. (Then 💸 unpause to continue.)

## Property 3 — CANCEL stops it, next tick, no timing dependency 💸 (cancel) + 👁 (verify)

**Proves:** cancel is reclaim-class — always available, effect on the very next tick.

- **Setup:** an active mandate.
- **Run:** 💸 POST `/api/dca-cancel { id }` at an arbitrary moment (deliberately not aligned to a
  tick).
- **Proves it:**
  - 👁 mandate record → `status == "cancelled"` immediately.
  - 👁 across the next several ticks: heartbeat shows the mandate is no longer `scanned` as active;
    no new fills; no new `recentOutcomes` entries.
- **Pass:** status flips to `cancelled` with no session-timing games, and **zero** fills after.
- **Fail:** any fill after the cancel record was written → **stop**; cancel has a race.

## Property 4 — CAP is enforced on an autonomous swap; a garbled cap SKIPS, never uncaps 👁/💸

**Proves two distinct things:** (a) the `swapCapUsdc` helper actually *fires* on the autonomous
path and an over-cap swap does not execute; (b) the fail-open-cap pattern that has bitten this
repo 4× does **not** reappear here — a garbled cap env makes the tick **skip**, never silently
uncap. Both sub-tests are **mandatory**, not optional.

### 4a — over-cap tick refuses (the helper fires)

- **Setup:** get a due mandate whose fill value **exceeds** the per-swap cap in force. Because
  `dca-create` already rejects a USDC per-tick over the cap at creation (fail-closed there too),
  exercise the *scheduler's* check one of two ways: use `tokenIn: EURC` with an amount whose USDC
  value exceeds the cap, **or** temporarily lower `AGENT_SWAP_CAP_USDC` below an existing active
  mandate's per-tick (redeploy env), then let it become due.
- **Run:** wait for the due tick. 👁 also read USDC/EURC balances before and after.
- **Proves it:** 👁 outcome `skipped-capped`, `needsAttention == true`; `lastFilledPeriod` NOT
  advanced; `spentAmount` unchanged; **no swap tx**; **both balances unchanged** (no partial
  fill). The reason string names the cap the helper returned (`exceeds the N USDC cap`) — that
  string is the helper having fired with a real number.
- **Pass:** `skipped-capped`, and the chain shows the SCA moved nothing.
- **Fail:** any swap tx, or any balance delta, for an over-cap tick → **stop**; the cap is
  bypassed on the autonomous path.

### 4b — garbled cap env SKIPS, does not UNCAP (the fail-open test)

- **Setup:** temporarily set `AGENT_SWAP_CAP_USDC` to a **garbled** value (`"1O"` — digit-one,
  letter-O) and redeploy env. Keep a mandate whose per-tick is *well within* the normal cap, so
  that IF the cap fail-opened to `NaN`, the comparison `fillValue > NaN` would be `false` and the
  swap **would proceed** — making a fail-open detectable as an *unwanted fill*.
- **Run:** wait for the due tick. 👁 read balances before/after.
- **Proves it:** 👁 outcome `skipped-blocked` with reason `cap unreadable: … misconfigured`;
  **no swap tx; both balances unchanged.** A fail-open would instead show a `swapped` outcome and
  a real balance delta on a swap that should have been impossible to price against the cap.
- **Pass:** garbled cap → `skipped-blocked`, nothing moved.
- **Fail:** the tick FILLED under a garbled cap → **stop**; the fail-open-cap pattern is back.
- 👁 **Restore** `AGENT_SWAP_CAP_USDC` to its real value and redeploy before continuing.

## Property 5 — CEILING YIELD: DCA stops at its 50% share; the user can still act 💸

**Proves:** DCA consumes at most half the daily ceiling; the user's half is never
agent-consumable.

- **Setup:** choose values so DCA's half is small and reachable in 1–2 fills. Example with
  `PERIOD_CEILING_USDC = 4` and `DCA_CEILING_RESERVE_FRACTION = 0.5` → DCA share = 2 USDC/day.
  Create a mandate `perTickAmount = 1.5 USDC`, cadence 1h.
- **Run:** let it fill once (DCA daily = 1.5 ≤ 2, allowed). Wait for the next due tick (would take
  DCA to 3.0 > 2 share).
- **Proves it:**
  - 👁 second tick → `recentOutcomes[0].outcome == "skipped-ceiling"` (DCA yielded), no second
    fill, `dca-day:<owner>:<today>` == 1.5 (not 3.0).
  - 💸 **user action still works:** from your session, do a manual swap/send whose value fits the
    reserved half (≤ ceiling − DCA-share used). It must SUCCEED — proving DCA did not consume the
    user's half.
- **Pass:** DCA yields at its share AND a user action within the reserved half still executes.
- **Fail:** DCA fills past its share, or the user's action is blocked by DCA's consumption →
  **stop**; the yield rule is wrong.
- 👁 Reset for the day: the counter is per-UTC-day; either wait for UTC rollover or use a fresh
  owner wallet for later properties.

## Property 6 — IDEMPOTENCY: a double-fire fills once 👁

**Proves:** the per-period claim prevents double-spend.

- **Setup:** a due mandate.
- **Run:** 👁 invoke the scheduler **twice in quick succession** by hitting the function endpoint
  directly (`curl -s https://<site>/.netlify/functions/dca-tick`) two or more times within the
  same minute — simulating Netlify double-invoking the schedule. (Read-only in that you are not
  signing anything yourself; the *scheduler* may fill once.)
- **Proves it:**
  - 👁 exactly **one** `swapped` outcome for that period; `fill:<id>:<period>` shows a single
    `filled` record; `spentAmount` advanced by exactly one `perTickAmount`.
  - 👁 at most one on-chain swap tx for that period.
- **Pass:** N invocations in one period → exactly one fill.
- **Fail:** two fills / `spentAmount` advanced twice / two txs → **stop**; idempotency leaks.

## Property 7 — FAILURE HONESTY: a failure never looks like success, and never partially fills 💸/👁

**Proves:** a failed/skipped tick (a) records the correct non-`swapped` outcome, (b) leaves **all
spend state unchanged** (`spentAmount`, the `dca-day` counter, `lastFilledPeriod`), and (c) is
reconciled against the chain **in both directions** — the record says no-fill AND the chain shows
no-fill. The dangerous case isn't a loud failure; it's a *silent* one: spend advanced with no tx,
or a tx that landed while the record says "failed." We check for both.

- **Setup A — insufficient funds (a pre-checked SKIP, safe to force):** create a mandate whose
  `perTickAmount` **exceeds the wallet balance** (or drain the wallet after creating).
  - **Proves it (all must hold):** 👁 outcome `skipped-funds`, `needsAttention == true`, mandate
    **stays active**; `spentAmount` unchanged; `dca-day:<owner>:<today>` unchanged;
    `lastFilledPeriod` unchanged; **no swap tx from the SCA in the tick window**; **no balance
    delta**.
  - **Pass:** `skipped-funds` AND every state/chain check shows nothing moved.
- **Setup B — genuine failure stops immediately:** hard to force honestly on a stablecoin pair;
  do **not** fabricate. If a real genuine failure occurs (revert/slippage), the record must show
  `status == "stopped-failed"`, `recentOutcomes[0].outcome == "stopped-failed"` with the reason,
  and — critically — `spentAmount` unchanged and **no tx**. **Pass:** stopped with reason, nothing
  moved.
- **Setup C — transient streak (observe during a real Arc throttle):** a single throttle →
  `failed-transient (n/3, Hh)`, mandate still active, streak carried; a 3rd consecutive →
  `stopped-failed` (count); a streak whose first failure is >24h old → `stopped-failed` (window).
  A subsequent **success resets** the streak (`consecutiveFailures → 0`, `firstFailureAt → null`).
  Every non-`swapped` tick in the streak must leave `spentAmount`/`dca-day` unchanged.
- **The both-directions reconciliation (the core of this property):**
  - **Record → chain:** for every non-`swapped` outcome, confirm the SCA made **no swap tx** in
    that tick's minute window (scan the SCA's tx list on the explorer). A "failed" record with a
    real swap tx behind it is a **silent partial fill** — the worst outcome.
  - **Chain → record:** for every swap tx the SCA *did* make in the rehearsal window, confirm a
    matching `swapped` outcome + `spentAmount` increment exists. A tx with no matching record is
    spend the mandate isn't accounting for.
- **Universal fail condition:** ANY of — a non-`swapped` tick recorded `swapped`; `spentAmount` or
  `dca-day` advanced without a confirmed on-chain swap; a swap tx exists with no matching
  `swapped` record; or a `failed`/`stopped-failed` record with a real fill behind it → **stop**;
  failure honesty is broken.

---

## Sign-off

All seven pass → the money path is proven and the DCA UI may ship. Record here the tx hashes /
outcome snapshots for Properties 1–5 as the evidence trail (the same discipline as the DD engine:
a claim is checkable or it doesn't count).

| Property | Result | Evidence (tx / blob / heartbeat) | Date |
|---|---|---|---|
| 1 · fills on-chain | | | |
| 2 · pause blocks | | | |
| 3 · cancel stops | | | |
| 4 · cap enforced | | | |
| 5 · ceiling yields | | | |
| 6 · idempotent | | | |
| 7 · failure honest | | | |

**Not run yet.** Written to be executed step by step against the deploy.
