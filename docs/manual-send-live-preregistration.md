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
