# BUILD SCOPE — the manual (user-signed) swap

**2026-08-30. The path question settled first, then the build. ⛔ No code written yet.**
Follows `docs/manual-swap-scope.md` (design) and `docs/swap-adapter-payer-beneficiary-unbound.md`.

---

# PART 1 — THE DECISION: **two-transaction approve-then-swap. Permit second.**

## ⚠️ FIRST, A CORRECTION TO THE FRAMING — permit does not save a prompt

| | prompts | on-chain transactions | waits |
|---|---|---|---|
| **approve → swap** | **2** (approve tx, swap tx) | 2 | 2 |
| **permit → swap** | **2** (typed-data signature, swap tx) | **1** | **1** |

⭐ A permit is still a **signature the user must read and approve**. What permit removes is one
*transaction*, one *wait*, and the partial-completion state between them — **not** one user action.
The case for it is real but it is smaller than "one action instead of two".

## ⭐ THE EXPOSURE COMPARISON — measured today, and it FAVOURS permit

All three properties probed read-only (local keygen + `eth_call`, nothing broadcast):

| | **approve** leftover | **permit** leftover |
|---|---|---|
| what exists if the swap never runs | a **real on-chain allowance** | ⭐ **nothing on-chain** — a signature in browser memory |
| bounded in **amount** | yes (exact-amount — never standing, see below) | yes (`value`) |
| bounded in **time** | ⛔ **NO — forever, until a revoke transaction** | ✅ **YES — the deadline, and WE choose it.** Measured: past-deadline reverts `"FiatTokenV2: permit is expired"` |
| other way it ends | a revoke tx, which costs gas | ✅ **nonce consumption.** Measured: with the nonce already advanced the same signature reverts `"EIP2612: invalid signature"` |
| who can act on it | the adapter — an **upgradeable proxy** with a live `owner()` | the adapter, once submitted |
| 🚨 if it LEAKS | n/a — it is already public and on-chain | **a BEARER authorization. Measured: a stranger can submit it** (`SUCCESS` from an unrelated `from`, and with no `from` at all) |

**So, stated fairly in both directions:** permit's residual is bounded on **both** axes and is **zero in
the normal case** (the user rejects or closes the tab and nothing ever touched the chain), where the
approve's residual is unbounded in time and always real. ⚠️ **But permit introduces a leak surface
that does not exist today** — a bearer credential living in browser memory, and in transit if the
design ever POSTs it anywhere. It trades an *unbounded but inert and public* on-chain residue for a
*bounded but bearer* off-chain one. **On exposure alone, permit is the better design.**

## ⛔ AND YET: BUILD THE TWO-TRANSACTION PATH FIRST. Three reasons, in weight order.

### 1. The evidence asymmetry lands exactly where being wrong costs the user their principal

Every permit result is `eth_call`. **So is the two-transaction result** — but its *shape* is not new:

- **allowance read → conditional approve → wait → send raw server-built calldata** is precisely what
  `manualBridgeBurn` (`metamask.ts:402`) already does **in production, from the browser, with a real
  user's key.**
- **`permitType: 0` + a live allowance** is precisely what `agentSwap` already does **in production,
  server-side, every time the agent swaps.**

⭐ **The two-transaction manual swap is two proven components composed. It introduces no new
mechanism.** Permit introduces one — at the authorization step, the single step where an error costs
the user their money rather than their time. *"A simulation that succeeds is not a signature that
lands"* is the user's own framing and it is correct; it bites hardest on the path with no production
twin.

### 2. ⭐⭐ Permit deletes the LEAST dangerous thing here, while the MOST dangerous thing is unbuilt

`docs/manual-swap-scope.md` §5 already established that the approve leftover is **benign and
self-healing**: no money has moved, and the next attempt re-reads the allowance and skips the approve.

Meanwhile the *measured* hazard on this path is the **beneficiary**: the adapter does not bind payer
to beneficiary, and MetaMask renders an opaque adapter call in which the destination of the user's
money **is not visible**. ⛔ **Spending the first build on optimising the safe part, while the
dangerous part does not exist yet, is the wrong order.** Part 2 is where the risk actually is.

### 3. Permit would put a new branch in `_swap.mjs` — the module that moves the AGENT's money today

The two-transaction path needs **no change to `agentSwap` at all**: a new endpoint reuses the B1
extraction the way `_user-bridge.mjs` reuses `bridgeCallData`. A permit path instead needs the
hardcoded `tokenInputs[].permitType = 0` to become conditional, inside the live agent swap path.
⛔ **A manual-swap feature must not be the reason the agent's production authorization step grows a
branch.**

## ⭐ THE RECOMMENDATION, STATED PLAINLY

> **Build two-transaction approve-then-swap now. Ship it. Land one real user swap.**
> **Then build permit as a scoped follow-on** — same panel, same disclosure, same beneficiary decode,
> changing *only* the authorization step, with its own pre-registration and its own live proof.
> Permit is the better destination; it is not the right first version.

### Two design points that fall out of the decision

