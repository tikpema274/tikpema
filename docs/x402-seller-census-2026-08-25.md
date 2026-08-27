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

> ### ⚠️ THIS SECTION WAS CORRECTED ON 2026-08-27, AFTER PUBLICATION
>
> **No measurement changed.** The scan was re-run on 2026-08-27 over the identical window and
> reproduces this document exactly: 80 addresses, 836 listings, **44,885** transfers, 1,107.60
> USDC, 302,401 of 302,401 blocks covered.
>
> **What was wrong was the unit.** Every figure here counts `payTo` **addresses**, and **50 of
> the 80 (63%) serve more than one endpoint** — 96% of the 836 Base listings sit behind a
> multi-endpoint address, and the largest single address serves 132. An address-level rate was
> therefore presented as, and would be read as, a rate about *services*.
>
> **One headline was CUT rather than restated:** *"34% of listed sellers received anything at
> all."* Translated to listings that claim spans **27 to 477 of 836** — a 17× range. A range that
> wide is not a headline, and publishing it as one invites quoting its midpoint, so it is gone.
>
> ⚠️ **The listing counts are a snapshot of a live index.** The re-scan that reproduced this
> document's 836 listings was taken earlier on 2026-08-27; a re-harvest ~2 hours later returned
> **845**, with all 9 new listings dark. Every listing-level figure below uses the **836** harvest,
> so that it shares this document's own denominator — a reader re-running later will get a larger
> denominator and slightly different percentages. The address count (80) and the transfer count
> (44,885) were stable across both.
>
> This note is here rather than the edit being made silently. The document has been read in its
> published form, and a public document quietly changing its headline is the thing this document
> would criticise.

**52% of listed endpoints never saw any price they quote arrive at their payout address.**

| | |
|---|---|
| Listings where **no** price they quote ever arrived | **435 of 836** (52.0%) |
| Listings where at least one of their prices arrived | **401 of 836** (48.0%) — *upper bound, see below* |
| Addresses receiving ≥1 inbound transfer | **27 of 80** |
| Addresses receiving nothing in 7 days | **53 of 80** |
| Total inbound transfers | **44,885** — *of which **66.6% sit on a single $0.0060 tier quoted by one listing**, see below* |
| Total inbound value | **1,107.60 USDC** |
| Mean per transfer | **$0.0247** — *a catalogue-wide modal price, not a per-service average* |

### ⭐ The asymmetry: the zeros translate to services, the earners do not

This is the frame for everything below, not a caveat on it. The two halves of "27 earned / 53
did not" behave completely differently when restated in endpoints.

**Zeros translate, and get stronger.** A till that received nothing means *every* endpoint behind
it received nothing. No assumption is needed for this to hold — it needs no sharing argument, no
attribution of a transfer to a product. **359 of 836 listings sit behind an address that received
nothing at all**, including whole catalogues of **71, 40, 36 and 21 endpoints**.

**Earners do not translate.** Endpoints **share price tiers**, so a single transfer marks an
entire tier as possibly-live. The clearest case in this data: `0xf46394ad…04623c`
(x402.quicknode.com) received **7 transfers totalling $0.007 from one sender** — and because all
132 of its listings quote the same three prices, that lights **all 132**. This is why the
"received anything" figure is an upper bound with almost no content, and why it was cut.

⛔ **Both bounds must stay visible, and the correction does not trade one overclaim for another:**

- **"Lit" is an upper bound.** Shared tiers mean one transfer lights many listings. 401 is a
  ceiling on live endpoints, not a count of them.
- **"Dark" is not provable-dead.** Prepaid credits (one settlement backing many later calls) and
  Circle Gateway batching both back calls whose own price never touches the chain. 435 is not a
  count of dead endpoints.

**The median listed *address* earned nothing.** ⚠️ Address-level; the median *listing* sits behind
a multi-endpoint till and is not described by this table.

| | across all 80 | among the 27 earners |
|---|---|---|
| Median inbound USDC | **0.00** | **0.44** |
| Median transfer count | **0** | **20** |

**Revenue is highly concentrated — on both bases.** ⚠️ **These figures are address-level and
UNDERSTATE the endpoint picture** — they are kept because they are correct as stated, not because
they are the sharpest available form.

| | share by transfer count | share by value |
|---|---|---|
| Top 1 seller | **69.1%** | **42.7%** |
| Top 3 sellers | **88.0%** | **80.5%** |
| Top 10 sellers | **99.6%** | **98.3%** |

⭐ **At endpoint level the top-1 row is far more concentrated than 69.1% suggests.** That address
(22 endpoints, 5 tiers, 63 senders) took 31,018 transfers, and **96.3% of them sit on its $0.0060
tier — a price exactly one of the 836 listings quotes. That single listing is 66.6% of all 44,885
transfers in this census.**

The two columns differ because the largest earner's payments are unusually small: it took
**473.24 USDC across 31,018 transfers** — roughly 4,400 payments a day at a mean of about 1.5
cents. ⚠️ **That mean is itself distorted:** its modal payment is **$0.0060**, and a **single
transfer of 285.82 USDC carries 60.4% of its entire weekly value.**

**The zeros are not withdrawals.** Only **6 of 80** addresses sent any USDC out during the
week — 19 transfers, 91.15 USDC total. A seller earning and withdrawing looks identical to
a dead one if you only measure balances, so outbound was measured too. ⚠️ That rules out
*one* alternative explanation for the 53 zeros. It does not rule out the one below.

## 🚨 The zeros track the settlement rail, not obviously the trade

