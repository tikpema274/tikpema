# Direction log

One dated entry per piece of ecosystem reading T shares (or a launch we measure), and **what it changed** for
Tikpema's direction. The point is the trend across entries, not any single summary. Newest at the bottom.

Each entry carries:
- **Source**: what was read.
- **Claim**: what it asserts.
- **Checked**: what we verified or measured. Unverified claims are marked as such.
- **Signal**: what it says about where the field is going.
- **Changed**: what, if anything, moved in Tikpema's priorities. "Nothing" is a valid answer.

## The standing thesis (revise it when an entry forces it)

Agents need four layers: **identity, payments, data, trust**. The first three are commoditising fast and are owned by
well-funded players (Circle's kits, ERC-8004, Surf-type data layers, Tempo). **The trust layer is not empty: it exists as
RATINGS** (Webacy's DD, Credora, vaults.fyi, Gauntlet: a number for every vault, unknowns scored, unsigned; Webacy sells
it over x402 with an MCP server). **What is empty is the CHECKABLE version: a verdict derived from the chain with the
redemption route understood, a REFUSAL when it cannot tell ("I don't know ⇒ no"), a per-check coverage manifest, and a
signature a third party can re-check at a block.** Tikpema builds that. *(Revised 2026-10-02: it read "the trust
layer … is empty"; the Webacy entry below forced the change.)* Directions that follow:

1. **Be the check the kits call**: DD in depth on what Circle hands agents (Morpho V2 + exit liquidity → Earn Kit's
   `onBeforeAuthorize`).
2. **Trust exercised, not declared**: reputation is declared but never used; the ack gate is checked only at deploy.
3. **Our own surfaces meet the standard we sell**: a trust product that misstates a fee undermines itself.
4. **Mainnet is the gate**: the kits and the risks are on Arc mainnet; DD is testnet-only.

**Watch for:** anyone moving from "here's the data" to "here's a verdict you can act on". That is the point where the
trust layer gets competition.

---

## 2026-09-24 — FXC report: Arc and payment chains
- **Source**: FXC report (partly gated; comparison, speeds and fees not read).
- **Claim**: Arc is pitched to institutions as wholesale/B2B rails; 11 permissioned validators; Tempo (Stripe +
  Paradigm) is the rival.
- **Checked**: validator model matches Arc docs (permissioned PoA). Gated sections not read.
- **Signal**: the payment-chain race is institutional and two-sided (Arc vs Tempo).
- **Changed**: nothing directly. It set the competitive frame: payments are a contested commodity.

## 2026-09-28 — Earn Kit launch read
- **Source**: Circle Earn Kit docs and SDK (1.6.1 installed).
- **Claim**: embedded yield for any app, via Morpho.
- **Checked**: Morpho-only, **no allowlist**, adapter + service-signed execution; `riskSignals` thin (sentinel,
  warnings, an aggregate `available` that is not "redeemable"); `onBeforeAuthorize` is the only insertion point.
  1.6.1 rejected Arc mainnet.
- **Signal**: Circle is handing agents deposit paths with weak risk signals.
- **Changed**: identified `onBeforeAuthorize` as DD's distribution point.

## 2026-09-30 — "Programmable money / AMP" essay
- **Source**: essay on context-aware money, idle capital, and "AMP (Arc Multiple Proposer)".
- **Claim**: Arc's AMP decentralises block building and protects against MEV; vaults auto-move balances into yield.
- **Checked**: **"AMP" is not in the Arc docs.** Multi-proposer is a Malachite *roadmap* item, for throughput.
  Today: permissioned PoA, one rotating proposer. `/build/payments` claims ordering prevents front-running; the
  node docs call pending-tx RPCs "a potential MEV vector". The yield-automation claim is not true of Tikpema today.
- **Signal**: ecosystem marketing runs ahead of shipped protocol.
- **Changed**: nothing. A reminder to check claims before repeating them.

## 2026-09-30 — Arc House: Onramp, Earn and Borrow Kits on Arc mainnet
- **Source**: Arc House blog (Tim Baker) + Arc docs + the kits' public APIs.
- **Claim**: embedded USDC funding, lending opportunities and BTC-collateralised borrowing, now on mainnet.
- **Checked** (read-only, chain + public APIs):
  - **Borrow Kit** is Morpho Blue (code: `protocol: z.enum(['morpho'])`). Its public market list includes the drained
    USDC/cirBTC pool `0xc2db…815d`: **39.84 USDC free** of 185M. On launch day it could lend ≤ ~40 USDC against cirBTC.
  - **Earn Kit 1.8.1** lists **30 vaults** on Arc, no allowlist, including test and unnamed vaults. **Galaxy USDC is
    first**: `status: low_liquidity`, but `riskSignals.warnings: []` + `circleGuarded: true`, while only **5.57%** was
    redeemable on chain (liquidity adapter unset).
- **Signal**: the platform's own risk feed missed the exit fact. The trust layer is not just empty; its absence is
  measurable on launch day.
- **Changed**: produced the **Morpho V2 recommendation** (PROGRESS 58486d7): widen DD in depth (V2 profile + exit
  liquidity) aimed at Earn Kit's hook. Decision is T's. ⛔ *Corrected 2026-10-02: T had already decided this on 09-28
  (PROGRESS 0b1858b: DD takes V2, signs structure + number, block-hash binding in the same window). The recommendation
  agrees with it; nothing was pending.*

## 2026-10-01 — Surf (crypto data layer)
- **Source**: post on Surf Skill + Surf's own docs, pricing and repo.
- **Claim**: agents get crypto data workflows (market, on-chain, prediction markets) via API, MCP and a skill.
- **Checked**: ~119 endpoints; **no security or risk endpoints**; chains Ethereum, Arbitrum, Base, BSC, **Tempo**,
  TRON, HyperEVM (**no Arc**); prepaid credits + API key, not x402; $0.006–$0.036/call; also sells LLM answers
  ($0.12–$1.20/call).
- **Signal**: breadth is commoditised and subsidised ($200k credits). The paid LLM answers are the first step from
  "data" toward "verdict" — but unaccountable, no refusal semantics.
- **Changed**: confirmed "depth, not breadth" for DD. Surf is not a DD competitor and is a poor Researcher source
  today (no Arc, credentials not x402, price above the per-buy ceiling).

## 2026-10-01 — "The Economic Passport" essay
- **Source**: essay on Arc as the foundation of an agentic economy.
- **Claim**: agents need identity, peer-to-peer communication, value exchange and verifiable trust; Arc
  "uniquely" provides this "economic passport", freeing AI from human micro-management.
- **Checked**: identity (ERC-8004) and payments (Circle's stack, USDC gas) exist on Arc but are mostly
  ecosystem standards, not Arc inventions; no peer-to-peer agent communication exists in our stack; verifiable trust
  is the thinnest pillar (DD's signed report exists; reputation declared, never exercised). "Uniquely" is
  contested by Tempo.
- **Signal**: the narrative treats oversight as friction. This week's evidence (Earn Kit, Borrow Kit, our own fee
  copy) shows autonomy without a verifier removes the safeguard, not the human.
- **Changed**: sharpened the pitch: Arc is the payment layer; **the trust layer is what's being built, and
  Tikpema builds it**. Bounded autonomy (caps, acknowledgements, refusal on doubt) is the position.

## 2026-10-01 — "How Arc + AI Agents Can Fix Broken B2B Payments" (forum post, written 2026-04-25)
- **Source**: Arc House member-lounge post by Sodiq Taiwo ("Skywalker"), 2026-04-25.
- **Claim**: B2B payments break on slow approvals, invoice/PO mismatches, disputed delivery and costly cross-border
  transfers. Agents read invoices, compare them with terms, *"verify whether goods were delivered"* from "available
  data (logistics updates, confirmations)", approve "automatically", and Arc settles instantly in USDC at "near-zero
  cost". Disputes are solved because "decisions are based on shared, verifiable data". The post itself raises
  "trust, control, and how much decision-making we're comfortable handing over".
- **Checked**:
  - Arc fees are low (ERC-20 transfers target ~$0.001, Arc docs). Settlement is final on inclusion. True.
  - **Delivery verification is asserted, not solved.** "Another agent verifies delivery using available data" is the
    oracle problem: who attests that goods arrived, and who answers when the data is wrong. Nothing in the post or in
    Arc's stack supplies it.
  - **"Shared, verifiable data" resolves no dispute by itself.** Release conditions need an escrow with a defined
    evaluator, not just fast settlement. ERC-8183 escrow exists on Arc and **we run it live** (research-for-hire, job
    #145459, priced → funded → evaluated → settled).
  - **The hard parts of cross-border B2B are missing:** compliance (sanctions/AML screening; ours is NOT built,
    deferred to mainnet, with only manual payout screening) and the fiat edges (on/off-ramps; TikpemaPay's ramp work
    is paused). "Near-zero cost" covers the USDC leg only.
  - Tikpema's own merchant rail exists: checkout v1 proven live 09-19 (one payment hash ⇒ one order, replay refused).
- **Signal**: the B2B narrative runs "agent decides → Arc settles" and skips the middle: who verifies the condition,
  who holds the money until then, who screens the counterparty. Same gap as the thesis, in a new vertical:
  verification before money moves.
- **Changed**: nothing in priorities. It frames where the trust layer extends beyond DD's "is this contract safe":
  **conditional release** (ERC-8183 escrow with an evaluator, already live for research) and **counterparty
  screening** (compliance, deferred). If B2B becomes a target, those two, not settlement speed, are the product.
  Noted for the mainnet go/no-go §5 (compliance), which already defers screening to exactly this point.

## 2026-10-01 — "3 kits, one problem" (hackathon post)
- **Source**: short community post on Onramp, Earn and Borrow Kits being live on Arc.
- **Claim**: the three cover "getting money into the app → putting it to work → borrowing against it"; the value is
  that developers can COMBINE them into an actual financial product instead of three integrations.
- **Checked** (this week's measurements + Arc docs):
  - **The chain does not compose as stated.** Borrow Kit takes **cirBTC** as collateral only (Arc docs: "Borrow: cirBTC
    as collateral"). Onramp delivers USDC/EURC; Earn returns vault shares. So you cannot "borrow against" what you
    onramped or put to work. Step 3 needs a different asset, i.e. a swap in between, which none of the three kits does.
  - **Composing compounds unverified risk.** On launch day Earn's first-listed vault (Galaxy USDC) was 5.57% redeemable
    with `riskSignals.warnings: []`, and Borrow's cirBTC→USDC market had ~40 USDC free of 185M. A product that chains
    them inherits both, and neither kit warns about the other.
- **Signal**: the ecosystem's next move is COMPOSITION, kits chained into products. Each joint is a decision point
  where money moves on the previous step's output, which is exactly where a check belongs and where none exists.
- **Changed**: nothing in priorities; it sharpens direction 1. **The check belongs at the JOINTS of a composed flow**,
  not only on a single action. Tikpema already has that shape: the agent plan path prices, discloses and asks consent
  PER STEP (bridge acknowledgement, vault disclosure in a plan) and refuses the whole plan before step 1. A Morpho V2
  DD profile would put the vault joint under the same per-step verdict. Watch for: a kit or framework that chains
  Onramp → swap → Earn/Borrow on the user's behalf; that is the flow that most needs a verifier between steps.

## 2026-10-01 — Centrifuge brings institutional RWAs to Arc (X post + Arc spotlight)
- **Source**: @silencexlm on X (19:15Z) → Arc House "Partner Spotlight / Centrifuge" (published 2026-10-01 19:09Z).
- **Claim**: Janus Henderson (JTRSY: T-bills; JAAA: AAA CLOs) and New York Life (HYB: high-yield corporate) tokenized funds are
  live on Arc via Centrifuge/Anemoy, as "composable ERC-4626 primitives" for lending collateral, yield vaults and treasury
  allocation ("routing USDC into RWA tokens in a single transaction"); "standard deposit(), withdraw(), convertToAssets()".
- **Checked** (the spotlight's own developer section; nothing on chain yet — it names no Arc addresses):
  - The tokens implement **ERC-7540, the ASYNCHRONOUS vault standard**, alongside ERC-4626. Under 7540, redemption is a
    request that is fulfilled later; the post itself says investors are **"submitting daily redemptions back to USDC"**.
  - **Transfers are permissioned:** "Token transfers verify address eligibility against Centrifuge's permission registry";
    the app does "identity verification, wallet whitelisting".
  - Pricing is a **NAV oracle pushed cross-chain** to Arc, not a market price.
- **Signal**: the most institutional assets yet on Arc are pitched to builders as plug-in 4626 collateral, while their EXIT is
  asynchronous (daily at best), whitelist-gated, and priced by an oracle. For anything integrating them — a lending market
  that must liquidate, a vault that must meet withdrawals, an agent routing a treasury — "can I get it back out, how fast,
  and can whoever receives it even hold it?" is the whole question, and the "deposit()/withdraw()" framing hides it.
  (A liquidation that must transfer the token to a non-whitelisted liquidator, or redeem on demand, does not work as it
  would for a liquid 4626.)
- **Changed**: no change in priorities; it strengthens the promise and widens Stage 1's case. DD's answer for these today
  should be a refusal (unrecognised exit mechanics), which is correct and honest. The verdict worth building — after the
  Morpho V2 profile — is an **exit-mode fact**: synchronous vs asynchronous (7540) redemption, the fulfilment cadence, and
  whether the holder/receiver is eligible in the permission registry. Noted for roadmap Stage 1 as the second profile
  candidate, not a commitment.
- **Verified on chain (2026-10-01, read-only; Arc mainnet 5042, block ~23762899; addresses from Centrifuge's own API
  api.centrifuge.io, where Arc is centrifugeId 14):**
  - **3 vaults, all `kind: "Async"`, asset = Arc USDC**: JTRSY vault `0x1277…2bb1` / share `0xc18e…6040` (6 dp);
    JAAA vault `0x2dc7…e5c4` / share `0xad48…f797` (6 dp); HYB vault `0xcf0c…a9ba` / share `0x4827…2505` (18 dp).
    Created 2026-09-17. Each vault reports supportsInterface true for ERC-7540 operator, **async DEPOSIT and async
    REDEEM**, and ERC-7575; `requestDeposit` / `requestRedeem` / `pendingRedeemRequest` are in the bytecode.
  - **Nothing is invested on Arc yet:** every share token has `totalSupply 0`, every vault `totalAssets 0`. "Live" =
    deployed and linked, no holders.
  - **Deposits are async too.** The spotlight's "routing USDC into RWA tokens in a single transaction" does not hold for
    these vaults: a deposit is a request, fulfilled by the manager, then claimed.
  - **One transfer hook for all three, `0x8E68…24a4`:** `isMember`, `checkERC20Transfer` / `onERC20Transfer`,
    `updateMember`, **`freeze` / `isFrozen`**, `updateRestriction`. An arbitrary address: `isMember(JTRSY, 0x…dEaD) =
    (false, 0)`, so it cannot receive the token. The issuer can also FREEZE a holder.
  - For any integrator, the exit therefore depends on: a fulfilled redeem request (timing set by the manager); the
    receiver being a member (a liquidator must be whitelisted); and the holder not being frozen. None of this is visible
    through the ERC-4626 `withdraw()` the spotlight points builders to.
- **The same announcement, three versions, and the caveats thin out as it travels** (T found the Discord post, 10-01):
  the blog's developer section names ERC-7540 (async) and the permission registry; the X post says "ERC-20 / ERC-4626
  primitives"; the **Discord announcement says "Built on ERC-20 and ERC-4626 vault standards", does not mention ERC-7540
  at all, and reduces the permission registry to "eligible investors … may be able to onboard."** Its pool IDs match the
  chain (JTRSY 281474976710662 → vault 0x1277…2bb1; JAAA 281474976710663 → 0x2dc7…e5c4; HYB, linked only to the app root,
  is 281474976710671 → 0xcf0c…a9ba). Signal: the version most builders read is the one that hides the exit mechanics, so a
  verifier that states the exit mode from the chain is answering a question the announcement leaves out.

## 2026-10-01 — SwiftPay live on Arc mainnet (forum post 2026-09-26) — the closest peer yet
- **Source**: Arc House "Ecosystem Showcase" post by Benneth Chiegene (SwiftPay), 2026-09-26; getswiftpay.xyz.
- **Claim**: an everyday-finance app for stablecoins, Nigeria/Africa first: Circle wallets (Google/email), send/request
  to @username, swap USDC⇄EURC, CCTP deposits, invoices, BatchPay, on-chain payroll, RecurePay (recurring payments under
  on-chain caps), savings pockets with round-ups, **Earn in "vetted Morpho USDC/EURC vaults through Circle App Kit"**, and
  **ALLIE, an AI payments agent "within limits you set"** (a Developer-Controlled Wallet). Security: "No single key
  controls them. Every contract is owned by a 48-hour timelock run by a 2-of-3 Safe … can pause … can never move user
  funds, and withdrawals stay open even while paused." Testnet: 164 users, 6 businesses. Next: an audit, a naira ramp,
  Gateway/Nanopayments for ALLIE. **"Builders … working on payments, ramps, FX or agents on Arc, we'd love to integrate."**
- **Checked** (read-only, Arc mainnet block ~23770952; all 5 contracts EXACT-match verified on Sourcify):
  - **Ownership claim TRUE.** All five (SwiftPaySend, BatchPay, RecurePayExecutor, SwiftPayrollExecutor, SwiftSaveVault)
    are owned by timelock `0x9178…f2E3` (created block 22738272, 2026-09-25 19:35Z), `getMinDelay` = 172 800 s (48 h),
    self-administered. PROPOSER + EXECUTOR + CANCELLER = Safe `0x0cbb…39c5`, **2-of-3**. No open executor. The guardian
    (pause-only) is the same Safe; only the timelocked owner can unpause.
  - **"Can never move user funds": TRUE for savings, by code.** `SwiftSaveVault.rescueTokens` is bounded to
    `balance − totalLocked` (untracked mis-sends only); `withdraw` has no `whenNotPaused` (deliberately open while paused
    or after a token is delisted). `SwiftPaySend.rescueTokens` is unbounded, but that contract holds funds only within
    a call.
  - **Not said in the post:** each executor is driven by a **single EOA operator** (RecurePay `0xAe0e…41fB`, Payroll
    `0x77C3…C94E`), and fees go to a single EOA (`0x0387…b56d`). The operator is **bounded on chain by the payer's own
    settings**: fixed recipients, per-period caps, replay-proof execution ids, constant fees (1% executors/BatchPay,
    0.1% send). A stolen operator key can pay a payer's OWN chosen recipients up to their caps, never an attacker. Two
    nuances: the operator picks WHEN and HOW MUCH (≤ cap), and the 1% fee is charged ON TOP of the cap (a RecurePay
    `maxPerPeriod` of X lets up to 1.01·X leave per period).
  - SwiftSaveVault holds 0 USDC / 0 EURC today. **Not checkable from here:** which Morpho vaults "vetted" means
    (Earn Kit's own list put Galaxy USDC first, with empty warnings and 5.57% redeemable); ALLIE's "limits" (off-chain;
    its wallet is custodial).
- **Signal**: a well-engineered peer covering Tikpema's surface (wallet, send, swap, bridge, recurring, savings, earn, an
  agent with limits) and launched first on mainnet. Its contract hygiene is strong and true as stated. Its trust gap is
  exactly the thesis: **"vetted vaults" is an assertion, not a verifiable verdict**, and the agent's limits are not on
  chain.
- **Changed**: nothing in priorities; it **sharpens** them. (1) Competing on the app surface (send/payroll/savings) is
  crowded and SwiftPay is ahead on mainnet; Tikpema's edge is the verifier, not the wallet. (2) **They ask builders to
  integrate.** DD as the check behind their Earn "vetted" claim (before a deposit, can you get it back out?) is a concrete
  first customer for roadmap Stage 2's "verdict in someone else's money path". A conversation for T to decide, not
  a commitment. (3) Their published, verifiable ownership chain sets a bar Tikpema's own mainnet go/no-go should meet.

## 2026-10-01 — Portage (Arc testnet demo: Gateway payout consolidation + conditional escrow)
- **Source**: portage-landing.vercel.app/demo; github.com/erhnysr/portage (Solidity, created 2026-07-27, last push
  2026-09-28, 0 stars, one developer); npm `@erhnysr/portage-sdk`.
- **Claim**: apps receive USDC on many chains via Circle Gateway, consolidated into a per-app balance on Arc and paid
  out on demand. "Nothing is custodied … no server holds a key." Testnet only.
- **Checked**: the five README-listed contracts exist on Arc TESTNET (5042002; AppRegistry, Ledger, PayoutEngine,
  PortageRouter, PortageMintForwarder; Ledger holds 2.4 USDC). Read from the repo (not audited):
  - The deposit's burn intent pins `destinationCaller` (the forwarder) and `destinationRecipient` (the router). The
    app/account metadata (`PayoutMeta`) is **bound to the transfer's specHash by an EIP-712 signature from the depositor**,
    because Gateway's testnet API 500s on non-empty `hookData`. Unattributable deposits go to quarantine (governor resolves).
  - A custody invariant (`custodyTotal == Σ appTotal`) enforced as test-suite invariants. App isolation is structural.
  - A **ConditionalEscrow** with pluggable release conditions: Timelock, MutualRelease, **AttestationCondition** (a
    payer-named attester makes ONE on-chain `attest(recipients, amounts)` call; any address may be the attester) and
    **VerdictCondition** (resolves from an on-chain "Arena" contest vote, 60/30/10, not a risk verdict).
- **Signal**: builders are composing Circle Gateway + conditional release on Arc, the B2B post's missing middle,
  as open infrastructure. The attester/condition pattern is exactly the slot a verifier fills: "release when an
  independent party says so". DD signs OFF-chain (ERC-1271-verifiable reports), while AttestationCondition needs an
  ON-chain `attest()` from the attester's address. Plugging DD in would mean DD's own agent wallet transacting, or a
  condition that verifies a DD signature. Not a fit today, but the shape is right.
- **Changed**: nothing in priorities. Two notes. (1) Portage's **signed metadata bound to the transfer spec hash** is a
  concrete technique for Tikpema's open **checkout GAP 1** (binding a payment to its order without calldata): the payer
  signs (spec, order) and the settlement verifies it. An idea for when GAP 1 is picked up, not a decision. (2) A
  "condition that verifies a DD-signed verdict" is a candidate integration shape for conditional release (escrow, B2B)
  if that ever becomes a target. Not a commitment.

## 2026-10-02 — Idea (T): build TikpemaPay into Tikpema, "serves all your needs, you don't have to leave the app"
- **Source**: T, in session, explicitly as an idea, not a decision.
- **Claim**: one app covering funding (on/off-ramps, TikpemaPay's providers, accounts, Solana) and Tikpema's agent +
  vault + DD would remove the friction of leaving the app.
- **Checked** (from our own records, no new measurement): TikpemaPay is PAUSED since 2026-09-24; its Circle Onramp
  (09-27) is local and unpushed; its repo AUTO-DEPLOYS on push to main (unlike Tikpema). Compliance/AML is not built and
  is deferred to mainnet (go/no-go §5). The custody map (09-24) already rates Unified Balance as Tikpema's most custodial
  path. The app layer is crowded: SwiftPay ships wallet, payroll, savings and an agent on Arc mainnet (entry 2026-10-01).
- **Signal**: the instinct is right about one thing. Funding is the step just before the deposit we protect, and making
  a user leave to do it is real friction.
- **Changed**: nothing in priorities. **Deferred, as INTEGRATION, not absorption** (Claude's recommendation, T agreed to
  record it):
  - **Against a merge now:** it reverses the narrowing (Tikpema wins as the check others call, not a better wallet, and
    an all-in-one app competes where SwiftPay and Circle's kits are strongest). Ramps pull KYC/AML, provider contracts
    and per-country rules forward into a product whose promise is trust: done half-well, that damages the one thing it
    sells. It widens custody surface before the vault exit has fired once. And "one coherent experience" is roadmap
    stage 5 on purpose, built around a proven promise.
  - **The shape to prefer:** when TikpemaPay is un-paused, make it **Tikpema's first customer**: it calls DD before any
    deposit or yield action, the way we want SwiftPay's Earn to. That is a live stage-2 integration example in our own
    code, gives "never leave the app" via linking (deep links, a shared wallet session) without one codebase carrying both
    risk profiles, and makes the SwiftPay pitch credible ("we depend on it ourselves").
  - **Comes back when:** the vault exit has fired AND Morpho V2 is in DD, and TikpemaPay is un-paused. Any experiment
    starts on a BRANCH in the TikpemaPay repo (push to main deploys).

## 2026-10-02 — "Your AI Agent Has a Wallet. But Does It Have an Identity?" (Agentic Economy post)
- **Source**: a short "Agentic Economy" post T shared (tagged #AgentIdentity), author not recorded.
- **Claim**: an agent should not be "an AI with a wallet"; we need to know which agent acts, who authorised it, what it
  may do, and how that is revoked. Example: 50 USDC for 2 hours, specific contracts, a defined action set. Identity
  should be verifiable, scoped, temporary when necessary, revocable, tied to clear permissions.
- **Checked** (against our own records; nothing new measured): a wish, not a mechanism; it names no standard or wallet.
  Against Tikpema:
  - *Verifiable:* partly. DD has an ERC-8004 identity (agentId 851891) and its reports verify on chain (ERC-1271). The
    agents' LIMITS are server-side, changeable by a deploy (agent-parameters, fixed 25006e5 to say exactly that); the
    invariants document is pinned on IPFS but NOT yet recorded on chain. A third party trusts our deploys, it cannot check.
  - *Scoped:* yes, server-enforced: per-tx / daily caps, the acknowledge gate, the vault mandate (one vault, 10 USDC per
    deposit, 100 total, daily), close to the post's example.
  - *Temporary:* by cadence and totals only, no expiry.
  - *Revocable:* yes (cancel, kill switch, the halt latch).
  - *Enforced on chain:* no. Custody map 09-24: no session keys in our wallet stack, no Circle scoped-delegation API;
    the UB delegate holds a full allowance.
- **Signal**: the identity layer is being described as "who acts + what it may do". Still identity: commoditising, per the
  thesis. ⭐ What it leaves out is our layer: **a perfectly scoped agent can still put its whole 50 USDC into a vault it
  cannot exit.** Permissions bound the BLAST RADIUS, not the DESTINATION. Scope says whether the agent MAY act; the check
  says whether the destination is one to act on. Complementary, and the case for "be the check the kits call",
  identity kits included.
- **Changed**: nothing in priorities. Sharpens thesis direction 2 (trust exercised, not declared) into a named gap: our
  scoping is real but only SERVER-verifiable. Candidates for stages 3–4, not builds now: publish a mandate's terms where a
  third party can check them (e.g. beside the ERC-8004 identity, without editing the frozen unified.json); on-chain
  limits when a wallet stack on Arc offers session keys / scoped delegation.

## 2026-10-02 — Webacy "DD" vault monitor (dapp.webacy.com/vaults; dd.xyz) — the closest competitor found
- **Source**: dapp.webacy.com/vaults (dd.xyz 301-redirects there) read from its page bundle; docs.webacy.com (llms.txt,
  vault-ratings, v3 overview / detail schema, framework methodology, API intro); the OpenAPI spec (540 KB); the PUBLIC
  `GET https://api.webacy.com/v3/framework` (no key). ⚠️ Per-vault data was NOT read: the API needs a key (or x402), and
  the dashboard's `/api/vaults*` routes return a Cloudflare 403 to scripts (not bypassed).
- **Claim**: "ERC-4626 vault risk monitoring" — composite 0–100 risk score → letter grade A+–F, listing verdict,
  withdrawal state, % TVL withdrawable, large-redemption alerts, 90-day history.
- **Checked**, against our four criteria:
  - **(a) who can touch:** PARTIAL, as weighted sub-scores (EOA vs multisig + threshold, proxy/upgradeable, timelock
    present/sufficient "7-day = gold standard", pause, pending admin change, curator identity/discretion, ownership
    transfers). No per-power timelock / abdication / current value seen.
  - **(b) out right now:** YES as an estimate: `pct_tvl_withdrawable`, `withdrawal_state`. Bundle definitions: Morpho =
    "idle market liquidity plus vault buffer, capped at TVL"; lending = "1 − utilization"; Lagoon = "safe asset balance".
  - **(c) not-checked:** NO per vault. `coverage` counts FRAMEWORK criteria (live: 42 defined, 39 live); per vault only
    `drivers_complete` + per-criterion `data_quality.confidence`. Unknowns are SCORED: "Unknown / unverified" oracle = 40
    ("Can't assess what isn't disclosed"); unverified code +65; "a category only appears on a vault when its signal is
    present". Fail-closed only at RESPONSE level (4xx/5xx/`stale`).
  - **(d) signed / re-checkable:** NO. Nothing in the spec signs a rating; the only signing is webhook HMAC (shared
    secret). Evidence values per criterion, no block / no re-runnable reads.
  - **Large Redemptions:** every 6 h, 24 h of `Withdraw` events (2 h Arbitrum, 6 h BSC) across 600+ vaults with TVL ≥
    $500K; flagged when one wallet redeems > $500K or > 1% TVL. Exit ACTIVITY after the fact, not exit ABILITY.
  - **Methodology:** weights, penalties, floors, grade bands published + a public taxonomy endpoint; sub-score curves
    not fully specified, so a score is not reproducible from the docs.
  - **Chains:** vault scoring eth, arb, base, opt, pol, bsc (docs say six and nine). **Arc: zero mentions in the spec.**
  - **Refuses?** No: every vault gets a score, grade and verdict; vaults < $100K are only hidden on the dashboard.
  - **Distribution:** the paid API answers 402 over **x402** (credit tokens) and ships an MCP server: agent-facing.
- **⭐ MEASURED (T's priority): their published Morpho definition vs what a V2 redeem delivers.** A V2 vault redeems only
  from idle + its LIQUIDITY ADAPTER; market liquidity is reachable only by `forceDeallocate` (a separate call, a
  per-adapter penalty). Scan: 84 Ethereum V2 vaults > $1M (Morpho API) at block ~26105510: **12 have no liquidity
  adapter, 4 of them 0% idle**; Base: 0 of 9 without an adapter.
  - **Gauntlet WETH Prime `0x43fCd85E8D9D003D515f886891B7C742AC9f92da`** ($25.6M; Ethereum block 26105518, hash
    0x23c1e07e…b500; ethereum-rpc.publicnode.com + rpc.mevblocker.io AGREE; code masked-matches vault-v2 2026-08-13):
    totalAssets 9,494.573 WETH, idle 0, liquidity adapter unset, one MM adapter, 2 markets, penalty 0.001%.
    - **Ours, an ordinary redeem: 0 WETH = 0.00%.** Simulated (`eth_call`, state override giving a test address ≈10 WETH
      of shares at balanceOf slot 12; all four gates 0x0): withdraw 1 wei / 0.001 / 1 WETH → **REVERT `TransferReverted()`**
      on both endpoints. Control: + 2 WETH idle → 1 WETH OK, 3 WETH reverts. The revert is the empty idle, not the setup.
    - **Theirs, from their published formula:** idle + Σ min(vault position, market free liquidity), capped at TVL =
      **1,597.69 WETH = 16.83%** (literal whole-market reading: 3,308.00 WETH = 34.84%).
    - Force-deallocation route: 1,597.67 WETH net of penalty (16.83%).
    - **Morpho's own API agrees with both of OUR numbers:** `liquidity` 0; `forceDeallocatableLiquidity` 1,597.689 WETH.
  - **Sentora mWIN Main `0x7cBcfc4F64be199eDE6db1D916ddcdb69f666B57`** ($25.4M PYUSD, block 26105545, both agree; not
    simulated: the mechanism is the one Gauntlet proves): ordinary redeem = idle **2,531 PYUSD = 0.01%**; their formula
    **21.51%**; force route 21.29% net of a **1% penalty (≈54.7K PYUSD)**. Morpho API: `liquidity` 2,531.23,
    `forceDeallocatable` 5,470,671.79: equal to ours.
  - **What this shows, in their own terms:** their published Morpho definition yields a number an ordinary ERC-4626
    redeem cannot deliver on these vaults; it is the force-deallocatable figure. ⚠️ **It does NOT show their OUTPUT is
    wrong:** if they read Morpho's `liquidity` field they would publish 0 / 0.01%. Their output for these vaults was not
    read (no key). On Gauntlet the force route costs 0.001%, so the gap there is the ROUTE (an agent calling standard
    `withdraw` gets a revert); on Sentora it is also ≈54.7K PYUSD.
- **Signal**: the trust layer is occupied as RATINGS, multi-chain, monitored, agent-facing over x402 + MCP. The empty
  part is the checkable version.
- **Changed**: the standing thesis line (above, revised 2026-10-02) and the roadmap's promise paragraph ("asked by
  nobody" → asked, answered as unsigned numbers). Priorities unchanged; Stage 1 (DD Morpho V2) more urgent: if Webacy
  adds Arc, it arrives with distribution. **Next proof that would settle the output question:** their
  `pct_tvl_withdrawable` for Gauntlet WETH Prime (one browser view of the vault page, or one keyed API call), against
  0 measured.

## 2026-10-02 — ⭐ MEASURED: a zero-timelock allocator removed Galaxy USDC's redemption route (block 23403623)
- **Source**: our own chain reads (rpc.mainnet.arc.io + arc-mainnet.drpc.org, AGREE), prompted by Morpho's API reading
  Galaxy at 0 on both liquidity fields where its page showed $4.22M on 09-28.
- **Claim** (ours, now measured): the change between 09-28 and 09-30 was not the field; it was the vault's wiring.
- **Checked**:
  - Binary search on `liquidityAdapter()` by historical `eth_call`: block **23403622 = 0xeE00…7c2C** (set),
    **23403623 = 0x0** (unset), **2026-09-29 17:23:55Z**, block hash 0x91e13722…63ec.
  - That block's vault log: **`SetLiquidityAdapterAndData`** (topic0 0x9deb43d7…), sender **0x43e4…a537**, new adapter
    0x0, data empty; **tx 0x87283833…8383**, status success, sent DIRECTLY by that address (code size 0: an **EOA**);
    `isAllocator(0x43e4…a537)` true at 23403622; input decodes to `setLiquidityAdapterAndData(address,bytes)` (0x0, 0x).
  - VaultV2.sol @2026-08-13: `setLiquidityAdapterAndData` requires only `isAllocator[msg.sender]` (:628): **no timelock,
    not abdicable**. No notice was possible.
  - Effect, same reads: totalAssets 84,807,145.54; idle 0; the cirBTC market 99.99% lent, **free 20.54 USDC**. Redeemable
    by an ordinary redeem: **20.54 → 0**. ⚠️ The route was already nearly dry; what was removed is the ROUTE: market
    liquidity freed later cannot reach a Galaxy redeemer until an allocator sets an adapter again, and new deposits stay
    idle (the ~5.0M of 09-30 23:05Z became exit liquidity for whoever redeemed first; by 10-02 idle was 0).
  - Our series stands (field meaning unchanged): 8.84% (09-26, adapter set) → 5.30% (09-28, chain at block 23198843
    = 4,226,250.11 via the adapter) → **route removed 09-29 17:23:55Z** → 0.00012% (09-30 12:34Z, idle 102) → 5.57%
    (09-30 23:05Z, idle 5.0M) → 0 (10-02: idle 0, market 100.00% lent).
- **Signal**: on Morpho V2 the most consequential power over an exit is the one with NO delay: an allocator, here an EOA,
  rewiring the redemption route. Timelocks and abdications (what ratings score) do not cover it.
- **Changed**: recorded prominently in the roadmap as THE measured case for the exit-path re-check (piece 5's fresh
  liquidity-adapter read; DD's `compareExitPath`). Step 3 names `setLiquidityAdapterAndData` and `setIsAllocator` among
  `exitPowers` (T 10-02). Priorities unchanged.
