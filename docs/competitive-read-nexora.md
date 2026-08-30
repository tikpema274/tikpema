# COMPETITIVE READ — Nexora (`nexorafi.app`)

**2026-08-30. Public sources only. ⛔ NOTHING SENT BUT GETs.**

Prompted by a bare URL. Recorded because the overlap with this project's thesis is close to total and
the field being crowded is itself a fact worth having written down.

---

## ⚠️ METHOD, AND ITS LIMITS — READ BEFORE ANY CLAIM BELOW

| what was done | what it can support |
|---|---|
| fetched the public HTML + JS bundle, read string literals | what the app **says** and how its **client** is coded |
| unauthenticated **GET** to public API endpoints | what the backend **reports about itself** |
| `eth_getCode` on Arc for addresses found in the bundle | whether a contract is **deployed** |

⛔ **NO POST WAS SENT.** `/verify` and `/settle` are money-path endpoints on someone else's system,
and a "harmless" malformed POST is still an execution attempt. **So nothing here tests their
facilitator's actual wire behaviour** — see the last section.

⚠️ **And nothing here is intrusive or private.** Every value came from a public page, a public
endpoint, or a public chain. Third-party **owner** addresses are truncated below by the standing rule
(contracts full, owner identities truncated); contract addresses are given in full because they are
the artefacts under discussion.

---

## 1. WHAT IT IS

**"Nexora — The financial control layer for AI agents."** Vercel-hosted SPA, ~2.4 MB bundle, backend
at `nexorafibackend.vercel.app`.

Verbatim positioning from the bundle:

> *"A control plane for agent payments and USDC services."*
> *"A safer way to let agents spend USDC."*
> *"Agent finance, not another wallet dashboard."*
> *"Agent-native USDC payments and earning infrastructure, built **Arc-first**."*

## 2. 🚨 THE OVERLAP IS NEARLY TOTAL

| theirs, verbatim | ours |
|---|---|
| *"Apply transaction caps, allowlists, cooldowns, and approval thresholds before an automated wallet spends."* | per-tx cap + day ceiling + pause, in `executeAction` |
| *"Circle developer-controlled wallets settle policy-approved USDC payments on Arc Testnet."* | the same stack |
| *"Check a target contract before an agent signs, approves, swaps, pays, or adds it to policy allowlists."* | **the DD engine** |
| *"Change an entitlement or internal balance only after a verified receipt."* | verified-not-claimed receipts |
| *"Build policy-aware x402 payments"* | x402 seller + DD facilitator |
| *"Compare Arc liquidity routes and route USDC into Save/Earn"* | vault / Save-Earn |

⭐ **Their Arc USDC address is byte-identical to `_arc.mjs:10`** (`0x3600…0000`) — checked, not
recalled. Same chain, same token, same rails.

⭐⭐ **And several of their marketplace listings ARE our DD engine as a product**: *"Contract Safety
Check"*, *"Wallet Risk + Approval Scan"*, *"Agent Transaction Preflight"*, *"Agent Policy Risk
Review"*. The gap `agent-pipeline-safety-gap` names — decode → *who can rug this?* → sign — they sell
as catalog items.

## 3. ARCHITECTURE, AS OBSERVED

**46 API endpoints**, coherently grouped: x402 (`/verify` `/settle` `/supported` `/authorize`
`/facilitator-settle` `/settlement/requirements` `/settlement/verify` `/analytics`), payment intents
(`approve` / `authorization` / `external-receipt`), policy (`/policies/simulate`,
`/agent-approvals`, `/automation/{evaluate,recipes}`), marketplace (`catalog`, `services`,
`canonical-routes/reconcile`, `public/builders`, `monetization/plans`, `revenue`), Circle
(`agent-marketplace/{intents,guard,inspect,readiness}`, `nanopayments/*`), rails (`gateway/estimate`,
`gateway/transfer`, `escrows`, `earn/optimizer`), and notifications (email + **Telegram**).

**Chains:** `eip155:5042002` (Arc), `84532` (Base Sepolia), `421614` (Arbitrum Sepolia), plus a
"BOT chain" on USDT.

**Contracts — deployment MEASURED on Arc via `eth_getCode`:**

| address | on Arc |
|---|---|
| `0x870757eEA236Fe0cD45c7013d97E09AEbFc800A4` | **558 bytes — deployed** |
| `0xC3B8F27faf07D4E25fa24459aC2003DAa04e741d` | **223 bytes — deployed** |
| `0xBEA95761fb313Dc0Ee90cc8EB2e2ad7b405EaC68` | 0 bytes — not on Arc (consistent with the multi-chain set) |

⚠️ **558 and 223 bytes are SMALL** — plausible proxies or minimal contracts. ⛔ Do not read "full
implementation" into a deployed address; this repo has already misread a 0/6-selector proxy once
([[probe-must-discriminate-between-states]]). Presence was measured; **purpose was not.**

**Commercial model, which this project does not have:** `MARKETPLACE_FEE_BPS: "200"` — a **2% rake** —
plus `TREASURY_ADDRESS`, `/api/revenue`, `/api/monetization/plans`, `/api/x402/analytics`. They are
building a two-sided marketplace that takes a cut; we built a service that charges for itself.

## 4. WHAT IS ACTUALLY WIRED — self-reported, and that distinction matters

