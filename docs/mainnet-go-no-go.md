# Mainnet go/no-go — the checklist

**This is an INDEX OF DECISIONS, not a build plan.** Each row names one item, WHO settles it (T / Circle / code),
what would COUNT AS PROOF that it is settled, and its state today. Nothing here starts any of the work; the
detail lives at the pointers (PROGRESS.md headings — grep for them; memory notes by file name). Written
2026-09-20 from `docs/mainnet-list.md` and the 2026-09-20 sketch. Update rows in place; never silently delete.

**The rule:** GO requires every row in sections 0–7 to read **SETTLED** with its proof recorded. A row whose proof
is "T says so" is not settled. Section 8 rows are preconditions on the TESTNET record and do not by themselves
block, but a GO with one open is a GO taken knowingly.

Owner legend — **T**: a decision or an action only T can take (keys, money, sign-off). **Circle**: a fact only
Circle publishes; we can only measure it. **code**: a change in this repo with its own gate/suite/live proof.

States — `OPEN` · `SCOPED` (written, not built) · `MEASURED <date>` (a fact read, not a decision) · `SETTLED`.

---

## ⛔ Read this first — what §0 blocks, and what does not wait for it (added 2026-09-20)

**§0 does NOT block everything, but it blocks most of it.** Of the 22 rows in §0–7: **14 wait on §0** (§1 rows 2–3,
§2 rows 2–4, all of §3, §4 row 2, all six of §7) — each names a chain-specific published value, a chain-specific
funding route, or a real-money proof on the chosen chain, and under option C (Arc treasury + Base shopping wallet)
§0 does not merely gate them, it **adds** rows (a Base wallet, a Base cap, a Base proof). **4 rows can be settled
today on testnet with no reference to §0:** §1 row 1 (the literal refactor + grep-guard), §5 row 2 (KYC stays out),
§6 row 1 (the REVERSALS review), §6 row 2 (the 202 four-step). **3 rows split:** §2 row 1's hygiene half (the spike
scripts reading the prod cred) vs its mainnet-key half; §4 row 1's UNSET-caps half (swap, vault-deposit — settable
on testnet prod now) vs its mainnet values; §5 row 1's *which flows are screened* half vs the vendor, whose coverage
is chain-dependent.

**Update 2026-09-20 (evening):** **§0 is SETTLED — A, pure Arc** (Arc mainnet live: chain id 5042, `rpc.mainnet.arc.io`, Gateway domain 26 on mainnet, all verified read-only). The 14 rows §0 gated are now unblocked and Arc-specific; none is added. §1 row 1 is SETTLED (Deploy 14) and §2 row 1 is SETTLED (Deploy 15); the floor is in. §1 row 2's inputs are now published (READY TO FILL). The testnet METHOD for the §7 x402/DD proofs is recorded on that row (two purchases proven on the post-A+B tree today); the mainnet rows themselves still wait on §0.

**The order that follows (as written this morning):** §1 row 1 is the floor. It is chain-agnostic, it is required under EVERY answer to §0
(a Base shopping wallet is a second chain table, which is impossible while the first is spread over 51 files), and
it is the row that makes §0's answer cheap to execute once taken. It is also bigger than the sketch made it look —
see the sequencing note under §1. Then §6 and the settle-able halves, in any order. Then §0. Everything else after.

## 0. The one decision before everything

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Arc mainnet or Base — where the agent HOLDS USDC vs where it SPENDS it.** Options on record: A pure Arc; C Arc treasury + low-capped Base "shopping wallet" (provisional rec). New input 09-20: Circle's Facilitator page says Arc settlements are final vs Base reorg risk. | T | A dated decision line in PROGRESS.md naming the option and the reason; every row below inherits its chain(s) from it. | **SETTLED 2026-09-20 — A, PURE ARC** (T). Inputs verified read-only the same day: Arc mainnet is live — chain id **5042** (`eth_chainId` → `0x13b2` from `https://rpc.mainnet.arc.io` and dRPC, unauthenticated), explorer `explorer.arc.io`, USDC native `0x3600…0000`, Gateway on Arc mainnet domain 26 (wallet `0x77777777Dcc4…00eE`, minter `0x2222222d…C205`) per docs.arc.io/arc/references/contract-addresses; the 09-19 census counted 325 x402 offers / 47 sellers on eip155:5042, which removed the 'marketplace is Base-centric' reason for C. Consequence: the 14 gated rows are now Arc-specific and none is added. ⚠️ docs.arc.io/arc/references/rpc-endpoints still says 'during the private mainnet phase, these endpoints are permissioned' and 'request gas USDC through your Circle point of contact' — reads work today; writes and first gas are the first thing §2 will meet. Was: OPEN, provisional rec C → memory `arc-vs-base-agent-shopping-decision.md`. |

