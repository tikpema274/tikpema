# SCOPE — which fee is authoritative in a receipt?

**2026-08-30. Decision scope. No code.** Blocks the two defects in
`docs/agent-bridge-receipt-defects.md`.

---

## 🚨 FIRST: BOTH DEFECTS ARE LATENT RACES, AND I MEASURED THE RATE

The defects were read from source. I went looking for them in real data: **all 44 bridge receipts in
the store, 6 of them agent-path** (`quoteId` set), including **the August acknowledge-band one**
(`q_msxi20om…`, amount 0.1, band `acknowledge`).

| agent receipt | amount | feeUsdc | feeRatio | derived feeUsdc/amount | |
|---|---|---|---|---|---|
| `q_msxi20om…` | 0.1 | 0.053275 | 0.53275 | 0.53275 | ⭐ reconciles |
| `q_msxi20om…` | 1 | 0.053274 | 0.053274 | 0.053274 | ⭐ reconciles |
| `q_msln542p…` | 2 | 0.053296 | 0.026648 | 0.026648 | ⭐ reconciles |
| `q_msb21x9q…` | 1 | 0.053203 | 0.053203 | 0.053203 | ⭐ reconciles |
| `q_mt6aoei8…` | 3 | 0.176635 | 0.058878 | 0.058878 | ⭐ reconciles |
| `q_mtdeh15z…` | 3 | 0.054173 | 0.018058 | 0.018058 | ⭐ reconciles |

**0 of 6 manifest. Including at a band.**

⛔ **THAT IS NOT EVIDENCE THE DEFECT IS ABSENT, AND THE ARITHMETIC SAYS SO.** Quote B and quote C
are one Iris round trip apart — **~200 ms**. The fee was measured moving four times in a couple of
minutes on 2026-08-29 (0.054214 / 0.054218 / 0.054211 / 0.054217), i.e. roughly **once per ~30 s**.
So per receipt:

```
P(fee moves inside the B→C window) ≈ 0.2 s / 30 s ≈ 0.7%
expected manifestations in 6 receipts ≈ 0.04
```

⭐ **A clean 6-for-6 is exactly what a real defect predicts at this sample size.** The sample is ~150×
too small to have caught it. [[absence-must-never-read-as-safe]]

⚠️ And when it does fire the **magnitude is small** — the fee moves by ~4e-6 on ~0.054, so
`feeRatio` would disagree with `feeUsdc/amount` around the 5th decimal. Small, real, and invisible
to anything but an explicit reconciliation check.

---

## ⭐ THE DECISION — three options, with what each costs

### A. The SIGNED fee is authoritative (quote C — the calldata, what was actually charged)

Every monetary field on the receipt derives from the quote that was signed.

- **Buys:** the receipt reconciles with the CHAIN. This is what makes the manual bridge's
  six-source reconciliation possible — `feeUsdc` == the signed `maxFee` == what the settler read
  from the destination. An auditor can check the record against the world.
- **Costs:** ⚠️ **the receipt stops recording what the user consented to.** `ackBand` and
  `ackAcceptedAt` would then describe a band computed from a fee **the receipt does not contain**.
  The consent evidence becomes unanchored: you can show *that* they accepted, not *what* they
  accepted against. 🚨 That directly weakens `verify-bridge-fee-band` §9's transitive-consent
  argument, whose whole point is that the record carries the evidence.

### B. The ACKNOWLEDGED fee is authoritative (quote B — what the user consented to)

- **Buys:** the receipt is a faithful record of consent.
- **Costs:** ⛔ **the receipt would state a fee that was never charged.** `feeUsdc` would disagree
  with the signed calldata and with the chain. That is a **false money record** — the exact class
  this repo refuses everywhere else, and it would break the six-source reconciliation outright.
  ⚠️ On its own this option looks non-viable for a money record; it is listed because it is the
  honest counterpart to A and because it names what A gives up.

### C. BOTH, as distinct named fields

