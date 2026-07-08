
---

## 2026-07-08 — Contact block in sidebar footer (copy-only)

Contact block in sidebar footer: `tikpema274@gmail.com` mailto + `@tikpemaGB` →
x.com/tikpemaGB, low-key (muted/amber, stacked) under Feedback. `src/App.tsx` only;
copy+links, no backend/logic. Deployed to prod (hash `index-TWRm4hxm.js`), block
confirmed in the live bundle.

---

## 2026-07-08 — Crypto-analysis capability (CUT 1) SHIPPED + PROVEN on prod

**What:** the research agent can now fetch crypto facts mid-research and cite them —
**on-chain** (via the existing paid QuickNode x402 path) and **market** (via free
CoinGecko). A classifier routes each question to `onchain` / `market` / `none`.

**Design (all in `_research.mjs` + new `_cryptodata.mjs`):**
- **Classifier** — `decidePurchase` returns `{kind:"onchain"|"market"|"none", method,
  params, justification}` (+ back-compat `buy = kind!=="none"` so `_autonomy-test.mjs`
  and the legacy `forceDecision` seam still work). Priority rule IN the prompt: prefer
  the paid on-chain path where a listed method can serve; use free CoinGecko ONLY for
  price/market-cap/volume RPC can't give; else `none`.
- **Router** — `maybeBuyData`: `market` → free `fetchMarketData` (NO challenge/gate/
  spend); `onchain` → `buildRpcBody` → the EXISTING x402 pay path UNCHANGED (challenge
  → ceiling → gate → `payX402` → `recordSpend`; only the request BODY varies and the
  fact PRODUCTION swaps to the decoder). Legacy `{buy:true}` (no kind) → static-env body.
- **Decoders** (`_cryptodata.mjs`, pure): `eth_blockNumber` hex→int, `eth_gasPrice`
  hex wei→gwei, `eth_getBalance` hex wei→human USDC. `hexToBigInt` is the choke point —
  any non-hex/missing result is DROPPED (returns []); a raw `0x…` can NEVER become a
  claim. `buildRpcBody` validates the method/params and refuses unsupported methods.
- **Market** — CoinGecko keyless public GET `/simple/price` (price/cap/vol); ids
  restricted to an ALLOWLIST (bitcoin, ethereum, usd-coin, tether, solana, binancecoin,
  ripple, cardano, dogecoin, avalanche-2, polygon-ecosystem-token); off-list → dropped.
- **Merge unchanged** — both branches return `{claim,source}[]`, folded into the
  grounding block at `_research.mjs:~305`. Graceful degradation everywhere: any failure
  → `[]` → Exa-only, never crash, never emit garbage.

**⚠️ ARC GOTCHA (recorded — cost a wrong-decimals near-miss):** `eth_getBalance` on Arc
returns an **18-DECIMAL NATIVE** value, NOT 6 — even though **USDC the ERC-20**
(`0x3600…0000`) is 6-dp. Both encode the SAME USDC value at different scales:
`eth_getBalance ÷1e18 == USDC balanceOf ÷1e6`. Proven live: `0xc54d…e621` = **43.75
USDC at ÷1e18** (matches `balanceOf ÷1e6` = the Arcscan balance; also `0x6db3…b380` =
0.09==0.09). Decode native with **18**; `÷1e6` would print a value 1e12× too large — a
FALSE number. The `DECIMALS_VERIFIED` gate CAUGHT the wrong 6-dp assumption at build
time (balance decoder stayed inert AND `buildRpcBody` refused to PAY for the read until
a live cross-check matched), then was flipped to `true` only after the match. Don't
trust a stated decimals value — cross-check native balance vs USDC `balanceOf`.

**Verified on PROD (user-run, passkey wallet — draft can't passkey-login, domain-bound):**
- Market: BTC price via CoinGecko, decoded + cited (free, no spend).
- On-chain: Arc block **50,762,442** via the QuickNode paid path — decoded from hex, x402
  settled (sub-cent, through the proven ceiling + budget gate).
- Classifier discipline: a carbon-capture question → Exa-only (no crypto over-trigger).

**Scope / deferred:** cut 1 = balance + gas + block + CoinGecko market. **Deferred:**
contract reads (`eth_call` / ABI decode), token-balance-by-contract, historical charts.
**Known cosmetic TODO:** the research price-preview card copy is stale for non-price
questions (says "single price source" for all) — cosmetic, not wired to the new router.

**Money path UNCHANGED:** no edits to `_x402.mjs`, the per-buy ceiling, or the budget
gate. On-chain reads reuse the proven pay path with a varying body; CoinGecko never
touches it. Files: `_cryptodata.mjs` (new), `_research.mjs` (classifier+router). tsc +
build clean; decoders + live CoinGecko smoke-tested; deployed to prod (functions-only,
frontend hash unchanged `index-qEtshKBL.js`).

---

## 2026-07-08 — RECON (read-only, no build): agent pays BlockRun via UB-funded Base wallet

**Goal explored:** let the research agent pay **BlockRun** (a pay-per-call x402 data/LLM
gateway that settles USDC on **Base mainnet**) for new capabilities, by (a) funding a
Base wallet from our Arc USDC via Circle Unified Balance + Forwarding Service, and (b)
letting BlockRun's own SDK handle the x402 payment. Two external research streams
(BlockRun SDK source; Circle UB docs) + codebase + Arc-mainnet status.

### Verdict: both linchpins GREEN mechanically, but the seam has a FATAL premise gap
"Fund a Base wallet **from our Arc USDC**" is **NOT achievable today** — **Arc has no
mainnet yet** (public testnet only as of 2026-07; mainnet beta scheduled 2026, and Arc
is not yet a Gateway mainnet source). BlockRun is **Base mainnet**. Testnet USDC can't
become mainnet USDC, and Gateway/UB is network-segregated (testnet→testnet only). So the
funding source must be **real mainnet USDC on an existing Gateway chain (Base/ETH/…),
NOT our Arc testnet balance.** This is a deliberate **mainnet, real-money, multi-session**
project — Tikpema's first mainnet crossing (the "deferred crossing" prior entries flagged).

### 1. BlockRun SDK wallet model (linchpin — RESOLVED: we provide the key)
- Accepts a key WE control: `new LLMClient({ privateKey })` or env
  `BASE_CHAIN_WALLET_KEY`/`BLOCKRUN_WALLET_KEY`, resolved FIRST before any generation
  (`blockrun-llm-ts/src/wallet.ts:102`; `src/types.ts` `LLMClientOptions = {privateKey?,
  apiUrl?, timeout?}` — no signer/account/apiKey param).
- Fallback only (no key): mints a fresh EOA, writes the raw key to `~/.blockrun/.session`
  (`wallet.ts:41–58`), exposes it via `getWalletAddress()` (`:133`).
- Signs with a **raw EOA private key** (viem `privateKeyToAccount`), NOT a Circle SCA/
  delegate. Settles **Base mainnet** (`src/x402.ts`: `BASE_CHAIN_ID=8453`,
  `USDC_BASE=0x8335…2913`), EIP-712 `TransferWithAuthorization`, **auto-pays on 402**
  (`src/client.ts handlePaymentAndRetry`) — no explicit pay(). So the SDK handles the
  x402 payment itself; we don't need our own x402 buyer. BlockRun is **mainnet-only** (no
  testnet endpoint) → the first real test IS a mainnet money test; no testnet dry-run.

### 2. Unified Balance fit (RESOLVED: it's the documented SCA path, already in use)
- We ALREADY call `kit.unifiedBalance.spend()` with the delegate model, proven on-chain:
  `_pay.mjs:47` (params `:29–44` — delegate EOA signs, SCA `sourceAccount` holds balance,
  `to.chain="Arc_Testnet"` today).
