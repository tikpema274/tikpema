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
well-funded players (Circle's kits, ERC-8004, Surf-type data layers, Tempo). **The trust layer — verify before money
moves, and "I don't know ⇒ no" — is empty**, and every piece assumes it exists. Tikpema builds it. Directions that follow:

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
  liquidity) aimed at Earn Kit's hook. Decision is T's.

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
