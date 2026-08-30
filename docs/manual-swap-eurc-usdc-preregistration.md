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

---

# ✅ RESULT — 2026-08-30: **PREDICTION 5 HELD. THE PIN DID WORK.** And one real defect found.

Swap `0x75c4d6a6afd86c837087d1378531c8994b9de4d9e47828a5ecd6504672699ae3`, block 59641706, success.
1.000000 EURC → **1.356968 USDC** against a signed floor of **1.316260**. Nothing above this line is
amended.

## ⭐⭐ PREDICTION 5 — MEASURED ON THIS TRANSACTION, NOT PREDICTED FROM THE LAST ONE

Two Transfer emitters logged the same delivery to the signer:

| emitter | value |
|---|---|
| `0x3600…0000` — USDC ERC-20, 6 dp | `1356968` |
| `0xffff…fffe` — native mirror, 18 dp | `1356968000000000000` |

| read | result |
|---|---|
| ⭐ **PINNED to the USDC contract** *(what shipped)* | **1.356968 USDC** |
| 🚨 **UNPINNED — topic + recipient only** | **1,356,968,000,001.356968 USDC** |
| ratio | **1.000e+12**, exactly as pre-registered |

> ⭐ **The pin excluded 1,356,968,000,000 USDC of native-mirror double count.** On the USDC→EURC run
> the pinned and unpinned sums coincided, so the pin was correct but idle. **Here it did the work.**

## The rest, verified

| | |
|---|---|
| beneficiary, decoded from the **landed input** | `0x74b7…24E5` == `tx.from` ✅ |
| output ≥ signed floor | 1.356968 ≥ 1.316260 ✅ |
| approve exact-amount | Approval value **1.000000 EURC** == `amountIn` ✅ |
| **EURC allowance after** | **0** ✅ falsifier 3 cleared |
| gas paid | **0.016179 USDC** (swap 714,996 + approve 55,438) vs the **0.018318 upper bound** — under ✅ |
| receipt written | none. 0 keys in four stores mention the tx; ⭐ the same query finds **14** keys naming this signer in `bridge-receipts`, so the absence is calibrated ✅ |

## ⭐ THE FLOOR THAT MOVED — a re-quote, and the SIGNED floor is the one the final review showed

Review showed **1.290776**; the result showed **1.316260**. **The landed calldata carries 1.316260**,
so the signed floor is the later quote's — a re-quote before signing, consistent with the countdown
and with quote-after-approve. ⛔ **No stale floor was signed.**

---

# 🚨 THE FINDING — AND IT INVERTS THE HYPOTHESIS. THE GATE IS FINE; THE SENTENCE IS WRONG.

**The question asked: is the band computed from the same number the panel displays, or a different
one?** Traced through the code:

```
user-swap-start.mjs:103   band = swapLossBand({ amountInUsd, minOutUsd })
                  :113-114  returns  band: band.band,  impliedLoss: band.impliedLoss
ManualSwapPanel   :288     <SwapReview band={quote.band} impliedLoss={quote.impliedLoss} …/>
                  :293     GATES on   quote.band
                  : 68     DISPLAYS   pct(impliedLoss)
```

⭐ **THE SAME NUMBER, from one call, returned in one object.** They cannot disagree. The gate is not
reading a different quantity, and it has **not** been banding something that can never reach 5%.

## ⭐⭐ THE VALUE WAS NEGATIVE, AND `none` WAS CORRECT

Reproduced from the observed screen (floor 1.290776 on 1.000000 EURC in, showing −11.64%):

```
implied getTokenRates EURC price   = $1.15619
swapLossBand({amountInUsd: 1.15619, minOutUsd: 1.290776})
   impliedLoss = -11.64%    band = "none"
   -0.1164 >= 0.10 ? false      -0.1164 >= 0.05 ? false
```

**The floor was worth MORE than the input at the mid-rate.** A negative implied loss is a *gain*, and
`none` is the right answer. ⭐ **And the band is fully capable of firing:** +6% → `warn`, +12% →
`acknowledge`, verified by calling it directly.

## ⛔ SO THE DEFECT IS THE COPY, AND IT IS A REAL ONE

```jsx
That guarantee is <b>{pct(impliedLoss)}</b> below the mid-market value of what you are spending.
```

The word **"below" is hardcoded** while the number carries its own sign. At −11.64% the sentence
renders *"is −11.64% below the mid-market value"* — which a careful reader parses as **an 11.64%
loss**. It is an 11.64% **gain**. 🚨 **The operator read it exactly that way, and was right to.**

⚠️ **A gate that correctly stays silent beside a sentence that reads as alarming is worse than
either alone**: it teaches that the gate is broken, which is the opposite of the truth.

### 🚨 WHY NO SUITE CAUGHT IT — every fixture was POSITIVE

`verify-manual-swap-copy` renders `SwapReview` three times, with `impliedLoss` of **0.0312, 0.03,
0.14 / 0.07**. ⛔ **A negative value was never rendered**, so the sentence was never seen in the state
where its wording fails. The suite asserts *"the implied loss is stated as a percentage"* and that is
true of `-11.64%` — the assertion passes on the broken output.
[[state-behind-a-transition-is-untested-by-default]]

## ⚠️ AND A SECOND-ORDER FINDING: THE TWO PRICE SOURCES DISAGREE WILDLY ON TESTNET

Measured live, both directions, 1.000000 in:

| | |
|---|---|
| pool, USDC→EURC | 0.808636 EURC → implies EURC = **$1.23665** |
| pool, EURC→USDC | 1.266665 USDC → implies EURC = **$1.26666** |
| `getTokenRates` (inferred from the run) | **$1.15619** |
| ⭐ **round trip** | 1 USDC → **1.024271** USDC = **+2.43%** |

🚨 **The pool does not round-trip** — it prices EURC differently in each direction, and a round trip
"gains" 2.43%. So on this testnet the mid-rate check is not a meaningful *economic* check; it is
structurally doing its job while the two sources it compares are far apart.
⛔ **This does not excuse the copy defect** — it is why the negative case is reachable at all, and
therefore why the wording was always going to be exercised eventually.

## ⛔ NOT FIXED — as instructed. What a fix must decide

- **The sentence must carry the sign in words**, not a signed number inside a fixed "below".
- **Whether a large negative deserves its own disclosure.** A guarantee far ABOVE mid-market is not
  automatically good news — it can mean the rate source is stale or the pool is mispriced, which is
  exactly what the round-trip measurement shows. Silence may not be the right answer either.
- **The suite must render a negative fixture**, or the next wording will have the same blind spot.