- Circle docs confirm this is REQUIRED for a Circle SCA ("*SCAs cannot sign their own
  Unified Balance spends… use the delegate workflow*"; "*SCA deposits require
  `allowanceStrategy:"approve"`*") — exactly our stack (`@circle-fin/app-kit@1.8.1` +
  `unified-balance-kit@1.2.1` + Circle Wallets adapter, installed).
- Fund an address we don't control: `spend({to:{chain:"Base…", recipientAddress,
  useForwarder:true}})` (no dest adapter) — documented server-side/custodial Forwarding
  mode. **No kit key** (just Circle API key + entity secret, which we have).
- Same Gateway burn→attest→mint primitive as our existing `_bridge.mjs` CCTP forward,
  which already mints to an arbitrary Base recipient (`_bridge.mjs:140,158`). Two working
  TESTNET mechanisms for the Arc→Base hop already exist.

### 3. The seam (mechanically yes; blocked by network reality)
Plumbing closes: Arc USDC → `unifiedBalance.spend`/bridge (`useForwarder`+
`recipientAddress`) → BlockRun EOA's Base address → BlockRun SDK signs from that key →
auto-pays x402. Two mismatches: **(fatal) network** — Arc testnet vs Base mainnet, no
path, Arc not a mainnet Gateway source yet → "from our Arc USDC" cannot hold; **(minor)
signer shape** — BlockRun wants a raw EOA; our wallet is a Circle SCA, so the BlockRun
payer is a SEPARATE raw mainnet EOA we generate + hold server-side (new hot-key mgmt).

### 4. Scope / risk
- BlockRun SDK integration: **SMALL** (`new LLMClient({privateKey})` + call; auto-pays).
- UB/funding call: **SMALL–MEDIUM** (delta from `_pay.mjs` is `to.chain:Base` +
  `useForwarder` + `addDelegate` on source; mainnet config net-new).
- Base wallet mgmt: **MEDIUM** (raw mainnet EOA private key, real hot wallet, fund+monitor).
- The mainnet crossing: **BIG** — real USDC, mainnet hot-wallet key, mainnet Gateway/UB
  config, and the funding source can't be Arc (premise gap); possible compliance screening.
- **Biggest risk:** testnet→mainnet real-money crossing + no Arc mainnet source + mainnet
  hot key + no testnet dry-run (BlockRun mainnet-only). **Multi-session, gated on a
  mainnet go/no-go — NOT a 1-session build.**

### The one decision before any scoping
Where the MAINNET USDC comes from (can't be Arc): (i) hold mainnet USDC on Base directly
and fund the EOA locally — simplest, no cross-chain; (ii) hold it on another mainnet
Gateway chain and spend/bridge to Base; (iii) wait for Arc mainnet + Gateway to make the
original "from Arc USDC" story real.

Sources: BlockRun `github.com/BlockRunAI/blockrun-llm-ts` (wallet.ts/types.ts/x402.ts/
client.ts); Circle App Kit UB docs (`docs.arc.io/app-kit/unified-balance`,
`.../use-forwarding-service`); Arc testnet-only + Gateway mainnet
(`circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet`,
`arc.io/blog/circle-launches-arc-public-testnet`, `circle.com/gateway`). Code:
`_pay.mjs:29–47`, `_bridge.mjs:140,158`. No code changed — recon only.

---

## 2026-07-08 — AI Agent guided actions COMPLETE: Bridge panel SHIPPED (all 3 cards live)

**Brick:** activated the last "Quick actions" card on the AI Agent page — Bridge (`Soon`
→ active amber `Bridge →`, routes to a new **`BridgePanel.tsx`**). Send · Swap · Bridge
are now all live guided panels. Also removed the now-dead `soonTag`/`CSSProperties` in
`MyAgentPanel.tsx` (Bridge was its last consumer). Multi-task box untouched.

**Call path (the guaranteed cap-enforcing door):** the panel POSTs to
**`/api/agent-bridge`** (new `bridgeFromAgent` in `useWallet.ts`, raw fetch like
SendPanel→`/api/agent-send`). It does NOT call `executeAction`/`agent-execute-plan`/the
bridge kit directly. `agent-bridge.mjs:46` → `executeAction(step,{walletAddress,session})`
→ the **per-bridge cap is compared at `_actions.mjs:91`** (`if (Number(step.amountUsdc) >
bcap)`, `bcap = bridgeCapUsdc()`), **before** the Arc burn (`agentBridge` at
`_actions.mjs:190`). Same path also enforces the live fee-floor (`:184–189`) and
day-ceiling (`:114`). Unlike swap, the bridge cap lives INSIDE `executeAction`, so the
dedicated endpoint is cap-safe — no one-step-plan indirection needed.

**Cap (deployed-confirmed):** `AGENT_BRIDGE_CAP_USDC=25` (via `netlify env:get …
--context production` — authoritative, not the code default). Operator is `>`, so 25
passes at the limit; over-25 blocks. A cap/fee-floor block returns HTTP 200
`{executed:false, blocked}`; `bridgeFromAgent` surfaces it as an error (not a silent
no-op).

**UX = Option A (fire-and-inform):** the Arc burn is synchronous; the destination mint
is async (Circle relayer). On submit the panel shows the burn tx + net arrival and lets
the user leave — the bridge completes server-side. One optional "Check status" button
does a SINGLE `agent-bridge-status` poll (`submitted → pending → minted|failed`), no
blocking loop.

**Fee shown POST-submit (pre-submit preview deferred):** the live IRIS fee/net is
surfaced from the `agent-bridge` response on the confirmation. A *pre-submit* fee preview
isn't available via existing surfaces — it would need a small fee-quote endpoint exposing
`bridgeFee` (`_bridge.mjs:109`), out of this UI-only brick's scope. Deferred; degrades
gracefully (bridge never blocked on a fee estimate).

**Arrival copy — aligned honestly:** originally "~10–20 min"; the prod test showed Base
Sepolia arrives faster, so the copy now reads "in a few minutes (up to ~20 for some
chains)" — honest across fast L2s and slower L1.

**Verified on PROD (user-run, passkey wallet — the draft can't passkey-login, domain-
bound):** (1) over-cap **26 USDC → rejected** "exceeds per-bridge limit of 25 USDC", no
funds moved; (2) happy path **5 USDC → Base Sepolia**: burn on Arc, **ARRIVED on Base
(~4.80 USDC, BaseScan mint tx confirmed), ~0.20 fee**; (3) "Check status" reflected the
mint. All 3 tests pass. Prod build hash `index-jKg6nPNR.js`; endpoints healthy
(`/api/agent-bridge` 405, `/api/agent-bridge-status` 405, `/api/my-wallet` 401).

Files: `BridgePanel.tsx` (new), `useWallet.ts` (+`bridgeFromAgent`, +`checkBridgeStatus`),
`App.tsx` (+`case "bridge"`), `MyAgentPanel.tsx` (Bridge card active, dead `soonTag`
removed). `#/bridge` is nav-less (like `#/swap`). Backend untouched. Build + tsc clean.

---

## 2026-07-07 — AI Agent page guided actions: Swap button (Swap brick) SHIPPED

**Brick:** activated the Swap card on the AI Agent page (`MyAgentPanel.tsx`) from
"Soon" to an active amber `Swap →` (identical treatment to the Send card), routing to
a new **`SwapPanel.tsx`** — a real USDC↔EURC form matching `SendPanel` (gated on
`w.agentWallet`, token selector + amount, async-"submitted"-aware confirmation, tx
link). Bridge stays "Soon"; multi-task box untouched.

**Call path (Option B — the cap-enforcing route, chosen deliberately):** the panel
does NOT touch the swap engine (`_swap.mjs`/App Kit) or call `agentSwap`/`kit.swap`.
It builds a structured one-step plan `[{type:"swap_tokens", tokenIn, tokenOut,
amountIn}]` and POSTs it through the EXISTING **`/api/agent-execute-plan`** executor
(new `swapFromAgent` in `useWallet.ts`; reuses `agentClient.executePlan` shape). No
LLM parse, no confirm round-trip — the form submit IS the confirmation.