`GET /api/readiness` → `ready: true`, `missing: []`, with **8 items configured**: `DATABASE_URL`,
`CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `FACILITATOR_PRIVATE_KEY`, `POLICY_REGISTRY_ADDRESS`,
`X402_LEDGER_ADDRESS`, `REPUTATION_ADDRESS`, `TREASURY_ADDRESS`.

⚠️ **THIS IS A SELF-REPORT THAT ENV VARS ARE SET.** It is structurally the same class of evidence as
"the deploy went green" — it says configuration exists, not that any path works.
[[success-message-is-not-evidence-of-effect]]

## 5. x402 CONFORMANCE — the axis this codebase has measured most carefully

⭐⭐ **Their version-to-transport mapping is CORRECT**, including the part Circle's own index gets
wrong. From the bundle, the request header is selected from the payload's own version:

```js
(Number(paymentPayload.x402Version) === 2 ? 2 : 1) === 2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT"
```

Their seller mirrors it (`version===2 → error:"PAYMENT-SIGNATURE header is required"`), and receipts
differentiate (`v2 → PAYMENT-RESPONSE`, `v1 → X-PAYMENT-RESPONSE`). **That is exactly the rule
`shared/x402/version.mjs` exists to pin.** [[x402-version-and-index-normalization]]

`/supported` returns `x402Version: 2`, `supportedVersions: [1,2]`, five kinds, and **extends the spec
shape** with `asset`, `assetSymbol`, `settlement` and `facilitator` per kind —
`erc3009-transferWithAuthorization` on the USDC chains, `permit2-x402ExactPermit2Proxy` on BOT chain.
⭐ Publishing the settlement mechanism per route is something we do not do and arguably should.

⚠️ **One row of their own docs table disagrees with our measurement:** they list v1's challenge as a
`PAYMENT-REQUIRED` header, where we measured v1's challenge surface as the **JSON body, no header**.
⛔ Not called a defect — it is a docs component, not the wire, and no v1 request was made.

## 6. 🚨 TWO DISCREPANCIES BETWEEN THEIR OWN ENDPOINTS

1. **Who settles?** `/api/x402/supported` says `"facilitator": "Nexora"` on arc-testnet, while
   `/api/marketplace/catalog` says `"facilitatorUrl": "https://gateway-api-testnet.circle.com"`.
   They run their own facilitator *and* the marketplace seller points at **Circle's Gateway** — the
   one we measured where `success:true` precedes the money moving by a ~15.4-minute flush cycle
   ([[gateway-settlement-measured]]). Two answers to one question; which applies to a given payment
   is not visible from outside.
2. **The buyer-facing catalog is empty.** `/api/marketplace/catalog` carries
   `schemaVersion, marketplace, x402, ledgerRoutes` and **no services array**, while
   `/api/public/builders` lists 58.

`mainnetActivation.allowed: false` — testnet only, same as us.

## 7. ⛔ TWO CORRECTIONS MADE DURING THIS INVESTIGATION — recorded, not quietly fixed

1. **"The marketplace is empty."** I inferred that from the onboarding string *"Be the first to
   publish an x402 service"*. **Wrong** — that is copy, not state. `/public/builders` returns 58
   services. ⚠️ An inference from marketing copy is not a measurement of state.
2. **"4 builders, 58 services."** Also wrong. The first builder's address is **byte-identical to the
   catalog's own `sellerAddress`** — it is the house. So: **3 third-party builders**, and one of
   those holds **50 near-duplicate listings** (*"Wallet Risk + Approval Scan"* ×3, *"Grant
   Application Reviewer"* ×3, a `watchpage` ×2, an `Agent Policy Risk Review13`) that read as one
   operator's fixtures. **Genuine independent supply: 3 builders, 8 services.**

⭐ Both errors ran the same way — a number or a claim read off a surface and stated with more
confidence than the surface supports. [[conversation-sourced-numbers-must-be-marked]]

## 8. THE STRATEGIC READ

**They are broader; the depth question is open and cannot be answered from outside.**

Broader is not arguable: Postgres, three chains plus a fourth ecosystem, a policy registry, an x402
ledger, a reputation contract, escrow, Telegram alerts, an SDK with route types, and a marketplace
with a 2% rake. That is platform surface this project does not have.

⭐ **What cannot be seen from here is whether any of it is PROVEN.** This project's distinguishing
asset is not features — it is that its claims have live evidence behind them: burns, both swap
directions, a measured fee ceiling, a log pin shown to exclude 1e12 of double-count, gates calibrated
red against a build they must fail, pre-registrations written before runs. **Whether Nexora has an
equivalent discipline is invisible to a GET**, and ⛔ **their absence of visible evidence is not
evidence of absence** — precisely the error made today about our own `"slippage"` grep.

⚠️ So the honest conclusion is narrow: **the thesis is not unique and the field is filling in fast
with more surface than we have.** That sharpens [[agentic-economy-competitive-posture]] — assert by
depth, because breadth is now demonstrably contested — rather than refuting it.

## 9. ⛔ WHAT IS NOT ESTABLISHED

- **That their facilitator behaves as declared.** `supportedVersions: [1,2]` is a claim. The correct
  header-selection code is evidence about their **client**, not proof the **facilitator** honours a
  v1 `X-PAYMENT` on the wire. Settling it means sending a real payment — its own decision, with its
  own pre-registration, and not taken unprompted.
- **What their deployed contracts DO.** Presence measured; purpose not probed.
- **Whether any of it has ever moved real money**, on testnet or otherwise.
- **Anything about the people or the company.** Not looked for, not inferred, not recorded.
