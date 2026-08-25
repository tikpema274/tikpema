# What x402 sellers actually earn: a 7-day on-chain census

x402 payment endpoints publish a `payTo` address in their 402 challenge. Those addresses
are public, so what sellers receive is measurable without asking anyone.

I scanned every distinct Base payout address I could harvest from the Circle x402
marketplace and read seven days of USDC transfers to and from each.

## Method

- **Chain:** Base mainnet (`eip155:8453`), USDC `0x833589fc…2913`
- **Window:** blocks 50,129,226 – 50,431,626 — **302,401 blocks, exactly 7.00 days**,
  2026-08-18T10:09:59Z → 2026-08-25T10:09:59Z
- **Sellers:** 54 distinct `payTo` addresses, taken from 2,103 priced offers across 20
  keyword searches of the marketplace
- **Measured:** every USDC `Transfer` with the seller as recipient **and** as sender,
  matched on the token contract address — not on the event topic alone
- **Coverage:** 302,401 of 302,401 blocks. No window failed; no gap was skipped.

## Results

**31% of listed sellers received anything at all.**

| | |
|---|---|
| Sellers receiving ≥1 inbound transfer | **17 of 54** |
| Sellers receiving nothing in 7 days | **37 of 54** |
| Total inbound transfers | **44,752** |
| Total inbound value | **1,106.40 USDC** |
| Mean per transfer | **$0.0247** |

**The median listed seller earned nothing.**

| | across all 54 | among the 17 earners |
|---|---|---|
| Median inbound USDC | **0.00** | **10.74** |
| Median transfer count | **0** | **214** |

**Revenue is highly concentrated.**

| | share of all inbound |
|---|---|
| Top 1 seller | **42.8%** |
| Top 3 sellers | **80.5%** |
| Top 5 sellers | **92.1%** |

The largest earner took **473.24 USDC across 31,018 transfers** — roughly 4,400 payments a
day at about 1.5 cents each.

**The zeros are real, not swept balances.** Only **3 of 54** addresses sent any USDC out
during the week — 12 transfers, 91.01 USDC total. A seller earning and withdrawing looks
identical to a dead one if you only measure balances, so outbound was measured too. It
rules out the obvious alternative explanation for the 37 zeros.

## What this does and does not show

**It shows:** x402 endpoints do get paid, at high transaction volume and very low value
per call. It also shows that being listed is not the same as being used — most listed
sellers received nothing for a week, and that is not an artifact of withdrawals.

**It does not show:**

- **That every inbound transfer is a purchase.** Funding, refunds and unrelated transfers
  are indistinguishable at this resolution. Every count here is an **upper bound** on
  sales, not a count of them.
- **Anything about sellers outside this sample.** 54 addresses harvested by keyword search
  is not the whole marketplace.
- **Anything about other chains.** Base only. Ethereum, Polygon, Avalanche, Arbitrum,
  Optimism, Unichain and Solana listings exist and were not measured.
- **A trend.** This is one 7-day window. It cannot say whether any of this is growing.
- **Why** some sellers earn and others do not.

Individual addresses are not named. The distribution is the finding; who occupies which
position in it is not.
