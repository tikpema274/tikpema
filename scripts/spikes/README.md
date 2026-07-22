# `scripts/spikes/` — money-path spike evidence (archive)

Two trails live here. **The proof trail** is the original TOP-ROW verdict: swap CAN get an authoritative
Circle tx id via the **approve-first two-tx `createContractExecution` refactor** (the permit wall was a
no-allowance artifact). **The re-prove trail** is the evidence that shipped that refactor — every claim
run end-to-end before the commit.

Not prod code — **nothing here is imported by `netlify/` or `src/`**. Kept for reproducibility of money
claims, per the money-path-proof discipline: a claim about money is only as good as the run you can
repeat. Dead ends are kept too (bottom section) — the trail is honest, not curated.

All scripts read credentials from `process.env` (`CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `KIT_KEY`)
— no secrets are embedded. Run with `--env-file=.env` and `KIT_KEY` from the Netlify prod env.

## The proof trail

| Script | What it established | Moves money? |
|---|---|---|
| `spike-phase0.mjs` | provision SCA + `estimateContractExecutionFee` (rail live on Arc) + `estimateSwap` exposes no calldata | no |
| `spike-phase0c.mjs` | real App Kit pipeline (execute-neutered) hits the permit wall — later shown to be a **no-allowance artifact** | no |
| `spike-find-swap-spender.mjs` | derives the **ground-truth swap adapter** `0xbbd70b01…` from a real fill's on-chain USDC Approval | no |
| **`spike-phase0e-approve.mjs`** | **THE PROOF** — one `approve(adapter, 1 USDC)`, then swap.execute builds submittable `{to,data}` → TOP ROW | **YES — money-moving** |

### ⚠️ `spike-phase0e-approve.mjs` is the one money-moving script
Sends exactly ONE `approve(0xbbd70b01…, 1000000)` on USDC, gated behind `--confirm` (a bare run is a
dry run). Needs a **funded throwaway SCA** (`WALLET_ADDRESS`). Hardcodes only the public adapter
address. The follow-on swap.execute rebuild is capture-and-abort (execute neutered). Do not run
without reading its header.

## Re-prove trail (agentSwap robust-path refactor) — COMPLETE, all steps proven

The evidence behind shipping the B1 execution path: inline-confirm for DCA, the id-reconcile net that
replaces the log-scan, the on-chain deadline backstop, and the Design-2 standing allowance. Every claim
below was run; the ones that move money are marked and were run deliberately by the wallet owner.

**Reading order = the order they were proven.** Each step's runner is self-documenting — its header
states what it proves, what it mocks, what it cannot prove, and its stop conditions.

| Step | Script | What it established | Moves money? |
|---|---|---|---|
| 1 | `spike-sync-budget.mjs` | manual swap ~3.2s vs the **10s Netlify sync ceiling**, but ~63s worst case when a throttled approve fires — and exact-amount approves fire on EVERY manual swap → **this measurement is why Design-2 exists** | no — read-only |
| — | `spike-B1-direct-calldata.mjs` | the B1 recipe: `createSwap` 200 (KIT_KEY **verbatim**) → viem-adapter `getCallData()` → `{to,data}` with `to == 0xbbd70b01…` | no |
| 2 | `spike-step2-money-prove.mjs` | hardened `agentSwap` moved USDC→EURC on-chain **twice**, confirm-gated (net USDC −2 / EURC +1.488895). Found + fixed a throttle gap in step A's allowance read | **YES** |
| 3 | `spike-step3-guardrails.mjs` | A: over-cap / paused / day-ceiling all refuse **before** `agentSwap`, with a BASELINE control so the rejects mean something. B: the day-ceiling ledger fires **exactly once, post-confirm** | **YES** (`--confirm`) |
| 4 | `spike-step4-phase0-deadline-ttl.mjs` | quote deadline TTL = **`now + 600s` exactly** (±0.2s over 3 quotes) → sized step-4 Part B as a one-run test | no — quote only |
| 4A | `spike-step4a-deadline-guard.mjs` | the pre-submit deadline guard refuses an expired quote **before any Circle tx exists**; ledger untouched; BASELINE control reached the submit boundary | no — cannot submit |
| 4B | `spike-step4b-deadline-revert.mjs` | the **ESTIMATION-REJECTED** class is real: Circle issued an id then marked it FAILED with no hash. Safety chain held (no funds, no ledger) — but the contract's own revert was NOT exercised | **YES** (gas only) |
| 4C | `spike-step4c-deadline-differential.mjs` | **the contract itself enforces the deadline**: identical calldata succeeds pre-deadline @52942858, reverts post @52943700 with `DeadlineExpired()` (`0x1ab7da6b`) — proven by differential, no broadcast needed | no — `eth_call` only |
| 5A | `spike-step5a-reconcile-net.mjs` | 33/33 on the id-reconcile net: entry parks with its `circleId` ledgering nothing, COMPLETE advances all three ledgers **exactly once by call count**, the inline/reconcile XOR holds both ways, every safety edge | no — all ids fake |
| 5B | `spike-step5b-real-fill.mjs` | one real fill through the net; Circle's **actual** `getTransaction` responses matched the scripted model | **YES** |
| D2-A | `spike-design2a-standing-allowance.mjs` | manual approves `capBase` (25000000), DCA approves exact (1000000) — **the control proving the `!confirm` gate branches** — EURC priced to 21925778 (≈25 USD, not 25 EURC ≈28.5), never max-uint | no — tripwire |
| D2-B | `spike-design2b-standing-allowance-onchain.mjs` | **approve once, then skip**: allowance `0 → 25 → 24 → 23 → 22`, exactly **1 approve across 3 swaps** (exact-amount would fire 3), never resets, never over cap | **YES** |

### ⚠️ The money-moving runners
`spike-step2`, `step3 --confirm`, `step4b --confirm`, `step5b --confirm`, `design2b --confirm` move real
USDC on a **funded throwaway SCA** (`WALLET_ADDRESS`). All are gated behind `--confirm` (a bare run is a
dry run or read-only), all read the chain back through `scripts/dd/` for an **independent** witness, and
none asserts success from its own flag. `design2b` additionally **refuses to start unless the allowance
is 0**, because its first claim is unobservable on a pre-approved wallet.

### Two runner bugs worth remembering (both fixed here, both the same family)
- **`step4b`** turned an Arc throttle (`"request limit reached"`) into the *finding* "bare revert" — a
  TRANSPORT failure rendered as evidence about a contract. Fixed with the production `withRetry` **and**
  a closed outcome set (`success | revert | rpc-error | probe-failed`); the closed set matters more.
- **`step5a`** had a ledger spy that captured a record object which `reset()` then rebound, so every
  call count read 0 — which made every `=== 0` "no ledger advanced" assertion pass **vacuously**. Fixed
  with a spy-attachment self-check and a never-reset total. The product code was never at fault.

See the memory note `absence-must-never-read-as-safe` — an absence must never occupy a result slot.

## Superseded / dead-ends (kept for the honest trail, NOT proof)
| Script | Why it's here |
|---|---|
| `spike-phase0b.mjs` | external SDK-reconstruction of `createSwap` — **failed on internal wiring**, inconclusive; the real pipeline (0c/0e) was the right approach |
| `spike-phase0d-discover.mjs` | permit-typed-data grab that produced an **ambiguous 7-address list** (caught proxy traps + the BridgingKit) — **superseded** by `spike-find-swap-spender.mjs`, which used a real on-chain Approval instead of inference |

See the memory notes `money-path-spike-verdict` and `dca-confirm-robust-path-design-brief` for the
full verdict and the refactor recipe these evidence.