## 1. The literal refactor — one source per lever, then the env-assert rows

Order matters: **refactor first**, then fill the mainnet rows, then let env-assert prove all four levers agree.
A migration that misses a duplicate passes the assert and verifies x402/DD against the wrong network's Gateway.

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Testnet literals live in many files.** MEASURED 2026-09-20 (`git grep -l`, `*.md` excluded): `rpc.testnet.arc.io` in **23** files (5 src+netlify / 16 scripts / 2 other); chain id `5042002` in **51** (12 / 25 / 14); testnet Gateway wallet `0x0077…19B9` in **13** (5 / 7 / 1). The 09-20 sketch's 23 / 15 / 1 was a narrower scope; the 23 agrees. | code | One source per lever (`ARC.rpc`, `ARC.chainId`, `GATEWAY.WALLET`, Gateway host) + a **grep-guard** that fails the build on a second copy in `src`/`netlify`; the scripts either import the source or are declared spike/diag. Scoped 09-16, held until row 0. | **SETTLED 2026-09-20** — phase A `8bd4821` (Deploy 14) + phase B `643943a` (Deploy 14): `verify-chain-literals.mjs` in test:all at MODE=refuse, PHASE_B empty, C1–C5 proven by mutation (`verify-chain-literals-controls.mjs`); one source per package (`_arc.mjs`+`_gateway.mjs` / `src/config/chain.ts` / `shared/dd/chains.mjs`) + the env-assert table; `assertPackagesAgree` refuses at boot (proven by spawning the real module); `PUBLISHED_OFFER` in `shared/x402/published.mjs`, on the DD surface by decision. Live: ddTree 596bcd84 → 349e755d, window 224 s. Was: SCOPED, held → PROGRESS.md `### env-assert duplication gap`. |
| **env-assert has NO mainnet chainId / rpcHost rows — BY DESIGN** (fail-closed: a full migration boots to UNKNOWN and REFUSES until both are added from a published source). gatewayWallet.mainnet (`0x7777…00eE`) and gatewayHost.mainnet are already present. | Circle → code | Circle's published Arc mainnet chain id + RPC host added to `_env-assert.mjs` with the source URL in the comment; `test:envassert` green; a deliberate partial flip still produces the SPLIT refusal. | **READY TO FILL** (2026-09-20): both values are now PUBLISHED — chain id `5042`, RPC host `rpc.mainnet.arc.io` (docs.arc.io/arc/references/rpc-endpoints, connect-to-arc), and the row above is SETTLED. The edit is one DD-surface deploy (`_env-assert.mjs` is hashed) and must cite the page. Not done. → `netlify/functions/_env-assert.mjs` header. |
| **All four levers agree on boot, in the deployed environment.** | code | `gate:deployed` after the mainnet deploy shows the assert classifying MAINNET on all four, no SPLIT, no UNKNOWN. | OPEN — cannot run before the two rows above. |

### Sequencing note on §1 (added 2026-09-20 — what 23 / 51 / 13 implies)

**The 51 are not 51 levers.** Read file by file, the chain-id hits split four ways, and only the first is refactor work:
1. **Sources that ARE a lever today — three of them, for the same chain**: `netlify/functions/_arc.mjs` (server),
   `src/config/chain.ts` (client bundle), `shared/dd/chains.mjs` (the DD engine, which must stay importable WITHOUT
   `netlify/functions` — see the DD-core extraction design). So "one source per lever" means **one per PACKAGE**
   (app-server, app-client, DD-core), not one per repo — and a cross-check that the three agree, which env-assert
   does not do today (it reads ONE copy per lever). The Gateway wallet has ONE source (`_gateway.mjs`) but is
   re-literalled in `_dd-x402`, `_x402-confirm`, `x402-quote` — those are the true duplicates.
2. **Server/client files that re-literal a value instead of importing it**: `_dd-x402`, `_swap-confirm`,
   `_x402-vanilla`, `x402-quote`, `x402-vanilla-seller`, `dd-identity`, `built.mjs`, `dd-analyze`,
   `shared/onchain-analyze/endpoints.mjs`, `src/config/contracts.ts`, `site/index.html`. Refactor targets.
