# SCOPE — making "the number I consented to" the number that is signed

**2026-08-29. Read-only scoping. Nothing built.** Written after the ack gate's first successful
live firing (`0x265be6d3…`), which measured the gap this document is about.

---

## 1. THE FINDING, AS MEASURED

| | fee | arrives |
|---|---|---|
| disclosure the operator accepted, read on screen | **0.054213** | 0.095787 |
| signed calldata `maxFee` / receipt `feeUsdc` | **0.054209** | 0.095791 |
| delivered, read from Base Sepolia | — | 0.095791 |

**Drift: 0.000004 USDC (0.0074% of the fee).** Direction **favourable this time** — the operator was
charged slightly less than they accepted. ⚠️ *This time* is doing real work in that sentence:
nothing in the design makes the direction favourable, and the same mechanism can move the other way.

**The design binds the BAND, not the number.** `bridgeAckToken`'s own header says why: the fee moves
constantly, so binding the figure *"would invalidate every acknowledgment on the next tick and train
people to click through a box that always complains."* That reasoning is sound **for a design that
re-prices after acceptance**, which is what exists today.

⭐ **Re-quoting closer to the signature does not fix this, it moves the gap.** Quote → sign has an
interval too. **Any design that fetches the number separately from the signature has a window.** The
question is not how to remove the window but what may happen inside it.

---

## 2. ⚠️ THE AGENT PATH HAS THE SAME GAP — AND ONE THE MANUAL PATH DOES NOT

This was the load-bearing question for scope, and the answer changes it: **this is a SHARED defect,
not a manual-path defect.**

**Manual path — 2 quotes, 1 window:**
```
priceAndGate → quote A ──(409, discloses A)──▶ human reads, accepts
priceAndGate → quote B ──(band from B, token compared, calldata built from B)──▶ client signs B
```
Disclosed **A**, signed **B**. ⭐ The receipt is **internally consistent**: `feeUsdc 0.054209`,
`feeRatio 0.36139333`, and `0.054209 / 0.15 = 0.3613933…` ✓. Every recorded number comes from B.

**Agent path — 3 quotes, 2 windows:**
```
_actions      → quote A ──(blocked + feeDisclosure from A)──▶ human accepts
_actions      → quote B ──(bandInfo + ackToken compared, from B)
  agentBridge → quote C ──(bridgeCallData(maxFee: C.maxFee))──▶ agent signs C
```
`agentBridge` takes only `amountUsdc` and **re-prices internally** — a third `bridgeFee` call the
gate never sees.

### 🚨 AND ITS RECEIPT MIXES TWO QUOTES

`_actions.mjs`'s success return:

```js
feeUsdc:  r.feeUsdc,        //  ← quote C, from inside agentBridge (the SIGNED one)
netUsdc:  r.netUsdc,        //  ← quote C
feeBand:  bandInfo.band,    //  ← quote B (the one the ack was checked against)
feeRatio: bandInfo.feeRatio //  ← quote B
```

⛔ **So an agent receipt can carry `feeUsdc` from one quote and `feeRatio` from another, and
`feeUsdc / amount !== feeRatio`.** The record does not reconcile with itself. On the manual path
that class of error is impossible.

⚠️ **A third inconsistency, on the error path:** the `catch` attaches `feeUsdc: fee.feeUsdc` — quote
**B**. So a bridge that times out records the *gated* fee, while the same bridge succeeding records
the *signed* fee. **Two writers, two different numbers for the same event.**

⭐ **Scope consequence:** the fix belongs in shared pricing/consent code, and the agent path needs a
second change the manual path does not — making its recorded fields come from one quote.

---

## 3. 🚨 A NEIGHBOURING DESIGN IS ALREADY REJECTED IN WRITING — READ THIS FIRST

`_quote-record.mjs` names this idea and refuses it:

> *"we already have the priced plan stored — validate the confirm against it instead of re-pricing"*
> — *"That would delete the pre-flight re-price, whose ENTIRE purpose is that the fee is volatile …
> and a quote left open on screen goes stale. It would also make a stored, client-facing value
> load-bearing for consent."*

**The proposal here is NOT that design, and the difference is one property:**

