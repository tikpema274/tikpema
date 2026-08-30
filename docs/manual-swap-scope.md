# SCOPE — a manual (user-signed) SWAP alongside the agent swap

**2026-08-30. Read-only investigation. ⛔ NOTHING BUILT, nothing run, no quote fetched, no key read.**
Written against code at `6df17a1`. The unscoped item deferred by `docs/manual-send-design-note.md`'s
closing paragraph, which is quoted and **tested** here rather than repeated.

---

> # 🚨 READ THIS FIRST — THE GATING PRECONDITION
>
> **`createSwap` has returned `Route or resource not found. Details: No route available.` for
> USDC↔EURC on Arc testnet since ~2026-08-14** — five consecutive jobs, both directions, 4–5 USDC
> (`PROGRESS.md:6381`, `:6423`). **There is no later record of recovery**, and that entry is ~10 days
> old at the time of writing.
>
> ⛔ **While that holds, a manual swap cannot be quoted — let alone signed.** Every live proof this
> document asks for is blocked behind it, and so is the existing agent swap. Check it before
> anything else is decided; it is one HTTP request.
>
> ⚠️ Two honest limits carried forward from that entry: *"'their side' is INFERRED, not confirmed"* —
> every way it could be ours was eliminated, but Circle has said nothing. And the check is not free
> of cost: it needs the prod `KIT_KEY`, the 20-file live-credential dependency already flagged.

---

# 0. ⭐ THE FRAMING QUESTION, ANSWERED FIRST

> *"is a manual swap a NEW PANEL, or a signer choice inside the existing SwapPanel?"*

## **A NEW PANEL — but NOT because send and bridge each got one.**

Symmetry is the weak argument and it is not the one used here. The load-bearing fact is this:

🚨 **`SwapPanel.tsx` HAS NO QUOTE STEP AT ALL.** It is one-shot fire-and-forget: pick a token, type
an amount, press Swap → `w.swapFromAgent` → `POST /api/agent-execute-plan` → done
(`SwapPanel.tsx:35-60`). The user is never shown a rate, an output, a floor, or an expiry — before
OR after. The only number on screen is the one they typed.

A manual swap is a **three-request state machine with a signature in the middle**: quote → disclose →
sign (approve, then swap) → confirm. Putting that behind a toggle means one component holding two
disjoint state machines whose *entire* shared surface is two `<select>`s and a number input.

**And the two do not even read the same wallet:**

| | agent swap | manual swap |
|---|---|---|
| balances from | `w.agentWallet.balance` / `.eurcBalance` (served by `/api/my-wallet`) | the connected EOA |
| **EURC balance** | served | 🚨 **does not exist** — `metamask.ts`'s `refreshBalance` reads USDC only, and `useWallet.ts:629` maps `usdcBalance` to `mmBalance` with no EURC counterpart |
| caps | per-tx + day ceiling, enforced server-side | none — the user's own key, own funds |

⭐ **So a manual swap panel needs a new on-chain EURC read on the user's own wallet before it can
even render its "from" side.** That is not a toggle; it is a second data source.

## ⭐ ONE PLACE THE SEND NOTE'S REASONING DOES **NOT** TRANSFER — and it transfers in our favour

`manual-send-design-note.md` §3 found that *"`SendPanel.tsx` — the agent send, which IS capped —
NEVER MENTIONS THE CAP"*, so a manual panel saying *"caps do not apply here"* would contrast against
**silence**, and it made stating the cap on the agent panel a prerequisite.

**Checked: `SwapPanel.tsx:83-86` already says it** — *"Swaps run within your per-transaction and
daily safety caps."* ⭐ **The contrast target exists. The send note's step-1 prerequisite does not
apply to swap, and the ordering constraint it imposed is absent here.**

