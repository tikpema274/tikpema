# SCOPE — is `maxFee` a CEILING, or charged in full?

**2026-08-29. Read-only scoping. ⛔ NOT RUN.** The unknown named in
`docs/consent-fee-binding-scope.md` §4, which decides both the sizing of the freshness window and
how the disclosure should be worded.

## THE QUESTION, AND WHY ONE DATUM CANNOT ANSWER IT

Burn `0x265be6d3…` delivered `0.095791 == 0.15 − 0.054209` — **the full `maxFee` was taken.** But
that is consistent with *both* hypotheses, because on Arc the two collapse:

```
minimumFee = 0  →  scaledBps = 0  →  baseFee = 0  →  providerFee = 0
maxFee = providerFee + forwarderFee = forwarderFee exactly
```

With `providerFee = 0` there is **no +10% buffer**, so `maxFee` *is* the actual fee by construction.
"Charged in full" and "a ceiling that happened to equal the fee" predict the identical observation.
⭐ **The two hypotheses only separate where `maxFee > actual`, i.e. where `minimumFee > 0`.**

## ⭐ MEASURED FREE TONIGHT: NON-ZERO ROUTES EXIST, INCLUDING ON TESTNET

Two unauthenticated GETs per route against Iris. No spend, no session.

| route | FAST (1000) `minimumFee` | STANDARD (2000) |
|---|---|---|
| **Arc → anything** (testnet) | **0** on every route probed | 0 |
| Ethereum → Base / Arbitrum / Polygon | **1** | 0 |
| Base → Ethereum / Arbitrum / Polygon | **1.3** | 0 |
| Arbitrum → Ethereum / Base / Polygon (mainnet) | **1.4** | 0 |

🚨 **Two things follow, and the second is the awkward one.**

1. **Non-zero routes are reachable on TESTNET** — `Base → *` reports 1.3 on the sandbox. So this
   does **not** require mainnet money.
2. **⛔ OUR CODE CANNOT REACH THEM.** `bridgeFee` hardcodes `ARC_CCTP_DOMAIN` as the source, and
   every Arc route reports 0. **No burn through this app can exercise a non-zero `minimumFee`**,
   today or at any amount. A self-burn is not a cheap experiment — it is a code change first.

## WHAT WOULD SETTLE IT, CHEAPEST FIRST

### A. Arithmetic on an existing third-party burn — **free, no spend, no code**

On a non-zero route all three numbers are public and on-chain: the signed `maxFee` in the burn
calldata, the amount burned, and the amount minted on the destination. `maxFee − (burned − minted)`
is the answer directly: **zero ⇒ charged in full; positive ⇒ a true ceiling.**

⚠️ **This reads a stranger's transactions, which is the shape that already cost six investigative
steps here** ([[establish-which-action-produced-the-outcome]]). It is defensible *only* because the
question is about **protocol arithmetic**, not about anyone's intent — all three values are on-chain
and none depends on knowing why the burn was made. ⭐ It answers *"what does CCTP do with `maxFee`"*,
which is exactly the question; it does **not** answer *"what would happen to us"*, and must not be
written up as if it did.

### B. Circle's documentation — **free, but weak on its own**

`mcp__circle__search_circle_documentation` / the CCTP docs may state the semantics outright.
⚠️ **Documentation is a claim about intent, not a measurement of behaviour**, and this repo has a
standing rule about values taken rather than derived — the CoinMarketCap `payTo` came from a vendor's
own marketing page and was wrong. Use B to form the hypothesis; settle it with A.

### C. Our own burn on a non-zero route — **the expensive one**

Needs, in order:
1. **A code change** — `bridgeFee`/`bridgeCallData` would have to accept a non-Arc source domain.
   Not a config toggle; the source is hardcoded and every caller assumes Arc.
2. **USDC on that source chain.** ⭐ We now hold **0.095791 USDC on Base Sepolia** from tonight's
   burn, which is enough for a small `Base → *` transfer.
3. **🚨 GAS ON BASE SEPOLIA, WHICH IS ETH — NOT USDC.** This is the real blocker. Every wallet here
   is Arc-native, where gas *is* USDC. A Base Sepolia burn needs Sepolia ETH from a faucet, which is
   a dependency this project has never had.

**Sizing, if it ever happens:** at `minimumFee 1.3`, `scaledBps = 130`, so
`baseFee = ceil(130 × amountMinor / 1e6)` and the buffer is `baseFee / 10`. At **1 USDC** the buffer
is **13 minor units = 0.000013 USDC** — small, but an exact integer count and therefore
unambiguous at 6 dp. A larger amount is not needed; a *reliable* one is.

## ⛔ RECOMMENDATION

**Do A.** It is free, needs no code and no spend, and answers the protocol question directly. Use B
only to predict what A should show — a documentation claim that A then contradicts is itself worth
recording. **C is not worth its cost**: a code change plus a faucet dependency, to learn something
two on-chain reads already contain.

⚠️ And note what A still leaves open: it establishes CCTP's behaviour, not ours. If we ever bridge
**from** a non-zero-`minimumFee` chain, the +10% buffer becomes live for the first time and the
disclosure would be quoting a number larger than what is charged — **the exact consent-vs-bound
problem again, in the opposite direction.** That is a reason to settle this before any multi-source
bridging, not after.

