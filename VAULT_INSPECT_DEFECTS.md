# Defect report — `inspectVault` disclosure asserts facts it did not establish

> ## ⚠️ THIS IS A REPORT, NOT A CHANGELOG
> **Nothing here has been fixed.** Every defect described below is **LIVE IN SHIPPED CODE** as of
> the date on this file, in the path that gates real USDC deposits. This document records findings
> only — no code was changed when it was written. If you are reading it to find out what was fixed,
> the answer is nothing; check `git log -- netlify/functions/_vault.mjs` for that.

**Date:** 2026-07-24
**Report status:** **OPEN — findings only, no fix applied, no fix scheduled here.**
**Component:** `netlify/functions/_vault.mjs` — `inspectVault()` and the disclosure it feeds
**Component status:** in production, on the path that gates real USDC deposits.
**Method:** Static trace of the file against its callers (`_actions.mjs:368-372`,
`agent-vault-inspect.mjs:30-48`, `src/components/VaultPanel.tsx`). No code changed, nothing run.
**Scope:** This is a report against shipped code. It is deliberately SEPARATE from the DD-engine
design — the design must not be the vehicle for fixing a live defect, and this must not wait on it.

---

## TL;DR

Three places where the vault disclosure makes an **affirmative safety claim about a check that
did not happen**. The user reads these statements and acknowledges them before a deposit.

| # | Line | The disclosure asserts | What was actually true | Shape |
|---|---|---|---|---|
| **A** | `168-169`, `299-300` | "Ownership renounced (owner is the zero address)" | `owner()` was **unread or absent** | unread → safe |
| **B** | `232-234`, `280` | "Not upgradeable — logic is fixed at this address (no proxy slot, no upgrade function)" | The proxy-slot read **failed** | unread → safe |
| **C** | `240-242`, `247-250` | "Reversible in the same transaction (no lock/delay)" | **No lock/delay/cooldown check exists** | described, not coded |

**A and B are the same bug** — an unread value falls through to the safest interpretation.
**C is a different bug** — the check was never written, but its conclusion is stated anyway. They
need different fixes, and C's fix is free.

---

## Why this is a blind spot, not an oversight

**The same file already encodes exactly the right discipline, 90 lines above the defects.**

`readBalanceStrict` (`138-152`) retries hard and then **throws** rather than returning a fallback,
with a comment stating the reason outright:

> *"a fabricated balance corrupts a delta silently … A witness that guesses is not a witness — if
> we cannot read it, we refuse rather than invent a number."*

That function exists because of the 70.772 bug, where `?? 0n` on a failed read made a withdraw's
"amount received" equal the wallet's entire balance. The lesson was learned, written down, and
applied — **to the money-witness path only.**

The disclosure path, in the same module, does the opposite three times. Nobody re-asked "does a
failed read here also invent a value?" because the disclosure feels like reporting rather than
arithmetic. It isn't: a disclosure that fabricates a *reassurance* is the same defect as a witness
that fabricates a *number*, and it is arguably worse, because a human reads it and acts on it.

That asymmetry is why this is worth writing down. The rule was known. It was applied once and not
generalised.

---

## Defect A — an unread `owner()` is reported as "Ownership renounced"

**Line 168-169** (`classifyOwner`), with the consequence at **299-300**.

`classifyOwner` treats a falsy `owner` as the zero address. Three distinct states collapse into one:

1. **Genuinely renounced** — `owner()` returned `0x000…0`. Correct.
2. **No `owner()` function at all** — the Multicall3 sub-call returns `null` under `allowFailure`.
3. **The read failed** — a throttled or total multicall failure yields all-`null` (`157-165`).

All three render as `type: "renounced"`, label **"Ownership renounced (owner is the zero address)"**.

**Failure mode:** `renounced` is the *only* owner classification that pushes no WARN — lines 299-300
warn on `eoa` and `contract`, and say nothing for `renounced`, `multisig`, or `timelock`. So an
unread owner produces the single safest verdict the function can emit.

**User-visible consequence:** the panel states that nobody controls this vault, when in fact nobody
*checked*. A vault owned by a live EOA — the case that carries the `owner-is-eoa` warning, *"a single
compromised key can exercise every owner power above"* — can present as ownerless if one sub-call
fails.

