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

## 0. The one decision before everything

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Arc mainnet or Base — where the agent HOLDS USDC vs where it SPENDS it.** Options on record: A pure Arc; C Arc treasury + low-capped Base "shopping wallet" (provisional rec). New input 09-20: Circle's Facilitator page says Arc settlements are final vs Base reorg risk. | T | A dated decision line in PROGRESS.md naming the option and the reason; every row below inherits its chain(s) from it. | OPEN — provisional rec C. → memory `arc-vs-base-agent-shopping-decision.md`; PROGRESS.md BlockRun recon `### The one decision before any scoping`. |

## 1. The literal refactor — one source per lever, then the env-assert rows

Order matters: **refactor first**, then fill the mainnet rows, then let env-assert prove all four levers agree.
A migration that misses a duplicate passes the assert and verifies x402/DD against the wrong network's Gateway.

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Testnet literals live in many files.** MEASURED 2026-09-20 (`git grep -l`, `*.md` excluded): `rpc.testnet.arc.io` in **23** files (5 src+netlify / 16 scripts / 2 other); chain id `5042002` in **51** (12 / 25 / 14); testnet Gateway wallet `0x0077…19B9` in **13** (5 / 7 / 1). The 09-20 sketch's 23 / 15 / 1 was a narrower scope; the 23 agrees. | code | One source per lever (`ARC.rpc`, `ARC.chainId`, `GATEWAY.WALLET`, Gateway host) + a **grep-guard** that fails the build on a second copy in `src`/`netlify`; the scripts either import the source or are declared spike/diag. Scoped 09-16, held until row 0. | SCOPED, held. → PROGRESS.md `### env-assert duplication gap — OUTRANKS the copy half`. |
| **env-assert has NO mainnet chainId / rpcHost rows — BY DESIGN** (fail-closed: a full migration boots to UNKNOWN and REFUSES until both are added from a published source). gatewayWallet.mainnet (`0x7777…00eE`) and gatewayHost.mainnet are already present. | Circle → code | Circle's published Arc mainnet chain id + RPC host added to `_env-assert.mjs` with the source URL in the comment; `test:envassert` green; a deliberate partial flip still produces the SPLIT refusal. | OPEN — waits on the published values AND on the row above. → `netlify/functions/_env-assert.mjs` header. |
| **All four levers agree on boot, in the deployed environment.** | code | `gate:deployed` after the mainnet deploy shows the assert classifying MAINNET on all four, no SPLIT, no UNKNOWN. | OPEN — cannot run before the two rows above. |

## 2. Money — keys, funding, the revenue wallet

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Mainnet hot-wallet key for the agent SCAs** (today's key signs on testnet only; the 18 spike scripts that read the live prod cred are a separate exposure). | T | A new key minted for mainnet, never pasted into a script; the deployed env carries it; the testnet key is NOT the mainnet key (assert by address, not by string). | OPEN. → memory `spike-scripts-read-live-prod-credential.md`. |
| **Funding source — cannot be Arc.** Buy USDC + bridge (CCTP, stay on SLOW tier), or Gateway from Base. | T | The first mainnet USDC arrives in the agent SCA / Gateway balance by a route T ran; the tx hash and the route recorded. **T runs it — never auto-fund.** | OPEN. → memory `bridge-latency-slow-tier-measured.md`, `live-proof-fund-moving-user-runs.md`. |
| **Mainnet revenue wallet (DD payTo)** — a payTo whose whole history must be attributable. | T | A fresh address with zero prior history, set as `payTo` in the deployed env; its first inbound is a DD purchase. | OPEN. → memory `dd-revenue-wallet.md`. |
| **Circle API key** — only if the Facilitator Service is adopted for settlement. | T (after row 0) | Either "not adopted" recorded, or the key in the deployed env with the facilitator's settle proven to return the TX HASH on mainnet. | OPEN — depends on a decision not yet taken. → memory `x402-second-network-and-facilitator-findings.md`. |

## 3. Gateway on Arc mainnet

| Item | Owner | Proof it is settled | State |
|---|---|---|---|
| **Arc has a Gateway domain on mainnet.** Absent when measured 2026-08-24; Circle published it 2026-09-16 (domain 26, wallet `0x7777…00eE`). | Circle | The two curls from `docs/mainnet-list.md` re-run against the MAINNET Gateway API and the mainnet Gateway list, Arc PRESENT in both; **and** the daily `arc-gateway-watch` tick reports `ARC PRESENT` (it reported `ARC_ABSENT` at its last recorded proof, 08-26). | MEASURED 09-16 (published) — the re-check and the watch's flip NOT yet recorded. → PROGRESS.md `## Same-environment startup assert — 2026-09-16`; memory `arc-gateway-watch-first-tick-check.md`. |
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
| **x402 pay** (UB / Gateway plane) and **DD purchase** at the mainnet payTo | T runs · code | settle-gate passes on the real hash; the revenue wallet's FIRST inbound | OPEN |
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