---

# ✅ RESULT — 2026-08-30: `maxFee` IS A CEILING. Read-only, nothing spent.

Settled by arithmetic on third-party burns, as scoped. **No code changed, no transaction sent.**

## THE INSTRUMENT, CALIBRATED FIRST ON A BURN WHOSE ANSWER WAS ALREADY KNOWN

CCTP v2's burn message body carries **both** numbers: `maxFee` (field 6) and `feeExecuted` (field 7).
So `maxFee − feeExecuted` is readable from a single event — no cross-chain matching needed.

⭐ Before trusting it on strangers' burns it was run against **my own** Arc burn `0x265be6d3…`, where
the answer was already established independently: `maxFee 54209`, `feeExecuted 54209`, and the chain
delivered `0.095791 = 0.15 − 0.054209`. The message agreed with the balance measurement exactly.

Source: `MessageReceived` on `MessageTransmitterV2` (`0x81D40F21…`) — the DESTINATION-side event,
because the source-side `MessageSent` is emitted before `feeExecuted` is known.

## THE DISTRIBUTION — 333 messages decoded, 82 on non-zero-`minimumFee` routes

Scanned ~6,000 blocks each on Base and Arbitrum mainnet, no RPC gaps.

⛔ **15 excluded because `maxFee == 0`** — a 0−0 difference is uninformative and counting it as
"charged in full" would have inflated that side of the answer. **67 informative burns remain:**

| `maxFee − feeExecuted` | count |
|---|---|
| **> 0 — a true CEILING** | **55** |
| == 0 — fully consumed | 12 |
| **< 0 — would break the ceiling** | **0** |

## ⭐⭐ THE ARITHMETIC SETTLES IT, AND THE 12 ZEROES ARE NOT COUNTER-EVIDENCE

`feeExecuted` is pinned to the protocol rate; `maxFee` is whatever the sender chose:

```
Ethereum (minimumFee 1)    exec 1.000 bp   maxFee 1.100 bp   ratio 1.100
Ethereum (minimumFee 1)    exec 1.000 bp   maxFee 2.000 bp   ratio 2.000
Arbitrum (minimumFee 1.4)  exec 1.400 bp   maxFee 1.546 bp   ratio 1.112
Arbitrum (minimumFee 1.4)  exec 1.400 bp   maxFee 1.400 bp   ratio 1.000
```

⭐ **`feeExecuted` lands on the route's `minimumFee` every time, whatever `maxFee` says.** Senders
using a 1.1× buffer got 1.1× headroom; a sender using 2× got 2×; the 12 with zero headroom are
senders who set `maxFee` **exactly at the rate** (ratio 1.000). **The zeroes are a property of those
senders, not of CCTP.** Nothing in the sample charged more than the ceiling.

> ⭐ **VERDICT: `maxFee` is a CEILING. CCTP charges its own rate and leaves the surplus.**

## ⚠️ BUT THE ANSWER FOR *OUR* PATH IS DIFFERENT, AND THIS IS THE PART THAT MATTERS

`maxFee` on Arc is `providerFee + forwarderFee`. Every Arc route reports `minimumFee 0`, so the
**providerFee — the part this result is about — is ZERO**, and our `maxFee` is essentially **all
forwarder fee**. On burn `0x265be6d3…` that forwarder portion was consumed **in full**
(`feeExecuted == maxFee == 54209`).

🚨 **So both readings are true and they are about different components:**

| component | behaviour |
|---|---|
| CCTP **protocol** fee (proportional, `minimumFee`) | a **ceiling** — surplus not taken (55/67) |
| Arc's **forwarder** fee (flat, dominates our `maxFee`) | taken **in full** (n=1, our own burn) |

⛔ **The scope doc's question — "would signing an accepted `maxFee` consent to more than is charged?"
— is therefore NOT resolved in our favour by this result.** On today's Arc routes the surplus this
finding is about does not exist, because the proportional term is zero. The +10% buffer only becomes
live if we ever bridge FROM a non-zero-`minimumFee` chain, which needs a code change.

⭐ And when it does become live, it moves in the **favourable** direction: we would disclose ~1.1×
what is charged, i.e. `feeCharged <= feeDisclosed` — the invariant added to the receipt this
morning already holds under these semantics.

## ⚠️ WHAT THIS DOES NOT ESTABLISH

- **It reads strangers' transactions.** Defensible only because the question is *protocol
  arithmetic* — `maxFee`, `amount` and `feeExecuted` are three public numbers in one event. ⛔ **No
  conclusion is drawn, or drawable, about who those senders are or what they were doing**, and none
  is recorded here. [[establish-which-action-produced-the-outcome]]
- **It answers what CCTP does, not what would happen to us.** We cannot reach a non-zero route
  without a code change, so this is about the protocol, not about our path.
- **The forwarder row is n=1** — our own burn. "Taken in full" for the forwarder is one observation,
  and the same argument that made a single Arc datum insufficient for the protocol question applies
  to it. It is not settled; it is merely the only reading we have.
- **Mainnet CCTP v2, Arc is testnet.** Identical protocol semantics is an assumption, not a
  measurement.
