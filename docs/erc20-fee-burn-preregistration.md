# PRE-REGISTRATION — the first ERC-20-`feeToken` burn on Arc

**Written 2026-09-03, BEFORE the burn runs.** Committed first so the prediction cannot be edited to
match whatever happens. Nothing here has been observed; every expectation below is derived from
verified source (`TokenMessengerWithFees.sol`, solc 0.8.24, 38 files) plus six real receipts that used
the *other* fee path.

⛔ **THIS IS THE GAP THIS DOCUMENT EXISTS FOR.** All 41 `depositForBurnWithFees` calls found on Arc,
and all six whose receipts were pulled, paid the fee **natively** (`msg.value`). The fee legs appear
only in the `0xffff…fffe` 18-dp stream; the ERC-20 emitter `0x3600…` shows **only the burn amount**.
Our path is the ERC-20 one — a gasless Circle SCA cannot attach `msg.value` — and **zero observed
transactions used it.** So the log shape we would reconcile against is *predicted*, not seen.

---

## 0. What produces the logs — the source, quoted

`_collectFeesAndBurn`, in order:

```solidity
_collectFees(correlationHash, requests, claim);                              // (1)(2)(3)
IERC20(p.burnToken).safeTransferFrom(msg.sender, address(this), p.amount);   // (4)
IERC20(p.burnToken).forceApprove(address(_TOKEN_MESSENGER), p.amount);       // (5)
_depositForBurn(p);                                                          // (6)
```

`_collectFees`, when `feeToken != address(0) && quotedFee > 0` — **the branch we take**:

```solidity
IERC20(feeToken).safeTransferFrom(msg.sender, address(this), quotedFee);     // (1)
IERC20(feeToken).forceApprove(address(_FEE_MANAGER), quotedFee);             // (2)
uint256 feeAmount = _FEE_MANAGER.collectFeesWithQuote{value: msg.value}(…);  // (3)
assert(feeAmount == quotedFee);
```

⭐ **The `assert` is why the reconciliation's claim is small.** Quoted-vs-collected is enforced
on-chain; a transaction where they differ reverts. What we can check afterwards is
**displayed-vs-submitted** — that the `feeTotalAmount` we showed is the one inside the quote we sent.

---

## 1. THE PREDICTION — exact logs, emitters, precisions

For a burn of **A** minor units with quoted fee **F** minor units, `feeToken = burnToken =
0x3600000000000000000000000000000000000000`, payer **P**, `TMWF = 0x8745D906…`:

| # | emitter | event | from → to | value | precision |
|---|---|---|---|---|---|
| 1a | `0x3600…0000` | `Transfer` | P → TMWF | **F** | 6 dp |
| 1b | `0xffff…fffe` | `Transfer` | P → TMWF | **F × 10¹²** | 18 dp |
| 2 | `0x3600…0000` | `Approval` | TMWF → FeeManager | F | 6 dp |
| 3 | `0x3600…0000` | `Transfer` | TMWF → FeeManager `0x08499fce…` | **F** | 6 dp |
| 3b | `0xffff…fffe` | `Transfer` | TMWF → `0x08499fce…` | F × 10¹² | 18 dp |
| 3c | — | — | FeeManager → `0xf992efcb…` → `0xb499efcd…` | F, then a **10 / 90 split** | both |
| 4a | `0x3600…0000` | `Transfer` | P → TMWF | **A** | 6 dp |
| 4b | `0xffff…fffe` | `Transfer` | P → TMWF | A × 10¹² | 18 dp |
| 5 | `0x3600…0000` | `Approval` | TMWF → TokenMessengerV2 | A | 6 dp |
| 6 | `0x3600…0000` | `Transfer` | TMWF → minter → `0x0` | **A** | 6 dp |
| 7 | `0xe737e5ce…` | MessageSent | — | — | — |
| 8 | `0x8fe6b999…` | DepositForBurn | — | — | — |

**The load-bearing prediction, stated as one line:**

> There will be an **ERC-20 `Transfer` from `0x3600…0000`, `P → TMWF`, of exactly `F` minor units,
> distinct from the `A` transfer**, and `F` will equal the `feeTotalAmount` of the quote submitted.

⚠️ **The 10/90 split values are carried from the NATIVE-path observation**, not from source. On
`0xff3afc0f…` the fee 152458 split as 15245 + 137212. Whether the same split appears on the ERC-20
path is part of what this run measures, not part of what it asserts.

---

## 2. WHAT WOULD FALSIFY IT

