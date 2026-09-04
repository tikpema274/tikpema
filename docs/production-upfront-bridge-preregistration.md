# PRE-REGISTRATION 5 — the first PRODUCTION bridge on the upfront mechanic

**Written 2026-09-04, BEFORE the run.** Committed first so the prediction cannot be edited to match
whatever happens. PR-1 through PR-4 stand unedited, results appended.

⛔ **NOTHING BELOW HAS BEEN OBSERVED.**

---

## ⛔⛔ THIS IS NOT PR-4 REPEATED — FOUR THINGS HAVE NEVER RUN, AND THREE OF THEM WRITE

PR-4 proved the **contract path** from a spike script: `bridgeFee → sealBridgeQuote →
openBridgeQuote → agentBridge`. It called `agentBridge` **directly**. Its own RESULT says so:

> ⚠️ **NO VERDICT WAS WRITTEN TO THE STORE.** The spike calls `agentBridge` directly, not
> `recordBridge`, so the trigger never fired and no `fee/<owner>/<burnHash>` record exists.

So everything downstream of the burn is **unexercised on the upfront mechanic**:

| never run on this mechanic | writes? |
|---|---|
| the UI path — BridgePanel → `/api/agent-bridge` → `agent-bridge.mjs` | — |
| `recordBridge` — the durable receipt | **writes** |
| `triggerFeeReconcile` → `bridge-fee-reconcile-background` | **writes** |
| `triggerSettle` → `bridge-mint-settle-background` | **writes** |
| `BridgeReceiptStatus` rendered against a live upfront receipt | — |

⭐ **A READING PROVEN AGAINST A RECEIPT IS NOT A WRITE PROVEN END TO END.** PR-4 ran the production
*reader* (`observeFeeMovement`, `reconcileFee`) by hand against real bytes and got `matched`. That
settles the reader's arithmetic and nothing about whether anything **calls** it. The trigger, the
background function's own guards, the write-once store and the panel are all on the far side of
that line. [[evidence-does-not-transfer-across-claim-types]]

---

## THE SUBJECT

One bridge from the **Bridge page**, signed by the agent path, **Arc → Base Sepolia** (domain 6),
recipient = the agent SCA `0xc54d4721…b4e621` (so the amount comes back to us).

    amount A = 1.000000 USDC       (see §5 for why this number and not a smaller one)
    fee     F = quoted at execution, ~0.054 USDC on recent burns — READ IT, do not assume it
    TMWF      0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A
    FEE_MANAGER 0x08499fce2344645c72de277a16734741e507a5d8

⭐ **EVERY ROW STATES ONE MOVEMENT OR ONE VALUE.** No row states a count, a total, or a relationship
between sets — the rule PR-3 set and PR-4's own R7/B7 broke.

⚠️ **THE SEVEN REQUESTED CLAIMS ARE TWELVE ROWS**, because five of them were compound. "the
reconciler fires **and** writes a verdict" is two facts with different causes: a trigger that never
sent and a background function that refused after being sent are different failures, and one row
covering both cannot say which happened. PR-4 recorded exactly this defect in its own B7 and did not
repair it; splitting here is that correction applied rather than noted again.

---

## 1. THE PREDICTION — one claim each

**R1 — A DURABLE RECEIPT EXISTS.** After the burn confirms, a `bridge-receipt/1` record exists for
this burn hash under the session owner.
*One value.* Nothing about its contents.

**R2 — IT SAYS `upfront`.** That receipt's `feeMechanic` field is exactly the string `"upfront"`.
*One value.* ⚠️ Distinct from R1: the writer defaults an unrecognised mechanic to `"unknown"`
(`bridgeMechanicOf`), so a receipt can exist and still name no mechanic.

**R3 — THE RECONCILE TRIGGER FIRED, FROM `recordBridge`.** The function log contains
`[bridge-receipt] fee-reconcile trigger sent burnHash=<this hash>` for this burn.
*One movement.* ⭐⭐ **THIS IS THE ROW PR-4 COULD NOT REACH AT ALL.** The evidence must be the log
line, not the verdict: a verdict written by a hand-invocation looks identical to one written by the
trigger, and only the log distinguishes "the wiring works" from "the reader works".
[[establish-which-action-produced-the-outcome]]

**R4 — A VERDICT RECORD EXISTS.** A record exists at the fee-verdict key for this owner and burn
hash.
*One value.* ⚠️ Distinct from R3: the trigger is awaited for a 202 ack only, and the background
function has its own refusals (`requireInternal`, missing receipt, `payer_unknown`). A trigger that
sent and a verdict that was written are two facts.

