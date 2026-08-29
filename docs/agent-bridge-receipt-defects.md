# DEFECTS — the agent bridge receipt does not reconcile with itself

**2026-08-29. Found while scoping the consent-vs-bound question; recorded as DEFECTS, not design
questions.** ⛔ **Neither needs a decision from anyone to be wrong.** Both are live in production.
Nothing was fixed.

Both come from the same root: **`agentBridge` re-prices internally.** `_actions.mjs` prices a quote
for the band gate, then calls `agentBridge({ walletAddress, destination, amountUsdc })` — which takes
**only the amount** and issues its own `bridgeFee` call. The agent path therefore holds up to three
quotes: **A** (disclosed), **B** (gated), **C** (signed).

---

## DEFECT 1 — `feeUsdc / amount !== feeRatio` on every agent bridge

`_actions.mjs`, the bridge success return:

```js
feeUsdc:  r.feeUsdc,         // ← quote C — from inside agentBridge, the SIGNED fee
netUsdc:  r.netUsdc,         // ← quote C
feeBand:  bandInfo.band,     // ← quote B — what the ack was checked against
feeRatio: bandInfo.feeRatio, // ← quote B
```

**Four fields, two different quotes, one record.** `feeRatio` is not derived from the `feeUsdc`
stored beside it, so an agent receipt is **arithmetically self-inconsistent** whenever the fee moved
between the two calls — which is most of the time. The measured drift on the manual path's single
window was 0.000004 USDC across a human pause; the B→C window is one Iris round trip, so the
divergence is usually smaller, **but "usually small" is not "zero", and nothing bounds it.**

⭐ **Contrast, and it is the proof this is a defect rather than a fact of life:** the MANUAL path's
receipt reconciles **exactly**. Measured on burn `0x265be6d3…`: `feeUsdc 0.054209`,
`feeRatio 0.36139333…`, and `0.054209 / 0.15 = 0.3613933…` ✓. Every number on that receipt comes
from one quote. The same class of error is structurally impossible there.

⚠️ **Why it matters beyond tidiness.** `feeRatio` is what the band was computed from, and the band is
what consent was taken against. A receipt whose ratio does not match its own fee cannot be used to
reconstruct *what the user was shown* — which is the entire purpose of persisting the consent
evidence. It also silently breaks any future reconciliation check over agent receipts, and would
break it in a way that reads as a rounding quirk.

---

## DEFECT 2 — the error path and the success path record different fees for the same event

`_actions.mjs`'s `catch` attaches:

```js
feeUsdc: fee.feeUsdc,   // ← quote B
netUsdc: fee.netUsdc,   // ← quote B
```

while the success return uses **quote C**. So:

- a bridge that **completes** records the fee that was **signed** (C);
- the *same* bridge **timing out** — `TxPendingError`, the 202 path — records the fee that was
  **gated** (B).

**Two writers, two different numbers, for the same bridge.** Which value a receipt carries depends
on whether the userOp happened to settle inside the deadline, which is a timing accident and not a
property of the money.

⚠️ A pending receipt that later completes therefore has a fee that may not match the burn it names,
and nothing downstream can tell that the two came from different quotes — there is no field
recording *which* quote a number came from.

---

## WHAT IS NOT CLAIMED

- **No money is misdirected by either defect.** The signed calldata is authoritative and the chain
  executed it exactly; on the manual burn measured tonight `netPredicted == amountDelivered` to the
  minor unit. These are defects in the **record**, not in the movement.
- **No live agent-path instance has been examined.** Both defects are read from source, and the
  reasoning is arithmetic rather than observational. ⭐ Confirming them on a real agent receipt would
  need one that reached the acknowledge band, and `PROGRESS.md` records that the agent band has fired
  live exactly once (2026-08-14, the plan card). **Neither defect is asserted by any suite.**
- **No fix is proposed here.** The obvious one — have `agentBridge` accept a priced quote instead of
  re-pricing — collides with the re-price rule in `docs/consent-fee-binding-scope.md`, so it belongs
  to that decision, not to this record.
