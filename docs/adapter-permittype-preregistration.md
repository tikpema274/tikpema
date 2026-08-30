# PRE-REGISTRATION — does the swap AdapterContract accept a non-zero `permitType`?

**2026-08-30. Written BEFORE the run. Nothing below this line is amended after the result.**

The open item from `docs/manual-swap-scope.md` §5 / RESULTS. Instrument 2 settled that **Arc USDC
supports EIP-2612 `permit`**. That is a fact about the **token**. This asks a different question
about a **different contract**: will the **AdapterContract** (`0xbbd70b01…`) honour a `TokenInput`
carrying `permitType = EIP2612`, so that one transaction both authorizes and swaps — **deleting** the
approve/swap window rather than managing it?

---

## 🚨 THE MISREAD THIS DOCUMENT EXISTS TO PREVENT

> A revert on `permitType = 1` could mean **the adapter rejects permits**, OR **my `permitCalldata`
> or signature is wrong.** Those are opposite conclusions from the same observation.

**Three de-confounders, each removing one way the fault could be mine. All must hold before any
revert is attributed to the adapter.**

### 1. THE ENCODING IS NOT MINE — it is the SDK's, read verbatim

From `@circle-fin/provider-stablecoin-service-swap`:

```
PermitType.NONE = 0 ,  PermitType.EIP2612 = 1
encodeEIP2612PermitCalldata(value, deadline, signature)
  ->  abi.encode(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)   // 5 words, 160 bytes
```

⭐ The same discipline `_swap.mjs` already applies to `executeParams` ("SDK-VERBATIM transform").
**"I invented the layout" is removed as an explanation.**

### 2. THE SIGNATURE IS PROVEN VALID BEFORE THE ADAPTER EVER SEES IT

A throwaway keypair is generated **locally** — signing is arithmetic, not a chain action, and the key
holds nothing. Then, in order:

- **CALIBRATION A — the domain must match.** Compute the EIP-712 domain separator from
  `name` / `version` / `chainId` / `verifyingContract` and assert it **equals the token's live
  `DOMAIN_SEPARATOR()`**. A mismatch means my typed data is wrong.
- **CALIBRATION B — ⭐ THE KNOWN-GOOD CONTROL THAT REACHES THE SAME CODE PATH.** `eth_call`
  **`permit(...)` DIRECTLY on the token** with that exact signature. It **must SUCCEED**. This proves
  the signature, nonce, deadline and domain are all good *against the very function the adapter would
  call*. `permit` is permissionless, so anyone may submit it.

⛔ **If A or B fails, the run STOPS and reports INCONCLUSIVE. No claim about the adapter is made** —
the fault would be mine, and that is exactly the misread being guarded against.

### 3. A KNOWN-GOOD CONTROL AT THE ADAPTER, differing ONLY in the token-input

`permitType = 0` **with an allowance override** already returns **SUCCESS** (scope RESULTS, probe B2).
Same quote, same calldata builder, same caller, same overrides — **the only variable is the
`TokenInput`.** So a difference in outcome is attributable to the token-input and nothing else.

---

## PRE-REGISTERED OUTCOMES — what each one MEANS, fixed in advance

The measurement: `eth_call` the swap calldata from the throwaway EOA with `permitType = 1` and a
valid `permitCalldata`, **native balance overridden but NO allowance override** — so the permit is
the *only* possible source of authorization.

| observed | conclusion |
|---|---|
| **SUCCESS** | ⭐⭐ The adapter accepts the permit shape and authorizes through it. **The one-transaction shape is real** at the simulation level. |
| revert **`"ERC20: transfer amount exceeds allowance"`** | 🚨 The adapter **IGNORED** the permit and went straight to `transferFrom`. `permitType = 1` is not honoured — silently treated as NONE. ⛔ **The one-transaction shape does not work, and it fails in the worst way: silently, looking like a plain allowance shortfall.** |
| revert **`"EIP2612: invalid signature"`** | The adapter **DID** forward to the token's permit — so it **accepts** `permitType = 1` — and the signature went stale between calibration B and this call. Adapter accepts; the run is re-done, not reinterpreted. |
| revert with a **custom 4-byte error** | Explicit adapter rejection. Report the selector; match it against computed candidates rather than guessing a name. |
| revert **EMPTY** | ⛔ **INCONCLUSIVE** — indistinguishable from a dispatch fallthrough. |
| a **throw before `eth_call`** | My construction failed. **Not an adapter result**, and must not be reported as one. |

