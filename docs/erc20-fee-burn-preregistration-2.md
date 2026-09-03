# PRE-REGISTRATION 2 — the resumed run: SCA, finality, settlement

**Written 2026-09-03, BEFORE the run.** Committed first. Nothing below has been observed.

Supersedes nothing: `docs/erc20-fee-burn-preregistration.md` and its appended RESULT stand unedited.
This document exists because that run **stopped on a fired falsifier** and never reached its steps 5
and 6, and because a **retraction** changed what it had established.

## WHY A SECOND DOCUMENT AND NOT AN EDIT

⛔ **Falsifier 6 of PR-1 contradicted PR-1's own §1 table.** Rows 1a and 3 predict two ERC-20
`Transfer`s of value `F`; falsifier 6 declared two to be falsifying. The document forbade what it
predicted, and the receipt showed exactly what §1 said. Repairing that clause after seeing the receipt
is the edit a pre-registration exists to prevent — even when the repair is obviously correct.

⭐ **SO EVERY FALSIFIER HERE IS DERIVED FROM A NUMBERED ROW AND CARRIES THAT ROW'S NUMBER.** A
falsifier is the negation of one prediction and nothing else. A clause contradicting a predicted row
cannot be written, because it would have to negate the row it came from.

## WHAT PR-1 ACTUALLY LEFT OPEN

| question | status after PR-1 |
|---|---|
| ERC-20 fee leg emits as predicted | **settled** — `Transfer(payer → TMWF, 53971)` from `0x3600…0000` |
| displayed == submitted fee | **observed once** — `53971 == 53971`, one route, one amount |
| dual-emission double-count | **confirmed** — 7 logs each stream |
| **an SCA can carry the quote tuple** | **OPEN — and PR-1 did not test it.** The wallet was an EOA (0 bytes code); the burn was a plain tx, not a userOp |
| **actual `minFinalityThreshold`** | **OPEN** — never read |
| **burn → mint settlement time** | **OPEN** — never measured |
| **gas sponsorship against a NEW target** | **OPEN** — prior evidence targets `BridgingKitContract` only |

---

## 1. THE PREDICTION — numbered rows

