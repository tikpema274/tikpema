# `scripts/spikes/` — money-path spike evidence (archive)

Read-only reproducible evidence behind the **TOP ROW** verdict: swap CAN get an authoritative Circle
tx id via the **approve-first two-tx `createContractExecution` refactor** (permit wall was a
no-allowance artifact). Not prod code — nothing here is imported by `netlify/` or `src/`. Kept for
reproducibility of a money-path claim, per the money-path-proof discipline.

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

## Superseded / dead-ends (kept for the honest trail, NOT proof)
| Script | Why it's here |
|---|---|
| `spike-phase0b.mjs` | external SDK-reconstruction of `createSwap` — **failed on internal wiring**, inconclusive; the real pipeline (0c/0e) was the right approach |
| `spike-phase0d-discover.mjs` | permit-typed-data grab that produced an **ambiguous 7-address list** (caught proxy traps + the BridgingKit) — **superseded** by `spike-find-swap-spender.mjs`, which used a real on-chain Approval instead of inference |

See the memory notes `money-path-spike-verdict` and `dca-confirm-robust-path-design-brief` for the
full verdict and the refactor recipe these evidence.