Likewise gap 2 (the two-state copy collapse) was fixed in the hook as the send note demanded —
`useWallet.ts:141` now exports `mmWallet`, and `:623` derives `isMetaMask` from it. **A manual swap
panel inherits the fix rather than re-shipping the defect.** Both blockers the send note left behind
are closed.

---

# 1. HOW THE AGENT SWAP WORKS TODAY

> *"Swap Kit server-side with a kit key, per the note?"*

## ⚠️ HALF RIGHT, AND THE HALF THAT IS WRONG IS THE HALF THAT EXECUTES

`_swap.mjs` holds **two different integrations** under one filename, and only the read-only one is
Kit-shaped.

### (a) PRICING — App Kit, kit key, server-side. ✅ as described.

```
new AppKit() + createCircleWalletsAdapter({apiKey, entitySecret})
  → kit.estimateSwap({ from:{adapter,chain,address}, tokenIn, tokenOut, amountIn,
                       allowanceStrategy:"approve", config:{ kitKey, slippageBps:100 } })
```
`kitAndAdapter()` `_swap.mjs:25-37` · `buildSwapParams()` `:99-124` · `estimateSwapOnly()` `:134-137`.
Free, moves nothing. **Call sites:** `_proposal.mjs:237` (pricing a proposal), `_analystb.mjs:140`
and `:196` (the forward and the round-trip sanity check).
`valueInUsdc()` `:61-91` also uses the kit — `kit.getTokenRates` — and is a **cap input at five
sites**, which is why it throws rather than returning NaN.

### (b) EXECUTION — 🚨 NOT `kit.swap()`. The "B1 path", three steps.

`_swap.mjs:12` states it outright: *"NOT kit.swap() — that path submits async and cannot be
confirm-gated."*

```
(A) allowance read → conditional approve(SWAP_ADAPTER, n) via createContractExecutionTransaction
(B) RAW POST https://api.circle.com/v1/stablecoinKits/swap   Authorization: Bearer <KIT_KEY VERBATIM>
      → { transaction: { signature, executionParams:{ instructions[], tokens[], execId,
                                                      deadline, metadata } } }
    → createViemAdapterFromProvider(READ-ONLY stub).prepareAction("swap.execute", …).getCallData()
    → { to, data }, HARD-asserted `to === SWAP_ADAPTER` before anything is submitted
(C) createContractExecutionTransaction({ contractAddress: cd.to, callData: cd.data })
      → authoritative Circle id
```
`agentSwap()` `_swap.mjs:171-346`. `SWAP_ADAPTER = 0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b`,
derived from a real fill's on-chain `Approval`, never inferred (`spike-find-swap-spender.mjs`).

### (c) CALL SITES — `agentSwap` has exactly ONE caller

`_actions.mjs:318`, inside `executeAction`. Reached from `agent-execute-plan` (which is what
`SwapPanel` posts to), `agent-act`, `job-swap-approve`, and `dca-tick` — all of which route through
`executeAction` so the cap/pause check cannot be dodged. `_dca.mjs:21` names this non-negotiable.

### (d) CONFIRMATION — `confirmSwapLanded`, `_swap-confirm.mjs:121`

Shared by `job-swap-receipt-background.mjs:149` and (historically) `dca-tick`. Two witnesses:
PATH 1 hash, PATH 2 a two-legged log-scan. Returns `amountOut`. Ambiguity fails closed.

---

## 🚨 A DEFECT FOUND WHILE ANSWERING (1) — the 1% slippage cap is not on the executing path

`slippageBps: 100` appears in `buildSwapParams` only, which is used **solely** by `estimateSwapOnly`
— the free estimate. **The `createSwap` HTTP body sends no slippage parameter at all**
(`_swap.mjs:262-266`), so the executed `minTokenOut` is whatever Circle's default produced.

⛔ **Two places state the 1% cap as the protection, and one of them is USER-FACING COPY:**

