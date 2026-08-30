# FINDING — the swap venue's two price sources disagree, and the pool does not round-trip

**2026-08-30. Read-only, measured. ⛔ NOT FIXED — recorded as its own item.**

Surfaced while diagnosing why the acknowledge band did not fire on the EURC→USDC run
(`docs/manual-swap-eurc-usdc-preregistration.md`). **It is a finding about the VENUE, not a copy
defect**, and it is kept separate from the copy fix for that reason — the two would otherwise be read
as one problem with one cause.

## MEASURED, LIVE, BOTH DIRECTIONS, 1.000000 IN

| | quote | implies EURC = |
|---|---|---|
| pool, **USDC→EURC** | 0.808636 EURC | **$1.23665** |
| pool, **EURC→USDC** | 1.266665 USDC | **$1.26666** |
| `getTokenRates` (the band's reference, inferred from the live run) | — | **$1.15619** |

> ⭐ **ROUND TRIP: 1.000000 USDC → 0.808636 EURC → 1.024271 USDC = +2.43%.**

## 🚨 TWO SEPARATE PROBLEMS, AND THE SECOND IS THE SERIOUS ONE

**1. The pool and the reference rate disagree by ~7–10%.** `getTokenRates` says $1.15619; the pool
trades EURC around $1.24–$1.27. For a stablecoin FX pair that is not a spread — one of the two is
wrong, and nothing here establishes which.

**2. ⭐⭐ THE POOL DOES NOT ROUND-TRIP.** It prices EURC at **$1.23665** when you sell USDC and
**$1.26666** when you buy USDC. That is not a bid/ask spread around a midpoint — **buying and selling
both favour the trader**, which is why a round trip *gains* 2.43% instead of losing a spread twice.
🚨 **A venue you can profit from by trading in a circle is mispriced**, and the direction of the
mispricing is not stable.

## ⚠️ WHAT THIS DOES AND DOES NOT MEAN

- ⛔ **It does NOT invalidate any completed swap.** Both live swaps received **at or above** their
  signed floors, and `minTokenOut` is enforced by the contract regardless of what any price source
  says. **The money guarantee never depended on these numbers.**
- ⚠️ **It DOES mean the band's economic check is not meaningful on this venue right now.** The band
  compares the floor against `getTokenRates`; when that reference is ~8% away from the trading price,
  the comparison measures the disagreement rather than the deal. ⭐ It is still *structurally* correct
  — it computes the right quantity from the right inputs — and it is precisely why the far-above
  advisory now exists: the honest statement is *"this check is unreliable"*, not a verdict.
- **It is a TESTNET observation.** Arc testnet with sandbox routing; nothing here is a claim about
  mainnet liquidity, and it must not be written up as one.

## ⛔ WHAT IS NOT ESTABLISHED — do not infer these

- **Which source is wrong.** Both readings are consistent with a stale `getTokenRates` *and* with a
  mispriced pool. Nothing measured here separates them.
- **Whether the gap is stable.** Three quotes at one moment. The USDC→EURC rate has already moved
  materially across today (0.929280 → 0.808636 per USDC, ~13%), so this is a snapshot, not a level.
- **That it is exploitable.** A +2.43% round trip is a *quote* arithmetic result; it ignores gas
  (~0.016 USDC per leg, so ~0.033 for the circle) and slippage on execution, and it does not model
  what happens to the pool as it is traded against. ⭐ At 1 USDC the gas alone exceeds the gain.
  **Recorded because it diagnoses the venue, NOT as an opportunity.**

## ⛔ NOT ACTED ON

No code change follows from this. The band's thresholds are unchanged, the reference source is
unchanged, and no attempt is made to reconcile the two prices. **What it earns is the advisory** —
already built — that says the comparison is unreliable rather than reporting a verdict from it.

⚠️ **The thing to watch:** if the reference source ever moves to the *unfavourable* side of the pool
by a similar margin, the band would fire `warn`/`acknowledge` on swaps that are actually fine, and a
user would be asked to acknowledge a loss that is an artefact of the disagreement. **Today's error is
in the harmless direction; it is the same defect either way.**
