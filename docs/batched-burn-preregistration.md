# PRE-REGISTRATION 4 — the first BATCHED burn: approve and burn in one userOp

**Written 2026-09-03, BEFORE the run.** Committed first so the prediction cannot be edited to match
whatever happens. PR-1, PR-2 and PR-3 stand unedited, results appended.

⛔ **NOTHING BELOW HAS BEEN OBSERVED.** Every previous burn this project has made sent the approve as
its own transaction and the burn as another. **No batched burn has ever landed on chain.**

---

## ⛔ WHY AN ESTIMATE IS NOT A RESULT

`estimateContractExecutionFee` returned a gas figure for the self-targeted `executeBatch`. That
settles exactly two things and no others:

* **Q1** the account's runtime validation accepts a self-call to `executeBatch`
* **Q2** Circle's API accepts a `contractAddress` equal to the wallet

🚨 **AN ESTIMATE SIMULATES; IT DOES NOT SETTLE.** It proves the shape is *accepted*, not that the
batch *executes correctly*. It says nothing about whether both calls actually run, whether the
approve is visible to the burn within the same transaction, what the receipt's log stream looks
like, or whether the allowance is genuinely zero afterwards.

⚠️ This is the same distinction PR-3 drew between "the mint arrived" and "the mint arrived at the
right value", and the same one that made run 1's `assert`-backed fee claim smaller than it looked. A
validation result generalises to validation. It does not generalise to settlement.

---

## THE SUBJECT

One bridge from the **agent SCA `0xc54d4721…b4e621`** to Base Sepolia (domain 6), amount **A = 1**
minor unit, quoted fee **F**, submitted as a single userOp whose callData is

    execute(SCA, 0, executeBatch([
      { USDC, 0, approve(TokenMessengerWithFees, A + F) },
      { TMWF, 0, depositForBurnWithFees(A, 6, mintRecipient, USDC, 0x0, {signedQuote, refundAddress}) },
    ]))

⭐ **THE DISCIPLINE FROM PR-3 APPLIES: EVERY ROW STATES ONE MOVEMENT OR ONE VALUE.** Never a count,
never a total, never a relationship between sets. A row asserting *"every X has a Y"* may not also
assert *"and nothing else exists"* — that was R5's defect, and it fired.

---

## 1. THE PREDICTION — numbered rows, one claim each

**B1 — ONE TRANSACTION.** The bridge produces exactly **one** Arc transaction hash. There is no
separate approve transaction with its own hash.
*One value.* Nothing about what is inside it.

**B2 — THE APPROVE HAPPENED, INSIDE IT.** The receipt contains an ERC-20 `Approval` log from
`0x3600…0000` whose owner is the SCA and whose spender is `TMWF`, of value exactly **`A + F`**.
*One movement.* ⚠️ Distinct from B1: "one transaction" and "the approve is in it" are different
claims, and a batch that silently dropped its first call would satisfy B1 alone.

**B3 — THE FEE LEG IS UNCHANGED FROM RUN 2.** An ERC-20 `Transfer` from `0x3600…0000`,
`SCA → TMWF`, of value exactly **`F`**, where `F` is the submitted quote's `feeTotalAmount`.
*One movement.* ⭐ Predicted identical to R3 because batching should change WHO SUBMITS, not what
moves. A difference here would mean the batch is not equivalent to the sequence.

**B4 — THE AMOUNT LEG IS UNCHANGED FROM RUN 2.** An ERC-20 `Transfer` from `0x3600…0000`,
`SCA → TMWF`, of value exactly **`A`**, distinct from B3.

**B5 — THE ALLOWANCE IS ZERO AFTERWARDS.** `USDC.allowance(SCA, TMWF)` read after the transaction
mines is **`0`**.
*One value.* ⭐⭐ **THIS IS THE CLAIM THE WHOLE OPTION RESTS ON.** Batching was chosen over "revoke on
refusal" and over "leave it and record it" because a successful batch should consume exactly what it
approves. Measured on both prior burns as 0 — but those approved and burned in *separate*
transactions, so this is a prediction about a shape never observed.