| | rejected design | this proposal |
|---|---|---|
| re-price at execution | ❌ deleted | ✅ **kept, unchanged** |
| what the stored/accepted number does | **authorizes** the burn | **bounds** it — a ceiling on consent |
| trust model | stored client-facing value trusted because stored | value **authenticated by HMAC**, not trusted |

⛔ **The re-price must stay.** It is the only thing that knows the live fee, and this proposal
*depends* on it — it compares live against consented rather than replacing one with the other. Any
implementation that drops the re-price has walked into the rejected design.

---

## 4. THE DESIGN, AND THE TRADEOFF THAT DECIDES IT

**Bind `maxFee` into the ack token** (`bridgeAckToken` currently binds owner + destination + amount
+ band; add the exact `maxFee`). The client returns it; tampering fails the HMAC, so the number is
*authenticated*, not *trusted*. Then re-price at signing and apply a **one-sided rule**:

```
live <= accepted   →  sign min(accepted, live).  No new consent needed: strictly favourable.
live >  accepted   →  REFUSE and re-disclose.    The user never signs worse than they accepted.
accepted older than N seconds → REFUSE and re-disclose, regardless of direction.
```

⭐⭐ **This is not a new principle — it is the EXISTING agreed rule at finer granularity.**
`_bridge.mjs` already states it for bands: *"accept an acknowledgment if the CURRENT band is no
WORSE than the one acknowledged; refuse only on a genuine worsening."* This applies the same
one-sided test to the **fee** instead of the **band**.

⭐ It also **removes the original objection to binding the number.** "Binding the figure would
invalidate every acknowledgment on the next tick" is true only when drift in *either* direction
invalidates. One-sided, downward drift is free and silent; only genuine worsening re-discloses.

### The tradeoff, answered directly

**The risk named:** a stale accepted fee could be worse than live, binding the operator to a number
they would have declined. Under the rule above **that cannot happen** — `min(accepted, live)` never
signs above what was consented, and `live > accepted` refuses rather than binds.

| option | what it costs |
|---|---|
| **refuse + re-disclose on ANY change** | Maximally safe, **and it reproduces the failure band-binding was invented to avoid.** The fee was measured moving four times in minutes (0.054214 → 0.054218 → 0.054211 → 0.054217), so nearly every acceptance would be refused and the box would "always complain" — training exactly the click-through this gate exists to prevent. ⛔ Not recommended. |
| **⭐ accept the better of the two (one-sided)** | Recommended. Silent when drift is favourable, re-discloses only on genuine worsening. Costs: `bridgeAckToken` gains a field (**every existing token is invalidated — a `v4` bump**), and the client must round-trip `maxFee`. Residual: an upward move between the final re-price and the signature is still unbound — **the window is not closed, only made one-directional.** |

### ⚠️ ONE UNKNOWN THAT CHANGES THE ARITHMETIC — must be settled before building

**Is `maxFee` a ceiling, or is it charged in full?** Measured on this burn: `amountDelivered
0.095791` == `0.15 − 0.054209` exactly, i.e. **the full `maxFee` was taken**. But that is *one*
observation in the current regime where every route reports `minimumFee: 0`, so
`providerFee = 0` and `maxFee` collapses to the flat forwarder fee.

🚨 **On a route with non-zero `minimumFee`, `bridgeFee` adds a deliberate `+10%` buffer** — there
`maxFee > actual`, and "sign the accepted `maxFee`" would consent to a number **larger than what is
charged**. Whether the surplus is refunded or kept is **not established here.** Under `min(accepted,
live)` the exposure is bounded, but the sizing of `N` and the framing of the disclosure both depend
on this answer. **Settle it by measurement, not by reading the CCTP docs.**

---

## 5. WHAT THIS SCOPE DELIBERATELY DOES NOT COVER

- **Swap.** Still unscoped, and this makes the case stronger rather than weaker: a swap has a
  *price* with slippage, so its consent-vs-bound question is strictly harder than a fee's.
- **Any code.** Nothing was built, and the `v4` token bump alone makes this a change that needs its
  own pre-registration — every outstanding ack token becomes invalid the moment it ships.
