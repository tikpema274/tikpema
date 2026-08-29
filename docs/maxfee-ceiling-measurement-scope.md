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
