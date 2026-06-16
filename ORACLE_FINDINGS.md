# Price-Feed Oracle Investigation — Arc Testnet

**Date:** 2026-06-16
**Network:** Arc Testnet — chain ID `5042002`, RPC `https://rpc.testnet.arc.network`
**Method:** Read-only. No transactions submitted, nothing deployed. All on-chain
checks via `cast` (Foundry 1.7.1) against the Arc testnet RPC. RPC `chain-id`
verified = `5042002`.

---

## TL;DR

| Oracle | On Arc testnet? | Address | Status |
|--------|-----------------|---------|--------|
| **Stork** | ✅ **LIVE** | `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` | Deployed proxy + impl, has stored values |
| Chainlink | ⚠️ Partner, no feeds | — | Announced ecosystem partner (CRE, Feb 2026); **no published price-feed addresses** for Arc testnet |
| Pyth | ❌ Not present | — | Arc **not listed** in Pyth's EVM contract-address docs |

**Stork is the only price oracle actually deployed and queryable on Arc testnet.**

Feeds with values currently stored on-chain: **BTCUSD, ETHUSD, XAUUSD** (gold).
All three were last pushed ~2 days ago (Jun 13–14) and are **stale** — see the
pull-oracle caveat below, which is the single most important thing for resolution design.

---

## 1. Stork (LIVE)

### Address & deployment proof

- **Contract (proxy):** `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62`
  - Source: Stork docs → Resources → Contract Addresses → EVM → Arc
    (docs.stork.network/resources/contract-addresses/evm). Arc Testnet is the only
    "Arc" network listed.
  - Explorer: https://testnet.arcscan.app/address/0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62
- **Bytecode confirmed on-chain:** `cast code` returns a 343-byte **ERC-1967
  minimal proxy** (delegatecall to the EIP-1967 implementation slot).
- **Implementation:** EIP-1967 impl slot
  (`0x360894...382bbc`) → `0x647dfd812bc1e116c6992cb2bc353b2112176fd6`, which holds
  **~21.6 KB of bytecode** (the real Stork logic).
- **`version()`** → `"1.0.6"`
- **`owner()`** → `0x157220964094faCbcDdd1b527ff85D99cb2908fE`

This is a genuine, initialized deployment — not an empty/placeholder address.

### Read interface

```solidity
struct TemporalNumericValue {
    uint64 timestampNs;     // publish time in nanoseconds since epoch
    int192 quantizedValue;  // price scaled to 18 decimals
}

// Returns the latest stored value, NO staleness check (always succeeds if feed exists):
function getTemporalNumericValueUnsafeV1(bytes32 id)
    external view returns (TemporalNumericValue memory);

// Same, but reverts if the stored value is older than the contract's freshness threshold:
function getTemporalNumericValueV1(bytes32 id)
    external view returns (TemporalNumericValue memory);
```

- **Feed ID (`bytes32`)** = `keccak256(<SYMBOL>)`, where SYMBOL is the upper-case
  pair string with no separator, e.g. `keccak256("BTCUSD")`.
  - BTCUSD → `0x7404e3d104ea7841c3d9e6fd20adfe99b4ad586bc08d8f3bd3afef894cf184de`
  - ETHUSD → `0x59102b37de83bdda9f38ac8254e596f0d9ac61d2035c07936675e87342817160`
  - XAUUSD → (computable the same way via `cast keccak "XAUUSD"`)
- **Price decoding:** `quantizedValue` is 18-decimal fixed point → divide by 1e18.
- **Revert selectors observed:**
  - `0xc5723b51` — feed ID not found (no value ever stored for that asset).
  - `0x24c4fe43` — returned by the staleness-checked `getTemporalNumericValueV1`
    for BTCUSD, i.e. the stored value is past the freshness threshold.

### Feeds currently live (values stored on-chain)

Queried via `getTemporalNumericValueUnsafeV1`:

| Pair | Feed ID = keccak256(symbol) | Last value | Last push (UTC) |
|------|------------------------------|-----------|------------------|
| **BTCUSD** | `0x7404e3d1…cf184de` | ~$64,515.87 | 2026-06-14 09:45 |
| **ETHUSD** | `0x59102b37…2817160` | ~$1,676.44 | 2026-06-13 20:15 |
| **XAUUSD** (gold/oz) | `keccak256("XAUUSD")` | ~$4,218.34 | 2026-06-14 09:45 |