| where | what it says |
|---|---|
| `src/components/jobTimeline.tsx:431` | *"it is re-estimated at execution and a **1% slippage cap** makes the swap revert rather than fill at a bad rate"* — shown beside a proposal the user is about to approve |
| `_proposal.mjs:262` | the same sentence, in the field comment for `indicativeAmountOut` |

⚠️ **State the claim precisely, because the stronger version is not established.** What is proven is
that **our `slippageBps: 100` does not reach the swap that executes**; the bound is Circle's choice,
not ours. Whether Circle's default happens to be 1% is **not** measured here, and that is exactly the
point — a user-facing promise about a money bound is resting on a value this codebase no longer sets.
The B1 refactor moved the executing path and neither copy followed.
[[duplicate-source-of-truth-is-the-recurring-bug]]

⭐ Pre-existing and **independent of this scope** — but a manual panel would inherit the same wording
if it were copied across, which is how a stale claim gets a second home.

---

# 2. IS A USER-SIGNED SWAP A REUSE, OR A DIFFERENT INTEGRATION?

> *"router contract, slippage, approve?"*

## ⭐ IT IS OVERWHELMINGLY A REUSE — a SMALLER integration than the manual bridge was.

There is no new router, no new contract, no new SDK, and no new endpoint.

| piece | verdict |
|---|---|
| **quote** (`createSwap` HTTP) | ✅ **REUSE.** Already address-parameterised: `fromAddress` / `toAddress` are request fields. Pass the EOA instead of the agent SCA. |
| **calldata build** (`prepareAction` → `getCallData`) | ✅ **REUSE, unchanged.** It is pure `encodeFunctionData`; the provider stub *throws if called*, so it already cannot sign or submit (`_swap.mjs:295-299`). It emits `{to, data}` — **exactly** the shape `manualBridgeBurn` already hands to `walletClient.sendTransaction`. |
| **the adapter assert** (`cd.to === SWAP_ADAPTER`) | ✅ **REUSE, and worth MORE here.** It caught a real inner-DEX-leg false positive during B1. On a path where a human signs, a wrong `to` is a signature on a stranger's contract. |
| **client signing** | ✅ **REUSE the shape.** `manualBridgeBurn` (`metamask.ts:402-450`) is already: allowance read → conditional approve → wait → `sendTransaction(raw calldata)`. A swap is that with a different spender and target. |
| **confirmation** | ✅ **REUSE VERBATIM.** `confirmSwapLanded` is parameterised by `walletAddress / tokenIn / tokenOut / amountIn` and nothing else. Nothing in it is agent-specific. |
| **slippage** | ⚠️ **NOT a new integration — a new DECISION.** The bound already exists as `minTokenOut` in the quote (§3). Whether to make it selectable is a product choice, not a build. |
| **approve AMOUNT policy** | ⛔ **NOT reusable — see §5.** The standing-allowance-bounded-by-`swapCapUsdc()` design has no analogue when there is no cap. |
| **caps / ledger / day ceiling** | ⛔ **Deliberately absent**, same settled reasoning as manual bridge, manual send, `agent-withdraw`, `ub-withdraw`. And it must be **said**, since it sits beside a panel that states its caps. |

## ⚠️ THE ONE LOAD-BEARING UNKNOWN — and it is cheap and read-only to settle

**Does the AdapterContract accept an EOA as `msg.sender`?**

Every proven fill has been submitted by a Circle dev-controlled SCA. The quote carries
`fromAddress`, and `T.signature` covers `executionParams` — `spike-step4b`'s mechanism note records
that *"editing the signature-covered deadline would revert on SIGNATURE verification"*. Whether the
contract additionally requires `msg.sender == fromAddress`, and whether an EOA satisfies whatever it
does require, is **not established anywhere in this repo**.

