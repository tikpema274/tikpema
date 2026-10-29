# PRE-REGISTRATION — measured round-trip depth of Arc MAINNET's USDC pools (step 0)

**2026-10-29. Written BEFORE any read.** Approved by T: mainnet only (chain 5042); N = 100 bps total round-trip
loss; fee and price impact recorded separately with the reason `fees-exceed-limit`. Nothing below the line
"⛔ FROZEN" is amended after the run starts — a change means a new pre-registration with its own commit, and
the results quote the commit of the version they ran under.

## WHY THIS READ EXISTS

Wash trading inflates volume and therefore fee-derived return, and circular token pairs inflate displayed
liquidity (Arc House, *"Wash trading and the illusion of liquidity"*). The answer for a pool the user NAMES is
to measure what the agent would actually pay: a simulated round trip at the agent's size, in USDC, at one
pinned block — never TVL, volume or a displayed price. Step 0 measures that across Arc mainnet before any
product rule is built, so the rule's threshold is chosen against real numbers.

⛔ **THIS IS NOT DISCOVERY.** The 2026-08-16 census decided a pool is a **policy subject, not a discovery
surface**, and suggestions stay unranked. Step 0 publishes counts and raw rows; it ranks nothing, lists no
"good" pools, and builds no product code. The product rule that follows (a depth rule evaluated for ONE named
pool, with `DEPTH_CEILING`) is a separate step.

⚠️ **THE 2026-08-16 CENSUS WAS ARC TESTNET** (chain 5042002, head block 57.3M; mainnet was at ~22.9M on
2026-09-26). Its figures (131,327 pools; 7,969 credible; 382 USDC-paired) are faucet-token pools whose
"depth" is not money. They are context only — **not a baseline**, and this read does not answer "how many of
the 7,969 pass".

---

# ⛔ FROZEN

## 1. Network and endpoints

| | |
|---|---|
| chain | **Arc mainnet, chain id 5042** (`0x13b2`) |
| USDC | **exactly** `0x3600000000000000000000000000000000000000` — WUSDC, EURC and the zero address are NOT USDC |
| endpoint A | `https://rpc.mainnet.arc.io` |
| endpoint B | dRPC's Arc mainnet endpoint |

- Both must answer `eth_chainId` = `0x13b2`; each one's `web3_clientVersion` is recorded.
- ⚠️ **Independence is NOT verified.** Both sync from the same permissioned validator set and dRPC is an
  aggregator. Agreement covers provider integrity, never consensus integrity — the same limit every DD report
  declares (`independenceVerified: false`).
- ⚠️ docs.arc.io still describes mainnet RPC as permissioned during the private-mainnet phase; reads worked on
  2026-09-20. **If either endpoint refuses a read, the run STOPS and says so.** It never falls back to one
  endpoint.

## 2. The scan head H — pinned before anything else is read

1. `eth_blockNumber` from A and B; **H = the lower of the two.**
2. `eth_getBlockByNumber(H)` from A and B — **the hashes must be identical**, or the run stops with
   `rpc-disagreement` (the `QUORUM_OUTCOMES` vocabulary).
3. H, its hash and timestamp are written to the scan record **first**. The enumeration covers `[0, H]`, nothing
   after. Arc finality is deterministic, so no reorg margin.

## 3. Enumeration — the census method, on mainnet

- **Topics, computed with viem at run time, never recalled:**
  V2 `PairCreated(address,address,address,uint256)` ·
  V3 `PoolCreated(address,address,uint24,int24,address)` ·
  V4 `Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)`.
- **No address filter** — there is no canonical factory on Arc. One `eth_getLogs` per window, the three topic0
  values OR'd.
- **10,000-block windows**, each retried until it reads; coverage is asserted against the full window list at
  the end — **zero unmeasured windows or no result.** One run, in memory; **no cross-run checkpoint** (the
  census discarded an attempt over one).
- **Two independent instruments, both required:**
  1. Endpoint B repeats the whole scan, deduped by `txHash:logIndex` — **identical totals**.
  2. For every factory answering `allPairsLength()` at H, the on-chain counter **equals** its event count.
- **Coverage stated, not hidden:** pools whose factory emits a different event (Curve-style, renamed-event forks)
  are **not enumerated** — the record says "not enumerated", never "absent". V4 pools are enumerated and every
  one is **unreadable (`v4-not-supported-v1`)**.

### The measured set

- Every **V2 and V3** pool with **exactly** USDC on one side.
- The census's "credible" filter (both tokens in ≥5 pools, neither the zero address) is a **reported column, not
  a filter**.
- If the set exceeds **2,000 pools**, a sample of 2,000 is taken by a rule fixed here and not choosable by us:
  sort by `keccak256(hash(H) ‖ poolAddress)` ascending, take the first 2,000. Every unsampled pool is listed in
  the rows as `not-sampled`.