e.g. `feeUsdc` (signed/charged) alongside `feeAcknowledgedUsdc` (consented).

- **Buys:** the only option that answers **both** questions, and ⭐ the only one where **drift is
  measured rather than hidden** — the gap between them IS the consent-vs-bound gap, currently
  invisible. It also makes the consent-fee-binding work *checkable from a receipt*: after binding,
  signed must always be ≤ acknowledged, which is an invariant a suite can assert on real records.
- **Costs:** schema growth on a money record; **every consumer must be told which one it means**,
  and a reader who picks wrong is back to a false claim. ⚠️ `feeRatio` still has to derive from
  exactly one of them — two ratios would reintroduce the mixing defect one level up. And by this
  repo's own rule a human-facing field ships with its render assertion, so both need UI treatment
  or they are write-never-read.

### ⭐ A sub-option that applies to all three: **stop storing `feeRatio` at all**

It is `feeUsdc / amountRequested`, both of which are on the record. Storing it is a duplicate source
of truth for a derived value — and **defect 1 is precisely that duplicate disagreeing with its
source.** Deriving it at read time makes self-reconciliation structural rather than a property to be
checked. ⚠️ Cost: `ackBand` was computed from a ratio at gate time, so if the stored fee ever
differs from the gated fee, a derived ratio would no longer explain the stored band — which is
option A's cost surfacing in a different place, not a new one.

---

## ⚠️ IS THIS THE SAME DECISION AS CONSENT-FEE-BINDING? PARTLY — AND THE SPLIT MATTERS

**The DECISION is entangled. The DEFECT is separable.** They must not be conflated.

- **Entangled:** consent-fee-binding is designed to make the signed fee equal (or better than) the
  acknowledged fee. **If it lands, B and C converge and "which is authoritative" largely dissolves**
  — the two options describe the same number. So deciding A-vs-B-vs-C *now* is choosing between two
  values that the binding work exists to make identical.
- **Separable:** the reconciliation fix is "derive every monetary field on a receipt from ONE quote
  object". That is correct under any of the three choices and is not undone by binding.

🚨 **AND THE IMPORTANT ASYMMETRY: BINDING WOULD MASK DEFECT 1, NOT FIX IT.** Once B == C, the code
still reads `feeUsdc` from one and `feeRatio` from the other — the values merely happen to agree.
A latent defect that stops manifesting is **worse** than one that manifests: it survives, invisible,
until some later change reintroduces divergence and silently starts producing bad receipts again.

⭐ So: **fixing the reconciliation is not wasted work if binding lands, and deferring it on the
assumption that binding solves it would be a mistake.** The single-quote fix is worth doing on its
own schedule; the A/B/C choice can wait for, or be dissolved by, the binding decision.

---

## ⛔ WOULD A LIVE AGENT BRIDGE AT A BAND-CROSSING AMOUNT BE WORTH RUNNING?

**No — and this is quantified rather than asserted.**

- Cost: ~0.0542 USDC (the flat fee) plus gas, on an amount around 0.15 to cross 25%.
- **Probability it shows the defect: ~0.7%.** You would need on the order of **100 runs for an even
  chance**, at ~0.0542 each. The six receipts already in the store are the same experiment run six
  times, and they came back clean exactly as predicted.
- ⭐ **A clean run would prove nothing and would be easy to misread as evidence the defect is not
  real** — which is the more expensive outcome than not running it.

**The instrument that works is INJECTION, not a live run.** Mock `bridgeFee` to return different
values on successive calls inside one `_actions` execution; the mixing then shows deterministically
and for free, and the same fixture pins the fix. That is a suite, and it is the only way to observe
this on demand.

⚠️ **What a live run WOULD still be worth**, separately from these defects: the agent band has fired
live exactly once (2026-08-14). A second firing would be a second instance of the §9 consent
property on the *agent* path — but that is a different question from these two defects and should
not be justified by them.