3. **Suites and fixtures that PIN the value** (~25 `scripts/verify-*`, `scripts/dd/_mock-chain.mjs`,
   `shared/dd-canary/fixtures.mjs`, `src/dev/dd-card-fixtures.ts`): a test that asserts `5042002` is doing its job;
   after the refactor each either imports the source (and so tests nothing about the value) or stays a literal by
   design as the CONTROL — the grep-guard must allowlist those explicitly, or it is either vacuous or red forever.
4. **Records that MUST NOT change**: `agent-metadata/*.json` (registered ERC-8004 identities — `unified.json` is
   FROZEN and self-referential; the chain id there is a fact about where the identity LIVES, and mainnet is a NEW
   registration, not an edit), `evidence/`, the x402 census harvest. Allowlisted as records, never refactored.

**⚠️ THE CONSTRAINT THE SKETCH MISSED — the DD surface.** `_arc.mjs`, `_gateway.mjs`, `_env-assert.mjs`, `_dd-x402.mjs`,
`dd-analyze.mjs`, all of `shared/dd/` and `shared/onchain-analyze/` are in `DD_SURFACE_DIRS/FILES`. **ddTree is a
CONTENT hash: any edit to any of them — a comment included — rotates it, and every deploy carrying a rotation has
opened a deposit refusal window** (four observed-banner windows 09-16→09-17). The server-side half of §1 therefore
cannot be sprinkled across deploys for free: each deploy that touches the surface is one window.

**Can §1 be done incrementally? Yes — but split by SURFACE, not by lever.** "One lever at a time, each with its
grep-guard" would put `_arc.mjs`/`_gateway.mjs`/`_env-assert.mjs` in every one of four deploys = four windows for
one refactor. The incremental cut that costs one window:
- **Increment A (no window, any number of deploys):** the client source (`src/config/chain.ts`, `contracts.ts`),
  `site/index.html`, `built.mjs`, the ~25 suites and fixtures re-pointed to import their source, the scripts either
  importing it or moved under `scripts/spikes/` (diag, allowlisted) — and the **grep-guard itself, landed FIRST in
  warn-only** so its allowlist is measured against the tree before it can refuse a build. None of these files are on
  the DD surface; `test:all` + `gate:deployed` prove each step.
- **Increment B (exactly ONE window, one deploy):** every DD-surface file at once — `_arc.mjs` and `_gateway.mjs`
  become the only server literals, `_dd-x402`/`_x402-confirm`/`x402-quote`/`dd-analyze`/`shared/onchain-analyze`
  import them, `shared/dd/chains.mjs` keeps its own table (DD-core) and env-assert gains the **cross-package
  agreement check**; the grep-guard flips from warn to refuse in the same deploy. Predicted DD-dirty before commit
  (the scripted DD-surface check), the window captured as usual.
- **What cannot be split at all:** the env-assert mainnet rows (§1 row 2) and the flip itself — those are one
  change by construction, and they are not §1 row 1.

**What is true about the codebase when §1 row 1 reads SETTLED:**
- `git grep -lw 5042002` / the RPC host / the Gateway wallet returns **exactly** the source per package
  (`_arc.mjs` + `_gateway.mjs`, `src/config/chain.ts`, `shared/dd/chains.mjs`), the env-assert table, the allowlisted
  control suites, and the allowlisted records — and **nothing else**. The grep-guard enforces that list in `test:all`
  with a control (a file that MUST contain the literal, so the guard is proven non-vacuous) and refuses on any other
  hit, including in `scripts/` outside `spikes/`.
- env-assert reads each lever from its package source and **refuses the boot when the packages disagree**, not only
  when one lever's environment disagrees with another's.
- A mainnet flip is then a diff of **three source files + the env-assert rows**, reviewable in one screen, and a flip
  that misses a package is refused at boot rather than discovered as x402/DD verifying against the wrong Gateway.
- The count row above re-measures to the allowlist size and no more — the number, not "fewer", is the proof.