Any one of these means the prediction was wrong, and the reconciliation design has to change before
it is built:

1. **No `0x3600…` Transfer of value `F`.** The fee did not move as an ERC-20 transfer — separability
   in the ERC-20 stream is false, and the reconciliation would have to read the native stream.
2. **A single Transfer of `A + F`.** The fee is not separable at all; only a balance delta could
   recover it, and the proof drops to inference.
3. **The fee appears only natively despite `feeToken` being set** — the contract took the other
   branch, so our `feeToken` argument does not do what we think.
4. **`F` in the log ≠ `feeTotalAmount` in the submitted quote.** Would contradict the on-chain
   `assert`, and is the one outcome that is a finding about *Circle* rather than about us.
5. **No native twin for the fee.** Arc's dual emission does not apply to this path — narrower than
   assumed, and the emitter-pinning rule needs restating.
6. **More than one `0x3600…` Transfer of value `F`.** Ambiguity: the reconciliation could not tell
   which leg is the payer's charge without pinning `from`.

⛔ **A reconciliation summing `receipt.logs` without pinning the emitter double-counts by ~1e12** —
every movement appears twice, at two precisions, from two addresses. That is the single most likely
implementation error and it is loud, not subtle.

---

## 3. WHAT THIS RUN DOES NOT SETTLE

* **`minFinalityThreshold` FAST → SLOW.** A FORWARD-only quote selects `2000`. This burn will use it,
  so the run should record settlement latency — but latency is a *separate* pre-registered question
  and one observation is not a distribution.
* **Whether a gasless Circle SCA can submit this at all.** The ERC-20 path exists precisely because we
  cannot attach `msg.value`; that the SCA path can call `depositForBurnWithFees` with a `claim` tuple
  is itself untested.
* **The reconciliation's own correctness.** This run produces the artifact it will read. Building the
  reader against this one receipt would calibrate it on a single sample.

---

## 4. HOW TO RECORD THE RESULT

Append to this file, do not edit above it. State for each of the six falsifiers whether it fired, and
paste the receipt's full log table as read — not summarised. If a falsifier fires, the finding is the
falsifier, not a repaired prediction.

⭐ And record the values **verbatim at both precisions**. A result recorded only as "the fee matched"
is the conclusion without its input, which is unfalsifiable the moment retention expires.

---
---

# RESULT — appended 2026-09-03, nothing above this line edited

**The burn ran.** Wallet `VANILLA_SELLER 0x1a63e59d…18dc99` (not the agent wallet — a failed burn
would have left a standing allowance to a UUPS proxy on the wallet agent paths use, contradicting the
same-day decision that between-bridge permission stays zero).

    quote issuedAt 1788450294 · expiry.mode TIMESTAMP · expiresAt 1788450414 · window 120s
    feeTotalAmount 53971 minor · feeToken 0x3600…0000 (the ERC-20 path — zero prior observations)
    approve  53972 minor -> TMWF   tx 0x9bb5ce118df94785e72670c1a70670658d4e27c504ff8237b70a9f2000d0f3a9
    burn     amount 1 minor        tx 0xa47d22b806eb9facf4176994099a65f85744b6c9fadf3d1245784bb4ef651512
    status 0x1 · block 60266103 · gasUsed 398642 · 22 logs · submitted with 117s left in the window

## ⛔ FALSIFIER 6 FIRED — and the finding is the falsifier

> *6. More than one `0x3600…` Transfer of value `F`. Ambiguity: the reconciliation could not tell
> which leg is the payer's charge without pinning `from`.*

**Observed: TWO.**

    [1] 0x1a63e59d…18dc99 (payer) -> 0x8745d906… (TMWF)        53971
    [5] 0x8745d906… (TMWF)        -> 0x08499fce… (FeeManager)  53971

🚨 **AND THIS FALSIFIER CONTRADICTS THE PREDICTED TABLE IN THE SAME DOCUMENT.** Rows 1a and 3 of §1
predict *both* of those legs explicitly. So falsifier 6, as written, is triggered by the behaviour
§1 predicts — it is a **defect in the pre-registration**, not a finding about the contract.

⛔ **RECORDED AND STOPPED HERE.** The protocol says: if a falsifier fires, the finding IS the
falsifier — do not repair the prediction and do not proceed. Steps 5 and 6 were NOT run; the
settlement timing and the finality threshold are unmeasured. Rewriting falsifier 6 now, after seeing
the receipt, is exactly the edit a pre-registration exists to prevent. It needs a decision made
knowingly, not a patch.

