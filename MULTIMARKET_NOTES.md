# Multi-Market Support — Contract Investigation (READ-ONLY)

Findings from reading the **TikpemaPrediction** contract on-chain. No transactions were
sent; everything below comes from `eth_call`, raw bytecode, decoded historical calldata,
and the explorer's tx list.

- **Contract:** `0xf38492403ce3f1c94ef6322b78c9024d26ed87e1`
- **Chain:** Arc Testnet (id `5042002`), RPC `https://rpc.testnet.arc.network`
- **USDC (native gas token, ERC-20 iface):** `0x3600000000000000000000000000000000000000` (6 dp)
- **Verified on explorer?** No — source/ABI not verified on arcscan. Signatures below were
  recovered from the runtime bytecode (function-selector extraction), the OpenChain
  signature DB, and by decoding real historical `createMarket` calldata.

---

## 1. How to enumerate markets

There is **no** `getMarketCount`, `marketCount`, or `getMarket` getter. Enumeration uses:

- **`nextMarketId() → uint256`** — the id that will be assigned to the *next* market.
  Ids are sequential starting at `0`, so **`nextMarketId` == total market count**, and
  valid market ids are `0 .. nextMarketId-1`.
- **`markets(uint256 marketId)`** — public mapping getter returning the Market struct.
  A non-existent id returns a zero struct (`creator == address(0)`), which is the
  existence check (already implemented as `readMarket()` returning `null` in
  `netlify/functions/_predict.mjs`).

**Enumeration loop:** read `nextMarketId()`, then `markets(i)` for `i` in `0..n-1`
(optionally skip any whose `creator == 0x0`, though all sequential ids exist).

`markets(uint256)` output order (matches the ABI already in `_predict.mjs`):
`question(string), category(string), resolutionSource(string), creator(address),
bettingDeadline(uint64), resolutionTime(uint64), yesPool(uint256), noPool(uint256),
creatorFeeBps(uint16), creatorFeesEarned(uint256), status(uint8), creatorClaimed(bool)`.

Status enum: `0 OPEN, 1 CLOSED, 2 RESOLVED_YES, 3 RESOLVED_NO, 4 CANCELLED`.

---

## 2. Markets currently on-chain

**`nextMarketId() = 7` → 7 markets exist (ids 0–6).** Confirmed by reading each:

| id | status | question | yesPool | noPool | creatorFeeBps |
|----|--------|----------|--------:|-------:|--------------:|
| 0 | OPEN | Will USDC hit $100B market cap in 2026? | 48.31 | 10.55 | 200 |
| 1 | OPEN | Will a major AI lab release AGI before 2027? | 4.80 | 19.20 | 200 |
| 2 | OPEN | gdshgjhjkjkjbfhbhbvc? (test) | 4.80 | 33.20 | 200 |
| 3 | OPEN | gdshgjhjkjkjbfhbhbvc? (test) | 4.80 | 5.20 | 200 |
| 4 | OPEN | Will USDC hit $100B market cap in 2026? | 3.50 | 6.50 | 200 |
| 5 | OPEN | Will USDC hit $100B market cap in 2026? | 3.50 | 6.50 | 200 |
| 6 | OPEN | will nroway win thw world cup? | 1.50 | 8.50 | 200 |

(pools in USDC.) All 7 are **OPEN**; none resolved/closed/cancelled yet. Several are
duplicate/test entries. `markets(7)` returns the zero struct (does not exist).

All 7 were created by the **same creator: `0x12B36dD2043C723543B44eEBF0900764fb17A29c`**.

---

## 3. Is `createMarket` access-controlled?

**No — `createMarket` is permissionless (open to any address).** Evidence:

- `owner()  = 0xd87f530b291107d3A2b23fCAC652B9BeDD2Da05c` (deployer)
- `oracle() = 0xd87f530b291107d3A2b23fCAC652B9BeDD2Da05c`
- `treasury()= 0xd87f530b291107d3A2b23fCAC652B9BeDD2Da05c`
- All 7 markets were created by `0x12B36dD2…`, which is **not** the owner/oracle. A
  non-privileged address successfully creating markets proves there is no owner/oracle gate.

`createMarket` is *not* fully unconditional, though. The reverted historical call we
decoded (1 USDC seed) shows it enforces guard conditions. From the contract constants:

- **`paused() = false`** — there is a global pause (`setPaused(bool)`, owner-only) that
  blocks creation/betting when true.
- **`MIN_LIQUIDITY() = 10000000`** = **10 USDC** — the initial liquidity seed must be ≥ this.
  (A sample `createMarket` passing only 1 USDC **reverted**; all 7 successful ones passed
  exactly 10 USDC.)
