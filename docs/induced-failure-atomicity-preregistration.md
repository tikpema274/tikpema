# PRE-REGISTRATION 6 — the INDUCED FAILURE: does a reverting burn roll the approve back?

**Written 2026-09-04, BEFORE the run.** Committed first so the prediction cannot be edited to match
the outcome. PR-1 through PR-5 stand unedited, results appended.

⛔ **NOTHING BELOW HAS BEEN OBSERVED.** Every run so far describes a **successful** burn. This is the
first attempt at the failure path, which is the only path that can settle atomicity.

---

## 0. ⛔ THE INDUCTION METHOD — DECIDED FIRST, BECAUSE THE TWO CANDIDATES ARE NOT EQUIVALENT

**The question atomicity asks is:** when the SECOND call fails, does the FIRST one roll back? So the
induction must make **the burn fail while the approve would otherwise have succeeded**. Anything that
makes the *approve* the failing call tests nothing.

### (a) EXPIRED QUOTE — achieves the shape, CANNOT BE REACHED

At the contract it is exactly right: the approve succeeds, the burn reverts on the quote deadline.
⛔ **But it never gets there, because two of OUR OWN gates refuse first:**

    openBridgeQuote()      -> openQuoteExpiry -> assertQuoteUnexpired   THROWS
    agentBridge()          -> fee.reCheckExpiry()                        THROWS, immediately pre-submit

The second is deliberate and documented: *"a burn past the deadline still REVERTS, and a revert costs
gas and produces a failed receipt for a bridge that was never going to work."* **Reaching the chain
with an expired quote requires disabling both** — and a run against modified code proves nothing
about the code that is deployed. ⛔ **REJECTED.**

### (b) DELIBERATE SHORTFALL — achieves the shape, but not for the reason given, and still cannot be reached

⚠️ **THE STATED WORRY IS MECHANICALLY WRONG, AND WORTH CORRECTING.** A smaller approve does **not**
make the approve the failing call. `approve` sets an allowance; it checks no balance, no magnitude,
nothing. Approving 1 wei SUCCEEDS. The burn then reverts inside `transferFrom` on insufficient
allowance — **call 1 succeeds, call 2 fails**, which is precisely the shape wanted.

⛔ **IT IS REJECTED FOR A DIFFERENT REASON: THE APPROVE AMOUNT IS NOT A PARAMETER.**

    bridgeBatchCallData()  ->  const debit = bridgeDebitMinor(fee)      // amountMinor + feeMinor
                               approve(TMWF, debit)

To approve less you must edit `bridgeDebitMinor` or the args — again a change to the code under
test. ⛔ **REJECTED, and the batch shape is not what forbids it.**

### ⭐⭐ (c) INSUFFICIENT BALANCE — THE ONE THAT IS CLEAN. THIS IS THE METHOD.

Hold the wallet's USDC **at or above the amount but BELOW amount + fee.** Then, inside the batch:

    call 1  approve(TMWF, amount + fee)      SUCCEEDS — approve never checks balance
    call 2  depositForBurnWithFees(...)
              fee leg      transferFrom  54018      succeeds (balance covers it)
              amount leg   transferFrom  12800000   REVERTS — insufficient balance

**The approve succeeds and the burn fails, from inside the burn call.** Exactly the shape.

⭐ **AND IT REQUIRES NO CODE CHANGE AT ALL** — the amount is a number typed into the panel.

🚨 **BECAUSE THE AGENT BRIDGE PATH HAS NO BALANCE PRE-FLIGHT.** Verified by reading: the only bridge
balance gate in the repo is in `job-bridge-approve.mjs` (the PLAN path). `agent-bridge.mjs`,
`_actions.mjs` and `_bridge.mjs` contain no `balanceOf` check for a bridge. Nothing refuses
server-side, so the whole band `[amount, amount + fee)` reaches the chain.

