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