**⚠️ WHY the plan-route, not a direct `executeAction` call (money-safety — do NOT
"simplify" this):** `executeAction` does NOT enforce a per-transaction cap on swaps.
Its per-tx caps are type-specific — send cap is `transfer_usdc`-only
(`_actions.mjs:79`), bridge cap is `bridge_usdc`-only (`:89`); the swap branch
(`:127`) goes straight to `agentSwap` with only the day-ceiling (`:114`) above it.
The per-action swap cap lives in the WRAPPERS. So the swap's caps are enforced at
**`agent-execute-plan.mjs:104`** (per-action cap, `capForA` → `sendCapUsdc` by USD
value) and **`:114`** (cumulative day-ceiling), BEFORE it calls `executeAction` at
**`:128`**. **Rewiring swap to call `executeAction` directly would BYPASS the per-tx
cap** (only the day-ceiling would bind). The plan-route is the cap-enforcing path —
leave it.

**CORRECTION (2026-07-07) — the real enforced cap is 10 USDC, not 5/1.** The two
lines below originally read "caps a swap at `sendCapUsdc` (5 USDC) … looser than the
text-box swap's `AGENT_MAX_SPEND_USDC` (1)". **That was a misstatement**: 5 and 1 are
only the code *defaults* (`_arc.mjs:72` / `agent-act.mjs:271`); the **deployed prod
env** sets both `AGENT_SEND_CAP_USDC=10` and `AGENT_MAX_SPEND_USDC=10` (confirmed via
`netlify env:get … --context production`, which manual `netlify deploy` also uses — so
drafts run the same 10). This doc-vs-env gap is what made a working 10-cap look like a
bypassed 5-cap when a 10 USDC swap passed. **Verified, no code bug:** the per-action
check is `if (vA > capForA(step))` — `>`, not `>=` (`agent-execute-plan.mjs:104`), and
the block message says "**exceeds** … limit of 10 USDC". So a swap of **exactly 10
passes by design** (10 is at the limit, not over); anything over 10 blocks (observed:
10 USDC swap passed; 12 EURC ≈ 13.68 USD blocked).

**Enforced cap (corrected):** the plan-route caps a swap at `sendCapUsdc` = **10 USDC**
(deployed) + the day-ceiling — the SAME caps a swap-as-a-plan-step gets. In prod the
text-box single swap's `AGENT_MAX_SPEND_USDC` is **also 10**, so the two paths enforce
the *same* 10; the earlier "looser 5-vs-1" framing does not hold for the running env.

**Deferred:** no pre-swap estimate preview yet (needs a `_swap.mjs` standalone
estimate export + an `agent-act` estimate branch — left for later). `#/swap` is a
**nav-less** route (like `#/nanopay`), reached via the AI Agent Swap card; no sidebar
item highlights (matches the "nav = working tools only" design).

**Verified end-to-end on a draft deploy** (`netlify deploy`, no `--prod`): happy-path
swap on-chain + over-cap rejection both confirmed. Then shipped to prod via Netlify
CLI (backgrounded), verified real: prod `index.html` references the new build hash
`index-fn9fa5h3.js`; `/api/agent-execute-plan` 405 (POST-only), `/api/my-wallet` 401
(auth-gated).

Files: `SwapPanel.tsx` (new), `useWallet.ts` (+`swapFromAgent`), `App.tsx`
(+`case "swap"`), `MyAgentPanel.tsx` (Swap card active). Build + tsc clean.

---

## 2026-07-07 — AI Agent page guided actions: Send button (Send brick) SHIPPED

**Brick:** the AI Agent page (`MyAgentPanel.tsx`) grew a "Quick actions" row of guided
shortcuts above the free-text box. **Send** routes to the existing Send view (sets
`window.location.hash = "/send"`; the sidebar highlights Send) — it reuses the same
`SendPanel`, not a duplicate money path. **Swap** and **Bridge** are present but
`disabled` with a muted "Soon" tag (placeholders until their own bricks; both remain
reachable today via natural-language tasks in the box below). The free-text multi-task
box was repositioned below the shortcuts as the general multi-step entry point, with a
tightened intro lede. Frontend-only — no function, `_actions.mjs`, cap, auth, or
`/api/*` change; `agent-send` untouched.

