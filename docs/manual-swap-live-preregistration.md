# PRE-REGISTRATION — the first user-signed SWAP, run live

**2026-08-30. Written BEFORE the run and BEFORE any deploy. THE OPERATOR RUNS IT.**
Nothing below this line is amended after the result. Code: `da3359b`. ⛔ **Not deployed.**

Every check behind this feature is static or simulated — `tsc`, three suites (27 + 46 + 27, all
zero-network), and `eth_call`. **No user-signed swap has ever run on this path.** This is the live
proof, and it is the operator's to run.

---

## ⭐ THE AMOUNT: **1.00 USDC.** And unlike the bridge, no threshold matters.

🚨 **THE BRIDGE'S TRAP DOES NOT EXIST HERE, AND THAT IS A MEASURED CLAIM.** The bridge run had to
be sized to cross a 25% fee band, and the first estimate (0.22) missed it by 0.36 of a point — because
Arc's bridge fee is *flat*, so the ratio moves with the amount. **A swap's costs are proportional**,
measured at three sizes today:

| amountIn | slippage (est → floor) | provider fee |
|---|---|---|
| 0.10 USDC | **3.00%** | 0.000020 (**2.00 bps**) |
| 0.25 USDC | **3.00%** | 0.000050 (**2.00 bps**) |
| 1.00 USDC | **3.00%** | 0.000200 (**2.00 bps**) |

⭐ **Both terms are constant in the amount, so the disclosure band cannot move with size. There is no
threshold to cross, and every assertion below is exercised identically at any amount.**

⚠️ **BUT GAS IS FLAT, SO SMALL IS NOT CHEAP** — it is the *inverse* of the bridge's shape:

| amountIn | gas cost | as a share of what you moved |
|---|---|---|
| 0.10 | 0.018434 USDC | **18.4%** |
| 0.25 | 0.018434 USDC | 7.4% |
| **1.00** | 0.018434 USDC | **1.86%** |

**1.00 USDC is chosen because a smaller amount saves nothing and tests nothing extra.** It also leaves
enough EURC behind to make the reverse direction a possible second run.

## ⭐ THE DIRECTION: **USDC → EURC.** It is effectively forced, not preferred.

**Gas on Arc IS USDC**, so any wallet funded enough to transact holds USDC by construction. **EURC
would only be there from a previous swap** — the login wallet almost certainly holds none, so the
reverse direction has no input token to spend. ⭐ It also leaves ~0.81 EURC behind, which is exactly
what a later EURC→USDC run would need.

## ⛔ WHAT IT COSTS YOU — measured today, not estimated

Arc `gasPrice` **21 gwei**; gas is paid in USDC (native 18-dp == ERC-20 6-dp, same asset).

| | gas | cost |
|---|---|---|
| **approve** (exact amount) | 56,241 | **0.001181 USDC** |
| **swap** | 821,588 | **0.017253 USDC** |
| **provider fee** (2.00 bps of 1.00) | — | **0.000200 USDC** |
| | | **TOTAL 0.018634 USDC** |

⭐ **The 1.00 USDC principal is CONVERTED, not spent** — it comes back as ~**0.813261 EURC**
(guaranteed floor **0.788863**). **Your net cost is ~0.0186 USDC plus the FX spread**, and the swap
gas dominates it. This is Arc **TESTNET** USDC — really spent, not mainnet funds.

**Prerequisite:** the MetaMask login wallet needs ≥ **1.02 USDC** on Arc testnet (1.00 principal +
~0.019 gas + headroom).

## ⚠️ WHAT THE 600s CLOCK MEANS FOR YOU — you are very unlikely to lose it, and losing it is cheap

⭐ **The design already spends the clock where it is cheapest: the quote is fetched AFTER the approve.**
The approve amount is the amount you typed, so the quote is not needed for it. That means the 600s
starts *after* the slow step (a MetaMask prompt plus an on-chain mine), not before it.

You get **≥580s** in hand: the server refuses to issue calldata at all with under 20s left
(`DEADLINE_SAFETY_MS`).