⚠️ **AND THAT BAND IS ITSELF A MIGRATION ARTEFACT WORTH NAMING.** Under the DEDUCTED mechanic the
wallet needed `amount`; under UPFRONT it needs `amount + fee`. Any gate checking only `amount` is now
short by exactly the fee. The agent path has no gate, so this is not a live defect there — but it is
the shape to check on any path that does have one.

---

## 1. THE SUBJECT

One bridge from the **Bridge page**, agent path, **Arc → Base Sepolia**, from the SCA
`0x60e76623…2f75`.

    balance NOW   12809812 minor = 12.809812 USDC   (read 2026-09-04, eth_call balanceOf)
    amount    A = 12.800000 USDC  (12800000 minor)  ≤ balance ✅
    fee       F = re-quoted at execution; 51348–54204 minor observed historically
    debit  A + F ≈ 12854018 minor  >  balance by ≈ 44206 minor (≈0.044 USDC)  ← the shortfall

⭐ **THE SHORTFALL IS ROBUST TO THE FEE.** It holds for any fee above **9812 minor (0.009812 USDC)**;
every fee this system has ever quoted is more than five times that.
⭐ **NO FUNDS NEED TO BE MOVED.** The amount is chosen against the balance rather than the balance
adjusted against the amount — one fewer transaction, and no state changed before the test.

Gates it must pass to reach the chain, checked in advance:
`feeRatio ≈ 54018/12800000 = 0.42%` → band **`none`**, no acknowledgment. Per-bridge cap
`AGENT_BRIDGE_CAP_USDC = 25` (read from the production context) against a valued
`amount + fee ≈ 12.854` → **passes**. ⚠️ The per-day ceiling is not read here; if it refuses, that is
a clean pre-execution refusal and a non-event — record it and re-run smaller another day.

---

## 2. THE PREDICTION — one claim each

⭐ No row states a count, a total, or a relationship between sets. PR-2's lesson, and PR-4 broke it
once already with a two-clause B7.

**R1 — NO USDC LEAVES THE WALLET.** The SCA's USDC balance after equals its balance before.
*One value.*

**R2 — THE ALLOWANCE IS ZERO AFTERWARDS.** `USDC.allowance(SCA, TMWF)` read after is `0`.
*One value.* ⭐⭐ **THIS IS THE ROW THE WHOLE RUN EXISTS FOR.** A standing allowance here means the
approve landed and the burn did not — **that is non-atomicity, observed directly**, and it would
reopen the choice between options A, B and C with the standing-allowance window back on the table.

**R3 — THE APPROVE LEFT NO TRACE.** If a transaction was broadcast, it contains no ERC-20 `Approval`
log from the SCA to TMWF.
*One movement — its absence.* ⚠️ **AN ABSENCE NEEDS A CONTROL, AND THIS ONE HAS A BUILT-IN ONE:** the
same receipt must still carry its EntryPoint/`UserOperationEvent` logs. If the receipt has NO logs at
all, the reader is broken and R3 is unevaluable rather than confirmed. A lone absence proves nothing.

**R4 — NO DURABLE RECEIPT IS WRITTEN.** No `bridge-receipt/1` record exists under a `0x…` key for
this attempt.
*One value.* Derived, not hoped: `waitForTx` **throws** on Circle state `FAILED`, so `agentBridge`
throws and `recordBridge` is never reached.

**R5 — NO PROVISIONAL RECEIPT IS WRITTEN.** No new `tx-…` key appears for this owner.
*One value.* `recordPendingBridge` runs only for `TxPendingError`; a `FAILED` is a different throw.
⚠️ Its own row because a stray `tx-` record is exactly what the origin-filter defect (`14d8b8a`) then
feeds ~146 futile Circle calls.

**R6 — NO FEE VERDICT IS WRITTEN.** No new `fee/…` key appears.
*One value.* `recordBridge` is the only caller of `triggerFeeReconcile`.

