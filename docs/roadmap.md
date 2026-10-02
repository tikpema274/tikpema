# Roadmap

Written 2026-10-01. Every session should start here: it says where Tikpema is going, what is next, and what each
step needs from T (a decision) versus from Claude (a build). `docs/direction-log.md` says why (the ecosystem
reading); `docs/mainnet-go-no-go.md` holds the mainnet detail; `PROGRESS.md` is the record of what happened.

## The promise

> **Before your agent puts money somewhere, Tikpema tells you whether you can get it back out — and refuses when it
> can't tell.**

This is the trust layer applied to the riskiest single moment, the **deposit**. It is narrow on purpose. Identity,
payments and data are being built by well-funded players (Circle's kits, ERC-8004, Surf, Tempo). The question
"can I exit?" IS asked, by ratings (Webacy publishes a "% of TVL withdrawable"), but answered as an unsigned number for
every vault, unknowns scored. *(Corrected 2026-10-02: this read "asked by nobody".)* The evidence that the ANSWER
matters: on Ethereum, Gauntlet WETH Prime's ordinary redeem delivers 0 (measured: a 1-wei withdraw reverts) while
Webacy's published Morpho formula gives 16.83% (direction log 2026-10-02); Earn Kit offered Galaxy USDC first with no
warnings while only 5.57% was redeemable (its idle cash: liquidity adapter unset, its market fully lent); Borrow
Kit lists a market with ~40 USDC free of 185M.

**What "done" means for the promise:** an agent on Arc mainnet is about to deposit into a vault Circle's kits offer.
Tikpema returns a signed verdict that states what can be redeemed now and who can change that. A vault it cannot
read is refused. The same verdict gates Tikpema's own vault mandate. The check is proven continuously, not only at
deploy. A new user understands all of this from one screen.

## Where we stand (2026-10-01)

| Built and proven | Built, not yet live or armed | Not built |
|---|---|---|
| DD service: signed verdicts (ERC-1271), sold at 0.06 USDC over x402, 3 real purchases | Vault mandate pieces 1–5 deployed **disarmed** (deposits, exit, monitoring all off) | DD profile for Morpho V2 vaults (refused today as unrecognised) |
| Caps, sealed fee quotes, per-step consent, acknowledge gate (forgery-proven); the upfront-fee copy fixes (live 6abe9d6d, 10-01) | | Exit liquidity as a reported DD fact |
| Send / swap / bridge / vault / escrow / checkout, each proven on chain | Mainnet §0 settled (pure Arc); §2 ack-gate row added | DD on Arc mainnet (chain registry has no 5042 entry) |
| Auth hole closed and proven live; failed reads refuse, never "no record" | | A between-deploys check of the ack gate |
| | | One coherent first-run experience |

## The five stages

Each stage lists its **goal**, what **exists**, what it **needs from T**, what it **needs from Claude**, and when it is
**done** (a proof, not a claim). Stages run roughly in order; 1 and 3 can overlap.

### Stage 1 — DD covers what agents are actually offered

- **Goal:** DD returns a verdict on Morpho V2 vaults (what Earn Kit lists), stating exit liquidity as a fact.
- **Exists:** DD engine and service; redemption semantics (6d04d13); recognition gate that refuses unknown vocabulary
  (4bc0d03); Morpho research and role getters (memory: morpho-vault-roles-verifiable-badge).
- **Decided (T, 2026-09-28, PROGRESS 0b1858b), not open:** DD TAKES Morpho V2. It signs the STRUCTURE and the exit-
  liquidity NUMBER (a past-block fact is a receipt, re-checkable by historical `eth_call`). Block-hash binding lands in
  the SAME DD-surface change (schema `onchain-analyze/0.3.0` → `0.4.0`, one refusal window). ⚠️ This was listed here as
  an open T decision on 10-01 (and Claude's 58486d7 was framed as a recommendation for it); corrected 10-02 so it is not
  decided twice.
- **Needs from T:** when that change deploys. Claude recommends: not before piece 5's exit has fired, because it
  changes the signed canon the mandate's check verifies (today `boundTo.blockHash: null`) and rotates ddTree.
- **Needs from Claude:**
  1. Recognise V2 via the factory's `isVaultV2`, and add an Arc mainnet (5042) entry to DD's chain registry.
  2. The power model: timelocks, abdications, current values, not mere presence (e.g. a zero-timelock allocator that
     can unset the liquidity adapter).
  3. Exit liquidity: redeemable now (idle + reachable adapter liquidity) vs total assets.
  4. Keep "unrecognised ⇒ refuse" true for every part the profile does not understand.
  5. Block-hash binding in the attestation canon (decided 09-28: the same change).
- **Cost:** a DD-surface change → ddTree rotates → one refusal window + a schema bump, planned per deploy.
- **Done when:** DD returns a signed verdict for Galaxy USDC that states its redeemable share and the allocator power
  behind it, matching an independent chain read; a vault outside the profile is still refused.

### Stage 2 — The verdict is in the money path

- **Goal:** the verdict gates real deposits, ours and others'.
- **Exists:** vault mandate pieces 1–5 deployed disarmed; the window-3 receipt carries `exitPath` + `check`; signing
  latency 1165–1368 ms (4 samples, not window data); **full-path sample 1: `wouldBeCheckAgeMs` 1447 ms (10-02 tick)**. Earn Kit's `onBeforeAuthorize` identified as the insertion point (09-28).
- **Needs from T:**
  - The freshness window value, once latency is measured (more than one sample).
  - Arming deposits (`MANDATE_DEPOSIT_ARMED` + `MANDATE_ARMED_FROM` together, own commit).
  - Arming exit (piece 5) and monitoring (Finding A: after piece 5).
  - The flat mandate fee; the two-state UI wording.
- **Needs from Claude:**
  1. A latency distribution from the ticks (the freshness window comes from it, not from one sample).
  2. Each arming as its own commit, with a live proof the user runs (memory: live-proof-fund-moving-user-runs).
  3. An Earn Kit integration example: `onBeforeAuthorize` calling DD, refusing on "unrecognised" and on findings.
- **Done when:** an armed mandate deposits only after a fresh DD check, and refuses (on chain, receipted) when a rule
  fires; an Earn Kit sample app refuses a deposit DD cannot clear.

### Stage 3 — Trust is proven continuously, not just at deploy

- **Goal:** the checks that guard money run between deploys and page when they cannot see.
- **Exists:** `gate:forgery` with PASS / FAIL / UNTESTED (43a199b), deploy-time only; `plan-path-watch` (valuation
  only); strong-read watch; the §2 go/no-go row; env measured deploy-fixed.
- **Needs from T:** paging destination and tolerance (which reds wake someone); whether ERC-8004 reputation should be
  exercised or stay declared (the gap may be deliberate: gameable).
- **Needs from Claude:**
  1. A scheduled forgery probe (folded into plan-path-watch, server-side, minting its own probe session), same three
     verdicts, paging on FAIL **or** UNTESTED.
  2. ✅ BUILT 10-02 (not yet run in a live deploy): `gate:forgery`'s red is deferred by `scripts/deferred-verdict.mjs`;
     gate:spec / deployloss / stage:ledger run regardless, and the chain exits with forgery's own code (test:deferredverdict).
  3. A scheduled DD self-check against a known vault set, so a silent regression in the verdict shows up between deploys.
- **Done when:** one PASS observed between two deploys, and a deliberately broken probe pages within one cadence.

### Stage 4 — Mainnet

- **Goal:** stages 1–3 running on Arc mainnet, with real but tiny money.
- **Exists:** `docs/mainnet-go-no-go.md` (§0 settled: pure Arc; 20 rows still OPEN); Gas Station supports Arc mainnet;
  the 5042 values are published.
- **Needs from T:** the mainnet hot-wallet key (minted fresh, never in a script); the funding route; a fresh DD revenue
  wallet; caps "start tiny"; the compliance decision (§5: deferred to exactly this point).
- **Needs from Claude:** the §1 literal refactor and env-assert rows; per-capability live proofs with real money (§7),
  each small and read from the chain; the 18 spike scripts that read the prod credential retired or isolated.
- **Done when:** every go/no-go row is SETTLED or explicitly accepted, and one deposit is checked, made and exited on
  mainnet, proven from the chain.

### Stage 5 — One coherent experience

- **Goal:** a new user understands the promise in one minute and can act on it.
- **Exists:** many honest components (the ack cards, VaultDisclosure, DdReportCard, the custody notices, the shared fee
  copy); conventions (amber-on-ink, 5-item nav). The app has grown capability by capability.
- **Needs from T:** the product shape: who the first user is (an agent builder integrating DD, or a person whose agent
  deposits), and what the first screen says.
- **Needs from Claude:** a first-run flow built around the promise, reusing the existing components rather than new
  copy; the open copy defects closed first (agent-parameters' "re-read on every request"); the panels audited against
  the structural rule (every money disclosure states what arrives and what leaves).
- **Done when:** a first-time user, unprompted, can say what Tikpema will do before their agent deposits and what
  happens when it can't tell.

## Not now (and what would bring each back)

| Not now | Comes back when |
|---|---|
| Lending markets / Borrow Kit profile | Stage 1's V2 profile proves the pattern; the drained cirBTC pool is its first case |
| General token / contract scanner | Never as breadth; only a specific profile with demand behind it |
| Risk-rating product | Stays a separate consumer of DD, as decided |
| B2B conditional payments | A target customer; then conditional release (ERC-8183, live for research) + counterparty screening |
| Compliance / AML | Stage 4 (go/no-go §5) |
| On/off-ramps (TikpemaPay); merging TikpemaPay into Tikpema | TikpemaPay is un-paused AND the exit has fired AND Morpho V2 is in DD; then as a DD **customer** (it calls the check before deposits), linked, not merged (direction log 2026-10-02) |
| Peer-to-peer agent communication | Nobody in our stack provides it; revisit only if the direction log shows it becoming real |

## How each session uses this

1. Read the stage in progress, and its **needs from T**: an open decision blocks the builds after it.
2. Build the next item in **needs from Claude** for that stage, red first, with its proof.
3. A finding that changes a stage goes in PROGRESS and, if it changes direction, in the direction log; then edit this
   file in the same commit.
4. Mark a stage **done** only with its stated proof, quoted with where it came from.

## Next, concretely (2026-10-01; corrected 2026-10-02)

1. ~~**T:** decide Morpho V2 in DD~~. **Already decided by T on 09-28** (Stage 1 above). Stage 1 is a build, not a wait.
2. ~~**T:** when to deploy the upfront-fee copy fixes~~. **Deployed** 10-01 (6abe9d6d, verified in bundle and server).
3. **Claude, unblocked now:** Stage 3 item 1 (the scheduled forgery probe; item 2 built 10-02) and
   collecting the latency distribution from the daily mandate ticks (Stage 2, item 1).
