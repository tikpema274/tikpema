# SECURITY FINDING — the swap adapter does not bind the PAYER to the BENEFICIARY

**2026-08-30. Read-only, measured. ⛔ NOT FIXED — reported for a decision.**

Recorded on its own because **it is true today, on the live agent path, independent of whether a
manual swap is ever built.** It surfaced as a control in the manual-swap scoping (probe C), but it is
not a property of that scope.

---

## THE FINDING

**Measured** on Arc testnet against AdapterContract `0xbbd70b01…`, by `eth_call` (nothing signed,
nothing submitted, no gas):

> A swap payload issued for address **X** — `createSwap` called with `fromAddress`/`toAddress` = X —
> **executes successfully when submitted by a completely different address Y**, pulling `tokenIn`
> from **Y** and delivering `tokenOut` to **X**.

So the two roles are decided by two different things and **nothing ties them together**:

| role | decided by |
|---|---|
| **who PAYS** | `msg.sender` — i.e. whoever signs and submits |
| **who RECEIVES** | `executeParams.tokens[].beneficiary`, inside the Circle-signed payload |

⭐ **CORROBORATED BY A SECOND, DIFFERENT KIND OF INSTRUMENT** — not by repeating the same one. Circle's
own SDK says it outright in `@circle-fin/provider-stablecoin-service-swap`, in the doc comment for
`createFallbackTokenInput`:

> *"The contract derives the token owner from `msg.sender`, so no `from` field is needed."*

A measurement and the vendor's own source, agreeing. [[repeating-one-instrument-is-not-corroboration]]

⚠️ **This is not a bug in the adapter.** Deriving the payer from `msg.sender` is a normal, reasonable
design — it is *why* no `from` field exists. The finding is about **what a caller must therefore check
for itself**, which is a different claim from "the contract is wrong".

---

## ⭐ IS THE AGENT PATH EXPOSED? — checked in code, not assumed

**Through its own inputs: NO. Verified, not "probably not".**

The beneficiary originates from the `toAddress` that `_swap.mjs` sends to `createSwap`, and that value
is `walletAddress` — traced to its source:

| step | value | caller-controllable? |
|---|---|---|
| `_swap.mjs:265` `toAddress: walletAddress` | the agent's own wallet | — |
| `_actions.mjs:318` `agentSwap({ walletAddress, … })` | `walletAddress` resolved from the **session**, server-side | ❌ |
| the `swap_tokens` step vocabulary | `tokenIn`, `tokenOut`, `amountIn` — **and nothing else** | ❌ |
| `_proposal.mjs:206` `validateSwapProposal` | tokens from **our** allowlist; `walletAddress` from `ctx`, never from `raw` | ❌ |

⛔ **There is no recipient field anywhere in the swap step vocabulary.** A model, a plan, or a client
cannot name one, so no caller-supplied value reaches the beneficiary. The exposure this finding would
otherwise create **does not exist on the agent path today.**

## 🚨 BUT THERE IS A RESIDUAL, AND IT IS ONE LINE WIDE

`agentSwap` hard-asserts the calldata's **destination**:

```js
if (!cd || String(cd.to).toLowerCase() !== SWAP_ADAPTER) throw new Error("B1 adapter assert failed …");
```

⛔ **It never asserts the BENEFICIARY.** It asks Circle for `toAddress: walletAddress` and then trusts
the response's `EP.tokens[].beneficiary` without checking that what came back is what it asked for.

**Why the existing assert would not catch it:** a payload with a foreign beneficiary still targets the
adapter, so `cd.to` is still correct and the guard passes. The two failures are independent, and only
one is guarded.

**What it would take to bite:** a wrong or tampered `createSwap` response — a Circle-side defect, or a
response altered in transit. **Not reachable by our own callers**, which is why this is a residual and
not a live vulnerability. But the trust boundary is real: *we currently trust an API echo for the
address that receives the money.*

⭐ **The fix is the same shape as the guard already there** — assert the returned beneficiary equals
the wallet we asked for, and refuse otherwise. It costs nothing, it fails closed, and it converts
"we asked for X" into "we verified we got X". ⛔ **Not applied here** — it is a money-path change and
wants its own decision, like the slippage copy.

⚠️ **And it must check every entry**, not `tokens[0]`. The payload carries two: one per token leg.
Checking index 0 alone is the filtered read that already misled this investigation once
([[filtered-read-is-not-absence]]). Only the `tokenOut` entry's beneficiary matters, and it must be
selected by token, not by position.

---

## ⭐⭐ WHERE IT WOULD BITE HARD: ANY USER-SIGNED SWAP

On a manual path the calculus inverts, because the **user** becomes `msg.sender` and the **server**
supplies the payload:

- The user signs calldata that says *"pull from me, deliver to `beneficiary`"*.
- 🚨 **MetaMask cannot show them the beneficiary.** It renders an opaque contract call to the adapter —
  a `to` address and a calldata blob. The destination of their money is not visible anywhere in the
  signing prompt.
- So a server bug, a compromised response, or a malicious operator could hand a user a payload that
  spends the user's funds into someone else's wallet, and **the signing UI would look completely
  normal.**

⭐ This is exactly the job the manual send's confirm step already does — *"showing the address AS WE
PARSED IT, catching a truncated or whitespace-damaged paste before it reaches MetaMask"* — and it is
why `docs/manual-swap-scope.md` §4b was upgraded there from *a decision* to **required**: the client
must decode the beneficiary out of the calldata it is about to sign and show it.

⚠️ Note the ordering consequence: **this must be settled before a manual swap ships, not after.** It
is the one place where the manual path is strictly more dangerous than the agent path, and it is not
an argument against building the manual swap — it is a named prerequisite of building it.

---

## SEVERITY

**No live exposure. A real trust boundary, currently unguarded.**

Nothing today can reach it: the agent path admits no recipient input, and no user-signed swap exists.
It is recorded now because (a) the missing assert is cheap and fails closed, and (b) it becomes
load-bearing the moment anything user-signed touches this adapter — at which point discovering it
would be much more expensive.
