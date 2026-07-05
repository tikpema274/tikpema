
---

## Session update — pay_for_service + shared execution refactor

All committed on `main` (local; no GitHub remote configured yet).

### What shipped
- **`pay-service` function** (`_pay.mjs` + `pay-service.mjs`) — the delegate-signed Gateway spend, proven last session as a script, now a guarded Netlify endpoint. Agent pays USDC from its Unified/Gateway balance via the EOA delegate; spend cap enforced; the code-1098/5001 async-waiter quirk caught and reported as `submitted`. Proven on-chain (seller wallet climbed correctly).
- **`pay_for_service` wired into the agent** (`agent-act.mjs` + `AgentPanel.tsx`) — the agent now triggers the Gateway payment from natural language ("pay 0.1 USDC from the Gateway balance to 0x…"). Disambiguation holds: plain "send" → `transfer_usdc` (regular balance); "pay from Gateway / for a service" → `pay_for_service` (delegate). Both proven on-chain.
- **Shared execution refactor** (`_actions.mjs`, branch `refactor/agent-act-shared-execution` → merged to `main`, commit `3349d46`) — extracted swap/pay/transfer execution into `executeAction(step, ctx)` + `valueOfStep(step)`. All three agent branches now route through this shared layer. Cap stays in the caller; `executeAction` validates shape + executes only. Verified: all three actions behave identically on-chain (transfer tx `0x16b5…3893`, swap tx `0x5164…7e67`, pay settled, Gateway balance → 1.086). This is the foundation for multi-step AND future surfaces (UI, research flow).

### The agent's money actions (all live, all guarded, all natural-language)
- `transfer_usdc` — send from regular balance
- `swap_tokens` — USDC↔EURC
- `pay_for_service` — pay from Gateway balance via delegate

