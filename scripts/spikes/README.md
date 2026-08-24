# `scripts/spikes/` — money-path spike evidence (archive)

Two trails live here. **The proof trail** is the original TOP-ROW verdict: swap CAN get an authoritative
Circle tx id via the **approve-first two-tx `createContractExecution` refactor** (the permit wall was a
no-allowance artifact). **The re-prove trail** is the evidence that shipped that refactor — every claim
run end-to-end before the commit.

Not prod code — **nothing here is imported by `netlify/` or `src/`**. Kept for reproducibility of money
claims, per the money-path-proof discipline: a claim about money is only as good as the run you can
repeat. Dead ends are kept too (bottom section) — the trail is honest, not curated.

All scripts read credentials from `process.env` (`CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, `KIT_KEY`)
— no secrets are embedded. `CIRCLE_*` come from `.env`; run with `--env-file=.env`.

## 🚨 KIT_KEY IS SUPPLIED PER-RUN — NEVER SOURCED FROM NETLIFY PRODUCTION
Until 2026-08-16 every header here told you to read the key back out of the **production Netlify env**.
That made **18 one-shot evidence scripts standing consumers of a live production credential** — and
because Netlify holds the only readable copy (no `.env` entry; Circle's console does not re-display a
kit key), that dependency tree, not the `is_secret` flag, was the actual exposure.

⭐ The evidence stays; the credential source changes. Supply the key for one run, from a key you hold:

```sh
read -rs KIT_KEY && export KIT_KEY     # paste at the prompt — nothing echoes
node --env-file=.env scripts/spikes/<script>.mjs
unset KIT_KEY
```

⚠️ **Not `KIT_KEY=… node script.mjs`** — that lands in shell history *and* in argv, and on Linux
`/proc/<pid>/cmdline` is world-readable. ⚠️ **Not a file on disk either**: a named env file holding a
prod key is just `.env`'s problem one level down, which is how the `SESSION_SECRET` divergence went
unnoticed. Keys are issued free (no KYC) at <https://console.circle.com/api-keys>.

`scripts/_kit-key.mjs` enforces this — it refuses a missing, `"No value set"`-contaminated, prefix-stripped,
or malformed key, reports shape only (never the value), and reaches for nothing itself.
Covered by `node scripts/verify-kit-key-guard.mjs` (31 checks).

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

## Step-8 trail (budget reversal — phantom day-ceiling charges) — backs work that is LIVE

⚠️ **These four were missing from this index until 2026-08-16** while the code they evidence was
already shipped (`676768f`) and running. An evidence index that omits entries is the
absence-reads-as-safe failure aimed at the index itself: a reader concludes these spikes are not
provenance, and the live reversal path silently loses its recorded proof. Added here for that reason.

Every one of these reverses budget, and **reversal is the only operation in `_budget.mjs` that can
WIDEN a cap** — so every failure mode is fail-OPEN. That shapes the assertions: each refusal is
asserted twice (return value *and* a ledger **re-read**), because a bug could report "refused" while
having already decremented. All four run the step-5A instrumentation self-check first — an absence
assertion is vacuous if the store under test isn't the one being written.

| Part | Script | What it established | Moves money? |
|---|---|---|---|
| 8A | `spike-step8a-reversal-primitive.mjs` | `reverseAgentSpend` mock-proven against an injected in-memory store — every refusal asserted against a ledger re-read, not its own return value | no — zero network |
| 8B | `spike-step8b-sweeper.mjs` | the budget **sweeper**: almost entirely absence assertions ("it did NOT reverse"), each against a `daySpend` re-read rather than the sweeper's own tally | no — zero network |
| 8C | `spike-step8c-verifier-reversal.mjs` | the **verifier** pairing: receipt→`failed` + day-ceiling reversed from one observed revert. Two fail-opens pinned — a FAILED LOOKUP reverses nothing and raises `needsAttention`; the reversal lands on the **charge's** day, never the verifier's run-day. ⚠️ Scope stated honestly: this path does not roll back `spentAmount` (that field is DCA-only) | no — zero network |
| 8D | `spike-step8d-forced-failure.mjs` | the **BACKSTOP** against a REAL Circle failure — the model-gap check: does an estimation-rejected swap actually report a state in `TERMINAL_FAILED`? If not, the backstop reverses nothing and the phantom stands. Raw `state`/`errorReason`/`txHash` are printed **before any assertion**, so the classification is the reader's to check | **YES** (`--confirm`, ~12 min) |

⭐ Why the backstop and not the verifier carries this: the verifier reverses only on `reason:"reverted"`,
which needs a broadcast tx whose receipt reads reverted — an estimation-rejected swap is **never
broadcast**, so the verifier settles `unconfirmed` and never reaches its reversal branch. The one
failure shape actually observed therefore lands on the backstop, which is why the backstop is the
primary handler. See the memory note `budget-reversal-reconcile-design-brief`.

## x402 vanilla trail (EIP-3009 direct settlement) — backs the `bytes`-overload switch

`x402-vanilla-seller` settled through the ECDSA-only `receiveWithAuthorization(...,uint8,bytes32,bytes32)`
overload, behind a guard requiring **exactly 65 bytes** — so no contract (ERC-1271) payer could settle,
and the guard refused them one function *before* the overload mattered. Both were changed together;
this spike is the evidence that the swap is safe for the EOAs already using it.

| Step | Script | What it established | Moves money? |
|---|---|---|---|
| A | `spike-vanilla-bytes-encoding.mjs` | **PHASE A (free):** Circle's SDK does **no** ABI encoding — zero `abiFunctionSignature`, no coder, just axios; it encodes **server-side**, so there is no local calldata to inspect. `estimateContractExecutionFee` answered it as an A/B on one throwaway zero-balance key: a real signature dies on the empty balance (*past* signature validation), a corrupted one dies *at* it. ⭐ The stop condition was **identical** outcomes — a mis-encoded `bytes` makes signature validity invisible, so "both errored" is the signature of breakage, not of safety | no — estimate only |
| B | `spike-vanilla-bytes-encoding.mjs --settle` | **the first vanilla settlement this project has done** — `0x398e7027…d067edb`, block 58,480,949. Delivered **exactly 10000 atomic**; payer delta exactly −10000; seller delta 6158 = 10000 − 3842 gas (pre-registered as delivered-**minus**-gas: USDC *is* the gas token on Arc and `receiveWithAuthorization` forces the payee to submit). ⚠️ **submit→mined 2.48 s — NOT the sub-second pre-registered**, reported as measured and run once. Still ~370× faster than Gateway's ~15.4 min flush, and *final* rather than `success:true` | **YES** (0.01 USDC) |

| C | `spike-vanilla-zero-balance-grief.mjs` | **the create path rejects a zero-balance payer, and it costs the seller nothing.** Run through the LIVE endpoint (the actual attack surface, not the SDK): fetched the seller's own 402, signed a genuinely valid authorization for the full price from a freshly generated account holding **0 USDC**, submitted it as `X-PAYMENT`. Seller nonce `2 → 2`, balance `314272 → 314272`, HTTP 402. ⭐⭐ **The NONCE is the load-bearing measurement** — an unchanged balance is consistent with both "never broadcast" and "broadcast but gas was free"; `eth_getTransactionCount` increments if and only if a tx really went out. This closes an inference previously extrapolated from `estimateContractExecutionFee`, a DIFFERENT endpoint from the `createContractExecutionTransaction` the seller actually calls | no — nothing broadcast, that is the finding |

| D | `spike-vanilla-rate-ceiling-live.mjs` | **the per-minute ceiling fires against REAL Netlify Blobs.** `test:vanillalimits` is 19/0 with four mutations but mocks `@netlify/blobs` wholesale — `onlyIfMatch`/`onlyIfNew` are stubs answering their own assumptions, both sides of the boundary in one process ([[binding-tested-across-what-it-binds]], the shape that hid a Blobs-context bug behind twelve green suites). Burst of 7: first 6 → 402, **7th → 429 `6/6 settles already this minute`**, seller nonce `2→2`, balance unchanged. ⭐⭐ **The decisive row is P4** — the counter read back out of the live store as `{"n":6}` via the Netlify CLI. A 429 alone could come from an in-memory counter in a warm container and would look identical; only the store read rules that out. ⚠️ The minute bucket is part of the hypothesis: the script waits for a fresh minute and exits **INCONCLUSIVE (code 2)** rather than red if the burst straddles a rollover | no — Guard A checks only BALANCE, so a funded payer with a bogus 65-byte signature clears it, claims a real slot, and is rejected by Circle at estimation. No broadcast, no gas, no USDC |

### ⚠️ Two measurement defects this trail is also evidence of
* **Delivered first read `10000000000000000`** — 1e12 too big. An Arc settlement emits the same movement
  **twice**: the USDC ERC-20 `Transfer` at `0x3600…` in **6** decimals and the **native-token view** at
  `0xffff…fe` in **18**. The filter matched topic + recipient and never pinned the contract address —
  a measurement failure that read exactly like a settlement failure.
* **The first run died on `ETIMEDOUT`** to Arc's throttled public RPC, in the free phase, before anything
  was signed; verified on-chain that nothing moved before re-running. Reads now retry —
  ⭐ **the Circle submit is deliberately NOT wrapped, because retrying a submission is how one payment
  becomes two.**

## Superseded / dead-ends (kept for the honest trail, NOT proof)
| Script | Why it's here |
|---|---|
| `spike-phase0b.mjs` | external SDK-reconstruction of `createSwap` — **failed on internal wiring**, inconclusive; the real pipeline (0c/0e) was the right approach |
| `spike-phase0d-discover.mjs` | permit-typed-data grab that produced an **ambiguous 7-address list** (caught proxy traps + the BridgingKit) — **superseded** by `spike-find-swap-spender.mjs`, which used a real on-chain Approval instead of inference |

See the memory notes `money-path-spike-verdict` and `dca-confirm-robust-path-design-brief` for the
full verdict and the refactor recipe these evidence.
