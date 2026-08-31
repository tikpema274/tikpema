# AUDIT — every claim on tikpema.xyz, checked against the code

**2026-08-31. Read-only. ⛔ THE PAGE WAS NOT CHANGED.** The inventory comes first, deliberately:
a rewrite restates a claim **more confidently**, so an unverified sentence gets harder to spot
afterwards, not easier.

⚠️ **The page is a single hand-deployed HTML file outside the repo** — Netlify site `tikpema`
(`a892e744-9dfc-45df-8cd4-8cd1b0c480b4`), no repo link, no build command, no publish dir.
**Its published deploy is dated 2026-06-26T00:41:28Z — 66 days before this audit.**

---

## ⭐⭐ THE PREDICTION WAS WRONG, AND THAT IS THE MOST USEFUL LINE IN THIS FILE

The audit was commissioned expecting the escrow claim to be **partly false**. **It is true.**
Evaluation gates settlement **structurally**, not advisorily: `job-evaluate-background.mjs:398-420`
computes a verdict and only then calls `complete(...)` or `reject(...)`, tied to the verified
`deliverableHash`. There is no path where a brief settles without a verdict.

🚨 **Why this is worth logging rather than quietly filing as "checked out fine".** The expectation
came from a real track record — copy-ahead-of-code was caught three times in the same week (the plan
card's "live pricing", the citation defect twice). **Three hits made the fourth feel known.** That is
prior, not evidence, and it was pointing at the one claim that turned out to be load-bearing and
sound.

⭐ The failure mode this avoided is specific and expensive: had the audit been skipped and the page
rewritten on the assumption, the rewrite would have **weakened a true claim** — softening escrow
language that the contract actually backs — while leaving the two genuinely shaky ones untouched,
because they read as the careful parts. **A prior that is usually right is the hardest kind to
notice.** [[refuted-by-what-you-read-not-what-you-failed-to-find]]

---

## 🚨 THE STRUCTURAL FACT THE PAGE DOES NOT STATE

Read from the ERC-8183 contract `0x0747EEf0706327138c69792bF28Cd525089e4583` on Arc, 11 jobs:

| job | status | budget | client | provider | evaluator |
|---|---|---|---|---|---|
| 155217 | **Rejected** | 0.25 | `0x4C6dbFda…F320` | `0x4C6dbFda…F320` | `0x4C6dbFda…F320` |
| 155262 | Completed | 0.25 | `0x4C6dbFda…F320` | same | same |
| 155341 | Completed | 1.00 | `0xca4ffd1C…6d0e` | `0xd867647b…9999` | `0xca4ffd1C…6d0e` |
| 156134 → 181295 (8 more) | Completed | 0.20–0.35 | one address | **same** | **same** |

**10 of 11 jobs: one address in all three roles.** `job-run-background.mjs:81` says so plainly —
*"the user's wallet is client, provider AND evaluator (a personal agent that funds its own research
budget)."* The escrow, the state machine and the USDC movement are all real; the **two parties are
not**. "The analyst is paid" and "you're refunded" name two outcomes that credit the same address.

⛔ Not listed as FALSE below, because no sentence on the page asserts the parties are distinct — it
is what the page lets a reader assume. It is the first thing a rewrite has to decide about.

---

## ✅ TRUE

| claim | evidence |
|---|---|
| *"An AI evaluator verifies the deliverable before it settles"* | GATES. Verdict → `complete(uint256,bytes32,bytes)` or `reject(...)`, `job-evaluate-background.mjs:398-420` |
| *"the analyst is paid for good work, or you're refunded"* — payment conditional on the **verdict**, not delivery | delivery moves `Funded → Submitted`; only the judge moves it to `Completed`/`Rejected` |
| a refund path exists **and has fired in production** | job **155217** — app says `rejected/fail`; the contract still says **`status = 4 = Rejected`**, 0.25 USDC, *"Bridge 10 USDC from Arc to Base"* |
| *"The AI prices it — or declines if it's advice rather than research"* | `job-quote.mjs:86` returns `{declined:true, reason}` for advice/opinion/subjective questions |
| *"No seed phrases, no gas"* — **for the path the page describes** | passkey + Circle Modular Wallets, gasless |
| *"ERC-8183 — on-chain escrow & jobs"* | real contract, real `createJob/setBudget/approve/fund/submit/complete/reject` |