**R7 — THE DAY LEDGER IS NOT CHARGED.** Today's ledgered agent spend after equals before.
*One value.* `_actions.mjs` ledgers *"after success"*; a throw should never reach it.

**R8 — THE PANEL SHOWS AN ERROR.** The Bridge page renders an error, not a success row and not an
in-flight row.
*One value.* `agent-bridge` answers `500 {error}` on a non-pending throw; `BridgePanel` renders it
through `describeError`.

**R9 — AND THE MESSAGE NAMES THE RIGHT ONE OF TWO THINGS.** The text the user sees says the
transaction **reverted on chain** if a hash exists, or that it was **rejected before broadcast** if
none does — matching what actually happened.
*One value.* ⭐ `waitForTx` already builds this discriminator (`err.broadcast`, set from the presence
of a `txHash`) precisely because *"telling a user their transaction failed on-chain when no
transaction ever reached the chain asserts something we did not observe"*. **This row asks whether
that distinction survives to the screen.** ⛔ Nobody has ever seen this path in the UI; the copy for
it may be unwritten, generic, or wrong, **and that is a finding whether or not atomicity holds.**

---

## 3. FALSIFIERS — one per row, each negating exactly one

| # | falsifier | negates |
|---|---|---|
| F1 | the SCA's USDC balance after differs from the balance before | **R1** |
| F2 | `allowance(SCA, TMWF)` after is a value other than `0` | **R2** |
| F3 | the broadcast transaction contains an `Approval` from the SCA to TMWF | **R3** |
| F4 | a `bridge-receipt/1` record exists for this attempt | **R4** |
| F5 | a new `tx-…` key exists for this owner | **R5** |
| F6 | a new `fee/…` key exists | **R6** |
| F7 | today's ledgered spend after differs from before | **R7** |
| F8 | the panel renders a success row or an in-flight row | **R8** |
| F9 | the message names on-chain revert when no hash exists, or pre-broadcast rejection when one does | **R9** |

⭐ **EACH ROW IS NEGATED BY EXACTLY ONE FALSIFIER AND EACH FALSIFIER NAMES ITS ROW.** No falsifier
forbids behaviour another row predicts.

⛔ **F2 IS THE ONE THAT WOULD CHANGE THE DECISION.** Everything else describes housekeeping on a
failed attempt. A non-zero allowance means the batch is not atomic and the option was chosen on a
property it does not have.

---

## 4. ⛔⛔ THE FORK — THIS RUN MAY NOT REACH THE CHAIN AT ALL, AND THAT IS NOT A FAILURE OF THE RUN

Circle **simulates before broadcasting**. If the simulation reverts, Circle marks the transaction
`FAILED` **with no `txHash`**, and no userOp is ever submitted.

    FAILED  WITH a txHash    -> broadcast and reverted   -> R3 is evaluable, ATOMICITY IS TESTED
    FAILED  with NO txHash   -> rejected at estimation   -> R3 is N/A, ATOMICITY IS NOT TESTED

⚠️ **EIGHT OF THE NINE ROWS ARE EVALUABLE EITHER WAY.** Only R3 — and the atomicity conclusion
itself — depends on a broadcast. ⛔ **IF THERE IS NO HASH, DO NOT RECORD ATOMICITY AS PROVEN OR
DISPROVEN.** Record: *no transaction existed, so the question was not put.* A pre-broadcast rejection
is a real and useful observation about where the failure surfaces — it is simply not this one.
⭐ The discriminator is already built and needs no new instrument: `err.broadcast`, and the two
distinct messages it selects.

---

## 5. WHAT THIS RUN DOES NOT SETTLE

* **THE EXPIRED-QUOTE REVERT.** Method (a) is unreachable without disabling our own gates, so
  `QuoteExpired` remains a revert we have reasoned about and never observed. Whether the batch is
  atomic under a **balance** failure and under a **deadline** failure are, strictly, two runs.