⭐ **Settle it exactly the way `spike-step4c` settled the deadline: a differential `eth_call`.** Build
the calldata for an EOA, `eth_call` it from that EOA at the current head, and read the revert. No
broadcast, no gas, no signature. A `DeadlineExpired()`-style named revert discriminates; a success
answers it outright. ⛔ **Do not assume it and build on the assumption** —
[[probe-must-discriminate-between-states]] applies: name the other states that produce the same
reading before calling a probe evidence.

---

# 3. ⭐⭐ WHAT DOES THE PANEL OWE THE USER — and where the prior reasoning INVERTS

> The prior scope: *"a swap has a PRICE, not a fee … so its consent-vs-bound question is strictly
> harder than a fee's."*

## 🚨 THAT IS HALF WRONG, AND THE WRONG HALF IS THE IMPORTANT ONE.

### KNOWABLE BEFORE SIGNING — and two of the three are ON-CHAIN COMMITMENTS, not estimates

| number | source | status |
|---|---|---|
| estimated output | `q.estimatedAmount` (`_swap.mjs:324`) | an **estimate**. Moves. |
| ⭐ **`minTokenOut` — the FLOOR** | `EP.instructions[].minTokenOut`, inside the signed calldata | **signature-covered and CONTRACT-ENFORCED.** The adapter reverts below it. |
| ⭐ **`deadline` — the EXPIRY** | `EP.deadline`, inside the signed calldata | **signature-covered and CONTRACT-ENFORCED.** `DeadlineExpired()` `0x1ab7da6b`, **proven by differential `eth_call`** — identical calldata succeeds pre-deadline @52942858, reverts post @52943700 (`spike-step4c`). |
| TTL of that expiry | **MEASURED: `now + 600s` exactly, ±0.2s over 3 quotes** (`spike-step4-phase0`) | a stable 10-minute human budget, less the 20s `DEADLINE_SAFETY_MS`. |

### ⭐⭐ THE INVERSION

`docs/consent-fee-binding-scope.md` §4's residual is that **`maxFee` binds nothing after the
signature**: *"the window is not closed, only made one-directional."* The operator accepted
`0.054213` and was charged `0.054209` with no mechanism making that direction favourable — and no
recourse if it had gone the other way.

**A swap does not have that residual.** The two numbers that matter are inside the signed payload and
the contract independently refuses to execute outside them:

> **A user who signs a swap cannot receive less than the floor they signed, and cannot fill after the
> expiry they signed.** The bridge's operator had neither guarantee.

⭐ So on the *consent-vs-bound* axis the swap is **structurally easier**, not harder. The 600s TTL is
also generous where the bridge's fee *"moved four times in minutes"*.

⚠️ **What IS genuinely harder is the opposite side: there is no ceiling on the upside.** The user may
receive anything in `[minTokenOut, ∞)` and cannot know where until it lands. That is a **disclosure**
problem — what may honestly be promised — not a **consent** problem. The prior scope collapsed the
two; they separate cleanly, and separating them is what makes §4 answerable.

### KNOWABLE ONLY AFTER

The actual `amountOut`. Nothing else.

### ⭐ IS IT READABLE THE WAY `verifyMintOnChain` READ THE MINT? **YES — and it is already built.**

`confirmSwapLanded` already returns `amountOut`, read from `Transfer` logs. Structurally the same
instrument as `verifyMintOnChain` (`_receipt.mjs:180`): pin the token address, pin the `to` topic,
sum the value, 6-dp.

⭐ **AND IT IS ALREADY AUDITED AGAINST THE ARC HAZARD.** Arc emits **two** `Transfer` logs per
movement — an 18-dp native one from `0xffff…fffe` and the 6-dp ERC-20 one — and the exposed shape is
raw `receipt.logs`, which is exactly what `amountOutFromLogs` reads. `PROGRESS.md:72-76` records the
audit verdict: *"`_swap-confirm.mjs` … reads RAW RECEIPT LOGS — the exposed shape — and pins
`l.address` FIRST … ✅ safe, and it is the one that had to be."* **No new hazard, and it was checked
rather than assumed.** [[arc-emits-two-transfer-logs]]

