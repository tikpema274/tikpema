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