| if you are slow… | what happens | what it costs |
|---|---|---|
| the countdown reaches 0 **before you click** | ⭐ **the panel refuses cleanly** — the sign button disables and offers a fresh quote | **nothing.** Nothing signed, no gas. |
| you click near 0 and **linger in MetaMask** | the tx broadcasts after expiry → **the adapter reverts** (`DeadlineExpired()`, `0x1ab7da6b` — proven by differential `eth_call`) | **swap gas only, ~0.0173 USDC. The principal never moves.** |

⭐ **And a retry is CHEAPER than the first attempt.** The approve already landed and the exact-amount
allowance survives an expired quote, so `manualSwap` skips the approve on the retry: **~0.0173, not
0.0186.**

⚠️ **One honest limit:** the countdown runs on your browser's clock. Significant clock skew could make
the panel and the chain disagree at the margin — the chain is the authority, and its answer is the
clean revert above.

---

## PRE-REGISTERED PREDICTIONS

| # | predicted |
|---|---|
| 1 | ⭐⭐ the review shows the **decoded beneficiary IN FULL** beside your own address, and **they match** — full 42 characters both, not truncated |
| 2 | the disclosure band is **`none`** at an ordinary rate, so no acknowledgement step appears |
| 3 | the approve is **exact-amount** — allowance goes to exactly 1.000000 USDC, **not** a standing cap |
| 4 | the swap lands and **`amountOut` is read from the transaction's own logs**, and is **≥ the signed floor** of 0.788863 EURC |
| 5 | ⛔ that read is **pinned to the EURC contract address**, not to topic+recipient alone — Arc emits **two** Transfer logs per movement and an unpinned sum is ~1e12 wrong |

⚠️ **PREDICTION 2 IS THE LEAST CERTAIN, AND I COULD NOT COMPUTE IT IN ADVANCE.** The band values the
floor against `getTokenRates` — a rate source **independent of the swap quote's own routing price** —
and `CIRCLE_API_KEY` is masked by `netlify env:get`, so it could not be evaluated locally. The
prediction rests on arithmetic: the floor is 3.00% under the estimate, `warn` fires at 5.00%, so
there are ~2 points of headroom. ⭐ **If it fires anyway, that is falsifier 5 and it means the two
rate sources disagree by more than two points — itself a finding worth having.**

## 🚨 FALSIFIERS — each a finding, none a nuisance

1. **A truncated address in the review** → the one thing this panel exists to do, undone. MetaMask
   cannot show the beneficiary; a shortened `0x6Fb2…FC58` is not something a human can check against
   `0xdEaD…1234`, so a truncation returns the user to having no way to see where their money goes.
2. **A beneficiary that is not yours** → the measured hazard, live. ⛔ **STOP AND DO NOT SIGN.** The
   panel should refuse before offering the button at all; if it offers one anyway, the gate is
   decorative and every claim in `docs/swap-adapter-payer-beneficiary-unbound.md` needs re-examining.
3. **A standing allowance left behind** → check the allowance after the swap. It should be **0**
   (consumed exactly). A residue means the approve was not exact-amount, and an unbounded-in-time
   allowance to an **upgradeable proxy** is sitting on your own wallet.
4. **`amountOut` below the signed floor** → the contract did not enforce `minTokenOut`, which
   contradicts a measurement this whole design rests on.
5. **The band firing at an ordinary rate** → see prediction 2. Not a nuisance: it means the band's
   rate source and the quote's disagree materially, and the gate would be training click-through.

⛔ **AND THE RULE THAT GOVERNED THE BRIDGE RUN APPLIES: DO NOT ADJUST THE AMOUNT UNTIL SOMETHING
PASSES.** Fitting the input to the desired outcome is how an experiment stops being one. If it fails,
say so and stop.

## THE STEPS