⭐ **The manual path is STRICTLY BETTER than the agent path here.** `walletClient.sendTransaction`
returns a hash **synchronously**, so PATH 1 (hash) always applies. PATH 2's log-scan — and with it
the `ambiguous: N matching swaps` fail-closed branch that exists only because the Circle SCA submits
async and returns `txHash: null` (the 1098 quirk) — is **unreachable on a user-signed swap.**

### ⛔ SO, CONCRETELY, WHAT THE PANEL OWES

1. **The floor as the headline number, not the estimate.** `minTokenOut` is what the user is signing.
   An estimate shown large with a floor shown small trains the reader to the wrong figure.
2. **The expiry as a live clock**, not a static timestamp. 600s is generous *and* real; a quote that
   dies while the MetaMask prompt is open must read as expired, not as failed.
3. **After landing: actual received, compared against the floor.** The bridge's
   estimate→measured vocabulary already exists and must be **reused, not reworded** — a second
   wording of a claim about money is a second source of truth (`ManualBridgePanel.tsx:3-8`).
4. **That caps do not apply** — stated, because silence beside a capped panel reads as capped, and
   here the capped panel is one hash-route away and says so explicitly.

---

# 4. RECEIPT, ACK GATE, OR BOTH?

Argued from what each **buys**. The send note ran the two together because for send both answers
were no; **they separate for swap, and must be answered apart.**

## 4a. RECEIPT — ⛔ **NO.** Run the send note's three tests.

| the bridge's reason | does it survive? |
|---|---|
| delivery is on ANOTHER chain, establishable only by a server-side read | ❌ same-chain. Delivery **is** the transaction. |
| delivered ≠ sent, needing reconciliation | ⚠️ **THIS ONE SURVIVES** — `amountOut ≠ amountIn`. It is the test send failed. |
| an estimate must ADVANCE to measured through a record | ❌ the advance completes inside one `await`. |

**The surviving test does not carry the conclusion.** The bridge needed a *record* to reconcile
because its answer lived on another chain, minutes away, behind IRIS and a background settler. **A
swap's answer is in the logs of the very transaction the browser just awaited.**
`waitForTransactionReceipt` returns them; `amountOutFromLogs` is twelve lines and already written.
**The reconciliation the bridge needed a verifier for is in hand at the moment of confirmation.**

⛔ **And a receipt COSTS the write-after-sign window** — the bridge's *"stay on this page until the
burn confirms"* gap. Accepted there because the record is load-bearing; **unjustifiable here for a
record that resolves in the same tick.**

⚠️ **The AGENT swap's receipt is NOT evidence for a manual one, and the contrast is the argument.**
It exists because `agentSwap` returns `state:"submitted"` with `txHash: null`, and because the
day-ceiling is charged at submit so a later revert needs reversing (`_actions.mjs:330-340`, step 8).
**Neither applies to a user's own key: there is a hash immediately, and there is no ledger.**

⭐ What a receipt WOULD buy is a **swap history**. That is a product feature. Decide it on its own
merits; it must not borrow the bridge's justification.

## 4b. THE ACK **TOKEN** — ⛔ **NO.** And the mechanism, not symmetry, is why.

The token exists to bind **a server-computed number the client must not be able to choose**, because
on the bridge a client-chosen `maxFee` would *"let the caller pick the band its own acknowledgment is
checked against, making the gate theatre"* (`_bridge.mjs:293-294`).

🚨 **On a swap, the chain already enforces what the token would enforce.** `minTokenOut` and
`deadline` live inside a **Circle-signed** payload. A client that alters either gets a revert on
**signature verification** — the mechanism `spike-step4b` deliberately avoided touching for exactly
this reason. **An HMAC over a number the contract independently refuses to accept if changed is
ceremony around a bound that already holds.** Same conclusion as the send note, opposite reason:
send had no server-computed number; swap has one that is *self-enforcing*.

