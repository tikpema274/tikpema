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

---
---

# RESULT — appended 2026-09-03, nothing above this line edited

**The first batched burn ran**, from the agent SCA `0xc54d4721…b4e621` through the PRODUCTION path
(`bridgeFee` → `sealBridgeQuote` → `openBridgeQuote` → `agentBridge`) — unlike runs 1 and 2, which
hand-encoded their calldata and therefore proved the contract rather than our code.

    quote issuedAt 1788471547 · mode TIMESTAMP · expiresAt 1788471667 · window 120s
    feeTotalAmount 54041 minor · feeToken 0x3600…0000 · items[0].args carry NO amount
    burn 0x4b703a7e2ee30221bcad28bf6b29a415e0eabf66447189f3a94d240e6353c4ff
    status 0x1 · block 60307336 · 26 logs · 2026-09-03T21:39:09Z
    from 0xf4b441ca… (bundler)   to 0x5ff137d4…d2789 (EntryPoint)

## ALL SIX JUDGED ROWS HOLD — no falsifier fired

| row | prediction | observed | falsifier |
|---|---|---|---|
| **B1** | ONE Arc transaction | one submit, one hash | **G1 did not fire** |
| **B2** | `Approval(SCA → TMWF, A+F)` | log [32], **54042** = 1 + 54041 | **G2 did not fire** |
| **B3** | fee leg == submitted quote's `feeTotalAmount` | log [34], **54041** | **G3 did not fire** |
| **B4** | amount leg == `A`, distinct | log [46], **1** | **G4 did not fire** |
| **B5** | `allowance(SCA, TMWF) == 0` afterwards | before **0** · after **0**, both READ | **G5 did not fire** |
| **B6** | balance delta == `A + F` | **27986014 → 27931972**, delta **54042** | **G6 did not fire** |

⭐⭐ **B5 IS THE ROW THE WHOLE OPTION RESTS ON, AND IT HELD.** A successful batch consumed exactly
what it approved: `Approval` of 54042 at log 32, two pulls of 54041 and 1, allowance back to zero.
⚠️ Both endpoints are READINGS. Run 1's post-balance was arithmetic written before the balance was
read and was wrong by the gas it omitted; this delta is `before − after` from two real reads.

⭐ **B6 ALSO RE-CONFIRMS SPONSORSHIP ON A NEW TARGET.** The delta is exactly `A + F` with no gas
component, and the EntryPoint paid the bundler `32648089811148462` separately (native log [56]).
The batch is a self-call to the wallet — a target Gas Station had never been observed against.

## BOTH STREAMS IN FULL, SEPARATELY — counts never compared

**ERC-20 `0x3600…0000`, 6 dp — 7 Transfers**

    [34] SCA        -> TMWF          54041   FEE
    [38] TMWF       -> FeeManager    54041
    [42] FeeManager -> recipient      5404
    [44] FeeManager -> recipient     48637
    [46] SCA        -> TMWF              1   AMOUNT
    [49] TMWF       -> token minter      1
    [52] minter     -> 0x0               1   burned

**ERC-20 Approvals — 4**

    [32] SCA        -> TMWF          54042   ⭐ OURS, from inside the batch
    [35] TMWF       -> FeeManager    54041
    [39] FeeManager -> 0xf992efcb…   54041
    [47] TMWF       -> TokenMessengerV2   1

**NATIVE `0xffff…fffe`, 18 dp — 8 Transfers** (the eighth is the EntryPoint's gas refund to the
bundler, `32648089811148462` — native by nature, no ERC-20 twin)

⛔ **7 vs 8 AGAIN, AS IN RUN 2.** Nothing here compares stream counts. The 10/90 split held a third
time on new figures: `5404 + 48637 = 54041`.

## ⭐ THE FEE RECONCILIATION — MATCHED, and by the FeeManager leg

