# DCA submit-time budget + atomic-pair reversal — DESIGN ONLY, **PARKED 2026-08-21**

> ## ⭐⭐ PARTIALLY UNPARKED 2026-08-22 — READ THIS BEFORE THE PARK NOTICE BELOW
>
> **What shipped:** dca-tick's `SwapPendingConfirm` branch now charges **the day ceiling only** at
> submit, idempotently (`chargeId`, the `reversedIds` mirror from §1.1), with the reversal runner
> from §1.4 (`reverseChargeById` on a witnessed terminal failure) and §2(a) (reconcile above the
> ACTIVE gate). Unblock condition (1) at `_dca.mjs`'s `CREATE_GATED` is met.
>
> **🚨 WHAT DID *NOT* SHIP, AND MUST NOT BE ASSUMED:** the **TRIPLE** (§0.2). `recordDcaSpend` and
> the mandate's `spentAmount` remain **confirm-gated**, and `reverseAgentSpend` was **NOT** extended
> to pair semantics. ⭐ That is the whole reason the change was safe: `_budget.mjs:652`'s
> precondition is triggered by a submit-time day charge **PAIRED WITH A SUB-LEDGER** — the pairing,
> not the timing. No pairing was created, so a day-only reversal stays COMPLETE rather than partial.
> **The moment either of the other two counters moves to submit time, §0–§1 apply in full and
> `reverseAgentSpend` must gain triple semantics FIRST.**
>
> **Known residual, stated rather than discovered later:** `dca-day:` is per-OWNER, so a second
> ACTIVE mandate of the same owner can fill while this one is pending and `yieldsToUser` will read
> a briefly understated DCA half. Narrower than the day-ceiling gap that was closed, same direction.
> `spentAmount` is *not* exposed — the tick takes one action per mandate per tick, so a mandate with
> a `pendingPeriod` cannot fill again before reconcile.
>
> ⚠️ **§0.5 was considered and deliberately NOT "fixed".** `recordAgentSpend` still does
> `casUpdate(dayKey)` **then** `appendAudit`, and submit-time ledgering does make that window the
> norm path as the section says. But the survivor of a crash between them is a charge that is
> **counted and unreversible** — an over-count, which NARROWS the cap. Appending first would invert
> it into a reversible row for a charge that never landed: a credit for nothing, which WIDENS it.
> ⭐ The order is now load-bearing rather than inherited, and is documented at the call site.
>
> §3-C (collapse the triple to one authoritative record) remains the recorded end state.


> 🅿️ **PARKED BEFORE ANY CODE WAS WRITTEN — and the reason is worth more than the design.**
> The three-step plan below (extend `reverseAgentSpend` → flip DCA to decrement-at-submit → close
> the reversal gap) would begin by modifying **the one function in `_budget.mjs` that can WIDEN a
> cap**, in service of a path with **zero ACTIVE mandates**. That trade is wrong at this moment:
> real risk taken on the money path's most dangerous primitive, to remove latent risk from a
> feature nobody is currently using.
>
> ⚠️ **THE PARK RESTS ON "IDLE", NOT ON "UNREACHABLE".** DCA **is** wired — `netlify.toml:70/75/80`
> route `/api/dca-create|cancel|list`, `App.tsx:84` mounts `DcaPanel`, and `dca-tick` is scheduled
> `* * * * *`. One user action creates a mandate and the measured-false rule in §1.4 is live again.
> ⭐ Do not let this file be read later as "DCA was dead" — that exact conflation already cost this
> project 22 days ([[dca-agentswap-refactor-state]]).
>
> **UNPARK WHEN:** a mandate is created, or DCA is promoted from idle. **Read §0 first** — the
> atomicity analysis is the durable part and does not expire.

**Status at time of writing (`3f5222a`): no code exists for any of this.** Verified, not assumed —
`dca-tick.mjs:498`'s `SwapPendingConfirm` branch still ledgers nothing, `recordDcaSpend` still has
exactly two call sites (`dca-tick.mjs:248`, `:469`), both confirm-gated, and `reverseAgentSpend`
still touches the day ledger only.

**Why this file exists — and it is the finding, not preamble.**

⭐⭐⭐ **THIS DEFECT WAS CAUGHT BEFORE SHIPPING ONLY BECAUSE SOMEONE LEFT A WRITTEN PRECONDITION IN
`_budget.mjs`.** The plan was "adopt step 8's existing pattern rather than invent one" — correct
about the pattern, and it would have shipped a fail-open desync, because step 8's pattern was built
for a case with **no paired sub-ledger** and its author said so in the file:

> ⚠️ **PRECONDITION FOR WHOEVER ADDS A NEW SUBMIT-TIME LEDGER**: this primitive reverses the DAY
> ledger ONLY, which is sound TODAY because the only submit-time charges are manual-path swaps, and
> those never write a paired sub-ledger (`recordDcaSpend` has exactly two call sites, both
> confirm-gated — traced 2026-07-22). **IF YOU ADD A PATH THAT LEDGERS AT SUBMIT *AND* WRITES A
> PAIRED SUB-LEDGER, THIS FUNCTION MUST BE EXTENDED TO ATOMIC-PAIR SEMANTICS *BEFORE* THAT PATH
> SHIPS** — a partial reversal desyncs the two counters, and the desync direction is fail-open.
> — `_budget.mjs:652`

⭐ **Skipping the brief would be taking the benefit of that convention without paying it forward —
on the one function in the module that can WIDEN a cap.** The precondition worked because it was
written down at the site of the danger, by someone who would not be in the room later. This file is
the same debt, paid to whoever comes next.

**Provenance and its limit.** Every code fact below was read from the tree at `3f5222a` and every
store fact was read from live production blobs. Nothing here has been validated by implementation —
where a claim depends on behaviour under crash or contention, treat it as a hypothesis to test.

---

# 0. ⭐⭐ WHAT "ATOMIC" CAN MEAN HERE — settle this before designing to the word

The precondition says "atomic-pair semantics." **The word invites assuming a guarantee that is not
available on this platform.** Before designing to it, two things had to be measured.

## 0.1 The store topology, measured

| counter | key | store |
|---|---|---|
| day ceiling | `day:<owner>:<date>` | `data-budget` |
| DCA daily share | `dca-day:<owner>:<date>` | `data-budget` |
| audit trail / reversal markers | `audit:<owner>:<date>:<suffix>` | `data-budget` |
| **mandate budget** (`spentAmount`) | `mandate:<owner>:<id>` | **`dca-mandates`** |
| fill claim (the journal) | `fill:<id>:<period>` | **`dca-fills`** |

⚠️ **CORRECTION TO THE FRAMING THAT PROMPTED THIS SECTION.** The two *budget* counters do **not**
live in different stores — `day:` and `dca-day:` are both in `data-budget`, at different keys
(confirmed in code at `_budget.mjs:30`/`153`, and confirmed empirically: both keys were read from
the live `data-budget` store during the 2026-08-21 investigation). Same store, different keys.

**The conclusion drawn from that premise survives anyway, and it is worth being precise about why:**
`casUpdate` (`_budget.mjs:172`) is **single-key CAS** — `getWithEtag` then `setIfMatch` on one key.
There is no multi-key CAS and no transaction anywhere in the module. **Sharing a store buys nothing.**
So the availability of a transaction was never a function of store topology, and anyone reasoning
"same store, therefore atomic" would be wrong for a second, independent reason.

## 0.2 🚨 It is a TRIPLE, across TWO stores — the precondition's own word understates it

Decrement-at-submit for DCA does not create a pair. It creates **three** counters that must move
together: `spentAmount`, `day:`, `dca-day:` — spanning **two different stores**. Any design written
to the literal word "pair" will be one counter short.

## 0.3 ⭐⭐ THE ANSWER: it is CAS-and-reconcile. "Atomic" describes an INTENT, not a PROPERTY

Netlify Blobs offers single-key CAS and nothing else. Therefore:

* **A real transaction is unavailable.** Not hard — unavailable. No design should be written as if a
  future refactor could recover it.
* **What is achievable is CONVERGENCE**: a durable intent record written first, idempotent counter
  writes, and a re-runnable reconcile that finishes whatever was left undone.

🚨 **SO THE WORD MUST NOT SURVIVE INTO THE CODE UNQUALIFIED.** "Atomic-pair semantics" names the
outcome someone wanted. What can actually be built is *idempotent, re-runnable, eventually-consistent
triple maintenance*. Those are not the same guarantee, and the gap between them is observable:

## 0.4 ⚠️ NAME THE WINDOW — what a crash between the writes actually leaves

Under CAS-and-reconcile, a crash after *k* of 3 counter writes leaves exactly the desync the
precondition warns about. **The desync is BOUNDED IN TIME, NOT PREVENTED.** Every un-written counter
is *understated relative to truth*, i.e. widened — the fail-open direction, per the asymmetry in
`PROGRESS.md` 2026-08-21.

⭐⭐ **AND WHAT BOUNDS IT IS A RUNNER, NOT A GUARANTEE.** The window closes only when something
re-runs the reconcile. That makes the honesty requirement concrete: **any claim of "atomic" is a
claim about a runner existing and executing.** See §2 — today, for the case that matters most, no
such runner is scheduled, which would make the guarantee **vacuous**.

