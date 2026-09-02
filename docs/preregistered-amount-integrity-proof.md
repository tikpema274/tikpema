# PRE-REGISTERED — the live proof that the executed amount is the audited amount

Written **2026-09-02, before any run.** Nothing here has been executed. It is registered in advance
so the verdict cannot be chosen after seeing the result.

## What is being proved

Three fund-moving boundaries passed `.toFixed(2)` to the executor while the per-action cap, the day
ceiling and `recordAgentSpend` all used the unrounded value. They now pass `String(...)`. The claim
is: **the amount that moves on-chain equals the amount the cap checked and the ledger recorded.**

## ⛔ THE DISCRIMINATOR IS THE ON-CHAIN AMOUNT, NOT THE LEDGER ROW

The ledger was **never** the rounded side — it recorded full precision throughout (5 historical
rows prove it). So a ledger row showing `0.127` is consistent with both the fixed code and the
broken code, and **reading the ledger cannot pass or fail this test.**

⛔ For a **swap** the ledger is not merely uninformative but a different quantity entirely — it
records `valueInUsdc(tokenIn, amountIn)`, not `amountIn`. Run this proof on a `transfer_usdc` or a
`pay_for_service`, where the recorded field IS the executed amount, or the two sides are not
comparable even in principle.

The only reading that separates them is the amount in the on-chain transfer.

## The amount, and why this one

**0.127 USDC.**

- `Number((0.127).toFixed(2))` → **0.13**. It rounds **UP**, so the broken code moves **MORE** than
  requested — the cap-integrity direction, not the harmless one.
- The divergence (0.003) is well above dust and unambiguous in a block explorer.
  ⚠️ An earlier draft justified this size by comparison to a "largest over-send found in the ledger
  (+0.002941)". **That comparison is withdrawn** — it applied `toFixed(2)` to a swap's USDC-equivalent
  rather than to `amountIn`, which is the number the defect actually rounded. No historical
  divergence has been measured, so this amount is chosen on its own merits, not against a precedent.
- It is not a round number, so it cannot be confused with any other test transaction.

## Expected readings — all three must hold

| Reading | Expected | Under the OLD code |
|---|---|---|
| **On-chain transfer amount** (the discriminator) | `0.127` | `0.13` |
| Ledger `amountUsdc` for the entry | `0.127` | `0.127` (identical — proves nothing) |
| Audit row `source` | the step type, `allowed: true` | same |

**PASS** = the on-chain amount reads `0.127`.
**FAIL** = it reads `0.13`. There is no third outcome; a value that is neither means the test did
not do what this document describes, and the run is void rather than passing.

## Abort conditions — do not run, or stop, if any holds

1. **The change is not SERVED.** The bundle and the functions must be live first. A live money test
   against unshipped code proves only that absent code is absent — that has already cost 1 USDC once.
2. A deploy is in flight.
3. The wallet balance is below `0.127` + gas, or is exactly at a maximum — full precision now means a
   max equals the balance exactly, so an insufficient-funds failure would be expected behaviour and
   would not be evidence about this invariant.
4. The explorer cannot be read for the resulting hash. An unread amount is not a passing amount.

## ⚠️ Who runs it

**The user runs it.** Fund-moving proofs are not executed by the agent. This document exists to be
read *before* that, so the expected numbers are fixed in advance.