⚠️ **NO VERDICT WAS WRITTEN TO THE STORE.** The spike calls `agentBridge` directly, not
`recordBridge`, so the trigger never fired and no `fee/<owner>/<burnHash>` record exists. The
production READER was run against the real receipt instead:

    observeFeeMovement -> { read: true, feeMinor: "54041", feeLogIndex: 34, amountLegsMinor: ["1"] }
    reconcileFee       -> verdict "matched" · observed 54041 · disclosed 54041

🚨🚨 **AND THE topic0 COLLISION THE DESIGN PREDICTED IS PRESENT ON THESE BYTES.**

    [35] 0x8c5be1e5…  TMWF -> FeeManager  54041   APPROVAL
    [38] 0xddf252ad…  TMWF -> FeeManager  54041   TRANSFER

Same emitter, same two indexed addresses, same value. **Only topic0 separates them.** With the pin
the forward leg is unique (`[38]`); without it there are **two candidates and the reader refuses**
(`fee_forward_legs=2`). The pin was argued from an ABI shape and is now confirmed on real bytes.

⚠️ **AND AN HONEST LIMIT ON THIS RECEIPT.** The fee was located by matching the forward leg's value,
which selected log 34 — but a *positional* reader ("the first payer→TMWF leg") would have selected
34 too. **Position and the forward leg agree here**, so this receipt does not discriminate between
them. That discrimination lives in the mutation suite, not in this run.

## B7 — the mint landed, and it landed WHOLE

    Base Sepolia · USDC 0x036CbD53…CF7e · block 46351636 · 2026-09-03T21:39:20Z
    tx   0x84e859fd1d42ce4160465b95b323de2e50a563b184b871cbb0eb96112102d6d1
    from 0x0000…0000 (a MINT)   to 0xc54d4721…b4e621   value 1
    mint tx `to` = 0xe737e5ce…e275 (MessageTransmitterV2)

**G7 did not fire.** ⭐ **CORROBORATED ACROSS BOTH MIRRORS INDEPENDENTLY** — publicnode and tenderly
each returned exactly one mint to the recipient, same block, same value, same hash. A single mirror's
answer would not have been enough for an absence, and is not treated as enough for a presence either.

⚠️ **B7 CARRIES TWO CLAUSES, AND PR-3'S DISCIPLINE SAYS IT SHOULD NOT.** §"THE DISCIPLINE FROM PR-3
APPLIES" states that every row asserts one movement or one value; B7 asserts a movement **and** a
value ("a `Transfer` whose `to` is the SCA, of value exactly `A`"). PR-3 split those deliberately as
R7 and R8, because "it never arrived" and "it arrived at the wrong value" have different causes.
⭐ **Both clauses hold, so nothing was lost — but the discipline was stated in this document and not
followed by it.** Recorded as a defect in the pre-registration, not repaired.

## SETTLEMENT — MEASURED, one observation

    burn  Arc  block 60307336  21:39:09Z
    mint  Base block 46351636  21:39:20Z
    BURN -> MINT: 11 seconds

⭐ Identical to run 2's SLOW figure, to the second. ⛔ **TWO observations are still not a
distribution, and `MINT_TIMING` does not move.** Its copy — "usually under a minute; we stop calling
it routine after 4 minutes" — remains consistent with both and is not edited on them.

## ⛔⛔ WHAT THIS RUN DID NOT ESTABLISH — read before treating it as closure

**ATOMICITY IS STILL UNPROVEN.** §3 said so before the run and the run changes nothing about it: a
SUCCESSFUL batch exercises only the success path. *"Either both land or neither does"* is a claim
about the **failure** path — and every row above describes a burn that worked. B5's zero allowance is
consistent with atomicity and equally consistent with a non-atomic batch whose second call happened
to succeed. **Only an INDUCED failure discriminates them**: an expired quote, or a deliberate
shortfall, submitted as a batch, with the allowance read afterwards. That run is not written.

⚠️ **AND THE CLEAN RESULT IS EXACTLY WHEN THAT IS EASIEST TO FORGET.** Six rows green and a mint in
eleven seconds reads as "the design is proven"; what is proven is the design's happy path.