## 2. Money — keys, funding, the revenue wallet

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **No public route can spend the agent's money.** FOUND 2026-09-20 on prod: `x402-pay.mjs` — an unauthenticated HTTP wrapper around `payX402` that paid ANY posted seller from the delegate's Gateway balance, exempt from the budget ceiling by name, bounded only by the per-call backstop. | code | The function removed; `verify-buyer-not-public.mjs` in `test:all` allowlists every importer of `payX402` with its guard named and asserts no HTTP function calls it. | **SETTLED 2026-09-20** — Deploy 15 (`ff5b313`, 17:26Z): `POST /.netlify/functions/x402-pay` and `/api/x402-pay` → 404 (a GET returns the SPA catch-all 200 HTML and proves nothing — the POST 404 does); live ~81 days from 2026-06-30, unauthenticated from its first commit; delegate Gateway balance unchanged 08-29 → 09-20 (no outside settle in 22 days), ≈0.0022 USDC unattributable 07-07 → 08-29. The CLASS remains a §7 question: audit every function that moves money for a session + pause check before mainnet. |
| **Mainnet hot-wallet key for the agent SCAs** (today's key signs on testnet only; the 18 spike scripts that read the live prod cred are a separate exposure). | T | A new key minted for mainnet, never pasted into a script; the deployed env carries it; the testnet key is NOT the mainnet key (assert by address, not by string). | OPEN. → memory `spike-scripts-read-live-prod-credential.md`. |
| **Funding source — cannot be Arc.** Buy USDC + bridge (CCTP, stay on SLOW tier), or Gateway from Base. ⚠️ 2026-09-20: docs.arc.io says first gas USDC on mainnet is requested 'through your Circle point of contact' during the private phase — the Circle contact may be the funding step, not a bridge. | T | The first mainnet USDC arrives in the agent SCA / Gateway balance by a route T ran; the tx hash and the route recorded. **T runs it — never auto-fund.** | OPEN. → memory `bridge-latency-slow-tier-measured.md`, `live-proof-fund-moving-user-runs.md`. |
| **Mainnet revenue wallet (DD payTo)** — a payTo whose whole history must be attributable. | T | A fresh address with zero prior history, set as `payTo` in the deployed env; its first inbound is a DD purchase. | OPEN. → memory `dd-revenue-wallet.md`. |
| **Circle API key** — only if the Facilitator Service is adopted for settlement. | T (after row 0) | Either "not adopted" recorded, or the key in the deployed env with the facilitator's settle proven to return the TX HASH on mainnet. | OPEN — depends on a decision not yet taken. → memory `x402-second-network-and-facilitator-findings.md`. |

## 3. Gateway on Arc mainnet

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Arc has a Gateway domain on mainnet.** Absent when measured 2026-08-24; Circle published it 2026-09-16 (domain 26, wallet `0x7777…00eE`). | Circle | The two curls from `docs/mainnet-list.md` re-run against the MAINNET Gateway API and the mainnet Gateway list, Arc PRESENT in both; **and** the daily `arc-gateway-watch` tick reports `ARC PRESENT` (it reported `ARC_ABSENT` at its last recorded proof, 08-26). | MEASURED 2026-09-20 from docs.arc.io/arc/references/contract-addresses (Gateway mainnet on Arc: domain 26, wallet `0x7777…00eE`, minter `0x2222…C205`) — the two curls against the mainnet Gateway API and the `arc-gateway-watch` flip to ARC PRESENT are still NOT recorded; until they are, this is a docs read, not a service read. → PROGRESS.md `## Same-environment startup assert — 2026-09-16`; memory `arc-gateway-watch-first-tick-check.md`. |
| **Unified Balance on mainnet**: deposit, spend and the EXIT path work with real USDC. | code (T runs) | One small deposit, one spend, one withdrawal, each read from the chain (UB exit is proven on testnet, unattended). | OPEN — testnet proven, mainnet unrun. → memory `ub-exit-shipped-and-live.md`, `unified-balance-capability.md`. |

## 4. Caps — start tiny, from the deployed env

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Every cap set in the mainnet env, tiny** (`AGENT_SEND_CAP_USDC`, `AGENT_MAX_SPEND_USDC`, `AGENT_BRIDGE_CAP_USDC`, `PERIOD_CEILING_USDC`, and the two that are UNSET on testnet prod today — swap and vault-deposit — which fall to CODE defaults). | T sets · code asserts | `netlify env:get <VAR> --context production` per variable (never `env:list`), every value recorded in PROGRESS.md at the go; no cap governed by a code default on mainnet. | OPEN. → memory `caps-from-deployed-env-not-code-defaults.md`. |
| **The kill switch and the ceiling are watched on mainnet.** | code | `strong-read-watch` (*/15) and `dd-canary` re-pointed and each seen posting to Discord from the mainnet deploy (delivery, not just `delivered:true`). | OPEN. → memory `strong-read-watch-monitor.md`. |

## 5. Compliance — deferred to exactly this point

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Wallet screening / AML on the app's own money path.** Today: none built, manual payout screening only; the DD OFAC screen exists as a DD OUTPUT (deterministic, `complete:false` is NOT a clearance), not as an app gate. | T decides scope · code | A written decision: which flows are screened (send? checkout payTo? DD payTo?), by which vendor or by the in-repo OFAC list, and what a `complete:false` does to the money path (must REFUSE, never read as clear). Then the gate exists with a suite. | OPEN — no decision. → memory `compliance-not-built-deferred-mainnet.md` (holds the Arc vendor directory), `dd-ofac-sanctions-screen.md`. |
| **Identity/KYC stays OUT** — the architecture sidesteps it (passkeys, agent wallets). | T | A one-line reaffirmation at the go, or a scoped decision if mainnet changes the answer. | OPEN — reaffirm. |

## 6. Two items where mainnet may arrive before their scheduled review

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **`REVERSALS_ARMED = false`** — a terminal-FAILED send stays charged against the day ceiling until UTC midnight. Review scheduled 2026-11-19. | T | Either the review pulled forward (arm if `observed:*` is non-zero, retire if zero) or "ship mainnet with it false, accepted" recorded. | OPEN — `netlify/functions/budget-sweep.mjs:120`. → `docs/mainnet-list.md` row 1. |
| **A 202 send never resolves to a transaction hash** — the sweep discards the `txHash` Circle returns. Four-step scope written. | code | The four steps built with their suite, or "accepted for mainnet" recorded with the consequence named (a buyer's 202 checkout is `submitted`, never `paid`, until a hash is posted). | SCOPED, not built. → PROGRESS.md `## 2026-09-18 — A 202 SEND NEVER RESOLVES TO A HASH`, "FOUR-STEP SCOPE". |

## 7. Live proofs with real money — small, from the chain, per capability

Each is **T runs it**, one small amount, verified READ-ONLY from the chain (block, emitter-filtered Transfer,
balances before/after) and recorded in PROGRESS.md. A scope report is not a deploy report; a deploy report is
not a money-path proof.

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| Agent **send** (SCA → address) | T runs · code | tx hash, status 0x1, exact amount, no USDC to gas (paymaster) | OPEN |
| **Bridge** (CCTP, upfront fees, SLOW) | T runs · code | burn + mint hashes, fee ≤ maxFee ceiling | OPEN |
| **Swap** | T runs · code | authoritative Circle id → getTransaction → hash | OPEN |
| **x402 pay** (UB / Gateway plane) and **DD purchase** at the mainnet payTo | T runs · code | settle-gate passes on the real hash; the revenue wallet's FIRST inbound | OPEN on mainnet. **Testnet method proven 2026-09-20 on the post-A+B tree** (the exact procedure to repeat): x402-quote — `probe-settlement-batch.mjs --runs 1 --confirm`, handle c9515652, payTo `availableBalance` 14,000 → 15,000, 446.9 s; DD — `probe-dd-purchase.mjs --url <prod fn> --confirm`, handle 2234a767, revenue wallet 120,000 → 180,000, settle-gate charged, served == frozen bytes, ERC-1271 valid on chain vs `ownerOf(851891)`, 260.7 s. ⛔ `probe-settlement.mjs --confirm` is retired (watched `balanceOf`). Watch `availableBalance` (0x3ccb64ae), never `balanceOf`. |
| **Checkout** — one order, one payment, replay refused, cancel | T runs · code | the 09-19 testnet proof repeated once on mainnet (binding, claim, refusal) | OPEN |
| **Monitors re-pointed** (`strong-read-watch`, `dd-canary`, `arc-gateway-watch`) | code | each seen posting from the mainnet deploy; `gate:watch` green | OPEN |

## 8. Preconditions on the TESTNET record (not blocking by themselves)

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Checkout v1 proven on testnet** | — | two payments, replay ×2, predates, cancel — all recorded | SETTLED 2026-09-19/20 |
| **Checkout late-note path** (a payment landing after a cancel → 409 + `late:` note) | T (whether to stage it) | one staged late payment, the note read back | OPEN — unexercised |
| **Multichain treasury live loop** (Deploy 9 on prod) | T runs | one PROPOSED move confirmed and read from the chain | OPEN — unproven |
| **app-kit upgrade HELD** (ERC-1271 has two fail-open edges invisible to `gate:deployed`) | code | either the edges closed with a suite, or "held through mainnet" recorded | HELD. → memory `app-kit-upgrade-held.md` |

---

*Resolved rows move to the bottom of their section with the date and the proof; the item text stays so the
list is never re-derived from scratch.*
