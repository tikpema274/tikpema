# TikpemaPrediction — Investigation Findings

_Network: Arc Testnet · Chain ID `5042002` · RPC `https://rpc.testnet.arc.network`_

## Address discrepancy (important)

The address originally cited — `0x4F8a2E3b7C1d9F6e0A8b4D2c5E7f3A1b2C3d4E5f...3c91` — **is not valid or deployed**:

- It is malformed: the part before `...` (`0x4F8a…4E5f`) is already a complete 40-hex-char address, with `...3c91` tacked on as extra characters.
- Querying Arc Testnet for code at the 40-char prefix `0x4F8a…4E5f` returns **empty (`0x`)** — nothing is deployed there.
- It does not match any address in the deployment / broadcast records.

The contract is actually named **`TikpemaPrediction`** (not `TikpemaPredict`).

## Live contract

| Field | Value |
|---|---|
| **Address (current)** | **`0xf38492403ce3f1c94ef6322b78c9024d26ed87e1`** |
| Status | ✅ Deployed, live, in use (16.6 KB bytecode on-chain) |
| Source | `src/TikpemaPrediction.sol` (identical copies in `~/tikpema-contracts`, `~/tikpema-full/tikpema-contracts`, `~/tikpema/tikpema-contracts`) |
| Older deployment (superseded) | `0xa99fb3984f1e2c8d358537e2e888013fd8305630` (still has code) |

On-chain state confirms it matches the source:

- `PROTOCOL_FEE_BPS = 50` (0.5%), `MAX_CREATOR_FEE = 500` (5%), `MIN_LIQUIDITY = 10000000` (10 USDC @ 6 decimals)
- `usdc = 0x3600000000000000000000000000000000000000` (Arc native USDC)
- `owner = oracle = treasury = 0xd87f530b291107d3A2b23fCAC652B9BeDD2Da05c` (the deployer)
- `nextMarketId = 7` → 7 markets already created
- `paused = false`

> ⚠️ `owner`, `oracle`, and `treasury` are all the same single deployer EOA (a hot wallet). Fine for testnet, but market resolution is currently fully centralized to one key.

## Public / external functions

| Category | Function | Access |
|---|---|---|
| **Create market** | `createMarket(question, category, resolutionSource, bettingDeadline, resolutionTime, initialLiquidity, initialYesBps, creatorFeeBps) → marketId` | anyone |
| **Place position** | `placeBet(marketId, isYes, amount)` | anyone (while OPEN) |
| **Resolve** | `resolveMarket(marketId, yesWon)` | oracle only |
| Lifecycle | `closeMarket(marketId)` | anyone (after deadline) |
| Lifecycle | `cancelMarket(marketId)` | owner only |
| **Claim** | `claimPayout(marketId)` | winners / refundees |
| Claim | `claimCreatorFee(marketId)` | market creator |
| Claim | `collectProtocolFees()` | treasury only |
| Views | `getProbabilities(marketId)`, `quotePayout(marketId, isYes, amount)`, `getPosition(marketId, user)` | view |
| Admin | `setOracle`, `setTreasury`, `setPaused`, `transferOwnership` | owner only |
| Auto-getters | `markets(id)`, `positions(id, addr)`, `nextMarketId`, `owner`, `oracle`, `treasury`, `paused`, `pendingProtocolFees`, constants `PROTOCOL_FEE_BPS` / `MAX_CREATOR_FEE` / `MIN_LIQUIDITY` / `BPS` | view |

## Market lifecycle

**Model:** parimutuel (pooled-odds) prediction market.

**Token / amounts:** all amounts in Arc-native **USDC** (`0x3600…0000`, **6 decimals** — e.g. `10000000` = 10 USDC). USDC is also Arc's gas token. Users must `approve()` the contract for USDC before creating a market or betting.

**Status flow:** `OPEN → CLOSED → RESOLVED_YES / RESOLVED_NO`, or `→ CANCELLED`.

1. **Create** — `createMarket(...)`. Creator sets a yes/no question (≥10 chars), category, resolution source, a betting deadline and a resolution time (≥ deadline), and **seeds initial liquidity** (min 10 USDC) split into YES/NO pools per `initialYesBps` (e.g. 5000 = 50/50). The seed is pulled via `transferFrom` and the creator receives a position equal to it. Creator fee capped at 5%.

2. **Place a position** — `placeBet(marketId, isYes, amount)` while `OPEN` and before `bettingDeadline`. USDC is pulled in and added to `yesPool` or `noPool`; the caller's `Position.yesStake` / `noStake` grows. Odds are implied by pool sizes (`getProbabilities` / `quotePayout`).

3. **Close** — after the deadline, anyone can call `closeMarket` to move `OPEN → CLOSED` (status flip only; bets were already blocked by the deadline check).

4. **Resolve** — after `resolutionTime`, the **oracle** calls `resolveMarket(marketId, yesWon)`, setting `RESOLVED_YES` or `RESOLVED_NO`. Fees are snapshotted here: `creatorFee = totalPool × creatorFeeBps`, `protocolFee = totalPool × 0.5%`.

5. **Claim / payout** — `claimPayout(marketId)`: winners get a pro-rata share of the post-fee pool: `payout = stake × (totalPool − creatorFee − protocolFee) / winningPool`. Losers get 0. The creator separately calls `claimCreatorFee`; treasury calls `collectProtocolFees`.

6. **Cancel (alt path)** — owner can `cancelMarket` before resolution (e.g. bad data); then `claimPayout` returns each staker a **full refund** (`yesStake + noStake`), with no fees taken.