*Partial mitigation, stated for accuracy:* the re-read loop at `212-216` retries the whole multicall,
so a **total** RPC failure is usually corrected. But it keys only on `values[0]` (`asset`) being null
**and** the `asset()` selector being present. A failure confined to the `owner` sub-call, or any
failure on a contract without an `asset()` selector, does not trigger it.

---

## Defect B — an unread proxy slot is reported as "Not upgradeable"

**Line 232-234**, with the consequence at **280**.

`withRetry(() => pc.getStorageAt({slot: EIP1967_IMPL_SLOT}), null)` returns `null` after 3 failed
attempts. `null` is falsy, so `proxyImpl` is false, so `upgradeable` is false unless an upgrade
*selector* was independently found.

**Failure mode:** the fallback value is indistinguishable from a legitimately empty slot. A
throttled `eth_getStorageAt` — the documented behaviour of Arc's public RPC, and the reason
`multiRead` exists at all (`64-68`) — silently becomes "no proxy slot."

**User-visible consequence:** the disclosure does not merely omit a warning; it emits a **positive
claim in the user's favour**: *"Not upgradeable — logic is fixed at this address (no proxy slot, no
upgrade function)."* The parenthetical specifically asserts the slot was checked and found empty.
It also suppresses the `upgradeable` WARN at line 302.

The independent selector scan for `upgradeTo`/`upgradeToAndCall` catches UUPS-style proxies that
expose those selectors in their own bytecode, which narrows this. It does **not** catch a
Transparent proxy, where the upgrade entrypoint lives in the admin and the proxy itself is thin —
a shape we confirmed on-chain today on the ERC-8004 registry (130 bytes, populated implementation
slot, empty admin slot).

---

## Defect C — a check that was never written, whose conclusion is stated anyway

**Lines 240-242**, with the consequence at **247-250**. **This is a different defect class.**

```
lock: false,      // "XyloVault has none; a general vault with a lock would surface as a
delay: false,     //  selector, TODO on demand"
cooldown: false,
```

These are **hardcoded literals**. No selector scan, no storage read, no call — nothing is checked,
ever, for any vault. The comment is honest about it and marks a TODO.

The problem is what happens downstream: the `reversibility` string at `247-250` is built as if those
values were measured, and tells the user:

> **"Reversible in the same transaction (no lock/delay). A withdraw retains ~99.xx% …
> This is NOT a one-way trap"**

**User-visible consequence:** a vault with a withdrawal queue, a cooldown, or a timelocked exit is
disclosed as *instantly reversible and not a one-way trap*. That is the exact property a depositor
would most want checked, and the disclosure is confident about it. The claim was true of XyloVault
when written, and is asserted for every vault the allowlist ever grows to include.

**Why it needs a different fix from A and B:** A and B are *runtime* failures — the code tries and
the fallback lies. C never tries. A tri-state cannot help a check that doesn't exist; the value is
not `unreadable`, it is **unknown-because-unimplemented**. Fixing C means either writing the check
or telling the truth about not having written it.

---

## Secondary findings (same family, lower severity)

**D — three power groups are defined but never scanned.** `POWER_SIGS` (`105-113`) declares
`setStrategy`, `setFeeRecipient`, and `transferOwnership`; only `emergencyWithdraw`, `feesSettable`,
`pausable`, and `upgradeable` are ever passed to `hasAny` (`227-231`). The disclosure therefore
never mentions that the owner can redirect the strategy, redirect fee recipients, or transfer
ownership. This is the same *described-but-not-coded* shape as C: the signature lists read as
coverage, and a future maintainer would reasonably assume they are wired.

**E — an unread `totalAssets` silently skips a BLOCK.** `isShell` (`224`) is
`totalAssets !== null && Number(totalAssets) === 0`, so a `null` from a failed sub-call makes
`isShell` false and the `empty-shell` BLOCK at `293` never fires. Fail-open, but narrower than A-C:
it suppresses a block rather than asserting a falsehood, and in deposit context an unread `asset`
usually BLOCKs on `asset-mismatch` first.

