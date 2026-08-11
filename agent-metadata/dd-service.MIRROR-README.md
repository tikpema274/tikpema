# DD service — MIRROR README (the mutable companion to a frozen document)

**This file corrects `agent-metadata/dd-service.json`. That document is FROZEN and its bytes must
never change.**

## Why the frozen doc cannot simply be edited

`dd-service.json` is pinned at CID `bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4`
(sha256 `d3734acc…`), and that CID is the on-chain `tokenURI` of **ERC-8004 agentId 851891**
(registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`, chain 5042002, tx `0xd33cb296…`).

⭐ **`tokenURI == CID` is the ONLY discriminator between this identity and the other one.** The
unified doc (`unified.json`, CID `bafkreidoeond3…`, agentId **851823**) shares the same owning
wallet. Editing `dd-service.json` changes its CID, breaks that equality, and destroys the one
mechanism that says which document describes which agent. **A correction that costs you the
identity binding is not a correction.**

⚠️ `mutable_companion` in the frozen doc is **`null`** — it reserved no pointer, so nothing in the
document itself will lead a reader here. Until a future registration updates the `tokenURI`, this
file is discoverable only from the repo. **State that plainly rather than assuming a reader will
find it.**

---

## 🚨 FOUR CLAIMS IN THE FROZEN DOC ARE NOW FALSE

All four said "NOT built" and described the service as of commit `3e27042`. Each is now built,
shipped, and — as of **2026-08-11** — proven on a real paid transaction.

| frozen doc says | actual state |
|---|---|
| `payment / x402 metering — NOT built` | ✅ **BUILT AND PROVEN ON REAL MONEY.** Facilitator `netlify/functions/_dd-x402.mjs`. A real purchase settled **exactly 60000 atomic (0.060000 USDC)** into the dedicated revenue wallet `0xb407967319d56218c7e1c369125490e665a16ac4`, confirmed by chain read, not by the seller's own word. |
| `HTTP interface — NOT built (the service is a callable function, not an endpoint)` | ✅ **BUILT.** `POST /.netlify/functions/dd-analyze` issues a real 402 challenge and serves the paid artifact. |
| `cryptographically signed reports — NOT built. No signing code exists.` ⚠️ *"signing is DESIGNED AGAINST A DEV/THROWAWAY KEY ONLY; there is no registered service identity"* | ✅ **BUILT, AND THE KEY CAVEAT IS RESOLVED.** Reports carry an **ERC-1271** attestation bound to **agentId 851891** — a *registered* identity, not a throwaway. Verified against live Arc: `valid:true, reason:"ok", method:"erc1271", keyClass:"registered"`, `isValidSignature` answered by the on-chain owner `0xc54D4721…`. |
| `canary / liveness attestation — NOT built` | ✅ **BUILT.** `dd-canary` on `*/10`, writing a health artifact bound to the **deploy id**; `dd-analyze` refuses `service-unverified` without a fresh, version-matched pass. |

## What has NOT changed, and must not be read as also corrected

* **Coverage is a manifest, not a clean bill.** The report states what was and was not checked, and
  that manifest is inside the signed payload so it cannot be stripped.
* **Severity is scope-not-rank** — non-ordinal, and must not be summed, ranked, averaged or
  aggregated into a score.
* **INDETERMINATE ≠ FAIL.** Absence of a finding is never evidence of safety.
* **Payment confirmation is AGGREGATE-ONLY.** It reads `availableBalance(USDC, payTo)` and cannot
  distinguish concurrent equal-amount payments. The revenue wallet's zero history is what makes
  reconciliation attributable — **it must receive nothing but DD revenue, ever.**
* **The service does not charge when it cannot deliver.** An unsigned attestation, an unreachable
  chain or a refusal returns the complete report **free**, with the payment authorization unspent.

## First revenue — the proving transaction

```
2026-08-11   draft deploy 6a7ada8e57557d271adc561e
402 → pay → 202 + handle → retrieve → 200          798.5s (13.3 min, inside the measured 42s–15.5min band)
handle       397b67b1-76fe-4578-9b88-ccf1e3773a3b
revenue      0 → 60000 atomic = exactly 0.060000 USDC   (chain read, availableBalance)
report       refusal:null · coverage 15 checked / 0 not
attestation  signed · agentId 851891 · canon/1 · ERC-1271 valid:true on chain
```

## 🚨 THE PIN IS NOW A PERMANENT OBLIGATION — created by the first sale

`bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4` **must stay pinned indefinitely.**

Two paid reports were produced under it. Verifying either runs `tokenURI(851891)` → this identity
document → the capability and coverage claims that were **live when that report was produced**.

⭐ **IF THE PIN LAPSES, THOSE REPORTS STOP BEING CHECKABLE.** The signature keeps verifying —
`isValidSignature` is a chain call and needs no IPFS — but *what was being attested to* becomes
unresolvable. A buyer is left holding a valid signature over claims nobody can retrieve, which is
exactly the auditability they paid for. The product fails **after** delivery, silently.

⚠️ **AND THE SET ONLY GROWS.** `supersession_rules` requires prior CIDs stay pinned, so every future
version **adds** a CID and removes none — a monotonically increasing commitment that **did not exist
before the first sale**. Budget for it; never unpin to reclaim quota. Operational copy lives at the
top of `scripts/pin-invariants.mjs`, where anyone touching Pinata will meet it.

## Supersession, not a mirror, is the fix for the stale claims above

⭐ **This README is the wrong instrument for correcting a load-bearing claim, and the frozen document
says so.** Its `mutable_companion` note reserves the mirror for what *cannot* be frozen — "carry the
agentId after registration" — not for restating capability. And `mutable_companion` is **`null`**, so
nothing points here: a verifier following `tokenURI` reads the stale document and never arrives.

The document's own `mutability_posture.decision` prescribes the remedy: *"an immutable
content-addressed document, a mutable on-chain pointer, and **supersession by new version rather than
edit**."* The re-point power is verified — `setAgentURI(uint256,string)` selector `0x0af28bd3` present
in the deployed registry implementation.

**A superseding version must:** state capability scoped to the **then-current commit** (not to "now",
or it rots identically); set `supersedes` to the prior version **and CID**; and set
`mutable_companion` to this file, closing the `null` that left the frozen document pointing nowhere.

⚠️ **Deliberately deferred until the launch work settles** — exposure, the refusal window, monitoring
and any MCP surface are all in flight, and a commit-scoped document authored mid-flight would need
superseding twice.

⭐ **The uncomfortable symmetry, which the frozen document names about itself:** `setAgentURI` is the
*same power class* this service flags in other people's contracts — re-pointable metadata. Exercising
it is honest only because the pointer move is **visible on-chain** and prior CIDs stay resolvable.

⚠️ **The service is NOT publicly enabled** at the time of writing. `DD_PUBLIC_ENABLED` and
`DD_PAYTO_ADDRESS` were set on `deploy-preview` only. This document describes a capability that is
proven, not necessarily one that is published — check the live environment, not this sentence.