**Verified end-to-end on a draft deploy** (`netlify deploy`, no `--prod`, throwaway URL
with functions — didn't touch prod): navigation clean, one real **0.1 USDC send landed
on-chain**. Then shipped to prod via Netlify CLI (backgrounded), verified real:
prod `index.html` references the new build hash `index-CRUTDDnV.js` + control endpoints
healthy (`/api/my-wallet` 401 auth-gated, `/api/agent-send` 405 POST-only).

Files: `src/components/MyAgentPanel.tsx` (only). Build + tsc clean. Phase 1
(dashboard/wallet clarity) was committed separately in `9ca7a23`/`7cfd568`.

---

## 2026-07-07 — Phase 1 dashboard/wallet clarity COMMITTED (was live-but-uncommitted)

**Git/prod sync fix.** Phase 1 (dashboard + wallet clarity) had shipped to prod but
was NEVER committed — `git log` had no Phase 1 commit, so origin/main and prod were
out of sync. Closed that gap: committed the Phase 1 files only (`9ca7a23`), leaving
the in-progress Send brick (`MyAgentPanel.tsx`) uncommitted in the working tree.

Phase 1 surface (all live on prod already): masked wallet address with click-to-expand
+ copy (new `AddressDisplay.tsx`), USDC + EURC balances, wallet auto-refresh, three
logged-out options (incl. `#/wallet?new` create-intent), safe disconnect, and the old
login-wallet line removed. Files: `App.tsx` (parseHash strips `?intent` query so
deep-links resolve), `Dashboard.tsx`, `ConnectPasskey.tsx`, `useWallet.ts`, `_arc.mjs`,
`my-wallet.mjs`, `AddressDisplay.tsx` (new). Build + tsc clean.

Send brick (QUICK ACTIONS row: Send active, Swap/Bridge "Soon", repositioned
multi-task box) stays uncommitted for continuation this session.

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

---

## Session update — sidebar console redesign (frontend only)

*Committed + pushed to `tikpema274/tikpema`, verified live on production.*

Reorganized the app from a single stacked-panel page (App.tsx rendered ConnectPasskey, ResearchPanel, MyAgentPanel, FeedbackPanel linearly, no router) into a multi-page **sidebar console**. Frontend only — no Netlify function, `_actions.mjs`, cap, auth, or `/api/*` money-path change; no new endpoints or client methods; no Swap/Bridge forms. PredictPanel/predict-markets left untouched (still dead — separate cleanup).

### What shipped (`982b60e`)
- **Routing** — lightweight **hash router**, no new dependency. Active view derives from `window.location.hash` (`parseHash()` in App.tsx) + a `hashchange` listener; nav sets `#/<route>`, so views deep-link (`#/send`, `#/research`) and the back button works. The single `const wallet = useWallet()` stays at the shell and is passed to every page as before.
- **Sidebar shell** — left nav, 5 items in order: Dashboard · Wallet · AI Agent · Research · Send. Feedback in a muted low-priority foot slot. No Swap/Bridge/Lend/Stake/Prediction items. Swap and Bridge stay reachable **inside AI Agent via natural-language tasks**, unchanged. Same visual language (warm-ink surfaces, amber-gold accent, Space Mono) — layout, not a recolor.
- **SendPanel.tsx (new)** — Send form lifted out of ConnectPasskey (coupling check confirmed it shared nothing but the `w` prop). `send()` logic and the `/api/agent-send` call are byte-identical; gated on `w.agentWallet` exactly as before, so Send never appears before a wallet exists.
- **Dashboard.tsx (new)** — overview composed only from existing per-user reads (`w.agentWallet` address/balance, `w.busy`, `w.refreshAgentWallet`) + quick-links to the action pages. Deliberately does NOT call `/api/agent-status` — that endpoint reads the SHARED env demo wallet (`process.env.AGENT_WALLET_ADDRESS`), not the user's, so surfacing it here would misrepresent the balance.
- **ConnectPasskey.tsx** — Send block + its state/helpers removed; connect flow (`username`, `showCreate`, `hasPasskey`, `handlePasskey`, `w.connect*`/`startOver`) untouched. It is now the **Wallet** page (connect + balance + funding + status).
- **styles.css** — added `.console`/`.sidebar`/`.nav`/`.console-main`/`.quick` using existing tokens; old `.app`/`.hero` styles left in place (harmless, unused).

Files: `src/App.tsx`, `src/components/ConnectPasskey.tsx` (modified); `src/components/SendPanel.tsx`, `src/components/Dashboard.tsx` (new); `src/styles.css`. Build + typecheck clean; prod serves the new bundle (verified via index.html hash + live click-through).

### Note for a future palette pass
The redesign brief described the palette as "deep navy, cyan, emerald," but the actual design is warm-ink + amber-gold. Kept the real tokens (instruction was "layout, not a recolor"). A navy/cyan reskin, if ever wanted, is a separate recolor pass.

### State
HEAD `982b60e`, clean, pushed, no open bugs. (Backlog + strategic items unchanged from the prior session entry above.)

---

## Feasibility survey — Nanopayments / user-escrow (read-only, no code changes)

*Two read-only code surveys evaluating whether a user-facing "Nanopayments" payment feature is buildable on existing surfaces. No files changed. Findings only.*

### A. x402 surfaces — pure pay-per-request, NO payment channel
- **Sellers:** `x402-quote.mjs` (Gateway-batched, $0.001, via `BatchFacilitatorClient`), `x402-vanilla-seller.mjs` (vanilla EIP-3009, $0.01, settles `receiveWithAuthorization` on-chain). **Buyers:** `_x402.mjs` (`payX402`, Gateway-batched), `_x402-vanilla.mjs` (`payX402Vanilla`, token-domain), `x402-pay.mjs` (thin HTTP wrapper).
- **Payment model:** every path is one signed EIP-3009 authorization = one HTTP call = one resource. **No channel / deposit-escrow / streaming / return-on-close anywhere.** The Gateway-batched path authorizes against an ALREADY-DEPOSITED balance (funded via `depositFor`), but still one-shot-per-request — a held pooled balance, not a per-counterparty escrow.
- **Chain:** Arc Testnet only (`eip155:5042002`, USDC `0x3600…0000`). No Base/Solana anywhere (grep-confirmed). Consistent with the Exa note: the buyer only ever pays this repo's OWN Arc seller (`DEFAULT_SELLER_URL` → app.tikpema.xyz/x402-quote); it sidesteps Exa's Base/Solana-only x402 entirely.
- **Live vs spike:** `_x402.mjs`/`payX402` = LIVE (called mid-research at `_research.mjs:120`, budget-gated). `x402-quote.mjs` = live seller counterparty. `x402-pay.mjs`, `x402-vanilla-seller.mjs`, `_x402-vanilla.mjs` = defined-but-unused spikes. Note: `executeAction`'s `pay_for_service` uses `agentPay` (plain transfer), NOT x402.
- **Money-safety:** x402 buys have their OWN controls (in-buyer `AGENT_MAX_SPEND_USDC` cap + `_budget.mjs` `canSpend`/`recordSpend` per-job spine), authed as the dev-controlled `DELEGATE_ADDRESS` EOA — NOT the user session/`executeAction` path.

### B. ERC-8183 escrow pipeline — separable from research, per-user auth already present
- **Contract:** `AGENTIC_COMMERCE 0x0747EEf0…4583`. Lifecycle: `createJob → setBudget → approve → fund → submit → complete/reject`.
- **Separable from research?** YES — cleanly layered. On-chain calls are task-agnostic (`job-run-background.mjs:68-82`, `job-submit-background.mjs:292-299`, `job-evaluate-background.mjs:262-268`); the on-chain layer only sees a generic keccak256 `deliverableHash`, never research content. Research logic is confined to `_research.mjs` + brief/judge prompts. A job's only task-descriptive field is a free-form `string description` (now `question`) — an arbitrary task fits WITHOUT changing the contract interaction.
- **Evaluator:** hardwired, not pluggable. `job-evaluate-background.mjs:252-268` always runs the module-local Haiku/Sonnet `evaluate()` to pick `complete` vs `reject`. Swapping in human sign-off = editing this handler (settlement calls stay generic).
- **Auth (the key finding):** `fund()` ALREADY moves the authenticated user's OWN per-user SCA wallet under their session. `job-run.mjs:33-52` does `requireSession` → `ensureOwnerWallet` → threads the resolved wallet to `job-run-background.mjs` via `internalToken()`. Per-user wallet resolution already applies to job funding. (Legacy `job-set-budget.mjs:29` still uses the shared env wallet, but it's NOT part of the live `job-run` pipeline.)
- **Two-party gap:** today `createJob` passes `[walletAddress, walletAddress, …]` → client == provider == evaluator == the ONE user wallet ("self-agent model"). So "release" and "refund" both land back in the depositor's own wallet — money never changes hands. A real user-escrows-for-a-task feature needs DISTINCT provider + evaluator addresses — a change to the `createJob` ARGS (`job-run-background.mjs:71`), not the ABI or settlement calls.
- **⚠️ Caps: the escrow `fund()` is UNCAPPED.** `job-run.mjs` validates only `budgetUsdc > 0` + wallet balance; no `canSpend`/`sendCapUsdc`/day-ceiling on the create→fund path. `_budget.mjs` caps cover ONLY autonomous mid-research x402 buys, not the user's escrow deposit. `job-quote.mjs:85` clamps the *suggested* budget to [0.20, 0.60] but `job-run.mjs` doesn't re-validate — deposit amount is uncapped.

### Verdict (what a user-escrow feature would reuse / need)
- **Reuse as-is:** the entire on-chain escrow spine (create/fund/submit/complete/reject, generic Circle `exec`, `waitForTx`/`TxPendingError`, `getJob` idempotency, keccak256 determinism, Blobs status stores, status/deliverable polling) AND the auth spine (`requireSession` → `ensureOwnerWallet` per-user SCA → balance gate → session→internalToken hand-off).
- **Generalize:** factor research out of the two fused handlers (task-production in job-submit, auto-judge in job-evaluate) behind a task/evaluator interface; `description` string; research-only `job-quote.mjs` pricing.
- **Net-new:** distinct provider/evaluator addresses in `createJob` (genuine two-party escrow vs self-agent); a real deliverable-acceptance path (human sign-off / non-research verifier); a deposit cap on the fund path (none today).
- **Highest money-risk (careful build + live test):** `fund()` (`job-run-background.mjs:82`, uncapped user-USDC pull), the `reject()`/refund path (`job-evaluate-background.mjs:180-197`), and the `complete`-vs-`reject` branch (`:262-268`) — the three direct user-money-movement surfaces.

*No code changed. This is a scoping/feasibility record only.*

---

## Session update — hard cap on the escrow fund path (money-safety fix)

*Closes the ⚠️ finding from the feasibility survey directly above: the escrow `fund()` was UNCAPPED. Committed `537d747` (backup remote `tikpema274/tikpema`), deployed to prod via the Netlify CLI, verified live on `app.tikpema.xyz`.*

### The problem (from the survey)
`job-run.mjs` accepted any client-supplied `budgetUsdc > 0`, checked ONLY against wallet balance — the one uncapped money path in the app. `_budget.mjs` caps cover only autonomous mid-research x402 buys, not the user's escrow deposit; `job-quote.mjs:85` clamps the *suggested* budget to [0.20, 0.60] but is a suggestion the server never re-validated.

