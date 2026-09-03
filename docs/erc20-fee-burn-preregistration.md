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