Burn of **A = 1** minor unit, quoted fee **F**, `feeToken = burnToken = 0x3600…0000`, from the
**AGENT SCA `0xc54d4721…b4e621`** (209 bytes of code — an ERC-4337 account, unlike PR-1's wallet),
destination domain 6.

**R1 — SUBMISSION SHAPE.** The burn arrives as an **ERC-4337 userOp**: the transaction's `from` is a
bundler and `to` is the EntryPoint, **not** the wallet and not `TokenMessengerWithFees`. The receipt
carries a `UserOperationEvent`.

**R2 — SPONSORSHIP.** The wallet's USDC balance falls by **exactly `A + F`** and no more. Gas is paid
by the paymaster (`0x7ceA357B…0a25` on Arc per `_delegate.mjs`), so the balance delta contains no gas
component.

**R3 — FEE LEG.** An ERC-20 `Transfer` from `0x3600…0000`, `wallet → TMWF`, value exactly **`F`**,
where `F` is the `feeTotalAmount` of the quote submitted.

**R4 — AMOUNT LEG.** An ERC-20 `Transfer` from `0x3600…0000`, `wallet → TMWF`, value exactly **`A`**,
distinct from R3.

**R5 — DUAL EMISSION.** Every movement in R3 and R4 also appears from `0xffff…fffe` at 18 dp, value
×10¹². The two streams have **equal Transfer counts**.

**R6 — FINALITY.** `minFinalityThreshold` in the `DepositForBurn` event emitted by TokenMessengerV2
(`0x8fe6b999…`) is **`2000`** (SLOW), because `_inferParamsFromQuote` selects
`quotedForPreFinality ? 1000 : 2000` and a FORWARD-only quote has no PRE_FINALITY item.

**R7 — SETTLEMENT.** The destination mint lands on Base Sepolia. ⚠️ **NO TIME IS PREDICTED.** Our
21–29 s figures are FAST-threshold observations and R6 predicts SLOW; predicting a duration from
measurements of a different threshold would be the inference this document exists to avoid. The run
**measures** burn→mint and compares against `MINT_DEADLINE_MS` (4 min) afterwards.

---

## 2. FALSIFIERS — each the negation of one row

| # | falsifier | negates |
|---|---|---|
| F1 | `from` is the wallet itself and `to` is TMWF — a plain transaction, no `UserOperationEvent` | **R1** |
| F2 | the balance delta exceeds `A + F` — i.e. a gas component is present | **R2** |
| F3 | no ERC-20 `Transfer` `wallet → TMWF` of value `F`, **or** its value ≠ the submitted quote's `feeTotalAmount` | **R3** |
| F4 | no ERC-20 `Transfer` `wallet → TMWF` of value `A`, **or** a single combined `A + F` | **R4** |
| F5 | the two streams' Transfer counts differ, **or** a native twin is missing | **R5** |
| F6 | `minFinalityThreshold` in `DepositForBurn` is not `2000` | **R6** |
| F7 | no mint on Base Sepolia within `MINT_DEADLINE_MS` × 5 (20 min) | **R7** |

⭐ **Each row is negated by exactly one falsifier and each falsifier names its row.** F3 permits the
two legs PR-1's falsifier 6 wrongly forbade: R3 constrains the leg whose `from` is the wallet, and
says nothing about the onward `TMWF → FeeManager` leg, which R3 does not predict and F3 cannot fire on.

⚠️ **F7 IS DELIBERATELY LOOSE.** It tests *"did it arrive at all"*, not *"was it fast"*, because R7
predicts no duration. A slow mint is a **measurement**, not a falsification; only a missing one fails.

---

## 3. WHAT THIS RUN DOES NOT SETTLE

* **Whether sponsorship holds for a DIFFERENT new target.** R2/F2 test `TokenMessengerWithFees` only.
* **A settlement-time distribution.** One burn is one observation. If it lands in 25 s that does not
  establish a SLOW-threshold figure, and `MINT_TIMING`'s seven surfaces cannot move on it alone.
* **The reconciliation's correctness.** This run produces the artifact the reader would read.
* **Anything about mainnet.** Arc testnet's Gas Station policy is Circle-provisioned with a 50/day
  limit; mainnet policies are developer-configured.

⚠️ **AND READ THE GAS STATION POLICY FIRST.** R2 is the one row settleable without spending: the
documented policy attributes carry no contract dimension, so the residual risk is a blocklist entry or
an exhausted daily limit, both readable from the API. **If R2 can be checked cheaply, checking it
after the burn is a wasted opportunity, not a stronger proof.**

---

## 4. HOW TO RECORD THE RESULT

Append below a rule; never edit above it. For **each of R1–R7** state the observation, and for **each
of F1–F7** state fired or did not fire, with the evidence. Paste both log streams in full, separately,
at both precisions. If a falsifier fires, **the finding is the falsifier** — record it and stop, and if
the falsifier turns out to be defective say so plainly rather than repairing it in place.

---
---

# RESULT — appended 2026-09-03, nothing above this line edited

**Run 2, from the AGENT SCA `0xc54d4721…b4e621` (209 bytes — deployed).**

    quote issuedAt 1788451442 · mode TIMESTAMP · expiresAt 1788451562 · window 120s
    feeTotalAmount 53985 minor · feeToken 0x3600…0000
    approve 0xce3744a82af2eb31cad12ed85c5da8384733509b012c5a2cce702295d0ae2f94
    burn    0xd5d003c07323ae7d750250b515a7f449ce82d1a178de74a41be17a6092d0f895
    status 0x1 · block 60268338 · 25 logs · submitted with 116s left in the window

## ⛔ F5 FIRED — and this time the falsifier was faithful; the ROW was over-strong

**R5 said:** *"Every movement in R3 and R4 also appears from `0xffff…fffe` at 18 dp, value ×10¹².
The two streams have **equal Transfer counts**."*

**Observed: ERC-20 stream 7 Transfers · NATIVE stream 8.**

R5's **first clause is TRUE** — every R3/R4 movement has its native twin. R5's **second clause is
FALSE**, and it never followed from the first. The extra native log is:

    [24] emitter 0xffff…fffe · from 0x5ff137d4…d2789 · to 0xf4b441ca…ba066 · 31699899562500000 (0.0316999)
         from == tx.to   (the EntryPoint)    ✓
         to   == tx.from (the bundler)       ✓
         → the EntryPoint REFUNDING THE BUNDLER FOR GAS. Native-only by nature: gas is not a token
           movement, so it has no ERC-20 counterpart and never could.

⭐ **THIS IS A DIFFERENT DEFECT FROM PR-1's.** PR-1's falsifier contradicted a predicted row. Here the
derivation discipline worked exactly as designed — F5 faithfully negates R5 — and **the ROW itself
carried an unsupported second clause**. "Equal counts" silently assumed the only native movements are
twins of ERC-20 movements. On a sponsored userOp that is false by construction.

⛔ **RECORDED AND STOPPED. F6 and F7 NOT JUDGED** — no `minFinalityThreshold` read, no settlement
timing. Deriving falsifiers from rows prevents a falsifier from contradicting a prediction; it cannot
prevent a prediction from being too strong. That is a **second, distinct lesson** and it belongs in a
third document, decided knowingly — not patched into this one after the receipt.

⭐ **AND THE FINDING IS USEFUL, NOT JUST A STOP.** A reconciliation must not compare stream COUNTS. It
must pin the emitter AND the movement (`from`, `to`, `value`). The counts differ legitimately, and a
count-based check would fail on every sponsored transaction.

## R1–R4 — all held

| row | prediction | observed | falsifier |
|---|---|---|---|
| **R1** | userOp: `from`=bundler, `to`=EntryPoint, `UserOperationEvent` present | `from` `0xf4b441ca…`, `to` `0x5ff137d4…d2789`, UOE at log [23] | **F1 did not fire** |
| **R2** | balance falls by exactly `A + F`, no gas | `28040000 → 27986014`, delta **53986** == `1 + 53985` | **F2 did not fire** |
| **R3** | ERC-20 `Transfer` wallet→TMWF of `F` == submitted quote's fee | log [2], `53985`, from the wallet | **F3 did not fire** |
| **R4** | ERC-20 `Transfer` wallet→TMWF of `A`, distinct | log [14], `1`, from the wallet | **F4 did not fire** |

⭐⭐ **R1 AND R2 ARE THE TWO THINGS RUN 1 COULD NOT ANSWER**, because its wallet was an EOA. Both hold:
**the gasless developer-controlled SCA carries the quote tuple, and Gas Station sponsors it against
`TokenMessengerWithFees` — a target it had never been observed against.** The open adoption question
from run 1 is closed affirmatively.

⭐ Two independent readings of the same sponsorship fact, which is why it is trustworthy: the wallet's
balance delta contains no gas component (R2), and log [24] shows the EntryPoint paying the bundler
`0.0316999` instead.

## BOTH STREAMS IN FULL, SEPARATELY

**ERC-20 `0x3600…0000`, 6 dp — 7 Transfers**

    [ 2] wallet -> TMWF               53985   FEE   [from WALLET]
    [ 6] TMWF   -> FeeManager         53985
    [10] FeeManager -> fee recipient   5398
    [12] FeeManager -> fee recipient  48587
    [14] wallet -> TMWF                   1   AMOUNT [from WALLET]
    [17] TMWF   -> token minter           1
    [20] token minter -> 0x0              1

**NATIVE `0xffff…fffe`, 18 dp — 8 Transfers**

    [ 1] wallet -> TMWF               53985000000000000
    [ 5] TMWF   -> FeeManager         53985000000000000
    [ 9] FeeManager -> fee recipient   5398000000000000
    [11] FeeManager -> fee recipient  48587000000000000
    [13] wallet -> TMWF                   1000000000000
    [16] TMWF   -> token minter           1000000000000
    [18] token minter -> 0x0              1000000000000
    [24] EntryPoint -> bundler        31699899562500000   <- GAS, no ERC-20 twin

⭐ The 10/90 split held again on different figures: `5398 + 48587 = 53985`.