* **THE SELF-SIGNED PATH.** Deducted, cannot batch, has no batch to be atomic.
* **THE PLAN PATH.** Its own store, neither trigger, no fee verdict.
* **THAT SUCCESS STILL WORKS.** A revert leaves the wallet where it started; it says nothing new
  about the happy path PR-5 proved.

---

## 6. COST — AND THE HONEST VERSION IS NOT "ZERO"

**Expected: 0 USDC.** No USDC moves on a revert, and gas is sponsored — PR-4 measured the EntryPoint
paying the bundler `32648089811148462` wei natively while the wallet's delta was exactly `A + F`,
i.e. no gas component. A pre-broadcast rejection costs nothing at all, on chain or otherwise.

⛔ **BUT "THE FEE IS NOT CHARGED ON A REVERT" IS R1 — THE THING UNDER TEST — AND A PRE-REGISTRATION
MAY NOT SPEND ITS OWN PREDICTION AS AN ASSURANCE.** So the bound, not the expectation:

    worst realistic case   the FEE alone, ≈ 0.054018 USDC — the fee leg lands, the amount leg
                           reverts, and the batch fails to roll back (i.e. F2 and F1 both fire)
    absolute bound         the fee. The AMOUNT leg cannot succeed: 12800000 exceeds the balance
                           remaining after the fee is pulled, by construction of the shortfall.

⭐ **THE SHORTFALL IS ALSO THE COST CAP.** The same arithmetic that induces the failure is what makes
the amount unable to move, so the exposure is one fee — and if that fee does move, it is not a cost,
it is the finding.

---

## 7. HOW TO RECORD THE RESULT

Append below a rule; never edit above it. For **each of R1–R9** state the observation, and for **each
of F1–F9** state fired / did not fire / not applicable, with evidence.

⭐ Record the balance and the allowance **before and after as separate readings**, never a computed
delta — the shape that produced the run-1 correction, and one this thread has now avoided four times.
⭐ Record the error message **verbatim, as the user saw it**, not paraphrased — R9 is a claim about
the text, and a paraphrase cannot falsify it.
⚠️ Record whether a `txHash` existed **before** interpreting anything, because it decides §4's fork.
⚠️ If a falsifier fires, **the finding is the falsifier** — record it and stop. If the defect turns
out to be in a row rather than in the world, say which clause and why, and do not repair it in place.

---
---

# RESULT — appended 2026-09-04, nothing above this line edited

## ⛔⛔ ATOMICITY IS **NOT TESTED**. THE FORK WENT THE NO-BROADCAST WAY.

    "Circle rejected the transaction before broadcast (INSUFFICIENT_TOKEN)
     — it never reached the chain"

Circle simulated the batch, saw the shortfall, and refused. **No transaction was broadcast, so the
question was never put.** §4 committed this fork in advance precisely so a rejection could not be
read as a result, and it is recorded as **NOT TESTED — neither a pass nor a falsification.**

    amount 12.80 against balance 12.81 · "Leaves your wallet 12.8540"
    agent-bridge invocation 2026-09-04T10:36:15.929Z, duration 2059.78 ms
    NO trigger log lines — recordBridge was never reached

## THE EIGHT EVALUABLE ROWS ALL HOLD. R3 IS UNEVALUABLE.

| row | prediction | observed | falsifier |
|---|---|---|---|
| **R1** | balance unchanged | `12809812` → `12809812`, **two readings** | **F1 did not fire** |
| **R2** | allowance is 0 | `0` — ⚠️ **for a different reason, see below** | **F2 did not fire** |
| **R3** | no `Approval` in the transaction | ⛔ **UNEVALUABLE** — no transaction exists | F3 not applicable |
| **R4** | no durable receipt | 58 `o/…/0x…` keys before and after; set difference **empty** | **F4 did not fire** |
| **R5** | no provisional receipt | 9 `tx-` keys, the same nine user-signed ones | **F5 did not fire** |
| **R6** | no fee verdict | still exactly **one** `fee/` key — PR-5's | **F6 did not fire** |
| **R7** | day ledger not charged | `spentUsdc 1.054018`, ONE audit row, at 10:00:00.038Z | **F7 did not fire** |
| **R8** | the panel shows an error | error rendered, no success row, no in-flight row | **F8 did not fire** |
| **R9** | the message names the right branch | verbatim below — **it does** | **F9 did not fire** |

