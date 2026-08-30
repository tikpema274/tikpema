# PRE-REGISTRATION — the manual send's first live run

**2026-08-30. Written BEFORE the run.** The operator runs it; the amounts and destination below are
fixed in advance.

## ⭐ WHAT THIS RUN ACTUALLY TESTS

Not the happy path — **the argued design.** The manual send shipped with three deliberate
ABSENCES, each reasoned in `docs/manual-send-design-note.md` and asserted by
`verify-send-copy.tsx`, and **none of them has ever met reality**:

| absent by decision | the argument it rests on |
|---|---|
| **no receipt** | delivery IS the transaction; amount received == amount sent; there is no estimate to advance |
| **no ack gate** | no fee is taken from the amount, so there is no band to disclose |
| **no "stay on this page"** | nothing is written after the signature, so leaving loses nothing |

⭐ A suite can prove the code does not write a receipt. **Only a live run can show that not writing
one was the right call** — that nothing downstream needed it.

## DESTINATION — `0x3cb76ac688f3fc02dfe4033d388989a44f132de9`

**This is the operator's own per-user agent wallet** (Circle-custodied SCA, `walletId
2e79ffe6-…`, created 2026-07-10), read from the `agent-wallets` store under
`owner:0x74b7b561…`. It is the address the Send panel already displays as "Sending from".

⚠️ **THE OBVIOUS CHOICE IS BLOCKED, AND IT IS BLOCKED BY DESIGN.** Sending to the MetaMask login
wallet itself refuses at `metamask.ts:358`:

> `if (dest.toLowerCase() === address.toLowerCase()) throw new Error("That's the wallet you're
> sending from — it would go nowhere.")`

So the login wallet cannot be the destination. ⭐ The agent wallet clears **both** guards: it is not
the login wallet (refuse-self) and it is not the SHARED agent wallet `0xc54d…e621`
(refuse-shared). It is an address the operator controls, and its balance is independently readable
on chain, which is what makes "received EXACTLY the amount sent" checkable.

## AMOUNT — **0.0123 USDC**

Small, and **deliberately a distinctive number.** Every other value moving through this account is
0.0001 (x402), 0.001 / 0.06 (DD probes), or 0.15 (the bridge). ⭐ A unique amount makes attribution
trivial in any later scan — the lesson from the Gateway flush investigation, where amount +
direction + timing were the *only* attribution available. Nothing else in this system moves
0.0123.

## BASELINE — captured before the run, block 59567243, 2026-08-30T07:06:02Z

| | USDC | native (18dp) |
|---|---|---|
| login wallet `0x74b7b561…` (sender) | **68.791284** | 68.791285 |
| agent wallet `0x3cb76ac6…` (recipient) | **6.000000** | 6.000000 |

Store key counts, so "no receipt" is falsifiable rather than assumed:

| store | rows |
|---|---|
| `bridge-receipts` | **55** |
| `data-budget` | **277** |
| `agent-wallets` | **57** |
| `x402-quote-pending` | **10** |

⭐ **AND THE STRUCTURAL CLAIM, WHICH IS STRONGER THAN THE COUNTS:** `ManualSendPanel` makes **no
authenticated call at all** — it never imports `agentClient`, never calls `ensureSession`, and
`sendUsdcManual` only touches `walletClient.writeContract`, `waitForTransactionReceipt` and a
balance refresh that reads the chain. **Nothing is sent to our server, so nothing can be written.**
The counts test that claim; they are not the claim.

## PRE-REGISTERED PREDICTIONS

| # | predicted |
|---|---|
| 1 | the review step shows the destination **IN FULL, untruncated, exactly as parsed** — the only safety net, since there is no allowlist |
| 2 | **no ack gate appears, and none should** — a same-chain transfer takes no fee from the amount |
| 3 | **no receipt is written** — all four store counts unchanged |
| 4 | the recipient receives **EXACTLY 0.0123 USDC**, no fee deducted → agent wallet 6.000000 → **6.012300** |
| 5 | **MetaMask shows the same destination and amount the review step showed** |

## 🚨 FALSIFIERS — each a finding

1. **A truncated or reformatted address in the review step** → the one safety net is decorative.
   ⚠️ `verify-send-copy` §7a asserts full-and-untruncated against a *rendered* box; this is the
   first time a human reads it on a real screen, which is exactly how the acknowledge disclosure's
   missing numbers were caught after every suite passed.
2. **MetaMask shows a different destination than the review** → ⛔ **CATASTROPHIC. STOP THERE. DO
   NOT SIGN.** It would mean the reviewed value and the signed value are different objects, which is
   worse than no review at all.
3. **Anything written to a store** → the no-receipt design is not what shipped, and the structural
   claim above is false.
4. **The recipient gets less than sent** → a fee exists that the copy denies, and the copy is
   telling users something untrue about their money.

## ⚠️ WHAT A PASS WILL NOT PROVE

That a **wrong** address is caught. This run sends to a correct, controlled address, so the review
step is exercised as a DISPLAY and never as an INTERCEPT. Its actual job — a human noticing a
corrupted paste — is untested by a run where the paste is clean, and remains untested after a pass.

⛔ Also unproven: refuse-self and refuse-shared. Both are guards this run deliberately does not
trip, and a guard that never refuses has not been shown to refuse.

## THE STEPS

1. Open `#/send-manual` with **MetaMask active** (a passkey-active wallet now says "Switch to
   MetaMask" rather than "Connect").
2. Paste `0x3cb76ac688f3fc02dfe4033d388989a44f132de9`, amount `0.0123`.
3. Press **Review**. ⭐ **STOP AND READ.** Compare the address on screen against the line above,
   character by character. This is prediction 1 and falsifier 1.
4. Press **Sign and send**, then **STOP AGAIN** and compare MetaMask's destination and amount
   against the review step before confirming. This is prediction 5 and falsifier 2.
5. Confirm. Report the tx hash.

---

# ✅ RESULT — 2026-08-30: all five predictions held. Tx `0x637b3556…`

⚠️ **THE RUN DEVIATED FROM THE PRE-REGISTERED INPUTS, AND THAT IS RECORDED FIRST.** The operator
used their own values: **1 USDC → `0x12B36dD2043C723543B44eEBF0900764fb17A29c`**, not 0.0123 to the
agent wallet. The predictions were therefore re-verified against the values actually used, not the
ones written down. ⭐ Nothing is weakened by this — the predictions were about BEHAVIOUR, not about
those particular numbers — but the "distinctive amount for later attribution" argument is void: 1
USDC is not distinctive. Attribution here rests on the tx hash instead, which is stronger anyway.

`0x637b355650a5d78a9672ffe0505f3ff7bd6bd09d46fbfbfbfa0e0a029ae20be6`, block **59568617**,
2026-08-30T07:17:55Z, status `0x1`.

## THE FIVE PREDICTIONS

| # | predicted | outcome |
|---|---|---|
| 1 | review shows the address IN FULL, untruncated | ✅ **observed on screen** — 42 chars, monospace |
| 2 | no ack gate, and none should appear | ✅ none appeared |
| 3 | no receipt written | ✅ **all four stores unchanged** |
| 4 | recipient receives EXACTLY the amount, no fee | ✅ **+1.000000 exactly** |
| 5 | MetaMask shows the same destination and amount | ✅ same address, Arc Testnet, from app.tikpema.xyz |

**Prediction 3, measured across the baseline:** `bridge-receipts` 55→55, `data-budget` 277→277,
`agent-wallets` 57→57, `x402-quote-pending` 10→10. ⭐ Consistent with the structural claim that made
the counts a test rather than the claim itself: `ManualSendPanel` makes no authenticated call, so
nothing could have been written.

**Prediction 4, measured across the exact block boundary** (59568616 → 59568617):

| account | before | after | delta |
|---|---|---|---|
| login (sender) | 68.791284 | 67.790256 | **−1.001028** |
| `0x12B36dD2…` (recipient) | 4425.151538 | **4426.151538** | **+1.000000** |
| agent wallet | 6.000000 | 6.000000 | ±0 |

⭐ **The sender's −1.001028 is 1 USDC plus 0.001028 gas; the recipient's +1.000000 is exact.** The
copy's claim — *"the recipient receives exactly the amount sent"* — is true, and gas being paid
separately is visible in the difference between the two deltas.

Independently verified from the calldata: `to` = the USDC contract, selector **`0xa9059cbb`**
(canonical `transfer(address,uint256)`), argument address == the reviewed destination, argument
amount == `1000000`.

---

## 🚨 FINDING — MetaMask displayed "1 Unknown", not "1 USDC"

**The cause is NOT our transaction shape, and that was established rather than assumed.**

| checked | result |
|---|---|
| `symbol()` on the token | ✅ returns **"USDC"** |
| `name()` | ✅ returns **"USDC"** |
| `decimals()` | ✅ returns **6** |
| contract code | 1798 bytes — a real contract, not an opaque precompile |
| our calldata selector | **`0xa9059cbb`** — the canonical ERC-20 transfer |

⭐ **The metadata is on chain and readable by one `eth_call`; our transaction is the standard shape.
There is nothing in what we send that could change the name MetaMask prints.** A different calldata
shape is not available — `transfer(address,uint256)` is the transfer.

⚠️ **THE HONEST LIMIT:** this establishes the cause is not on our side. It does **not** establish
what MetaMask does internally — that it relies on per-chain token lists or user-imported tokens
rather than reading `symbol()` at confirmation time is the plausible explanation, and it was **not
verified against their source.** Recorded as "not ours", not as "their bug".

### ⭐⭐ THE PRODUCT CONSEQUENCE, WHICH IS THE REAL FINDING

**A user checking only MetaMask cannot see WHAT they are sending — only how much.** That makes our
review step the **only** surface naming the asset.

🚨 This changes the review step's justification. `docs/manual-send-design-note.md` argued it earns
its place by showing the address *as we parsed it*, and explicitly said it "is not a second safety
net" over MetaMask's confirmation. **For token identity it is not a second net — it is the only
one.** The design note's reasoning was right about the address and incomplete about the asset.

⚠️ A user can make MetaMask show "USDC" by importing the token, but that is a per-user action we
cannot perform for them and must not assume anyone has taken.

---

## ⚠️ FINDING — Arc emits TWO Transfer logs per transfer, and a log-summing tool will DOUBLE-COUNT

This transaction's receipt carries **two** `Transfer` events for one movement, same sender, same
recipient:

```
Transfer  1000000000000000000  (1e18 — the 18-dp NATIVE view)
Transfer             1000000  (1e6  — the 6-dp ERC-20 view)
```

Same asset, two precisions — the "gas on Arc IS USDC" fact surfacing in the event log. **One
transfer happened; the recipient received 1 USDC.**

🚨 **ANY TOOL THAT SUMS `Transfer` LOGS ON ARC DOUBLE-COUNTS EVERY MOVEMENT**, and one that divides
by 1e6 uniformly prints a nonsense figure for the native-view log — as this session's own scan did,
rendering the first log as "1000000000000 USDC". It did no harm there (the question was existence,
not totals) but it is a live hazard for any future Arc balance or revenue scan.
[[arc-eth-getbalance-18-decimals]]

---

## ⛔ WHAT THIS RUN DID NOT TEST

- **The review step as an INTERCEPT.** The address used was correct, so the step was exercised as a
  DISPLAY only. Its actual job — a human noticing a corrupted paste — remains untested, and a pass
  here is not evidence for it.
- **refuse-self and refuse-shared.** Neither guard was tripped. A guard that has never refused has
  not been shown to refuse.
- **Any failure path at all**: no rejection in MetaMask, no insufficient balance, no invalid
  address. One clean run is one clean run.
