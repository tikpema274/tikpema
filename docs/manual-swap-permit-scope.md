# SCOPE — the permit (one-transaction) manual swap

**2026-08-31. Read-only. ⛔ NOTHING BUILT.** The follow-on named in
`docs/manual-swap-build-scope.md` Part 1, revisited now that the two-transaction path has run live
in both directions.

---

## 1. WHAT IS SETTLED SINCE THAT DECISION

| | |
|---|---|
| Arc USDC supports **EIP-2612 `permit`** | ✅ probed, three-way calibrated; the contract names the standard in its own revert (`"EIP2612: invalid signature"`) |
| the **adapter** accepts `permitType = 1` | ✅ `permitType:1` + a valid permit and **NO allowance override** → SUCCESS, with the no-permit control failing |
| the permit signature is a **bearer instrument** | ✅ measured — a stranger can submit it; ended by deadline **or** nonce consumption |
| both swap **directions proven live** | ✅ USDC→EURC and EURC→USDC, floors honoured, allowance 0 after each |

## ⭐ AND TWO OF THE THREE REASONS FOR DEFERRING ARE NOW SPENT

The build scope gave three reasons to ship two-tx first. Re-checked:

1. **Evidence asymmetry** — *partly spent.* The two-tx path now has two live runs; permit still has
   only `eth_call`. This reason survives, reduced.
2. **"Permit deletes the least dangerous thing while the most dangerous is unbuilt"** — ⛔ **SPENT.**
   The beneficiary decode is built, shipped, and exercised live twice.
3. **"Permit would put a new branch in `_swap.mjs`, the module that moves the AGENT's money"** —
   ⛔ **SPENT, AND IT WAS WRONG.** Verified: `buildSwapCallData` (line 238) has exactly one caller,
   `user-swap-start.mjs`. `agentSwap` keeps its **own** inline extraction with its own
   `tokenInputs` at line 467. **Permit touches no agent code at all.**

---

## 2. THE ARCHITECTURAL FORK — and only one branch survives

`permitCalldata` carries a signature **the user must produce**, but the **server** builds the
calldata today. Three ways to reconcile that:

| | |
|---|---|
| **(a) client signs the permit, server builds the final calldata with it** | ⭐ **the only one that survives** |
| (b) client assembles the adapter call itself | ⛔ **REJECT.** It puts the adapter ABI encoder in the browser AND makes the beneficiary decode meaningless — the client would be decoding its own construction. The check's entire premise is that it reads bytes *someone else* produced. |
| (c) server emits a placeholder, client splices the signature in | ⛔ **REJECT.** Byte-patching signed-adjacent calldata in a browser, and the decode then runs on patched bytes. |

⭐⭐ **(b) and (c) both destroy the prerequisite** this project spent a day establishing. That makes
the fork not really a choice — which is the useful outcome of scoping it.

### ⭐ THE ORDERING FALLS OUT, AND IT MIRRORS QUOTE-AFTER-APPROVE

The permit depends only on `owner`, `spender` (the adapter), `value`, `nonce` and `deadline` — **not
on the quote.** So the client can read `nonces(owner)` from chain, sign the permit, and POST it
*with* the quote request:

```
client: read nonce → build EIP-712 → assert computed domain == token DOMAIN_SEPARATOR → sign
POST /api/user-swap-start { tokenIn, tokenOut, amountIn, permit }
server: quote → build calldata with permitType 1 + permitCalldata → return
client: decode bytes, verify beneficiary, sign ONE transaction
```

⭐ **Still one server call**, and the 600s quote clock starts *after* the signature prompt — the same
property that made quote-after-approve right. ⭐ And the domain assertion is the calibration that
already worked in the probe: computed separator matched the token's on-chain value exactly.

---

## 3. 🚨 THE HONEST RE-ASSESSMENT — THE CASE HAS WEAKENED, NOT STRENGTHENED

The original case: *"it deletes the partial-completion window rather than managing it."* Measured
since, the window it deletes turns out to be smaller than feared:

| claimed benefit | what two live runs actually showed |
|---|---|
| deletes the approve/swap partial-completion window | ⚠️ the window **never materialised** in either run |
| removes a leftover allowance | ⚠️ the exact-amount approve returned to **0 both times** — nothing was left |
| "one user action instead of two" | ⛔ **still two prompts** — a typed-data signature plus a transaction |
| saves gas | **0.001164 of 0.016179 USDC — about 7%**, and the swap leg dominates |

**And it adds a cost the two-tx path does not have:** a **bearer credential crosses the network.** A
permit signature is submittable by anyone who holds it (measured), so it would live in browser
memory, in a POST body, and in anything that logs request bodies. ⛔ Bounded by a short deadline and
`value == amountIn`, but the two-transaction path creates no such artefact at all.

> ⭐ **So the balance moved: the benefit shrank under measurement while a new exposure appeared.**
> Permit is still architecturally cleaner and still deletes a real class of failure. It is no longer
> obviously worth doing next.

## ⛔ DECISION — TAKEN 2026-08-31: **HELD.** Not deferred by omission; held by decision.

The recommendation below was put to the operator and agreed. **Permit is not being built**, and the
three triggers are now the OPEN ITEM — the condition under which this reopens, rather than a vague
"someday". ⭐ Recorded so a future reader meets a decision with a reopen condition, not an
unfinished-looking scope they might restart from scratch.

**Do not build it now.** Not because it is wrong — because the two things it was going to buy have
both measured smaller than the argument assumed, and the one thing it costs is new.

⭐ **What would change the answer**, honestly stated so this is a decision rather than a stall:
- **a partial-completion actually happening** — an approve landing with the swap abandoned. It would
  make the window real rather than theoretical.
- **the approve becoming the expensive leg** — it is 7% today; on a chain or at a gas price where it
  is 40%, the arithmetic flips.
- **a UX complaint about two prompts** — a real user finding the second prompt confusing is worth
  more than my estimate of it.

⚠️ If it is built anyway, the design above is the one to build: **flow (a), permit-before-quote,
`value == amountIn`, a short deadline, the domain assertion client-side, and the request body never
logged.**

## ⛔ WHAT REMAINS UNPROVEN EITHER WAY

- **MetaMask will sign this typed data** for a token at `0x3600…0000`. Generic EIP-712 says yes;
  nothing has tested it.
- **The connector has no `signTypedData`** today — it exposes `signMessage` (personal_sign) for
  session auth only. That is the one genuinely new capability the change needs.
- **The nonce race.** The nonce is read at signing time; anything else consuming it makes the swap
  revert. Low risk for a single user, but a retry needs a fresh read, not a cached signature.
- **Two deadlines** — the permit's and the quote's — would need to be coherent, and nothing today
  reconciles them.