### ⚠️ THE CAREFUL PART — the one thing the signature does NOT bind

The signature binds *"this quote is authentic"*. It does **not** bind *"this is the quote you were
shown"*. A server could fetch quote A (good floor), display it, then fetch quote B (worse floor) and
hand over B's calldata — both validly Circle-signed, indistinguishable on-chain.

⛔ **But an ack token does not close that either, and cannot.** Our server both mints and checks the
token; **an HMAC we issue to ourselves proves nothing against ourselves.** The bridge's token is not
defending against that threat and never claimed to.

⭐ **WHAT WOULD ACTUALLY CLOSE IT — and it is strictly stronger than a token:** return the calldata
and the decoded floor **from the same quote object**, and have the **client decode `minTokenOut` out
of the calldata it is about to sign** and compare it to the number on screen. That makes the
disclosure **self-verifying** rather than **attested** — a check the client can perform *for itself*,
which the bridge's client could not be given.
⚠️ **The cost is real and must be weighed, not waved through:** it puts the adapter's `swap.execute`
tuple shape in the browser — a second source of truth for an ABI. **Flagged as a decision, not
recommended by default.**

## 4c. A DISCLOSURE GATE (blocking, no token) — ⭐ **YES, and this is the part that earns its place.**

The bridge's bands are ratios of a fee **taken from the amount**. A swap's honest analogue is the
**implied loss against the mid-rate**:

```
impliedLoss = 1 − (minTokenOut_in_USD / amountIn_in_USD)
```

⚠️ **AND THE ARITHMETIC HAS A TRAP THE BRIDGE'S DOES NOT.** USDC↔EURC is a **cross-currency** pair,
so the expected ratio is the **FX rate, not 1.0**. Comparing `minTokenOut` to `amountIn` directly
would flag *every* USDC→EURC swap as a double-digit loss and fire the gate on every swap — precisely
the *"box that always complains"* failure the band design exists to avoid
(`consent-fee-binding-scope.md` §4). The band must be computed against a mid-rate — `valueInUsdc` /
`getTokenRates` already provide one.

⭐ **And note what that means for trust, because it is a genuinely different requirement:** the
mid-rate is a server-computed number, but it is used **only to decide whether to interrupt the user**
— it never bounds the money. **A number that gates an interruption carries a different trust
requirement than a number that bounds a spend.** The money is bounded by `minTokenOut`, on-chain,
regardless of what the rate lookup says. A wrong rate produces a wrong *interruption*, never a wrong
*fill*. That is why the disclosure survives and the token does not.

⛔ **A rate that cannot be read must refuse, not default.** `valueInUsdc` already throws rather than
returning NaN, and for the documented reason: a NaN comparison is FALSE, so an unreadable rate would
silently mean "no band applies". [[nan-fail-open-cap-pattern]] · [[fail-safe-default-masks-a-missing-input]]

---

# 5. THE TWO-TRANSACTION APPROVE-THEN-SWAP WINDOW

## THE WINDOW

`approve(SWAP_ADAPTER, n)` lands; the swap tx never goes out — the user rejects the second MetaMask
prompt, closes the tab, or the 600s quote expires between the two prompts.

**No money has moved.** Same as the bridge: benign in the sense that the next attempt re-reads the
allowance and skips the approve. `manualBridgeBurn` already has exactly this structure and already
records why no receipt may be written between the two (`metamask.ts:395-401`) — **that reasoning
transfers unchanged, including the refusal to ever record an approve hash as a swap hash.**

## 🚨 BUT THE RESIDUE IS A DIFFERENT RISK OBJECT, AND THIS IS WHERE SYMMETRY BREAKS