## ⚠️⚠️ R2 HOLDS FOR A REASON THAT IS NOT ATOMICITY — AND READING IT AS ATOMICITY WOULD BE THE ERROR THIS DOCUMENT EXISTS TO PREVENT

The allowance is `0`. **That is not evidence the batch rolled back.** Nothing was ever submitted, so
no approve was ever attempted, so there was nothing to roll back. The zero is the **pre-existing
state** — it was `0` before PR-5, PR-5 consumed exactly what it approved and left it `0`, and this
attempt did not touch it.

⛔ **R2 PASSING HERE AND R2 PASSING ON A BROADCAST REVERT ARE THE SAME OBSERVATION WITH COMPLETELY
DIFFERENT MEANINGS.** Only the second is about atomicity. The row is scored as holding because it
was predicted and observed; the CONCLUSION it was written to support is not available.

## ⛔ R3 IS UNEVALUABLE, AND AN ABSENCE WITH NO POSSIBLE PRESENCE IS NOT A PASS

R3 predicted no `Approval` from the SCA to TMWF, and required a control: *the same receipt must still
carry its EntryPoint logs, or the reader is broken and R3 is unevaluable rather than confirmed.*

**There is no receipt.** No transaction was broadcast, so the control cannot exist — and neither can
the presence R3's absence was supposed to be measured against. ⭐ **THE ABSENCE IS TRIVIAL: there is
no transaction in which an `Approval` could have appeared.** Scoring that as CONFIRMED would be
exactly the defect recorded hours earlier — *a lone absence proves nothing* — applied to a row that
had been written with a control specifically to avoid it. **The control did its job by refusing.**

## ⭐⭐ R9 — THE COPY EXISTS, IS PRECISE, AND NAMES THE RIGHT BRANCH

> **Circle rejected the transaction before broadcast (INSUFFICIENT_TOKEN) — it never reached the chain**

⭐ **THIS IS `err.broadcast` SURFACING IN THE USER'S TERMS, ON A PATH NOBODY HAD EVER SEEN.**
`waitForTx` sets `broadcast` from the presence of a `txHash` and selects between two messages; the
transaction had **no** hash, and the message says so — *"it never reached the chain"* — rather than
the on-chain-revert wording. It also carries Circle's own reason, `INSUFFICIENT_TOKEN`, unparaphrased.

⚠️ **THE PREDICTION HERE WAS PESSIMISTIC AND IT WAS WRONG.** §2 said *"nobody has ever seen this path
in the UI; the copy for it may be unwritten, generic, or wrong."* It was none of those. The
distinction was built into `_circle.mjs` against a defect measured on the vanilla seller — *"telling a
user their transaction failed on-chain when no transaction ever reached the chain asserts something we
did not observe"* — and it travelled all the way to the screen, unaltered, on first contact.
⭐ A repair made in one place for one incident held on a surface it was never tested against.

## OBSERVED BUT NOT PREDICTED — the panel reset

The quote rows returned to dashes and the button returned to **"Get quote"**. No row predicted this.
It is correct behaviour — the quote is dead and re-quoting is the only way forward — but it is
recorded as an **observation, not a passing row**: a claim nobody registered cannot be scored.

## 🚨🚨 WHAT WOULD REACH THE BROADCAST FORK — AND THE HONEST ANSWER IS "NOTHING DETERMINISTIC"