- ⛔ **EXACT-AMOUNT APPROVE, NEVER STANDING.** Design-2's standing allowance is bounded by
  `swapCapUsdc()` — and there is **no cap on a user's own funds** to bound it with. Its rationale
  (amortising an approve-wait against Netlify's 10s sync ceiling) also does not exist in a browser.
- ⭐ **FETCH THE QUOTE *AFTER* THE APPROVE, NOT BEFORE.** The approve amount is the amount the user
  typed — the quote is not needed for it. Ordering it *allowance check → approve → wait → quote →
  swap* starts the 600s quote clock **after** the slow human-plus-mine step, removing the only real
  timing pressure in the flow. Free, and it makes expiry a non-issue in the normal case.

---

# PART 2 — THE PREREQUISITE: client-side beneficiary decoding

⛔ **Not a feature. A precondition of shipping any user-signed swap.** Build before the panel.

## WHAT IT MUST DECODE, AND FROM WHERE

🚨 **From the CALLDATA BYTES THE USER IS ABOUT TO SIGN — never from the quote JSON the server
returned.** The entire threat is that the response disagrees with the request. Reading the pretty
fields beside the bytes proves nothing about the bytes; only decoding the bytes does.

| field | why the user needs it before signing |
|---|---|
| ⭐ **`beneficiary`** (tokenOut leg) | **the destination of their money.** MetaMask cannot show it. |
| **`minTokenOut`** | the floor they are committing to — the number they are actually signing |
| **`deadline`** | when the authorization dies |
| `amountIn` | what leaves their wallet |

## THE RULES IT INHERITS

- ⭐ **Select the tokenOut entry BY TOKEN, never by index** — the same rule as the server assert
  (`d6f5221`), for the same reason: `instructions[0]` is the fee leg, and index-0 reading already
  produced a wrong conclusion twice in this investigation.
- ⛔ **Ambiguity refuses and refuses LOUDLY** — the panel must not offer a signature it cannot
  describe. "Cannot decode" blocks the button; it never degrades to "sign anyway".
- **Compare against the connected wallet address**, and render it *as we decoded it*, in full —
  the same job the manual send's confirm step does for a pasted address.

## ⚠️ THE SECOND-SOURCE-OF-TRUTH OBJECTION, ANSWERED

This puts the adapter's `swap.execute` tuple shape in the browser, next to the server's copy. The
standing rule is that a claim copied into two places drifts.

⭐ **It does not apply here, and the distinction is the point.** The rule is about a *claim* copied
into a second place. This is not a copy of a claim — it is an **independent derivation of the same
fact from the authoritative bytes, on the other side of a trust boundary.** The server's assert
(`d6f5221`) checks Circle's response against the server's request; the client's decode checks the
*bytes it is about to sign* against the *user's own address*. Neither can stand in for the other, and
if they ever disagree that disagreement **is the finding**. Corroboration, not duplication.

⚠️ Drift is still a real cost and is paid deliberately: a test must pin the two decoders against one
real payload, so a tuple change that updates one and not the other fails loudly.

---

# PART 3 — THE PANEL

Built last, on top of a decode that already works.

| # | step | notes |
|---|---|---|
| 1 | **EURC balance on the MetaMask path** | `metamask.ts` reads USDC only; `useWallet:629` maps `usdcBalance` to `mmBalance` with no EURC counterpart. The panel cannot render its "from" side without this. |
| 2 | **`POST /api/user-swap-start`** | Session-authed. Server prices, builds the B1 calldata for the **caller's own** address, runs `assertSwapBeneficiary`, and returns calldata + the disclosure figures. ⭐ Reuses the extraction; **no change to `agentSwap`.** ⛔ No caps — the user's own key and funds, same settled reasoning as manual bridge/send, and it must be **said** because `SwapPanel` beside it states its caps. |
| 3 | **`manualSwap()` in `metamask.ts`** | Mirrors `manualBridgeBurn`: allowance read → conditional **exact-amount** approve → wait → `sendTransaction(calldata)`. ⛔ Carries over its re-arm rule verbatim: once a swap hash exists, the sign control is **removed** — a user must never re-sign to fix a record. |
| 4 | **The disclosure gate** | Blocking, **no ack token** (`manual-swap-scope.md` §4b: the chain already enforces what a token would, and an HMAC we mint and check ourselves proves nothing against ourselves). ⚠️ The band is implied loss **against the mid-rate** — USDC↔EURC is cross-currency, so comparing `minTokenOut` to `amountIn` directly would fire on every swap. An unreadable rate **refuses**, never defaults. |
| 5 | **Result** | ⛔ **No receipt** (§4a). `waitForTransactionReceipt` returns the logs synchronously; read `amountOut` from them by pinning the token address — the Arc two-Transfer hazard is handled exactly as `_swap-confirm.mjs` handles it. Show **received vs floor**. |
| 6 | **Route + link** | `#/swap-manual`, **linked from `SwapPanel`** — a live route nothing links to is the state that hid `#/dca` for 22 days. Titles distinguish the wallets: *"Swap from your agent wallet"* vs *"Swap from your own wallet"*. |

## ⛔ EXPLICITLY OUT OF SCOPE FOR THIS BUILD

- **Permit / one-transaction.** The named follow-on, with its own pre-registration.
- **`_swap.mjs`'s `permitType`.** Stays `0`.
- **A swap history.** A product feature; it must not borrow the bridge receipt's justification.
- **The slippage copy decision.** Still open, still separate (`docs/swap-slippage-copy-overclaim.md`).
- **The tokenIn-leg beneficiary.** Still unchecked on both sides; recorded, not silently skipped.