> ### ⛔ CORRECTED 2026-08-27 — THE TABLE'S BOTTOM TWO ROWS ARE **UNRECOVERABLE**, AND THE CLAIM THEY SUPPORT IS **WITHDRAWN**
>
> **This table cannot be reproduced from the artifacts that were published with it.**
>
> Two rows re-derive exactly on a fresh harvest — `Circle Gateway only` (46 / 37 zero / 9 earned)
> and `both` (2 / 0 / 2). The other two do not. This table splits the remaining 32 addresses as
> **vanilla-only 17** + **neither declared 15**, but on the 2026-08-27 harvest **every one of the
> 80 addresses declares a rail**: 34 `extra.name = "USD Coin"`, 46 `GatewayWalletBatched`, 2 both.
> **No address has a missing `extra.name`, so the "neither declared" row cannot be reconstructed
> at all.** The 15 addresses in it are all zeros and today all read as vanilla.
>
> **Two explanations fit everything observable, and nothing distinguishes them:**
> 1. the live index changed — those listings gained an `extra.name` after 2026-08-25; or
> 2. the original classifier treated a missing or differently-shaped field as "neither declared".
>
> ⛔ **No value is asserted, because picking one would assert a cause.** Reading the closing claim
> as **95%** asserts the index did not change; correcting it to **53%** asserts it did. Neither is
> supported by anything we can still inspect.
>
> **Therefore the closing claim of this section — *"the honest population … is the 19 addresses
> that declare vanilla settlement, of which 18 (95%) show receipts"* — is WITHDRAWN**, pending a
> re-derivation that saves its per-address rows. The earner count (18) is not in doubt; the
> **denominator** is 19 or 34 depending on a classifier decision that can no longer be recovered.
>
> #### ⭐ Root cause, and it is not about this table
>
> **The aggregate was published and the per-address rows were not.** A claim *derived* from those
> rows became unfalsifiable the moment the index moved — there is nothing left to diff against.
> Publishing a conclusion without the intermediate it rests on is how a finding becomes
> unrecoverable. **That is a rule about what to save, not a fact about settlement rails.**
>
> **Fixed for this run:** `scripts/x402-census/census-2026-08-25.per-address.json` now carries all
> 80 address rows and all 836 listing rows, with the **classifier input stored verbatim** — the raw
> `extra.name` values seen per address and per listing, not just a derived rail label. A derived
> label is precisely what could not be checked here. ⚠️ This reverses the "individual addresses are
> not named" stance at the foot of this document, deliberately: reproducibility of a published
> claim outranks that editorial preference, and every `payTo` involved is already public in
> Circle's own discovery index.

⚠️ The table below is **left as published** — see the correction above before reading it. Rows 1
and 4 are the unrecoverable ones.

| rail declared | earned ≥1 | zero | total | earn rate |
|---|---|---|---|---|
| vanilla x402 only | 16 | 1 | 17 | **94%** — ⛔ unrecoverable |
| both | 2 | 0 | 2 | 100% — ✅ re-derives |
| **Circle Gateway only** | 9 | **37** | 46 | **20%** — ✅ re-derives |
| neither declared | 0 | 15 | 15 | 0% — ⛔ unrecoverable, cannot be reconstructed |

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
Gateway-only addresses among them, a zero is uninformative rather than negative — that part rests
on the `Circle Gateway only` row, which re-derives exactly.

> ⛔ **WITHDRAWN 2026-08-27.** This paragraph previously closed: *"The honest population for any
> statement about observed trade is the 19 addresses that declare vanilla settlement — of which
> 18 (95%) show receipts."* **That claim cannot be reproduced from the published artifacts.** Its
> denominator is 19 or 34 depending on a classifier decision that was never saved, and no value is
> substituted, because 95% and 53% each assert a different unverifiable cause. See the correction
> at the head of this section. The narrowing idea may well be right; the number is not available.

## What this does and does not show

**It shows:** x402 endpoints do get paid, at high transaction volume and very low value
per call. It shows that inbound flow is extremely concentrated on a handful of addresses.
⚠️ It does **not** show that most listed sellers are unused — measuring outbound rules out
*withdrawals* as the explanation for the zeros, but not *settlement rail*. See below.

**It does not show:**

- **That every inbound transfer is a purchase.** Funding, refunds and unrelated transfers
  are indistinguishable at this resolution. Every count here is an **upper bound** on
  sales, not a count of them.
- **What any one endpoint earns.** ⭐ **A `payTo` address is usually a whole catalogue's
  till, not one product's.** Measured 2026-08-27 against this census's own address set:
  **50 of the 80 Base `payTo` (63%) serve more than one endpoint**, **96% of the 836 Base
  listings sit behind a multi-endpoint address**, and the largest single address here
  serves **132 endpoints**. One address in the wider Bazaar serves **965 endpoints across
  21 price tiers**. So every per-address figure above is a **catalogue total**, and
  dividing one by any single endpoint's list price is a category error — the mean per
  transfer in particular is the modal price of a seller's *cheapest* products, not a
  discount on its headline one.
- **How many calls were made.** ⛔ **The bound runs the other way too, and both directions
  are real.** Sellers sell **prepaid credits** — one settlement that backs many later
  calls which never touch the chain — and Gateway batching does the same. Transfer count
  is therefore an upper bound on **settlements**, not on calls. The two errors do not
  cancel: inbound can overstate one endpoint's revenue and understate total calls at once.
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

Individual addresses are not named **in this document**. The distribution is the finding; who
occupies which position in it is not.

⚠️ **Amended 2026-08-27:** the per-address and per-listing rows ARE now published, in
`scripts/x402-census/census-2026-08-25.per-address.json`. Withholding them is what made the
withdrawn rail claim above unrecoverable — a conclusion published without the intermediate it
rests on cannot be checked once the source moves. The editorial preference stands for the prose;
it no longer applies to the evidence.