⚠️ **What the evaluator actually assesses — exactly two things, and neither is quality.**
`EVALUATOR_SYSTEM_PROMPT`: **(a)** does the brief responsively answer the question, **(b)** are the
cited sources relevant. The rubric explicitly **forbids** judging completeness, depth, actionability,
execution, next steps, or whether the analysis is the best possible — *"If your reason for failing
does not name (a) or (b) explicitly, the verdict is pass."* And it **cannot** check that a source
exists: it has no browsing, and rule 2 forbids failing on non-recognition.

⚠️ **The one production rejection on record was WRONG.** #155217 was refunded for *"does not actually
execute or provide actionable transaction steps"* (not in the rubric) and for sources that
*"cannot be verified"* (it cannot browse; all six URLs were live). The current rules 1–3 exist to
prevent exactly that. **So the sole live exercise of the refund path is a false negative** — the
mechanism fired, and fired incorrectly.

---

## ❌ FALSE, or materially misleading

| claim | what the code does |
|---|---|
| *"Cited sources, every time"* / *"Every answer is cited"* | the gate is `if (noBrief \|\| (uncited && citationEnforcing))`. `RESEARCH_CITATION_ENFORCE` is **unset in production** (checked in the deployed context), so **an uncited brief ships and is paid.** The code's own words: *"uncited briefs will SHIP. This is fail-OPEN by design."* |
| *"commits the deliverable on-chain"* | `submit(uint256,bytes32,bytes)` commits `keccak256(canonicalReport)`. **The bytes live in Netlify Blobs.** The chain proves integrity, not availability |
| *"refunded if it doesn't pass"* | implies every refund is a quality verdict. There are **four** classes, and `jobTimeline.tsx:170` says `judge-rejected` is *"the ONLY class for which a quality judgement was actually made."* `uncited` / `no-brief` / `internal-error` force-reject on a path that **skips the judge, the re-hash and the status guard entirely** |
| *"gasless, no seed phrase"* | true for the agent path, **false for the three self-signed operations** (`#/send-manual`, `#/bridge-manual`, `#/swap-manual`) which require MetaMask, are user-signed and unsponsored. The page never mentions they exist — a false impression of the product rather than a false sentence |

## ⚠️ UNVERIFIABLE FROM CODE ALONE

- **Whether the evaluator is a meaningful check.** It is genuinely a second, tools-less model call on
  the text — but its usefulness is a question about model behaviour, not code.
- **Judge accuracy.** `verify-evaluator-rubric.mjs` replays #155217 against the hardened rubric:
  a regression test on one case, not a measured rate.
- **The settle transaction for #155217.** `eth_getTransactionByHash` returns `null` for `0x025985…`
  on the public RPC. ⭐ The node is live (block 59,766,265; `eth_getCode` fine), so that is pruning or
  absence and the tx index cannot tell them apart. **Contract state settles it instead** — `Rejected`
  is readable today, which is the stronger instrument. [[probe-must-discriminate-between-states]]

## ON *"It's free"* — fair, and it should stay

Quotes are **0.20–0.40 USDC** (`job-quote.mjs:20-21`), real spend from the agent wallet. But the page
says *"It's free, it's play-money"* and stamps **ARC TESTNET · PLAY MONEY** in the hero and footer —
five disclosures in one page. The framing holds. ⚠️ The sentence that breaks on mainnet is not this
one; it is the escrow section, which would then describe a value transfer that still does not happen
between parties.

---

# ⭐⭐ WHAT TO WATCH IN THE REWRITE — NOT THE FALSE ONES

The outright-false claims are easy: they are wrong, they get fixed, nobody argues. **The dangerous
ones are the two that passed.**

### 1. *"Cited sources, every time"* — verified narrower than it reads
Sources are real: `_research.mjs:419-422` **overwrites** the model's `sources` with what was actually
fetched, so a URL cannot be fabricated. That is a strong guarantee — **about existence, not about
presence or numbering.** Enforcement is off, so a brief with zero sources still ships. 🚨 And this
exact area has failed twice: the citation defect recurred, and **index preservation shipped precisely
because it was NOT reliable**. A claim about citations is the one claim on this page with a
two-instance failure history behind it.

### 2. *"Paid for good work"* — the evaluator checks STRUCTURE, not quality
(a) responsive and (b) sources relevant. Depth, correctness, completeness and usefulness are
**explicitly out of rubric**. "Good work" is a quality word for a structural test.

⛔ **Both are defensible as marketing. Both are stronger than the code supports.** A rewrite that
keeps them *because they passed this audit* would be inheriting exactly the confidence problem the
audit exists to catch — the same shape as the wrong prediction at the top of this file, one level up.
**"It passed the check" is not the same claim as "it is true as written", and a rewrite is where that
difference gets spent.**