## ⛔ STOP CONDITIONS

- Calibration A or B fails → **INCONCLUSIVE**, no adapter claim.
- ⛔ **Do NOT vary `permitType`, the encoding, the value or the deadline until an outcome is
  obtained.** Searching over shapes until one succeeds is fitting the experiment to the result — the
  same rule the bridge ack pre-registration set for the amount.

## ⚠️ WHAT A SUCCESS WILL **NOT** PROVE — the boundary, carried forward

- **`eth_call` is simulation.** A success means **the adapter accepts the shape**, *not* that a real
  permit signature lands. A real run additionally needs MetaMask to sign the `Permit` typed data, the
  nonce to still be current at broadcast, and the whole thing to survive a real submission.
- **It says nothing about Circle's production path.** `_swap.mjs` hardcodes `permitType: 0`; this
  builds the token-input by hand. A working adapter would make the one-transaction shape *available*,
  not *wired*.
- **It is one route, one pair, one moment**, on testnet.

---

# ✅ RESULT — 2026-08-30: **THE ADAPTER ACCEPTS `permitType = EIP2612`.**

Read-only: a locally generated throwaway key plus `eth_call`. **Nothing was broadcast, nothing
submitted, no gas.** Nothing above this line is amended.

## The de-confounders held, in order — so the result is attributable

| | | |
|---|---|---|
| **CALIBRATION A** — computed EIP-712 domain vs live `DOMAIN_SEPARATOR()` | `0x36119152…c8c6b0` vs `0x36119152…c8c6b0` | ✅ **MATCH** |
| **CALIBRATION B** — `permit()` called DIRECTLY on the token with that signature | **SUCCESS** | ✅ signature, nonce (`0`), deadline and domain all valid **against the very function the adapter would call** |
| `permitCalldata` length | **160 bytes** = 5 words | ✅ exactly the SDK layout |

## The measurement, with both pre-registered controls

| | result |
|---|---|
| **CONTROL** `permitType 0` + allowance override | ✅ **SUCCESS** *(as predicted)* |
| **CONTROL** `permitType 0`, **no** allowance | ✅ revert `"ERC20: transfer amount exceeds allowance"` *(as predicted)* |
| ⭐ **PROBE** `permitType 1` + valid permit, **NO allowance override** | ⭐⭐ **SUCCESS** |

⭐ **The second control is what makes the probe mean something.** Same calldata, same caller, same
overrides — remove only the permit and it fails for want of authorization. **So the permit is what
authorized the pull**, not a leftover allowance and not the balance override.

> ⭐⭐ **VERDICT, per the pre-registered table: the adapter accepts the permit shape and authorizes
> through it. The one-transaction shape is REAL at the simulation level — approve + swap can collapse
> into a single user action, DELETING the partial-completion window of `docs/manual-swap-scope.md` §5
> rather than managing it.**

## ⚠️ ONE OUTCOME FIRED FIRST, AND IT WAS MINE — recorded rather than quietly fixed

The first run returned **"THREW BEFORE eth_call — adapter assert failed"** on **all three** cases,
including the control that was already known to succeed. Per the pre-registered table that is
*"my construction failed. **Not an adapter result**, and must not be reported as one."*

**Cause: my own comparison bug.** I wrapped the adapter constant in `getAddress()` (checksummed) and
compared it with `.toLowerCase()` against the checksummed form. **The target address was correct the
whole time.** ⭐ The tell was that the *known-good control* failed too — a probe whose control breaks
is reporting on the instrument, not the subject. Fixed, re-run, controls then behaved exactly as
predicted. [[a-check-whose-failure-mode-is-a-pass]]

## ⛔ WHAT THIS STILL DOES NOT PROVE — the boundary, unchanged

- **`eth_call` is simulation.** The adapter accepts the **shape**. A real run needs MetaMask to sign
  the `Permit` typed data, the nonce to still be current at broadcast, and the transaction to land.
- **It is not wired.** `_swap.mjs` hardcodes `permitType: 0`; this built the token-input by hand. The
  one-transaction shape is now **available**, not **built**.
- **One route, one pair, one moment, on testnet**, with a key that holds nothing.