**Contrast — where the file gets it right**, which shows the pattern is understood in places:
an unread `withdrawFee` yields `reversibility: "unknown"` (`248-249`) — the one spot that names its
own gap; an unread `asset` BLOCKs via `gateDeposit`; and unread bytecode BLOCKs at `291` (though its
message, *"No bytecode at this address — it is not a deployed contract"*, asserts a falsehood while
reaching a safe outcome).

---

## Blast radius — small today, and that is not a reason to defer

**Why it is contained right now:**

- **One-vault allowlist.** `VAULT_ALLOWLIST` (`33-44`) has a single entry; `resolveVault` rejects
  free-form addresses, so only XyloVault is reachable.
- **Proxied vaults BLOCK before this matters.** Conformance is selector-in-bytecode against the
  address's own code (`189`), so any delegating proxy fails `not-erc4626` and is refused — for the
  wrong reason, but refused.
- **A regression test pins the known-bad case.** `verify-vault.mjs` asserts XyloVault still trips
  WARN, so the allowlisted vault's `emergencyWithdraw` / settable-fee / EOA-owner warnings cannot
  silently vanish.
- **The ack is bound to the disclosure.** `disclosureDigest` (`337-341`) covers warn codes and
  current fees, so an ack minted against a disclosure that dropped a warning will not match a later
  correct one — it forces re-review rather than persisting.

**Why it is still a real defect:**

- Every mitigation above is **contextual, not structural**. They are properties of today's
  configuration — one vault, testnet, a passing regression test — not of the inspector. Widen the
  allowlist or move to mainnet and all three defects become live simultaneously.
- The ack binding limits *persistence*, not *occurrence*. It cannot stop a user acknowledging a
  disclosure that says "Ownership renounced" and "Not upgradeable" in the moment those claims are
  false. The user's consent is obtained against fabricated reassurance.
- This is the code path that gates **real deposits**. The failure direction is toward permitting.
- The trigger is not exotic. It is **RPC flakiness on a public endpoint we already document as
  throttled**, which is why `multiRead` was built in the first place (`64-68`).

The honest summary: **not an incident, and a hazard that arms itself the moment the allowlist grows.**

---

## Recommended fix

**Put a tri-state in the primitive, not patches at each call site.**

Every read that feeds a disclosure should resolve to one of three states, and the distinction must
live in the reading layer (`withRetry` / `multiRead` / `tryRead`) rather than being reconstructed by
each consumer:

- **`present`** — read succeeded, here is the value
- **`absent`** — read succeeded, the thing genuinely is not there (no `owner()`, empty slot)
- **`unreadable`** — the read did not complete

Then make the rendering rule explicit: **`unreadable` never renders as a safety claim.** It renders
as "could not verify," and it should suppress any WARN-clearing effect rather than grant one.

Doing this per-caller would be the wrong fix twice over: it is the same three-line mistake repeated
at every site, and — the reason it matters here — the generic half of this file (owner
classification, the EIP-1967 probe, the selector primitives) is exactly what a shared DD core would
lift. **Extracting it as-is copies A and B into the core**, where they would be inherited by every
future consumer rather than confined to vault deposits.

`readBalanceStrict` already demonstrates the strictest version of this rule — refuse rather than
invent. Tri-state is the same principle applied where refusing outright is too blunt, because a
disclosure should still render with a hole in it rather than fail entirely.

### C can be fixed for free, today

C does not need the tri-state and should not wait for it. The check does not exist, so the only
defect is the **claim** — and the claim is a string.

Changing `reversibility` to report lock/delay/cooldown as **"unknown — not checked"**, exactly as it
already does for an unreadable `withdrawFee` (`248-249`), removes the false assertion at zero risk
and with no new reads. The pattern is already in the file, one line away. Writing the actual
lock/delay detection can then be scheduled on its merits instead of being the blocker on not
misleading anyone.

D is the same free fix: either wire the three declared power groups into `hasAny`, or delete them so
they stop reading as coverage.

---

## What this report does not claim

- No exploit is demonstrated. No vault has been shown to have been misreported in production, and
  no logs were examined for an occurrence.
- Severity is argued from the code path and its failure direction, not from an observed incident.
- The mitigations listed are real and were verified in the source, not assumed.
- Line numbers are against `_vault.mjs` as of 2026-07-24 (536 lines); they will drift with any edit.
