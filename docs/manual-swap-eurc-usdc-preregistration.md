# PRE-REGISTRATION — the EURC → USDC swap, where the LOG PIN becomes load-bearing

**2026-08-30. Written BEFORE the run. Nothing below this line is amended after the result.**
Ships on the current build (`6a9448921e9f20e73bb04424`) — ⛔ **no deploy needed.**

The direction `docs/manual-swap-live-preregistration.md`'s result section named as outstanding: the
first run's output was **EURC**, a plain ERC-20 with no native twin, so the token-address pin was
correct but **was not what made it correct**. Here the output is **USDC — the native gas token** —
and an unpinned sum would be ~1e12 wrong.

---

## ⚠️ TWO CORRECTIONS TO THE BRIEF, both from re-deriving rather than reusing

**1. 🚨 You hold 8.719539 EURC, not 0.929280.** The 0.929280 was yesterday's swap *output*; the wallet
holds more than that swap put there. **Re-deriving is what caught it** — reusing the figure would have
sized the run against a balance that was never the constraint.

**2. USDC's two views differ below 6 dp, and that is expected.** `balanceOf` reads **66.776817** while
the native balance is **66.776817731878936817**. Not a mismatch: the ERC-20 view **truncates** the
18-dp native value. Yesterday's run compared equal only because that balance happened to be a round
13. ⭐ **This is the same two-views property the pin exists for, showing up on the balance side.**

---

## ⭐ THE AMOUNT: **1.00 EURC.** No threshold matters — CONFIRMED FOR THIS DIRECTION

The USDC→EURC run established that slippage and the provider fee are both proportional, so the
disclosure band cannot move with size. **That was measured in one direction only.** Re-measured here:

| amountIn | slippage (est → floor) | provider fee |
|---|---|---|
| 0.20 EURC | **2.9998%** | 0.000040 (**2.00 bps**) |
| 0.50 EURC | **3.0001%** | 0.000100 (**2.00 bps**) |
| 0.929280 EURC | **3.0000%** | 0.000186 (**2.00 bps**) |

⭐ **Both terms are constant in the amount in this direction too. There is no threshold to cross**,
and every prediction below is exercised identically at any size.

**1.00 EURC is chosen for legibility, not necessity:** a round input makes the output distinctive, and
🚨 **a 1e12 error is unmissable against it** — which matters for prediction 5. It also leaves ~7.7 EURC
for future runs rather than emptying the balance.

## ⚠️ GAS COMES FROM A DIFFERENT BALANCE THAN THE INPUT — and there is ample

This direction **spends EURC** while **gas is USDC**. The two are unrelated balances, so an input
that fits says nothing about affordability.

| | |
|---|---|
| gas needed (approve + swap) | **~0.018318 USDC** |
| USDC held | **66.776817** |
| headroom | ✅ **~3,600×** — not close |
| EURC needed | 1.000000 of 8.719539 held ✅ |

⛔ **The failure mode this rules out:** a wallet with plenty of the input token and no gas would fail
at the *approve*, before anything moved — cheap, but confusing if unanticipated.

## THE COST — measured, not estimated

`gasPrice` **21 gwei**.

| | gas | cost |
|---|---|---|
| approve (EURC, exact-amount) | 56,228 | **0.001181 USDC** |
| swap | 816,069 | **0.017137 USDC** |
| provider fee (2.00 bps of 1.00 EURC) | — | **0.000200 EURC** |
| | | **~0.018318 USDC + 0.0002 EURC** |

⚠️ **THESE ARE UPPER BOUNDS, AND LAST TIME THE SWAP LEG CAME IN 40% UNDER.** `eth_estimateGas` (here
under a state override for the allowance) over-predicted 821,588 against an actual 584,507 yesterday.
**Expect the real total to land nearer 0.013 USDC.** ⛔ Do not quote the estimate as "the cost" — it is
the ceiling, and it is stated as one.

## THE QUOTE, at 1.00 EURC

