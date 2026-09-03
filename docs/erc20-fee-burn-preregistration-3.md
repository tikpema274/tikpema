# PRE-REGISTRATION 3 — finality and settlement, for the burn already made

**Written 2026-09-03, BEFORE the measurement.** Committed first. Nothing below has been observed.

PR-1 and PR-2 stand unedited, results appended. This document covers **only** what run 2 did not
reach when F5 fired: **R6 (`minFinalityThreshold`)** and **R7 (settlement)**.

⭐ **NO NEW BURN IS REQUIRED.** The subject is the burn run 2 already made —
`0xd5d003c07323ae7d750250b515a7f449ce82d1a178de74a41be17a6092d0f895`, Arc block 60268338, amount
**A = 1 minor unit**, `mintRecipient` = the agent SCA `0xc54d4721…b4e621`, destination domain 6 (Base
Sepolia). Everything below is a **read**: the Arc receipt is already on disk, and the destination side
is a query against Base Sepolia. **This costs nothing and spends nothing.**

## WHAT IS ALREADY ESTABLISHED AND IS NOT RE-PREDICTED

R1 (userOp shape) · R2 (sponsorship, delta == A + F) · R3 (fee leg == submitted quote's
`feeTotalAmount`) · R4 (amount leg, distinct). Held in run 2, recorded in PR-2's RESULT. **Not
restated here.** Re-predicting a settled fact inflates a document with rows that cannot fail.

---

## THE REMEDY THIS DOCUMENT ADDS

PR-1's defect: a falsifier contradicted a predicted row. PR-2 fixed it by **deriving every falsifier
from a numbered row**. That worked — and PR-2 then failed a different way: **R5 asserted more than it
could support** ("the two streams have equal Transfer counts"), a second clause that did not follow
from its first and assumed every native movement is a twin of an ERC-20 one.

⭐⭐ **SO: EVERY ROW STATES ONE MOVEMENT OR ONE VALUE.** Never a count, never a total, never a
relationship between sets. A row asserting *"every X has a Y"* may not also assert *"and nothing else
exists"*. **If a row needs two clauses, it becomes two rows**, so each is falsifiable alone and a
failure names which half was wrong.

⚠️ Derivation discipline and single-clause discipline are **orthogonal**. The first constrains the
relationship between the prediction and its falsifier; the second constrains the strength of the
prediction itself. PR-2 had the first and lacked the second.

---

## 1. THE PREDICTION — numbered rows, one claim each

**R6 — THE FINALITY THRESHOLD IS A VALUE.**
The `DepositForBurn` event emitted by TokenMessengerV2 (`0x8fe6b999…2daa`) in the run-2 receipt
carries `minFinalityThreshold == 2000`.
*Basis:* `_inferParamsFromQuote` selects `quotedForPreFinality ? 1000 : 2000`, and a FORWARD-only
quote carries no `PRE_FINALITY` item. One value; nothing about speed.

**R7 — A MINT MOVEMENT EXISTS ON THE DESTINATION.**
On Base Sepolia there is a USDC `Transfer` whose `to` is `0xc54d4721…b4e621`, attributable to this
burn.
*One movement.* Nothing about when, nothing about how much.

**R8 — THE CREDITED VALUE IS THE FULL AMOUNT.**
That mint's `value` is **exactly `1`** minor unit — **not** `1 − fee`, and not any other figure.
*One value.* ⭐ This is the upfront-fee claim itself, observed on the destination chain: the fee was
paid on the source, so the recipient receives the whole amount. Never yet observed by us.

⚠️ **SETTLEMENT TIME IS MEASURED, NOT PREDICTED.** Our 21–29 s figures are FAST-threshold (1000)
observations; R6 predicts SLOW (2000). Predicting a duration from measurements taken at a different
threshold is exactly the inference these documents exist to prevent. **No row asserts a time.** The
measurement is reported and compared against `MINT_DEADLINE_MS` (4 min) afterwards, as data.

---

## 2. FALSIFIERS — one per row, single-clause

| # | falsifier | negates |
|---|---|---|
| F6 | the `DepositForBurn` event's `minFinalityThreshold` is a value other than `2000` | **R6** |
| F7 | no USDC `Transfer` to `0xc54d4721…b4e621` on Base Sepolia is attributable to this burn | **R7** |
| F8 | that mint's `value` is a number other than `1` | **R8** |

⭐ **F7 AND F8 ARE SEPARATE BECAUSE R7 AND R8 ARE.** "It arrived, at the wrong value" and "it never
arrived" are different findings with different causes — a forwarding failure versus a fee deducted on
the destination — and a single combined row would have reported them as one.

⚠️ **F7 CARRIES NO DEADLINE.** A mint that has not yet landed is **NOT** a falsification: it is an
unfinished observation, and the honest record is *not yet observed*, re-read later. Only a mint that
demonstrably will not arrive fires F7, and this document does not define that condition — because I
cannot define it without a settled SLOW-threshold expectation, which is the thing I do not have.
⛔ **If the mint has not landed at read time, record NOT-YET-OBSERVED and stop. Do not convert
waiting into failure, and do not invent a deadline to resolve the ambiguity.**

---

## 3. WHAT THIS MEASUREMENT DOES NOT SETTLE

* **A settlement-time distribution.** One burn is one observation. Whatever it shows, `MINT_TIMING`'s
  seven derived surfaces cannot move on it — that needs repeats, and a single figure recorded as
  though it were a range is how a constant becomes wrong.
* **Whether SLOW is slower than FAST *on Arc*.** Arc's Fast Transfer is N/A precisely because standard
  attestation is already fast there. A 25-second SLOW settlement would be consistent with that and
  would still not establish it.
* **Anything about other destinations.** Domain 6 only.

---

## 4. HOW TO RECORD THE RESULT

Append below a rule; never edit above it. State each of R6–R8 with its observation and each of F6–F8
as fired / did not fire / **not yet observable**, with evidence. Report the burn→mint interval as a
measurement, labelled as one observation. If a falsifier fires, the finding is the falsifier: record
it and stop — and if the defect is in a row rather than in the world, say which clause and why.