### Next session — the multi-step feature (designed, not built)
Build the plan → confirm → execute layer on top of `executeAction`. Design calls already made:
- **Stop-on-failure** (on-chain can't roll back; do steps in order, stop at first failure, report what completed).
- **Total cap** (sum the USD value of all steps via `valueOfStep`, check against AGENT_MAX_SPEND_USDC before executing any).
- **Plan-then-confirm** (two-turn flow): `agent-act` detects a multi-step task and returns `{ needsConfirm, plan, totalUsdc }` instead of executing; UI shows the plan + a "Confirm & execute" button; a new `agent-execute-plan.mjs` endpoint loops `executeAction` over the confirmed steps. Client holds the plan between turns (server stays stateless).

### Loose ends
- **GitHub backup** not set up (no remote, no gh CLI). Clean standalone task when fresh: create repo, set up a PAT or `gh auth login`, push all history.
- `x402-pay.mjs` still parked (x402-protocol buyer, blocked on SCA signature — which the delegate now solves; could be revived).

---

# THREE-SESSION SUMMARY — pay_for_service → multi-step → x402 buyer

## Session 1 — pay_for_service + shared execution refactor
- **`pay-service`** (`_pay.mjs` + `pay-service.mjs`) — the delegate-signed Gateway
  spend became a guarded Netlify endpoint. Agent pays USDC from its Unified/Gateway
  balance via the EOA delegate; spend cap enforced; code-1098/5001 async-waiter
  quirk caught and reported "submitted". Proven on-chain.
- **`pay_for_service` wired into the agent** — natural-language Gateway payments
  ("pay 0.1 USDC from the Gateway balance to 0x…"). Disambiguation holds: plain
  "send" → transfer_usdc (regular balance); "pay from Gateway" → pay_for_service
  (delegate). Both proven on-chain.
- **Shared execution refactor** (`_actions.mjs`, commit `3349d46`) — extracted
  swap/pay/transfer into `executeAction(step, ctx)` + `valueOfStep(step)`. All three
  agent branches route through it. Cap stays in the caller. Foundation for multi-step
  AND future surfaces. Verified: all three actions behave identically on-chain.
  (Note: heavy edit-mechanic friction with heredocs — handed the extraction to
  Claude Code, which edits files directly. Lesson institutionalized.)

## Session 2 — multi-step feature (plan → confirm → execute)
The agent now handles multi-action tasks, built on `executeAction`. Three commits:
- **Executor** (`agent-execute-plan.mjs`, `f4a6e47`) — TOTAL cap up front (sum all
  steps' USD value, block before executing any), STOP-ON-FAILURE (in order, halt at
  first failure, no rollback), batched-settlement-aware per-step state ("submitted"
  vs "completed"). Pending transfer stops the plan (conservative).
- **Plan-detection** (`agent-act.mjs`, `a988e14`) — agent returns
  `{ needsConfirm, plan, totalUsdc }` WITHOUT executing. Distinct from
  needs_confirmation (which refuses scheduling/conditional).
- **UI** (`AgentPanel.tsx` + `agentClient.ts` + `netlify.toml`, `8fc354b`) — renders
  the plan + "Confirm & execute" button; on click POSTs to agent-execute-plan and
  renders per-step ✓/✗ results.
- Proven end to end in-browser, on-chain (seller reached 0.8 USDC via a multi-step pay).

### THE REDIRECT BUG (worth remembering)
The final blocker was self-inflicted: editing netlify.toml stripped `status = 200`
from the `/api/agent-act` rewrite, turning it into a 301 redirect. A browser follows
a 301 on a POST and DOWNGRADES it to GET → function 405s "POST only." curl masked it
(doesn't follow redirects by default), so it failed ONLY in-browser. Diagnosed via
curl-vs-browser isolation + a JS stack trace pointing at `act` + `num_redirects=0`
after the fix. **LESSON: every `/api/*` → function redirect in netlify.toml MUST have
`status = 200` (rewrite preserves POST). A 301 downgrades POST→GET.**

## Session 3 — x402-protocol buyer revived (commit `6909b64`)
Revived the parked `x402-pay.mjs` into a WORKING true x402 buyer (402 → sign → settle).
Proven on-chain: closed-loop test (our buyer → our x402-quote seller) returned HTTP 200,
`settleReceipt.success: true`, delegate Gateway balance debited exactly 0.001 USDC.

### The key architectural finding (proven by testing, not assumed)
- **The SCA's Gateway balance is UNREACHABLE via the batched x402 scheme.** The
  `@circle-fin/x402-batching` facilitator enforces `ecrecover(signature) == from`
  off-chain — there is NO depositor/signer split in the batched header format. So:
  SCA sig is ERC-1271 → rejected; a delegate sig signing for the SCA recovers to
  ≠`from` → rejected. (Confirmed via live /v1/x402/verify test, not guessed.)
- **This differs from the general Gateway delegate model** (`_pay.mjs` /
  pay_for_service), which DOES support depositor≠signer — but that uses the full
  burn-intent / App Kit spend flow, NOT the batched x402 header path. Two different
  layers; the depositor/signer split works in one, not the other.
- **Correct model = EOA-as-payer:** the payer EOA holds its OWN Gateway balance AND
  signs `from = itself`. Matches Circle's own documented "EOA-only for signing"
  guidance. The failed "elegant decoupling" attempt (SCA balance + delegate sig) was
  refuted by the test; we let the result redirect us to the correct architecture.
- **`depositFor` funding technique:** the SCA funded the delegate EOA's Gateway
  balance directly via `depositFor(USDC, delegate, 5e6)`, since the delegate EOA had
  no native USDC for gas. Reusable trick for funding an EOA's Gateway balance from
  the SCA.

### Status: PROVEN STANDALONE, NOT WIRED
x402-pay is committed as a proven standalone buyer, deliberately NOT wired into
agent-act. Reason: there are no external Arc x402 sellers yet (Exa's x402 is
Base/Solana only), so the only seller it can call is our own x402-quote — wiring it
into natural-language chat now would add a second confusing payment path (delegate
EOA balance vs SCA balance; x402 protocol vs App Kit spend) for a demo-only capability.
**Trigger to wire it later: an actual external Arc x402 seller to buy from.**

## Agent capabilities now
- Single actions: transfer_usdc (regular balance), swap_tokens (USDC↔EURC),
  pay_for_service (SCA Gateway balance via delegate) — all guarded, natural-language.
- Multi-step plans: decompose → confirm → execute, total cap + stop-on-failure.
- x402 buyer: proven standalone (not agent-wired), delegate-EOA-funded.
- Research-for-hire: ERC-8183 job loop live (job #145459 — priced, funded, Exa-
  researched, evaluated, settled on-chain, sourced answer delivered).

## Still open (no urgency)
- Wire x402-pay into agent-act — WHEN an external Arc x402 seller exists.
- Research-bound payment — deepen the "pay for data, get research" loop (partly live
  via ERC-8183).
- Compliance Engine (wallet screening / address pre-screening) — a MAINNET concern,
  relevant only if the agent pays arbitrary external recipients on mainnet. Not now.
- GitHub backup — still no remote (deploys via Netlify CLI); clean standalone task
  when fresh: create repo, PAT/gh auth, push all history.

---

# SESSION — Autonomous mid-research data purchases (Phase 2a) COMPLETE

## The vision, realized
Tikpema's research agent can now **autonomously buy paid data mid-research**, governed
by a budget spine with hard caps, incorporate the bought data into the delivered brief,
and settle on-chain — all proven end to end on testnet against our own stand-in seller.
This is the "AI Research Analyst that pays for its own inputs" North Star, proven safely.

## How we got here — the ecosystem investigation
- Discovered the **Circle Agent Marketplace** (agents.circle.com) — 474 resources across
  20 providers, agents paying APIs in USDC via x402. Real external data sellers exist
  (Exa, Parallel, Tavily, Google Scholar, Messari, etc.).
- **Ground-truth finding (via Circle's discovery API `GET api.circle.com/v2/x402/discovery/resources`):**
  the marketplace is **mainnet-only** — ZERO testnet endpoints anywhere. Base-dominant
  (eip155:8453), plus Polygon/Ethereum/Arbitrum/etc. and Solana. No Arc.
- **Two schemes:** vanilla x402 (`extra.name:"USD Coin"`, on-chain USDC transfer) — the
  majority incl. Exa & Parallel; and Gateway-batched (`GatewayWalletBatched`,
  supportsCircleGateway) — only 4 providers (AIsa, Alchemy, Arrays, BlockRun.AI). Our
  proven x402-pay buyer speaks ONLY the batched scheme.
- **Consequence:** reaching the research-relevant sellers (Exa/Parallel) needs a
  NEW vanilla-x402 buyer on Base MAINNET with real USDC — a deliberate mainnet project,
  deferred. So Phase 2a proves the whole pattern on TESTNET against our own stand-in.

## Design decisions (locked)
- Budgets: **persisted** (Netlify Blobs) — real per-day/per-period caps across jobs.
- Money: data allowance **carved from the user's job payment** (their price includes a
  data allowance the agent spends on their behalf).
- Trigger: **Claude-brain decides mid-research** ("I need source X") — genuine autonomy.
- Purchase failure: **graceful degradation** — proceed Exa-only, charge only on confirmed buy.
- Decision: **binary** (buy the one stand-in dataset or not), fixed price.

## What shipped (all committed, testnet, brick-by-brick)
1. **Budget spine** (`_budget.mjs`, commit `91ed463`) — three env-configurable caps:
   DATA_ALLOWANCE_PCT=0.30 (per-job allowance = price × pct), PER_PURCHASE_PCT=0.50
   (max single buy = allowance × pct), PERIOD_CEILING_USDC=2.00 (rolling UTC day).
   Exports canSpend/recordSpend/recordBlocked/jobSpend/daySpend/auditLog. Float-safe
   (cap math in atomic 6dp integers). Store-injectable (in-memory for tests, Blobs in
   prod). 26 isolated assertions pass. (Note: test file renamed `_budget-test.mjs` —
   dots break Netlify function names.)
2. **x402 buyer refactored to importable** (`_x402.mjs`, exports `payX402({sellerUrl,
   jobContext})`; `x402-pay.mjs` slimmed 270→27-line thin wrapper). Pure refactor,
   closed-loop test still passes identically.
3. **Plumbing** — `jobId`+`jobPrice` threaded into `research()` (jobPrice surfaced from
   `job.budget` already read on-chain in C1; atomic→USDC verified: 5000000→5 USDC).
   Stand-in seller `x402-quote` returns canned `{topic, facts:[{claim,source}×3]}` on
   paid 200 (402/settle unchanged).
4. **The autonomous loop** (`_research.mjs` Exa branch, commit `707d5db`) — two-phase:
   exaSearch → **decision call** (decidePurchase → {buy, justification}) → **budget gate**
   (canSpend) → **purchase** (payX402, graceful degradation, recordSpend only on success)
   → **merge** (purchased {claim,source} folded into grounding block AND the line-97
   sources override so citations survive) → synthesis. Downstream (hash/submit/evaluate/
   settle) untouched — consumes only the final brief.

## Both paths PROVEN (isolated harness, real on-chain job 1, jobPrice=5 USDC, real Exa+Anthropic+x402 settle)
- **ALLOWED:** decision BUY → gate allows → payX402 settled → 3 facts bought for $0.001 →
  purchased sources CITED in brief (merged with Exa) → recordSpend (allowed:true) →
  delegate debited 4.997→4.996.
- **BLOCKED:** decision BUY → gate blocks (per-purchase cap) → recordBlocked (allowed:false)
  → no purchase, no spend, Exa-only brief, balance unchanged.
- **Graceful degradation** proven incidentally (a payer-config failure → no spend, job continued).

## Honest notes
- The **genuine decision call runs in production** and returns reasoned verdicts — it
  SKIPPED when Exa already sufficed (the stand-in data is redundant with Exa by design).
  The buy-branch mechanics are proven via a TEST-ONLY `opts.forceDecision` injection;
  production never sets it, so the real agent always decides for itself.
- This means: the autonomy *mechanics* are proven, but the genuine agent rarely buys the
  redundant stand-in. A real "genuine buy" needs a stand-in dataset NON-redundant with
  Exa (data Exa can't retrieve), so a frugal agent rationally chooses to buy.

## Next steps (two distinct, decide deliberately)
- **Testnet refinement (safe):** give the stand-in a dataset genuinely non-redundant with
  Exa, so the GENUINE decision (no injection) chooses to buy because it's actually worth it.
  Completes the "genuine autonomy" picture on testnet.
- **Mainnet project (deliberate, real money):** reach real marketplace sellers (Exa/Parallel).
  Requires a NEW vanilla-x402 buyer + Base mainnet setup + real USDC + likely compliance
  screening. Tikpema's first mainnet crossing — scope consciously, not by momentum.
- Still open: wire x402-pay into agent-act (when a real external Arc seller exists);
  GitHub backup (no remote yet).

---

# SESSION — Codebase sharpening + GENUINE autonomy proven

## Strategic context
- Read Circle/Arc's "money's second act" manifesto (Rachel Mayer) — Arc positioned as
  the chain for the machine economy: "an agent is a worker… pays for compute, routes
  liquidity, settles with other agents constantly." Tikpema IS a working instance of
  this thesis. Validation + vocabulary for the "why Arc" narrative, not a redirect.
- Joined the **Arc Builders Fund** waitlist (agentic-commerce vertical maps directly to
  Tikpema). "Coming soon" — no deadline pressure; the fund bar is "apps that can only
  exist on Arc." Project-vs-company question left open, to decide deliberately.

## Radical move = SUBTRACTION (committed to the pivot)
Considered reviving prediction markets (agent-takes-positions) but decided AGAINST it —
reopens the gambling/asset-mgmt regulatory door deliberately closed, the closed-demo
version is "theater" (agent bets into empty pool, human resolves), and post-milestone/
pre-fund timing calls for consolidation not expansion. Instead:
- **`e79bfb8`** — removed 10 vestigial prediction files (1,053 lines): predict-bet,
  predict-analyze(+background), predict-start/status, predict-resolve-* (propose/
  background/start), research-start/background. Stripped 6 dead netlify.toml redirects
  + 2 orphaned timeout blocks. Grep-verified zero live references before deleting;
  build+deploy+smoke confirmed live product unaffected (predict-markets still serves,
  research job still runs). KEPT: predict-markets (live), _predict.mjs (publicClient is
  the shared chain-read client), PredictPanel/ResearchPanel/_research.
- **`1a702d2`** — comment hygiene: removed stale references to the deleted files across
  6 modules + netlify.toml. Comments-only, build passes.
- **`2e39b85`** — comment accuracy: `_research.mjs` header now truthfully states it CAN
  spend money (Exa path → maybeBuyData → payX402, budget-gated) — was falsely marked
  "READ ONLY, no transaction". `job-quote.mjs` range corrected [2,15]→[0.20,0.60] to
  match actual code. Deployed; prod in sync.
Note: Claude Code's cursor repeatedly auto-suggested reviving prediction markets (3×);
held the line each time — a tool suggestion is not a decision, and this one was made.

## THE MILESTONE — genuine autonomous economic judgment PROVEN (`5841181`)
Phase 2a proved the purchase *mechanics* but only via the test-only `forceDecision`
injection — because the stand-in data was redundant with Exa, so the honest decision
correctly SKIPPED. This session closed that gap by making the non-redundancy
**structural**, then proving the UNFORCED decision fires.

Build:
- `x402-quote.mjs` paid-200 body → `liveDataset()`: current Arc Testnet metrics (block
  time ~0.92s, Gateway settlement ~470ms, USDC peg) stamped with an `asOf` timestamp
  generated at request time — data indexed web search STRUCTURALLY cannot have. 402/
  settle path untouched.
- `_research.mjs` decision prompt now reasons about recency (web search is indexed/
  stale; a live feed reports "as of now") — but remains free to SKIP. No forced buy.
  `decidePurchase` exported so the proof drives the REAL production path, not a copy.

The two-case gate (real `decidePurchase`, NO injection):
- **CASE A — BUY 2/2** (go/no-go ops brief needing today's live figures, no buy hint):
  genuine reasoning — "requires present-moment figures… retrieved sources only provide
  design-target values, not live operational metrics." → budget ALLOWS ($0.001 vs
  $0.105 allowance) → live figure merged & CITED → recordSpend logs the model's own
  verbatim justification. The delivered brief reads: "GO — Arc Testnet is healthy as of
  2026-07-02T15:25:10Z. Current average block time ~0.92s… settlement latency ~470ms…
  Safe to ship" — citing the paid real-time feed. The bought data CHANGED the answer.
- **CASE B — SKIP 2/2** (definitional "what is Arc/x402" brief, no buy hint): genuine
  decline — "retrieved sources already provide sufficient information… no live figure
  is needed."

BUY-when-warranted AND SKIP-when-not, both from the genuine decision = real judgment,
not a rigged always-buy. Honesty confirmed: no question hints at buying; decidePurchase
logic unchanged (only recency awareness added to the prompt); it still skips B.

**What this proves:** the agent, unprompted, correctly decides WHEN real-time data is
worth paying for, buys it within budget, produces a better answer for it — and declines
when it isn't warranted. The manifesto's machine-economy claim, demonstrated on testnet
with an honest two-case proof. This is the fund-worthy result.

## The one caveat (honest)
The on-chain `payX402` byte-movement was NOT re-run in this proof — the decision→gate→
merge→record loop is proven fresh with real modules, but the actual on-chain settlement
rests on Phase 2a having settled that identical hop live (`4.997→4.996` earlier). A
single fully-end-to-end run (genuine decision → real on-chain settle in one shot) needs
the Gateway-funded delegate EOA in the env — worth doing eventually for the cleanest
pitch/demo artifact, not required to call this proven.

## State / next
- All committed on main (linear, local): `e79bfb8` → `1a702d2` → `2e39b85` → `5841181`.
  Prod in sync. Proof harness `_autonomy-test.mjs` committed inert; re-run:
  `node --env-file=.env netlify/functions/_autonomy-test.mjs`.
- Codebase is now cleanly the agentic-research product: clutter gone, comments honest,
  genuine autonomy proven.
- Open (deliberate, unhurried): (1) single fully-on-chain end-to-end run of the genuine
  decision (needs funded delegate EOA); (2) the mainnet real-seller project (vanilla
  x402 buyer on Base — the deferred crossing); (3) project-vs-company / Builders Fund
  decision; (4) GitHub backup (no remote yet).

---

# MILESTONE — Published a working vanilla-x402 reference for Arc (open source)

## The insight
Hit a real wall: no reliable x402 facilitator on Arc testnet (verified Xylo/
XyloFacilitator broken firsthand — route creation didn't persist; Circle's
marketplace is mainnet-only, all batched scheme). Diagnosed this as an
ECOSYSTEM-WIDE gap, not just ours. Decided to build the missing primitive —
scoped deliberately to Tier 1 (a minimal working reference), NOT a platform
(resisted the "build a public facilitator product" daydream). Primary goal:
unblock our own real-seller testing; secondary: a genuine community/PR artifact.

## Verify-first (on-chain, before building)
Proved Arc testnet USDC (0x3600…0000) is a Circle FiatTokenV2 with full EIP-3009
support — directly on-chain via cast:
- transferWithAuthorization reverts "FiatTokenV2: invalid signature" on garbage
  sig → function exists, runs real ecrecover logic. receiveWithAuthorization
  reverts "caller must be the payee". authorizationState present. Full EIP-3009
  surface live.
- EIP-712 domain confirmed bit-for-bit against on-chain DOMAIN_SEPARATOR():
  {name:"USDC", version:"2", chainId:5042002, verifyingContract:0x3600…0000}.
- Key constraint (same as batched): buyer MUST be an EOA (ecrecover → from==signer;
  an SCA can't produce a valid vanilla auth). Use the delegate EOA.

## Built + proven (brick 1, in Tikpema repo, commit 1fc484f)
Vanilla x402 "exact" seller + buyer pair, settling real USDC on Arc testnet:
- x402-vanilla-seller.mjs: unpaid → spec 402; on X-PAYMENT → guards → settles
  receiveWithAuthorization on-chain from its own wallet (msg.sender==payTo) →
  200 + data + receipt.
- _x402-vanilla.mjs: payX402Vanilla() — 402 → sign EIP-3009 auth (delegate EOA,
  ecrecover-compatible) → X-PAYMENT → settle result.
- Gate passed on-chain: settle tx 0xb7fa38…c551d8, buyer −0.01 / seller +0.01,
  receiveWithAuthorization selector 0xef55bec6, replay rejected (nonce consumed).

## Extracted + published (bricks 2a→2b→2c)
- 2a: extracted to a clean STANDALONE project at ~/arc-x402-reference/ — pure viem
  + local keys, ZERO Tikpema/Circle coupling, PLUGGABLE signing (viem-LocalAccount
  shape), simulateContract-before-settle (gas-efficient, improves on brick 1).
  Re-proven standalone on-chain: settle tx 0x759cbc…70f11. Fresh throwaway EOAs.
- 2b: honest README (flow diagram, the hard-won gotchas — EOA-only buyers, the
  receiveWithAuthorization msg.sender constraint, the exact-EIP-712-domain warning,
  Arc gas floor) + a clear "minimal reference, not audited, use at your own risk"
  scope disclaimer. MIT LICENSE, Copyright (c) 2026 Salifu Sandow Jargani.
- 2c: PUBLISHED PUBLIC → https://github.com/tikpema274/arc-x402-reference
  Verified: repo public, no .env/secrets on the remote, LICENSE name correct.
  (Also: set up gh CLI auth as tikpema274 — GitHub auth now configured, which
  unblocks the long-deferred Tikpema repo backup.)

## What this unblocks / next (deliberate, unhurried)
- We now have a PROVEN vanilla buyer + a REAL vanilla seller — the original goal
  (agent buying from a genuine third-party seller) is much closer; our own vanilla
  seller is a more honest "third party" than the batched stand-in.
- The vanilla buyer is the piece needed for the mainnet Circle marketplace
  (Exa/Parallel are vanilla on Base) — now proven on testnet first, de-risking the
  eventual mainnet crossing.
- PR/visibility (when ready): share the reference in Arc/Circle & Xylo Discords,
  tag the Arc team — converts "published repo" into ecosystem recognition. Ties to
  the Builders Fund thesis (a real shared primitive, not just a private app).
- GitHub backup of the Tikpema repo itself — now trivial (gh authed).

## State
Tikpema repo: brick-1 committed (1fc484f), otherwise untouched, prod in sync.
Standalone reference: live & public at github.com/tikpema274/arc-x402-reference.

---

# Cross-chain bridge: from "it's blocked" to a shipped agent capability (2026-07-05)

## The wall that wasn't
A prior recon had concluded outbound Arc→elsewhere bridging was BLOCKED — "the
agent can't sign the destination mint." That was true only of the RAW CCTP path
(depositForBurn + manual receiveMessage, which needs a destination-chain
signature). Disproved it: Circle App Kit's forwarding path needs just ONE Arc-side
signature — the Orbit relayer does the destination mint. So the real question was
never "can we bridge" but "can the agent's dev-controlled SCA make that one call."

## Verify-first (read the SDKs, not the docs)
Traced the proven path end-to-end through the installed @circle-fin packages:
- Arc Testnet has a custom BridgingKitContract (kitContracts.bridge =
  0xC5567a5E3370d4DBfB0540025078e283e36A363d) → App Kit takes the CUSTOM flow.
- With useForwarder:true the source-chain calls are two on-chain txs:
  usdc.increaseAllowance (preapproval) then cctp.v2.customBurnWithHook →
  contract method bridgeWithPreapprovalAndHook(BridgeParams, hookData). hookData =
  ASCII "cctp-forward" magic bytes. NO EIP-2612 permit on this path → the
  ecrecover-vs-ERC-1271 problem that forced allowanceStrategy:"approve" on swap
  never even arises. The Circle Wallets adapter has first-class SCA handling
  (withScaFeeInterceptor strips SCA-incompatible fee fields).
- kit.estimateBridge (free) resolved the full route for the agent SCA. Feasible.

## The spike + the App Kit dead-end (the honest failure)
Prepared scripts/spike-bridge.mjs (App Kit kit.bridge()). Live attempt FAILED —
but informatively: the approve LANDED on-chain (allowance set), yet App Kit
reported it as code 1098 "Transaction hash is required" (FATAL) because the Circle
SCA submits async and the hash isn't ready synchronously — the SAME race
_swap.mjs documents. App Kit's step state machine halts before the burn. Swap
survives this 1098 (single step, already effective); bridge dies on it (multi-step,
aborts before value moves). No funds lost — the failure was safe.

## The fix: the direct-contract path (scripts/bridge-direct.mjs)
Drove the bridge through Circle's dev-controlled createContractExecutionTransaction
+ waitForTx (the same plumbing that reliably moves funds for send/bets) — it polls
the Circle tx by id and returns the REAL hash, sidestepping the 1098 race. Built
the calldata directly with viem + the exact ABI extracted from adapter-viem-v2;
fetched maxFee live from Circle's IRIS API (providerFee ~0 + forwarderFee, volatile
with destination gas). PROVEN LIVE (user ran it): 15 USDC Arc→Sepolia, burn
0xaf6f5ba2… → Sepolia mint 0xa9fea2c8…, one Arc signature, relayer minted.

## Productized as a real agent action (commit edc119f, deployed prod)
"bridge X USDC to Ethereum" in plain language → agent PROPOSES (amount, live fee,
net) → user confirms → Arc burn → async destination mint, both tx links inline.
- _bridge.mjs: the executor (promoted spike) + bridgeFee() + bridgeMintStatus() +
  8 destinations (Ethereum/Base/Arbitrum/Optimism/Avalanche/Polygon/Unichain/
  Linea), each gated by a live IRIS forwarding tier.
- ONE secure path: bridge_usdc runs through the shared executeAction — auth-gated
  (401 anon), source wallet session-resolved (never client-supplied), per-bridge
  cap (AGENT_BRIDGE_CAP_USDC=25), live FEE-FLOOR refusal (won't attempt an
  un-settleable bridge), per-user day-ceiling + ledger. agent-bridge is the single
  confirmed-execute endpoint; agent-act only proposes; agent-bridge-status polls.
- Config gotcha: PERIOD_CEILING_USDC defaulted to 2 (tuned for tiny data buys) —
  raised to 60 in prod so bridges of meaningful size aren't blocked by the ceiling.
- Verified live by user: 3 USDC Arc→Sepolia settled; fee-floor refusal (1 USDC →
  "too small, fee ~1.55"); per-bridge cap (30 → "exceeds 25"); no send/swap regress.

## Copy + the multi-step gap (commits bf8ca5e, 24a4185)
- bf8ca5e: surfaced bridging in the app-page hero lede + 01–04 ledger (honest —
  dropped "in seconds" so it never implies instant cross-chain; it's ~1–2 min async).
- 24a4185: fixed "unknown step type bridge_usdc" inside multi-step plans. The plan
  path had never learned the step type (KINDS allow-list rejected it; both proposal
  and executor capped every step with the SEND cap). Fix — through the SAME executor
  (no second path): KINDS += bridge_usdc, type-aware per-step cap (bridge→bridgeCap),
  plan prompt teaches bridge steps. Option A "fire-and-continue": executeAction
  returns after the Arc burn (state "submitted") without waiting on the mint, so the
  plan moves on; MyAgentPanel polls each bridge step's mint INLINE (concurrent,
  background) — burned→minting→minted. Per-step caps/fee-floor/day-ceiling still hold.
  Verified live by user: 3-step plan (bridge 2 to Base, swap 1 EURC→USDC, send 3) ran
  all steps, bridge showed inline burned→minted, plan continued.

## What this unblocks / next
- The agent is now genuinely cross-chain: it can move its USDC off Arc to 8 EVM
  networks by natural language, standalone or as a step in a chained plan, all
  guardrailed. Cross-chain was the last "does the SCA even work here" unknown.
- The key reusable lesson: for ANY multi-step Circle-SCA on-chain flow, prefer the
  dev-controlled createContractExecutionTransaction + waitForTx path over App Kit's
  orchestration — the latter's synchronous hash-wait races the SCA's async submit
  (1098) and aborts mid-sequence. Documented in the memory note.

## State
Tikpema repo: bridge feature shipped + prod in sync — commits edc119f (feature),
bf8ca5e (copy), 24a4185 (multi-step fix), all on main, pushed to origin.
Prod env: AGENT_BRIDGE_CAP_USDC=25, PERIOD_CEILING_USDC=60.
Spike scripts kept under scripts/ as the proven reference. Agent wallet 0xc54d…e621.

---

## Session update — passkey/ceiling hardening, cross-chain bridge, refusal copy

*Two-day session. All committed + pushed to private GitHub `tikpema274/tikpema`, verified live.*

### Fixes (committed + pushed, verified live)
- **Passkey login fix** (`c1ae868`) — returning users land in their existing wallet (deterministic restore from stored non-secret credential `{id, publicKey, rpId}`; graceful failure, no silent new-wallet).
- **Smart login/create entry** (`c1ae868`) — one "Continue with your passkey" button (login-if-exists / create-if-new); MetaMask secondary; deliberate/muted "different wallet" escape hatch with honest fresh-wallet copy. Fixes wallet proliferation.
- **Per-user daily ceiling** (`aea98a9`/`44de574`) — was a shared global counter (users blocked each other); now keyed `day:<owner>:<date>` per server-resolved wallet. Verified live: wallet A maxed ≠ wallet B blocked.
- **Agent-first copy reframe** (`7297c37`, `bf8ca5e`) — app page reframed from "research analyst" to "autonomous agent" (research as flagship + send/swap/multi-task/bridge); one consistent voice; honest (no "caps you control" — caps are env-set, not user-adjustable).
- **Refusal copy fix** (`e58bd9e`) — plain wording for scheduled/conditional transfer refusals (`agent-act.mjs` ~:116-120 model-flagged + ~:186-200 regex backstop); strings only, no logic touched. Verified live.

### Cross-chain bridge — the capstone (agent bridges USDC to 8 networks)
- **Disproved the earlier "blocked" recon.** Raw CCTP direct-mint needs a destination-chain signer (agent's Arc SCA can't). Circle App Kit single-sign forwarding removes that — sign once on Arc, Circle's Orbit relayer mints on destination. But App Kit `kit.bridge()` is incompatible with dev-controlled SCA async submission (1098 race).
- **Fix = direct-contract path**: `createContractExecutionTransaction` + `waitForTx` calling `increaseAllowance` then `bridgeWithPreapprovalAndHook` on `0xC5567a5E3370d4DBfB0540025078e283e36A363d` with cctp-forward `hookData` (same plumbing as agent-send; byte-identical to App Kit's call; selector `0x513e1175`; `maxFee` from Circle IRIS API; no `KIT_KEY` needed — only swap needs that). Spike (`scripts/bridge-direct.mjs`) proved a 15-USDC agent-wallet bridge Arc→Sepolia end-to-end.
- **Shipped as agent action** (`edc119f`): `_bridge.mjs` executor + `agent-bridge.mjs`/`agent-bridge-status.mjs`, folded into the one `executeAction`. NL "bridge X to Ethereum" → propose (live fee + net) → confirm → burn on Arc → async destination mint. Guardrails: fee-floor refusal (live IRIS fee, volatile ~1.5–14 USDC), `AGENT_BRIDGE_CAP_USDC=25`, day-ceiling (`PERIOD_CEILING_USDC=60` in prod). Verified live: 20-USDC settled; 1-USDC refused (fee floor); 30-USDC blocked (cap).
- **Bridge-in-multi-step fix** (`24a4185`) — plan executor didn't know `bridge_usdc` step type. Fixed with Option A (fire-and-continue; bridge shows inline burn→mint status; plan continues; per-step caps/balance still checked). Verified live: 3-step plan (bridge 2→Base, swap 1 EURC→USDC, send 3) ran end-to-end.

### Architecture confirmed by code trace
Two pipelines — free-form action agent (`agent-act` → `executeAction` in `_actions.mjs`, the single guarded chokepoint where money moves re-check caps) and the research/escrow job tree — sharing `_auth`, `_agent-wallets`, `_budget`, `_circle`, `_arc`. Both bridge entry points converge on `executeAction`. The "one secure path" claim is backed by the trace.

### ⚠️ THREE "KNOW BEFORE YOU TOUCH" GOTCHAS (from code trace — read before the relevant cleanup)
1. **Prediction cleanup is a TRAP.** `_predict.mjs` exports `publicClient()` — the shared viem RPC client that agent-send, `_bridge`, AND the job workers import. So `_predict.mjs` is NOT deletable as-is; naive deletion breaks the money paths. Correct order: (a) move `publicClient()` out into a neutral shared module (e.g. `_circle.mjs` or new `_rpc.mjs`), repoint send/bridge/jobs, verify they still work; (b) THEN remove the genuinely-dead surfaces `predict-markets.mjs` + `PredictPanel.tsx` + `_predict.mjs`.
2. **`_budget.mjs` has LYING comments** — headers claim the cap system is "NOT WIRED," but it demonstrably IS wired. Misleading in money code (audit hazard). One-line fix whenever.
3. **`maxSpendUsdc()` is dead for its own paths** — it was hardened to replace inline `process.env.AGENT_MAX_SPEND_USDC` reads, but swap/pay branches still do the raw inline read. Hygiene, NOT a hole (pay is already the most-capped path: ~1 USDC inline cap + day-ceiling). Worth wiring for (a) not leaving a hardened parser dead, (b) misconfiguration defense. Needs its own scoping first — "make them identical" ≠ "make them safer."

### State
HEAD `ae05381` (adds this PROGRESS.md; last code change `e58bd9e`), clean, pushed, no open bugs.

**Parked backlog:** prediction dead-code cleanup (SEE GOTCHA #1 — move the RPC client first), `_budget.mjs` comment fix, `maxSpendUsdc()` wiring (needs scoping), recovery (2b/2c — Circle mechanism confirmed, highest-stakes), user-configurable/tiered caps, app+landing redesigns.

**Strategic (high-leverage now):** real users, Arc Builders Fund (strong story — cross-chain + Arc-roadmap fit), testnet→mainnet.