| | |
|---|---|
| estimated output | **1.336718 USDC** |
| **signed floor** (`minTokenOut`) | **1.296616 USDC** |
| slippage | 3.0000% |
| quote TTL | ~599s, and the quote is fetched **after** the approve |

---

## PRE-REGISTERED PREDICTIONS

| # | predicted |
|---|---|
| 1 | the review shows the **decoded beneficiary in full** beside your own address, **matched**, both untruncated |
| 2 | the disclosure band is **`none`** at an ordinary rate |
| 3 | the approve is **exact-amount** (Approval value == 1.000000 EURC) and the **EURC allowance is 0 afterwards** |
| 4 | the output is **at or above the signed floor of 1.296616 USDC** |
| 5 | ⭐⭐ see below — the point of the run |

### ⭐⭐ PREDICTION 5 — THE PIN DOES WORK, AND HERE IS THE NUMBER IT PREVENTS

The panel reads `amountOut` from the transaction's own logs, **pinning the token address first**. On
this direction the output is USDC, which on Arc is the native gas token — so the **same movement is
emitted twice**: once by the USDC ERC-20 contract at 6 dp, and once by the native emitter
`0xffff…fffe` at 18 dp. (Both emitters were observed doing exactly this in yesterday's receipt: 7
native logs mirroring 7 USDC logs.)

> **Predicted, for an expected output of `1.336718 USDC` (raw `1336718`):**
>
> | read | value |
> |---|---|
> | ⭐ **PINNED to the USDC contract** *(what the panel does)* | **1.336718 USDC** |
> | 🚨 **UNPINNED — topic + recipient only** *(the defect)* | **1,336,718,000,001.336718 USDC** |
> | ratio | **≈ 1.000e+12** |

⭐ **That is what makes this run prove the pin rather than merely include it.** The figure to record
is the panel's — but the falsifier is a number ~1e12 too large, and it would be unmissable.

⚠️ The exact figures scale with the fill, so record what the screen says; the **ratio** is the
invariant, not the digits.

## 🚨 FALSIFIERS — each a finding

1. **A truncated address in the review** → the panel's whole purpose, undone.
2. **A beneficiary that is not yours** → ⛔ **STOP, DO NOT SIGN.** The decode should refuse before
   offering a button at all.
3. **A standing allowance left behind** → the EURC allowance to `0xbbd70b01…` must be **0** after.
4. **Output below 1.296616 USDC** → the contract did not enforce `minTokenOut`.
5. ⭐ **An `amountOut` ~1e12 too large** → **the pin is not where I think it is.** This is the one the
   run exists for: it would mean the shipped read is summing the native mirror alongside the ERC-20
   log, and every USDC-output swap has been misreporting.

⛔ **Do not adjust the amount until something passes.** Fitting the input to the desired outcome is
how an experiment stops being one.

## THE STEPS

1. `#/swap-manual` with **MetaMask active** — or via **Dashboard → "Sign it yourself" → Swap**, which
   also exercises the new page shipped today.
2. Direction **EURC → USDC**, amount **1.00**.
3. 🚨 **STOP AND READ** — compare the full beneficiary against your full address, character by
   character. Record the floor, the band and the countdown.
4. Sign the approve, then the swap.
5. Record: **the received amount** (this is prediction 5 — a plausible ~1.33 or an absurd ~1.34e12),
   and the **EURC allowance** to `0xbbd70b01…`, which should be back to 0.

## ⚠️ WHAT A PASS WILL NOT PROVE

- **That the decode catches a hostile server** — the cooperating path again; the hostile case stays
  proven in simulation only.
- **Anything about permit** — `permitType` stays `0`.
- **That the pin is right everywhere** — it proves the *panel's* read. `_swap-confirm.mjs`'s agent-path
  read is a separate instrument, already audited but not exercised by this.
- **That 0.018 USDC is the cost** — it is the estimated ceiling; gas is flat, so the fraction changes
  sharply with size.
- **Anything on mainnet.**