## 4. The simulation block B and the probe

- **B** is pinned at the start of calibration exactly as H was (lower of the two heads, hashes identical).
  **Calibration and measurement both run at B.** A pool must have code at B; one created after H is not in the
  set.
- **The probe:** `scripts/pool-depth/DepthProbe.sol`, compiled with a pinned solc version; its source and runtime
  bytecode are committed and the scripts assert the bytecode hash before use. It is installed at a fresh,
  unused address by an `eth_call` **code override** and funded by a **native balance override** of S
  (Arc's USDC `balanceOf` IS the native balance, at 18 decimals native vs 6 for the ERC-20 — check C0).
- **One `eth_call` per pool per size does the whole round trip at B:** buy with S USDC → read the token received
  as a `balanceOf` difference (so a fee-on-transfer token is measured, not trusted) → sell all of it → return
  `(usdcIn, tokenGot, usdcBack)`.
- **V2:** transfer in, then `swap()` with the output from the constant-product formula at an assumed fee of
  **30 bps**, then **25 bps** if the pair refuses the first. Both refused with a `K` error →
  **unreadable (`v2-fee-unknown`)**, not a finding. A pass at an assumed fee means the pair's fee is **at most**
  that figure; the row says which (`feeSource: "assumed-v2-30"` / `"assumed-v2-25"`).
- **V3:** `swap()` exact-in with the price limit at its bound, paying in `uniswapV3SwapCallback`. The fee tier is
  read from the `PoolCreated` event AND from `fee()` at B; a mismatch is **unreadable (`fee-disagreement`)**;
  `feeSource: "pool-stated"`. A fork with renamed callbacks (ArcFlow's V3 has them) never pays →
  **unreadable (`callback-unrecognised`)**.
- **Every call is made against A and B**; any difference in the returned values is
  **unreadable (`rpc-disagreement`)**, and both answers are kept.

## 5. The figures — fee and price impact recorded separately

For a pool with per-leg fee `f` (a fraction) and a completed round trip:

| figure | definition |
|---|---|
| `totalLossBps` | `10,000 × (1 − usdcBack / usdcIn)` |
| `feeLossBps` | `10,000 × (1 − (1 − f)²)` — the round trip's cost from fees alone (30 bps → **59.91**; 100 bps → **199.00**) |
| `impactLossBps` | `10,000 × (1 − (usdcBack / usdcIn) / (1 − f)²)` — what remains once the fee is taken out |

The components are **multiplicative, not additive**: `(1 − total) = (1 − fee) × (1 − impact)`. Both are kept in
the raw rows for every completed row, with `f` and `feeSource`. A fee-on-transfer token's transfer tax lands in
`impactLossBps` (it is not a pool fee) and the row also records `tokenGot` against the amount the pool said
it sent, so the two can be told apart afterwards.

## 6. Pass mark and classification

**S ∈ { $10, $100, $1,000 }. N = 100 bps total round-trip loss.** Raw rows keep every figure, so any other N
can be recomputed by anyone — but **only N = 100 is a pre-registered result.**

Applied in this order; the FIRST that matches is the reason:

| # | condition | bucket | reason |
|---|---|---|---|
| 1 | not V2/V3; probe not run; RPC failure; undecoded revert, custom error or Panic; fee unknown or disagreeing; callback unrecognised; endpoints disagree | **unreadable** | the specific cause |
| 2 | the buy reverts with a decoded `Error(string)` | **fail** | `entry-reverts` (+ the string) |
| 3 | the sell reverts with a decoded `Error(string)` | **fail** | `exit-reverts` (+ the string) |
| 4 | `usdcBack > usdcIn` | **fail** | `round-trip-gains` — the pool is mispriced |
| 5 | `feeLossBps > N` | **fail** | `fees-exceed-limit` (a 1% V3 tier is ≈199 bps before any impact) |
| 6 | `totalLossBps > N` | **fail** | `too-shallow` |
| 7 | otherwise | **pass** | — |

- A `fees-exceed-limit` row whose `impactLossBps` alone also exceeds N carries `impactAlsoExceeds: true`, so
  "expensive" and "expensive AND shallow" are not merged.
- ⚠️ Text is never evidence: only a **decoded** `Error(string)` reaches rows 2–3 (the viem trap recorded in
  `shared/vault-mandate/redeem-sim.mjs`). Everything that looks like a revert but did not decode is row 1.
- **Reported per size:** pass / each fail reason / each unreadable cause — **three buckets, never summed into one
  figure** — with the "credible" column alongside.

## 7. Calibration — all must pass before any measured row is read

| # | check | must hold |
|---|---|---|
| C0 | balance override | a fresh address reads USDC **0** without the override and exactly **S** with it |
| C1 | code override | a stub at the fresh address returns its sentinel WITH the override; WITHOUT it the address has no code and the sentinel does not come back |
| C2 | historical state | both endpoints serve `eth_call` at B and agree |
| C3a | a built DEEP pool | the **genuine V2 pair runtime bytecode** (byte-copied by `eth_getCode` from an enumerated factory's pair) at an empty address, reserves of 10,000,000 USDC-equivalent per side: at S = $1,000 → **pass**, `feeLossBps` = 59.91 (assumed 30), `impactLossBps` < 5 |
| C3b | a built SHALLOW pool | the same bytecode, reserves of 100 USDC-equivalent per side: at S = $1,000 → **fail, `too-shallow`** |
| C4 | V3 monotonicity (weaker, labelled weaker) | the V3 pool holding the most USDC at B (chosen by that rule): `totalLossBps` non-decreasing over S = $1, $10, $100, $1,000, $1,000,000, and ≥ 9,000 bps at $1,000,000 |
| C5 | the classifier (pure) | fixed inputs reach every reason in §6, including `fees-exceed-limit` with and without `impactAlsoExceeds`, and a 100-bps fee row that is `fees-exceed-limit`, not `too-shallow` |

- C3's storage slots (reserves, the other token's balance) are **located against a known value**, never assumed
  from a layout.
- ⚠️ C4 shows the probe responds to size on V3; without a V3 pool of known depth it cannot show the absolute
  figure is right. That is recorded as a limit of the V3 rows.
- **Any calibration failure: the measurement does not run**, and the record names the failing check.

## 8. Files (this repo) and the .gitignore trap

| path | |
|---|---|
| `docs/arc-pool-depth-preregistration.md` | this file — committed **before** the run |
| `scripts/pool-depth/scan-pools.mjs` | §2–3 |
| `scripts/pool-depth/DepthProbe.sol`, `DepthProbe.bytecode.json` | the probe, source + pinned compile |
| `scripts/pool-depth/calibrate.mjs` | §7 |
| `scripts/pool-depth/measure-depth.mjs` | §4–6 |
| `scripts/pool-depth/classify-depth.mjs` | §5–6, pure (C5 tests it) |
| `scripts/pool-depth/verify-depth-read.mjs` | re-derives every published figure from the raw rows |
| `scripts/pool-depth/arc-mainnet-<date>.scan.json` | H, hash, timestamp, endpoints + client versions, windows, retries, both instrument checks |
| `scripts/pool-depth/arc-mainnet-<date>.pools.json` | **every** creation event, decoded: block, txHash, logIndex, factory, version, token0, token1, fee, tickSpacing, pool / poolId, hooks |
| `scripts/pool-depth/arc-mainnet-<date>.calibration.json` | B, hash, every calibration input and raw output from both endpoints |
| `scripts/pool-depth/arc-mainnet-<date>.depth.json` | per pool × size: inputs, raw outputs from both endpoints, `f`, `feeSource`, `totalLossBps`, `feeLossBps`, `impactLossBps`, `impactAlsoExceeds`, bucket, reason |

- ⚠️ **THE TRAP:** `.gitignore`'s `census-out.json`, `payto-catalogue-out.json` and `catalogue-effect-out.json`
  carry **no path**, so they are ignored in EVERY directory. No file here uses those names, and **no ignore rule
  is added for `scripts/pool-depth/`.**
- **Proof before the commit:** `git check-ignore -v scripts/pool-depth/*` prints nothing, and
  `git status --porcelain --ignored scripts/pool-depth` shows every file as `??`, none as `!!`.
- A rows file over 50 MB is split by version (V2 / V3 / V4) to stay under GitHub's 100 MB limit.

## 9. What step 0 does NOT do

- No transaction, no signature, no deploy, no product code.
- No ranking, no list of "passing pools" presented as recommendations — the counts and the rows are the result.
- **Does not detect:** wash trading (volume and fee-derived return are not read at all); liquidity withdrawn
  after B (a pass is "at block B", never a promise); prices on other venues; pools not enumerated (§3).
- The depth rule for a NAMED pool, with its `DEPTH_CEILING` disclosure, is the next step and is built only after
  T reads these results.

### Recorded as a proposal only — NOT a decision

If discovery is ever revisited: order by **measured round-trip loss at the agent's size**, not by fee-derived
return — it is the one figure here that wash trading cannot inflate without leaving real, sellable USDC depth
behind. Return could be shown beside it, labelled not checked, never as the sort key. The 2026-08-16 census
decision (policy subject, not a discovery surface; suggestions unranked) stands until T decides otherwise.