## 0.5 🚨 A PRE-EXISTING HAZARD THIS PROMOTES FROM RARE TO NORM-PATH

`recordAgentSpend` (`_budget.mjs:591`) does `casUpdate(dayKey)` **then** `appendAudit`. The audit
entry is what makes a charge *reversible* — `listUnresolvedCharges` selects on it, and
`reverseAgentSpend` refuses any charge without one. **So a crash between those two writes leaves a
day-ceiling charge that is counted and PERMANENTLY UNREVERSIBLE**, invisible to every sweeper by
construction.

Under confirm-gated ledgering this is rare and the survivor is safe-direction. **Submit-time
ledgering makes this window the norm path**, taken on every slow fill. It must be addressed in the
same change, not inherited.

---

# 1. The design — idempotent counters, journal-first, runner-closed

## 1.1 ⭐⭐ `reversedIds` ALREADY PROVES THE PATTERN — mirror it as `chargedIds`

`reverseAgentSpend` solved idempotency for the reversal direction, structurally, inside one CAS:

```js
const already = rec.reversedIds ?? [];
if (already.includes(id)) { applied = false; return rec; }   // membership + arithmetic, one mutate
```

The charge direction has no equivalent — `_budget.mjs:79` states plainly that neither write is
idempotent, which is why `dca-tick.mjs:265` must *always* clear `pendingPeriod` to avoid
double-applying on re-reconcile.

⭐ **The extension is the mirror, on every one of the three counters:** a `chargedIds` set keyed on
the authoritative `circleId`, membership-tested and mutated inside the same CAS. Then **both
directions become idempotent and re-runnable**, and "finish the triple" becomes a safe operation to
retry from anywhere, any number of times. This is the technical core of step 0.

## 1.2 The journal already exists — the fill claim

`fill:<id>:<period>` in `dca-fills` is written **before** the swap (`status:"claimed"`) and rewritten
after submit with the authoritative `circleId`. That second write is the natural **commit point**:
from that moment the charge is *owed*.

Proposed sequence at the `SwapPendingConfirm` branch:

1. claim → `status:"claimed"` *(exists today)*
2. submit
3. claim → `status:"submitted"` + `circleId` + `fillValueUsdc` — **JOURNAL COMMIT**
4. charge the three counters, each idempotent on `circleId` (§1.1)
5. claim → `ledgered: true`

Any runner can then select `status==="submitted" && !ledgered` and finish step 4 safely.

## 1.3 ⭐ Write ORDER — a crash must leave the system MORE restricted, not less

Order the three by *cost of being the missing one*:

| order | counter | cost if it is the one missing |
|---|---|---|
| 1st | `spentAmount` | 🚨 funds a tick past the mandate's **authorized total** — the mandate *is* the authorization artifact (`_dca.mjs` header). Worst. |
| 2nd | `day:` | global day ceiling widened — affects every action by that owner, not just DCA. |
| 3rd | `dca-day:` | DCA's half widened, but the hard `canSpendDay` ceiling still backstops it. Least bad. |

⭐ **And the reversal must mirror it — charge most-critical-FIRST, reverse most-critical-LAST** — so
a crash mid-reversal also leaves the system more restricted rather than less. Both directions then
fail toward refusal.

## 1.4 What gives budget back

Only a **positive on-chain observation** that no funds moved: `getTransaction({id})` returning
`FAILED`/`CANCELLED`/`DENIED`. **An unconfirmed fill returns nothing — "I could not look" is not an
observation.** That is the whole content of the 2026-08-21 finding, and it is the rule this design
exists to install.

---

# 2. ⚠️ THE REVERSAL GAP — its own item, because decrement-at-submit CREATES it

**This is not a footnote and it is not subsumed by §1.** It is the one defect that does not exist
today and would come into being the moment step 1 ships.

**Today** a cancelled-while-pending mandate is an *over-spend* surface (the uncounted fill widens
`remaining`). **After step 1** it is a *reversal* surface: the charge is already applied, and if that
tx actually failed, something must reverse it.

⭐ **The over-spend half genuinely is subsumed** — confirmed at `_dca.mjs:222`: `evaluate()` returns
not-due for *any* non-ACTIVE status, so a cancelled mandate can never fill again regardless of its
budget number. **The reversal half is not.** Three candidate runners, none of which covers it:

| runner | covers the orphan? |
|---|---|
| `dca-tick` reconcile | ❌ unreachable — the ACTIVE gate (`:337`) sits above the reconcile gate (`:341`) |
| `budget-sweep` | ❌ **absent from `netlify.toml` entirely** — unscheduled by decision (Path B) |
| `job-swap-receipt-background` → `reverseChargeById` | ❌ the research→swap verifier, a different path |

🚨 **So the charge would stand permanently — and per §0.4 this is exactly where "atomic" becomes
vacuous:** the convergence guarantee is only as real as the runner, and for this case there is none.
The direction is safe (over-count narrows), but a permanent phantom charge is precisely the class
step 8 was built to remove, so shipping one back in would be a regression against that work.

⭐⭐ **THIS IS WHY STEP 2 CANNOT BE DELETED ONCE STEP 1 LANDS.** It changes shape — from over-spend
to reversal gap — and it shrinks, but it does not disappear. Two candidate closures, and they are
not equivalent:

* **(a) Reconcile above the ACTIVE gate** — reorder `dca-tick` so a mandate carrying a
  `pendingPeriod` is reconciled regardless of status. Narrow, local, fixes the original defect at its
  root. ⚠️ Needs care: reconcile currently writes patches that assume an active mandate.
* **(b) Schedule `budget-sweep`** — generic, covers orphans from *any* path, not just cancel.
  🚨 **But it must not be scheduled before step 0 lands**, or it performs exactly the day-ledger-only
  partial reversal the precondition forbids.

**Recommendation: (a) then (b).** (a) is the honest fix for the defect actually found; (b) is
defence-in-depth and is worth having, but only once the triple is idempotent.

---

# 3. Options considered for §0.3, and why CAS-and-reconcile

| | option | verdict |
|---|---|---|
| **A** | real multi-key transaction | ❌ **unavailable** on Netlify Blobs — single-key CAS only |
| **B** | journal-first + idempotent counters + re-runnable reconcile | ⭐ **recommended** — achievable today, reuses `reversedIds`' proven shape, and the residual window is nameable (§0.4) |
| **C** | collapse the triple to one authoritative record (derive `day:`/`dca-day:` by summing the audit log) | the only option where desync is **structurally impossible** rather than merely convergent — but it rewrites the hot read path of the daily ceiling. **Not now; record it as the end state** if the triple keeps causing trouble. |

⚠️ **B's honesty requirement:** because B converges rather than guarantees, the code comment must say
so. **Do not write "atomic" in the source.** Write what is true — idempotent, re-runnable, and
convergent *given a runner* — and name the runner. A future reader who inherits the word "atomic"
inherits a guarantee nobody built, which is how this brief came to be needed in the first place.

---

# 4. What this brief does NOT settle

* **Whether `spentAmount` should be charged at submit at all, or derived.** §3-C would make the
  mandate budget a *view* over the audit log rather than a stored counter. Deferred, not dismissed.
* **The 7 USDC of historical discrepancy** (`PROGRESS.md` 2026-08-21). No future exposure — all
  seven mandates are terminal, zero ACTIVE. Reconcile or document; **not urgent, and not this work.**
* **Whether `dca-day:` earns its existence** given the hard ceiling backstops it. If it does not, the
  triple becomes a pair and §0.2 stops being a problem. Worth asking before building §1.1 three times.
* **Test strategy.** Named here so it is not discovered late: per
  [[binding-tested-across-what-it-binds]], a crash-window test that runs in ONE process where both
  stores are trivially consistent proves nothing about the real desync. The interruption must happen
  **between** the counter writes, against stores that can actually diverge.

---

# 5. ⚠️ THE PRECONDITION IS GENERAL — read and understood, NOT extended

`_budget.mjs:652` is written as a note about DCA's neighbours, but **its terms are not
DCA-specific.** It binds:

> **ANY** path that ledgers at SUBMIT **AND** writes a paired sub-ledger.

⭐ Nothing in it is about mandates, swaps, or schedulers. The trigger is a *shape* — an eager
day-ceiling charge plus a second counter that must move with it — and any future feature with that
shape inherits the same obligation, whether or not it ever touches `dca-tick`.

🚨 **DELIBERATE NON-ACTION: `_budget.mjs` WAS NOT EDITED.** The precondition needed **reading**, not
amending. Rewriting it to name DCA would have narrowed a general rule to one instance and quietly
disarmed it for the next feature — and it would have been done by the very session that proved the
rule works, which is the worst possible moment to weaken it. It stays exactly as its author left it.

**The rule, for whoever arrives next:** if you are about to charge the day ceiling before the chain
has confirmed, and something else must move with that charge — **stop and read `_budget.mjs:652`
before writing the first line.** It caught this one.
