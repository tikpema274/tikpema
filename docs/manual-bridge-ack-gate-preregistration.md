# PRE-REGISTRATION — firing the manual bridge's ACK GATE live

**2026-08-29. Written before the run. THE OPERATOR RUNS IT; I set it up and did not execute it.**

## WHY THIS ONE, AND WHY BEFORE DEPLOYING ANYTHING ELSE

Every other property of the user-signed bridge has a live run behind it — the burn, the promote,
the four `verifyBurnOnArc` conditions, the routing fix, and the fee reconciling across six
independent sources (`PROGRESS.md:349`). **The acknowledge gate is the one part proven by suite and
injection only** (`PROGRESS.md:392`).

⭐ It is also the part that most needs proving, and it is **more necessary on the user-signed path
than on the agent one: the human eats the fee.** On the agent path a bad band costs the agent's
budget under caps the user already set; here it costs the user directly, and the gate is the only
thing standing between them and a fee they did not see.

⛔ **The manual SEND is built and committed but NOT deployed.** Shipping a second manual path while
the first has an unexercised consent gate is how gaps compound — so this closes first.

⚠️ **This run exercises the CURRENTLY DEPLOYED build**, which does not contain today's commits. That
is correct and not a limitation: today's work touches the connect/switch copy, `SendPanel`, and the
new send panel — **nothing on the ack path**. The gate being tested is the one that has been live
since 2026-08-28.

## ⭐ WHAT TO ENTER — RE-DERIVED FROM THE LIVE FEE, NOT FROM THE OLD ESTIMATE

```
  node scripts/bridge-ack-band-amount.mjs --route base     # run this FIRST, it is read-only
```

| | |
|---|---|
| **amount** | **0.15 USDC** |
| **destination** | **Base (Sepolia)** |
| fee, quoted live 2026-08-29T18:5xZ | **0.054217 USDC** |
| ratio | **36.14%** |
| band | **acknowledge** — fires |
| arrives on Base Sepolia | **0.095783 USDC** |

### 🚨 THE OLD ESTIMATE WAS WRONG, AND IT WOULD HAVE FAILED SILENTLY

The design note said *"roughly ≤0.22 USDC"*. At today's live fee:

```
  0.054217 / 0.22 = 24.64%   →   band "warn"   →   THE GATE DOES NOT FIRE
```

**0.22 misses the 25% band by 0.36 of a percentage point.** A run at 0.22 would have produced
`ackRequired: false`, which is *pre-registered below as falsifier 1 — "the band computation is wrong
live"* — and the finding would have been **false**: the band computation would have been perfectly
correct and the INPUT stale. ⭐ That is the whole reason for re-deriving, and it is why the script
imports the server's own `bridgeFee`/`bridgeFeeBand` rather than reimplementing the arithmetic.

### The arithmetic, shown

`bridgeFee` returns `maxFee = providerFee + forwarderFee`, where
`providerFee = ceil(minimumFee×100 × amountMinor / 1e6) × 1.1` and `forwarderFee =
forwardFee.high`. **On every Arc testnet route today `minimumFee` is `0`**, so the proportional term
vanishes and the fee is **entirely the flat forwarder fee**. Therefore:

```
  feeRatio = fee / amount            (fee constant in amount)
  fires when feeRatio >= 0.25  ⟺  amount <= fee / 0.25 = 0.054217 / 0.25 = 0.216868
  chosen 0.15  →  36.14%, i.e. 45% of headroom above the band
```

⚠️ **Flatness is MEASURED by the script (it prices at two amounts and compares), not assumed.** A
non-zero `minimumFee` would make the fee partly proportional and move the crossing point.

⭐ **Margin is FREE here and that is why 0.15 rather than 0.20.** Because the fee is flat, **the
exercise costs the same at any amount** — 0.20 would cost the identical 0.054217. A larger amount
buys only more USDC back on the far side, while a smaller one buys robustness against the fee
drifting down between the quote and the signature. The fee moved 0.054214 → 0.054218 → 0.054211 →
0.054217 across four calls while this document was being written.

## ⛔ WHAT IT COSTS YOU, BEFORE YOU RUN IT

| | |
|---|---|
| leaves your wallet | **0.15 USDC** |
| **fee — the actual cost** | **~0.0542 USDC** |
| arrives on Base Sepolia | **~0.0958 USDC** |
| plus | Arc gas (paid in USDC on Arc; a single ERC-20 approve + burn) |

