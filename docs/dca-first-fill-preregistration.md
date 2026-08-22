# ⭐ PRE-REGISTRATION — the first DCA fill after un-gating

**Written 2026-08-22, BEFORE `CREATE_GATED` was flipped and before any tick ran.** Committed ahead
of the un-gate deploy so the numbers cannot be adjusted after seeing the result.

Every number below is **derived by reading the code**, not from what the change was meant to do.
Yesterday's lesson: a forecast of *21* would have looked like success and actually indicated a
broken `MAX_RESOLVES_PER_TICK`. The same trap applies here, and §3 names where.

---

## 0. Why the amount is EXACT, not approximate

For a **USDC → EURC** mandate with `perTickAmount = P`:

* `dca-tick:493` — `fillValueUsdc = m.tokenIn === "USDC" ? m.perTickAmount : valueInUsdc(...)` ⇒ **P**
* `_actions.mjs:208` — `dayValue = valueOfStep(step)` → `valueInUsdc({token:"USDC"})` →
  `_swap.mjs:67` `if (t === "USDC") return amt;` ⇒ **P**

No price lookup, no rounding, no drift. **Both charged amounts are P exactly.** A ceiling that
moves by anything other than P is a mis-valuation, not a rounding artefact.

Effective bounds read from the **deployed** production env (not code defaults):
day ceiling **60**, swap cap **25** (`AGENT_SWAP_CAP_USDC` unset → default),
DCA's daily share **30** (`DCA_CEILING_RESERVE_FRACTION` unset → 0.5).

---

## 1. 🚨 THERE ARE TWO SUBMIT OUTCOMES, AND ONLY ONE EXERCISES CONDITION (1)

`dca-tick` submits with `confirmSwap: true`, so `agentSwap` INLINE-CONFIRMS by waiting for
`waitForTx` to reach COMPLETE (deadline 60 s). Which branch runs depends on whether the swap
confirms inside that window.

### BRANCH A — inline confirm SUCCEEDS (`result.ok`) — the PRE-EXISTING path

| thing | expected | where |
|---|---|---|
| `day:<owner>:<date>.spentUsdc` | **+P** | `_actions.mjs:244` `ledger()`, fired POST-confirm |
| `dca-day:<owner>:<date>.spentUsdc` | **+P** | `dca-tick` inline branch, `recordDcaSpend` |
| `spentAmount` | **+P** | patch `m.spentAmount + m.perTickAmount` |
| audit rows for this fill | **1**, `confirmation:"confirmed"`, `circleId` present |
| `day….chargedIds` | **ABSENT** | `executeAction` passes no `chargeId` |
| `pendingPeriod` | `null` | |
| `lastOutcome` | `swapped` | |

> 🚨🚨 **A CLEAN BRANCH A IS *NOT* CONFIRMATION OF CONDITION (1).** The submit-time charge lives
> ONLY in the `SwapPendingConfirm` branch. If the fill confirms inline, **the new code never
> executes.** Arc has sub-second finality, so Branch A is the LIKELY outcome — and it would prove
> only that the old path still works. Saying this in advance is the point: a green first fill must
> not be reported as having exercised the new path.

### BRANCH B — inline confirm TIMES OUT (>60 s) — **the path that has never executed**

**At submit:**

| thing | expected | note |
|---|---|---|
| `day….spentUsdc` | **+P** | ⭐ THE NEW CHARGE |
| `day….chargedIds` | **`[circleId]`** | ⭐ NEW field |
| `dca-day….spentUsdc` | **+0** | stays confirm-gated |
| `spentAmount` | **+0** | stays confirm-gated |
| audit rows | **1**, `confirmation:"submitted"`, `circleId` present |
| `pendingPeriod` | `= period` | |
| `lastOutcome` | `pending-confirm` | |

**At the next tick's reconcile (COMPLETE):**

| thing | expected |
|---|---|
| `day….spentUsdc` | **+0** — suppressed by `chargeId` |
| `dca-day….spentUsdc` | **+P** |
| `spentAmount` | **+P** |
| audit rows | **still 1** — a suppressed charge appends none |
| `lastOutcome` | `swapped` |

**Net after reconcile: day +P, dca-day +P, spentAmount +P** — the same totals as Branch A, reached
in two steps instead of one. ⭐ That identity is the design's whole claim.

