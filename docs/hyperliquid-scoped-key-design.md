# Scoped-key design — IF Hyperliquid trading is ever wanted

**STATUS: SKETCH. NOT BUILT, NOT SCHEDULED, NOT DECIDED.** The Hyperliquid work is scoped
**read-only** — analyse, present, let the user act — and a read-only analyzer needs none of this.
Recorded so the shape does not have to be re-derived, and so the costs are visible before anyone
starts rather than after.

## THE PREREQUISITE THAT FORCES THE QUESTION

Measured 2026-08-24: **a Circle dev-controlled wallet signs typed data only for the chain the wallet
lives on.** Four probes isolated it to the `chainId` alone — an arbitrary struct type signs, a zero
`verifyingContract` signs, Arbitrum (42161) and Hyperliquid (1337) both refuse. So the delegate EOA
— which IS an EOA, Circle-custodied — cannot sign a Hyperliquid order, and no plumbing changes that.

Trading therefore requires **a key held locally**, which would be a first:

```
private keys in production code : 0
private keys in .env            : 0
privateKeyToAccount usages      : test + spike files only, all generatePrivateKey() throwaways
```

`_x402.mjs` states the property outright: *"Circle custodies the key, so there is no local private
key."* This design exists only to answer: if that changes, what makes it defensible?

## ⭐ THE ORGANISING PRINCIPLE

> **Every boundary that matters must be enforced OUTSIDE the process that signs.**

This is why the current caps are credible: Circle is a second system that also has to agree.
In-process enforcement is one bug from bypass — a lesson this repo has paid for repeatedly. A design
whose only guarantees are its own code is not the same product.

## THE FOUR BOUNDARIES

### 1. Isolation — a SEPARATE NETLIFY SITE

⭐ Netlify env vars are per-**site**, not per-function. Today a key in the environment would be
readable by all 26+ functions that import `_circle.mjs`, by `dca-tick`, and by
`x402-vanilla-seller` — a **public, unauthenticated** endpoint that was armed on 2026-08-23 and
needed two guards on 2026-08-24 precisely because anyone can drive it.

Putting the trading function on its own site makes the key **structurally absent** from those
processes. Not "we are careful not to read it" — not in their environment at all. The main app
reaches it over HTTP, which is a shape already built and proven twice.

### 2. Privilege — a HYPERLIQUID API WALLET, not the account key

Hyperliquid supports approving a separate signing address that **places orders but cannot
withdraw**. Funds remain with the main account.

⭐⭐ THIS IS THE PIECE DOING THE REAL WORK, and it is enforced BY HYPERLIQUID. Without it the design
is just a key in a slightly better hiding place. **If this split is ever unavailable, the answer is
no** — not "build it more carefully".

⚠️ **A CORRECTION TO AN EARLIER CLAIM IN THIS THREAD:** it was said that "a leaked private key means
the funds are gone". For an API wallet that is **false** — it can be revoked and replaced. Revocation
exists here, which materially changes the risk picture; the earlier claim flattened it.

### 3. Funding — the cap enforced by arithmetic

Whatever sits on Hyperliquid is the entire loss ceiling. Everything else stays where it is.

⭐ That makes the real limit a **funding decision, not a constant**. Nothing to misconfigure, no
`NaN` to fail open — unlike `VANILLA_SELLER_SETTLES_PER_MIN`, which silently uncapped itself in its
first draft ([[nan-fail-open-cap-pattern]]).

### 4. Approval — BOUND TO A PRICE, AND EXPIRING

The existing propose→confirm template, plus the one thing a trade needs that a send does not: **the
approval names a price and dies when the market moves past it.**

The precedent is already in the repo — the vault gate's 409 carrying a FRESH disclosure,
`diffDisclosure` computing which value moved and from what to what, and the **`unexplained`** branch
for a refusal none of the digest inputs accounts for. Ported: approving at a stale price returns
**409 with the new price and the delta**, never silent execution at whatever is current.

⚠️ And approval must stay expensive enough to mean something. A loop that suggests constantly turns
approval into a rubber stamp — the human version of a tolerated red, which the guard registry already
names as the worst of its three failure species.

## THE RECORD AND THE KILL SWITCH

* **External anchor:** Hyperliquid's `userFills` is the `getTransaction` equivalent — an
  authoritative account of what actually filled, independent of what we logged. Every spend today
  has an authoritative Circle id; a locally-signed action would otherwise have only our own word.
* **Kill switch:** revoking the API wallet, exchange-side. ⚠️ `agent-pause` stops our function from
  INITIATING; it cannot stop a key that already exists. Only revocation can.
* **Refusals:** `makeRefuser` applies unchanged — the refusal vocabulary and the audit trail are
  domain-agnostic.

## WHAT STAYS IRREDUCIBLE

1. **A key exists somewhere it did not before.** Isolation shrinks the blast radius; it does not
   remove it, and this repo's own history is a catalogue of paths reaching further than expected.
2. **Analysis → suggestion is INFERENCE.** Strategy type is a hypothesis: a basis trade, a
   directional short and a spot hedge are indistinguishable in a position object. The approval gate
   is the only thing preventing a hypothesis from becoming a position unattended.
   ⭐ Read-only keeps `INDETERMINATE ≠ FAIL` usable; a trading loop forces it to resolve.
3. **`liquidationPx` is CROSS-MARGIN** — a suggested position moves the liquidation price of
   positions already held. Presenting per-coin risk in isolation would be plausible and wrong.
4. **A second deployment surface** to build, deploy and monitor, in a repo where deploys currently
   run 40–60 minutes.

## THE DECISION THIS DOCUMENT IS NOT MAKING

Nothing here argues FOR building it. The scoping decision — analyse only, let the user act — was
made deliberately and is strengthened by the chainId measurement: a read-only analyzer needs no
wallet, no key and no custody, and every Hyperliquid endpoint probed on 2026-08-24 was free and
unauthenticated. It is the only work currently on the table that nothing else blocks.