- **`MAX_CREATOR_FEE() = 500`** = **5%** — `creatorFeeBps` must be ≤ 500.
- **`BPS() = 10000`**, **`PROTOCOL_FEE_BPS() = 50`** (0.5% protocol fee).

The privileged functions are the *resolution/admin* ones, not creation — see §5.

---

## 4. `createMarket` exact signature & parameters

Selector **`0x2209dbac`** (the only string-bearing state-changing call in the contract's
history — called 25×, 7 succeeded, 18 reverted, mostly on the 10-USDC minimum).

```
createMarket(
  string  question,                 // e.g. "Will USDC hit $100B market cap in 2026?"
  string  category,                 // e.g. "Macro" / "Crypto" / "Tech"
  string  resolutionSource,         // e.g. "Oracle"
  uint64  bettingDeadline,          // unix seconds; betting closes at/after this
  uint64  resolutionTime,           // unix seconds; expected resolution time
  uint256 initialLiquidity,         // USDC (6dp), MUST be >= MIN_LIQUIDITY (10 USDC)
  uint16  initialYesProbabilityBps, // 1..9999; splits initialLiquidity into yes/no pools
  uint16  creatorFeeBps             // <= MAX_CREATOR_FEE (500 = 5%)
)
```

Signature string used for the selector (and for Circle `abiFunctionSignature`):
`createMarket(string,string,string,uint64,uint64,uint256,uint16,uint16)`

**Parameter meanings confirmed by decoding all 7 successful calls and cross-checking pools:**

- `initialLiquidity` = 10 USDC (`10000000`) for every market — pulled from the caller via
  USDC `transferFrom`, so the caller **must `approve` USDC to the contract first**
  (≥ `initialLiquidity`). `transferFrom` is present in the bytecode.
- `initialYesProbabilityBps` sets the starting pool split. Verified: markets 4 & 5 were
  created with `3500` (35%) and show `yesPool=3.5 / noPool=6.5` (35% / 65% of the 10 USDC
  seed). Market 6 used `1500` → `1.5 / 8.5`. Observed values: 3500, 800, 4800, 1500.
- `creatorFeeBps` = `200` (2%) for all 7; matches each market's stored `creatorFeeBps`.

**To create a new market later** you need: (a) the caller holds ≥ `initialLiquidity` USDC,
(b) `approve(0xf3849…, initialLiquidity)` on the USDC ERC-20, (c) call `createMarket(...)`
with the 8 params above, (d) contract not paused, fee ≤ 500 bps, liquidity ≥ 10 USDC.
The caller becomes the market `creator` and earns `creatorFeeBps` on the pool.

---

## 5. Other functions on the contract (for reference)

Recovered from bytecode selectors + OpenChain. Useful when wiring multi-market UI/flows.

**Reads (view):** `nextMarketId()`, `markets(uint256)`, `getProbabilities(uint256)`,
`quotePayout(uint256,bool,uint256)`, `getPosition(uint256,address)`,
`positions(uint256,address)`, `owner()`, `oracle()`, `treasury()`, `usdc()`, `paused()`,
`MIN_LIQUIDITY()`, `BPS()`, `PROTOCOL_FEE_BPS()`, `MAX_CREATOR_FEE()`,
`pendingProtocolFees()`.

**User writes (permissionless):** `createMarket(...)` (above),
`placeBet(uint256,bool,uint256)`, `claimPayout(uint256)`, `claimCreatorFee(uint256)`.

**Admin / oracle writes (owner/oracle = `0xd87f530b…`):**
`resolveMarket(uint256,bool)` (bool = YES wins), `closeMarket(uint256)`,
`cancelMarket(uint256)`, `setOracle(address)`, `setTreasury(address)`, `setPaused(bool)`,
`collectProtocolFees()`, `transferOwnership(address)`.

---

## Implications for multi-market support

- **Listing** is trivial: `nextMarketId()` + loop `markets(i)`. The existing
  `readMarket()` helper already normalizes a single market — wrap it in a loop over
  `0..nextMarketId-1` to build the full list (add a small multicall/batch if perf matters).
- **Creating** new markets is open to our agent wallet — no owner privilege needed — but
  requires a USDC `approve` for ≥ 10 USDC, then `createMarket(...)`. Each market locks
  ≥ 10 USDC of seed liquidity from the creator.
- **Resolution stays gated** to the oracle EOA (`0xd87f530b…`), which is the deployer, not
  our market-creating wallet (`0x12B36dD2…`). Keep that distinction in mind for the
  resolve/propose flow (see ORACLE_FINDINGS.md / ORACLE_KEY_NOTES.md).