| | manual bridge | manual swap |
|---|---|---|
| leftover allowance is to | `BRIDGE_CONTRACT` — Circle's BridgingKit | `0xbbd70b01…` — an **upgradeable EIP-1967 proxy** |
| what the repo knows about it | Circle's own | **813-byte proxy → impl `0xb4d0aa6c…` (17,729 bytes); live `owner()` = `0xfbc171f3…`; `paused()` present and false** — all DD-verified on two independent RPCs (`PROGRESS.md:6435`) |

⭐ **An allowance to an upgradeable contract is an allowance to whatever its owner deploys next.**

The **agent** path accepted a **standing** allowance to it with the trade written down:
*"worst-case blast radius for a malicious adapter goes from one in-flight swap to one cap —
deliberate, and still bounded"* (`_swap.mjs:194-199`). ⛔ **On the user's own wallet there is no cap
to bound it with**, so:

- **The manual approve MUST be exact-amount, never standing.** And Design-2's entire *rationale*
  evaporates independently: it exists to amortise an inline approve-wait against Netlify's **10s sync
  handler ceiling**. **The browser has no such budget** — the user is already waiting on two MetaMask
  prompts, and Arc's finality is sub-second.
- ⭐ **A genuinely NEW obligation, not a symmetry:** surface (and ideally offer to revoke) a residual
  allowance to an **upgradeable** spender. The bridge never owed this because its spender is not
  upgradeable. This is the one place the manual swap is strictly heavier than the manual bridge.

## ⭐⭐ AND THERE MAY BE NO SECOND TRANSACTION AT ALL

`allowanceStrategy: "approve"` exists in this codebase for **exactly one recorded reason**
(`_swap.mjs:113-117`):

> *"The agent wallet is a dev-controlled SCA. App Kit defaults to a USDC permit (EIP-2612) signature,
> but permits use ecrecover, which rejects an SCA's ERC-1271 signature."*

🚨 **A MetaMask EOA is precisely the case `ecrecover` accepts.** The constraint that forced two
transactions is an **agent-wallet** constraint that **does not exist on the manual path.** The B1
payload already carries the field: `tokenInputs = [{ permitType: 0, …, permitCalldata: "0x" }]` —
hardcoded to `PermitType.NONE` because the SCA had no alternative. A permit path would collapse
approve + swap into **one signature and one transaction**, and **the partial-completion window would
not exist to manage.**

⚠️ **UNPROVEN, and two separate things must be checked — do not conflate them:**
1. **Does Arc USDC support EIP-2612 `permit`?** ⭐ The repo has confirmed FiatTokenV2 supports
   **EIP-3009 `transferWithAuthorization`** on Arc (the vanilla x402 work). **That is a different
   function.** 2612 is adjacent, not implied. [[arc-usdc-supports-eip3009-vanilla-x402]]
2. **What are the non-zero `permitType` values and the `permitCalldata` encoding the adapter
   expects?** Unread — the SDK's `createFallbackTokenInput` is the only shape this repo has used.

Both are **read-only** questions.

⛔ **RECOMMENDATION: scope the two-transaction shape as the baseline** — it is proven, it reuses
`manualBridgeBurn`'s exact structure, and its window is understood. **File the permit as the named
follow-on that would DELETE the window rather than manage it**, and do not let it hold up the
baseline.

---

# 6. WHAT THIS SCOPE DOES NOT ESTABLISH

- **That a manual swap can run at all today.** §0's route drought is unresolved in the record and
  was not re-checked here (it needs the prod `KIT_KEY`). ⛔ Everything above is a design that has not
  been exercised, which is a materially different thing from a design that is ready.
- **That an EOA can be `msg.sender` to the adapter** (§2). Named, with a free read-only instrument.
- **That EIP-2612 permit works on Arc USDC** (§5). Named, with the adjacent-but-different finding it
  must not be mistaken for.
- **What Circle's default slippage actually is** (§1). What is established is only that **ours does
  not reach the executing swap** — the stronger claim was deliberately not made.
- **Any code.** Nothing was built, nothing was run, no quote was fetched, no credential was read.