Swept ~50 other pairs (SOL, ADA, DOT, AVAX, LINK, BNB, XRP, DOGE, ARB, OP, SUI,
APT, ATOM, LTC, BCH, PEPE, SHIB, GBPUSD, JPYUSD, EURUSD, USDCUSD, USDTUSD,
EURCUSD, XAGUSD, WTIUSD, etc.) — **all revert `0xc5723b51` (not found).**
Only BTCUSD, ETHUSD, and XAUUSD have ever been written on this testnet deployment.

### ⚠️ Critical caveat — Stork is a PULL oracle

Stork does not continuously push prices on-chain. A value only exists/updates when
**someone submits a Stork-signed update** (`updateTemporalNumericValuesV1`, which
charges a small update fee in native USDC gas). The three feeds above show
timestamps from **2 days ago**, and the staleness-checked read already reverts —
meaning nobody has refreshed them recently.

**Implication for trustless resolution:**
- You cannot assume a fresh price is sitting on-chain at resolution time.
- A resolver must: (1) fetch the current signed value from Stork's REST/WebSocket
  API, (2) submit it on-chain via `updateTemporalNumericValuesV1` (pay the fee),
  then (3) read it back. The signature is verified on-chain against Stork's
  publisher key, so the value is trust-minimized even though delivery is pull-based.
- The off-chain Stork API likely signs **far more assets** than the 3 stored here;
  the on-chain "available" set is just whatever has been pushed so far on testnet.

---

## 2. Chainlink (partner, but no usable feeds)

- Chainlink is a **named core ecosystem partner** of Arc — Arc integrated the
  Chainlink Runtime Environment (CRE) around Feb 6, 2026
  (chainlinkecosystem.com/ecosystem/arc; Circle press materials).
- However, Chainlink's Data Feeds address registry (docs.chain.link) does **not
  publish any price-feed contract addresses for Arc testnet (5042002)**. No
  AggregatorV3 / feed address could be found to verify on-chain.
- **Verdict:** No usable Chainlink price feed on Arc testnet today. Worth
  re-checking near Arc mainnet launch.

## 3. Pyth (not present)

- Arc is **not listed** in Pyth's EVM contract-address documentation
  (docs.pyth.network/price-feeds/contract-addresses/evm).
- No `IPyth` contract address documented for chain 5042002; nothing to verify
  on-chain.
- **Verdict:** No Pyth deployment on Arc testnet.

---

## What this means for market resolution

- **Trustlessly resolvable today (with a pull step):** any market that resolves on
  **BTC/USD, ETH/USD, or gold (XAU/USD)** — these are the only feeds Stork has
  on-chain on Arc testnet. Resolution must pull a fresh signed value and submit it
  (pay the USDC update fee) rather than reading a passively-maintained price.
- **Not trustlessly resolvable via on-chain oracle yet:** altcoins, forex pairs,
  stablecoin pegs, equities, commodities other than gold — no feed stored, and no
  Chainlink/Pyth alternative on Arc testnet.
- **Architecture note:** because Stork is pull-based and current testnet values are
  stale, treat the oracle as "signed price available on demand," not "always-fresh
  on-chain price." Budget for the update fee (native USDC gas) at resolution time.

---

## Reproduction commands

```bash
RPC=https://rpc.testnet.arc.network
PROXY=0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62

cast chain-id --rpc-url $RPC                       # -> 5042002
cast code  $PROXY --rpc-url $RPC                   # -> 343-byte ERC-1967 proxy
cast storage $PROXY 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $RPC   # impl addr
cast call  $PROXY "version()(string)" --rpc-url $RPC   # -> "1.0.6"

# read a feed (BTCUSD); returns (uint64 timestampNs, int192 quantizedValue@1e18)
cast call $PROXY "getTemporalNumericValueUnsafeV1(bytes32)(uint64,int192)" \
  $(cast keccak "BTCUSD") --rpc-url $RPC
```