---

## 2. THE ABORT CONDITION — decided now, not in the moment

**Cancel the mandate IMMEDIATELY (do not investigate first) on any of:**

1. Any counter moving by an amount **≠ P** (its pre-registered value).
2. A fill that lands (`lastFillTx` set, or `lastOutcome: swapped`) with **zero audit rows** — money
   moved with no reversible trail.
3. `day….spentUsdc` advancing **twice for one `circleId`** — idempotency failed.
4. `dca-day` or `spentAmount` advancing **at SUBMIT** (Branch B, before confirm) — see §3.1.
5. `errors > 0` in the tick heartbeat while a fill is in flight.

Cancel is **never gated** (`dca-cancel` is reclaim-class), so this is always available. Cancelling
stops every FUTURE fill; a swap already submitted still lands — which is why the abort is about
stopping the NEXT one, not recalling this one.

---

## 3. ⭐⭐ NUMBERS THAT WOULD LOOK RIGHT AND ACTUALLY INDICATE A BUG

This is the section that matters. Each of these reads as "consistent" and is a defect.

### 3.1 Branch B, at submit: all three counters advancing together

The instinct is that three counters moving in lockstep is *more* correct. **It is the bug.**
`_budget.mjs:652`'s precondition forbids a submit-time day charge **paired with a sub-ledger**,
because `reverseAgentSpend` reverses the day ledger ONLY — a partial reversal desyncs the pair in
the **fail-open** direction. If `dca-day` or `spentAmount` moves at submit, the pairing exists and
every later reversal is silently partial. **ABORT.**

### 3.2 Net totals correct, but reached without `chargedIds` ever appearing

If Branch B runs and the day record never gains `chargedIds`, the totals can still come out right
— because the submit charge silently failed and the reconcile did the whole job. That is the OLD
behaviour wearing the new one's totals. **The discriminator is the field, not the sum.**

### 3.3 `day` unchanged across a re-reconcile

Reads as idempotency working. Equally consistent with **the reconcile never running** — exactly the
false pass caught on the draft, where a stale (eventual-consistency) read made the tick skip the
mandate. **The discriminator is `recentOutcomes`:** one entry means it never ran, two means it ran
twice. A counter that did not move proves nothing until something proves the code executed.

### 3.4 A second fill arriving before the first reconciles

Would suggest the one-action-per-mandate-per-tick rule broke — and `spentAmount`'s safety argument
rests entirely on it. Two fills in flight for one mandate means the window I claimed is closed is
open. **ABORT.**

---

## 4. What is being claimed, and what is not

Un-gating proves **Branch A** almost certainly, and **Branch B only if a fill happens to be slow**.
Branch B cannot be forced without injecting a fault, so if the first fills are all fast, condition
(1)'s own path stays unexercised in production and **must be reported that way** — not as
"un-gated and working".

---

## 5. ⭐⭐ DECIDED 2026-08-22, BEFORE ANY FILL ACCUMULATED: WE DO **NOT** INDUCE BRANCH B