### What shipped (`537d747`)
- **`netlify/functions/job-run.mjs` only.** Added a per-transaction hard cap on the deposit: after the existing `budgetUsdc > 0` validation and before wallet resolution / the balance gate, `job-run.mjs:48-53`:
  ```js
  const cap = sendCapUsdc();
  if (budget > cap) {
    return json(400, { error: `Deposit ${budget} exceeds per-transaction limit of ${cap} USDC` });
  }
  ```
  Plus the import (`job-run.mjs:14`).
- **Reuses `sendCapUsdc()`** from `_arc.mjs` — the SAME per-tx cap the send / `executeAction` paths enforce (default 5 USDC on testnet). No new env var, no new number.
- **Reject, never clamp** — over-cap returns `400` naming the limit + the requested amount, mirroring the existing cap wording (`_actions.mjs:82`, `agent-act.mjs:334`). Never funds a different amount than the user asked for. The reject returns before wallet resolution, so **no funds move**.
- **Server-side, post-`requireSession`** — enforced in the authenticated front door, so no client can bypass it. The `job-quote.mjs` clamp stays a suggestion; this is the real enforcement.
- **Per-tx bound only** — deliberately NOT wired into the `_budget.mjs` daily ceiling (`canSpendDay`). No lifecycle / evaluator / self-escrow-model changes. No changes to `_actions.mjs`, send, swap, or bridge.

### Deploy + live verification
- Deployed via `npm run build` + `netlify deploy --prod --dir=dist` (this project's real deploy path — CLI, not git auto-build; see the deploy memory). Live at `app.tikpema.xyz`, all 43 functions incl. `job-run` shipped.
- **Verified live on prod (user-run, authenticated):** over-cap `budgetUsdc: 5.01` → `400` `{"error":"Deposit 5.01 exceeds per-transaction limit of 5 USDC"}` (no funds moved); at-cap `budgetUsdc: 5` → `202` (gate cleared, job started). ✅

### State
HEAD `537d747`, clean. The one uncapped user-money path is now bounded. Note: this is the *deposit* per-tx cap only — the survey's other net-new items (distinct provider/evaluator addresses for genuine two-party escrow, a non-research deliverable-acceptance path, `reject()`/refund-path review) remain open and out of scope for this change.


## 2026-07-06 — x402 Gateway-batched buy PROVEN settling on Arc (Brick D resolved)

**Result: PASS.** The existing Gateway-batched x402 buyer (payX402 in _x402.mjs)
produced a real, settled payment on Arc Testnet. Closes the long-open "has x402
ever actually settled on Arc?" question.

Evidence (from a temporary read-only diagnostic, since deleted + confirmed 404 on prod):
- executed: true, settleReceipt.success: true
- Settlement id (Circle Gateway batch, not a 0x tx hash): e2ee4aa4-6af5-4d86-b5a7-551197443fcf
- Network: eip155:5042002 (Arc Testnet)
- Payer (DELEGATE_ADDRESS): 0x6db396c1a37024fd3bee1f3dbf3020aa3b2bb380
- Payer Gateway balance moved 4.996 -> 4.995 USDC — receipt and balance agree
- Price: 0.001 USDC; seller advertised GatewayWalletBatched / verifyingContract
  0x0077777d7EBA4688BDeF3E311b846F25870A19B9 (Gateway wallet) → confirms
  Gateway-batched path, NOT raw per-tx EIP-3009 (the vanilla twin)
- Seller returned real content — full request->402->pay->settle->deliver loop closed

Scope — what this did NOT prove (still open):
- Self-loop only: our own x402-quote was both seller and payee
  (payTo 0xc70112c7d5ebe38cd998679594a5d082c1860df6). External-seller NOT proven.
- Budget caps (30%/50%/period in _budget.mjs) NOT exercised — diagnostic bypassed
  maybeBuyData's gate by design. Caps still unverified in a live buy.
- Settlement id is a Gateway batch UUID; not yet traced to an on-chain batch tx on Arcscan.

Correction: _budget.mjs header comments claiming caps are "NOT WIRED" are false —
caps are wired; they just weren't in this test path.

Op note: minting an internal token for a PROD call requires
`netlify env:get SESSION_SECRET --context production` — the bare command returns
the dev secret and every token 401s.

Next brick: exercise the real maybeBuyData path so caps bind for the first time —
price a job so the buy would exceed allowance, confirm it's blocked (not clamped).
Then: external Arc seller; then audit cleanups (delete vanilla-x402 twin,
gate/remove unauth agent-init.mjs, retire shared-wallet ghosts).

## 2026-07-06 (pm) — Budget gate BLOCKS over-allowance data-buy (reject-not-clamp) PROVEN

**Result: PASS.** The data-buy budget gate rejects an over-allowance buy on the
real maybeBuyData path — it does NOT clamp — and no money moves.

How tested: temporary diag-caps-block endpoint (since deleted, prod 404 confirmed)
drove the real exported research() → private maybeBuyData with forceDecision:{buy:true},
injecting DATA_PURCHASE_USDC=0.05 into process.env for that invocation only. At
jobPrice 0.20: allowance 0.20 x 0.30 = 0.06; per-purchase cap 0.06 x 0.50 = 0.03.
Injected 0.05 > 0.03 → blocks at the per-purchase branch.

Evidence:
- canSpend returned allowed:false, reason "per-purchase cap: 0.05 > 0.03 USDC
  (0.5 of job allowance 0.06)" — per-purchase branch, not period ceiling
- realPath.purchasedFacts = 0 — buy skipped, not shrunk (reject, not clamp)
- Payer (0x6db3…b380) Gateway balance unchanged 4.995 → 4.995 — no money moved
- Job still returned a clean Exa-only brief — graceful degradation intact
- exa_branch_ran = true — precondition held, gate was actually exercised
- Function log confirmed the clean "[research] budget BLOCKED: per-purchase cap:
  0.05 > 0.03" path; NO "purchase loop error" line (swallowed-throw ruled out)
- Log line "purchase decision: BUY ($0.05)" (from dataPurchaseUsdc()) independently
  proves the injected 0.05 reached real production code — default 0.001 would have
  been under the cap and allowed

Note: the harness's injected_amount_reached_real_code assertion came back false and
auditEntriesWrittenThisRun was empty ONLY because they keyed off the persisted
recordBlocked audit entry, which didn't read back within the direct invocation — a
Netlify Blobs readback artifact of the throwaway diagnostic, NOT a gate failure.
The reason string + the BUY ($0.05) log line + unchanged balance close it fully.

**Scope — what this did NOT prove (still open, more important — Brick 2):**
- canSpend checks DATA_PURCHASE_USDC (env figure). The actual buy charges the
  SELLER'S advertised maxAmountRequired, which the gate never sees (payX402 reads
  it internally; maybeBuyData passes no amount). Both ~equal by coincidence today.
  A gate validating a different number than the one charged is a latent money-safety
  hole — it goes live the moment DATA_SELLER_URL points at an external seller with a
  different price. Fix options drafted: (guard) payX402 refuses to sign if
  maxAmountRequired > approved ceiling; (reorder, cleaner) fetch 402 first, gate the
  advertised amount, then sign+settle. Lean: guard now, reorder later.

**Op notes (both bit us this session):**
- When Claude Code runs the prod deploy it MUST background it — a foreground
  `netlify deploy` exceeds the 5-min tool timeout and gets SIGTERM'd mid-upload,
  leaving prod half-updated (endpoint 404s). Backgrounding removes the ceiling.
  (Deploying from your own terminal is unaffected.)
- Audit-log readback in a directly-invoked diagnostic doesn't reliably reflect
  Netlify Blobs writes within the same invocation. Future cap tests should assert on
  the canSpend reason string / function logs, not the persisted recordBlocked entry.

