# DEFECT — the "1% slippage cap" is told to users and is not what bounds the swap

**2026-08-30. Read-only. ⛔ NOT FIXED — deliberately.** Found while scoping the manual swap
(`docs/manual-swap-scope.md`, `3ccde08`) and **separated from it on purpose**: this is a live
user-facing claim on a money path, and it wants its own decision rather than a fix folded into a
feature scope.

---

## THE CLAIM, AS SHIPPED

`src/components/jobTimeline.tsx:429-432` — rendered beside a swap proposal the user is about to
approve:

> *"The rate is INDICATIVE, exactly like the bridge's fee — it is re-estimated at execution and a
> **1% slippage cap** makes the swap revert rather than fill at a bad rate."*

`netlify/functions/_proposal.mjs:261-263` carries the same sentence as the field comment for
`indicativeAmountOut`.

---

## ⭐⭐ IT IS AN OVERCLAIM, NOT AN UNVERIFIED CLAIM — and that distinction was the open question

Two separate things had to be established. **Both now are.**

### 1. OUR 1% DOES NOT REACH THE EXECUTING SWAP — established from CODE

`slippageBps: 100` appears in exactly one place: `buildSwapParams()` (`_swap.mjs:121`), which is used
by **`estimateSwapOnly()` alone** — the free, read-only estimate consumed by `_proposal.mjs` and
`_analystb.mjs`.

The **executing** path is the B1 path, and its `createSwap` request body carries no slippage field at
all (`_swap.mjs:262-266`):

```js
body: JSON.stringify({ tokenInAddress, tokenOutAddress, tokenInChain: "Arc_Testnet",
                       fromAddress: walletAddress, toAddress: walletAddress,
                       amount: amountBase })          // <- no slippage parameter
```

The floor that actually binds is `EP.instructions[].minTokenOut`, taken from Circle's response
verbatim. **Nothing this codebase sets determines it.** The B1 refactor moved the executing path off
`kit.swap()` and neither copy followed. [[duplicate-source-of-truth-is-the-recurring-bug]]

### 2. 🚨 CIRCLE'S ACTUAL TOLERANCE IS **3.00%** — MEASURED 2026-08-30

Four live `createSwap` quotes, both directions, two amounts. **Quote endpoint only — nothing signed,
nothing submitted, no gas.**

| pair | amountIn | `estimatedAmount` | `minTokenOut` | gap |
|---|---|---|---|---|
| USDC→EURC | 1.000000 | 850279 | 824771 | **3.0000%** |
| USDC→EURC | 5.000000 | 3995222 | 3875365 | **3.0000%** |
| EURC→USDC | 1.000000 | 1282748 | 1244266 | **3.0000%** |
| EURC→USDC | 5.000000 | 6399057 | 6207085 | **3.0000%** |

`ceil(0.97 × estimatedAmount) == minTokenOut` **exactly, in all four.**

> ⛔ **The copy understates the real tolerance by 3×, in the direction that flatters us.** It promises
> tighter protection than exists. It is **not** accidentally true.

⭐ **So the open question is closed: this is an OVERCLAIM.** Had Circle's default been 1%, the copy
would have been right by luck and this would be a comment-accuracy issue. It is 3%, and a user
reading that card is told their downside is bounded three times more tightly than it is.

---

## ⚠️ A SECOND-ORDER CONSEQUENCE, worth naming separately

The *number shown* and the *floor enforced* now come from **two different tolerances**:

- `indicativeAmountOut` on the proposal card derives from `estimateSwapOnly` — priced at **1%**.
- The swap that runs is bounded at **3%**.

So even the indicative figure is not the same quote family as the executed one. This is not the same
defect as the copy; it is what makes the copy *plausible* to a reader and to anyone maintaining it.

---

## ⛔ THE DECISION THIS DOCUMENT DOES NOT MAKE

Two honest endings, and they are not equivalent:

| | what it means | what it needs first |
|---|---|---|
| **(a) THE COPY COMES OUT** | stop claiming a bound we do not set. Describe what IS true: a floor exists, is inside the signed calldata, and is enforced on-chain — without naming a percentage. | nothing. Available immediately. |
| **(b) THE SLIPPAGE GOES IN** | send our own tolerance on the executing path so the copy becomes true. | 🚨 **unestablished: does `createSwap`'s HTTP API accept a slippage parameter at all?** The SDK's `config.slippageBps` is an App-Kit-level option; whether the raw endpoint honours one is unknown. |

⭐ **(b) has a cheap, decisive, read-only test** — send a slippage field and see whether the 3.00% gap
moves. A silently-ignored unknown field and an accepted one are distinguishable *because the floor is
observable*. ⛔ **Not run here**, because it belongs to the decision, not to the record of the defect.

⚠️ **And a caveat that bears on (a)'s replacement wording:** it is **not** established that 3% is a
fixed Circle default rather than a property of this route (`provider: "lifi"`, `tool: "fly"`). Four
quotes at one moment on testnet. **Both readings make the current copy wrong**, but only one of them
would let replacement copy quote "3%" as a number. ⛔ **Do not put 3% on screen on the strength of
this measurement** — that would repeat the original defect with a fresher number.
[[conversation-sourced-numbers-must-be-marked]] · [[repeating-one-instrument-is-not-corroboration]]

---

## WHAT ELSE THE PROBE SETTLED (recorded here so it is not re-measured)

- ⭐ **A swap has a FEE as well as a price**, and it is disclosed: `fees.provider` = **2.00 bps flat**
  (200 minor on 1.000000 in; 1000 on 5.000000 — proportional, exact at both). It is taken as its own
  instruction leg (`instructions[0]`, `amountToApprove == the fee`), which is why the swap leg
  operates on `amountIn − fee`. `_swap.mjs:324` already captures `fees` into `estimate` and **nothing
  ever surfaces it.**
- ⚠️ **`instructions[0].minTokenOut` is 0 and that is CORRECT** — it is the fee leg, not the swap leg.
  A reader (this one, first time) who checks index 0 alone concludes there is no floor at all. **Read
  every leg.** [[filtered-read-is-not-absence]]

---

## SEVERITY

**Not urgent, not ignorable.** No money has been mis-moved by it: the floor is real, enforced
on-chain, and 3% on a stablecoin pair is loose rather than dangerous. What is damaged is the
**record** — a user consented to a swap under a stated protection that is three times tighter than
the one they got, and the same sentence sits in a server comment where the next maintainer will
believe it.