**Net cost of exercising the gate: ~0.0542 USDC, plus gas.** This is **Arc TESTNET USDC** on the
Iris *sandbox* — really spent, but not mainnet funds. Prerequisite: the MetaMask login wallet needs
≥0.15 USDC plus gas headroom on Arc testnet.

## PRE-REGISTERED PREDICTIONS

| # | predicted |
|---|---|
| 1 | the quote returns **`ackRequired: true`** with a band **above `warn`** (i.e. `acknowledge`) |
| 2 | the disclosure renders showing the **exact fee** and the **exact net** |
| 3 | the panel **refuses to submit** until acknowledged — no signable calldata before the ack |
| 4 | the ack token is **server-minted and echoed back**, never computed in the browser |
| 5 | after promotion, **`ackAcceptedAt` is written from a REAL acceptance** — the property `verify-bridge-fee-band.mjs` §9 guards, which has **never had a live instance** |

⭐ **Prediction 5 is the one that matters.** §9 asserts that `ackAcceptedAt` is derived from the
BAND, never from the token, and is evidence of consent **only transitively** — because a refusal in
`_user-bridge.mjs` makes that line unreachable without a matching token. Every existing check on it
is an ordering assertion read from source. **A live instance is the first evidence that the
transitive argument actually holds in production.**

## 🚨 FALSIFIERS — each a finding, none a nuisance

1. **`ackRequired: false` at a fee that crosses the band** → the band computation is wrong live.
   ⚠️ Only a real finding if the script's own reading at the moment of the run said `acknowledge`.
   Re-run the script first, or this falsifier is unattributable — see the 0.22 trap above.
2. **The panel submits without acknowledgement** → the gate is decorative. The most serious outcome
   here: it would mean every "consent" record on this path is a record of nothing.
3. **`ackAcceptedAt` written when you did NOT acknowledge** → the exact defect §9 exists to prevent,
   observed live. It would mean the field reads as consent while being reachable without one.
4. **The fee does not cross even at the computed amount** → ⛔ **SAY SO AND STOP. DO NOT RAISE OR
   LOWER THE AMOUNT UNTIL IT CROSSES.** Adjusting the input until the gate fires is fitting the
   experiment to the desired result; the script exits non-zero rather than searching further, for
   this reason.

## ⚠️ WHAT A PASS WILL NOT PROVE

That the gate refuses a **forged or replayed** token live. The run exercises the cooperating path —
refusal, disclosure, acceptance, echo. The token is an HMAC bound to owner+destination+amount+band,
and a live forgery attempt is a separate exercise that this one does not perform. A pass means
**"the gate fires, discloses, blocks until accepted, and records a real acceptance"** — never
"the token cannot be forged".

## THE STEPS

1. `node scripts/bridge-ack-band-amount.mjs --route base` — read-only; confirm it still prints
   `band acknowledge` and take **its** amount, not this document's.
2. Open the manual bridge (`#/bridge-manual`) with **MetaMask active**.
3. Enter the amount, choose **Base (Sepolia)**, press **Get quote**.
4. **STOP AND READ**: the disclosure box should appear instead of a quote. Record what it says —
   this is prediction 2, and it is the screen a user would otherwise never see.
5. Press **"I understand — quote it anyway"**, then **Sign and bridge**.
6. Afterwards, read the receipt's `ackBand`, `ackRequired`, `ackAcceptedAt`, `feeRatio`.

---

# RESULT — 2026-08-29: the gate FIRED; prediction 2 FAILED; 4 and 5 not reached

Predictions 1 and 3 held (fired at 36.14%; refuses to quote until acknowledged). **Prediction 2
failed: the disclosure rendered no fee, no ratio, no net and no amount** — the panel discarded the
figures the server sent with the 409. No falsifier fired; falsifier 2 specifically did NOT occur,
as the gate refuses correctly.

⚠️ **Predictions 4 and 5 were not reached** — the operator stopped at the disclosure, as step 4
instructs. **Gap 1 is NARROWED, not closed:** `ackAcceptedAt` still has no live instance. A second
run against the fixed panel proves 2, 4 and 5 for a single fee.

Full record, and the blind-spot class that hid it, in PROGRESS.md. Nothing above this line is
amended.