## 2026-07-06 (pm) — payX402 approved-amount guard added + proven (gate/wire mismatch CONTAINED)

**What:** Added a fail-closed approved-amount guard to payX402 (_x402.mjs) closing
the gate/wire gap where canSpend validated DATA_PURCHASE_USDC but payX402 charged
the seller's advertised maxAmountRequired unchecked. payX402 now takes approvedUsdc
+ requireApproved; maybeBuyData passes the canSpend-approved amount with
requireApproved:true. Atomic-integer compare (micro-USDC), refusal fires in step
"guard" before any signing/settlement, returns the existing {executed:false,blocked}
shape so maybeBuyData degrades to clean Exa-only.

**Posture:** research path is FAIL-CLOSED — a data buy with a missing/invalid
ceiling is refused, not waved to the AGENT_MAX_SPEND backstop. x402-pay.mjs (test
harness) is intentionally EXEMPT (does not set requireApproved) and runs on the
AGENT_MAX_SPEND_USDC backstop only; if it ever becomes a real buy path, pass it an
explicit approvedUsdc.

**Proven end-to-end (temporary diag-guard, since retired):**
- State 1 ENFORCE: approved 0.0005 < advertised 0.001 → blocked "advertised price
  exceeds budget-approved", never reached sign, balance unchanged
- State 2 FAIL-CLOSED: approved undefined and 0 → blocked "fail-closed: requires a
  budget-approved ceiling", never reached sign, balance unchanged
- State 3 HAPPY: approved 0.01 > advertised 0.001 → executed:true, settleReceipt
  (batch afb1f2bc-…), balance 4.995 → 4.994 (−0.001). Guard does not break settlement.

**Still open — this CONTAINS, does not fully close, the mismatch:** the guard binds
the SIGNED amount to the approved ceiling (you can't sign an over-ceiling
authorization). It does not make canSpend gate the advertised price as canonical
input — that's the "reorder" (fetch 402 → gate advertised amount → sign+settle),
still the cleaner eventual fix. Guard is the belt; reorder is the redesign.

## 2026-07-06 (pm) — payX402 reorder: canSpend now gates the SELLER'S advertised price (gate/wire mismatch CLOSED)

**What:** Reordered the data-buy path so the budget gate reads the seller's
advertised maxAmountRequired as canonical input, instead of gating DATA_PURCHASE_USDC
and binding it afterward. Extracted fetchX402Requirements() from payX402 (exported);
payX402 gained an optional `challenge` param (challenge ?? fetch — single fetch,
threaded). maybeBuyData now: fetch 402 → derive advertisedUsdc → canSpend(advertised)
→ payX402(challenge threaded, approvedUsdc=advertised). Gated price == signed price
by construction. Guard KEPT as defense-in-depth (TOCTOU insurance + sole bound for
x402-pay.mjs, which passes no challenge and self-fetches unchanged).

**This CLOSES the gate/wire mismatch** that the earlier guard only contained: the
gate now validates the exact amount that gets charged, not a coincidentally-equal
env figure. External-seller-ready — single threaded fetch means no gate-vs-sign
divergence even against a nonce-bearing seller.

**Proven end-to-end on the LIVE path (temporary diag-reorder, since retired):**
- State 1 GATE BLOCKS ON ADVERTISED: real maybeBuyData at jobPrice 0.005 blocked on
  the FETCHED advertised 0.001 (log: "BUY (advertised $0.001)" then "budget BLOCKED:
  per-purchase cap: 0.001 > 0.00075"). Control: same fetched 0.001 allowed at
  jobPrice 0.20 — proves the gate reads the fetched number, not a stale env figure.
- State 2 SINGLE-FETCH HAPPY PATH: challengeFetchedOnce + threadedIntoPayX402 (one
  402 total), executed:true, settleReceipt (batch c76cf6ef-…), balance 4.994 → 4.993
  (−0.001). Reorder did not break settlement.
- State 3 FETCH-FAILURE DEGRADES: bad seller URL → [] → clean Exa-only, no throw.
- State 4 INVALID-PRICE DEGRADES: malformed maxAmountRequired "not-a-number" → the
  Number.isFinite guard → [] → clean Exa-only, no throw.

**Note:** the reorder was deployed live to prod BEFORE commit (required to prove
end-to-end on prod); this commit makes git match the running prod code.

**Dead code:** dataPurchaseUsdc() / DATA_PURCHASE_USDC no longer feed the gate.
Left in place. Optional follow-up (not done): repurpose as an absolute secondary
ceiling — gate on min(advertised, DATA_PURCHASE_USDC) — so an external seller can't
advertise an arbitrarily high price that still fits under the percentage allowance.

**Now genuinely open — external seller:** the mismatch is closed and the path is
external-ready, but no actual external (non-self-loop) Arc seller has been paid yet.
That's the next real brick: point DATA_SELLER_URL at a seller we don't control and
prove a cross-party settle.

## 2026-07-06 (pm) — x402 buyer hardened for multi-chain sellers + absolute per-buy ceiling; QuickNode settle BLOCKED at account layer

**Buyer improvements (_x402.mjs) — proven against self-loop AND real external-seller PARSING:**
- **Entry-selection (FIX 1):** fetchX402Requirements no longer assumes accepts[0]; it SELECTS the
  entry matching our chain + scheme (network eip155:5042002 AND extra.name GatewayWalletBatched),
  first match wins; no match → ok:false → graceful degrade. A multi-chain seller (QuickNode
  advertises a 21-entry menu; Arc is index 16, accepts[0] is Base Sepolia) now parses correctly.
- **Price fallback (FIX 2):** read maxAmountRequired ?? amount (v1 vs v2 sellers). QuickNode has no
  maxAmountRequired; its `amount:"100"` (0.0001 USDC) is now read. Same fallback feeds BOTH the
  gate (maybeBuyData advertisedUsdc) AND the signed atomic → gate-price == signed-price.
- **Resource-binding + five-key envelope:** fetchX402Requirements now threads the challenge's
  TOP-LEVEL `resource` and `extensions` (it previously dropped both). wirePayload is the full
  { x402Version, payload, resource, accepted, extensions } — resource/accepted ALWAYS, extensions
  when the challenge carried them. Byte-diffed against @quicknode/x402's own captured payment
  (their client uses the same @circle-fin BatchEvmScheme via @x402/core createPaymentPayload):
  OUR payload is now byte-identical to theirs for the Arc nanopayment challenge (payload.authorization,
  signature, all three extensions [sign-in-with-x, bazaar, quicknode-session], resource, accepted).
  Self-loop unchanged (no extensions → four-key envelope, byte-identical to before).
- Reworded the price-guard block message (maxAmountRequired/amount).

Proven (local parse-only, no deploy/money): QuickNode Arc entry selected (idx 16 of 21), priced
0.0001 via amount-fallback, passed ceiling + canSpend; self-loop still parses; no-match degrades.

**Absolute per-buy ceiling (_research.mjs) — proven binds:** dataBuyCeilingUsdc() (repurposed dead
dataPurchaseUsdc), default 0.01, fail-safe (unset/garbled/<=0 → 0.01, never disables). In maybeBuyData
BEFORE canSpend; refuses advertised > ceiling with recordBlocked (audit parity), returns [] → Exa-only,
fires before signing. Proven end-to-end (real maybeBuyData, in-memory store, DELEGATE unset):
over-ceiling 0.02 refused ("absolute ceiling: 0.02 > 0.01"); UNSET still 0.01 and still refused
(fail-safe); QuickNode 0.0001 and self-loop 0.001 pass under. QuickNode 0.0001 << 0.01 so unaffected.

**QuickNode finding — nanopayment via a hand-rolled buyer is BLOCKED at the account/session layer:**
- Captured a QuickNode-accepted payment from @quicknode/x402 (throwaway key) and byte-diffed vs ours
  for the SAME Arc 402. After the fixes above, our payload is byte-identical to their client's.
- Their live verifier still rejects ours with "Unexpected error verifying payment", while their own
  client's payment (same shape) is accepted (a broke fresh key only failed on `insufficient_balance`
  — a funds check, i.e. the shape parsed fine). So the rejection is NOT in the x402 payload — it's
  QuickNode's account/session context around the request (extensions carry sign-in-with-x + a
  quicknode-session descriptor; nanopayment skips the SIWX/JWT sign path, but the server still binds
  the request to account/session state our raw buyer doesn't establish).
