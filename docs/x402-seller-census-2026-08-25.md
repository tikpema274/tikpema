# What x402 sellers actually earn: a 7-day on-chain census

x402 payment endpoints publish a `payTo` address in their 402 challenge. Those addresses
are public, so what sellers receive is measurable without asking anyone.

I scanned **every** distinct Base payout address in the Circle x402 marketplace and read
seven days of USDC transfers to and from each.

## Method

- **Chain:** Base mainnet (`eip155:8453`), USDC `0x833589fc…2913`
- **Window:** blocks 50,129,226 – 50,431,626 — **302,401 blocks, exactly 7.00 days**,
  2026-08-18T10:09:59Z → 2026-08-25T10:09:59Z
- **Sellers:** **80 distinct `payTo` addresses**, taken from the complete Circle Agent
  Marketplace discovery index — all **1,009** listings, paginated in full, not sampled
- **Measured:** every USDC `Transfer` with the seller as recipient **and** as sender,
  matched on the token contract address — not on the event topic alone
- **Coverage:** 302,401 of 302,401 blocks, 76 windows in each direction, **0 incomplete**.
  No window failed, no gap was skipped, and no window came near the log cap.

## Results

**34% of listed sellers received anything at all** — but see *The zeros track the
settlement rail* below before reading that as a measure of usage.

| | |
|---|---|
| Sellers receiving ≥1 inbound transfer | **27 of 80** |
| Sellers receiving nothing in 7 days | **53 of 80** |
| Total inbound transfers | **44,885** |
| Total inbound value | **1,107.60 USDC** |
| Mean per transfer | **$0.0247** |

**The median listed seller earned nothing.**

| | across all 80 | among the 27 earners |
|---|---|---|
| Median inbound USDC | **0.00** | **0.44** |
| Median transfer count | **0** | **20** |

**Revenue is highly concentrated — on both bases.**

| | share by transfer count | share by value |
|---|---|---|
| Top 1 seller | **69.1%** | **42.7%** |
| Top 3 sellers | **88.0%** | **80.5%** |
| Top 10 sellers | **99.6%** | **98.3%** |

The two columns differ because the largest earner's payments are unusually small: it took
**473.24 USDC across 31,018 transfers** — roughly 4,400 payments a day at about 1.5 cents
each, below the all-seller mean of 2.5 cents.

**The zeros are not withdrawals.** Only **6 of 80** addresses sent any USDC out during the
week — 19 transfers, 91.15 USDC total. A seller earning and withdrawing looks identical to
a dead one if you only measure balances, so outbound was measured too. ⚠️ That rules out
*one* alternative explanation for the 53 zeros. It does not rule out the one below.

## 🚨 The zeros track the settlement rail, not obviously the trade

Splitting the same 80 addresses by which rail their listings declare:

| rail declared | earned ≥1 | zero | total | earn rate |
|---|---|---|---|---|
| vanilla x402 only | 16 | 1 | 17 | **94%** |
| both | 2 | 0 | 2 | 100% |
| **Circle Gateway only** | 9 | **37** | 46 | **20%** |
| neither declared | 0 | 15 | 15 | 0% |

**70% of the zero-inbound addresses are Gateway-capable, against 41% of the earners.**
Nearly every vanilla-only seller shows receipts; four fifths of Gateway-only sellers show
none.

This is what the undercount above predicts. Gateway settles *net positions in bulk*, so a
seller doing steady business through it can show **zero inbound transfers to its `payTo`
indefinitely** — the payments are real and the transfers are not there to be counted. The
two readings are:

1. Gateway sellers are trading, and this census structurally cannot see it.
2. Gateway sellers genuinely sell less.

**On-chain data cannot distinguish them**, and no amount of additional scanning will —
the signal is absent by design, not by sampling. Only facilitator-side settlement counts
could separate the two, because only facilitators hold the pre-batch record.

⚠️ **So "53 of 80 received nothing" must not be read as "53 dead endpoints."** For the 37
Gateway-only addresses among them, a zero is uninformative rather than negative. The honest
population for any statement about *observed trade* is the 19 addresses that declare
vanilla settlement — of which **18 (95%) show receipts**.

## What this does and does not show

**It shows:** x402 endpoints do get paid, at high transaction volume and very low value
per call. It shows that inbound flow is extremely concentrated on a handful of addresses.
⚠️ It does **not** show that most listed sellers are unused — measuring outbound rules out
*withdrawals* as the explanation for the zeros, but not *settlement rail*. See below.

**It does not show:**

- **That every inbound transfer is a purchase.** Funding, refunds and unrelated transfers
  are indistinguishable at this resolution. Every count here is an **upper bound** on
  sales, not a count of them.
- **The share of x402 traffic this represents.** No such number appears in this document,
  deliberately. **629 of the 1,009 listings (62%) settle through Circle Gateway**, which
  aggregates authorizations and settles *net positions in bulk* rather than per payment.
  On-chain transfers to a `payTo` address therefore **undercount Gateway-settled sales by
  an unknown factor** — including in the numerator above. Any ratio against a "total x402
  volume" figure would be comparing post-batch transfers to pre-batch payments, and would
  measure the batching factor rather than market share.
- **Anything about other chains.** Base only. Ethereum, Polygon, Avalanche, Arbitrum,
  Optimism, Unichain and Solana listings exist and were not measured.
- **A trend.** This is one 7-day window. It cannot say whether any of this is growing.
- **Why** some sellers earn and others do not.

**On completeness:** an earlier version of this census used 54 addresses harvested by
keyword search and cautioned that it was "not the whole marketplace". That caveat was
measurably wrong, in the modest direction. Widening to all 80 addresses in the full
discovery index moved the total from 44,752 to 44,885 transfers — **+133, or +0.30%**. The
54 were not a sample of the directory's Base flow; they were effectively the population of
it. The additional 26 addresses contribute almost nothing, which is itself a finding about
how concentrated this market is.

Individual addresses are not named. The distribution is the finding; who occupies which
position in it is not.