The question was real: Arc confirms in 2–3 s against a 60 s deadline, so Branch B may be
effectively unreachable in normal operation — which is precisely why the defect survived months.
Ten clean Branch A fills would leave condition (1) unexercised. The repo has precedent for
inducing (`dd-watch`'s alarm was proven by an INDUCED outage, not by waiting for a real one), and
the mechanism is clean: `waitForTx(client, id, deadlineMs = DEADLINE_MS)` — the deadline is
ALREADY an injectable parameter, so no money-path constant would be edited and no env override
would be needed (the objection upheld for `DEADLINE_SAFETY_MS`).

⭐ And the induction would not even be a simulation. Branch B is DEFINED by "we stopped waiting"
— `TxPendingError` says the deadline passed and nothing about the chain. A shortened deadline
produces a GENUINE timeout on a GENUINE swap. Nothing about the money would be faked.

### 🚨 THE BLOCKER, AND IT IS DECISIVE

Inducing requires a SECOND tick invoker (a draft invoked by hand) alongside prod's `* * * * *`
scheduler. The claim guard cannot survive that:

```
// A "claimed" claim is a prior attempt that died before submit → RETRY.
// … read-before-write is adequate for ONE CRON INVOKER PER MINUTE.
```

`status === "claimed"` means **retry, not skip**. Two concurrent invokers can both read `claimed`
and both submit — **a real double-spend of real USDC.** ⭐⭐ So the induction would MANUFACTURE
the exact class of defect this entire thread exists to prevent, in order to prove a fix for a
smaller one. That trade is wrong at any price.

Making it safe means removing `dca-tick`'s schedule from **production** for the induction window:
two prod deploys (~45 min each), a period where DCA does not tick at all, and a restore whose
omission is **invisible to every provenance check** — `netlify.toml` sits outside the build
stamp's hashed surface, so a schedule-off production deploy and a schedule-on one carry an
IDENTICAL tree hash ([[netlify-draft-deploy-traps]]). That is a worse failure than the one being
proven against.

### THEREFORE, THE STANDING CLAIM — stated plainly, not accumulated quietly

> **Condition (1) is proven by suite (behavioural, mutation-tested against two mutations of the
> primitive) and by the draft proof (the reconcile path, the status guard, and `chargedIds`
> idempotency against REAL Netlify Blobs CAS). Its live submit-time branch is LEFT UNEXERCISED,
> because it cannot be reached in production without inducing it, and inducing it safely costs
> more risk than it retires.**

⚠️ Specifically still unobserved in production, ever: `agentSwap` throwing `SwapPendingConfirm`
**carrying a `circleId`**. The four July PENDING_CONFIRM records are the pre-refactor generation
and carry none, so even the historical evidence is for a different code shape.

### WHAT REPLACES THE INDUCTION

Branch B occurred **four times in July**, so it is uncommon rather than impossible. The watch is
therefore standing rather than one-shot: any fill reaching `lastOutcome: pending-confirm` is the
real thing, and §1 Branch B's table is what it must be checked against — at submit AND after the
next tick's reconcile. If it never occurs, that is reported as "never occurred", not as proven.

🚨 **AND CLEAN BRANCH A FILLS MUST NEVER BE TALLIED AS EVIDENCE FOR (1).** They exercise the
pre-existing path. Counting them would be the precise failure this document was written to
prevent: a true observation that does not support the claim it is offered for.

---

## 6. RESULT — the first fill, 2026-08-22T17:12:06Z

**Mandate** `61c2cce9-d4af-43dc-9d65-b8ea045c27ef` — USDC→EURC, `perTickAmount` 0.05,
`totalBudgetAmount` 0.15 (three fills), `cadenceMs` 3_600_000 (hourly).
**Outcome: `swapped` — "confirmed inline"** ⇒ **BRANCH A.**

| pre-registered (Branch A) | observed | |
|---|---|---|
| `day….spentUsdc` **+P** | **0.05** | ✅ |
| `dca-day….spentUsdc` **+P** | **0.05** | ✅ |
| `spentAmount` **+P** | **0.05** | ✅ |
| audit rows **1**, `confirmation:"confirmed"`, `circleId` present | 1 row, `"confirmed"`, `904ee95c…` | ✅ |
| `day….chargedIds` **ABSENT** | absent | ✅ |
| `pendingPeriod` `null` | `null` | ✅ |
| `lastOutcome` `swapped` | `swapped` | ✅ |

**All seven matched exactly. P = 0.05 with no rounding**, as §0 predicted from
`_swap.mjs:67 if (t === "USDC") return amt`. Tx `0xe0ca93c4…`, confirmed by `waitForTx` reaching
COMPLETE (Circle's authoritative state, not an RPC log-scan). No abort condition triggered;
`errors 0` on every tick. Exactly 3 keys were written to `data-budget` (213 → 216).

⭐ The audit row is `confirmation:"confirmed"`, so the step-8 sweeper correctly cannot see it —
`listUnresolvedCharges` selects only `"submitted"`. The designed behaviour, confirmed live.

### 🚨 AND THIS DOES **NOT** PROVE CONDITION (1) — as pre-registered in §1

Branch A is the **pre-existing** path: `executeAction`'s own post-confirm `ledger()` did the day
charge, and the new submit-time branch never executed. The tell is in the table above and was
named in advance: **`chargedIds` is absent.** That field is written only by the new charge. Its
absence is exactly right for Branch A — and it is also the proof that the new code did not run.

⭐ A green first fill was the LIKELY outcome and was called that way before it happened. Recording
it as "un-gated and working" would be true of the feature and false of the claim it would be
offered for. Condition (1)'s live branch remains **unexercised**, per §5.

### One correction, for the record

The first counter read reported `day` and `dca-day` as ABSENT and briefly looked like an abort
condition. That was a wrong-address lookup, not a defect: the mandate is KEYED by the user's
owner address (`0xfd801d…`) but the ledger is written under `m.walletAddress`, the agent SCA
(`0x058957…`). ⚠️ Two addresses, one record, and the wrong one reads as "nothing was charged" —
the fail-open-looking direction ([[plan-path-spender-is-caller-sca]]). The raw key listing is
what settled it, because it makes no assumption about which owner to look under.

---

## 7. PRE-REGISTERED BEFORE THE WEDGE-FIX DEPLOY (2026-08-22, ~18:55Z)

### Q1 — does the overdue fill 2 fire on the first healthy tick, or wait for the next boundary?

**On the FIRST HEALTHY TICK.** From `_dca.mjs`'s `evaluate()`:

```js
const period = periodFor(mandate, nowMs);
if (period === mandate.lastFilledPeriod) return { due: false, reason: "already filled this period" };
return { due: true, period, remaining };
```

The gate is an **inequality**, not a boundary wait. `lastFilledPeriod` is **496505**; any period that
is not 496505 is due. So whenever the first healthy tick runs — mid-period, seconds after the
deploy, whenever — it fills immediately. There is no "wait for :00".

⭐ **AND THE MISSED PERIODS ARE NOT MADE UP.** One fill per tick, no catch-up queue: the deploy
takes ~45 min, so periods 496506 (and possibly 496507) pass unfilled and are simply skipped. The
mandate still gets all **3** fills, because termination is gated on `remaining < perTickAmount` —
the BUDGET, not the clock. The schedule slips; the total does not change.

### Q2 — does the [WEDGED] alarm fire on the first post-deploy tick?

**NO — and the premise that the streak is "~40 by now" is wrong.** Measured on prod just now:
`consecutiveDeferrals` is **absent** on the mandate. The counter is written **only by the new
code**, which is not deployed — so ~52 ticks have deferred and **none were counted durably.** The
stored streak is 0, not 40. The counter ships *with* the fix; it does not pre-exist it.

Two independent reasons the alarm stays silent, either sufficient:

1. **The stored streak is 0**, so even a defer would read 1 — below `WEDGE_AFTER_DEFERS = 3`.
2. `beat.wedged++` lives **inside** the `isBlobsTransient(e)` catch. A successful tick never
   enters it, and `patchMandate` resets `consecutiveDeferrals: 0` on any real outcome. A high
   stored streak is never *read into* an alarm — it is only read to compute the next streak.

⭐⭐ **SO THE ALARM IS AN INVERTED SIGNAL HERE, AND THAT IS THE USEFUL PART: if `[WEDGED]` FIRES
AFTER THIS DEPLOY, THE FIX FAILED.** The alarm requires a defer; a post-deploy defer means the
handle is still stale. Silence is success; noise is the discriminator. It would take 3 consecutive
ticks (~3 min) to appear, counting from zero.

⚠️ A consequence worth naming rather than discovering: a wedge that **recovers** leaves no alert
trail, because the streak is only read on a defer. `lastDeferAt` on the mandate is the only
retrospective trace. Live detection is what this buys; forensics is not.

### Q3 — fill 2 is judged on the SAME table as fill 1

No new expectations. §1 Branch A, all seven values, deltas from the post-fill-1 baseline
(day 0.05, dca-day 0.05, spentAmount 0.05, 1 audit row):
day→0.10 · dca-day→0.10 · spentAmount→0.10 · audit rows→2 · `chargedIds` **ABSENT** ·
`pendingPeriod` null · `lastOutcome` swapped.

🚨 **`chargedIds` absent still means Branch A, and Branch A still means condition (1) UNEXERCISED.**
A second clean fill is a second observation of the pre-existing path, not a second piece of
evidence for the new one. Two of them are not more evidence than one.