- CONCLUSION: paying QuickNode requires their SDK (@quicknode/x402), not our raw buyer. Not fixable
  in-payload. For a general external cross-party settle, use a seller running the SAME @circle-fin
  x402-batching middleware as our own seller (Option B) — it accepts our payload as-is.

**Still OPEN — an actual external cross-party SETTLE (not just parse).** QuickNode proved PARSING
end-to-end (select/price/gate/sign the real challenge) but not a settle. Next brick: Option B — a
non-self-loop seller on the same @circle-fin batching middleware, to prove a real cross-party settle.

Diagnostics diag-qn-settle / diag-parse / diag-reorder / diag-caps-block / diag-guard / diag-x402-buy
all retired (404). Buyer improvements deployed live to prod before this commit (needed for the live
QuickNode tests); this commit makes git match prod.


## 2026-07-07 — CORRECTION to the QuickNode finding: cause is the MISSING REQUEST BODY, not the account layer

The prior entry (2026-07-06 pm) concluded QuickNode's rejection was "at the account/session
layer, outside the payload." That was WRONG. Ground-truth probes found the real cause:

- **Signature is valid (suspect refuted):** captured our real Circle-signed payment for the Arc
  challenge and ecrecovered it against the exact EIP-712 TransferWithAuthorization digest
  (domain GatewayWalletBatched/1/5042002/GatewayWallet). It recovers to the delegate
  (0x6Db3…B380), 65 bytes, v=27 — a standard, viem-equivalent signature. Not the problem.
- **Missing request body (the actual difference):** QuickNode is a JSON-RPC PROXY — its client
  sends the paid request WITH the RPC body it's paying for (eth_blockNumber), on both the
  challenge fetch and the paid retry. Our payX402 (built for x402-quote, which serves a fixed
  resource needing no input) sent the payment header with NO body. Captured both empirically:
  @quicknode paid retry hasBody:true; ours hasBody:false. A payment with no request is
  nonsensical to an RPC proxy → "Unexpected error verifying payment."

**Fix implemented (_x402.mjs):** optional `requestBody` threaded through fetchX402Requirements
(challenge fetch) AND payX402 (settle) via a bodyInit() helper — forwarded on BOTH phases for
RPC-proxy sellers, omitted for our self-loop (unchanged, bodyless). Proven locally: with
requestBody the QuickNode challenge+settle both carry the eth_blockNumber body; self-loop
unaffected.

**Causation CONFIRMED by a live settle:** with the body-forwarding fix, payX402 settled the real
QuickNode Arc nanopayment — executed:true, settleReceipt.success:true (batch
21fb2402-c524-40c9-a849-8ad7c7007d04, eip155:5042002), QuickNode SERVED the RPC
(sellerBody.result 0x3033b90 = a real eth_blockNumber), and the payer's Gateway balance moved
4.993 → 4.9929 (−0.0001) cross-party to QuickNode's payTo 0xF463…623C. The missing request body
WAS the cause; the earlier "account/session layer" conclusion is fully retracted.