**R5 — THE VERDICT IS `matched`.** That record's `verdict` field is exactly `"matched"`.
*One value.* ⚠️ `matched` requires `observed.feeMinor === disclosedMinor` as BigInts. The other two
values in the closed set are `mismatched` and `unreadable`, and `unreadable` is the common one on
older burns.

**R6 — THE FORWARD-LEG PIN RESOLVED EXACTLY ONE LEG.** The reading behind that verdict did not
refuse with reason `fee_forward_legs`.
*One value.* ⭐ PR-4 confirmed on real bytes that the `TMWF → FeeManager` `Approval` and `Transfer`
share emitter, both indexed addresses and value — **only topic0 separates them** — and that without
the pin the reader sees two candidates and refuses. This row asserts the pin holds on the write
path's own bytes. ⚠️ PR-4 also recorded that on those bytes *position* and *forward leg* selected
the same log, so that receipt did not discriminate the two rules; this row does not claim to either.

**R7 — THE SETTLE TRIGGER FIRED, FROM `recordBridge`.** The function log contains
`[bridge-receipt] settle trigger sent burnHash=<this hash>` for this burn.
*One movement.* Separate from R3: they are two independent awaited fetches, and either can fail
alone. Both are swallowed by design, so neither failure would surface to the user.

**R8 — DELIVERY IS PROMOTED TO `measured`.** The receipt's `delivery` field becomes `"measured"` and
its `amountDelivered` is non-null.
*One value.* ⛔ **NO TIME IS PREDICTED** — see F8.

**R9 — THE FULL AMOUNT ARRIVED.** `amountDelivered` is exactly `1.000000`.
*One value*, and its own row rather than a clause of R8, because "it was measured" and "it measured
the right number" have different causes. ⭐⭐ **THIS IS THE VALUE THAT DISCRIMINATES THE TWO
MECHANICS**: under the deducted mechanic a 1 USDC bridge delivered `0.945900` on this system's own
recent receipts. A deducted-mechanic regression does not fail R8 — it produces a measured `~0.946`
and fails only here.

**R10 — THE PANEL EXPLAINS THE DERIVATION WHILE IT IS ONE.** While this receipt's `delivery` is
`"predicted"`, its row renders the upfront mechanic sentence — the copy from
`BRIDGE_MECHANIC_COPY.upfront.summary`.
*One value.* 🚨 **THIS OBSERVATION IS ONE-SHOT AND TIME-BOXED** — see F10, which is the falsifier
most likely to be misread.

**R11 — AND STAYS SILENT WHERE THE NUMBER IS AN OBSERVATION.** On a receipt with
`delivery: "measured"`, no mechanic sentence renders.
*One value.* ⭐ Observable immediately on the 57 existing measured rows, independent of this run —
which is why it is separated from R10 rather than sharing a row with it.

**R12 — THE ALLOWANCE IS ZERO AFTERWARDS.** `USDC.allowance(SCA, TMWF)` read after the burn mines
is `0`.
*One value.* ⚠️ Held over from PR-4 deliberately: that run proved it for a hand-built batch. This
one asserts it for the batch the **production** path builds.

---

## 2. FALSIFIERS — one per row, each negating exactly one

| # | falsifier | negates |
|---|---|---|
| F1 | no `bridge-receipt/1` record exists for this burn hash | **R1** |
| F2 | the receipt's `feeMechanic` is any value other than `"upfront"` | **R2** |
| F3 | no `fee-reconcile trigger sent` log line names this burn hash | **R3** |
| F4 | no verdict record exists at the fee-verdict key for this burn | **R4** |
| F5 | the verdict field is any value other than `"matched"` | **R5** |
| F6 | the reading's reason is `fee_forward_legs` | **R6** |
| F7 | no `settle trigger sent` log line names this burn hash | **R7** |
| F8 | the receipt's `delivery` is still `"predicted"` **at the moment of a final read** | **R8** |
| F9 | `amountDelivered` is a value other than `1.000000` | **R9** |
| F10 | the row carries **no** mechanic sentence **while its `delivery` reads `"predicted"`** | **R10** |
| F11 | a row with `delivery: "measured"` carries a mechanic sentence | **R11** |
| F12 | `allowance(SCA, TMWF)` after the burn is a value other than `0` | **R12** |

⭐ **EACH ROW IS NEGATED BY EXACTLY ONE FALSIFIER AND EACH FALSIFIER NAMES ITS ROW.** No falsifier
forbids behaviour another row predicts.

⚠️ **F8 CARRIES NO DEADLINE.** A mint that has not yet landed is an **unfinished observation, not a
falsification**. If `delivery` still reads `"predicted"`, record NOT-YET-OBSERVED and re-read. Do not
convert waiting into failure. The same applies to F9, which cannot be evaluated at all until R8 holds.

