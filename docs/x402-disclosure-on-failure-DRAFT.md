# What x402 services disclose when a check fails

> ⛔ **DRAFT — NOT PUBLISHED.** Not linked from `/built`, not posted anywhere.
> Every quoted string has been verified byte-for-byte against the committed
> artifacts in `evidence/competitor/`. It sits here until a decision is made
> about where, or whether, it goes.

An x402 endpoint takes payment and returns an answer. The interesting
question isn't what it returns when everything works — it's what it returns
when one of its inputs was unavailable, and whether the buyer can tell.

I bought one report, made three free calls, and sent two unpaid requests to
a service that refuses anything outside its scope. Everything below is a
live response, and the artifacts are in the repo.

**Disclosure:** I build one of the services measured here. That is why its
section is the shortest, why every claim about it is reproducible from an
unpaid request, and why I've led with its limitation rather than its
behaviour.

## Method

- **402.com.tr** — `deep-dd`, $0.75 USDC, Base mainnet, vanilla EIP-3009,
  2026-08-28. Subject: their own published example token (DEGEN,
  `0x4ed4E862…`). Settlement verified on-chain: payer balance
  2.000000 → 1.250000.
- **402.com.tr** — `rug-score`, `exit-liquidity`, `safe-to-send`, free tier
  (one call per service per day per IP, per their `/.well-known/x402`,
  harvested and committed alongside this piece). Subject: my own Circle
  agent wallet (`0xed96e509…`), deployed on Base hours earlier — a
  smart-contract account with code that is definitively not an ERC-20,
  chosen so the token checks *must* fail.
- **Tikpema DD** — unpaid request, Arc testnet, for a Base-mainnet token it
  cannot analyse.

A degraded response seen by chance shows the state exists. One produced by a
subject chosen to guarantee the failure shows the disclosure fires when it
should. That's why the subject was engineered rather than waited for.

## The finding

The failure-disclosure machinery is real, it reaches actual responses rather
than only documentation — and it is uneven **within a single seller**.

Three endpoints, same operator, same day:

| endpoint | on failure |
|---|---|
| `rug-score` | `degraded: true`, `level: "unknown"`, `refusal: { reason: "upstream_data_unavailable", missing: ["goplus-security-feed (honeypot/taxes)"] }`, `refundable: true` |
| `safe-to-send` | names the skipped factor: `{ level: "skipped", reason: "not applicable — Coinbase verification and Basenames attach to user accounts, not to contracts" }` |
| `exit-liquidity` | `{"error":"No liquidity pool found for this token on Base"}` — 58 bytes, no receipt, no `degraded`, no refusal |

`rug-score` names the exact missing dependency and marks the call
refundable. `exit-liquidity` returns a string. Both are the same operator's
paid endpoints.

That unevenness is the story. It isn't a gap between vendors; it's a gap
inside one.

## What the paid report contains

18 top-level fields against the 8-field free preview — not a superset.
Eleven are new, and one preview field (`risksCount`) does not appear in the
paid report. Five sub-checks with raw evidence, and — this is the part I did
not expect — two sub-checks that state their own scope limits unprompted:

> `exitLiquidity`: "Estimate using constant-product (V2-style) math on total
> pool liquidity; concentrated-liquidity (V3) pools may differ. …"

> `sanctions`: "No direct match on the OFAC list (direct-address match only;
> does not trace indirect exposure)."

Those are coverage statements inside a paid payload — a check saying what it
does not cover. The published tier list says this product carries only a
minimal receipt, and by the letter it does. The disclosure arrives through
its components instead.

**Limit:** this report ran with `degraded: false` and all five sub-checks
returning. It shows what a *successful* report discloses and nothing about a
failed one. That question is unresolved below.

## The question I could not answer

Does `deep-dd` name a failed sub-check, or silently omit it? It has no free
tier, so this is only answerable by buying, and I stopped at one purchase.

The two available proxies point opposite ways:

- `exit-liquidity` is `deep-dd`'s **tier** — and disclosed nothing.
- `safe-to-send` is `deep-dd`'s **shape** (an aggregator over sub-checks) —
  and disclosed fully.

Neither licenses an inference, and the error is available in both
directions: leaning on `safe-to-send` to be generous is exactly as wrong as
leaning on `exit-liquidity` to be harsh. Recorded as unresolved.

One documentation note, because it cuts both ways: the published tier list
*understates* some endpoints — `safe-to-send` is listed baseline and
returned a full receipt — and was *exactly right* for `deep-dd`, measured
from the paid artifact rather than inferred. A generalisation that is false
precisely at the endpoint in question is worse than no generalisation.

## The service I build

**The limitation first: for the token in this comparison, `deep-dd` returns
a report and mine returns nothing.** It analyses Arc testnet only. DEGEN is
on Base. That is a real product limitation, not a framing difference.

What it does instead is refuse in full. Asked about a Base token, it returns
HTTP 400 carrying a complete report:

All nine power groups enumerated individually, each with its own reason.
Nothing silently dropped. Reproducible from an unpaid POST — no payment, no
account.

Two design choices that differ from everything else measured, stated as
choices rather than as advantages:

**It refuses to score.** No 0–100, no verdict. The schema says:
*scope-not-rank: describes what the power can reach. Non-ordinal. MUST NOT
be summed, ranked, averaged or aggregated into a score.* A buyer who wants
one comparable number gets it from `deep-dd` and is explicitly denied it
here. These are opposite products, and which is right depends on what you're
doing with the answer.

**The price is flat, and the reason is published:** "A coverage-scaled price
would pay us more for reporting more coverage — an incentive to overstate
what we actually checked, on the one number you cannot independently audit
before you buy."

I have not compared like with like: this is my service's *failure* path
against theirs on *success*. Their degraded path remains unmeasured.

## What this does and does not show

**It shows:** paid x402 services in this category do disclose failed checks,
in real responses, with structured refusals and a published refund rule.
Anyone writing off the category as having no honesty layer — as I did,
repeatedly, in earlier notes — is wrong. It also shows the disclosure is
inconsistent across endpoints from one seller, so "this vendor discloses" is
not a safe generalisation.

**It does not show:**

- Whether `deep-dd` specifically discloses a failed sub-check. Two proxies,
  opposite answers, unresolved.
- Anything about other sellers. Three endpoints, one operator, one day.
- Anything about how often these failures occur. One engineered failure is
  not a rate.
- **That any of it is verifiable.** Every response measured here is
  unsigned. `inputHash` is self-asserted; the DD refusal is explicitly
  `attestation.status: "unsigned"`, with the stated reason that a rejected
  input leaves no on-chain claim to attest. But that set excludes the one
  path that would be signed — DD's 402 promises an ERC-1271 attestation
  verifiable against the on-chain owner of ERC-8004 agentId 851891, and I
  did not buy a DD report to check it. So the gap is real, and I have not
  measured my own service's answer to it either.

That last one is the gap I'd point at next, and no purchase closes it.