**Status: FIRST external cross-party x402 settle — DONE.** QuickNode nanopayment works via our
hand-rolled buyer (forward the paid request's body). The "still OPEN — actual external
cross-party settle" item from the prior entry is now CLOSED. Buyer is proven end-to-end against a
real, non-self-loop seller: select → price → gate → sign → pay+forward → verified/settled/served.

## 2026-07-07 — External-seller research-buy path completed end-to-end (pay → account → consume)

Built on the QuickNode live settle (logged in the correction entry above — batch 21fb2402…, the
first real cross-party x402 payment, cause = missing request body). This session generalized the
AUTONOMOUS research-buy path so it can pay, account for, and consume a real external / request-bound
data seller — not just the in-repo x402-quote stand-in. Four commits (6394bcc..37268c4):

- **6394bcc — payX402 forwards the request body.** bodyInit() + optional `requestBody` threaded
  through fetchX402Requirements (challenge fetch) AND payX402 (settle). RPC-proxy sellers (QuickNode)
  bind the payment to the request being paid for; a bodyless payment fails their verify. Proven by
  the live QuickNode Arc nanopayment settle (executed:true, served eth_blockNumber 0x3033b90, payer
  4.993→4.9929). Self-loop unchanged (no body). Corrected the earlier wrong "account/session layer"
  conclusion — ground-truth probes showed our Circle signature is valid (ecrecovers to delegate,
  v=27) and the lone asymmetry was the missing body.

- **62ded10 — maybeBuyData sources DATA_SELLER_BODY** and threads it into both the challenge fetch
  and the settle, so an autonomous research buy can target a request-bound seller. Unset → bodyless
  (stand-in unchanged). Documented in .env.example.

- **55b570f — seller-shape-aware response→facts mapping.** extractFacts(sellerBody, sellerUrl) maps a
  paid response into { claim, source } via DATA_SELLER_FACTS_PATH (dot-path; default "dataset.facts"
  keeps the stand-in unchanged): array of {claim,source} used as-is; array of other shapes
  stringified; scalar/object → one labeled fact. Exported + unit-tested (6 shapes). Lets a real
  seller's response feed the brief.

- **37268c4 — record spend on ANY confirmed settle.** Reordered maybeBuyData: settle-check →
  recordSpend → facts-extraction. recordSpend now fires as soon as executed:true (before facts), so a
  misconfigured DATA_SELLER_FACTS_PATH (settled but no usable facts) can't hide a real on-chain debit
  from the day-ceiling ledger. Invariant restored: money moved ⟺ spend recorded. !executed still
  records nothing. Graceful Exa-only degradation preserved (no facts → brief proceeds without them).

**Net:** the buyer + research engine now handle a real non-self-loop seller end-to-end —
select (multi-chain menu) → price (maxAmountRequired ?? amount) → gate (percentage caps + absolute
per-buy ceiling) → sign (Circle EOA) → pay+forward request → verify/settle/serve → always account →
map response → feed the brief. To wire a specific external seller, set DATA_SELLER_URL +
DATA_SELLER_BODY + DATA_SELLER_FACTS_PATH.

**Open:** no real external DATA seller wired in prod yet (QuickNode proved the mechanics with an RPC
call, not research data); DATA_SELLER_URL still defaults to the x402-quote stand-in. Next: point it
at an actual paid data API and confirm a live research brief consumes its facts.

**Method notes (this session):** all money-path changes proven no-money/no-deploy first (local
captures, ecrecover, in-memory ledger, unit tests) before any prod deploy; the one real settle (the
QuickNode 0.0001) confirmed the fix end-to-end. Diagnostics (diag-qn-settle etc.) all retired (404);
scratchpad/qn-probe sandbox deleted.

## 2026-07-07 — DATA_SELLER_URL wired to QuickNode (prod) — first real external data seller live

Recon for a real research-DATA seller first (Circle x402 marketplace + public x402 bazaar):
NONE found that our buyer can pay. Our buyer's guard requires scheme "exact" + extra.name
"GatewayWalletBatched" + the Gateway Wallet verifyingContract on Arc (eip155:5042002). Circle's
own docs confirm nanopayments = the "exact" scheme signed against the GatewayWalletBatched domain.
The mainstream x402 sellers (Coinbase Bazaar: weather/prices/news) use standard exact-onchain
EIP-3009 against the USDC token on BASE — our Arc/Gateway-batched buyer REJECTS them (wrong network,
not a Gateway-batched option). The only live sellers on our exact scheme+chain are QuickNode
(blockchain RPC data) + our own x402-quote stand-in + reference samples. So there is no drop-in
general research-data seller today.

Per user decision, wired the one proven-payable real seller: **QuickNode** (accepting it serves
on-chain RPC data, not general research facts). Prod env (production context) + redeploy:
- DATA_SELLER_URL        = https://x402.quicknode.com/arc-testnet
- DATA_SELLER_BODY       = {"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}
- DATA_SELLER_FACTS_PATH = result

**Proven end-to-end locally (no money — settle stubbed):** research() with those env bought from
QuickNode → extractFacts(path=result) → the fact { "result = 0x3033bcd", url: quicknode } merged into
the brief → model answered "current Arc Testnet block height is 0x3033bcd (50,545,613)" → spend
recorded (0.0001). Config-only change: repo unchanged (the three vars were already documented in
.env.example); deploy 6a4c4c0f live, job-quote 200 / x402-quote 402 / my-wallet 401.

**Now live:** prod research jobs autonomously buy from QuickNode when decidePurchase judges a live
figure is needed — ~0.0001 USDC/qualifying buy, bounded by the 0.01 absolute ceiling + per-tx cap +
60/day per-user ceiling; recordSpend fires on any confirmed settle.

**Caveats / open:**
- SEMANTIC FIT: QuickNode's "fact" is an Arc block number — meaningful only for on-chain questions;
  for general research decidePurchase should SKIP, so most jobs won't buy. This proves a real
  external autonomous buy end-to-end; it is NOT a general research-data source.
- Local .env left unset → local research still uses the x402-quote stand-in (no local spend).
- The first REAL on-chain settle inside a prod job hasn't happened yet (user-triggered; not forced).
- STILL OPEN: a general research-data seller our buyer can pay. Options if pursued: (1) run our own
  seller that proxies a real data API/LLM behind the Gateway-nanopayment middleware on Arc; (2) add
  the vanilla exact-onchain buy path (already built/proven) to maybeBuyData to reach Base bazaar
  sellers (needs a Base USDC balance + a 2nd buy path).

## 2026-07-07 — RETRACTION + PROOF: autonomous QuickNode settle works end-to-end (supersedes 45d9dff conclusion)

**RETRACTION.** The 45d9dff entry concluded QuickNode's rejection was an "account/session layer
block, outside the payload — nanopayment via hand-rolled buyer is BLOCKED; use @quicknode/x402;
for a general cross-party settle use Option B." That conclusion was WRONG. Root cause was mundane
and in-payload: the **missing JSON-RPC request body**. QuickNode's endpoint is a JSON-RPC PROXY —
the paid request must carry the call it is paying for (eth_blockNumber). Our buyer, built for a
seller that serves a fixed resource (x402-quote), sent the payment header with no body, so
QuickNode's verify errored. Ground-truth probes proved our signature was valid (ecrecovers to the
delegate, v=27) and the body was the lone asymmetry vs @quicknode/x402's own client.

**PROVEN on prod — the FULL autonomous path, not a forced/direct diag.** A genuine decidePurchase
decision → maybeBuyData → payX402 → live QuickNode settle:
- decidePurchase (real Claude call, no forceDecision) decided BUY for "current Arc Testnet block
  height right now" (Exa can't supply a live block number).
- Settle: batch **ba918c90-0fd6-47ef-bb8a-18cb2dca1ec9**, network eip155:5042002.
- Money moved: delegate Gateway balance **4.9929 → 4.9928** (−0.0001), confirmed via the Circle
  Gateway API INDEPENDENT of our diag.
- The real figure flowed into the brief: Arc block **0x303d4ed**.
This is the FIRST real autonomous cross-party x402 settle against an independent external seller
(closes the "only proven with a stubbed settle" seam flagged during reconciliation).

**Live wiring (prod).** DATA_SELLER_URL=https://x402.quicknode.com/arc-testnet,
DATA_SELLER_BODY={"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]},
DATA_SELLER_FACTS_PATH=result. Every autonomous buy is bounded by the 0.01 absolute per-buy ceiling
+ per-tx cap + the per-user daily ceiling, and degrades to Exa-only on any failure; recordSpend
fires on any confirmed settle.

**Semantic caveat (honest).** QuickNode's "fact" is an Arc block number — genuinely useful only for
on-chain/crypto questions. decidePurchase SKIPS it for general research (no live on-chain figure
needed), so most real jobs will NOT buy. A general research-DATA seller our buyer can pay is STILL
OPEN (no third-party sells research data on our GatewayWalletBatched-on-Arc scheme; options remain:
run our own real-data seller on the Gateway-nanopayment middleware, or add the vanilla exact-onchain
buy path to reach Base bazaar sellers).

Diagnostic diag-realbuy retired (404) after this proof.

## 2026-07-07 — UI: "Nanopayments" explainer window (copy-only, no money moves)

**What.** A new user-facing explainer that tells people what a nanopayment is and walks through how
the agent uses one mid-research. Pure UI/copy — no wallet prop, no network calls, moves no money,
no CSS changes. Read-only audit first, then built to the audit.

**Placement (decided with user).** Reached at `#/nanopay` via a **4th "Nanopayments →" quick-card**
in the Dashboard "Do something" row — deliberately NOT a nav item. The 5-item nav (Dashboard /
Wallet / AI Agent / Research / Send) stays reserved for working tools; the hash router
(`App.tsx` parseHash + switch) renders the route from a `case "nanopay"` with no NAV entry, which it
supports because parseHash never validates against NAV. The 4th card wraps to a second row in the
`repeat(3,1fr)` grid and sits alone on the left — confirmed intentional, no CSS tweak (collapses to
one column on mobile like the rest).

**Visual (matches shipped design — amber-on-ink).** Reuses existing classes only: `.plane` shell +
serif `h2` + `.sub`; amber `.panel-eyebrow`; and the **previously-unused `.process` 4-step strip**
(`styles.css:197-223`) as the how-it-works sequence (its intended purpose); an inset `--field`-bg
callout for the "$0.01 max" line. NOTE: there is NO purple/teal gradient in this app — the signature
is warm ink + a single amber-gold seal; a gradient impression from earlier was foreign to the CSS
and was not built to.

**Copy = the real flow.** The 4 steps condense the actual autonomous purchase path in
`netlify/functions/_research.mjs`: 01 decide a live figure is needed (decidePurchase SKIPs if free
web sources suffice) → 02 read the seller's advertised price, refuse above the 0.01 ceiling / budget
→ 03 sign the on-chain USDC nanopayment (only a confirmed settle counts) → 04 fold the purchased
fact into the brief with its source. This doubles as the spec for a future LIVE version of the
window (server already logs the price/gate/settle signals it would surface).

**Naming.** Feature name is plural "Nanopayments" in the card title + eyebrow; singular common-noun
usage left as-is where it means one payment ("Pay the nanopayment", "Each buy… every purchase").
Component file kept `NanopaymentPanel.tsx` (internal, not worth the churn).

**Files.** New `src/components/NanopaymentPanel.tsx`; `src/App.tsx` (import + route case);
`src/components/Dashboard.tsx` (4th card). Verified: `tsc --noEmit` clean, `vite build` clean, local
`vite preview` eyeballed by user before ship.

**Shipped.** Committed `0e9176d` on main, pushed to origin. Deployed to prod via Netlify CLI
(deploy `6a4cdf71…`, "Deploy is live!"); prod `index.html` confirmed serving the new build hash
`index-C1dH3bdq.js` (real-deploy check, not just a 200 on the hash route). Live at
app.tikpema.xyz/#/nanopay.