1. ⛔ **Deploy first — it is not deployed.** ⭐ A **draft** deploy is enough to prove this and is the
   cheaper proving step: nothing here is scheduled, so the draft traps (scheduled functions do not
   fire; `COMMIT_REF` absent) do not bite. Prod after it passes, then `npm run gate:deployed`.
2. Open `#/swap-manual` with **MetaMask active** (or reach it from **Swap → "Swap from your own
   wallet instead"** — checking that link works is part of the run).
3. Enter **1.00**, direction **USDC → EURC**. Press **Get quote**.
4. 🚨 **STOP AND READ.** This is prediction 1 and the whole reason the panel exists: compare the
   **full** beneficiary address against your **full** own address, character by character. Record
   what the screen says — the floor, the implied loss, the countdown.
5. Press **Sign and swap**. Approve (MetaMask prompt 1), then the swap (prompt 2).
6. Afterwards record: the received amount vs the floor, and — for falsifier 3 — the **allowance from
   your wallet to `0xbbd70b01…`**, which should be back at 0.

## ⚠️ WHAT A PASS WILL NOT PROVE

- **That the decode catches a genuinely hostile server.** This exercises the **cooperating** path.
  The hostile case is proven in simulation only (`test:swapdecode`, a real re-encoded payload) and a
  live adversarial test is a separate exercise this run does not perform.
- **Anything about permit.** `permitType` stays `0`; the one-transaction path is untouched.
- **The reverse direction.** EURC→USDC is a second run, newly possible once this one leaves EURC.
- **That 0.0186 USDC is the cost at other sizes** — gas is flat, so the *fraction* changes sharply.
- **Anything on mainnet.** Arc testnet, Circle's sandbox routing.

---

# ✅ RESULT — 2026-08-30: **ALL FIVE PREDICTIONS HELD. NO FALSIFIER FIRED.**

Swap `0x2997749a8eedbc8376b85f3826c698a2978f00f7a587df08053152abdd906d1a`, block 59619631, status
success. 1.000000 USDC → **0.929280 EURC** against a signed floor of **0.901402**. Deploy
`6a943664e75f975fb8f03a89`. Nothing above this line is amended.

## Observed ON SCREEN BEFORE SIGNING — by the operator, the half only they could check

Beneficiary decoded from the calldata shown **in full beside their own address, character for
character, both untruncated**; band **`none`**; **591s** on the clock (quote-after-approve worked);
approve **exact-amount**.

## Verified afterwards, on-chain and read-only

| # | prediction | result |
|---|---|---|
| 1 | beneficiary in full, matching | ✅ decoded **from the signed transaction's own input**, not the quote: beneficiary == `tx.from` |
| 2 | band `none` at an ordinary rate | ✅ appeared, and reconciles exactly (below) |
| 3 | approve **exact-amount**, not standing | ✅ the `Approval` value was **1.000000 USDC** == `amountIn` |
| 4 | `amountOut` from the tx's own logs, ≥ floor | ✅ **0.929280 ≥ 0.901402** |
| 5 | pinned to the EURC contract | ✅ pinned — but see the honest limit below |

⭐ **The decode was re-run against the transaction that actually landed**, so the loop closes: what
the panel displayed and what was signed are the same bytes.

### ⭐ FALSIFIER 3 — THE ALLOWANCE IS **0**

`allowance(signer → 0xbbd70b01…)` reads **0** after the swap. The exact-amount approve was consumed
exactly. **No standing allowance to an upgradeable proxy was left on the user's own wallet** — the
property `agentSwap`'s cap-bounded design cannot offer here, and the reason manual approves are
exact-amount.

### GAS — the estimate was 27% HIGH, and that is worth recording

| | estimated | **actually paid** |
|---|---|---|
| approve | 0.001181 | **0.001164** (55,438 gas) |
| swap | 0.017253 | **0.012275** (584,507 gas) |
| provider fee | 0.000200 | 0.000200 |
| **total** | **0.018634** | ⭐ **0.013639 USDC** |

⚠️ The swap estimate (821,588) over-predicted actual (584,507) by 40%. `eth_estimateGas` under state
overrides is an upper bound, not a measurement — **the pre-registered figure was conservative in the
right direction, but it should not be quoted as "the cost" for future runs.**

### NO RECEIPT — established two ways, and the absence is CALIBRATED

- **By code:** `user-swap-start.mjs` obtains no store handle and performs no write; `buildSwapCallData`
  contains zero writers; the panel POSTs to exactly one endpoint.
- **By listing:** **0** keys in `job-deliverables`, `bridge-receipts`, `agent-quotes` or `agent-spend`
  mention the swap tx.
- ⭐ **THE CONTROL THAT MAKES THAT ABSENCE MEAN SOMETHING:** the same query finds **14** keys
  mentioning this signer in `bridge-receipts` — their earlier manual *bridges*. So the query can
  match this address; a zero elsewhere is a real absence, not a broken grep.
  [[absence-must-never-read-as-safe]]

⚠️ Minor: `user-swap-start.mjs` still calls `connectBlobs(event)` though nothing uses a store. Inert,
but it is a line implying a capability the handler does not use.

## ⚠️ THE HONEST LIMIT ON PREDICTION 5 — the pin was NOT exercised by this direction

🚨 **The Arc two-Transfer hazard IS present in this very transaction.** The native emitter
`0xffff…fffe` produced **7** Transfer logs at 18-dp mirroring USDC's **7** at 6-dp — the same
movements, twice, from different emitters.

⭐ **But it could not affect this read, because the OUTPUT was EURC**, which is a plain ERC-20 with no
native twin: 5 EURC logs, one emitter, exactly one of them to the signer. Pinned and unpinned sums
therefore coincided (ratio 1.000).

⛔ **So `amountOut` was read correctly, and the pin was not what made it correct.** The pin becomes
load-bearing on **EURC → USDC**, where the output token *is* the native one and an unpinned sum would
be ~1e12 wrong. **That direction is now possible** (this run left 0.929280 EURC) and is the test that
would actually exercise the guard.

## ⭐⭐ THE TWO PERCENTAGES ARE DIFFERENT MEASUREMENTS, AND THEY COMPOSE EXACTLY

The disclosure said **−4.22%** while the measured slippage floor is **3.00%**. Both are correct and
they are not the same quantity:

| | what it measures | against what |
|---|---|---|
| **3.00%** | the **contract's revert threshold** — how far below the quote's own expected output the fill may land | the **quote's own** `estimatedAmount` |
| **−4.22%** | the **guarantee valued in money** — the worst case the user is signing for | an **independent** rate source (`getTokenRates`), not the quote |

```
implied EURC rate behind −4.22%   = $1.06257
quote execution vs that mid-rate  = 1.2577%
1 − (1 − 3.0000%) × (1 − 1.2577%) = 4.2200%      ← the reported band, exactly
```

⭐ **This is the intended reading, and the composition is why the band is the more honest number.** A
quote could be priced terribly and still show exactly 3.00% slippage, because 3.00% is a property of
*Circle's tolerance*, not of the deal's quality. Only the independent rate can notice a bad rate at
all. ⛔ Two numbers that "ought to agree" would mean one of them was redundant — the whole value of
the band is that its rate source is **not** the quote's.

⚠️ And note which one is the disclosure: **−4.22% is the WORST CASE, not the expected outcome.** The
fill landed at the estimate, worth **−1.26%** at the same mid-rate. Disclosing the guarantee rather
than the expectation is deliberate — the floor is the number being signed.

## ⛔ WHAT THIS RUN DID NOT PROVE

- **That the decode catches a hostile server.** This was the cooperating path. The hostile case
  remains proven in simulation only (`test:swapdecode`, a real re-encoded payload).
- **The pin on a native-token output** — see above. EURC→USDC is the outstanding test.
- **Anything about permit.** `permitType` stays `0`.
- **That 0.013639 USDC is the cost at other sizes.** Gas is flat; the fraction changes sharply.
- **Anything on mainnet.**