**B6 — SPONSORSHIP SURVIVES THE BATCH.** The wallet's USDC balance falls by exactly **`A + F`** and
no more.
*One value.* ⚠️ Gas Station sponsored a single `depositForBurnWithFees` in run 2. A batched userOp is
a different target (the wallet itself) and more gas; that it is still sponsored is **not** implied.

**B7 — THE DESTINATION CREDITS THE FULL AMOUNT.** A USDC `Transfer` on Base Sepolia whose `to` is
the SCA, of value exactly **`A`**.
*One value.* ⚠️ **NO TIME IS PREDICTED** — the same reasoning as R7/R8. Settlement is measured and
reported as data, and one observation does not move `MINT_TIMING`.

---

## 2. FALSIFIERS — one per row, single-clause

| # | falsifier | negates |
|---|---|---|
| G1 | more than one Arc transaction is produced for the bridge | **B1** |
| G2 | no `Approval(SCA → TMWF, A + F)` from `0x3600…0000` in the receipt | **B2** |
| G3 | no ERC-20 `Transfer` `SCA → TMWF` of value `F`, **or** its value ≠ the submitted quote's `feeTotalAmount` | **B3** |
| G4 | no ERC-20 `Transfer` `SCA → TMWF` of value `A`, **or** a single combined `A + F` | **B4** |
| G5 | `allowance(SCA, TMWF)` after the transaction is a value other than `0` | **B5** |
| G6 | the balance delta is a value other than `A + F` | **B6** |
| G7 | no USDC `Transfer` to the SCA on Base Sepolia of value `A` is attributable to this burn | **B7** |

⭐ **EACH ROW IS NEGATED BY EXACTLY ONE FALSIFIER AND EACH FALSIFIER NAMES ITS ROW.** No falsifier
forbids behaviour another row predicts — the defect PR-1's falsifier 6 had.

⚠️ **G7 CARRIES NO DEADLINE**, for the reason PR-3 gave: a mint that has not yet landed is an
unfinished observation, not a falsification. If it has not landed at read time, record
NOT-YET-OBSERVED and re-read. Do not convert waiting into failure.

⛔ **G5 IS THE ONE THAT WOULD CHANGE THE DECISION.** A non-zero allowance after a successful batched
burn means batching does not deliver the property it was chosen for, and the choice between options
A, B and C has to be re-made with that on the table.

---

## 3. WHAT THIS RUN DOES NOT SETTLE

* **That a FAILING batch leaves nothing behind.** Every row above describes a *successful* burn.
  The atomicity claim — "either both land or neither does" — is about the failure path, and this run
  does not exercise it. ⚠️ Reading a successful batch as proof of atomicity would be exactly the
  inference this document exists to prevent. Forcing a failure (an expired quote, a deliberately
  insufficient balance) is a **separate** pre-registered run.
* **Anything about mainnet.** Arc testnet's Gas Station policy is Circle-provisioned; a mainnet TMWF
  is a different contract with its own owner and its own upgrade authority.
* **A settlement-time distribution.** One burn is one observation.
* **The self-signed path.** It stays on `BridgingKitContract` and the deducted-fee mechanic, because
  a browser EOA cannot batch. Nothing here applies to it.

---

## 4. HOW TO RECORD THE RESULT

Append below a rule; never edit above it. For **each of B1–B7** state the observation, and for
**each of G1–G7** state fired / did not fire / not yet observable, with evidence. Paste both log
streams in full, separately, at both precisions — the ERC-20 emitter `0x3600…0000` and the native
`0xffff…fffe` — and **do not compare their counts**: run 2 established that they legitimately
differ on a sponsored userOp.

⭐ Record the allowance read (B5) **verbatim, as returned**, and record the balance before and after
as two separate readings rather than one delta. A delta computed and reported without its operands
is the shape that produced the run-1 correction.

⚠️ If a falsifier fires, **the finding is the falsifier** — record it and stop. If the defect turns
out to be in a row rather than in the world, say which clause and why, and do not repair it in place.