**Circle simulates against CURRENT state before broadcasting.** Therefore **any revert cause visible
in current state is refused pre-broadcast, by construction.** A shortfall it can see is always
refused. To broadcast a reverting userOp, the cause must arise **between simulation and inclusion**:

* **(i) A STATE RACE** — the balance or allowance changes after simulation. Needs a second spender
  racing Circle's pipeline. No code edit, but not schedulable, and it needs a second mover.
* **⭐⭐ (ii) A TIME RACE — `QuoteExpired`.** The deadline is `block.timestamp`-based. **Our gates
  check at SUBMIT time; the chain checks at INCLUSION time, and nothing can close that gap** — it is
  structurally open. A quote submitted with a few seconds left passes `assertQuoteUnexpired`, passes
  `reCheckExpiry`, passes simulation, and reverts on inclusion. PR-5's whole submit→mine was
  **3864 ms**, so the target window is single-digit seconds.
  ⭐ **THE CODE ANTICIPATED EXACTLY THIS RACE:** `agentBridge`'s re-check comment keeps the check
  *"because a burn past the deadline still REVERTS."* Not a new idea — a named one, never observed.

⛔ **SO: ONE INDUCTION SURVIVES SIMULATION WITHOUT EDITING CODE UNDER TEST, AND IT IS A RACE, NOT AN
INDUCTION.** It cannot be scheduled — only biased toward, by submitting as late in the quote window as
the panel allows, accepting that most attempts will simply be refused. **Every DETERMINISTIC induction
requires editing the code under test.**

⭐ **THAT IS A FINDING, NOT A GAP: atomicity is not deterministically testable from this path.**

## ⭐⭐⭐ AND THE RUN THAT FAILED TO TEST ATOMICITY DEMONSTRATED THE REASON FOR IT

⚠️ **A DERIVATION FROM TWO OBSERVED FACTS, MARKED AS SUCH — not an observation.** Observed: (1)
Circle refused **the burn** pre-broadcast with `INSUFFICIENT_TOKEN`; (2) `approve` checks no balance,
so an approve of `12854018` would have succeeded. It follows that under the **two-transaction**
design this same refusal would have arrived **after** a successful approve — leaving `12854018`
standing to `TokenMessengerWithFees`, a UUPS proxy whose `_authorizeUpgrade` has an empty body behind
a single EOA.

⭐⭐ **SO PRE-BROADCAST SIMULATION DOES NOT WEAKEN THE CASE FOR BATCHING — IT SHARPENS IT.** Simulation
happens at *burn-submit* time, when a split design's approve is **already on chain**. A refusal that
costs nothing in the batched design costs a standing allowance in the split one. **The exact scenario
the batch was chosen to prevent is the scenario that occurred today**, and the batched design absorbed
it into `allowance = 0`.

⚠️ **WHAT DOES CHANGE IS THE ARGUMENT'S SHAPE.** `agentBridge`'s comment lists the window as *"a quote
that expired in between, a revert, a timeout"*. Deterministic **reverts** now mostly never reach the
chain, so the batch's live value is against the **race** class — expiry-in-flight and timeout — plus
the split design's own refusal-after-approve. Narrower than the comment implies, and still real.
⛔ **NOT RECORDED AS PROOF OF ATOMICITY.** The batch absorbing a pre-broadcast refusal says nothing
about whether `executeBatch` rolls back a mid-execution revert. That remains untested.

## WHAT THIS RUN STILL DOES NOT SETTLE

* **ATOMICITY.** Untested, for the reason above, and now known to be untestable deterministically
  from this path without editing the code under test.
* **THE EXPIRED-QUOTE REVERT.** Still reasoned about, never observed — and now identified as the
  ONLY non-code-editing route to the broadcast fork.
* **THE SELF-SIGNED PATH.** ⚠️ And note it does **not** get Circle's simulation: a browser EOA signs
  and broadcasts directly. Nothing here transfers to it.
* **THE PLAN PATH.** Own store, neither trigger, no fee verdict.