🚨 **F10 IS THE ONE THAT WILL BE MISREAD, AND IT IS CONDITIONED ON PURPOSE.** The sentence renders
only while `!measured`. PR-4 measured burn → mint at **11 seconds**, so this window may be under a
minute and it **closes permanently for this receipt**. An absent sentence on a row that has already
been promoted is the system working exactly as `c8e84ad` intended — it is **not** F10 firing. F10
fires only if the sentence is absent *while the same row still reads `predicted`*.
⭐ **IF THE WINDOW IS MISSED, RECORD `MISSED` — an unfinished observation, like F8.** It is not a
pass and it is not a falsification. It can be re-attempted on the next bridge.
⚠️ And if the receipt JSON is captured at `delivery: "predicted"` but no screen was watched, that
proves the render's INPUT, not the render. Record it as a claim about the receipt, and say so.

---

## 3. WHAT THIS RUN DOES NOT SETTLE

* **ATOMICITY. Still unproven, exactly as PR-4 left it.** Every row above describes a **successful**
  burn. *"Either both land or neither does"* is a claim about the **failure** path. R12's zero
  allowance is consistent with atomicity and equally consistent with a non-atomic batch whose second
  call happened to succeed. ⭐ **Only an INDUCED failure discriminates them** — an expired quote, or
  a deliberate shortfall, submitted as a batch, with the allowance read afterwards. That run is
  still not written.
* **THE SELF-SIGNED PATH.** It stays on `BridgingKitContract` and the **deducted** mechanic, because
  a browser EOA cannot batch. Nothing here applies to it, and R11 is the only row that touches it at
  all — as an assertion about existing rows, not about that path's behaviour.
* **THE PLAN PATH (`job-bridge-approve`).** It has its own receipt system in its own store and
  deliberately calls **neither** trigger, so it carries **no fee verdict at all**. R3–R6 say nothing
  about it. That exclusion is a recorded decision, not an oversight.
* **A SETTLEMENT-TIME DISTRIBUTION.** One bridge is one observation. `MINT_TIMING` does not move on it.
* **ANYTHING ABOUT MAINNET.** Arc testnet's Gas Station policy is Circle-provisioned.

---

## 4. HOW TO RECORD THE RESULT

Append below a rule; never edit above it. For **each of R1–R12** state the observation, and for
**each of F1–F12** state fired / did not fire / not-yet-observed / missed, with evidence.

⭐ Record the allowance (R12) **verbatim as returned**, and the balance before and after as **two
separate readings**, never one computed delta — the shape that produced the run-1 correction.
⭐ Record the fee **as read from the submitted quote**, not as the ~0.054 estimate written above.
⚠️ Paste both Arc log streams in full and separately, at both precisions, and **do not compare their
counts** — run 2 established they legitimately differ on a sponsored userOp.

⚠️ If a falsifier fires, **the finding is the falsifier** — record it and stop. If the defect turns
out to be in a row rather than in the world, say which clause and why, and do not repair it in place.

---

## 5. ⭐ THE AMOUNT, AND WHY IT IS NOT SMALLER

**Use A = 1.000000 USDC.**

* **IT KEEPS THE ACK GATE OUT OF THE RUN.** `feeRatio = feeDisclosed / amountRequested`; the bands
  are `warn` at ≥10% and `acknowledge` at ≥25%, and only `acknowledge` gates execution. At a ~0.054
  fee, 1.000000 gives ~5.4% → band `none`. ⛔ A 1-minor-unit bridge like PR-4's would sit at ~100%
  and drag the acknowledge gate into the run — machinery that is **already proven live** (burn
  `0x265be6d3…` at 36.14%) and whose failure would be indistinguishable here from an upfront-path
  failure. One unexercised mechanic per run.
* **IT MAKES R9 DISCRIMINATE.** Upfront delivers exactly `1.000000`; deducted would deliver
  `~0.946`. At 1 minor unit both mechanics deliver a number that rounds to nothing a human can tell
  apart, and R9 would be checkable only in minor units.
* **THE COST IS THE FEE, NOT THE AMOUNT** — ~0.054 USDC. The 1 USDC is minted to our own SCA on Base
  Sepolia. Balance was `27.931972` USDC after PR-4; ample.
* **HEADROOM ON THE BAND:** the fee would have to exceed 0.10 to reach `warn` and 0.25 to gate. Both
  are far above every fee this system has observed.

⚠️ **READ THE QUOTED FEE FROM THE RUN.** The ~0.054 above is a prior, not a prediction, and no row
depends on it.