⭐ What a corrected falsifier would have to say is *"more than one ERC-20 Transfer of value F **whose
`from` is the payer**"* — but that is a NEW prediction and belongs in a NEW pre-registration.

## THE OTHER FIVE — all held

| # | falsifier | fired? | evidence |
|---|---|---|---|
| 1 | no `0x3600…` Transfer of value F | **no** | log [1], payer → TMWF, `53971` |
| 2 | a single Transfer of A + F | **no** | no log of value `53972`; fee `53971` and amount `1` are separate |
| 3 | fee appears only natively despite `feeToken` set | **no** | present in BOTH streams |
| 4 | F in the log ≠ F in the submitted quote | **no** | `53971` == `53971` |
| 5 | no native twin for the fee | **no** | native [0], `53971000000000000` |

## THE TWO EMITTER STREAMS — reported separately, never merged

**ERC-20 — emitter `0x3600…0000`, 6 dp — 7 Transfer logs**

    [ 1] payer -> TMWF                53971    <- FEE
    [ 5] TMWF  -> FeeManager          53971    <- FEE (second leg)
    [ 9] FeeManager -> fee recipient   5397
    [11] FeeManager -> fee recipient  48574
    [13] payer -> TMWF                    1    <- AMOUNT
    [16] TMWF  -> token minter            1
    [19] token minter -> 0x0              1    <- burned

**NATIVE — emitter `0xffff…fffe`, 18 dp — 7 Transfer logs**

    [ 0] payer -> TMWF                53971000000000000    <- FEE
    [ 4] TMWF  -> FeeManager          53971000000000000
    [ 8] FeeManager -> fee recipient   5397000000000000
    [10] FeeManager -> fee recipient  48574000000000000
    [12] payer -> TMWF                    1000000000000    <- AMOUNT
    [15] TMWF  -> token minter            1000000000000
    [17] token minter -> 0x0              1000000000000

⛔ **EVERY MOVEMENT APPEARS IN BOTH STREAMS, 7 and 7.** Merging them would double-count the fee to
107942 minor and the amount to 2. The ~1e12 hazard is confirmed on real bytes, not inferred.
⭐ The 10/90 split carried over from the native-path observation held exactly: `5397 + 48574 = 53971`.

---

## ⚠️ CORRECTION, appended — GAS WAS NOT SPONSORED, AND I PREDICTED A BALANCE INSTEAD OF READING IT

Commit `2f4ed4e`'s message states *"Post-run: balance 0.260300 (delta -0.053972)"*. **That figure was
arithmetic, not a measurement** — `0.314272 − 0.053972` — written before the balance was read. The
measured balance is **0.248465 USDC, delta −0.065807**. A commit message cannot be edited after
pushing, so the correction lives here.

⭐ **THE 0.011835 GAP IS GAS, AND IT ACCOUNTS EXACTLY:**

    approve   gasUsed  55426  ·  effectiveGasPrice 30459500000  ->  0.001688 USDC
    burn      gasUsed 398642  ·  effectiveGasPrice 25453000000  ->  0.010147 USDC
    gas total ......... 0.011835
    fee + amount ...... 0.053972
    sum ............... 0.065807   == observed delta, residual 0.000000

🚨 **`from` ON BOTH RECEIPTS IS THE WALLET ITSELF — GAS WAS PAID, NOT SPONSORED.** That is 22% on top
of the fee, and it contradicts the premise this whole migration rests on ("our agents are gasless").

⚠️ **BUT IT IS A FINDING ABOUT THIS WALLET, NOT ABOUT THE PATH.** `VANILLA_SELLER` is an x402
spike wallet. `job-bridge-approve.mjs`'s own comment records the opposite for the agent wallet:
*"gas is SPONSORED: two prior successful bridges each dropped the wallet by EXACTLY 10.000000
(balanceOf delta, measured)"*. So **sponsorship is per-wallet**, and choosing a non-agent wallet to
isolate the allowance residue introduced a gas cost the shipped path would not pay.

⛔ **WHAT THIS DOES AND DOES NOT AFFECT.** The log-shape measurement is untouched — gas does not
appear in the Transfer streams and the fee/amount values are unchanged. What it changes is the COST
model for the migration: a bridge from an unsponsored wallet costs `amount + fee + gas`, and gas here
was ~0.0118 USDC for the two-transaction flow. Whether the agent wallet stays sponsored when calling
`TokenMessengerWithFees` — a NEW target — is **not** established by this run and must not be assumed
from the two old bridges, which targeted `BridgingKitContract`.
