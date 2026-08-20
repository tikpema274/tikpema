---

# 🚨🚨 REFUTED: THE TWO "INDEPENDENT BLOCKERS" ON THE BUY SIDE DO NOT EXIST

**2026-08-20.** Before writing the NanopaymentPanel copy, I re-probed the seller. **Both blockers
recorded on 2026-08-19 are artifacts of reading `accepts[0]` on a 21-entry menu.** No code changed
between the two measurements; the difference is entirely in how the challenge was read.

## WHAT THE LIVE 402 ACTUALLY SAYS

`POST https://x402.quicknode.com/arc-testnet` (unpaid, read-only) → **402, `accepts[]` with 21
entries** across 9 networks. `accepts[0]` is Base Sepolia at `1000000` atomic. That single entry is
where both recorded blockers came from.

| recorded 2026-08-19 | measured 2026-08-20 |
|---|---|
| "seller's advertised price **1.0 USDC**" | that is `accepts[0]`. **Arc's entry is `100` atomic = 0.0001 USDC** |
| "**100× too expensive**" against the 0.01 ceiling | **100× UNDER it.** The ceiling is not even close to binding |
| "🚨 the chain is wrong — advertises `eip155:84532`" | **`eip155:5042002` IS advertised**, at index 16 of 21 |
| "two independent blockers, so raising the ceiling is not a fix" | neither exists; there was nothing to raise |

⭐ **AND OUR CODE WAS NEVER THE PROBLEM — IT ALREADY SELECTS CORRECTLY.** `_x402.mjs:237` finds
`network === eip155:5042002 && extra.name === "GatewayWalletBatched"`, never falling back to
`accepts[0]`. It matches **exactly one** entry: the Arc one, at 0.0001 USDC. The file even carries
the warning in a comment written months earlier — *"Multi-chain sellers (e.g. QuickNode) advertise
a MENU across many chains/tokens; `accepts[0]` may be a different chain."*

🚨 **THE DIAGNOSIS READ POSITION 0 OF A MENU THE CODE KNEW WAS A MENU.** Same family as the
`Accept`-header truncation and the failed-chunk log sweep: *the read shape was the hypothesis.* An
array index is a filter. ⚠️ And it failed in the direction that looks like diligence — "two
independent blockers" reads as thorough, closes the question, and tells the next person not to
bother raising the ceiling.

## ⚠️ SO WHY HAS THE BUY SIDE NEVER FIRED? THAT IS NOW OPEN AGAIN — AND EVERY GATE I CAN SEE IS CLEAR

| gate | state |
|---|---|
| seller advertises our chain | ✅ `eip155:5042002`, Arc USDC `0x3600…` |
| price vs the 0.01 hard ceiling | ✅ 0.0001 USDC — **100× of headroom** |
| our selector matches it | ✅ exactly 1 entry of 21 |
| `DATA_SELLER_BODY` (QuickNode is request-bound) | ✅ set: `eth_blockNumber` |
| Researcher paused? | ✅ `RESEARCHER_PAUSED` unset |
| signing path for `GatewayWalletBatched` | ✅ option (A) implemented AND proven closed-loop — delegate EOA is `from == signer` |
| the payer's Gateway balance | ✅ **4.864500 USDC** — ~48,000 purchases at this price |

🚨 **I CANNOT NAME A BLOCKER.** That is a finding, not a conclusion that it works — every check
above is a PRECONDITION, and preconditions being met is not an execution. The step may fail
somewhere only a live run reaches, or it may simply never have been ATTEMPTED since the config
settled. ⭐ What is now clear is that "it cannot buy" is unsupported, and it was the reason nobody
tried.

⚠️ **AND WE STILL COULD NOT TELL FROM THE OUTSIDE** — the previously-recorded observability gap is
untouched and is now the binding constraint: the only difference between "bought and used it" and
"never even tried" is a `console.warn`. **That is the thing to fix before guessing again.**

## ⛔ NANOPAYMENTPANEL COPY: NOT WRITTEN, DELIBERATELY

The proposed honest version was *"Built, not yet possible — the seller we point at charges 100× our
ceiling and settles on a different chain."* **Every factual clause in that sentence is now false.**
Shipping it would have replaced an over-claim with a fresh false claim on the same card, which is
the exact defect the card is being fixed for. ⭐ The over-claim ("this runs automatically") is still
wrong and still needs replacing — but the replacement cannot name a mechanism nobody can currently
demonstrate. The narrowest durable form is available regardless: *built server-side, and it has not
bought anything in production yet.*


# ⭐⭐ THE UNGUARDED-CLAIM SWEEP — QUEUED, WITH FOUR FINDINGS ALREADY CONFIRMED

**2026-08-20.** Prompted by the plan card: *"an unguarded claim is one nobody is required to
revisit"* is predictive, not a post-mortem. Method: cross-reference every user-facing surface
against the suites that assert its RENDERED output. ⚠️ Rendering is the bar — a suite that
`readFileSync`s a component is a source scan, which this repo abandoned twice for cause.

## 🚨 FINDING 1 — `NanopaymentPanel` DESCRIBES, IN PRESENT TENSE, SOMETHING THAT HAS NEVER RUN

Worse than the plan card, and the same class. The plan card over-promised a hedge; **this page's
entire content is a capability that has never once executed in production.**

| the page says | the measurement |
|---|---|
| "It **signs** a tiny on-chain USDC payment" | the agent-buys-from-agent step has **never fired** |
| "Only a confirmed settlement counts as a purchase" | no settlement has ever occurred |
| "This **runs automatically** when you commission research" | it cannot run — two independent blockers |
| "Each buy is capped at … **$0.01** max by default" | ⭐ **that ceiling IS blocker #1** — the seller charges 1.0 USDC, 100× over |

⭐ **THE CARD NAMES THE VERY NUMBER THAT BLOCKS IT, PRESENTED AS A REASSURANCE.** Blocker #2 is
unchanged too: `DATA_SELLER_URL` is still QuickNode, advertising `eip155:84532` (Base Sepolia)
while we pay on Arc `eip155:5042002`. **Both re-confirmed from the deployed production env on
2026-08-20**, one day after they were first measured — `DATA_PURCHASE_USDC` is still unset, so the
0.01 hardcoded default is still live.

🚨 **AND THE FILE ALREADY KNEW.** Its own header comment contradicts itself in nine lines: *"the
autonomous mid-research purchase flow that **already runs** server-side"* … *"**When a LIVE version
lands**, this is its spec."* Both cannot be true. The page shipped as a spec and reads as a feature.

## ⭐⭐ FINDING 2 — A GUARD DOCUMENTED COVERAGE IT DOES NOT HAVE (`UbExitStatus`)

`verify-unified-balance-copy`'s header listed `UbExitStatus` among the child components its
whole-rendered-tree checks reach. **Measured: it contributes ZERO CHARACTERS to a 4,152-char
render.** `loading` starts `true` and every claim-bearing branch sits behind a `useEffect` fetch of
`/api/ub-withdraw` that SSR never runs. Five distinct phrases probed, all absent:

* "We finish this automatically — you do not have to come back"
* **"Nothing arrives in your own wallet automatically"** ⭐ the hop-3 caveat — *the most
  load-bearing line in the product now that hop 2 works*, because `completed` means the SCA, not
  the user
* "cannot be cancelled once it begins"
* "not a statement that you have nothing pending" (unreadable ≠ empty)
* "Nothing on its way out right now"

🚨 **THE FAILURE IS SILENT BY CONSTRUCTION: AN ABSENCE CHECK OVER A COMPONENT THAT RENDERS NOTHING
PASSES.** The suite goes green while contributing nothing, and the header asserting otherwise made
it *look* deliberate. The `useGatewayBalance` mock right below it exists for exactly this reason
and was never extended to the fetch. ⭐ **The nastiest shape found: not an absent guard, but a
present one that reports coverage it cannot deliver.** Header corrected today; the fix (mock the
fetch, assert both directions) is QUEUED.

⚠️ **AND IT IS THE THIRD COPY OF A GUARDED CLAIM.** "We finish it automatically — you do not have
to come back" lives in three components. Two are asserted; the third — *the one that renders when
a user actually has an exit running* — is not.

## ⚠️ FINDING 3 — ABSOLUTES ON MONEY PATHS, NO RENDERED GUARD

* **`VaultPanel`** — *"Always available, never blocked by a pause"* (the reclaim path — an absolute
  about escaping a vault), *"Every owner power disclosed above is now held by a different party
  than the one you acknowledged"*, *"⛔ This vault cannot be deposited into"*. Two `always/never`
  absolutes and a consent-delta claim, none rendered by any suite.
* **`DcaPanel`** — the acknowledgement checkbox: *"I understand Tikpema's server will move my
  USDC/EURC automatically while I'm offline, signed by a key it controls…"* ⭐ **THIS IS A CONSENT
  RECORD, NOT COPY.** If it drifts, what the user agreed to drifts, and there is no assertion
  anywhere that it still says what it must. ⚠️ This surface has drift history: the panel 404'd for
  22 days while its notes read "fully verified".
* **`BridgePanel`** — *"A live cross-chain fee … you'll see the exact fee and net arrival"* is a
  live-pricing-shaped claim of exactly the kind just removed from the plan card. Its only coverage
  is `verify-bridge-fee-band`, which `readFileSync`s the component — **source scan, so unguarded by
  this repo's own standard.**
* **`Dashboard`** — *"stop any of them instantly"*, *"The one pocket you can't pull back alone"*.
* **`MyAgentPanel`** (797 lines, the largest surface) — *"always spending only what's in that wallet
  and within your per-action, per-bridge, and daily caps"*, *"the burn is instant"*.

## ✅ FINDING 4 — TWO SURFACES ARE BETTER COVERED THAN ASSUMED

* **DD's discovery page is well guarded**, in two suites: `verify-endpoint` (self-containment, and
  that price/chain/URL match the 402 — plus that the hard terms survive a friendly rewrite:
  "not a clean bill", "incentive to overstate") and `verify-dd-report` (the health banner in every
  state, including that it sits ABOVE the curl). ⚠️ It is also **not a React component** — it is
  server-rendered HTML in `_dd-discovery-page.mjs`, so a components-only sweep misses it entirely.
  **User-facing copy is not confined to `src/`.**
* **`DdReportCard`** has `verify-dd-card-copy`; **`bridgeReceiptStatus`** has `verify-bridge-copy`
  (rendered, both directions).
* ⚠️ **`AgentsPanel` reads as covered and is not** — `verify-activity-fallback` renders ONE row
  subcomponent to check a fallback label. None of the page's claims are asserted.

## ⭐⭐ THE STRUCTURAL FIX — make it a GATE, not a sweep anyone must remember to repeat

This sweep found four real defects in an hour, and its own weakness is that it was run by hand,
once. ⭐ Proposal: a **registry gate** — every component under `src/components` is listed with the
suite that asserts its rendered claims, or explicitly marked `no-claims`. A new file, or a
`no-claims` file that grows a promise, fails the gate. **That converts "nobody was required to
revisit it" into "nobody can add one without saying who guards it."**

⚠️ **AND IT MUST ASSERT THE GUARD ACTUALLY REACHES THE COMPONENT** — Finding 2 is precisely a
registry entry that would have been filled in, truthfully-looking, and wrong. The cheap version:
each registered suite must render a nonempty contribution from its component.


# ⭐⭐ HOP 2 RAN. UNATTENDED. THE EXIT IS NOW PROVEN END TO END — ONCE.

**2026-08-20.** The last unproven branch of the unified-balance exit closed itself while nobody was
watching, which is the only way it could ever have been proven. `16be509f` is `completed`.

| | |
|---|---|
| initiated | `2026-08-12T20:49:12Z`, block 56671240, tx `0x79d06776…` |
| maturity | block 57880840 = **`2026-08-20T00:33:55Z`** |
| completed | block 57884052 = **`2026-08-20T01:01:02Z`**, tx `0xc51ae011…` |
| moved | **1.000000 USDC**, Gateway → the owner's SCA |
| wall clock | **7 d 4 h 11 m** |

## ⭐ FOUR INSTRUMENTS, FOUR DIFFERENT QUESTIONS — not one read repeated

1. **Chain, two independent RPCs.** `withdrawingBalance` 0, `withdrawableBalance` 0,
   `withdrawalBlock` **0** — the slot is cleared, so there is nothing pending AND nothing matured
   sitting unswept. Those are the two distinct failures a single zero would have hidden.
2. **`eth_getLogs`, anchored on the initiation tx.** Exactly ONE Gateway→SCA USDC transfer after
   maturity: 1 USDC at block 57884052. ⚠️ The first attempt at this returned "0 transfers found"
   with **every chunk erroring** (`range too large`, then `rate limit exceeded`) — a clean-looking
   absence produced entirely by a broken instrument. The rewrite prints `chunks ok=27 failed=0` and
   says in words that a non-zero `failed` makes absence meaningless. *A filtered read is not a
   measurement of absence, and neither is a failed one.*
3. **The payout transaction itself.** `to` is the ERC-4337 EntryPoint (correct for a Circle SCA,
   not the Gateway); inner calldata `b61d27f6` execute → Gateway → **`0x51cff8d9` = `withdraw(address)`**
   with USDC. Status 1. This is the PURPOSE check — a transfer alone would only have proved value moved.
4. **Our own record.** `state:"completed"`, `completeTxHash` = **the same hash the chain search
   found independently**, `completedAt` matching the block timestamp to the second.

## ⭐⭐ THE TIMING IS THE ATTRIBUTION — this is what makes it the SWEEPER and not a human

Maturity `00:33:55Z`. The sweeper is `*/30`. The `00:30` tick fell **3 m 55 s before** maturity and
correctly returned `not-yet-matured`; the `01:00` tick completed it **62 seconds later**. Nobody
lands within a minute of the top of the hour. ⭐ And the mechanism corroborates the clock:
`ub-withdraw-sweep` is the ONLY caller of `ubCompleteWithdrawal` and the ONLY writer of
`completeTxHash` — grep confirms no manual complete path exists to confuse it with, and the function
is not HTTP-invokable. Heartbeat live at `08:00:43Z`, `open:0`.

## ⚠️ TWO MEASUREMENTS ABOUT ESTIMATES, BOTH IN THE SAME DIRECTION

* `maturesApprox` recorded `2026-08-19T23:13Z`. Real maturity: `2026-08-20T00:33:55Z` — **80 minutes
  late.** The delay is in BLOCKS; block time drifted. Exactly the failure the "never a precise
  deadline" rule was written against, and it happened on the very first run.
* The round trip took **7 d 4 h** against a 7.1-day estimate. ⭐ "Treat the wait as the floor, not
  the ceiling" is no longer a precaution — it is a measurement.

## 🚨 IT IS *ONCE*, NOT TWICE — the store holds ONE record

The whole `ub-withdrawals` store is one withdrawal plus the heartbeat. What changed is not the
COUNT, it is what "done" MEANS: the page's "done once" sat directly after *"we finish it
automatically — you do not have to come back"*, and **the automatic finish had never happened**. The
sentence was reading as evidence for the one claim nothing supported. Now it isn't.

⭐ Copy updated at all three rendered sites (`YourMoney` ×1, `UnifiedBalancePanel` ×2): *"done once,
**end to end**: 1 USDC asked for on 2026-08-12 and returned automatically on 2026-08-20, with nobody
watching — one real run, not a track record. It took 7 days and 4 hours, longer than the estimate."*
⚠️ `one real run, not a track record` is KEPT verbatim — the evidence got stronger, not thicker.

**Guard**: `verify-unified-balance-copy` 33/0, and the new `/end to end/` assertion scores **0/1 and
0/2 against the pre-fix copy**. The 33 is only worth what that 0 proves.

# ⭐⭐ "WITH LIVE PRICING" IS GONE — the fifth deferral did not happen

`PlanPanel.tsx` promised *"a concrete plan — with live pricing"* on the card a buyer reads **before
paying**, while the artifact delivered **after** hedged with *"fees may be disproportionately
large"*. Ending 2 of the recorded decision, taken as recorded.

## ⭐ WHY NOT SIMPLY DELETE THE PHRASE — the asymmetry is real and moves

* **Bridge** — our own timestamped fee table is injected as grounding (`8c1d1e9`), so a bridge brief
  CAN state a measured figure.
* **Swap** — `createSwap` has returned `No route available` since ~2026-08-14, so a swap cannot be
  priced at all.

Promising pricing flatly is false for swaps; promising none understates bridges; **naming the
drought rots the day it lifts.** ⭐ So the new claim is about CONDUCT, not coverage: *"Where a fee
can be measured, it is quoted as a measured figure with its timestamp; where it cannot, the agent
says so rather than inventing a number."* True on both sides of the outage.

## 🚨 AND THE REAL FINDING: **NOTHING GUARDED THIS CARD AT ALL**

No suite rendered `PlanPanel`, no suite mentioned it. That is why a false promise survived four
deferrals — **an unguarded claim is one nobody is required to revisit.** The unified-balance copy has
been wrong five times and has a guard; this card was wrong once, for longer, and had none.

New `scripts/verify-plan-card-copy.tsx`, wired into `npm run test:copy`. Renders the component and
asserts BOTH directions with exact counts. **10/0 on the fix; 4 failures against the pre-fix card —
two present-checks and two absence-checks, so both halves of the guard are shown to discriminate.**
⚠️ It also asserts the lead paragraph EXISTS, because an empty render passes every absence check.

# STATE

* Deferred no longer, but **NOT DEPLOYED** — prod `6a86a72be0a892f00ca72d44` still shows the old
  copy on both cards. Bundling budget ~30 min; run `npm run gate:deployed` after.
* `npm run build` clean; `test:copy` 33/0 + 10/0; `test:disclosure` 20/0.
* ⏳ **OPEN — the one thing no gate can prove:** whether `cannot_execute` actually RENDERS on a real
  swap job. `ce58631` is live (`364fab3`) but only a real job exercises the state. Requires a
  passkey, so the user runs it: header must read *"No action taken · this cannot be carried out
  right now"*, NOT *"your analysts disagreed"*.
* ⚠️ Still queued from the previous handoff, untouched: **Analyst A failing has no state** — it
  collapses to `no_action`, indistinguishable from A deliberately proposing nothing. Same defect
  `ce58631` fixed, one analyst over.
* ⭐ Hop 3 is still the user's: `stillNeedsAgentWithdraw: true`. Funds are in the SCA, NOT with the
  user, and nothing renders "your money is back" from `state === completed` alone.


# 🚨 HANDOFF — THE SWAP DROUGHT IS AN OUTAGE, AND EVERYTHING DOWNSTREAM WAS CALLING IT A DISAGREEMENT

**2026-08-20, written at 98% context, before the deploy of `ce58631`.** Every number here was
measured this session; where something is inferred rather than confirmed it says so.

## ⭐⭐ ITEM 1 — WHY NOTHING HAS SWAPPED SINCE ~14 AUGUST

**Circle's `createSwap` returns `Route or resource not found. Details: No route available.`** for
USDC↔EURC on Arc testnet. Identical text on **five consecutive swap jobs** (180679, 181044, 181056,
181164, 181171), across both directions and 4–5 USDC.

Analyst B is behaving **correctly**: it refuses to endorse a trade that cannot be routed. Nothing
downstream is broken — `job-swap-approve` and `executeAction` are complete and correct, they are
simply never reached, because a user can only approve a proposal that exists.

⭐ **THE ADAPTER WAS VERIFIED, PRESENCE *AND* PURPOSE:**

| | |
|---|---|
| proxy `0xbbd70b01…` | 813 bytes, byte-identical on two independent RPCs |
| EIP-1967 implementation | `0xb4d0aa6c…`, 17,729 bytes |
| distinguishing selectors | `owner()` ✅ `paused()` ✅ — a real contract with a real ABI |
| `paused()` | **false**, agreed by both RPCs |
| `owner()` | `0xfbc171f3…`, agreed by both RPCs |

⚠️ **`eth_getCode` alone would have proved PRESENCE, NOT PURPOSE** — something else could be
deployed at that address. The selector probe is what makes this evidence. ⭐ And the first probe
found 0/6 selectors, which looked like "wrong shape" and was actually **a proxy** — the same misread
made against the ERC-8004 registry earlier in the week. Check for EIP-1967 slots before concluding.

**Our side did not change:** `_swap.mjs` last touched **2026-07-22**, well before the drought.
`job-swap-approve.mjs` was touched 2026-08-13 — one day before, close enough to check — but all
three commits are error-handling changes (503 provisioning, catch narrowing) and that file runs
*after* a proposal exists, which is not where the refusal happens.

🚨 **"THEIR SIDE" IS INFERRED, NOT CONFIRMED.** Every way it could be ours has been eliminated;
there is no statement from Circle. Those are different claims. ⭐ If the drought persists, this
rides along with the recovery-file ticket as a concrete question: *"USDC↔EURC on Arc testnet has
returned `No route available` since ~14 August — is routing withdrawn, or is our call shape wrong?"*

## ⭐⭐ ITEM 2 — `ce58631`: SIX REFUSAL STATES, CLASSIFIED FROM A TYPED CAUSE

All refusals used to return `verdict:"refuse"` → `agreement:"hard_disagree"`, and the panel said
**"No action proposed · your analysts disagreed"** and **"this is the safeguard working, not a
failure."** Both are FALSE for an outage: nobody disagreed (A wanted the trade, B said the venue was
down), and something IS failing — just not us and not the user. A buyer reads it and concludes the
action was DEBATABLE when it was IMPOSSIBLE.

**The shape to preserve:**

* 🚨 **THE CAUSE IS TYPED AT THE CATCH SITE** in `_analystb.mjs`, where it is known exactly, and
  travels as a field. It is NEVER re-derived by matching B's prose downstream — that breaks the
  first time B rewords, and a test asserting on the same sentence would pass *while the classifier
  read that sentence too*, both wrong together and mutually confirming.
* Three causes among refusals: `cannot-execute` → `cannot_execute`, `should-not-execute` →
  `hard_disagree`, `malformed-proposal` → `not_actionable`.
* ⚠️ **AN UNTAGGED REFUSAL FALLS TO `hard_disagree` — THE PRE-EXISTING BEHAVIOUR — DELIBERATELY.**
  A missing tag must never silently become an *outage claim*. Verified.
* ⭐ **DIFFERENT COPY PER STATE, not just a different enum.** Renaming the state and keeping the
  disagreement wording would have renamed the problem. `hard_disagree`'s words are unchanged, and
  the guard asserts the outage copy does not leak into it either.

`npm run test:refusalstates` — 14/14 on the fix, **6 failures against the pre-fix component**, which
is what makes the 14 mean anything.

## ⚠️ ITEM 3 — TWO QUEUED, NEITHER STARTED

**(a) ANALYST A FAILING HAS NO STATE.** If A errors there is no proposal, so `no_action` fires —
*"No action was proposed, so there was nothing for me to price."* That is **indistinguishable from A
deliberately proposing nothing**. The same collapse `ce58631` just fixed, one analyst over, and
untouched because it is a different code path. ⭐ B being unavailable already has its own state
(`unverified`, with its own copy); A does not.

**(b) THE CARD STILL PROMISES "a concrete plan — with live pricing".** Bridges now get our own
timestamped fee table injected as grounding (`8c1d1e9`), so bridge briefs can price from our
measurement. **Swaps cannot be priced at all while routing is down**, so for swaps the claim is
currently unmet by circumstance rather than by design. ⚠️ Recorded earlier as ONE decision with two
honest endings — quote our own path, or stop claiming it — and doing neither leaves the overclaim.

## STATE AT HANDOFF

* HEAD `ce58631`, tree clean, **pushed through `779392d`**; `ce58631` itself is unpushed and
  undeployed at the time of writing.
* Prod is `6a864182609c575ff408fb57`. ⚠️ `ce58631` is NOT in it.
* ⭐ **Both spend-ledger silences are live-closed**: `[budget][ledger-write-failed]` (a lost write
  WIDENS the day ceiling) and `[budget][audit-row-unreadable]` (a dropped row LOWERS displayed
  totals). A spend could previously vanish at either end with the page looking normal.
* `gate:rpc` 8 healthy. `base`'s dead primary (`sepolia.base.org`, 0/5, `-32011 no backend`) was
  replaced with Tenderly and has held three deploys. ⚠️ `ethereum` degraded then recovered on its
  own — watching it was right, expecting it to follow `base` was not.
* ⏱ **Bundling: fourteen measurements, 19m23 – 44m29.** Still noisy, not growing. Treat any single
  run as a FLOOR.
* ⚠️ **`capture:window` will keep reporting NO WINDOW** — nothing in this batch touches
  `DD_SURFACE_DIRS/FILES`, so `ddTree` does not rotate. Correct, not a regression.

## ⭐ THE METHOD THAT FOUND ALL OF THIS, WORTH KEEPING

**Run every new guard against the code it was written to catch.** `8/8` is a number with no
information in it — a guard that always passes scores 8/8. `5/8` against the pre-fix version is what
makes the 8 mean something. It caught a fail-open *inside a guard* twice this session: an ordering
assertion satisfied by absence (`indexOf` returns −1, and −1 is less than everything), and a
citation check that matched the prose it was checking against.

🚨 **AND THE HARNESS KEEPS GETTING INSIDE THE MEASUREMENT — four times in one session:** a `pgrep`
matching its own command string (twice, the second time defeating the `[d]` bracket trick because
the same command line also contained the literal), a monitor exiting on a sentinel the wrapper
itself echoed, and the citation guard above. ⭐ Ask of any check: *what would this print if the thing
I am checking for were absent — and could it print that for another reason?*


# ⭐⭐ ONE DECISION, NOT TWO: "WITH LIVE PRICING" vs "FEES MAY BE DISPROPORTIONATELY LARGE"

**2026-08-19. Deferred three times now.** These are not two items. They are the same gap seen from
each end, and doing neither leaves the overclaim standing.

| | |
|---|---|
| **The card promises** (`PlanPanel.tsx:129`) | "…proposes a concrete plan — **with live pricing**." |
| **The report delivers** (job #181044) | "fees **may be** disproportionately large" |

🚨 **THE HEDGE IS ABOUT THE ONE NUMBER WE CAN MEASURE EXACTLY.** Not an FX rate from a third party,
not a forecast — the cost of a swap we would execute ourselves, through a quote path this codebase
already runs.

## ⭐ AND THE "MEASURE IT" ENDING IS CHEAPER THAN IT LOOKED

`netlify/functions/_swap.mjs:134` already exports it, and its own comment says so:

```js
// ⭐ estimateSwap is FREE … Priced against the USER'S OWN wallet (walletAddress),
//    so the quote is the one that wallet would get.
export async function estimateSwapOnly({ walletAddress, tokenIn, tokenOut, amountIn })
```

So the work is not "build a pricing path". It is calling one that exists, for free, against the
wallet that would actually pay.

⚠️ **THE REAL COST IS PARSING, NOT PRICING.** `estimateSwapOnly` needs `tokenIn`, `tokenOut` and
`amountIn`; the research path receives free text ("convert 5 EURC"). Extracting a token pair and an
amount reliably enough to put a NUMBER in a paid deliverable is the actual work — and a wrong number
is worse than an honest hedge. ⭐ That is the argument for the copy ending being the safe default,
not merely the lazy one.

## THE TWO HONEST ENDINGS

1. **Make the claim true.** The report quotes our own swap path and states the fee as a measured
   figure with its own timestamp, the way CoinGecko's price already arrives
   ("usd-coin $0.999665 as of 2026-08-19T12:50:30Z"). ⚠️ Requires reliable token/amount extraction,
   and a REFUSAL when extraction is ambiguous rather than a guessed pair.
2. **Stop claiming it.** The card drops "with live pricing" and says what the product actually does
   — researches economics from cited sources and proposes a plan. **~1 hour**, no money-path change,
   no new failure modes.

⭐ **DOING NEITHER IS THE ONLY OPTION THAT IS WRONG**, and it is the one three deferrals have chosen
by default. A card that promises live pricing next to a report that says "may be" is the
advertised-vs-delivered gap this codebase refuses everywhere else — it is the same defect class as
x402-quote's "real-time feed" label over canned values, which was fixed, and as DD's coverage
manifest existing precisely so a thin report cannot read as a full one.

⚠️ **AND IT IS NOT A COPY NIT.** The claim is on the card the buyer reads BEFORE paying, and the
hedge is in the artifact they receive AFTER. That ordering is what makes it a mis-sale rather than a
disappointment.


# 🚨🚨 THE AGENT-BUYS-FROM-AGENT STEP HAS NEVER FIRED IN PRODUCTION

**2026-08-19.** The sell side is proven — the DD service takes real x402 payment, settles through
Gateway, and withholds the artifact until the money lands. **The BUY side has not happened once.**
Every research brief this product has ever sold was synthesised from Exa alone.

## THE MEASUREMENT

`_research.mjs:maybeBuyData` gates a purchase on an absolute per-buy ceiling and then on percentage
budgets. Measured against the seller actually configured in production
(`DATA_SELLER_URL = https://x402.quicknode.com/arc-testnet`), via an unpaid 402 probe:

| | |
|---|---|
| seller's advertised price | **1.0 USDC per call** (`1000000` atomic) |
| absolute per-buy ceiling | **0.01 USDC** (`DATA_PURCHASE_USDC` unset on prod → hardcoded default) |
| ratio | **100× too expensive** |

| job price | allowance (30%) | per-buy cap (50%) | can buy at 1.0? |
|---|---|---|---|
| 0.20 | 0.060 | 0.030 | **NO** |
| 0.30 | 0.090 | 0.045 | **NO** |
| 0.40 | 0.120 | 0.060 | **NO** |
| 0.60 | 0.180 | 0.090 | **NO** |

⭐ **NOT A BOTTOM-OF-BAND PROBLEM — A WHOLE-BAND ONE.** The ceiling bites before the percentage gate
even runs, so no price anywhere in the band has ever cleared it. Lowering the band to [0.20, 0.40]
neither caused this nor revealed it; it was already total.

🚨 **AND A SECOND, INDEPENDENT BLOCKER: THE CHAIN IS WRONG.** QuickNode's challenge advertises
`network: eip155:84532` (Base Sepolia) with Base Sepolia USDC. We pay on Arc testnet,
`eip155:5042002`. Even at an affordable price the authorization could not be constructed against
that challenge. ⚠️ Two independent blockers means fixing either one alone changes nothing — and it
is why "just raise `DATA_PURCHASE_USDC`" is not a fix.

⚠️ The in-repo stand-in (`x402-quote`, 1000 atomic = 0.001) fits under the ceiling comfortably. The
ceiling was calibrated against the stand-in and never revisited when prod was pointed at QuickNode.
**A default that was correct for a test seller became a silent kill-switch for a real one.**

## ⭐⭐ THE STRATEGIC WEIGHT, STATED PLAINLY

This is the **agent-buys-from-agent** step — the core of the two-sided thesis. An agent that can
only SELL is half the claim; the thing that makes the marketplace real is an agent deciding, within
a budget, to spend its owner's money on another agent's data. **That has never happened in
production.** It is not a pricing detail and does not belong in a footnote to one.

⚠️ **AND WE COULD NOT HAVE KNOWN FROM THE OUTSIDE.** Every job completed. Every brief cited sources.
The pipeline showed Funding → Researching → Evaluating → Settled. The only observable difference
between "bought data and used it" and "bought nothing and never could" was a `console.warn` in a
function log nobody reads. ⭐ **The product looked identical in both worlds.**

## WHAT WAS BUILT — DISCLOSURE, NOT A PRICE FIX

`111fe4a`. A closed outcome set with **`unclassified` as the DEFAULT**, so an exit nobody enumerated
is loud rather than silent — the ceiling case being exactly such an exit. Reported in BOTH halves:
`dataPurchase` (structured record) and `dataDisclosure` (the sentence the buyer reads), the latter
**inside the hashed canonical report**, on the same argument that puts DD's coverage manifest inside
the signed payload: a statement that a brief rests on web sources alone is worth exactly as much as
its inseparability from the brief.

## ⛔ WHAT WAS DELIBERATELY *NOT* DONE

**`DATA_PURCHASE_USDC` was NOT raised.** At 1.0 USDC against a 0.20–0.40 job the data costs **more
than the job** — the agent would spend 2.5–5× the fee to answer it. Combined with the chain
mismatch, raising the ceiling would convert a silent no-op into a silent overspend, which is worse.
🚨 **Whether that seller is viable at all is a product question, not a config nudge**, and making it
by editing an env var is how an agent starts paying 1.0 to fulfil a 0.40 job.

## 🚨 CORRECTION TO `111fe4a` — IT CLAIMED A SENTENCE NO BUYER COULD READ

The commit message for the disclosure feature says *"`dataDisclosure` is the sentence the BUYER
reads"* and *"a disclosure only a source-reader would see is not one"*. **Both were false of what
shipped.** The field went into the canonical report, was covered by the deliverable hash, and
deployed with **ZERO renderers** — `grep dataDisclosure src/` returned nothing.

⭐ **THE RECORD HALF IS LIVE AND CORRECT** — `dataPurchase.code = ceiling` is real, queryable, and
matched the pre-registered prediction. Saying only that would have been honest. Claiming the reader
half was the overclaim, and it is exactly what this feature exists against.

⭐⭐ **AND THE HASH DIFFERENTIAL DID NOT CATCH IT, BECAUSE IT CANNOT.** Removing the field changes
the `deliverableHash`, so **transit tampering** is detectable — a real guarantee, and the wrong one.
It is silent on whether any renderer projects the field. **Two guarantees; one established, the
other assumed.** The assumption is the whole error: I proved the property that was easy to prove and
reported the property that mattered.

⚠️ **SECOND OCCURRENCE IN TWO DAYS.** 2026-08-17: `errata_note` written into `VERSIONS`, dropped by
dd-openapi's projection, reached nobody. 2026-08-19: `dataDisclosure` written into the report,
dropped by the absence of a renderer, reached nobody. Same shape, different file, and the second
happened *while the first was fresh in the same session*. ⭐ **Knowing the rule did not prevent
repeating it** — the failure was not ignorance, it was stopping at the first proof that looked
sufficient.

## ⭐⭐ TWO PORTABLE RULES OUT OF THE GUARD'S OWN BUG

**1. AN ORDERING ASSERTION ON INDICES IS SATISFIED BY ABSENCE, UNLESS PRESENCE IS ASSERTED FIRST.**

```js
iD < iA                       // ⛔ passes when the item is MISSING: indexOf returns -1
iD >= 0 && iA >= 0 && iD < iA // ✅ ordering only where both exist
```

`-1` is less than everything, so "X appears before Y" is trivially true whenever X does not appear
at all. ⚠️ This is not a React or a testing quirk — it applies to any `indexOf`/`findIndex`/`search`
comparison, in any language with a sentinel-index convention, and it fails in the reassuring
direction: the layout check goes green precisely when the thing being laid out is gone.

**2. A GUARD VALIDATED ONLY AGAINST THE FIXED CODE PROVES NOTHING. RUN IT AGAINST THE BROKEN ONE.**

`8/8 on the fixed component` is a number with no information in it on its own — a guard that always
passes scores 8/8 too. What makes it mean something is **`5/8` against the pre-fix component**: the
guard fires on the defect it was written for, and stays silent otherwise.

⭐ **AND IT IS WHAT CAUGHT THE FAIL-OPEN.** The ordering bug was invisible while testing the fixed
version — it passed, as it does. It only appeared when the guard was pointed at the code that
lacked the field, printing `disclosure@-1` beside a green tick. **Reading the guard would not have
found it; running it against the broken version did.**

⚠️ **THE STANDING PRACTICE, THEREFORE:** every new guard is run against the state it was written to
catch, before it is trusted. Where the broken state no longer exists, reconstruct it —
`git show HEAD:<file>`, a mutated copy, a fixture with the field removed. This session used the same
technique three times: the AMBER branch in `verify-operator-count.mjs`, the drift branches in
`_pinned-set.mjs`, and here.

Fixed at `98eb788`, with a RENDERED guard (`npm run test:disclosurerender`) rather than a source
grep — because "the string appears in a .tsx" passes the day it is written and forever after,
including through a refactor that deletes the JSX and leaves the type.
🚨 **AND RUNNING THAT GUARD AGAINST THE PRE-FIX COMPONENT EXPOSED A FAIL-OPEN INSIDE THE GUARD:**
the ordering assertion was `indexOf(disclosure) < indexOf(answer)`, which **passed when the
disclosure was absent** — `-1` is less than everything. An ordering check satisfied by absence, in
the suite written against exactly that. Caught by RUNNING it against the broken version, not by
reading it. **8/8 on the fixed component, 5/8 on the pre-fix one.**

## ⭐ PRE-REGISTERED EXPECTATION FOR THE NEXT JOB — WRITTEN BEFORE IT RUNS

Deployed `6a858997c8bdc5178445c9d5` on 2026-08-19. **No job has run since**: `netlify logs --source
functions --since 6h` returns "No logs found", so the disclosure path has executed ZERO times in
production. Everything below is a prediction, not an observation.

| what to read | where | **expected** |
|---|---|---|
| `dataPurchase.code` | the stored job record | **`ceiling`** |
| `dataDisclosure` | inside the canonical (hashed) report | "⚠️ No paid data was purchased… advertised 1 USDC exceeds the absolute per-buy ceiling of 0.01 USDC" |
| `[research][outcome-unwired]` | function logs | **silent** — both caller branches populate the outcome |

🚨 **IF `code` IS ANYTHING OTHER THAN `ceiling`, THAT IS NOT GOOD NEWS UNTIL EXPLAINED.** The seller
advertised 1.0 USDC against a 0.01 cap when measured; a different code means the seller, the
`DATA_SELLER_URL`, or `DATA_PURCHASE_USDC` moved since. ⭐ Especially `purchased` — that would mean a
real spend happened on a path measured as impossible, and the first question is what changed, not
whether to celebrate.
⚠️ And `unwired` firing would mean a third code path exists that neither of us wrote.

⭐ **THE PREDICTION IS RECORDED FIRST ON PURPOSE.** A result read against a stated expectation is
evidence; the same result read afterwards is a story. This session already produced two cases where
a number arrived without provenance and was reasoned about as if measured.

## ⚠️ RPC REDUNDANCY — BASE HAS NOW DEGRADED, RECOVERED, AND DEGRADED AGAIN

Across three deploys on 2026-08-18/19: `base 1/2` → recovered `8 healthy` → `base 1/2` **and**
`ethereum 1/2`. Transient 503s each time; `gate:rpc` warns rather than fails, which is correct.

🚨 **BUT BASE IS THE MOST-USED BRIDGE DESTINATION IN THE RECEIPTS**, and single-endpoint mint
verification there is precisely the shape that produced the twelve-day Polygon `rpc_error`: one
surviving endpoint, a verification that cannot be corroborated, and a failure that reads as a chain
problem rather than an instrument problem. ⚠️ **A line, not an action** — but if `base` degrades on a
fourth consecutive deploy, that is a pattern rather than weather, and the second endpoint is worth
replacing before it is needed.

## OPEN, RECORDED, NOT BUNDLED

* ⚠️ **`budgetUsdc` is a JavaScript FLOAT on a money path.** `Math.round(x*100)/100` in the quote,
  converted to atomic downstream in `_budget.mjs`. The exact inverse of the DD pattern, where atomic
  is the source of truth and renderings derive from it. A correctness fix, not a pricing one.
* ⚠️ **The ceiling default (0.01) is calibrated to a seller we no longer use.** Either re-point at a
  seller priced for this market, or restate what the ceiling is for.
* ⚠️ **A quote-time disclosure of fee-vs-stake is NOT buildable as asked.** On job #180679 the FX
  gain (~0.70–0.78 USDC on 5 EURC) appeared in the RESEARCH OUTPUT — after the fee was quoted and
  paid. Stating the proportion at quote time would require estimating the gain before researching
  it. ⭐ That is a genuine design problem, not a copy change, and it is the honest reason the
  bridge-band comparison does not port over directly.


# ⚠️ THE RECOVERY FILE IS STILL SINGLE-COPY — AND `gate:recovery` GOING GREEN IS WHY THAT IS DANGEROUS

**2026-08-19.** `npm run gate:recovery` passes. **That does not mean this item is done**, and the
green run is precisely what would make a later reader think it is.

## WHAT IS ACTUALLY TRUE

* ✅ The real file is intact: `recovery_file_1781206891750.dat`, 144 chars, sha256 `3adb019b8055…`,
  pinned and re-checkable offline.
* ✅ The decoy is defused: a **0-byte `recovery_file.dat`** — the name anyone grabs in an emergency —
  renamed to `*.EMPTY-DO-NOT-USE-2026-06-11`. Written 21:44, three minutes AFTER the real file at
  21:41, almost certainly by Circle's own docs example whose `?? ""` writes an empty file silently.
* 🚨 **THERE IS STILL EXACTLY ONE COPY**, on one disk, in one directory.

## ⭐⭐ A CHECKER IS NOT A BACKUP, AND CONFLATING THEM IS THE WHOLE RISK HERE

A validator on a single-copy file **detects loss; it does not survive it.** Worse, the disk that
dies takes the checker with it — the instrument and the artifact share a failure domain, so the
alert that would tell you it is gone dies at the same instant.

⚠️ **AND A SCHEDULE WAS THE WRONG NEXT MOVE.** It would have produced a weekly green tick against a
single point of failure — the most reassuring possible output for the least protected possible
state. Held deliberately. ⭐ **A monitor over one copy measures how quickly you learn about a loss
you cannot undo. A monitor over two copies measures DIVERGENCE, which is a thing you can act on.**
The schedule earns its keep only after the second copy exists, and it also needs somewhere to send
an alert or it is a log nobody reads.
⚠️ It could never have run on Netlify regardless: the file lives at `~/Arc-tikpema/tikpema-dev/`,
which no scheduled function can see. Local cron or a systemd timer, with a real notification path.

## THE OPEN ACTION — OFFSITE COPY, AND IT CLOSES THE ITEM OUTRIGHT

⭐ **Possession is confirmed sufficient**: the Circle SDK writes the API's base64 response verbatim,
with **no password step and no encryption** (`registerEntitySecretCiphertext` → `writeFileSync`). So
the file must be protected exactly like the Entity Secret itself — and a password manager entry is
therefore both the right home and a complete fix, not a partial one.

⚠️ Store it as a **file attachment or a verbatim text field**. It is base64: a manual retype or a
line-wrapping paste corrupts it, and the corruption passes casual inspection because base64 still
*looks* like base64. Verify any new copy with `RECOVERY_FILE=<path> npm run gate:recovery` — the
sha256 pin is what proves a copy is the SAME file rather than merely a well-formed one.

## WHAT REMAINS UNKNOWABLE LOCALLY, AND IS WITH CIRCLE

`gate:recovery` checks FORM and IDENTITY, never CURRENCY or AUTHENTICITY — a file deprecated by an
Entity Secret rotation passes every check perfectly, because deprecation is server-side and does not
touch the bytes. The documentary case narrows that (no rotation recorded as of 2026-08-19; rotation
is a deliberate act, not drift) but does not close it. **Only Circle's answer on whether the Console
upload validates before committing would make acceptance testable without spending the reset.**


# 🚨 MULTI-NETWORK PAYMENT: THE SETTLE-GATE READS **ONE CHAIN'S** LEDGER — ANSWERED WITH ZERO SPEND

**2026-08-18.** Circle's agent-readiness score. The multi-network question was the only one worth
measuring, and it resolved structurally — **no draft deploy, no probe payment, nothing moved.**

⚠️ **CORRECTED 2026-08-19: THE SCORE IS 95/100, NOT 72.** This entry was written against 72, a
figure I recorded from a verbal report and never saw myself — the page is a browser tool I cannot
read. It has been **95 since the spec deploy**, and the **ONLY scored gap is "Accept payment on 2+
networks"**. The bare-POST 400 and mpp are **NOT costing points**: they were already priced in, so
declining them costs nothing numerically. My "two gaps chosen" framing was arguing a trade-off that
did not exist.
⭐ **THE DECLINES WERE RIGHT AND THE ARITHMETIC AROUND THEM WAS WRONG** — which is the more useful
half to record. A reason that stands on its own does not need a scoreboard to justify it, and
dressing it in one made it look contingent on a number I had not verified. ⚠️ I also treated a
number reported to me as measured, in a session that spent the whole day insisting on the
difference. **Provenance applies to figures from humans too — mark them as reported until seen.**

## THE MEASUREMENT

`_x402-confirm.mjs:readGatewayBalance` calls `availableBalance(token, depositor)` on GatewayWallet,
over an **Arc** RPC. Gateway ledgers are **PER CHAIN**:

| chain | GatewayWallet | payTo `availableBalance` |
|---|---|---|
| **Arc testnet** | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` | **120000 atomic (0.12 USDC)** — two sold reports |
| **Base Sepolia** | `0x0077777d…` — ⭐ SAME ADDRESS | 0 |
| **Base mainnet** | `0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE` — DIFFERENT | 0 |

🚨 **A PAYMENT MADE ON BASE WOULD CREDIT BASE'S LEDGER AND OUR GATE WOULD NEVER SEE IT.** The buyer
pays, `confirmPayment` polls Arc, the balance never rises, the report never settles and is never
served. Worse than a refusal: money leaves and nothing arrives.

⭐⭐ **CIRCLE USES ONE GATEWAY ADDRESS ACROSS ALL TESTNETS AND ANOTHER ACROSS ALL MAINNETS**, so our
hardcoded `GATEWAY_WALLET` is *already correct* for Base Sepolia. **THE ADDRESS IS NOT THE
DISCRIMINATOR — THE RPC IS.** A reader who "verified the contract address matches" would conclude
cross-chain works. It does not. The constant being right is exactly what makes this trap quiet.

## ⭐ THE FIX IS SMALLER THAN EXPECTED — THE CONFIRM PATH IS ALREADY PARAMETERISED

`readGatewayBalance({ rpcCall, payTo, token = USDC, gateway = GATEWAY_WALLET })` takes the RPC
**injected** and token/gateway as arguments. Whoever wrote it made it chain-agnostic without needing
to. So multi-network needs the CALLER to pass the paying chain's RPC + USDC — not a rewrite.

⚠️ What is genuinely missing: the pending record must store WHICH CHAIN a payment arrived on, the
baseline snapshot must be per-chain (an aggregate baseline across chains is meaningless), and
`accepts[]` needs one entry per network. Real work, well-scoped, no redesign.

## ⚠️ AND A CATEGORY ERROR TO AVOID: BASE **MAINNET** PAYS FOR AN **ARC TESTNET** SERVICE

The buying wallet is funded on Base mainnet. This service analyses Arc **testnet** contracts. Taking
REAL USDC for testnet analysis is not a pricing question, it is a mis-sold product — and `x-guidance`
says "Arc testnet only — not a mainnet service" precisely so a buyer bounces first. Base **Sepolia**
is the honest pair; Gateway is deployed on 15 chains including six testnets
(ARB/BASE/ETH/OP/UNI-SEPOLIA + ARC-TESTNET), so the testnet pairing exists.

## ⭐ WHY THIS COST NOTHING: THE STRUCTURAL QUESTION WAS SEPARABLE FROM THE PLUMBING

The plan was a draft deploy plus a real sub-cent probe. Neither was needed. "Does a Base payment
credit the balance we poll?" is answerable by reading TWO CONTRACTS — and the answer is no, because
they are different ledgers. ⭐ **Ask what the cheapest instrument that could refute the claim is,
BEFORE building the expensive one.** A spike that spends money to learn something two `eth_call`s
already know is a spike that was designed before it was scoped.

## ⚠️ A FALSE NEGATIVE I ALMOST RECORDED

`sepolia.base.org` returned **0 bytes** for the Gateway contract on the first read — I was one line
from recording "not deployed on Base Sepolia", which would have made the testnet pairing look
impossible and killed the option. Re-read across three RPCs: **163 bytes on two of three**, the third
erroring. The first read was transient.
⭐ Same lesson as the `Accept` header earlier the same day, from the other direction: there, two
instruments agreed and were both wrong; here, one instrument was wrong and a second settled it.
**Neither "it agreed with itself" nor "it answered once" is corroboration.**

## THE OTHER TWO GAPS — DECLINED, WITH REASONS

* **bare-POST 400 → REFUSED.** `dd-analyze` validates input BEFORE the 402, deliberately: *"charging
  for 'that is not a well-formed question' would quote a price for something we answer for free, and
  would reward narrowing the supported chain set."* Moving 402 earlier would make every unsupported
  chain a billable challenge instead of a free refusal. ⚠️ My first defence of this was WRONG on
  mechanism — I said it prevented pay-then-400, but settlement runs after analysis so a bad body
  never charges. The real reason is incentive alignment, and it is stronger.
* **mpp → DECLINED.** One line to add, and a lie: it advertises a payment path this service would
  then fail. Implementing it means a second settlement path holding every property the first one
  does. A project, not a checkbox.

⭐ **95/100, AND THE TWO DECLINED GAPS COST NOTHING.** The score does not test the property the
product is built on — that acceptance is not payment — so optimising for it would trade the thing
being sold for the thing being measured. That argument holds at any score; it just turned out not to
be needed here, because the refusals were free.

🚨 **AND THE LAST 5 POINTS MAY BE UNREACHABLE WITHOUT MIS-SELLING.** The one scored gap is payment
on 2+ networks. The honest pairing for a service that analyses **Arc testnet** contracts is **Base
Sepolia** — but a scorer probing mainnet payability would not count it, and accepting Base
**mainnet** USDC would mean taking real money for testnet analysis. So the remaining 5 points are
plausibly gated on becoming a mainnet service, not on writing code. ⚠️ Do not treat them as
outstanding work: treat them as a decision about what this service IS.

⭐ **BADGES ARE A SEPARATE AXIS FROM THE SCORE.** Nanopayments showing unticked costs NOTHING
numerically — the score is already 95 with multi-network as its only gap. And the live 402 already
passes Circle's own documented seller test (`extra.name === "GatewayWalletBatched"`, `scheme:
"exact"`, above the $0.000001 minimum with **no maximum**). So it is a DISPLAY question, worth one
line in a note to Circle and **no build work at all**.


# ✅✅ ITEM 1 IS CLOSED — `gate:pins` EXITS 0. AND THE GATE ITSELF WAS UNDER-REPORTING.

**2026-08-18.** Three CIDs, two independent operators each, agreed by both routing instruments.
The DD identity supersession is complete on-chain, and the permanent obligation behind it now
survives losing either operator.

| CID | operators | peers |
|---|---|---|
| `bafkreigton…o2af4` — dd-service v1.0.0 | **filebase.io, pinata.cloud** | 4 |
| `bafkreib6vi…momla` — dd-service v1.1.0 | **filebase.io, pinata.cloud** | 4 |
| `bafkreidoeond3…` — unified 851823 | **filebase.io, pinata.cloud** | 4 |

## 🚨🚨 THE GATE REPORTED RED WHILE THE WORK WAS GREEN — ITS OWN `Accept` HEADER TRUNCATED THE ANSWER

T reported `gate:pins` green. It read RED here. **The disagreement was the finding.**

`Accept: application/json` returns a TRUNCATED provider set from both routing instruments.
Measured across both instruments and both CIDs:

```
cid.contact         Accept: application/json   2 peers  pinata.cloud
cid.contact         Accept: */*                4 peers  filebase.io, pinata.cloud
delegated-ipfs.dev  Accept: application/json   1 peer   pinata.cloud
delegated-ipfs.dev  Accept: */*                2 peers  filebase.io, pinata.cloud
```

⭐⭐ **THE REQUEST SHAPING WAS PART OF THE HYPOTHESIS.** This is the same family as *a filtered read
is not a measurement of absence* — `--function`, `grep`, `tail`, and an `Accept` header are one
mistake in four costumes: **the instrument was asked a narrower question than the one being
answered, and its answer was read as the whole truth.**

🚨 **AND TWO INSTRUMENTS DID NOT SAVE IT.** The n=1 defence this repo already learned —
*repeating one instrument is not corroboration* — assumes the instruments are asked the same
question independently. Both were asked the NARROW question, so both agreed, and their agreement
was worthless. ⭐ **Corroboration requires varying the QUESTION, not only the answerer.**

⚠️ **IT FAILED IN THE DIRECTION THAT LOOKS LIKE DILIGENCE**, which is why it survived review:
completed work read as unfinished. An under-reporting safety gate raises no alarm — nobody
investigates a check that says "not yet". Had the bias run the other way it would have declared a
single-operator CID safe and been caught in a day. **A gate being conservative is not evidence that
it is correct**, and "fails safe" is not a substitute for "measures the right thing".

⭐ **THE PROCESS LESSON: THE HUMAN'S CONTRADICTING REPORT WAS THE INSTRUMENT.** The cheap move was
to assume T had misread their own terminal — two green rows above one red one is an easy misread,
and my reading came from the gate itself. Taking the disagreement seriously instead is what
surfaced a defect in the criterion everything else was being measured against.

Fixed at `212696a`: `Accept: */*`, and `parseProviders()` handles either a `{"Providers":[…]}`
envelope or NDJSON, returning **null — never `[]`** — for an unreadable body, so "could not read"
cannot collapse into "nothing announced".

## THE SECOND OPERATOR IS FILEBASE, ADDED BY pin-by-CID

⭐ **pin-by-CID, NOT re-upload.** We hold the bytes, so re-uploading was the obvious move and the
wrong one: the CID a provider ANNOUNCES depends on how it wraps an upload. Ours are CIDv1 raw
(`bafkrei…`); a file-upload API announces a UnixFS dag-pb root (`bafybei…`). The bytes would have
been stored, the routing instruments would still have shown ONE operator for the CID the chain
points at, and **the work would have looked done while achieving nothing.** `POST /pins` names the
exact CID, so there is no codec ambiguity.

🚨 **STORACHA IS GONE — DO NOT PLAN AROUND IT.** `storacha.network` and `docs.storacha.network` both
301 to `fil.one` (an S3 product with no IPFS pinning surface); `console.storacha.network` and
`up.storacha.network` do not resolve at all. A third-party notice puts uploads ending 2026-04-15.
Filebase became primary by elimination, not comparison.

⭐ **AND THE PRIVATE-BUCKET QUESTION WAS ANSWERED BY MEASUREMENT, NOT BY DOCS.** Filebase tokens
scope to ONE bucket, buckets have a visibility setting, and if a private bucket stored without
announcing then every pin would succeed while the operator count never moved — the same end state
as not doing the work, through a door the "does Filebase announce under a DNS name?" pre-check
could not cover, since that measured someone else's bucket. Filebase says it publishes all provider
records to the DHT and defines private/public only for the S3 access path, but **no source states
that intersection outright**, so the script does not assume it: after the FIRST pin it polls for a
new named operator and STOPS if none appears. The live pins settled it — `filebase.io` announces
for this bucket.

## ⭐ THE CRITERION WAS TIGHTENED BEFORE IT WAS USED — AND IT MATTERED

`gate:pins` counted `operators.size >= 2`, and a peer announcing no DNS name is keyed
`unknown:<peerId>`. So `{pinata.cloud, unknown:QmA}` went GREEN, and `{unknown:QmA, unknown:QmB}`
went green with **nothing named at all**.

🚨 Keeping unnamed peers separate is still right — folding them into a known operator would HIDE a
genuine second custodian. Counting them AS one is the opposite error, and it only became dangerous
when this gate was promoted to the SUCCESS CRITERION. ⭐ **A check that DESCRIBES can afford to be
generous with unknowns; a check that DECIDES cannot, because the generous reading is exactly the
false pass the work exists to eliminate.** Independence you cannot name is independence you cannot
verify.

Verdicts are now `OK` / `AMBER` / `SINGLE` / `NONE` / `UNRESOLVED`, and **AMBER states what the old
rule would have said** — *"would have called this 2. It is 1"* — so the tightening documents itself
where it fires rather than silently correcting a number.
⭐ AMBER cannot occur against real data, so the rule was extracted to `_operator-count.mjs` and all
five branches are driven by `verify-operator-count.mjs` with no network. **A branch whose first
execution is the day it decides something is a branch nobody has tested.**

## STEP 4 LANDED — tokenURI(851891) RESOLVES TO v1.1.0

Operator-run `setAgentURI`: tx `0xe7babbf3…e099`, block **57624156**, status `0x1`,
gasUsed **159,052**. Confirmed on two independent RPCs. `verify-supersession.mjs` → ✅ SUPERSEDED.

⚠️ **THE PRE-FLIGHT COST ESTIMATE WAS WRONG BY ~3×.** `eth_estimateGas` said 53,578; the write used
159,052. The estimate measured a direct call from the owner address, but the send went through the
Circle SCA (`from 0x927e53dd…`). Same call, different path. **An estimate is only valid for the
path it was taken on** — harmless here, but the COST line should name which path it measured.

⭐ **THE RECORD SURVIVED THE MOVE, WHICH WAS THE PART WITH NO UNDO.** `mergePreservingProvenance`
would NOT have protected it: its rule is "never downgrade a known value to null", and a
supersession's incoming values are all non-null and different, so the merge never fires and a plain
write replaces the registration txHash with the setAgentURI hash. `pointerHistory[]` is append-only
and `registrationTxHash` is pinned separately.
⭐ **AND THE SEED WAS CORRECT ONLY BY TIMING** until it was asserted: it read `prior.txHash` and
LABELLED it "the original registration" without checking — true on the first supersession, false
forever after. Now asserted against a constant, with 24 checks and 6 refusal cases proving it
against the real record in memory, no chain, no writes.

## ⭐ FOUR SELF-MEASURING MISTAKES IN ONE SESSION — A PATTERN WORTH NAMING

1. `pgrep -f 'deploy:prod'` matched **its own command string**, so the deploy monitor could never
   observe the deploy ending. Fixed with a `__DEPLOY_EXIT__` sentinel written by the wrapper.
2. An endpoint probe **reused the previous iteration's response body**, so two dead hosts appeared
   to return spec-compliant errors.
3. The `Accept` header above.
4. `verify-supersession`'s errata check **passed vacuously** before the deploy, because the v1.1.0
   entry did not yet exist and the guard short-circuited on `!newEntry`.

⭐ The common shape: **the measurement apparatus was inside the thing being measured**, and in every
case the wrong answer looked exactly like a right one. Ask of any check: *what would this print if
the thing I am checking for were absent — and could it print that for some other reason?*

## THE DEPLOY RECORD — SIX MEASUREMENTS, AND "GROWING" IS NOT SUPPORTED

`24m49 · 36m03 · 30m12 · 44m29 · 22m10 · 19m23` at constant function count. ⭐ **The two most recent
runs are the two fastest.** The spread is ~25 min and non-monotonic: bundling time is NOISY, not
growing. ⚠️ Treat any single run as a FLOOR — 19m23 says nothing about the next one.

## STATE

* `gate:pins` **exit 0** · `gate:opcount` **exit 0** · `verify-supersession` **exit 0** ·
  `gate:deployed` / `gate:forgery` green on deploy `6a84436f4a395d50eac1a5bd`.
* ⚠️ `capture:window` still reports NO WINDOW — correct: `dd-identity.mjs` sits outside
  `DD_SURFACE_DIRS/FILES` by design, being a static informational endpoint with no engine, no
  health gate and no money path.
* ⚠️ **The must-stay-pinned obligation now spans TWO accounts.** Both must be kept alive, and the
  set still only grows. A second operator halves the risk; it does not remove the obligation.
* ✅ `pin-invariants.mjs`'s `--env-file=.env` line is FIXED. It documented a command that could
  never work: `.env` holds a **10-char, 1-segment placeholder** (verified, not assumed) while the
  real token has no local copy, so that form loaded a fake credential on every run.
  ⭐ **IT SURVIVED FOR MONTHS BECAUSE THE FAILURE LOOKED LIKE THE GATE WORKING** — the refusal talks
  about the TOKEN, so each run read as "I pasted it wrong" rather than "the documented command is
  wrong". A defect that presents as its own safety check is invisible until someone reads `.env`.
  ⚠️ And the shape gate caught it BY LUCK: it was written for a different failure (capturing a
  `netlify env:get` status message) and merely happens to require 3 dot-separated segments. A
  placeholder that happened to be JWT-shaped would have reached a live 401.
  ⭐ **THE PORTABLE RULE: a secret with NO LOCAL COPY must not have a documented invocation that
  reads a local file.** Paste it per run. `pin-second-operator.mjs` was built that way from the
  start, and its anti-placeholder gate enforces it mechanically rather than by convention.


# ✅ DD IDENTITY v1.1.0 — PINNED AND VERIFIED. THE CHAIN IS UNTOUCHED, AND STEP 4 IS THE OPERATOR'S.

**2026-08-18.** Supersedes the handoff below on ITEM 3 and ITEM 4 — that entry was written before the
route build and still calls `/api/dd-identity` non-existent. It exists, it is deployed, and the
document it describes is pinned.

## THE PIN-ORDER, WITH THE BOXES ACTUALLY TICKED

```
✅ 1. ship  /api/dd-identity                      deployed 6a840d8d4c9c5afe6086b2d4, 07:45Z
✅ 2. verify it serves — as a stranger            HTTP 200 from outside
✅ 3. pin   dd-service.v1.1.0.DRAFT.json          bafkreib6viz4fqa4oqrrgxfecwcttxyda6ilm5nmzr7yplznqeahqmomla
✅ 3b. deploy the companion that KNOWS about v1.1.0   ← this commit
⬜ 4. setAgentURI(851891, "ipfs://bafkreib6vi…")  selector 0x0af28bd3, OPERATOR-RUN
⬜ 5. verify tokenURI resolves AND the companion reports the new CID
```

| | |
|---|---|
| CID | `bafkreib6viz4fqa4oqrrgxfecwcttxyda6ilm5nmzr7yplznqeahqmomla` |
| sha256 | `3eaa33c2c01c7423135ca4158539df030790b675accc7f87af2d81007831cc58` |
| bytes | 18,756 |
| pinned root == raw CID == the CID predicted OFFLINE before any network call | ✅ |

## 🚨 STEP 3b EXISTS BECAUSE STEP 3 LANDED BEFORE THE COMPANION KNEW ABOUT IT

Between the pin and this commit, prod served a companion whose `versions[]` held **only 1.0.0** with
`superseded_by: null`. Had `setAgentURI` gone first from there, `tokenURI(851891)` would have resolved
to a document whose own named companion said that document did not exist — **structurally the same
defect v1.1.0 was written to correct.** v1.0.0's companion was named and unreachable; a companion that
is reachable and calls the current document nonexistent is not an improvement on it.

⭐ The route's new `pointer_expectation` field states the order and the reason, so a reader who lands
mid-changeover is told rather than left to infer: **this endpoint runs AHEAD of the chain, never
behind it.** The reverse order would hand a reader the new document off the chain while the endpoint
still called it superseded. Until step 4 lands, `tokenURI` returning `bafkreigton…o2af4` is CORRECT
and v1.0.0 is still the authoritative document — errata and all.

## 🚨🚨 PINNING v1.1.0 DOUBLED THE SINGLE-OPERATOR EXPOSURE. IT DID NOT ADDRESS IT.

**ITEM 1 of the handoff below is not closed by this work — it is made larger by it.** Measured this
session with `npm run gate:pins`:

| CID | peers | operators |
|---|---|---|
| `bafkreigton…o2af4` — dd-service v1.0.0 | 2 | **pinata.cloud** |
| `bafkreib6vi…momla` — dd-service v1.1.0 ⭐ NEW | 2 | **pinata.cloud** |
| `bafkreidoeond3…` — unified 851823 | 2 | **pinata.cloud** |

⭐ **THREE CIDs, ONE OPERATOR.** Every peer announcing every document this project has ever put on
chain belongs to one account. A successful pin reads like progress and this one is progress on
*supersession* — but on *survival* it is a third egg in the same basket. The gate exits 1, and that
is the correct verdict, not a regression to be silenced.

⚠️ **AND w3s.link SERVING THE BYTES IS RETRIEVAL, NOT CUSTODY.** Re-probed after the pin:

| gateway | result |
|---|---|
| ipfs.io | 200 in 0.20s — **hash MATCH** |
| dweb.link | 200 in 0.75s — **hash MATCH** |
| w3s.link | 200 in 0.36s — **hash MATCH** |
| cloudflare-ipfs.com | `000`, no connection at all (that gateway is retired) |
| gateway.pinata.cloud | 404 after 35s |

🚨 **THREE GATEWAYS SERVED CORRECT BYTES AND THAT IS STILL ONE OPERATOR.** A gateway is a *reader* of
the network; it fetched from Pinata's peer like everyone else. Storacha serving the bytes through
w3s.link does not mean Storacha *stores* them, and if the Pinata account lapses all three of those
200s become 504s together. **Count operators in the routing answer, never gateways in a fetch table.**
This is the same distinction `verify-pin-providers.mjs` already draws between transport redundancy and
custody redundancy — it applies to gateways too, and the fetch table above is exactly the artifact that
would let someone forget it.

## ⭐ dweb.link WENT FROM "NOT RETRIEVED" TO MATCH, WITH NO INTERVENTION

At pin time, ipfs.io served and re-hashed to a match while **dweb.link and cloudflare-ipfs.com did
not** — the same 2-of-3 pattern measured on v1.0.0, whose bytes are months old. Re-probed later the
same day, dweb.link served in 0.75s. So that pattern is **cold-fetch warming, not a v1.1.0 problem and
not an aging problem** — it reproduced on a CID minutes old. cloudflare-ipfs.com is a different thing
entirely: `000` is no connection, a retired gateway, not a missing pin.
⚠️ **A FIRST FETCH FAILING IS THE NORMAL CASE, WHICH IS WHY THE COMPANION IS ALSO THE AVAILABILITY
PATH.** A reviewer's first attempt may well 504. Do not read that as a lapsed pin.

## ⭐ THE DOCUMENT'S BOLDEST NEW CLAIM WAS CHECKED FROM OUTSIDE BEFORE IT WAS FROZEN

`code_provenance.repository_access` flipped from "⚠️ NOT public, a genuine gap in verifiability" to
"✅ PUBLIC, and therefore a THIRD retrieval path". That is a claim an outsider can falsify, so it was
verified as an outsider would: `HOME=/nonexistent`, no `GITHUB_TOKEN`, no `GH_TOKEN`, no netrc.

```
raw.githubusercontent.com/tikpema274/tikpema/6e437d5/agent-metadata/dd-service.json
  → 200, 28,628 bytes, sha256 d3734accb6390a361df2daf87b49c41d4a44d30bfc9285f47be3c3284dbb402f
```

That hash is v1.0.0's recorded sha256 exactly. **The repository is a genuine third source, sharing no
operator with Pinata or with app.tikpema.xyz** — which is why `availability_is_not_guaranteed` was
rewritten in the same pass to name three sources rather than two, and still refuses to call three a
guarantee.
⚠️ The frozen bytes deliberately CANNOT name their own repository path: they are frozen before they
are committed, so the commit carrying them does not exist yet. The companion publishes it — a fact
that must change after freeze is precisely what the companion is for.

## THE BYTES ARE FINAL AND WERE CONFIRMED FINAL

On-disk `agent-metadata/dd-service.v1.1.0.DRAFT.json` is 18,756 bytes hashing to `3eaa33c2…` — the
same hash recorded in `pin-invariants.mjs` and the same one the pinned CID commits to. **No post-pin
edit has occurred.**
⚠️ **THE FILE KEEPS THE `.DRAFT.json` NAME ON PURPOSE.** Renaming changes nothing about the bytes but
invites a re-save, and a re-save changes the CID and makes the document's own central claim false. The
filename stopped mattering the moment it was pinned: the CID is the address.

## TWO GATE FIXES THAT CAME OUT OF THIS

⭐ **`verify-pin-providers.mjs` printed `SINGLE OPERATOR (undefined)` when the answer was ZERO.** Zero
providers is not "one, but smaller" — it is an instrument ANSWERING and naming nobody, which means
never pinned or LAPSED, the most serious state the gate can observe. It was being folded into the
one-operator branch and mis-diagnosed. Now its own branch, with the note that an unpinned CID reads
this way too — expected for a version awaiting its pin.
⭐ **The companion's `known_errata: []` got an `errata_note`.** A bare empty array invites "audited
clean". It means nothing has been FOUND yet — a statement about how long the document has existed, not
about its accuracy. v1.0.0 also carried none the day it was frozen and carries three now.
⚠️ Two instruments disagreed on the fresh pin: `cid.contact` returned 2 peers while
`delegated-ipfs.dev` returned **0**. Routing propagation lag, not a defect — but it is exactly the
zero-answer the fixed branch now reports honestly instead of printing `undefined`.

## STATE AT THIS COMMIT

* `tokenURI(851891)` = `ipfs://bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4`, read from
  **two independent RPCs** (`rpc.testnet.arc.network`, `arc-testnet.drpc.org`). The chain has NOT been
  touched. ⚠️ `rpc.testnet.arc.com` does not resolve — the host is `.network`.
* **Step 4 is the operator's to run**, and it is the only remaining action.
* ⚠️ **EXPECTED AND NOT REGRESSIONS:** `gate:pins` exits 1 (three CIDs, one operator — see above) and
  `capture:window` reports NO WINDOW. Neither is caused by this change.
* ⭐ **THE REAL OPEN ITEM IS STILL ITEM 1: A SECOND PINNING OPERATOR.** It waits on nobody's
  credential, and the document is 18,756 bytes. Every session that pins without adding one makes the
  basket heavier rather than the eggs safer.


# 🚨 HANDOFF — DD IDENTITY SUPERSESSION, WRITTEN AT 97% CONTEXT BEFORE A ROUTE BUILD

**2026-08-18.** Written deliberately BEFORE building, because a route build plus a ~45 min deploy from
here is exactly how the last two sessions ended mid-flight. Nothing below is speculative: every
number was measured this session.

## ⭐⭐ ITEM 1 — A SECOND PINNING PROVIDER. DO THIS FIRST; IT NEEDS NO CREDENTIAL FROM ANYONE.

**There is exactly ONE provider for `bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4`,
and TWO PAID REPORTS WERE SOLD UNDER IT.** Measured via the IPFS delegated-routing API:

| CID | providers | via |
|---|---|---|
| `bafkreigton…o2af4` — dd-service 851891 v1.0.0 | **1** | `bitswap-v3.pinata.cloud` |
| `bafkreidoeond3akvswce3e425o5grfygsvrfyleqkwathio4ae6y6vujae` — unified 851823 | **1** | `bitswap-v3.pinata.cloud` |
| a random nonexistent CID (negative control) | 0 | — |

🚨 **CONFIRMATION IS NOT MITIGATION.** Verifying the pin tells you it is there TODAY. A second
provider is what makes it SURVIVE — and unlike the confirmation below, it waits on nobody's
credential. One provider for a permanent obligation is a single point of failure whose failure mode
is retroactive: the reports stay signed, the signature stays valid, and the claims they were produced
under become unfetchable.

⭐ Candidates that need no coordination: web3.storage / Storacha, Filebase, a self-hosted IPFS node,
or a second Pinata account. Any ONE of them halves the risk; the CID is 28,628 bytes.

## ITEM 2 — CONFIRM THE v1.0.0 PIN (needs T's credential)

Run and paste; never echoes the token:
```sh
read -rs PINATA_JWT && export PINATA_JWT
curl -s -H "Authorization: Bearer $PINATA_JWT" \
  "https://api.pinata.cloud/data/pinList?hashContains=bafkreigtonfmznrzbi3b34w27b5utra5jjcngc74skc7i67dymue3o2af4&status=pinned" \
  | python3 -m json.tool | head -20
unset PINATA_JWT
```

⚠️ **THE PINATA_JWT DIVERGENCE — SAME SHAPE AS SESSION_SECRET.** `.env` holds a **10-char, 1-segment
placeholder**; a real Pinata JWT is 3 dot-separated segments, 300+ chars. The real credential is
**NOT in `.env` and NOT in Netlify** (33 vars, none pinning-related) — it lives ONLY with the operator
and is pasted per run. `.env` has been LABELLED locally (gitignored) to stop it reading as
authoritative.
🚨 **AND THE SCRIPT'S OWN DOCUMENTED COMMAND CANNOT WORK:** `pin-invariants.mjs` documents
`--env-file=.env`, which loads the placeholder. Its shape check (needs 3 segments) catches it and
refuses to run unauthenticated — correct — but the documented form never succeeds. Use
`read -rs PINATA_JWT && export PINATA_JWT`.
⚠️ **AN UNAUTHENTICATED PINATA QUERY RETURNS 401, WHICH READS LIKE "no pins found".** I reported
"0 pinned records" from exactly that this session before catching it. Do not mistake a 401 for a
lapsed pin.

## ITEM 3 — THE v1.1.0 DRAFT

**`agent-metadata/dd-service.v1.1.0.DRAFT.json`** — 16,916 bytes, valid JSON, 17 top-level keys.
NOT pinned, NOT pointed at, no chain write has occurred.

🚨 **WHY IT EXISTS: v1.0.0 WAS FROZEN BEFORE REGISTRATION AND REGISTERED ANYWAY**, so `tokenURI(851891)`
resolves to a document DENYING ITS OWN EXISTENCE. Four false claims, each corrected by supersession
(never by edit) and quoted inside `supersedes` so the correction is traceable:
1. `_notice`: "NO WALLET EXISTS … NOTHING IS REGISTERED … NO agentId EXISTS" — registered 2026-07-26 as **851891**.
2. `ownership_deferred_to_phase_B_C.status` repeated it.
3. `_notice`: "Reports … are NOT signed or attested by any identity today" — ERC-1271 attestation is live.
4. `open_decision_for_phase_B` (same wallet as 851823, or distinct?) — the chain answered a month ago: **same**, owner `0xc54D47211997aCA90Ef4fCfBc742a3b511B4e621`.

**Preserved deliberately:** the commit-scoped key `capabilities_at_commit_6e437d5` (scope in the KEY
NAME, which is what makes a superseded doc honestly out-of-date rather than wrong), the selector
evidence for `setAgentURI` `0x0af28bd3` / `upgradeToAndCall` / `transferFrom`, and its
"selector present, NOT a call simulation" caveat.

**Added:** a top-level `mutable_companion` at `https://app.tikpema.xyz/api/dd-identity` carrying BOTH
corrections AND availability, disclosing its own operator-controlled mutability on the same terms the
document applies to `tokenURI`, and stating the trust ordering — immutable bytes → on-chain pointer
(mutable, observable) → companion (mutable, NOT observable). Also a new
`code_provenance.repository_access` admitting the repo is private so an outsider cannot verify the
commit — an honest gap, newly admitted rather than newly true. **T should confirm they want that
admission in a public document.**

## 🚨 ITEM 4 — THE BLOCKING PIN-ORDER. DO NOT REORDER.

```
1. ship  https://app.tikpema.xyz/api/dd-identity      (route does NOT exist yet)
2. verify it serves — as a stranger, from outside
3. pin   dd-service.v1.1.0.DRAFT.json  → new CID
4. setAgentURI(851891, "ipfs://<new CID>")             selector 0x0af28bd3, operator-run
5. verify tokenURI(851891) resolves AND the companion reports the new CID
```
⚠️ **PINNING BEFORE THE ROUTE EXISTS REPRODUCES THE EXACT DEFECT BEING FIXED** — v1.0.0's companion
was named ("a README in the public mirror") and unreachable: the whole document contained only TWO
URLs, both RPC endpoints. A doc pointing at a 404 is the same failure with a nicer field name.
⚠️ The bytes are final at step 3: the CID is a pure function of them, so any reformat, trailing
newline, or `JSON.parse` round-trip after pinning makes the document's own central claim false.

## ITEM 5 — TWO-REPO RESOLUTION (unchanged, restated so it is not re-derived)

`origin` = `github.com/tikpema274/tikpema` — **backup only, pushing does NOT deploy.** The Netlify
site's `build_settings.repo_url` points at a DIFFERENT repo (`Tikpema/tikpema-predict-test`), but git
auto-build is not the real path: **prod ships via `npm run deploy:prod` (Netlify CLI)**. Never push to
`tikpema-predict-test` to deploy — that was a wrong guess already rejected.

## STATE AT HANDOFF

* HEAD `6e437d5`, pushed, tree clean. Prod serving deploy `6a83813b2eb14fc4b3cae9a4`, all five
  `gate:deployed` checks green.
* ⏱ **Deploy budget ~45-60 min.** Four measurements today at constant function count: 24m49 / 36m03 /
  30m12 / **44m29** — noisy, not monotonic. Launch detached (`nohup setsid`), and use **CPU, not
  elapsed time**, to tell slow from stuck.
* The outsider's pass (STEP 2 of T's request) has **NOT** been done: resolve tokenURI → fetch CID →
  `GET /api/dd-analyze` as browser and as machine → `/api/dd-openapi` → verify attestation against the
  on-chain owner → run the curl copied off the human page.
* ⚠️ Gateways: a COLD fetch of the CID returned HTTP 504 from ipfs.io and dweb.link before succeeding;
  once warm all three served correct bytes in <3.2s. A reviewer's FIRST fetch may fail — which is
  precisely why the companion is also the availability path.

# ⚠️ DEPLOY BUNDLING IS GROWING — 7.5 → 25 → 24m49s → 36m03s, and the recorded budget is now wrong

**2026-08-17.** Two deploys today, both timed from their own logs:

| deploy | functions bundling | published |
|---|---|---|
| `6a834ab31972b84d68cfb24b` (18:22Z) | **24m 49.3s** | tree `42b972359f42` / commit `929379501514` |
| `6a8358cc4b38dd7bfb3a258c` (19:33Z) | **36m 03.2s** | tree `5fba3ade7c6e` / commit `6c849385e88a` |
| `6a8369049eb4ec5ed66adfc6` (20:37Z) | **30m 12s** | tree `182eb7642a69` / commit `1ff8d7f36c26` |
| `6a83813b2eb14fc4b3cae9a4` (22:36Z) | **44m 29.4s** | tree `09fee79b5241` / commit `2c0c49cc33f1` |

⭐ **FOUR MEASUREMENTS THE SAME DAY: 24m49s, 36m03s, 30m12s, 44m29s — AT THE SAME FUNCTION COUNT.**
The spread is nearly **20 minutes** and it is NOT monotonic, so bundling time is noisy rather than
steadily growing. ⚠️ Treat any single measurement as a FLOOR, never as an estimate: a run that
finishes in 25 minutes says nothing about the next one. ~45 min is now the floor of a BAD run.

## 🚨 THE DISCRIMINATOR FOR "SLOW" vs "STUCK" IS CPU, NOT ELAPSED TIME

At 39 minutes the 22:36Z deploy had passed **every** prior run, so the "compare against a previous
log" rule had run out — the only precedent said it should already have finished. Elapsed time could
no longer tell a slow bundle from a hung one.

⭐ **`ps -o time,pcpu` SETTLED IT IN 25 SECONDS.** node was at **156% CPU** with cumulative CPU time
climbing `01:02:37 → 01:03:15` across one sample, and `esbuild` was live beside it at 36%. A hung
process burns no CPU; a working one does. The bundle finished 5 minutes later at 44m29s.

⚠️ **USE THIS BEFORE KILLING A DEPLOY.** Log silence plus a stopwatch cannot distinguish the two, and
killing a healthy deploy mid-bundle is exactly how five deploys ended up stuck at state `new`:
```sh
pgrep -f 'deploy:prod|netlify|esbuild' | while read -r p; do ps -p "$p" -o pid,etime,time,pcpu --no-headers; done
sleep 25   # then repeat — if TIME climbed, it is working
```

⚠️ **THE MEMORY NOTE SAYS "budget ~30 MIN (bundling grew 7.5→25 min)". THAT IS OPTIMISTIC** — the
second deploy took 36 minutes to bundle ALONE, before uploading, and the whole `deploy:prod` chain ran
roughly 19:53→19:42 wall-clock including `gate:*`, `build`, upload, `gate:deployed` and
`capture:window`. Budget **~45 min**, and do not start one against a tool ceiling.

⭐ **THE OPERATIONAL LESSON, WHICH COST NOTHING TODAY BECAUSE IT WAS ANTICIPATED:** both deploys were
launched with `nohup setsid … &` and polled from a separate command. The polling loop DID hit a
10-minute tool ceiling mid-bundle — and the deploy survived it untouched, because it was never a child
of that shell. ⚠️ Had it been run in the foreground it would have been killed at the ceiling **during
bundling**, which is precisely how five deploys ended up stuck at state `new` on 2026-08-14, each
reading exactly like a success.

⚠️ **AND THE SILENCE IS NORMAL, WHICH IS THE TRAP.** Bundling emits NOTHING for its whole duration —
29 minutes passed with the log frozen on the last function name. That is indistinguishable from a hang
by inspection. The only way to tell them apart is the previous deploy's own log, which shows the same
silence ending in `(Functions bundling completed in 24m 49.3s)`. **Compare against a prior run before
concluding a deploy is stuck.**

⭐ 108 functions bundled, 17 uploaded on the second deploy. The growth tracks function count, so this
gets worse with each new endpoint — a `dd-*` or `agent-*` addition is also a deploy-time cost.

---

# ✅✅ THE ACKNOWLEDGE GATE IS PROVEN LIVE — `ackAcceptedAt` written for the first time, on the acknowledge step ONLY

**2026-08-17.** Supersedes the "proof not attempted" entry below, which was written earlier the same
day. Ran on the PLAN CARD (`agent-execute-plan`), the surface 14 Aug never reached.

## The result, from two independently-written records

| | step 0 — 1.0 USDC | step 1 — 0.1 USDC |
|---|---|---|
| receipt `ackBand` | `none` | **`acknowledge`** |
| receipt `feeRatio` | 0.053274 | **0.53275** |
| receipt `ackRequired` | false | **true** |
| **receipt `ackAcceptedAt`** | **null** | **2026-08-17T17:28:26.588Z** |
| receipt `quoteId` / `quoteStepIndex` | `q_msxi20om…` / **0** | `q_msxi20om…` / **1** |
| quote `band` / `ackTokenIssued` | `none` / **false** | `acknowledge` / **true** |

⭐⭐ **THE TWO RECORDS AGREE AND WERE WRITTEN AT DIFFERENT TIMES BY DIFFERENT CODE PATHS.** The quote
(propose time, before anything was ticked) says a token was ISSUED for exactly one step index; the
receipt (execution time) says consent was ACCEPTED for exactly one. Joined on `quoteId` +
`quoteStepIndex`. **This is the first time that join has ever carried data** — every prior receipt in
the store predates the plan path.

⭐ **THE CONFOUND IS EXCLUDED FROM THE RECORD, NOT FROM MY PREDICTION.** Step 0's band at EXECUTION is
`none` with its own recorded `feeRatio 0.053274` — read before `ackAcceptedAt` was looked at, in that
order deliberately. So the null on receipt 0 is genuine per-step discrimination, not step 0 having
drifted into the band. Pre-run margin was 88%: the fee would have had to exceed 0.1000.

⭐ **RIGHT SURFACE, CONFIRMED FROM LOGS RATHER THAN FROM THE SCREEN:**
`[agent-plan] RUN quoteId=q_msxi20om_0d4cac7c226e6f49 steps=2`, then two settle triggers for
`0xae6e428f7630…` and `0x66351875e43a…` — the same hashes the receipts carry. Duration 13,395 ms.

On-chain (operator-verified): mint tx `0x91e2fd74…2625d`, block 45609712, Success — 0.046725 USDC to
the SCA `0x058957de…47f9e`, 0.053275 to the fee recipient.

## ⚠️ The fee moved WITHIN a single plan

`0.053274` on step 0, `0.053275` on step 1 — three blocks apart, one minor unit. Quoted net 0.046724,
delivered 0.046725; both steps delivered one to two units MORE than quoted. Harmless here, but it
is the empirical case for why the acknowledge token is band-scoped rather than fee-scoped: a
fee-exact token would have been invalidated between two steps of the same confirmed plan.

## 🚨 A FALSE FINDING I REPORTED, AND THE FIX IT LED TO

I first reported **"0 of 20 receipts carry a quoteId"** and called the join unexercised. **That was
wrong.** I was reading `GET /api/bridge-receipts`, whose projection **never included `quoteId` or
`quoteStepIndex`** — so `r.quoteId` was `undefined`, my reader defaulted it, and it printed as `null`.
The stored records held `q_msxi20om_0d4cac7c226e6f49` steps 0 and 1 the entire time. I diagnosed a
write-side defect that did not exist; the real gap was read-side, in the surface I was measuring with.

⭐⭐ **WHY IT SURVIVED UNSEEN, AND WHY IT MATTERED:** an absent field and an explicit null render
identically — and **null is CORRECT here** for the direct Bridge page, which has no quote. So the
broken state was indistinguishable from a legitimate one from outside. Meanwhile the only supported
way to audit a receipt showed consent as accepted with no way to reach the quote that authorised it.

**Fixed:** both fields added to the projection, with 5 assertions in `verify-bridge-receipts.mjs`
(180 → 185). ⚠️ Asserted as **key presence** (`"quoteId" in row`), not value — a value check passes
while the field is missing, which is the exact confusion being prevented. Both negative controls
verified reachable-red: removing the fields turns 5 red; changing `Number.isInteger(...)` to
`|| null` turns exactly 1 red (`got null`).

🚨 **AND THE FALSY-INDEX TRAP IS PINNED SEPARATELY.** `quoteStepIndex: 0` is falsy — a `?? null` or
`|| null` would erase the FIRST step of every plan, which is precisely the step whose null
`ackAcceptedAt` carries the discrimination. The bug would have deleted the evidence that the gate is
per-step, while leaving the acknowledged step looking perfect.

## ✅ DEPLOYED + VERIFIED AT THE SURFACE 2026-08-17

Deploy `6a834ab31972b84d68cfb24b`, published 18:22:10.923Z, tree `42b972359f42`, commit `929379501514`.

⚠️ **`gate:deployed` REPORTED FROM ITS OWN FIVE CHECKS, NOT FROM AN EXIT CODE** — a reaped deploy
sticks at state `new` with `error_message: null` and reads exactly like success, which is the class
that cost five silent deploys:
1. local build stamped ✓ · 2. **published deploy is `ready`** ✓ (not `new` — the check that matters)
· 3. production serves this tree AND commit ✓ · 4. **control plane == data plane**, both naming
`6a834ab3…` ✓ · 5. no orphaned deploys, 25 newer scanned ✓

⭐⭐ **AND THEN THE LIVE GET, WHICH IS THE ONLY THING THAT PROVES THE POINT.** The suite (185/0) proves
the projection *function*; only `GET /api/bridge-receipts` proves an OUTSIDER can reach the join:

```
1 USDC    band none         ackAcceptedAt null            quoteId q_msxi20om…  step 0
0.1 USDC  band acknowledge  ackAcceptedAt 17:28:26.588Z   quoteId q_msxi20om…  step 1
```

`cache-status: fwd=bypass` / Edge `fwd=miss` — origin, not cache. Note `quoteStepIndex 0` survives on
the 1.0 receipt **in production**, so the falsy-index handling is confirmed live and not only in a mock.

`capture:window` observed NO window, correctly: `bridge-receipts.mjs` is not in the DD surface, so
`ddTree` did not rotate and no refusal was expected. Recorded as not-a-pass, per its own rule.

## 📌 THE PROOF, CAPTURED VERBATIM — this section outlives the store

⭐⭐ **CAPTURED ON PURPOSE, BECAUSE THE QUOTE IS SCHEDULED FOR DELETION (~2026-08-31).** Transcribed
from both records after they were read, so the 14-day TTL below is **irrelevant to THIS proof**. That
separates two things that were being conflated: the **evidentiary** need (capture once, permanent —
solved here) and the **operational** need (what a USER can resolve, and for how long — the only part
that is still a retention design question).

**QUOTE** `agent-quotes` · `q/0xfd801d…5767/2026-08-17T17:20:26.614Z-q_msxi20om_0d4cac7c226e6f49`
```json
{ "quoteId": "q_msxi20om_0d4cac7c226e6f49", "quotedAt": "2026-08-17T17:20:26.614Z", "totalUsdc": 1.1,
  "steps": [
    { "i": 0, "amountUsdc": 1,
      "bridge": { "destinationKey": "base", "destinationLabel": "Base (Sepolia)",
                  "feeUsdc": 0.053276, "netUsdc": 0.946724,
                  "feeRatio": 0.053276, "band": "none", "ackTokenIssued": false } },
    { "i": 1, "amountUsdc": 0.1,
      "bridge": { "destinationKey": "base", "destinationLabel": "Base (Sepolia)",
                  "feeUsdc": 0.053276, "netUsdc": 0.046724,
                  "feeRatio": 0.5327599999999999, "band": "acknowledge", "ackTokenIssued": true } } ] }
```

**RECEIPTS** `bridge-receipts` · `o/0xfd801d…5767/<burnHash>`
```json
{ "burnHash": "0xae6e428f7630bb01276936b50b4dc027bfaad76f8d77994d6148c89d19953635",
  "burnedAt": "2026-08-17T17:28:19.962Z", "amountRequested": 1, "destinationKey": "base",
  "feeUsdc": 0.053274, "netPredicted": 0.946726, "amountDelivered": 0.946726,
  "feeRatio": 0.053274, "ackBand": "none", "ackRequired": false,
  "ackAcceptedAt": null, "ackToken": null,
  "quoteId": "q_msxi20om_0d4cac7c226e6f49", "quoteStepIndex": 0, "state": "minted" }

{ "burnHash": "0x66351875e43ab96597c0787b85985070fec70880cb9a2ff81f23ca6da5135356",
  "burnedAt": "2026-08-17T17:28:26.588Z", "amountRequested": 0.1, "destinationKey": "base",
  "feeUsdc": 0.053275, "netPredicted": 0.046725, "amountDelivered": 0.046725,
  "feeRatio": 0.53275, "ackBand": "acknowledge", "ackRequired": true,
  "ackAcceptedAt": "2026-08-17T17:28:26.588Z", "ackToken": "e6b6d07d…938e",
  "quoteId": "q_msxi20om_0d4cac7c226e6f49", "quoteStepIndex": 1, "state": "minted" }
```

⚠️ **`ackToken` IS TRUNCATED HERE — but NOT for the reason first recorded, and the correction matters
more than the truncation.** I initially wrote that publishing it "would hand anyone who can already
authenticate as this owner a way to skip the consent step." **That was WRONG.**

🚨🚨 **THE ACK TOKEN IS NOT A SECRET. IT IS PLAIN SHA-256 OF A PUBLIC STRING — no HMAC, no server key:**
```js
// _bridge.mjs:216
const digest = `bridge|${who}|${destinationKey}|${Number(amountUsdc)}|band:${band}|v2`;
return createHash("sha256").update(digest).digest("hex");
```
**Verified by recomputation:** `sha256("bridge|0xfd801d…5767|base|0.1|band:acknowledge|v2")` reproduces
the stored `e6b6d07d…938e` exactly — from four values **already on the receipt** (owner in the key,
`destinationKey`, `amountRequested`, `ackBand`). Truncation is therefore harmless but buys nothing; it
stays only because publishing a value nobody needs has no upside.

⭐⭐ **WHAT THAT MEANS FOR WHAT THE GATE WITNESSES — this deepens `5c15ba8` rather than contradicting it.**
`agent-execute-plan` refuses when `ackTokens[i] !== expected`. But `expected` is derivable by ANY caller
from the plan it is already proposing. So **the refusal stops a client that did not bother, not one that
intends to bypass.** The token is an *explicit-intent marker for a cooperating UI*, not a proof of
consent — a protocol step, not an authentication.

⚠️ **THAT IS DEFENSIBLE, AND SHOULD BE STATED AS THE DESIGN RATHER THAN DISCOVERED AS A GAP.** The caller
IS the session-authenticated owner; a user scripting past their own disclosure is their own choice, and
no server-side token can distinguish "the human read it" from "the client says so". What the mechanism
genuinely buys is that an HONEST client cannot reach execution without having received the disclosure —
because the token only arrives WITH it. That is real and worth having. It is not cryptographic consent,
and the record should not let the name imply otherwise.

⏭️ **CONSEQUENCE FOR THE "STORE A HASH, NOT THE TOKEN" PROPOSAL:** the argument is sound —
evidence without capability is exactly what a durable record wants — but its premise does not hold here,
because there is no capability to remove and no evidence to preserve. Hashing a value that any caller can
recompute changes nothing on either axis. ⭐ The proposal becomes live the moment the token gains a
secret (an HMAC over a server key), which is also the change that would make it mean what its name says.
Those two are the same decision, and worth taking together rather than separately.

🚨 **AND THAT SURFACED AN INCONSISTENCY WORTH ITS OWN LOOK.** `agent-act` deliberately does NOT store
the token on the quote, with the reason written at the code: *"The token itself is NOT stored:
`ackTokenIssued` says whether the box appeared, which is the fact in question, and a record is a poor
place for a credential."* **The RECEIPT stores it in full.** Same argument applies and was not applied.
Not changed here — a receipt is durable evidence and dropping a field from it deserves its own
decision — but the two records disagree about whether a credential belongs in a record.

⭐ **What the capture shows on re-read, which the live numbers alone did not:** the quote priced step 1
at `netUsdc 0.046724`; the receipt's own `netPredicted` was `0.046725` and `amountDelivered` was
`0.046725`. So the +1 unit is the **execution-time re-price**, not a delivery surplus — the bridge
delivered exactly what the receipt predicted, and the quote was one unit stale by then. Step 0 likewise:
predicted 0.946726, delivered 0.946726, exact.

## 🚨 RETENTION: THE PROJECTION MAKES THE JOIN REACHABLE — RETENTION DECIDES WHETHER IT RESOLVES

**Receipts are permanent (no prune exists). Quotes have a 14-day TTL** (`QUOTE_TTL_MS`, plus a 200/owner
cap, pruned on the write path). So **every receipt outlives its quote by design**, and a receipt older
than 14 days carries a `quoteId` that resolves to nothing — the same broken chain as the missing
projection, by a different route.

⭐ **OBSERVED, NOT PREDICTED.** Between two reads today the quote
`…/2026-08-02T00:21:32.462Z-q_msb21x9q…` was evicted at **exactly 14 days old**, by the age prune,
triggered by today's own writes. The mechanism is live and working as designed — the design is the
issue, not a bug.

⚠️ **Today's proof therefore has an expiry: ~2026-08-31.** After that the acknowledge receipt still
says consent was accepted, and the record that says a token was ISSUED for that step index is gone.
The evidentiary value of this run rests on TWO records agreeing; one of them is scheduled for deletion.

⭐ **THE QUESTION IS NARROWED, AND IT IS NOW ONLY ABOUT FUTURE RECEIPTS.** Today's proof is captured
above and no longer depends on the store. What retention still decides is purely operational: **what a
USER can resolve from a receipt, and for how long.** Those are different needs and only the second is
a design question.

⏭️ Three options, and they are NOT equal:
1. **Extend the quote TTL** — trades storage for a longer resolvable window. Simplest; changes one constant.
2. **Copy `ackTokenIssued` (the boolean, never the token) onto the receipt at write time** — makes the
   receipt self-contained, but creates the duplicate-source-of-truth shape this repo treats as its
   recurring bug, and the two copies would then be able to disagree.
3. 🚨 **Prune receipts to match — NEVER THE DEFAULT.** It is the only option that resolves the mismatch
   by DESTROYING evidence. A dangling join loses the corroboration; this loses the claim itself.
   Recorded explicitly so it is never reached for as the tidy symmetric answer.

## Where this leaves the gate

`ackAcceptedAt` set on **1 of 20** receipts — the right one. The remaining honest limit is the one
`5c15ba8` recorded and this run does not change: the field is derived from the band at execution, and
its meaning as CONSENT rests on two refusals in different modules making the line unreachable without
a matching token. This run proves the field is written under the intended conditions; it does not
convert the field into self-witnessing evidence.

# 🚧 ACK GATE — PROOF NOT ATTEMPTED 2026-08-17. Pre-run reads complete; the setup stands and is reusable.

**Nothing spent, nothing pending, no phantom.** No plan was confirmed and nothing was pressed. An
early "both receipts landed" was premature and was retracted before anything was recorded as proven.

⭐⭐ **THE INSTRUMENTS WERE RIGHT, AND FOR THE RIGHT REASON** — which is the part worth keeping. They
did not merely happen to say "no": each said no *because of the specific thing that had not happened*.
`agent-quotes` held no quote dated today **because `agent-act` never priced a plan**; `bridge-receipts`
held 26 keys unchanged **because nothing executed**. A reading that is right for the wrong reason is
indistinguishable from luck.

⭐ **AND THE DECISIVE READ PROVED IT WAS NOT A CACHED PHANTOM.** `GET /api/bridge-receipts` returned
`cache-status: "Netlify Durable"; fwd=bypass, "Netlify Edge"; fwd=miss` — origin, not cache. That is
the correct detector (**cache-status, not `Age`**); `age: 2` was irrelevant beside it. The 14 Aug
phantom-quote failure mode is ruled out for this read, not assumed away.

## The measurements, taken read-only

* **Fee re-measured `2026-08-17T16:17:06.844Z`: `0.053274`** (flat across amount — the forwarder fee
  dominates). Two IRIS GETs, no tx.
  * step 1 — **1.0 USDC → 5.33%, band `none`**. Margin: the fee would have to exceed **0.1000** to
    leave `none`, i.e. **88% headroom**. So an `ackAcceptedAt` on receipt 1 could NOT be explained by
    step 1 drifting into the band — which is the confound the two-step design exists to exclude.
  * step 2 — **0.1 USDC → 53.27%, band `acknowledge`**. Crossover is amount ≤ 0.2130; the usable
    window is `0.0533 < amount ≤ 0.213`.
  * ⚠️ **0.21 would have been the wrong pick** — 25.36%, only 0.36pp of margin, and the fee drifts
    (0.053216 / 0.054364 / 0.053543 / 0.053274 across four readings). A small fee DROP would silently
    demote it to `warn` and the gate would not fire. 0.1 is 2× the threshold.
* **Baseline re-derived from the store: 26 receipts, `ackAcceptedAt` null on ALL 26**, `ackRequired`
  false on all 26. Highest `feeRatio` ever recorded: **0.0536**, against a 0.25 threshold — nothing has
  ever come close, which is why the field is untouched. Across 4 owners (18 / 5 / 2 / 1).
* **Bands unchanged**: `FEE_BAND_WARN = 0.10`, `FEE_BAND_ACKNOWLEDGE = 0.25`, `GATING_BANDS = ["acknowledge"]`.
* **`412e8d0` is live** — an ancestor of the **stamped** commit prod serves (`945a9f13`), which is the
  check that matters rather than ancestry of HEAD. It touched `agent-execute-plan.mjs` too, so the plan
  path gets the provisional record, not only `agent-bridge`.
* ⚠️ **The ack path is NOT the `d64bb7f` surface — 13 commits have touched it since.** Most relevant:
  `a7ca274` (agent-act keeps the plan it priced — what makes the quoteId join possible at all) and
  `5c15ba8` (the semantics, plus the record that the 14 Aug proof also did not run).

## 🚨 THE FINDING THAT CHANGES THE PLAN: the plan path has NEVER produced a receipt

All 18 receipts for owner `0xfd801d…5767` carry **`quoteId: —`**. Not one has ever had a quote join.
So the `quoteId` + `quoteStepIndex` join — the second record intended to catch a client wrongly
applying one token to both step indices — **has never been exercised end to end.** Every existing
receipt came from a surface where `quoteId` is null by design.

⭐ **The surface discriminator is real, not a preference:** `agent-bridge` takes a single `ackToken`;
`agent-execute-plan` takes `ackTokens: { [stepIndex]: token }` and refuses **pre-flight, before step 1**.
The 14 Aug attempt on the single-action page structurally could not have exercised per-step consent.

⭐⭐ **AND THE PROOF SPLITS INTO A FREE HALF AND A PAID HALF.** The disclosure is emitted at **propose**
time by `agent-act` — band, ratio, and the minted `ackToken` all appear with **nothing executed**. So
"the gate fires" is provable at zero cost; only the re-submit with the token spends anything, and only
that writes `ackAcceptedAt`. Two different claims; decide them separately.

## ⭐ Two keepers from the false alarm — both would mislead the next session

1. 🚨 **`AGENT_WALLET_ADDRESS` from `.env` is NOT the spender on the plan path.** `_actions.mjs:95`:
   *"EVERY money-moving branch below sources funds from `ctx.walletAddress` — the CALLER'S OWN agent
   SCA, server-resolved from the verified session. No branch reads a wallet from env."* I measured
   `.env`'s wallet, got `delta 0.000000`, and **nearly reported "nothing executed" from an uninvolved
   address.** The right address is the caller's SCA — here `0x058957de…47f9e`.
2. **`0xc54d…e621` is the DD attestation's verifying contract, not a bridge wallet.** That is why it was
   never on the 15.635654 → 10.635654 trajectory, and why its balance is irrelevant to bridge questions.

⚠️ **A BALANCE IS A NET, NOT A LEDGER.** The SCA read `12.628654` — *higher* than the 10.635654
baseline. A single balance reading cannot distinguish "no spend" from "a spend plus a larger deposit",
so it was treated as evidence against a simple −1.1 rather than as proof of no spend. The receipt read
is what settled it.

⚠️ **AND ONE INSTRUMENT BUG OF MY OWN, CAUGHT:** the first receipt scan wrote its key list with
`'\n'.join()` — no trailing newline — so `wc -l` reported 25 and **`while read` silently skipped the
26th key.** I nearly reported "0 of 26" on 25 reads. The missing receipt was recovered and read
(`ackBand none`, `ackAcceptedAt null`). Same family as every other absence-reads-as-safe defect here,
this time in the measuring tool.

## Reusable setup for the next attempt

* owner `0xfd801d…5767` · agent SCA `0x058957deff333c47c15c208a4425420af6947f9e`
* target: two-step plan — **1.0** (band `none`) then **0.1** (band `acknowledge`); `ackAcceptedAt` must
  appear on the **0.1 receipt only**
* read order, deliberately: each receipt's own `feeUsdc`/`feeRatio`/`ackBand` **first**, then
  `ackAcceptedAt`, then the `agent-quotes` join (`steps[i].bridge.ackTokenIssued`, a **boolean** — the
  token itself is deliberately not stored)
* re-measure the fee immediately before confirming; verify `cache-status` shows `fwd=bypass`/`miss`
* `scripts/_prod-session.mjs` mints the read-only token for the receipts read

## ⭐ STANDING RULE FOR PROGRESS ENTRIES: full for SCAs and contracts, TRUNCATED for owner identities

Adopted 2026-08-17. **Contract addresses and provisioned SCAs go in full; owner / session identities
are truncated** (`0xfd801d…5767`). This file is public git history — permanent, and expensive to
retract, as this session's gitleaks work demonstrated at length.

⚠️ **Truncation is not privacy — be honest about what it buys.** It prevents **linkage-by-search**,
not linkage-by-investigation: anyone with the receipts store or an explorer can recover the full value,
and a truncated address is still effectively identifying. What it stops is the cheap, automated case —
someone grepping GitHub for an address string.

⭐⭐ **AND THE FORWARD-LOOKING ARGUMENT IS THE STRONGER ONE.** A testnet identity often becomes a
mainnet identity. A public link established now, against play money, **persists into the period when
that same address holds real funds** — and by then the linkage is already indexed and no longer yours
to withdraw. The asymmetry is the point: truncating costs a few characters of convenience today, while
not truncating cannot be undone later.

⭐ The distinction is deliberate, not blanket caution. A **provisioned SCA** is an account this system
created for one purpose and can replace; an **owner address** is a wallet the human personally controls,
plausibly across other chains. Those carry different consequences and get different treatment. The SCA
`0x058957de…47f9e` above stays in full for exactly that reason.

# ✅ CREDENTIAL AUDIT CLOSED — and the real exposure was never the `is_secret` flag

**2026-08-16.** Commits `9360413` (audit doc), `82df505` (spike guard), `d09af6e` (smoke scripts),
`9bfa810` (repath + per-file guards), `9961496` (import resolution folded into the index guard).
Nothing deployed — this touched no prod code path.

## The finding that reframed the whole task

`KIT_KEY` and `ANTHROPIC_API_KEY` were the last two vars still carrying the `builds` scope. Both
dropped to `functions, runtime`, values proven unchanged by sha256 before/after.
`ANTHROPIC_API_KEY` also went `is_secret` — safe on both axes at once: regenerable from the console
AND `.env` proven a real backup by hash comparison first (the pre-flight that caught the genuine
`SESSION_SECRET` divergence).

⭐⭐ **`KIT_KEY` HELD AT `is_secret: false` — DECIDED, NOT DEFERRED.** It IS regenerable
(`console.circle.com/api-keys`, free, no KYC — confirmed from Circle's docs, not assumed), so the
stated criterion was met. It was declined because the pre-flight grep found **20 files** running
`netlify env:get KIT_KEY --context production` while Netlify held the ONLY readable copy — no `.env`
entry, and Circle's console does not re-display a kit key.

🚨 **`is_secret` protects against console access; the dependency tree was the bigger surface.**
Flipping first would have made recovery a REISSUE — invalidating the live value and breaking prod
swap/bridge. A protection whose recovery path is a money-path outage is not the one to take first.
So the order was inverted: shrink the tree, then close the readback.

## Triage before deleting — and the answer was DELETE NOTHING

18 of the 20 were one-shot spikes. The instinct to retire them was wrong, and the repo had already
recorded why in two independent places: `scripts/spikes/README.md` ("a claim about money is only as
good as the run you can repeat") and PROGRESS.md:8277 ("Spike scripts kept under scripts/ as the
proven reference"). Every indexed spike is the provenance for a specific money claim — step2's net
USDC −2 / EURC +1.488895, step4c's `DeadlineExpired()` differential at 52942858/52943700, design2b's
1-approve-across-3-swaps. **Deleting them converts recorded results into unverifiable claims.**

⭐ So the credential SOURCE changed and the code did not. `scripts/_kit-key.mjs` is now the one place
a script obtains the key: it refuses missing, `"No value set"`-contaminated, prefix-stripped and
malformed values, reports shape only, and reaches for nothing itself. Its refusal teaches
`read -rs` — **not** `KIT_KEY=… node …`, which lands in shell history AND argv
(`/proc/<pid>/cmdline` is world-readable), and **not** a file on disk, which is `.env`'s problem one
level down and is how the `SESSION_SECRET` divergence went unnoticed.

⚠️ The 12 "dead" spikes were **mis-pathed, not rotted** — every target still existed. Two positional
causes: `scripts/dd` → `shared/dd`, and one directory level from the move into `spikes/`.

## 🚨 THE DEFECT THIS SURFACED: phase0e sent money before validating its credential

`spike-phase0e-approve.mjs` — the one money-moving script — **never validated `KIT_KEY` at all**.
Its only use is the rebuild that runs AFTER the real `approve(adapter, 1 USDC)` is broadcast. So a
missing or prefix-stripped key meant: **money moves, THEN the run dies on a credential that was
knowable at second zero.** Now checked before the approve, gated on `--confirm` so the dry-run
preflight is unaffected. It was also PRINTING `KIT_KEY=… node …` at runtime while provisioning —
actively teaching the leak the audit was closing.

## ⭐ Repathing made them runnable, so the deferred decision went live — six answers, not one

Verified by **STATIC IMPORT RESOLUTION only; no spike was executed.** Running a money-path spike to
confirm a repath worked is precisely the thing that must not happen, and it is the obvious
temptation once the paths are fixed. Fixed by RESOLVING each specifier against the real filesystem
rather than pattern-matching paths — PROGRESS.md:1797's lesson from the original move — and the
computed paths came out identical to what the living spikes already use.

Reading each file produced six different skip-vs-fail answers:
* **design2a KEEPS its skip** — cases 1/2 are its primary claim and need no network. Made SHAPE-aware:
  a prefix-stripped key is non-empty, so the old presence test sent it down the LIVE branch to die at
  a 401 while `fails++` — which exists so a skipped claim never reads as passed — never ran.
* **design2b / step4b / step5b / step8d** — guard placed BELOW the dry-run exit; line ordering asserted.
* **step2 / step4a / step4c / step5a** — unconditional; even the dry run prices a real quote.
* **step3** — inside the Part B branch; Part A is zero-money and stays runnable.
* **phase0** — never checked, then passed inline into AppKit at two call sites.

## Two defects the new suites caught in MY OWN work

* The guard diagnosed `KIT_KEY:abc123` (missing secret half) as PREFIX-STRIPPED, because `KIT_KEY` is
  itself a valid segment — advice that produces `KIT_KEY:KIT_KEY:abc123`. **A wrong diagnosis costs
  more than none, because it gets acted on.**
* The purity check matched the guard's own PROSE about the trap rather than a use of it —
  `assert-on-rendered-output-not-source-regex`, occurring inside the test written to enforce it.

## The index was missing four rows

`spike-step8a/8b/8c/8d` were unindexed while the reversal code they evidence was already live
(`676768f`). ⚠️ That is absence-reads-as-safe aimed at the INDEX: a reader of a complete-looking
table concludes those spikes are not provenance. Added, and `verify-spike-index.mjs` now checks
**both directions** — the one-way form would have stayed green through exactly this failure.

## State

* prod-Netlify `KIT_KEY` dependency: **20 → 0**.
* New suites wired into `test:all` as `test:spikes`: 34/0 (guard) + 11/0 (index).
* ✅ **FULL `test:all` GREEN after all five commits — exit 0, 2088 assertions across 36 reporting
  suites, 0 failed.** Checked for red beyond the tallies (`❌`, `FAILURES`, `npm error`, `Error:`,
  tracebacks) across all 3,574 log lines: none. `gate:routes` still reports `/api/agent-dd-report`
  correctly declared — the route this session's reverse audit was built for.
  ⚠️ **Four entries produced NO tally line** (`test:vault`, `test:client`, `gate:routes`, `test:dd`)
  — and a suite that reports nothing is indistinguishable from one that passed, which is this
  session's own subject. Checked individually rather than assumed: vault `32 passed, 0 failed`,
  client `8 passed, 0 failed`, routes `10 passed` (28 referenced paths vs 34 redirects, 6 exempted
  with stated reasons), and `test:dd`'s tallies sit under `stamp` because that chain opens with
  `npm run stamp`. All four genuinely ran.
* ⚠️ **`test:all` DOES NOT close the gap below.** Every suite is in-process or mocked; none of them
  supplies a real Circle key, so a green run says nothing about whether a spike works under the new
  recipe. A full-suite pass is not evidence about the credential path.
* ✅ **PROD PROBE PROVEN LIVE 2026-08-17 — the rebuilt tooling works end-to-end against prod.**
  `probe-ub-auth.mjs` 5/0 against `https://app.tikpema.xyz/api/agent-ub-spend`: the unauthenticated
  CONTROL returned **401** (so the route is live and a 401 would have meant something), and the
  authenticated over-cap request returned **`400 {"error":"exceeds per-spend limit of 50 USDC","cap":50}`**
  — the token was **TRUSTED** and the cap refused the amount. **Zero money moved**, by construction:
  the cap is enforced before any UB call.
  ⭐ This closes the ACCEPT path for `_prod-session.mjs`, which until now had only its REFUSAL path
  proven (18 subprocess cases). A guard whose accept path is untested can be uniformly-refusing and
  look identical to a working one.
  ⭐ It also re-confirms the divergence from the live values: the prod secret is 64 chars and is NOT
  `.env`'s — had they matched, the guard would have refused before any request.
  ⚠️ Recorded exception: the repo's standing rule is **never auto-mint a session token** — the user
  directed this run explicitly, and it is zero-money by construction. The rule stands for
  `fire-ub-spend.mjs`, which is untouched and remains the user's to run.
* ✅ **KIT_KEY GUARD ACCEPT PATH PROVEN WITH A REAL KEY 2026-08-17 — pipeline half deliberately left
  open.** A throwaway kit key was issued from `console.circle.com/api-keys`, supplied via
  `read -rs` (73 chars), and `spike-sync-budget.mjs` run twice. `requireKitKey()` is at **L45**; both
  runs printed messages from **L61** and **L62** — *downstream* of it — and the L63 verbatim-shape
  check never fired. **So the guard accepted a genuine hand-issued key and execution continued.**
  That is the accept path, proven against a real credential rather than the suite's fixtures.
  ⚠️ **WHAT IT DOES NOT PROVE:** the run stopped at L62 (`WALLET_ADDRESS` unset — a gap in the runbook
  I gave, not a defect) and never reached the Circle quote call at L84. **Circle's API was never asked
  to accept the key.**
  ⭐ Incidental confirmation: run 1 printed the *new* L61 message from `cf47676`, so that fix — five
  runtime error messages that still said "get it from the prod env" — is confirmed live.
  ⭐ Zero residue by design: the key was `unset` and then **REVOKED** in the Circle console, so the
  proof created no lasting credential to manage. `unset` alone would not have — it clears the shell
  while the credential stays valid, and the two were explicitly distinguished at the time.

* ✅ **`is_secret` ON KIT_KEY — DECIDED: STAYS `false`. Not pending, not deferred.**
  The reasoning was settled 2026-08-16 and nothing since has changed it: **the `builds`-scope drop was
  the whole win.** `is_secret` protects only against Netlify console/CLI access — a far smaller
  population than the 20-file readback tree that was the actual exposure, and that tree is now zero.
  ⚠️ Recorded as DECIDED on purpose. Left as "pending" it would sit on the list forever as an item
  nobody intends to close, which is how a list stops being read. Off the list, with a reason, and
  revisitable if someone later has one.
  🚨 **THE RESIDUAL, NAMED PRECISELY — this sentence is the reason, and it must survive the
  conclusion:** *a self-issued kit key could behave differently at Circle's API than the deployed one,
  and that is exactly what cannot be discovered after losing readback.* "Untested" understates it:
  the untested thing is the one thing `is_secret` makes permanently untestable. Closing readback
  before Circle has ever accepted a self-issued key trades a small access reduction for the loss of
  the only way to find out.
  ⚠️ This bullet previously read "`is_secret` is now unblocked — hold until a key is confirmed
  working". **Superseded by the DECIDED entry above, and rewritten rather than deleted** because the
  contradiction is the instructive part: the stale line survived the same commit that recorded the
  decision, and was caught by grepping for the OTHER copy — the exact discipline being cited two
  bullets up. A record that contradicts itself is worse than one that is merely incomplete.
* ✅ **`SESSION_SECRET` divergence RESOLVED — accidental in origin, deliberate in retention.** A
  half-finished rotation is ruled out (no `env:set` in shell history — all 7 hits are `env:get` — no
  rotating commit, and `.env.example` introduced the var once at `7c6a51a` and never changed it).
  Designed separation is ALSO ruled out: PROGRESS.md:7511 records it as a **"Blocker"** found while
  debugging a 401, and lists "align local/prod `SESSION_SECRET`" as one of two ways to CLOSE it —
  nobody proposes aligning what they deliberately separated. Two values were generated
  independently; the mismatch was found expensively, alignment was **declined**, and reading the prod
  value at call time became the documented method. Defensible end state, rationalised rather than
  designed.
  🚨 **The consequence outranks the label:** that workaround is a READBACK DEPENDENCY on
  `env:get SESSION_SECRET --context production` — the KIT_KEY shape exactly. Holding `is_secret` was
  right for a reason not yet identified at the time; flipping it kills authenticated prod probing
  except via a real browser login. ⚠️ And the tooling (`probe-ub-auth.mjs`, `fire-ub-spend.mjs`) was
  untracked and **is already gone** — the method survives only as prose.
  ⚠️ Evidence strength stated: Netlify exposes NO created/updated timestamps on env values, and
  `~/.bash_history` is one machine and length-capped, so "no rotation" rests on shell + commit
  history, not an authoritative log.
* ⏭️ Still open from earlier: `CIRCLE_ENTITY_SECRET` offsite copy; the Circle-support question about
  validating a recovery file without a reset.

# ✅ HANDOFF RESOLVED — the deploy it was written about did NOT land; it has now been redeployed

**Answered 2026-08-15 21:02Z.** The handoff below did its job exactly as designed, and the answer to
its first question was **no**. Production was serving `8e8c2b6` — two commits behind, missing both
`63e7dac` and `1835499`. The deploy started at 19:48:51Z died mid-bundle and its record is still
sitting at `new`. A fresh `deploy:prod` at 20:36:07Z published at 21:02:28Z (~26 min), and
`gate:deployed` now reports **DEPLOY VERIFIED** on tree `f3bbc36fd6bc` / commit `f4cb3e78fb76` under
deploy `6a80cdb71972b88faccfb167`. See the entry directly below for what the redeploy exposed in the
gate itself. The handoff text is kept verbatim as the record of a prediction that came true.

---

# 🚨 HANDOFF — WRITTEN BEFORE A DEPLOY THAT MAY NOT FINISH

**Written 2026-08-15 ~19:40Z at 97% context, deliberately before starting a ~25-minute foreground
deploy.** The session will probably end mid-flight. That is exactly how five deploys ended up in
state `new` on 2026-08-14, so this exists so the next session does not have to reconstruct it.

## ⭐ FIRST THING TO CHECK: DID THE DEPLOY LAND?

The deploy being started carries **`1835499`** (or whatever `git log -1` shows if this file is
newer). `gate:deployed` is chained into `deploy:prod` and runs automatically — **but a completed
deploy self-verifies into a log nobody reads, and a deploy that DIED DURING UPLOAD leaves a silent
`new` record with `error_message: null` and nothing red anywhere.**

Run this first. It answers both cases:

```bash
npm run stamp && npm run gate:deployed   # then: npm run stamp:clear
```

* ✅ `DEPLOY VERIFIED` → it landed; nothing to do.
* ❌ `the published deploy is `ready`` fails, or **check 5 lists an orphan** → the deploy died
  mid-flight. Re-run `npm run deploy:prod` (foreground, budget ~25 min).
* ⚠️ A commit-mismatch under a MATCHING tree is NOT a failure — it means later commits touched only
  files outside the stamped surface.

## WHAT SHIPPED IN THE LAST THREE COMMITS

| commit | what |
|---|---|
| **`63e7dac`** | **1b — the vault gate refused without saying why.** A 409 carries the fresh disclosure; the client did `throw new Error(data.error)` and discarded the body, so the server's *"carrying the disclosure so the UI can render exactly what must be acknowledged"* had NO CONSUMER. Fixed with `errorWithPayload` (extracted so it is TESTED by calling, not grepped for), a computed `diffDisclosure` (which warn appeared/disappeared, which named fee moved and from what to what), and the **`unexplained`** case — a refusal none of the four digest inputs explains says so, because an empty panel reads as "nothing important happened". The disclosure now also carries its own digest inputs, since a fee-only change was previously unexplainable. |
| **`8e8c2b6`** | `POLICY_CEILING` rides on every `evaluatePolicy` result — *a policy gate can never say "safe", only "nothing was found against your rules"* — written before the UI copy exists. Plus the three accidental safety mechanisms on the vault path, recorded as a table. |
| **`1835499`** | **The quote-suite "defect" was a fixture ageing past a TTL**, plus `test:all`. |

## ⚠️ TWO CORRECTIONS THE NEXT SESSION MUST NOT RE-LEARN

1. **`pruneOwnerQuotes` was NEVER broken.** I wrote "the test isn't broken; the module is" — wrong.
   The test hardcoded `quotedAt: "2026-08-01T12:34:56.789Z"`, which crossed `QUOTE_TTL_MS` (14 days)
   at **2026-08-15T12:34:56.789Z**. After that the write-then-prune correctly expired the record it
   had just written. Fixture age 14.29 days vs a 14-day TTL. **Production is unaffected** — `quotedAt`
   is minted at write time.
2. **A bisect could not have found it.** Clean worktrees at twelve commits back to `a7ca274` (the
   commit that INTRODUCED the suite) all failed, and I concluded "it never passed". That was an
   artefact of the method: **a `Date.now()`-relative test fails at EVERY commit once the wall clock
   passes the boundary**, because every run shares one clock. History showed a defect that was never
   there. The TTL boundary is now pinned deliberately with an injected clock.

## ⭐⭐ `npm run test:all` — USE IT, AND READ `$?`

13 suites chained with `&&`. **Never grep suite output.** "Read the exit code" was already written
down from the bridge-suite incident and failed AGAIN on 2026-08-15: suites were checked with
`grep -c "FAILURES"` and `0` read as green — but **a crash prints no summary line**, so a crashing
suite counted as passing and several "bridge green" reports were false. See
`scripts/README-testing.md`. As of this handoff **`test:all` exits 0**, tsc + build clean.

## WHERE THE POLICY THREAD IS

✅ **`evaluatePolicy` HAS A CONSUMER** — `POST /api/agent-dd-report`, built 2026-08-16, **NOT YET
DEPLOYED**. The shared ladder (`_dd-rungs.mjs`), the in-app route, and the warn supersession all
landed; see the entry below for what each one is defending. `test:all` exits 0, tsc + build clean.

Still ahead on this thread:

* **The UI consumer.** The route exists and **nothing calls it** — no card, no fetch. This is the
  mirror of the DCA bug and `gate:routes` structurally cannot see it (see OTHER OPEN ITEMS).
* ✅ **DONE 2026-08-16 — policy storage.** `agent-policy` / `o/<owner>`, four states, unknown groups
  rejected at write AND read, server-computed digest, threshold bounds. ⚠️ Still `display-only`, and
  the flip is blocked by a THROW in `assertMayGate` until the override ships.
* **The override token binding the policy digest** — without it a later edit makes the receipt claim
  a rule that no longer means the same.
* **Step 2 of the warn migration:** `gateDeposit` must READ `holder`/`holderKind` and the power
  catalogue from the report. Only then may the superseded warns be deleted. The condition is written
  at the code as `deleteWhen`, not here.

⭐ **MEASURED, not estimated: 9 JSON-RPC requests per card render** across 2 endpoints (5 + 4), not
the ~8 predicted. The asymmetry is `pin()`, which is deliberately NOT quorumed — one endpoint is
pinned and the same block tag goes to every other. No cache, and the suite asserts there isn't one.

## OTHER OPEN ITEMS

* ⭐⭐ **POOL DISCOVERY IS PARKED, AND THE REASON IS ON-CHAIN, NOT A PREFERENCE.** Measured
  2026-08-16: **no canonical Uniswap factory exists on Arc** — every canonical address has NO CODE
  (control: Arc USDC returns 1,798 bytes, so the probe is not vacuously empty), and **48 different
  addresses run byte-identical V3 Factory code under 48 DIFFERENT owners**. There is nothing to
  anchor "is this pool legitimate" to. ⚠️ And the **131,327** total is the residue of a stopped bot
  farm — **~19 pools/hour now against 45,021 in July**. ⭐ The buildable version is a POLICY SUBJECT
  (*"evaluate this pool against your rules"*, reusing `analyze` → `evaluatePolicy`), never a browse
  surface: a browse surface needs an authority that does not exist. Full census in the entry below.
* 🚧 **The Polygon record** — PROVEN arrived on-chain (IRIS `complete`; Amoy receipt `0x1` at block
  43,849,013; 0.94899 USDC to the recorded recipient, matching `netPredicted` exactly) but still reads
  `mint_unconfirmed`. Past the 7-day auto-retry bound by design; **resolves when the owner opens the
  Bridge panel**.
* 🚧 **Hop 2 of the unified-balance exit has never run.** Matures ~2026-08-19.
* 🚧 **The source-grep sweep** — *"the string appears" is not "the call happens."* Five instances now:
  a dead `indexOf` (`-1 < anything`), a tautological `||`, an exported function with zero callers,
  the 409 disclosure with no consumer, and — 2026-08-16 — a "there is no cache" check that read the
  producer's own JSDoc *arguing about* caching and went red. Comments must be stripped before any
  claim about what the CODE does.
* ✅ **DONE 2026-08-16 — `gate:routes` now audits BOTH directions.** 10/0. The reverse pass found
  **7 dangling redirects**, not one: `dd-analyze` and `dd-openapi` (sold to strangers — the SPA is
  correctly not the caller), `agent-init` / `agent-status` / `agent-parameters` / `agent-ub-spend`
  (operator-only, deliberately never wired to a button), and `agent-dd-report` (🚧 genuinely not
  wired). ⭐ An exemption must STATE A REASON — the list is audited too: an entry for a route that no
  longer exists fails, an entry contradicted by an actual caller fails, and a reason under 25 chars
  fails. ⚠️ The `agent-dd-report` entry is a **placeholder that must be deleted when the card lands**;
  leaving it would hide the exact class the reverse audit exists to catch.
  ⚠️ **It did NOT trigger the refusal-window capture** — `scripts/` is in neither `SURFACES` nor the
  DD surface, so `tree` and `ddTree` were byte-identical before and after (verified by stamping, not
  assumed). Nothing deployable changed.
* ⭐ **~~`gate:routes` AUDITS ONE DIRECTION ONLY~~ — the record of why, kept.**
  It checks **referenced → redirect**, which caught nothing on 2026-08-16: the new
  `/api/agent-dd-report` redirect exists with **nothing calling it**, and the gate passed. The
  reverse audit, **redirect → referenced**, is the same tool pointed the other way.
  ⚠️ The two failures are mirrors of each other and BOTH have happened here: a **reference with no
  route** left `/api/dca-*` dead for 22 days while its notes claimed "FULLY VERIFIED … UI", and a
  **route with no reference** is what this session just shipped. One audit covering one of them is
  **half a guard**. ⚠️ A dangling redirect is the cheaper failure — it 404s nobody — but it is also
  the one that lets a route be believed shipped when no code path reaches it.
* 🚧 **THE BANNER IS STILL UNWITNESSED — armed, and NOT fired by either of the last two changes.**
  ⚠️ Neither the reverse route audit (`scripts/`) nor the DD card (`src/`) rotates `ddTree`, so
  neither opened a window. Measured both times rather than assumed. ⭐ Only a change under
  `shared/onchain-*`, `shared/dd*`, or the listed `netlify/functions` DD files will fire it — the
  likeliest genuine candidate is step 2 of the warn migration touching the report shape.
* 🚧 **(original note) THE BANNER IS UNWITNESSED IN PRODUCTION — the capture is ARMED, not scheduled.**
  `verify-dd-report.mjs` proves the banner in-process across all three health states, but the
  DISCOVERY rung actually threading `healthDisclosure()` into the page ON A REAL DEPLOY has never
  been seen. ⚠️ **It is observable only during the post-deploy refusal window**, which opens when a
  publish rotates the DD key and closes by itself within one canary period — and manufacturing one
  on prod means deliberately corrupting the health artifact, the one thing between a broken detector
  and somebody's deposit. So `capture:window` is wired into `deploy:prod` and fires automatically on
  **the next deploy that changes DD-surface bytes**. ⭐ A no-op redeploy will NOT trigger it: the DD
  identity is a content hash, so identical DD code keeps its key and no window opens.
  🚨 Its three outcomes are enforced: OBSERVED+banner → pass · OBSERVED+no banner (or JSON served to
  an HTML GET) → **exit 1, the defect is back** · NO WINDOW → exit 0 but printed as **"NOT a pass"**.
  ⭐ Each run records the local `ddTree`, so "no window" can be told apart from "no rotation" —
  without it, *nothing happened* quietly becomes *nothing is wrong*.
* ✅ **DONE 2026-08-16 — the discovery page moved ahead of health.** It was unreachable during every
  post-deploy refusal window (measured on prod: a `text/html` GET got `application/json` 503). Fixed
  as `RUNG.DISCOVERY`, placed between RETRIEVE and HEALTH for the reason already written one rung
  above — documentation is not an answer about a subject. HTML only; the JSON `howToCall` refusal
  stays behind health. See the entry below for the honesty problem the move created and how the
  banner solves it.
* ✅ **DONE 2026-08-16 — the power catalogue is fully decided.** Seven warn, two silent with stated
  reasons, ZERO pending. ⚠️ Remaining unmeasured: the **duration** of a withdrawal delay, and
  `withdraw.lock/cooldown` (still `null` = UNKNOWN by design).
* ✅ ~~**`setStrategy` IS PRESENT ON THE LIVE VAULT AND THE CARD IS SILENT ABOUT IT.**~~ `funds-movement`
  class — the same class as `emergencyWithdraw`, which does warn. Plus `transferOwnership` (makes the
  owner-identity disclosure perishable: the holder you acknowledged can be replaced without any warn
  moving) and `setFeeRecipient`. All three measured present on XyloVault 2026-08-16. Recorded as
  PENDING DECISION rows in `POWER_DISCLOSURE`, so they cannot be forgotten — but they are still
  undisclosed today, and the denylist widening did nothing about them.
* ⚠️ **EVERY DD-SURFACE DEPLOY BLOCKS DEPOSITS FOR 0–10 MINUTES.** Measured 2026-08-16: 545s (9.1m)
  on one deploy, ≤6m49s on another. It is a DISTRIBUTION set by where the publish lands in the `*/10`
  canary cycle — mean ~5m, worst case a full period. Fail-closed and correct; a real per-deploy cost,
  and larger than the first hand-taken sample suggested.
* 🚨 **THE MONEY PATH'S COMPOSITE AVAILABILITY IS UNMEASURED.** Shape known (2026-08-16): the vault
  deposit blocks on **3 distinct services** — Netlify Blobs (pause + budget + dd-health, so ONE
  outage takes three), Arc RPC (multicall + a ~9-call quorum), Circle — **plus a CRON**. ⚠️ The
  canary margin is exact: **2 consecutive missed ticks tolerated, the 3rd blocks deposits** (dedupe
  5m < period 10m < TTL 30m). Crons have failed here before. Not a change; a number to have before
  mainnet.
* ✅ **DONE 2026-08-16 — `capture:window` now waits for the close** and reports the duration as
  "deposits were unavailable for this long"; a window that never closes exits 1.
* ⚠️ **THE MONEY-CHANNEL ESCALATION'S LIVE WEBHOOK IS UNPROVEN.** ✅ The payload, the gate and the
  delivery path are now REHEARSED end-to-end (`npm run calibrate:moneyalert`, in `test:dd`) — and
  that rehearsal's first run caught the alert quoting the wrong TTL. ⚠️ What remains: nobody has
  confirmed the real `WATCH_ALERT_WEBHOOK` accepts these bytes or is even set in prod, and firing
  THAT still costs a deliberate 20-minute outage.
* ~~⚠️ **THE MONEY-CHANNEL ESCALATION HAS NEVER FIRED IN PRODUCTION.**~~ `dd-watch`'s dual-route is
  suite-proven only: it is gated past a 20-minute grace, so firing it live means a deliberate
  20-minute DD outage during which **deposits are blocked**. Accepted as suite-proven, deliberately —
  but the first time it fires will be the first time anyone sees it, mid-outage, which is the worst
  moment to discover a malformed payload or an unset `WATCH_ALERT_WEBHOOK`. ⭐ The cheap thing nobody
  built: a manual invocation with a forced `refusingMs` past the grace against a throwaway webhook.
* ⚠️ **Mutation hygiene:** five mutations this session reported green without applying. Every mutation
  must print whether it changed anything.

---

---

## 2026-08-16 (calibration) — 🚨🚨 THE ESCALATION FIRED FOR THE FIRST TIME, AND ITS FIRST FIRING WAS WRONG

The money-channel escalation is no longer suite-proven-only, and the run that proved it **found a
real defect in the message it would have sent**.

### ⭐⭐ THE DEFERRAL ARGUMENT DID NOT SURVIVE ITS OWN WORDING

"Suite-proven only, because firing it live costs a deliberate 20-minute DD outage" — true, and it
**only ever applied to the LIVE route.** A forced invocation against a webhook nobody depends on
costs nothing: no outage, no deploy, no deposit blocked. The same move that calibrated `dd-watch`
itself, which caught two real bugs on its first run.

⭐⭐ **AND THE BRANCH WAS UNTESTABLE BECAUSE OF ITS SHAPE, NOT ITS COST.** Built inline in the
handler, the only way to see its bytes was to satisfy its condition. `moneyAlertLines()` is now a
PURE exported builder — **reachable without the condition** — and the handler calls that exact
function, so a rehearsal exercises the bytes that fire at 3am rather than a second copy.

### 🚨🚨 WHAT THE FIRST RUN CAUGHT — THE ALERT LIED ABOUT THE MARGIN

    • refusing 25m (past the 20m grace; health TTL is 20m)     ← WRONG

**Two constants are called TTL in adjacent modules.** `watch.mjs`'s `TTL_MS` is the WATCH RECORD's
freshness (20m); `health.mjs`'s `DEFAULT_TTL_MS` is the HEALTH ARTIFACT's TTL (30m) — the one that
decides when serving, and now depositing, stops. **The message reached for the wrong one and labelled
it "health TTL".**

⚠️ **AND IT READ AS ZERO MARGIN.** The grace is also 20m, so "past the 20m grace; health TTL is 20m"
states that the budget is already spent. **An operator reading that mid-outage would believe deposits
were beyond recovery with ten minutes still on the clock** — in the one message whose entire job is
to convey the margin. Now: *"past the 20m grace; the health artifact goes stale at 30m"*, aliased as
`HEALTH_TTL_MS` so the name says WHICH ttl it is.

### ⭐ WHAT THE CALIBRATION PROVES, AND WHAT IT STILL DOES NOT

**Proven:** the gate crosses at the grace and does NOT inside it · the exact rendered bytes ·
consequence-first framing · fail-closed-not-data-loss · the cause and the margin named · **valid JSON
under Discord's `content` key** · **within the 2000-char limit** (471) · a REAL fetch delivered and
accepted (HTTP 204) · the receiver got byte-identical content with the right content-type.

⚠️ **NOT proven:** that the REAL `WATCH_ALERT_WEBHOOK` accepts these bytes, or that it is even set in
production. Delivery is proven against a capture server; the live endpoint is not, and firing THAT
still costs the 20-minute outage. That is the honest remaining edge and it is written at the code.

🚨 **IT CANNOT PAGE THE REAL CHANNEL BY ACCIDENT.** `WATCH_ALERT_WEBHOOK` is never read as a
destination; `--webhook` must be explicit, and passing the real one is REFUSED by comparison. Default
is a local capture server — a calibration tool that could reach the money channel by default is one
that will, on the day somebody runs it half-awake.

⭐ Wired into `test:dd`, so the rehearsal runs on every suite pass rather than the day someone
remembers. `verify-dd-report` **175/0**. `test:all` exit 0, tsc + build clean.

## 2026-08-16 (follow-ups) — ⭐⭐ THE DEAD-CANARY ALERT IS DUAL-ROUTED, AND THE CAPTURE NOW TIMES THE OUTAGE

Two consequences of the dependency count, plus the margin written where someone will find it.

### 1 ⚠️ SAME EVENT, SECOND CONSEQUENCE CLASS — SO A SECOND ROUTE, NOT A MERGE

`dd-watch` would catch a dead canary (it polls both paths every 5m and alerts on stale/no-record),
but it posts to `DD_WATCH_WEBHOOK` — the channel deliberately separated from the money path because
**muting is per-channel** and a chatty availability alert sharing the money channel would train
someone to mute the kill-switch siren.

⭐ **That separation was right, and it still is.** What changed is not the event but its consequence:
since step 2, a stale health artifact does not merely stop DD selling reports — **it blocks
deposits**. The alert about the more serious outcome was arriving in the channel filed as least
urgent.

⚠️ **MIRRORING EVERYTHING WOULD RECREATE THE PROBLEM.** The commonest DD alert of all is the
`no-record` window after every deploy — expected, self-clearing, and it would page the money channel
on **every single deploy**. So `blocksDeposits()` gates the second route on the GRACE:

* **inside the grace** (< 20m) → DD channel only. A routine post-deploy window.
* **past the grace** (≥ 20m, TTL 30m) → also the money channel. ⭐ Grace expiry is roughly when one
  tick of margin remains, so it is the moment the risk becomes real rather than theoretical.
* a recovery is **never** escalated — the money channel is told when risk starts, not when something
  it was never told about stops.

### ⚠️⚠️ AND THE ESCALATION BRANCH IS SUITE-PROVEN ONLY — IT HAS NEVER FIRED

🚨 **IT MUST NOT INHERIT THE CONFIDENCE OF THE BRANCH BESIDE IT.** The DD-channel post is exercised
LIVE on every deploy — the post-deploy `no-record` window fires it routinely, so its delivery, its
formatting and its webhook are continuously demonstrated. **The money-channel escalation is gated
past a 20-minute grace, which by construction never happens on a healthy system.**

⚠️ Proving it live would mean holding a **deliberate 20-minute DD outage** purely to calibrate an
alert — and during that window **vault deposits are blocked**. Same cost class as the
still-failing-quiet branch already accepted as suite-proven, and accepting this one the same way is
reasonable. **Saying so is what keeps it honest.**

⭐ What IS proven: `blocksDeposits()` unit-tested at the grace boundary in both directions, the
message text asserted, the ordering (after the DD post, never throwing) asserted. ⚠️ What is NOT:
**no byte of it has ever reached the money channel.** The first time it fires will be the first time
anyone sees it, mid-outage — the worst moment to discover a malformed payload or an unset
`WATCH_ALERT_WEBHOOK`. The cheap thing nobody built: a manual invocation with a forced `refusingMs`
against a throwaway webhook.

⭐ **AND THE MESSAGE IS REFRAMED, NOT MIRRORED.** The DD text describes availability; the money text
has to say what it MEANS where money moves, because that channel's reader is not tracking DD at all:
*"DEPOSITS BLOCKED — vault deposits gate on the DD report since step 2 … likeliest cause: the
dd-canary cron has not fired."* It runs AFTER the DD post and never throws, so a second-channel
failure cannot cost the first message.

### 2 ⭐ `capture:window` NOW WAITS FOR THE CLOSE

It exited on first sight of the banner, so it could prove a window HAPPENED and never say how long it
LASTED. Fine when the window only affected a documentation page; **not fine once the same window
blocks deposits**, which is why today's `≤6m49s` had to be obtained by hand.

It now polls until the banner clears and reports **`WINDOW DURATION: Ns — deposits were unavailable
for this long`**, recorded in the ledger as `durationMs` / `openedAt` / `closedAt`.
🚨 **A window that never closes is its OWN outcome and exits 1** — an unobserved recovery is an
UNKNOWN, and reporting it as a pass with a blank duration would be absence-reads-as-safe aimed at the
instrument that measures an outage.

⚠️ **AND THE TEST HARNESS WAS MASKING A TIMEOUT AS EXIT 0.** `execFile` leaves `err.code` undefined
when it kills on timeout, so `err?.code ?? 0` reported a HUNG capture as a clean pass — the same
shape as the crashing suite that grepped green, this time inside the harness written to catch it.
Timeouts now get their own sentinel.

### 3 🚨 THE MARGIN, WRITTEN WHERE SOMEONE WILL FIND IT

    dedupe 5m  <  canary period 10m  <  TTL 30m
    ⇒ the deposit path survives TWO missed canary ticks. The THIRD blocks deposits.

That is the whole budget, and the thing that must keep firing is a **cron that has failed silently
here twice** — Netlify ACKing a `*-background` invocation without running it, and
`netlify deploy --dir=dist` not registering schedules at all.

Recorded at `DEFAULT_TTL_MS` in `shared/dd-canary/health.mjs` (with the note that shortening the TTL
or lengthening the cron **spends that margin directly** — neither is a tuning knob any more), and
restated in `_vault-report.mjs` where the money path reads it. ⭐ **And ASSERTED**: the suite reads
the cron period from `netlify.toml` — the only place it exists, so no second source of truth — and
fails if the margin is not exactly three ticks.

### ⭐⭐ AND THE UPGRADED CAPTURE PAID FOR ITSELF ON ITS FIRST RUN

Deployed as `6a81f9f2139f476b3678c02e` (`ddTree` `0cff0b4b2b0c → de01523615e6`). The window opened,
and the capture timed it to the close **automatically**:

    ⏱  WINDOW DURATION: 545s (9.1m) — deposits were unavailable for this long.

🚨 **NEARLY DOUBLE THE HAND-TAKEN FIGURE FROM THE DEPLOY BEFORE IT** (≤6m49s, estimated ~5 min). Both
are correct; the earlier one was a lucky sample whose publish landed just before a tick. ⭐ **The
honest statement is a DISTRIBUTION, not a value: every DD-surface deploy blocks deposits for 0 to
~10 minutes**, set by where the publish falls in the `*/10` cycle — mean ~5, **worst case a full
canary period.** A single by-hand upper bound could not have shown that, which is exactly why the
number belonged in the instrument rather than in someone's terminal — and the instrument produced
the correction on its first run.

⚠️ **OPERATIONAL COST, PLAINLY: a DD-surface deploy costs up to TEN MINUTES of blocked deposits.**
Fail-closed and correct, but real, now measured instead of assumed, and worth knowing before mainnet
where the deposits are not testnet ones.

`verify-dd-report` **173/0**. `test:all` exit 0, tsc + build clean.

## 2026-08-16 (deployed + measured) — ⚠️ THE FIRST REFUSAL WINDOW THAT BLOCKED DEPOSITS, AND A COUNT OF WHAT THE MONEY PATH NOW DEPENDS ON

Policy storage is live: deploy `6a81e8d29a55fbbd35b882ca`, tree `56c7baad1e47`, `ddTree`
`b32d3e590968 → 0cff0b4b2b0c`.

### ⚠️ THE WINDOW BLOCKED DEPOSITS FOR THE FIRST TIME — MEASURED, ~5 MINUTES

Step 2 routed the deposit gate through the DD report, so while health refuses, `vaultDdReport`
returns null, `applyReportDisclosure` BLOCKS, and **the deposit is unavailable** — not just the card.
That is correct and fail-closed, and this deploy is the first time it actually happened.

| | |
|---|---|
| window opened | at or before **17:15:01Z** (capture's first probe already saw the banner) |
| window closed | at or before **17:21:50Z** |
| **observed upper bound** | **≤ 6m49s** |
| mechanism | the next `*/10` canary tick |

🚨 **AND THE HAND-MEASUREMENT UNDERSTATED IT.** The next deploy, with the upgraded capture timing the
close automatically, measured **545s = 9.1 MINUTES** — see the entry above. That hand-taken ≤6m49s
was a lucky sample: the publish happened to land just before a tick. ⭐ **The real figure is a
DISTRIBUTION, not a value** — 0 to ~10 minutes depending on where the publish falls in the `*/10`
cycle, mean ~5, **worst case a full canary period.** Exactly what a by-hand upper bound taken once
cannot tell you, and the reason the instrument had to learn to do it.

⚠️ **AND THE INSTRUMENT DOES NOT MEASURE THE NUMBER THAT NOW MATTERS.** `capture:window` records that
a window was OBSERVED and exits the moment it sees the banner — it never watches for the close. For a
window that only affected a documentation page that was fine; now that the same window blocks
deposits, **DURATION is the figure worth having and the capture cannot produce it.** The bound above
was obtained by hand. Recorded rather than fixed: it is a change to the instrument, not to the system.

### ⭐⭐ THE DEPOSIT PATH'S FAILURE DEPENDENCIES — COUNTED FROM THE IMPORT GRAPH

Enumerated over the **36 modules reachable from `_actions.mjs`**, not from memory.

🚨 **FIRST, A CORRECTION TO THE PREMISE: THE POLICY STORE IS NOT ON THE DEPOSIT PATH.** `readPolicy`
appears **zero** times in `_actions.mjs`, `_vault.mjs` and `_vault-report.mjs` — it is read only by
the CARD route (`agent-dd-report`). A policy-store outage breaks the card, not the deposit. The ack
comes from `agent-vault-inspect`, which never touches it.

| # | dependency | why it blocks | added |
|---|---|---|---|
| 1 | Netlify Blobs — `agent-pause` | `assertNotPaused` fail-closed | pre-existing |
| 2 | Netlify Blobs — `data-budget` | `canSpendDay` | pre-existing |
| 3 | Netlify Blobs — `dd-canary-health` | the health gate | **today (step 2)** |
| 4 | Arc RPC — viem multicall, ONE public endpoint | `inspectVault` | pre-existing |
| 5 | Arc RPC — quorum, 2 endpoints, ~9 calls | `analyze` via `vaultDdReport` | **today (step 2)** |
| 6 | Circle API | the approve + deposit itself | pre-existing |
| 7 | **the canary CRON firing** | health goes stale in 30 min | **today (step 2)** |

⭐⭐ **THEY ARE NOT INDEPENDENT, AND THAT IS THE FINDING.** Three of the seven are the SAME service —
**Netlify Blobs** — so one Blobs outage takes out pause, budget AND health together. Two more are the
same Arc RPC. **Distinct external services on the deposit path: THREE** (Blobs, Arc RPC, Circle),
plus one liveness dependency. A naive product of seven independent probabilities would badly
overstate the availability.

⭐ **SO TODAY DID NOT ADD NEW SERVICES — it added new CONSUMERS of services already on the path, and
one thing that is not a service at all.**

🚨 **THE NEWEST DEPENDENCY IS A CRON, AND CRONS HAVE FAILED HERE BEFORE.** The deposit path now
depends on `dd-canary` firing. This file already records that Netlify intermittently ACKs a
`*-background` invocation without running it, and that `netlify deploy --dir=dist` does not register
scheduled functions at all. **The margin is exact:** dedupe 5m < period 10m < TTL 30m, so
**the deposit path tolerates 2 consecutive missed canary ticks and the 3rd blocks deposits.**

⚠️ **NOT A CHANGE — A NUMBER TO HAVE BEFORE MAINNET.** Each dependency is individually correct and
fail-closed. The composite availability of the money path is still UNMEASURED; what is now known is
its shape: 3 services, 1 cron, 30 minutes of canary margin.

## 2026-08-16 (policy storage) — ⭐⭐ RULES ARE SERVER-SOURCED NOW — AND STILL CANNOT GATE, BY A THROW

`POST/GET/DELETE /api/agent-policy`, one record per owner at `agent-policy` / `o/<owner>`, keyed by
the SESSION address and never by anything from a body.

### ⚠️⚠️ (1) THE DECISION: STORAGE FIRST, AUTHORITY LAST — AND THE FLIP IS BLOCKED BY A THROW

Storage is exactly what would let a policy stop being advisory: a server-stored policy has none of
the *"the caller chose their own rules"* defect. **Which is why it becomes dangerous.** Storage
WITHOUT the digest-bound override token is a policy that can BLOCK a deposit with no escape — and the
rules are the user's own, so the lockout is self-inflicted and unappealable. Same 409-lockout shape
already rejected here once.

⭐ **So `authority` stays `display-only`, and it is not merely SET to a safe value.** `assertMayGate()`
**THROWS** while `OVERRIDE_TOKEN_EXISTS = false` — even when passed `ENFORCING`. The first author to
wire a gate meets an exception naming the file and the flag, not a silent enforcement. ⚠️ Leaving a
field on a safe value and trusting the next person to notice is how a safe default becomes an unsafe
one, quietly, in a diff about something else.

### ⭐⭐ (2) FOUR STATES, AND COLLAPSING ANY TWO IS A CONSENT BUG

| state | why it is its own |
|---|---|
| `absent` | never expressed a preference |
| **`empty`** | ⚠️ a record whose `rules` is `{}` — **the shape a WIPE leaves behind** (failed migration, half-completed delete). A user whose rules got wiped has made NO decision, and reading `{}` as consent is how a cleared policy becomes a green tick |
| **`all-allow`** | ⭐ **this one IS a decision.** It legitimately PASSES — and the copy says *"they pass because you refuse nothing, not because nothing was found"*, which is a different sentence from the normal pass |
| `active` | at least one rule refuses |

Each has its OWN sentence in the response; the suite asserts all four sentences are distinct, because
a shared string would re-collapse them in the UI regardless of the enum.

### ⚠️ (3) UNKNOWN GROUPS REJECTED AT WRITE **AND** AT READ

A policy naming `upgradable` would silently fail to refuse `upgradeable` — **the user's own safety
rule, quietly doing nothing, with a UI still showing it as set.** Rejected whole, offender named, real
catalogue listed so the error is actionable. ⚠️ Dropping the bad key is WORSE than rejecting, because
the user keeps believing they are protected.

⭐ **READ-TIME IS NOT REDUNDANT.** A policy stored before a catalogue change can name a group that no
longer exists; validating only on write would let it read back, silently skip the vanished rule, and
evaluate as though the user never wrote it — **the same evaporation arriving through time instead of
through a typo.** `readPolicy` runs the same normaliser and returns errors instead of a usable policy.

### ⭐ (4) SERVER-COMPUTED DIGEST, AND THRESHOLD BOUNDS

* **The digest is never accepted from a caller** — a body carrying `digest` is REJECTED, not ignored
  (a caller that sent one believed it would be used). The future override token binds to this digest;
  a client-supplied one would bind an override to rules nobody stored.
* **Canonical** — rule order does not change it, a changed verdict does. Versioned `v1` from the
  start, because the vault digest's v1→v2 bump only worked because the marker was already there.
* ⭐ **`null` ≠ `0`.** `null` = no threshold. `0` = trivially met, which is a STATEMENT, not an
  absence. They digest differently, and `null` renders as `cov:none` rather than an empty slot.
* 🚨 **A threshold above the catalogue size is REJECTED** — it can never be satisfied by any report
  about any contract, so every evaluation would refuse forever **for a reason that looks like a
  finding about the vault.** Caught where it is still a typo.

### ⭐ AND THE REPORT ROUTE PREFERS THE STORED POLICY

Stored wins; a request policy is accepted only when nothing is stored, and `source: "stored" |
"request" | "none"` says which. ⚠️ **An UNREADABLE store REFUSES rather than falling back to the
body** — a store outage silently downgrading a user's real rules to whatever this browser sent would
replace the safety input at the worst moment. A stored-but-invalid policy surfaces as
`stored-policy-invalid` and is not evaluated.

### ⭐ THE REVERSE ROUTE AUDIT EARNED ITS KEEP AGAIN

`/api/agent-policy` shipped with a redirect and no caller, and `gate:routes` **failed**. The honest
fix is wiring, not an exemption — **storage nobody can reach is not storage** — so the card now loads
stored rules on mount and has a Save button. ⚠️ It states STORED vs LOCAL rather than implying it,
and a failed read renders *"couldn't check"*, never *"you have none"*.

⚠️ **One of my own source-regexes broke on a legitimate refactor** — it grepped for the literal
`authority: "display-only"` and went red when the route switched to the `POLICY_AUTHORITY` constant.
A change that made the guarantee stronger breaking the check that guards it. Rewritten to assert the
VALUE, not the spelling.

`verify-policy-store` **42/0** (new, wired into `test:dd`). `test:all` exit 0, tsc + build clean.

## 2026-08-16 — 🚨🚨 THERE IS NO CANONICAL UNISWAP FACTORY ON ARC, AND THAT IS WHY DISCOVERY CANNOT BE BUILT HONESTLY

A READ, not a build. No money, no deploy, no third party — `eth_getLogs` over chain data only.

### ⭐⭐ THE FINDING: THE THING DISCOVERY WOULD ANCHOR TRUST TO DOES NOT EXIST

Any pool-discovery feature has to answer *"whose factory made this pool"*, because that is the only
cheap proxy for legitimacy available. On Arc there is no answer.

* **EVERY canonical Uniswap address has NO CODE.** V3 Factory `0x1F98431c8aD98523631AE4a59f267346ea31F984`,
  V2 Factory `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f`, V4 PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90`,
  plus the Base and BNB variants. All empty.
* ⭐ **THE CONTROL PROVES THE PROBE IS NOT VACUOUSLY EMPTY** — the same `eth_getCode` against Arc's
  USDC `0x3600…0000` returns **1,798 bytes**. Without that control, "no code anywhere" is
  indistinguishable from a broken reader, and this file's whole thesis is that an absence must never
  fill a result slot unchallenged.
* 🚨 **48 DIFFERENT ADDRESSES RUN BYTE-IDENTICAL UNISWAP V3 FACTORY CODE.** Diffed against Ethereum
  mainnet's real one: **24,535 bytes on both sides, differing in exactly 20 bytes** — the factory's
  own embedded address — with `uniswapV3{Swap,Mint,Flash}Callback` selectors intact and an identical
  solc-0.7.6 metadata trailer. ⚠️ **And each has a DIFFERENT `owner()`.** Forty-eight unrelated
  parties deploying the same audited source. Genuine Uniswap CODE, zero Uniswap AUTHORITY.
* **The largest are rebranded forks**, identified from error strings in the deployed bytecode —
  `ArcFlowV25: FORBIDDEN` (43,762 pairs), `Apexiswap: PAIR_EXISTS`, plus Curve- and Pancake-branded.
  `0xab6a8aab…` is ArcFlow's V3: Uniswap V3 source with the three callbacks RENAMED, same `owner()`
  as its V2 factory and its V4 PoolManager.

⚠️ **SO "WHICH FACTORY IS REAL" HAS NO ON-CHAIN ANSWER HERE**, and a UI that ranked or listed pools
would be inventing one. That is the same shape as the accidental clean bill this repo keeps closing,
scaled to a browse surface.

### ⭐⭐ AND THE COUNT IS AN ARTIFACT, NOT A MARKET — THE ARITHMETIC IS WHAT SHOWS IT

**131,327** pool-creation events sounds like a live ecosystem. Re-scanning 8h16m later found
**+156 events — about 19 pools/hour.** July alone produced **45,021**. One factory (`0xba27c71b…`,
genuine Uniswap V3 bytecode) made **59,620** pools in three weeks, every one USDC-paired against a
fresh single-use token.

⭐ **The bot farm has STOPPED.** The total is the residue of a burst, not a rate — and a number that
describes a finished burst reads exactly like a number describing a thriving market. That difference
is invisible in the total and obvious in the delta, which is why the re-scan was worth doing.

### THE NUMBERS

| | |
|---|---|
| pool-creation events, all time | **131,327** (V2 65,216 · V3 64,345 · V4 1,766) |
| distinct factory contracts | **492** |
| distinct tokens | 116,433 — **86.4% appear in exactly ONE pool** |
| **USDC-paired** (`0x3600…0000`) | **62,646 (47.7%)** |
| EURC-paired / USYC-paired | 1,126 / 6 |
| earliest pool | block 6,535,750 — **2025-10-18T20:48:16Z** (V3, `0x23dbcec2…`) |
| most recent pool | block 57,310,387 — **2026-08-16T15:38:00Z** (V4, `0x33c02bfb…`) |

⚠️ **13,431 pools use the ZERO ADDRESS as a token side**, which Arc's own porting guide warns
against. **`WUSDC` (`0x911b4000…`) appears in 40,205 pools** — a wrapped-native token Arc's docs say
should not exist ("no wrapped native token on Arc and no `WUSDC`/`WETH` equivalent is needed").

⭐ **CREDIBLE SUBSET** — both sides used in ≥5 pools, neither the zero address:
**7,969 pools · 1,109 tokens · 382 USDC-paired · 192 factories.**

### METHOD, AND HOW IT WAS CORROBORATED

Unfiltered `eth_getLogs` topic scan over **every block, 0 → head**, HEAD pinned first so the interval
is fixed and reproducible. 5,726 windows of 10,000 blocks, **retried internally until ZERO windows
were unmeasured**, coverage asserted against the full window list at the end. Topic0 values computed
with viem, not recalled. ⚠️ An earlier attempt was DISCARDED because its cross-run checkpoint file
proved unreliable — [filtered-read-is-not-absence] applied to the scan's own bookkeeping.

**Two independent instruments agree:**
1. A separate scan run, deduped by `txHash:logIndex`, produced the identical total.
2. Factory `0xd67f63a4…` reports `allPairsLength() = 43,762` **on-chain**; the log enumeration counts
   **43,762** for that factory. The contract's own counter matches the event count exactly.

### ⭐ WHAT THIS DECIDES

Not a handful — but it does not say "build discovery" either. **131,327 pools carry no signal about
which are legitimate, and there is no canonical factory to anchor trust to.** Listing or ranking them
surfaces junk behind a confident UI.

⭐ **THE BUILDABLE VERSION IS A POLICY SUBJECT, NOT A DISCOVERY SURFACE:** *"evaluate THIS pool
against your rules"* — the same `analyze` → `evaluatePolicy` path pointed at a pool address. It
reuses the foundation completed today, needs no index, no ranking, and no trust in a factory nobody
can verify. **A browse surface needs an authority that does not exist; a policy check does not.**

⚠️ The raw corpus (96MB of logs, `pools.json`, `classified.json`, `ARC_POOL_CENSUS.md`) lived only in
a session scratchpad and will not survive. This entry is the record.

## 2026-08-16 (catalogue complete) — ⭐⭐ `pausable` AND `withdrawalDelay` DECIDED — BOTH WARN, AND ONE OF MY OWN REASONS WAS FALSE

Every one of the nine catalogue groups is now a DECISION. Nothing is PENDING.

**Seven warn** · `emergencyWithdraw` `feesSettable` `upgradeable` `denylist` `setStrategy`
**`pausable`** **`withdrawalDelay`**
**Two are silent, each with a stated reason** · `transferOwnership` (handled in the digest instead)
· `setFeeRecipient` (changes nothing a depositor stands to lose)

### ⭐ BOTH ARE THE REST OF THE DENYLIST ARGUMENT

`denylist` was admitted because it is *"not about what the owner can TAKE; it is about whether YOU can
leave"*. A pause and a withdrawal queue reach the **same outcome — your funds stay put** — by
different routes. Excluding them while admitting denylist was an ordering, not a distinction.

⚠️ **AND SELECTOR PRESENCE CANNOT ESTABLISH THE BENIGN READING, which is what settles it.** We can see
`pause()`; we CANNOT see whether the pause spares withdrawals. We can see `withdrawalDelay()`; we
CANNOT see whether the wait is an hour or unbounded. **Staying silent would assert the comfortable
half of an unknown** — the exact fail-open family this module exists to close. So the wording states
what was found AND what could not be established: *"we can see the pause switch but NOT what it
halts"*, *"nothing establishes an upper bound"*.

⚠️ **UBIQUITY IS NOT A REASON TO HIDE A MATERIAL FACT.** A pause is near-universal good practice, so
this warn will fire on most well-built vaults. That makes the disclosure often non-empty, which is
honest. The `setFeeRecipient` test is MATERIALITY — does it change what a depositor stands to lose —
and an exit that can be closed plainly does.

### 🚨 AND MY EARLIER `why` FOR `withdrawalDelay` WAS SIMPLY FALSE

I had written: *"delay is not denial, and the withdraw mechanics are already reported as plain
fields."* ⚠️ **The second half is wrong.** `withdraw.lock/delay/cooldown` are hardcoded `null` —
explicitly NOT CHECKED, for any vault, by design (defect C). So the "plain fields" I pointed at have
never contained anything.

⭐⭐ **AND IT INVERTED THE ACTUAL SITUATION.** The DD report DOES scan the group — including
`initiateWithdrawal(address,uint256)`, a **two-step withdrawal queue** — which `_vault` structurally
cannot see. Staying silent would have muted the ONLY instrument that can detect a queued exit, while
pointing at a field guaranteed to stay empty. A one-line justification written without checking, on
the money path, that survived two passes.

⚠️ The allowlist header claim *"a vault with a withdrawal queue is not detected"* is corrected: a
queue now WARNS; what remains unmeasured is the **duration**.

### ⭐ TWO INSTRUMENTS ON ONE FACT — MADE A CROSS-CHECK, NOT A DRIFT RISK

`pausable` is now observed twice: by `_vault`'s own scan (`withdraw.pausable`, DISPLAY ONLY, feeds no
gate) and by the report (which drives the warn, the level and the digest). `verify-vault` §ROW 1c
asserts they AGREE — a disagreement would be a real finding about one of the two scans, since they
read the same selectors against the same address. ⚠️ Recorded honestly: on XyloVault both are FALSE,
so today's agreement is **0-vs-0** and weak. It becomes load-bearing the moment a vault with a pause
switch is allowlisted — which is exactly when a silent divergence would matter.

⚠️ **NO LIVE EFFECT ON XyloVault** — it has neither power, so its warns and digest are unchanged.
This pass is entirely forward-looking, and that is the honest description of it.

`verify-dd-report` **155/0**, `verify-vault` **45/0**, `verify-vault-degraded` 32/0. `test:all` exit 0.

## 2026-08-16 (consistency + digest v2) — ⭐⭐ `setStrategy` DISCLOSES, AND THE HOLDER IS FINALLY IN THE DIGEST

Three decisions, each taken on its own terms rather than as one "widen the set" sweep.

### 1 ⭐ `setStrategy` WARNS — CONSISTENCY, NOT EXPANSION

Severity `funds-movement`, the **same class as `emergencyWithdraw`**, which has always warned. Two
powers in one severity class — one disclosed, one silent — is not a threshold, it is an
inconsistency. And it was silent **on the live vault** while the card claimed to disclose what the
owner can do. Now visible: XyloVault's warns are `emergency-withdraw, fees-settable, **set-strategy**,
owner-is-eoa, performance-fee`.

### 2 🚨🚨 `transferOwnership` DOES **NOT** WARN — IT WAS A DIGEST BUG ALL ALONG

⭐ **A WARN WOULD NOT HAVE FIXED ITS PROBLEM.** It adds no power; it makes the owner-identity
disclosure PERISHABLE. A warn says *"this can happen"* once, at acknowledgement time, and then never
fires again when it actually did.

🚨 **THE HOLE:** `disclosureDigest` v1 was `address | warn codes | withdrawFee | depositFee` — **the
owner was not in it.** So an ownership transfer from one EOA to a DIFFERENT EOA left every input
identical (the warn code is still `owner-is-eoa`), the digest did not move, and an acknowledgement
taken against *"the owner is 0xABC"* stayed valid for a vault now owned by 0xDEF. **The user acked a
holder claim that had silently become false.**

⚠️ **AND IT FAILED ASYMMETRICALLY, WHICH IS WORSE THAN FAILING ALWAYS.** EOA → multisig *did* move
the digest, because the warn code disappeared. So transitions that changed the disclosure's
CHARACTER invalidated acks, while transitions that merely changed **who holds the keys** did not —
exactly backwards from what a depositor cares about.

**Digest v2** = `… | holder | holderKind | v2`. ⭐ Both address AND kind: `renounced` is address
0x000…0 while `no-owner-fn` has no address at all, and *"we asked and there is no owner()"* must
never collapse into *"ownership was renounced"*. An absent holder renders `holder:none`, an explicit
marker rather than an empty string that could prefix a real value.

⚠️ **AND THE INPUT TRAVELS WITH THE DIGEST.** Shipping a new digest input without shipping the input
itself would have swapped one silent failure for another: the ack would die correctly and the panel
would render `unexplained` — *"it changed and we cannot show you how"* — **for the single change most
worth naming.** `holder`/`holderKind` are on the disclosure payload, `diffDisclosure` gained a
first-class `holderChange`, and `VaultPanel` renders *"The owner changed. 0xABC… (eoa) → 0xDEF…
(eoa)"* above the re-tick. Addresses are case-normalised first — a case-only difference is not an
ownership transfer, and a false alarm on this surface is exactly the wrong failure.

### 3 ⭐ `setFeeRecipient` STAYS SILENT — DECIDED, NOT DEFERRED

It redirects **where** fees go, which is between the owner and a recipient. The DEPOSITOR's exposure
is the fee **amount**, already covered by `feesSettable`. ⚠️ A line that changes nothing a depositor
stands to lose is noise on a card **whose value depends on every line mattering.** Its `why` no
longer says PENDING.

⚠️ **`pausable` and `withdrawalDelay` remain genuinely undecided** and still say so. Both are ABSENT
on the live vault, so neither is a silent gap today — but *"absent from the one vault we allowlist"*
is not a decision, and a suite assertion names exactly those two so they cannot quietly become one.

`verify-dd-report` **150/0** (new §G3 for digest v2). `test:all` exit 0, tsc + build clean.

## 2026-08-16 (widening) — ⭐ THE DENYLIST WARNS — AND THE REAL FINDING IS THE THREE POWERS THAT STILL DO NOT

`denylist` joins the acknowledged set. ⭐ It is not about what the owner can TAKE; it is about
whether **you can leave**. A blocked holder may be unable to withdraw their own funds while every
other line on the card still reads normal — solvent vault, sane fees, exit shut for you specifically.
That asymmetry is why it belongs behind an acknowledgement.

### 🚨🚨 MEASURED FIRST, AND THE MEASUREMENT CHANGED WHAT MATTERS

XyloVault does **NOT** have `denylist`, `pausable` or `withdrawalDelay`. It **DOES** have:

| power | severity | disclosed? |
|---|---|---|
| `emergencyWithdraw` | funds-movement | ✅ warns |
| `feesSettable` | economics | ✅ warns |
| **`setStrategy`** | **funds-movement** | 🚨 **SILENT** |
| **`transferOwnership`** | ownership-transfer | 🚨 **SILENT** |
| **`setFeeRecipient`** | parameter-change | 🚨 **SILENT** |

⚠️ **SO THE WIDENING AS ASKED IS A NO-OP ON THE ONLY ALLOWLISTED VAULT** — the digest is unchanged,
`level` is still WARN on the same four codes. It is correct and forward-looking (a second vault with
a denylist is now caught), and it is **not** where the live gap is.

🚨 **THE LIVE GAP IS `setStrategy`: `funds-movement` class, the SAME class as `emergencyWithdraw`,
present on the vault right now, and the card says nothing about it.** Recorded as a PENDING DECISION
row rather than quietly left out. `transferOwnership` is subtler and worth its own sentence: it adds
no power, it makes the OWNER-IDENTITY disclosure **perishable** — the holder you acknowledged can be
replaced without any warn moving.

### ⭐⭐ AND THE STRUCTURAL FIX IS BIGGER THAN THE ONE GROUP

The old table listed only the groups that WARN, so the other six were excluded **by silence** —
nothing recorded that a decision had been taken, and a TENTH catalogue group added later would have
been left off every vault card by an omission nobody wrote. That is
[absence-must-never-read-as-safe] aimed at the disclosure itself.

`POWER_DISCLOSURE` now carries **every** catalogue group with an explicit `warn`, and every silent
one must state a `why`. `assertDisclosureComplete()` runs **at module load** and throws if the table
and `POWER_SIGS` disagree in either direction. ⚠️ A module-load throw on the money path is
deliberate: it can only fire on a code-level inconsistency between two constants in this repo, every
test run catches it long before a deploy, and taking the vault path DOWN beats serving a disclosure
that silently omits a power somebody added on purpose. Proven by CALLING with a drifted catalogue.

### ⚠️ A STALE COMMENT ON THE MONEY PATH, CORRECTED

The allowlist header said *"DECLARED BUT NOT SCANNED: setStrategy / setFeeRecipient /
transferOwnership … A vault whose only owner power is one of these discloses no power."* **That
stopped being true at step 2** — the disclosure comes from the report, which checks all nine groups
(13/13 measured). The SCAN gap is closed; what remained was a DISCLOSURE decision, and the comment
was describing the wrong one. ⭐ A comment that misnames which gap is open is worse than none: it
sends the next reader to fix something already fixed.

⚠️ **`ddTree` UNCHANGED** (`b32d3e590968`) — `_vault.mjs` is a report CONSUMER, not the engine, so it
is correctly outside the DD surface. No refusal window from this deploy.

`verify-dd-report` **138/0**. `test:all` exit 0, tsc + build clean.

## 2026-08-16 (step 2) — ⭐⭐ THE DEPOSIT GATE NOW READS THE DD REPORT, AND THE SEVEN WARNS ARE DELETED

The `deleteWhen` condition written at the code — *"gateDeposit reads holder/holderKind from the DD
report instead of inspection.verdict.warns"* — is met, so the marking and the warns both go.
`inspectVault` no longer derives any of the seven; `applyReportDisclosure(inspection, report)` does,
from the same artifact the paid endpoint sells and the card shows. **The card and the deposit gate
can no longer disagree about what a vault's owner can do: they read one object.**

⚠️ `performance-fee` stays — a fee VALUE the report never reads, no replacement, never had a
`deleteWhen`. The BLOCK ladder is untouched.

### 🚨🚨 WHAT MAKES DELETING THEM SAFE: THE GATE REFUSES A RAW INSPECTION

An inspection that never went through `applyReportDisclosure` carries none of the seven, so its
`warns` look reassuringly SHORT — a deposit sailing through on a disclosure that omits every power
the owner holds. That is the silent-consent removal the retain-and-mark ordering was built to avoid,
arriving by a different door.

⭐ So `gateDeposit` requires `disclosure.source === "report"` and BLOCKS otherwise. **Fail-closed by
construction, not by call sites remembering** — there is no path from a raw inspection to an approved
deposit. Asserted by CALLING the gate with one.

### 🚨 EVERY WAY THE SECOND SUBSYSTEM CAN FAIL TO ESTABLISH SOMETHING IS A BLOCK

| | |
|---|---|
| no report | `dd-report-missing` — an absent report is not an absence of powers |
| `report.refusal` | `dd-report-indeterminate` — it established nothing |
| **different address** | `dd-report-subject-mismatch` — 🚨 would disclose ANOTHER contract's powers under this vault's name |
| different chainId | `dd-report-chain-mismatch` |
| power group in `notChecked` | WARN `owner-powers-unreadable` — **not established is not absent** |
| owner kind outside the known set | WARN `owner-unreadable` — an unrecognised kind is not benign |

⭐ Not-checked is tested BEFORE present, the same ordering `evaluatePolicy` uses and for the same
reason: asking `present` first lets an unchecked group fall through to "absent".

### 🚨🚨 AND BUILDING IT SURFACED A REAL DEFECT — ON THE MONEY PATH

The first cut of `_vault-report.mjs` called `analyze()` **directly, skipping the health gate.**
`/api/dd-analyze` refuses when the detector is not known good, and so does the card — but the DEPOSIT
GATE would have consumed that same detector's output regardless. **A detector too broken to sell a
report or draw a card would still have been trusted to say whether a vault's owner can drain it.**
⭐ And the stakes run the other way: a buyer loses the price of a report; a depositor loses the
deposit. Fixed — `serving !== true` refuses, and an UNKNOWN health state refuses too.

⚠️ `_vault-report.mjs` added to the DD surface (34 → **35 files**): a change there can silently
reconnect the money path to a detector the canary already condemned, which is this binding's own
fail-open reachable from the one path where money moves.

### ⚠️ THE COSTS, STATED RATHER THAN DISCOVERED

* **The deposit path now depends on the analyze engine** — ~9 RPC calls through a quorum against an
  RPC that has throttled this repo. **An engine outage BLOCKS deposits that previously succeeded.**
  Fail-closed and correct (`proxy-status-unreadable` already blocks for the same reason), but a real
  availability trade.
* **The digest moved**, as accepted — the warn codes are the same strings, but they now arrive from
  the report. Ack population is zero (no ack store), so the cost stays theoretical.
* ⚠️ **MIGRATION, NOT WIDENING.** Exactly the same three power warns and four owner warns. The report
  also knows `denylist` — which can freeze a holder's funds — plus `setStrategy`, `setFeeRecipient`,
  `transferOwnership`, `pausable`, `withdrawalDelay`. Warning on those is a genuine improvement AND a
  behaviour change making more vaults require an ack. **A decision to take deliberately, not a side
  effect of moving where seven things come from.** Asserted: `REPORT_POWER_WARNS` has exactly three.

### ⭐ AND IT FINALLY ROTATES THE DD KEY

`ddTree` 2848a3d6fdea → **b32d3e590968**. The next deploy opens a genuine post-deploy refusal window,
which is what `capture:window` has been armed and waiting for since it was built. ⚠️ Not engineered
for that: the rotation comes from `_vault-report.mjs` joining the DD surface because the money path
became a DD consumer — a reason that stands on its own.

Suites: `verify-vault` 43/0 (new §ROW 1b), `verify-vault-degraded` 32/0, `verify-dd-report` **131/0**
(new §G rewritten, new §G2 for the health gate). `test:all` exit 0, tsc + build clean.

## 2026-08-16 (later still) — ⭐ THE CARD — `evaluatePolicy` NOW HAS A UI CONSUMER, AND THE TWO "COVERAGE" NUMBERS ARE PULLED APART

`DdReportCard` renders inside the vault panel, BETWEEN the disclosure and the deposit: a second,
independent reading of the same contract, placed where the user is still deciding.

⚠️ **IT DOES NOT GATE THE DEPOSIT AND SAYS SO IN WORDS A USER READS.** The gate remains the vault
inspection + acknowledgement, untouched. The policy is client-supplied, so `authority` is
`display-only` and the card prints *"This verdict does not gate anything."*

### 🚨 THE OWNER'S CATCH: TWO CORRECT NUMBERS, ONE WORD

The prod response carries both, and they measure different things:

| field | value | what it counts |
|---|---|---|
| `policy.coverage` | **9 of 9** | POWER GROUPS — ⭐ **what `coverageThreshold` applies to** |
| `report.coverage.totals` | **13** | every CHECK RUN — the nine groups PLUS shape detection and the owner reads |

⚠️ A reader who takes the threshold to apply to 13 concludes the rules demanded far less of the
catalogue than they did. ⭐ So they are labelled **at the point of display** — "Power groups checked"
vs "Individual checks run" — never in a legend, which is a second place to read and therefore a
second place to not read. The word "coverage" appears **nowhere** in the rendered card, and the suite
asserts its absence.

### ⭐⭐ THE COPY SUITE ASSERTS ORDER, NOT JUST PRESENCE

`verify-dd-card-copy.tsx` (22/0) renders `DdReportResult` with react-dom/server and reads TEXT.
The threshold sentence must sit **under** the 9-of-9 number and the "does not apply" disclaimer
**under** the 13 — ⚠️ a regex on either sentence alone passes with them swapped, which IS the
confusion. Layout is the claim, and layout is exactly what source regexes cannot see.

⭐ **A PURE COMPONENT, NOT A TEST-ONLY PROP.** `DdReportResult` was extracted so the suite renders the
REAL path; an `initialData` seam would exist only for tests and therefore be exercised by nobody.

⚠️ **AND THE SUITE'S FIRST VERSION WAS WRONG IN AN INSTRUCTIVE WAY.** It asserted the word "safe"
appears nowhere and went red — because `POLICY_CEILING` itself says *"never that this contract is
safe"*, the sentence we most want rendered. A blanket ban on a word would have forced the ceiling to
be TRIMMED to satisfy a test written to guard the ceiling. ⭐ The claim is narrower and truer: the
VERDICT region must not say it; the ceiling must.

### ⭐ THE REVERSE ROUTE AUDIT CAUGHT ITS OWN STALE ENTRY

Wiring the card made `NO_FRONTEND_CALLER["/api/agent-dd-report"]` false, and `gate:routes` **failed**
on the expires-when-contradicted check — the exemption-rot guard firing on the very entry it was
written for, one commit after being written. Entry deleted; the route is now covered by the ordinary
referenced→redirect pass. Exemptions 7 → 6.

### ⚠️ AND IT STILL DOES NOT OPEN A REFUSAL WINDOW — MY PREDICTION WAS WRONG

I expected the card to touch `agent-dd-report.mjs` ("a card wants a vault key, probably a shaped
response") and so rotate `ddTree`. **It did not need to.** The card passes the address the SERVER
already resolved (`insp.vault.address`) rather than re-typing a literal, so no server change was
required. Measured, not assumed: `tree` c024addde35c **ROTATED** (real UI ships) while `ddTree`
2848a3d6fdea is **UNCHANGED**.

⭐ **THE RIGHT CALL WAS NOT TO TOUCH THE SERVER ANYWAY.** Editing a DD-surface file to make a test
fire is inventing work to satisfy an instrument, which is the failure mode this repo keeps naming
from the other direction. `capture:window` stays armed and unfired.

Files: new `src/components/DdReportCard.tsx`, `scripts/verify-dd-card-copy.tsx`; modified
`src/wallet/useWallet.ts` (`ddReport`), `src/components/VaultPanel.tsx`, `scripts/verify-api-routes.mjs`,
`package.json` (`test:ddcopy`). `test:all` exit 0, tsc + build clean.

## 2026-08-16 (later) — ⭐⭐ THE DOCUMENTATION MOVED AHEAD OF THE HEALTH GATE — AND HAD TO LEARN TO SAY THE SERVICE IS DOWN

Fixes the defect the earlier draft found: with the discovery page behind health, a browser sending
`Accept: text/html` during the post-deploy refusal window got `application/json` 503
`service-unverified` instead of the page. Measured on PROD, not theorised. New `RUNG.DISCOVERY`
sits between RETRIEVE and HEALTH.

⭐ **THE ARGUMENT WAS ALREADY IN THE FILE, ONE RUNG ABOVE.** RETRIEVE sits ahead of health because
*"the health gate guards the PRODUCTION of new answers, not the delivery of old ones."* A page
explaining how to call the service is not an answer about a subject either — **it is documentation**.
Same reasoning, same placement.

⚠️ **HTML ONLY.** A non-POST asking for JSON still falls through to the METHOD rung BEHIND health,
because that response is a report about a request and belongs under the same gate as every other
report. `wantsHtml` requires an explicit `text/html`, so `*/*` (curl's default) and an absent header
are unaffected. **Machines see no change; only humans do.**

### 🚨🚨 THE FIX CREATED ITS OWN HAZARD, AND IT IS WORSE THAN WHAT IT REPLACED

**A page that renders unchanged while the service is refusing implies the service is fine.** A reader
copies the curl, runs it, gets a 503, and reasonably concludes THEY got the call wrong — which is
worse than the bare 503 they used to get, because the bare 503 at least named what was happening.

⭐ The page's entire job is *"here is how to call it"*. **If calling it right now would fail, that
belongs on the page.** Omitting it is disclosure-by-omission on the one surface built specifically to
be honest to a stranger who has no other source. ⭐ Same discipline as `POLICY_CEILING` riding on
every policy result: **the constraint travels WITH the artifact** instead of depending on the reader
already knowing it.

So the page always renders, and carries a banner **ABOVE the curl** — a caveat placed under the
command it qualifies is one most readers never reach, because they copy and leave.

### ⭐⭐ AND NOT EVERY REFUSAL CLEARS BY WAITING — THE SPLIT THAT KEEPS THE BANNER HONEST

The obvious banner says "try again in a few minutes". **That is a fresh lie whenever the detector has
FAILED ITS OWN FIXTURES**, and it would be printed on the honesty surface to make an error message
feel friendlier. `SELF_CLEARING_HEALTH` is a **closed set of exactly two**:

| | |
|---|---|
| `no-record` · `stale` | ✅ resolves by itself — the scheduled sweep refreshes the artifact |
| `not-passing` · `version-mismatch` · `malformed` · `unreadable` · `build-unresolved` | 🚨 **NOT** a waiting problem; the banner says so and says it louder |

⭐ **A health reason invented later is NOT self-clearing until somebody decides it is** — the safe
direction for a page that tells strangers what to do. Asserted by enumeration.

⭐ **THREE STATES, NOT TWO.** `healthDisclosure()` returns `serving: true | false | null`, never
gates, and **never throws** — the docs must survive the outage they are describing. 🚨 The catch
resolves to `null`, **never to `true`**: a reassuring default there would be
[absence-must-never-read-as-safe] on the honesty surface itself. `null` renders its own explicit
"we could not determine" banner that borrows neither the reassuring nor the alarming wording.

⚠️ **NO CRON PERIOD IS QUOTED ANYWHERE ON THE PAGE.** The schedule lives in `netlify.toml`, outside
anything the page module can read, so a hardcoded "10 minutes" would be a second source of truth that
goes wrong silently the day the schedule changes — [duplicate-source-of-truth-is-the-recurring-bug]
on a **user-facing promise**. "Minutes, without anyone doing anything" stays true across a change.
The suite greps for a quoted period and fails if one appears.

### ⭐⭐ AND THE PROOF THAT CANNOT BE RE-RUN IS NOW CAPTURED AUTOMATICALLY

The banner is proven in-process across all three states. What that CANNOT see is the DISCOVERY rung
actually threading `healthDisclosure()` into the page on a real deploy —
[binding-tested-across-what-it-binds], where both sides are trivially identical inside one process.

⚠️ **AND THE ONLY MOMENT IT IS OBSERVABLE CLOSES BY ITSELF.** Every publish that changes DD-surface
bytes mints a new health key, the canary has no artifact for it, and the service refuses until the
next scheduled run. That guaranteed, self-healing outage is the ONLY time the banner appears in
production — and forcing one means corrupting the health artifact on purpose, which is the single
thing standing between a broken detector and somebody's deposit. **It was missed once already:** the
window after `4712479` had closed by the time the first probe ran, two minutes after publish.

So `scripts/dd/capture-refusal-window.mjs` runs as the last link of `deploy:prod` rather than
depending on a human being at the terminal in the right ninety seconds.

🚨 **THREE OUTCOMES, AND "NOT OBSERVED" IS NOT "PASSED":**

| | |
|---|---|
| OBSERVED + banner, html, above the curl | ✅ proven across the process boundary |
| OBSERVED + banner absent, **or JSON served to an `Accept: text/html` GET** | 🚨 exit **1** — the defect is back |
| NO WINDOW | exit 0, printed verbatim as **"and this is NOT a pass"** |
| nothing reachable | exit **2** — ⭐ deliberately not folded into "no window"; a capture that cannot see is not one that saw nothing |

⭐ **IT CARRIES ITS OWN DISCRIMINATOR.** Each run records the local `ddTree`. "No window" is EXPECTED
when the hash matches the previous entry and **SUSPICIOUS when it rotated** — a rotated key with no
refusal is what a fail-open would look like. Without the recorded hash those are indistinguishable,
which is exactly how *nothing happened* becomes *nothing is wrong*.

⭐ **ITS OWN FAILURE PATHS ARE TESTED BY CALLING**, against a local fixture server — all five
branches, including the two that only fire when something is already broken, which is the worst
moment to run them for the first time. (The live dry-run against prod only ever exercises "no
window".) A banner rendered BELOW the curl fails too: a caveat under the command it qualifies is one
most readers never reach.

⚠️ **THE LEDGER IS TRACKED IN GIT**, following `deploy-loss-log.jsonl`. Gitignoring it was the first
instinct and the wrong one — it would leave the single entry that ever matters living only on
whichever machine ran the deploy. The cost is a modified root file after every prod deploy; it does
not touch SURFACES, so it cannot dirty the next deploy's tree gate.

⚠️ **A NO-OP REDEPLOY WILL NOT TRIGGER IT.** The DD identity is a content hash over 34 files —
identical DD code keeps its key and opens no window. The proof lands on the next real DD change.

### ALSO

* ⚠️ **A test that pinned `skip.length === 3` went red on a legitimate fourth skip.** Rewritten to
  assert the PROPERTY (parses, validates, health-free, no UNSKIPPABLE member). ⭐ A test that fails
  on correct change teaches people to edit the test, which is how a real guarantee gets weakened by
  a routine diff.
* The banner escapes `health.detail` — server-derived today, but a page we serve must not become an
  injection point through text that might later carry env-derived content.

`verify-dd-report.mjs` **98/0** (was 67). `test:all` exit 0, tsc + build clean.
Files: `_dd-rungs.mjs` (`RUNG.DISCOVERY`, `SELF_CLEARING_HEALTH`, `healthDisclosure`),
`_dd-discovery-page.mjs` (`healthBanner`), `dd-analyze.mjs`, `agent-dd-report.mjs` (skips discovery).

## 2026-08-16 — ⭐⭐ `evaluatePolicy` HAS A CONSUMER, AND THE LADDER IT CLIMBS EXISTS ONCE

`POST /api/agent-dd-report` — the in-app report route. Session-authed instead of x402, **the same
artifact a buyer receives**, produced by the same code. `evaluatePolicy` was built, tested 36/0 and
mutation-tested with nothing calling it; a policy evaluator with no consumer is a claim nobody has
had to stand behind. **Built, not deployed** — prod still serves the old `dd-analyze`.

### ⭐⭐ THE ONE LADDER, AND WHY THE SKIP LIST IS INVERTED

`_dd-rungs.mjs` holds the rung order in a single frozen array. The load-bearing choice is that an
entry point does **not list the rungs it runs — it names the ones it SKIPS**:

* a rung ADDED to the ladder is climbed by **every** entry point, including ones written before it
  existed. Had handlers listed what they run, a new rung would apply only to whichever handler its
  author remembered to edit.
* a skip is a **named, validated, deliberate** act. `assertSkipSet` **throws** on an unrecognised
  name and on anything in `UNSKIPPABLE`. Tested by CALLING it — thirteen bad skip names, each
  asserted to throw — not by grepping for the constant.

🚨 **HEALTH IS UNSKIPPABLE BY CONSTRUCTION**, not by comment. The in-app path has a *stronger* reason
to respect it than a buyer does: a buyer who gets a report from an unverified detector loses the
price of a report; a user who deposits on one loses the deposit. Proven live in the suite — a
session-authed caller with a non-passing health artifact still gets 503 `service-unverified`, and it
is a REPORT with `checked: 0` and the word INDETERMINATE, never an error envelope.

⭐ **THE PRODUCER IS SHARED TOO, AND THAT IS THE HALF THAT MATTERS.** A shared ladder feeding two
different producers would still hand the card an object no buyer can reproduce and no attestation
covers. `makeProduceReport` — quorum, the systemic-failure refusal, the integrity escalation, the
attestation — is now one function. The suite asserts neither entry point calls `analyze()` itself,
neither builds its own quorum client, and the in-app route returns the **FULL** report: **no "lite"
variant**, because a projection is the first step toward two schemas and a card whose verdict is
derived from fields the buyer's copy does not contain.

⚠️ **AUTH SITS AHEAD OF THE LADDER, DELIBERATELY.** The ladder asks *can the SERVICE answer*; auth
asks *may THIS CALLER ask*. Folding auth in would put a rung there that the public endpoint must
skip — and **every skippable rung is one a future entry point can skip by accident**. The shared
ladder has no auth concept at all and so cannot be misconfigured into having one.

### ⭐ 9 REQUESTS PER RENDER, NOT ~8 — AND THE ASYMMETRY IS THE INTERESTING PART

Counted against a counting transport, quorum fan-out included: **9 JSON-RPC requests per card
render across 2 endpoints — 5 + 4, not 4½ + 4½.** `pin()` is deliberately NOT quorumed (two
endpoints legitimately differ by a block or two; requiring agreement on the head would refuse
constantly on CORRECT behaviour), so one endpoint is pinned and the same block tag goes to the rest.
That single un-quorumed read is the whole difference between the estimate and the measurement.

**No cache, and the suite asserts there isn't one** — "we decided not to cache" is otherwise
unfalsifiable. A 40-request ceiling fails the suite if a change makes a render dramatically dearer,
on a chain whose public RPC has already throttled this repo.

### 🚨🚨 `inspection` — RETAIN AND MARK, BECAUSE DELETING FIRST INVERTS THE ORDER

The plan was that power-scan and owner-identity warns MIGRATE to the report. **They have not been
deleted, and the reason is that `inspection` is not a display vocabulary — it is the GATE's input.**

`gateDeposit` consumes it server-side, `level` derives from `warns.length`, and the warn CODES are
the substance of `disclosureDigest`. So deleting a superseded warn before `gateDeposit` reads the
report does not "move" the disclosure anywhere: for a vault whose only warns were the migrated ones,
`level` falls **WARN → OK and the deposit proceeds with NO acknowledgement at all**. A gate that
quietly stops asking for consent is the worst available version of this change, and it is
[absence-must-never-read-as-safe] with a deposit on the end of it.

⭐ **SO THE MIGRATION HAS AN ORDER:** (1) the report carries the disclosure ✅ · (2) `gateDeposit`
READS it ❌ · (3) only then delete. `WARN_SUPERSESSION` marks all seven migrating warns with
`supersededBy` and **`deleteWhen`** — the deletion condition written **at the code**, never in a
commit message. ⭐ Temporary, deliberate, MARKED coexistence is a different thing from permanent
duplication; an **UNMARKED leftover** is what becomes drift.

⚠️ **THE INSTRUCTION SAID OWNER-IDENTITY WARNS; THIS APPLIES IT TO THE POWER WARNS TOO**, because the
failure shape is identical and the argument does not distinguish them. Consequence: **the digest does
not move at all.** Annotation only adds fields and `disclosureDigest` reads `w.code`, so every
outstanding ack stays valid — asserted byte-identical by calling it, with the counterfactual asserted
beside it: deleting a warn DOES move the digest, and `gateDeposit` on the deleted version returns
`ok: true` with no ack. Both directions proven, not argued.

⚠️ **`performance-fee` is deliberately ABSENT from the table.** It derives from a fee VALUE the
report never reads, so it has no replacement; listing it would schedule the deletion of a disclosure
with nothing to take its place. The suite asserts its absence.

⚠️ **THE BLOCK LADDER IS UNTOUCHED** — `not-a-contract`, `not-erc4626`, `empty-shell`,
`withdraw-fee-too-high`, `proxy-status-unreadable`, `asset-mismatch`, each asserted still raised AND
not scheduled for deletion. `not-a-contract` in particular is what makes the three accidental safety
mechanisms on the vault path safe.

### ⭐ THE REFACTOR BROKE NINE SOURCE-REGEX ASSERTIONS, AND ONE CAME BACK STRONGER

Moving code out of `dd-analyze.mjs` (563 → 265 lines) reddened nine checks in `verify-build-binding`
and `verify-quorum-billing` that grep its source — a live demonstration of
[assert-on-rendered-output-not-source-regex]. Retargeted, and two got better:

* **The escalation's "called BEFORE `runPaidAnalysis`" check was POSITIONAL** — a claim about text
  order in one file, which any edit could reorder. It is now an **import** check: the module holding
  the producer imports no billing code at all, so it cannot branch on a settlement outcome even in
  principle — **the identifier is not in scope**. Structural beats positional.
* **The two per-handler "uses codeIdentityForEvent" checks became one claim over every entry point:**
  no handler derives an identity of its own. With a shared rung it can be stated once and enforced
  over handlers written later.

### PROVEN, NOT ASSUMED

* ⭐ **`ddTree` ROTATES on a `_dd-rungs.mjs` edit** — verified by appending a line, re-stamping, and
  diffing the hash, then removing it. 🚨 That file **contains the health gate itself**; had the row
  been missed, a change to the rung deciding whether an unverified detector may answer would produce
  an identical ddTree — old canary evidence vouching for a rewritten gate, the exact fail-open the
  binding exists to close, aimed at the binding's own enforcement point.
* `_auth.mjs` added to the DD surface — **churn measured first**, per the rule the last addition
  established: 2 commits over the full history, last 2026-07-03.
* `test:all` **exit 0** (read from `$?`, not grepped — the first attempt this session read `tail`'s
  exit code, which is the same trap recorded twice already), tsc clean, `vite build` clean,
  `gate:routes` 5/0.

**New suite `scripts/dd/verify-dd-report.mjs` — 67/0**, wired into `test:dd`.

### ⭐ PROVEN ON A DRAFT BEFORE PROD — `6a8182a3dcc807171c049095`

`gate:draft` refused the first attempt and was RIGHT: on a draft the canary is unreachable by BOTH
routes (scheduled functions 403 on invoke; cron fires only on the published deploy), so the health
artifact can never be written and nothing gated on it can pass. Schedule commented out per its own
instruction, deployed (**35m 34s**, 21m of it bundling), **restored immediately after**.
⚠️ `netlify.toml` is OUTSIDE the hashed surface, so the tree hash is byte-identical with the schedule
commented or not — `gate:watch`/`gate:draft` is the only thing that catches a forgotten restore.

| check | result |
|---|---|
| `/api/agent-dd-report` reachable | **401 JSON** — not a 404, not the SPA HTML fallback |
| `dd-analyze` after the 563→265 refactor | **402**, correct `payTo` `0xb4079673…`, price `60000` |
| shared rung 3 / rung 4 | 400 `invalid-address` / 400 `unsupported-chain` |
| canary run | `wrote:true`, 5 fixtures, **0 failures**, DD surface now **34 files** |

⭐⭐ **AND THE DRAFT FOUND A DEFECT THE IN-PROCESS SUITE STRUCTURALLY COULD NOT** — a **GET** during
the pre-canary window returned `service-unverified` instead of the discovery page, because health
precedes method. See OTHER OPEN ITEMS: the discovery page is documentation, not an answer about a
subject, and the file already argues for that placement one rung above. This is
[binding-tested-across-what-it-binds] again — 67 green in-process checks all ran in one process where
the health artifact was mocked, and none of them could see an ordering cost that only exists across
a real deploy's refusal window.

### ⚠️ WHAT THIS DOES NOT CLAIM

* 🚨 **THE AUTHENTICATED HAPPY PATH IS UNPROVEN OVER HTTP.** Auth sits ahead of the ladder, so every
  anonymous call is 401 — the draft proves the route executes and refuses, NOT that it renders a
  report or that `evaluatePolicy` returns a verdict on a real artifact. No session token was minted:
  [live-proof-fund-moving-user-runs]. **The owner must run one authenticated call.** The discriminator
  to read back is `policy.reason` + `policy.coverage` — present-power, unreadable-power and
  below-threshold are three different findings and the reason the evaluator has two buckets.
* **NO UI CONSUMER.** The redirect exists and nothing fetches it. `gate:routes` passed anyway — it
  audits one direction only. Added to OTHER OPEN ITEMS with the reason.
* **The policy is client-supplied**, so the verdict is `authority: "display-only"` and gates nothing.
* `runLadder`'s two "rung not skipped but no dep supplied" throws are unexercised — the handlers
  always supply them, so the branch only fires on a future miswiring.

Files: new `netlify/functions/_dd-rungs.mjs`, `netlify/functions/agent-dd-report.mjs`,
`scripts/dd/verify-dd-report.mjs`; modified `dd-analyze.mjs` (climbs the shared ladder),
`_vault.mjs` (`WARN_SUPERSESSION`), `netlify.toml` (redirect), `scripts/stamp-build.mjs` (three DD
surface rows), `verify-build-binding.mjs`, `verify-quorum-billing.mjs`, `package.json`.

## 2026-08-15 (night, later) — ⭐⭐ THE SWEEP IS BUILT — AND ITS FIRST RUN PROVED MY OWN BASELINE WAS A FILTERED READ

`deploy-loss-sweep` counts the deploys `deploy:prod` silently loses. It exists because check 5
answers *"did I lose the deploy I just ran"* and structurally cannot answer *"is this still
happening"* — it scopes to deploys newer than the published one, so every corpse goes invisible the
moment a good deploy publishes.

### 🚨🚨 THE FINDING, AND IT IS ABOUT THE ENTRY DIRECTLY ABOVE THIS ONE

The first live run scanned **437 deploys over 5 pages** and found **23 more abandoned production
deploys**, `2026-06-24` → `2026-06-28`. Every one `new`, every one production, every one
`updated_at == created_at`. **Corrected total: 59, not 36.**

⭐⭐ **THE SCAN THAT DIAGNOSED A FILTERED READ WAS ITSELF A FILTERED READ.** Hours earlier I wrote
that `per_page:25` had hidden 36 records for six weeks, quoted this repo's own rule that *a filtered
read is not a measurement of absence* — and then established the zero baseline with a **3-page cap I
chose myself**, saw the oldest returned record was `2026-07-01`, and wrote it down as *"the API's
reach"*. It was not the API's reach. It was where I stopped asking. The 23 were sitting on page 4.

⚠️ **"The oldest record I saw is X" is not "the record begins at X".** A self-imposed cap is still a
filter, and it is more dangerous than an inherited default because it arrives feeling like a
decision. This is the single strongest argument for why `listAllDeploys` pages to exhaustion and
returns `exhausted` rather than a page count — and the sweep's own `beforeBaseline` branch is what
flagged the contradiction, on its first run, against its author.

### THE FOUR CONSTRAINTS, AND HOW EACH IS ENFORCED RATHER THAN PROMISED

1. **⭐⭐ REPORTS, NEVER CLEANS.** No cancel, no delete, no retry. Enforced by INJECTION, not by a
   comment: `api` is a parameter, and the suite passes one that THROWS on any method outside a read
   allowlist, then runs the real code path through it. Tested by calling, not by grepping for
   `cancel`. Auto-remediation would repeat today's evidence loss on a schedule and permanently
   destroy the ability to measure the class.
2. **⚠️ UNFILTERED AND PAGED TO EXHAUSTION.** `per_page` is always explicit, never the API's default;
   nothing is scoped past the published deploy. Asserted on the actual request objects. ⭐ Hitting
   the page cap sets `exhausted: false`, the report says the number is a **FLOOR, not a total**, and
   the process exits **2** — no silent caps.
3. **⭐ AGE IS THE RIGHT INSTRUMENT HERE, AND THE REASON IS PHYSICAL.** Check 5 judges ONE deploy in
   real time **on the machine that ran it**, where `/proc/stat` and a process table exist — so an
   elapsed-time guess there is a proxy standing in for evidence sitting right beside it, and it
   needs PRECISION. The sweep counts a POPULATION over time from wherever it runs; both liveness
   tests are **machine-local and simply do not exist** for a deploy that died three weeks ago on a
   box that is gone. It needs RECALL, and age is not a proxy for anything — it IS the measurement.
   Default **6 hours**, ~14× the longest real deploy ever observed here (~26 min). No real deploy
   runs that long, so a generous threshold has no false positives. 🚨 The code says all of this at
   the constant so nobody "corrects" it to match check 5.
4. **⭐ `uploading` IS ITS OWN CLASS.** `6a5a0230…` died **12.5 minutes in, during the upload** — the
   only one of the 36 whose `updated_at` moved. Counting only `new` erases the sole example of a
   second death at a second point in the deploy.

### ⭐ THE 23 SURVIVORS ARE NOW THE ONLY CLEAN EVIDENCE LEFT

They were found **after** the report-do-not-clean rule was in force, so they were left exactly as
they died: `new`, `error_message: null`, `updated_at == created_at`. Everything cancelled on
2026-08-15 now reads as a deliberate human cancel and can never be counted again. These 23 cannot.

⚠️ They are **named explicitly by id** and excluded from the loss count — not because they do not
matter, but because *a monitor that reports the same 23 forever is one people stop reading*, and it
is then worth nothing on the day the number changes. They are reported as a standing named quantity.
A new loss beside them is still reported; the suite asserts the exclusion cannot mask one.

### ALSO

* **⭐ The ledger.** Every run appends one line to `deploy-loss-log.jsonl` — tally plus ids, including
  survivors. Cancelling erases evidence and the deploy list is not permanent; an observation that
  lives only in a terminal does not survive. *"Was it recorded"* is a different question from *"how
  long does it last"*.
* **Exit codes are the signal:** `0` nothing lost · `1` losses found · `2` **could not measure**
  (no site id, API failure, paging capped). ⭐ `2` is deliberately not folded into `0` — a sweep that
  cannot see is not a sweep that found nothing.
* **One API layer, not two.** `siteId`/`netlifyApi` moved to `scripts/lib/netlify-api.mjs` and are
  now shared with `verify-deployed`. A second copy would have drifted from the `maxBuffer` ENOBUFS
  fix. `gate:deployed` re-verified live after the refactor: **DEPLOY VERIFIED**, all five checks.
* **Steady state today:** `437` scanned, `0` new losses, `23` survivors, `46` ambiguous
  `Deploy canceled`, exit `0`.

**Still open — and it is now a decision, not a task.** The sweep is a script; nothing schedules it.
Running it on a cron needs a `NETLIFY_AUTH_TOKEN` wherever it runs, and a token that can cancel and
create deploys is a real blast-radius question. Deliberately not decided here.

Files: new `scripts/lib/deploy-loss-sweep.mjs`, `scripts/lib/netlify-api.mjs`,
`scripts/deploy-loss-sweep.mjs`, `scripts/verify-deploy-loss-sweep.mjs` (42/0), `deploy-loss-log.jsonl`;
modified `scripts/verify-deployed.mjs` (shared API layer, corrected header figures), `package.json`
(`test:sweep`, `sweep:deploys`). All outside the stamped surface.

## 2026-08-15 (night) — 🚨🚨 THE DEPLOY GATE'S OWN IN-FLIGHT BRANCH SAID "FINE" ABOUT A DEAD DEPLOY. A timeout was standing in for evidence.

`verify-deployed` exists because a `new` deploy record reads exactly like a success. This session it
found the failure it was built for — and, in the same run, printed a reassuring line about a second
deploy that was already dead. **The gate had the defect it guards against, one level in.**

### WHAT THE THREE OPENING CHECKS FOUND

| check | result |
|---|---|
| handoff written for `63e7dac` / `1835499`? | ✅ present and accurate at the top of this file |
| does prod report those commits? | ❌ **no** — prod served `8e8c2b6` (tree `91f49acf318e`), two commits behind |
| a deploy stuck at `new`? | ❌ **yes** — `6a80c2a311767fb9e735f610`, `updated_at == created_at`, `error_message: null`, `required: []` |

So the 1b vault-gate fix was **not live**, and had been believed shipped. Redeployed: created
20:36:07Z, published **21:02:28Z** (~26 min), `gate:deployed` green on all five checks — tree
`f3bbc36fd6bc`, commit `f4cb3e78fb76`, deploy `6a80cdb71972b88faccfb167`.

### ⭐⭐ THE FINDING — AND IT IS NOT THE DEAD DEPLOY

Check 5 classified that orphan as **`presumed in flight, not orphaned`**. It was 9 minutes old, and
the rule was "under 30 minutes ⇒ presumed in flight". What the rule could not see: **the machine had
REBOOTED at 19:53:15Z**, four minutes after the deploy was created. Every process that could have
been working on it was gone before the session even opened.

⭐ **The reassurance was strongest exactly when someone was looking.** The 30-minute window covers
precisely the minutes right after a deploy dies — which is when a human asks "did it ship?". A guess
tuned to avoid false alarms is silent in the one window where the alarm matters.

⭐⭐ **THE CLASS: a guard that accepts a TIMEOUT in place of EVIDENCE has the same shape as the thing
it guards against.** This file's own thesis is that an absence must never fill a result slot and read
as safety. *"Thirty minutes have not yet elapsed"* is an absence — of elapsed time — standing in for
a presence of work. The fix is never a longer window; it is to test for the work. This is the same
family as [absence-must-never-read-as-safe], now found **inside a defense**, which is the harder
place to see it: the surrounding file is entirely correct about the hazard and still reached for a
proxy in the one branch where the direct measurement was slightly less convenient.

### THE FIX — TWO POSITIVE TESTS, BOTH CHEAP AND IMMEDIATE

`scripts/lib/deploy-liveness.mjs`. The 30-minute constant is deleted.

* **A — the deploy's `created_at` predates the current boot.** Decisive on its own: no process
  survives its machine. Read from `/proc/stat`'s `btime` — the boot *instant* in epoch seconds, not
  arithmetic against an uptime counter that a clock adjustment would skew. `sysctl kern.boottime`
  fallback for BSD.
* **B — no netlify/esbuild process exists at all.** The independent second instrument (⭐ *two
  instruments, not two reads of one*, same discipline as check 4), and it catches what A cannot: a
  CLI killed **without** a reboot.

**A is evaluated first, and that ordering is load-bearing.** During the live run there *were* build
processes running — they belonged to the *replacement* deploy. Test B alone would have called the
dead one alive. Elapsed time cannot express that distinction at all.

### ⚠️ THREE THINGS BUILDING IT SURFACED

1. **🚨 THE FALSE "IN FLIGHT" HAS A BACK DOOR WITH NO TIMEOUT IN IT.** `deploy:prod` is a single
   `sh -c "… && netlify deploy --prod --dir=dist && npm run gate:deployed"`. When the gate runs as
   the **last link of that chain**, the shell holding the whole chain is still alive with the literal
   string `netlify deploy --prod` in its argv. Matching it would report an already-exited CLI as
   still working — reintroducing the exact bug by a different route. Confirmed on the real deploy:
   pid 2474 was that shell. ⭐ **A command chain is a plan, not a running command**, and the argv of
   a shell is a *description* of work, not evidence of it — the same "the string appears ≠ the call
   happens" trap already on the open-items list.
2. **The unknown is its OWN outcome.** `livenessOf` returns `dead: true | false | null`; `null` fails
   check 5 on its own line. Had an unreadable instrument collapsed to "in flight", the gate would go
   quiet precisely when it had lost the ability to see. Every helper returns `null` for "could not
   tell" and **never a convenient zero** — a boot time of `0` would make every deploy predate the
   boot, and an empty process list where `ps` itself failed reads as "nothing is running".
3. **Placement was a correctness decision, not tidiness.** `SURFACES = ["netlify/functions",
   "shared", "src"]`, so a new file under `shared/` would have moved the `tree` hash while a deploy
   stamped `f3bbc36` was mid-flight — the next `npm run stamp` would report a mismatch that is not a
   deploy failure. `scripts/` is in neither surface, which is also where build tooling belongs.
   Verified after the fact: re-stamping post-change reproduces `f3bbc36fd6bc` unchanged.

### PROVEN, NOT ASSUMED

**Live, during the redeploy — the discriminating case ran for real.** Two production deploys sat at
`new` simultaneously, byte-identical in the API, and were judged **oppositely and correctly** in one
run: `6a80cdb7…` in flight (`node(2933), esbuild(2995)`), `6a80c2a3…` orphaned (created 19:48:51.556Z,
before the 19:53:15Z boot). **The old rule would have called both of them in flight.**

**`scripts/verify-deploy-liveness.mjs` — 30/0**, wired into `test:all` as `test:liveness`. It exists
because the live run could only exercise two of the four branches; the other two — *no process found*
and *both instruments unreadable* — fire only when something is already going wrong, which is the
worst moment to run them for the first time. §5 replays the 2026-08-15 record to the millisecond and
asserts **both** that the old rule would have passed it and that the new one fails it, so the
elapsed-time rule cannot quietly return. ⚠️ **Every timestamp is injected** — a `Date.now()`-relative
test fails at every commit once the wall clock passes the boundary, which is what turned the quote
fixture into a phantom defect in the entry below.

### ⚠️ WHAT THIS DOES NOT CLAIM

* **Check 5's scope is "did I lose MY deploy", not "has this ever happened".** It looks only at
  deploys *newer than the published one*, so once a good deploy lands it narrows to zero — correct
  for its question, and **not** a claim that old records were cleaned up. See the backlog below,
  which check 5 was structurally incapable of surfacing.
* **Both tests are about THIS machine.** A deploy driven from another machine or from CI reads as
  dead here. Deliberate trade, and the costs are asymmetric: a false ORPHANED costs one redundant
  ~26-minute deploy, a false IN FLIGHT costs a change everyone believes shipped and nobody re-checks.
  The old comment ranked those the other way round and was wrong to.
* **The gate still cannot save its own process.** Checks run only if the CLI exits; a killed shell
  takes its chain with it. That is why check 5 is durable and standalone — it is what a *later*
  session runs to find what an earlier one lost, and it is now the reason this entry exists.

Files: new `scripts/lib/deploy-liveness.mjs`, new `scripts/verify-deploy-liveness.mjs`; modified
`scripts/verify-deployed.mjs` (check 5 rewritten, helpers imported), `package.json` (`test:liveness`).
All outside the stamped surface, so the verified deploy identity is untouched.

### 🚨🚨 THEN AN UNFILTERED SCAN FOUND **36** OF THEM, NOT FIVE — GOING BACK TO THE FIRST DAY THE API CAN SEE

Cleaning up the one orphan meant listing the deploys without a filter. `deploy:prod` has been
silently losing deploys **since at least 2026-07-01**, and "the five silent failures, 2026-08-14" was
an undercount by a factor of seven.

| | |
|---|---|
| deploys scanned (3 pages) | **300**, oldest `2026-07-01T07:26:39Z` — ⚠️ **this cap was itself wrong; see the next entry** |
| non-`ready` | **44** |
| **limbo** (`new` 35 + `uploading` 1) | **36** — 27 production, 9 deploy-preview |
| of those with `updated_at == created_at` | **35 of 36** — the killed-instantly signature |
| already terminal, left untouched | 8 — five prior `Deploy canceled`, plus two REAL build errors |

⭐ **The one exception is the most informative record in the set.** `6a5a0230d556905d8ebd9efd` sat in
state **`uploading`**, created `10:21:36Z` and last touched `10:34:09Z` — it died **12.5 minutes in,
during the upload**, not at creation. Every other one was killed before it could touch its own
record. That is a second death, at a second point in the deploy, that the gate had no name for.

⭐⭐ **CHECK 5 WOULD NEVER HAVE FOUND ANY OF THESE, AND THAT IS BY DESIGN.** It scopes to deploys
*newer than the published one*. The 2026-08-14 five were visible only because production was, at that
moment, stuck behind them. Every deploy that dies and is then succeeded by a good one becomes
invisible to the gate the instant the good one publishes. So the gate answers *"did I lose the deploy
I just ran"* — it has never answered *"is this still happening"*, and a class that only shows up when
you are already in trouble looks like it is not happening at all.

⚠️ **This was found only because the read was UNFILTERED.** Every previous look was `per_page:25` and
scoped past the published deploy — the repo's own rule, [filtered-read-is-not-absence], applied to
the deploy list itself. One page deeper and the incident stops being an incident and becomes a rate.

### WHAT WAS ACTUALLY DONE TO THEM — AND WHAT IT COST

🚨 **DELETE IS NOT AVAILABLE.** Both `deleteDeploy` and `deleteSiteDeploy` return **405 Method Not
Allowed**; Netlify's UI offers only a bulk site-wide purge. All 36 were **cancelled** instead
(`cancelSiteDeploy`), which is strictly less destructive and achieves the real goal: the failure was
never that the records existed, it was that they *read as successes*. Each now carries
`state: error`, `error_message: "Deploy canceled"`, `updated_at != created_at` — none of the three
signatures survives. Verified by re-listing all 300 afterwards: **0 limbo remaining**, 256 `ready` +
44 `error`, published head `6a80cdb7…` untouched and still serving (HTTP 200).

⚠️ **THE COST, STATED PLAINLY: cancelling OVERWROTE the evidence.** A cancelled orphan is now
indistinguishable from a deploy a human cancelled on purpose — the five that were already
`Deploy canceled` before today may themselves have been orphans, and that is no longer knowable. **The
deploy list can no longer be used to count this class, and the tally in this entry is now the only
surviving record of it.** That is why the numbers above are written down instead of merely acted on.

⚠️ **`2026-07-01` IS WHERE THE SCAN STOPPED, NOT THE API'S REACH — AND CALLING IT THE REACH WAS THE
SAME MISTAKE AGAIN.** 300 records is three pages, chosen by me. The site has **437**. The sweep built
in the next entry paged to exhaustion and found **23 more** abandoned deploys, 2026-06-24 → 06-28,
one page past where this scan stopped. Corrected total: **59**.

**Still open:** nothing here changes `deploy:prod`. The class is now measured, named, and the gate
catches the *current* deploy — but the standing question this raises is whether a periodic unfiltered
sweep should exist at all, since the only reason 36 records surfaced today is that somebody happened
to look sideways while cleaning up one of them.

---

## 2026-08-16 (night) — 🚨 THE QUOTE SUITE'S "DEFECT" WAS A FIXTURE AGEING PAST A TTL. I had it backwards.

### ⚠️ FIRST, THE CORRECTION

Last entry I wrote *"the test isn't broken; the module is."* **That was wrong.** `pruneOwnerQuotes` is
correct — a fourteen-day-old quote SHOULD be pruned. The **test** hardcoded
`quotedAt: "2026-08-01T12:34:56.789Z"`, and at **2026-08-15T12:34:56.789Z** that literal crossed
`QUOTE_TTL_MS` (14 days). From that moment `recordQuoteNeverThrows` wrote the record and the prune
immediately expired it: `SET …q_msu… | DELETE …q_msu…`, `written: true`, `mem.size 0`.

Measured, not inferred: fixture age **14.29 days** against a **14 day** TTL, boundary crossed about
seven hours before the diagnosis.

### ⭐⭐ AND THE BISECT COULD NOT HAVE FOUND IT

I ran clean worktrees at twelve commits back to `a7ca274` — the commit that INTRODUCED the suite —
and got FAIL at every one, and concluded "it never passed". **That conclusion was an artefact of the
method.** A test evaluated against `Date.now()` fails at *every* commit once the wall clock passes
the boundary, because every worktree run shares one clock. History showed a defect that was never
there, and the real transition — a calendar boundary — is invisible to bisection by construction.

⚠️ The instruction not to anchor on "it passed earlier" was right in spirit, and the observation
itself turned out to be **accurate**: it did pass, until 12:34 today. It was my *evidence against it*
that was unsound.

### THE FIX

Fresh fixtures derive from `Date.now()`. ⭐ And the TTL boundary is now tested **on purpose** with an
injected clock — `pruneOwnerQuotes(owner, now)` has always taken one — so one second inside the TTL
survives, exactly at the TTL expires, and neither depends on what day it is.

⚠️ **Recorded while it was in view:** a quote written ALREADY older than the TTL returns
`written: true` and is gone immediately. Production never hits it (`quotedAt` is minted at write
time), but the return value can describe a record that no longer exists.

### ⭐⭐ `npm run test:all` — THE RULE BECOMES A MECHANISM

"Read `$?`, never grep" is written down from the bridge-suite incident and **failed again today**:
suites were checked with `grep -c "FAILURES"` and `0` read as green — but **a crash prints no summary
line**, so a crashing suite counted as passing, and every "bridge green" I reported for those hours
was false.

Second occurrence, so it gets a mechanism rather than a third entry: `test:all` chains all 13 suites
with `&&`, so there is nothing to grep — one command, one exit code, first failure stops the run.
`scripts/README-testing.md` states the rule and both incidents. ⚠️ A crashing suite and a failing
suite are the SAME outcome, non-zero, and that is the point: any check that can tell them apart by
reading text can also be defeated by text.

### STATE

* ⛔ **UNDEPLOYED.** `test:all` exits 0 across all 13 suites; tsc + build clean.
* ⭐ The three "open failures" from the last entry are resolved: the module was never broken, and the
  suite is green — the only real defect was in how I verified.

## 2026-08-16 (late evening) — ⭐ THE GATE THAT REFUSED WITHOUT SAYING WHY. Fixed, with the change COMPUTED rather than announced.

### THE DEFECT, SHIPPED

A vault gate refusal is a **409 carrying the fresh disclosure** — `agent-vault-deposit.mjs` says so:
*"carrying the disclosure so the UI can render exactly what must be acknowledged."* The client did
`throw new Error(data?.error)` and **discarded the body**. ⭐ That sentence described a capability
with NO CONSUMER — the same "the string appears, the call never happens" shape, one layer up.

So a user whose acknowledgement had been invalidated saw a bare refusal beside a disclosure they had
already ticked, **tick still set**, nothing indicating anything had moved underneath them.

### ⭐ FIRST, THE COUNT — THE INVALIDATION COST WAS THEORETICAL

**Vault acks are never persisted. There is no ack store.** `ackTokenFor(inspection)` is computed
client-side from the disclosure rendered, sent with the deposit, and `_actions.mjs:444` **re-inspects
and re-derives** at execute time. So "outstanding acks" is not a backlog — it is the set of browser
tabs holding a rendered disclosure with the box ticked that submit after a change. We reasoned
carefully about a cost bounded by page-session lifetime. ⚠️ The MECHANISM the `_vault.mjs` comment
warns about is real; the stored population behind it is zero.

### THE FIX — THREE PARTS, EACH ADDRESSING A DIFFERENT FAILURE

1. **The disclosure now carries its own digest inputs.** `disclosureDigest` is
   `address | warn codes | withdrawFee | depositFee`, but the payload shipped only
   `{level, blocks, warns, digest}` — so a **fee-only change moved the digest and was unexplainable**.
   The inputs must travel with the digest or the change cannot be described.
2. **The body survives the throw**, via `errorWithPayload` — extracted as a function precisely so the
   behaviour can be TESTED rather than grepped for. Additive: `e.message` is unchanged, so every
   existing caller keeps working.
3. **The delta is computed, not announced.** `diffDisclosure` reports which warns appeared or
   disappeared, which named fee moved and from what to what, and any verdict-level move. ⚠️ Clearing
   the tick alone would have left the user to diff two things they cannot see — the old disclosure is
   gone the moment the new one renders — and **a re-tick nobody can check is a formality, which is
   trained click-through**, already a recorded hazard on the fee-band surface.

⭐⭐ **AND THE CASE THAT MUST NEVER BE SILENT:** if the refusal happened but none of the four inputs
explains it, `unexplained` fires and the UI says *"changed in a way this page cannot itemise"*. An
empty panel reads as "nothing important happened".

⚠️ **THE CLIENT CANNOT COMPARE DIGESTS** — it holds `ackToken`, a HASH, while the disclosure carries
the raw string. So the authoritative "something moved" signal is the REFUSAL itself, passed
explicitly. Without that, `unexplained` could never fire and the honest case would be unreachable.

### PROOF

`verify-disclosure-diff` **20/0** (new), `verify-vault-degraded` **31/0** (5 new pinning the digest
inputs), vault 35/0, DD, copy, routes, tsc + build clean. **Four mutations, all red:** unexplained
silently becomes "no change"; a null fee treated as 0; removed warns dropped; the refusal signal
ignored. ⭐ The end-to-end chain is tested by CALLING it — a 409 body through `errorWithPayload` into
an itemised delta.

### 🚨 AN OPEN FAILURE I MUST NOT DRESS UP, AND A CORRECTION TO MY OWN REPORTING

**`test:quote` (`verify-agent-quote-record.mjs`) FAILS, and so does `test:bridge` through it.**
The written key and the computed key are byte-identical strings, yet `mem.has(key)` is false — the
test's in-memory store and the module's are DIFFERENT INSTANCES, a module-mocking registry problem,
not a logic bug.

* ⭐ **NOT caused by this work:** a CLEAN WORKTREE at `7622cd3` (early this session) fails identically.
* ⚠️ **But it passed earlier in this session** — 72/0 was observed repeatedly. So the transition is
  real and I have NOT isolated its trigger. Recorded as undiagnosed rather than explained away.
* 🚨 **AND MY GREEN CHECKS WERE UNSOUND.** I verified suites with `grep -c "FAILURES"` and mapped 0 to
  green — but **a CRASH prints no "FAILURES" line**, so a crashing suite counted as passing. Every
  "bridge green" I reported after the transition was false. ⭐ Now checked by EXIT CODE, which is what
  should have been used from the start: a test harness verified by grepping its own output is the
  same defect class as everything else in this thread.

### STATE

* ⛔ **UNDEPLOYED.**
* 🚧 `verify-agent-quote-record.mjs` — undiagnosed store-instance mismatch. Its own item.
* 🚧 The in-app report route is still next: shared rung helper, then the route.

## 2026-08-16 (evening) — ⭐ `evaluatePolicy` BUILT, and the coincidental vault safety is now a guarantee.

### 1 ✅ THE hasAny QUESTION — ALREADY HANDLED, AND NOW PINNED

**The shipped vault card does NOT tell users an unreadable contract is clean.** Traced end to end:
`withRetry(() => pc.getBytecode(...), "0x")` falls back to the literal `"0x"` — NOT the UNREADABLE
sentinel — so the tri-state dies before `hasAny` is called and the selector scan legitimately finds
nothing. ⭐ But the SAME `"0x"` makes `isContract` false and raises the **`not-a-contract` BLOCK**,
and `gateDeposit` refuses on BLOCK before any disclosure renders. The reassuring sentences are
unreachable.

### ⭐⭐ THREE INDEPENDENT ACCIDENTAL SAFETY MECHANISMS ON ONE PATH — THIS IS WHY THE PIN WAS NECESSARY

Not a footnote. The reason.

| # | mechanism | designed for this? |
|---|---|---|
| 1 | the `"0x"` fallback makes `isContract` false → **`not-a-contract` BLOCK** | no — it is a default value |
| 2 | `hasAny` would THROW on a real `UNREADABLE` symbol (`code.includes` is not a function) | no — a type accident |
| 3 | `String(symbol)` is legal, so an `UNREADABLE` fallback yields `"symbol(unreadable)"` → **`not-erc4626` BLOCK** | no — discovered by mutation |

⭐ **I PREDICTED (2) AND THE MUTATION DISPROVED IT.** The comment claimed switching the fallback to
`UNREADABLE` "would turn a stated refusal into a 500". It does not — line 241 wraps the value in
`String(codeRaw || "0x")`, and explicit `String()` on a Symbol is legal (only implicit coercion
throws). It blocks as `not-erc4626` instead. **Fail-closed held anyway, by a third route nobody
designed and nobody had noticed.** Corrected at the code rather than quietly edited.

⚠️ **THREE ACCIDENTS AGREEING IS NOT A SAFETY PROPERTY — IT IS A COINCIDENCE WITH A GOOD TRACK
RECORD.** Nothing documented tied them together, so any one of them could have been "cleaned up" by
someone reasoning correctly about the other two. That is precisely what makes a pin necessary rather
than optional: the behaviour was right, the *reason* was unrecorded, and an unrecorded reason is one
edit away from being removed for tidiness.

Now pinned by five assertions in `verify-vault-degraded` (26/0): no crash, BLOCK on
`not-a-contract`, gate refuses, an ack cannot buy past it, and — recorded explicitly — that the
powers DO read as absent underneath, so the dependency on the BLOCK is visible rather than assumed.
Mutation-tested both ways: remove the BLOCK → red; change the fallback → red.

### 2 ⭐ `evaluatePolicy(report, policy)` — pure, in `shared/onchain-analyze/policy.mjs`

Inside the stamped surface AND inside `ddTree`, so a change to the evaluator rotates the health key.

* **Unreadable never passes.** Each rule asks the MANIFEST first: `notChecked` → `unreadableFailures`.
  ⭐ It iterates the USER'S RULES, never `coverage.checked` — that inversion is the optimisation that
  turns a wholly-unreadable refused set into a silent pass, because an unchecked group is never visited.
* **Two buckets, never one**, with wording that distinguishes *"this vault is upgradeable"* from
  *"we could not establish whether it is."*
* **No score.** One accept/refuse per group; the report's own `severityMeaning` forbids aggregation.
* **A coverage threshold**, which catches what per-group rules cannot: everything read passed, but
  little was read.

⚠️ **A LIMIT ON WHAT ANY PASS CAN MEAN, surfaced from the engine's own evidence note:** *"presence of
a selector is evidence of the power; ABSENCE is not proof of its absence (a power may be reachable
via fallback/delegatecall)."* So `present: false` means "no selector found", not "cannot do this".
⭐ We still pass on it — refusing on "not proven absent" would fail every refuse rule against every
contract forever, a lockout rather than a safety property — but the pass text now says exactly what
was established. The overclaim was in the wording, not the logic.

### 3 THE FIXTURES — 31/0, and two findings from building them

Named shapes all covered: absent policy, empty rules, empty manifest, and every-refused-group-
unreadable. Plus adversarial reports from REAL quorum runs (disagreement, quorum-unmet, all-down).

🚨 **FINDING: power groups are ALL-OR-NOTHING.** All nine derive from the ONE bytecode read, so
knocking it out makes the SHAPE unclassifiable and the report becomes a refusal with all nine
unchecked — verified 9/0 on a healthy read. **The engine cannot currently emit partial power
coverage**, so the trap fixture is hand-built from a real report and labelled as such. Today the trap
is defended by a different branch (`REPORT_UNUSABLE`); the per-rule branch is pinned for the moment
any group gains its own read. ⭐ A branch unreachable today and load-bearing tomorrow is exactly the
kind that ships broken.

⚠️ **AND MY FIRST MOCK CLIENT WAS WRONG IN A SILENT WAY.** `analyze()` takes ONE `call({method,
params})` returning `{result, query, evidence}`; a plausible client with `getCode`/`getStorageAt`
produces a **`chain-unreachable` REFUSAL, not an error** — so every fixture asserted against a
refusal while looking fine. ⭐ Fixed by EXTRACTING the working harness to `scripts/dd/_mock-chain.mjs`
and having `verify-analyze` consume it too (87/0 unchanged, proving the extraction is behaviour-
neutral). A second copy of the mock would be a duplicate source of truth over the thing the tests
measure WITH.

### PROOF

`verify-policy` **31/0**, `verify-analyze` 87/0, `verify-vault-degraded` 26/0, vault 35/0, all 14 DD
suites, bridge, tsc + build clean. **Six mutations on the evaluator, all red:** notChecked-as-absent,
absent-policy-passes, empty-rules-passes, empty-manifest-passes, buckets-collapse, threshold-ungated.

⚠️ Two of those first CRASHED the suite instead of reporting, because a failing assertion was
followed by an indexed access on an empty array — hiding every later check. Guarded; a failure must
report, not take the run down. ⚠️ And a `\&` escape in a `python -c` corrupted `package.json`
mid-run; caught immediately by the JSON parse and repaired.

### STATE

* ⛔ **UNDEPLOYED.** No wiring yet — `evaluatePolicy` has no consumer.
* ⭐⭐ **THE CEILING IS WRITTEN DOWN BEFORE THE COPY EXISTS**, and it rides on every result as
  `POLICY_CEILING` — machine-readable, on pass and fail alike, for the same reason `severityMeaning`
  rides on every report: **so no consumer can claim it was not told.**
  > **A policy gate can never say "safe". Only: "nothing was found against your rules."**
  Three reasons no UI can design away: a power is detected by SELECTOR PRESENCE and absence of a
  selector is not proof of absence; the rules are the user's and cover nine catalogue groups, not
  every way a contract can take funds; and coverage counts what was ASKED. ⚠️ A green tick with the
  word "safe" would contradict a string handed to the UI in the same object.
* 🚧 NEXT, in order: the in-app report route (same interface a buyer uses, not engine internals),
  policy storage at `agent-policy` / `o/<owner>`, then the override token binding the policy digest.

## 2026-08-16 (latest) — ⭐ THE DUPLICATE MAPPING WAS NOT AN OVERSIGHT ANYONE COULD SEE: the extraction was already done and never consumed.

✅ The six DD-surface rows deployed first — `5197f78` live as `6a80684d87024bbcbb019123`, gate 13/13,
both commits pushed.

### THE FINDING — worse than a duplicate, and self-concealing

`quorum.mjs` raises the failure tags and **already exported `quorumReasonFor(e)`** to translate them,
with a docblock reading *"Consumed by coverage.runCheck."* Meanwhile `coverage.mjs` carried its own
**inline copy** of the same table.

⭐⭐ **THE EXPORTED FUNCTION HAD ZERO CALLERS.** So this was not a copy someone forgot to remove — the
extraction HAD been done, the consumption never happened, and the comment asserted a relationship
that did not exist. Reading either file alone showed a correct, deduplicated design.

⚠️ **AND IT IS THE SWEEP ITEM AGAIN, IN THE WILD:** *"the string appears" is not "the call happens."*
An exported, documented, well-named function that nothing calls reads exactly like a single source of
truth — right up until you grep for callers.

### ✅ CHECKED FOR DRIFT BEFORE MERGING

The two tables were **byte-identical** — no drift yet. That matters: had they drifted, deduping would
have silently changed behaviour on one path, and the merge would have needed a decision rather than a
deletion. Verified first, merged second.

### THE PROOF IS BEHAVIOURAL, NOT A GREP

⭐⭐ Mutating the SINGLE mapping (`disagreement → "rpc-MUTATED"`) turns **six checks red** in
verify-analyze. **Before the dedupe that same mutation changed nothing**, because nothing called the
function — which is the cleanest possible demonstration that the call now happens.

Two structural guards stop the copy returning: the tag→reason table must appear **exactly once**
across the package, and `coverage.mjs` must import it. Mutation-tested by re-inserting the inline
copy → red (`found 2`).

`verify-analyze` 85 → **87/0**. All 14 DD suites, bridge, tsc + build clean.

### STATE

* ⛔ **UNDEPLOYED.**
* 🚧 The source-grep sweep is now the last item on this thread — and this entry is the third distinct
  instance in two days (a dead `indexOf` check, a tautological `||`, and an exported function nobody
  called). The pattern is not "regexes are brittle"; it is **assertions that confirm the presence of
  a thing rather than the occurrence of an action.**

## 2026-08-16 (late) — ⭐ THE CODE-IDENTITY HASH NOW COVERS EVERYTHING `dd-analyze` RUNS. Six rows, and the decision was measured.

✅ The `shared/dd` move deployed first — `70b92c0` live as `6a8061f296b74871ed42fc9f`, gate 12/12.

### THE MEASUREMENT THAT DECIDED IT

Same method that justified the binding originally. ⚠️ A 40-commit window said **0 of 40** for all
three candidates and was **misleading** — roughly half that window was one session's bridge work,
which would never touch them. Over the **full 354-commit history**:

| file | commits ever | last change |
|---|---:|---|
| `shared/x402/settle-gate.mjs` | 2 | 2026-07-28 |
| `netlify/functions/_x402-confirm.mjs` | 1 | 2026-07-28 |
| `shared/build-stamp.mjs` | 2 | 2026-08-11 |
| `netlify/functions/_circle.mjs` | 2 | 2026-07-11 |
| `_dd-descriptor.mjs` / `_dd-discovery-page.mjs` | 1 each | 2026-08-14 |
| *`dd-analyze.mjs` (already in the surface)* | *13* | — |

**Nine changes across 354 commits.** At the measured ~5m refusal window per DD-dirty deploy, that is
~45 minutes bought over the project's lifetime — every minute of it on a commit that genuinely
changed money-path or identity code, which is exactly when re-verification should fire.

⚠️ **I EXPECTED `_circle.mjs` TO CHURN** — it is shared with bridge and swap — **and it does not.**
Two commits, last touched over a month ago. The measurement contradicted the intuition, which is the
entire reason the rule is to measure.

### ⭐⭐ COMPLETING THE SET BEAT MAINTAINING AN EXCLUSION LIST

Adding the three requested rows left exactly three modules still outside — **surfaced by the
graph-derived guard, not by memory.** The alternative was a `KNOWN_UNCOVERED` list in the verifier.
⭐ But a human-maintained list is precisely what failed here: the stamper's *"add a row whenever the
canary gains an import"* rule was never applied because the import arrived through `dd-analyze`. With
full coverage the guard asserts a clean property — **nothing `dd-analyze` runs is outside the hash,
full stop** — and a new import fails it instead of being quietly listed.

`ddTree`: 24 → **30 files**. `shared/build-stamp.mjs` is the strongest addition on grounds other than
frequency: it COMPUTES the identity, so a change there can alter what the identity MEANS without
anything rotating to say so.

### 🚨 FOUR MUTATIONS THAT DID NOT MUTATE, AND ONE CHECK THAT WAS A TAUTOLOGY

⚠️ **Dropping `settle-gate` and `_x402-confirm` both reported GREEN — and neither mutation had
applied.** Those two rows carry trailing comments (`"…settle-gate.mjs",  // decides whether a buyer
is CHARGED`), so a string match on `"  \"path\",\n"` never matched. Redone line-based with an
applied/not-applied report, both fail correctly. ⭐ **That is the fourth malformed mutation this
session; the rule now has a mechanism — every mutation prints whether it changed anything.**

⭐⭐ **AND ONE CHECK WAS GENUINELY DEAD.** The SELF assertion read
`!covered(generated) || stampSrc.includes("const SELF")` — the left operand is ALWAYS true, so the
right was never evaluated and renaming `SELF` out of existence left it green. **An `||` whose first
operand is always true is not a check, it is a comment with a green tick.** It now asserts the
stamper's actual mechanism — the `.filter((p) => p !== SELF)` in the walk — and fails when that
filter is removed.

### PROOF

All 14 DD suites, `verify-quorum-billing` **30/0**, bridge green, tsc + build clean.
**Mutations, each verified as applied:** drop any of the six rows → red; remove the SELF filter → red.

### STATE

* ⛔ **UNDEPLOYED.**
* ✅ The `ddTree` coverage gap is CLOSED and the property is now self-maintaining.
* 🚧 The `chain-disagreement` → `rpc-disagreement` mapping is still duplicated across two files.
* 🚧 The source-grep sweep (*"the string appears" ≠ "the call happens"*) is still outstanding.

## 2026-08-16 (night) — ⭐⭐ THE CODE THAT SIGNS THE ATTESTATION WAS OUTSIDE THE HASH THAT IDENTIFIES THE CODE.

`dd-analyze` imported `chainClient` and `ddAttestationOptions` from `scripts/dd/`, pulling
`client / chains / rpc / attest-circle` into the deployed bundle. `scripts/` is in **neither**
`SURFACES` nor `DD_SURFACE_DIRS`, so a change to any of them produced an identical `tree`, an
identical `ddTree`, **and no dirty flag** — invisible in all three channels at once.

⭐⭐ **INCLUDING `attest-circle.mjs`: the signing path.** The code that produces the signature sat
outside the hash whose entire job is to say which code produced it. Old canary evidence would vouch
for new signing code — the exact fail-open the binding exists to close.

### ✅ FIRST, THE QUESTION THAT DECIDED URGENCY

**`dd-canary` reaches none of the four.** Its transitive closure is 18 modules and touches no
`scripts/` code, so the thing that vouches was never itself produced by unhashed code. That is what
made this cleanup rather than an emergency — and it was worth answering before anything else leaned
on the binding.

### ⚠️ THE MOVE ALONE WOULD NOT HAVE FIXED IT

`shared/` is inside `SURFACES`, so relocating repairs the `tree` hash. But `ddTree` filters by
`DD_SURFACE_DIRS`, and `shared/` root matches none of them — the health key still would not have
rotated on a signing change, and **the binding would have looked fixed while remaining open.** Both
gaps closed deliberately: files to `shared/dd/`, and `shared/dd` added as a DD surface dir.

⚠️ The stamper's own rule already said this — *"ADD A ROW HERE WHENEVER THE CANARY GAINS AN IMPORT,
or the binding silently stops covering it."* The import arrived through `dd-analyze` rather than
`dd-canary`, and the row was never added.

### MEASURED

| | before | after |
|---|---|---|
| `ddTree` | `f4c8ec9bfa4d…` (19 files) | **`d1cd378608e0…` (24 files)** |
| `tree` | 155 files | **160 files** |
| dd-analyze modules under `scripts/` | 4 | **0** |

24 = 19 + `endpoints.mjs` + the four. The counts reconcile exactly.

### ⚠️ MY IMPORT SURVEY WAS INCOMPLETE, AND THE SUITE CAUGHT IT

The first pass grepped for `from "./client.mjs"` and `scripts/dd/client` — and **missed every
`../client.mjs` from a subdirectory.** Ten stale imports across `scripts/dd/checks/` and
`scripts/spikes/` survived the move; `test:dd` died on the first one. ⭐ Fixed by RESOLVING every
relative import in the repo against the moved set instead of pattern-matching paths — the same
"a filtered read is not a measurement" lesson, in the tool I was using to check for it.

🚧 `scripts/spikes/spike-phase0.mjs` was ALREADY broken before this move (`./dd/rpc.mjs` from
`scripts/spikes/` resolves nowhere; `ERR_MODULE_NOT_FOUND` on load). Left alone — not this commit's
business, and silently "fixing" a spike I have not reasoned about is worse than leaving it.

### THE GUARD — derived from the real import graph, not a list

`verify-quorum-billing.mjs` now walks `dd-analyze`'s transitive imports and asserts **none** come
from `scripts/`, that `shared/dd` is a DD surface dir, and that the signing path specifically is
inside the code-identity hash. ⭐ Computed from the graph precisely because the rule that failed here
was a human-maintained list.

⚠️ **AND THE MUTATION WAS MADE HONEST.** Pointing `dd-analyze` back at `scripts/` first made the
suite CRASH (`ERR_MODULE_NOT_FOUND`) — the module loader catching it, not the check. Re-run with a
resolvable stub at the old path, the CHECK fails on its own merits, naming `scripts/dd/client.mjs`.
A guard credited for work the loader did is a guard nobody has actually tested.

### PROOF

All 14 DD suites green, `verify-quorum-billing` 24/0 (3 new), bridge green, copy 32/0, tsc + build
clean. Mutations: drop `shared/dd` from the DD dirs → red; re-import from `scripts/` → red (with the
stub, i.e. by the check).

### STATE

* ⛔ **UNDEPLOYED.**
* 🚧 **STILL OUTSIDE `ddTree`, and now the largest remaining gap:** `shared/x402/settle-gate.mjs` and
  `netlify/functions/_x402-confirm.mjs` — **the code that decides whether a buyer is charged** — plus
  `_circle.mjs`, `_dd-descriptor.mjs`, `_dd-discovery-page.mjs`, and `shared/build-stamp.mjs` (the
  code that COMPUTES the identity). By the stamper's own conservative rule these are candidates for
  rows; adding them widens the DD re-verification surface, so it is a deliberate call, not a tidy-up.
* 🚧 The `chain-disagreement` → `rpc-disagreement` mapping is still duplicated across two files.

## 2026-08-16 (later) — ⭐⭐ QUORUM ON THE PAID PATH. The service that SELLS a claim about chain state was reading it from one endpoint.

`dd-analyze` — the public, paid endpoint — called `analyze(addr, { client: chainClient(chain) })`.
⭐ **The report already said so about itself:** *"Single endpoint. No cross-check: a wrong answer
from this provider is reported as fact."* A tested quorum layer existed and ran only from the CLI.

### THE SHAPE, CONFIRMED BEFORE WRITING — quorum for the READ, coverage for the DISAGREEMENT

Three independent confirmations, none of them inference:
* `quorum.mjs` already declares its four tagged throws reach the caller "which `coverage.runCheck`
  already routes into notChecked".
* `coverage.runCheck` already records **one read PER ENDPOINT** — "what makes a disagreement
  REPRODUCIBLE: the reader gets one curl per endpoint and can re-run the split themselves." The
  manifest was built for a quorum client that had never run in production.
* The completeness invariant means a thin report is still a VALID report.

### ⚠️ THE ONE THING THAT SHAPE GETS WRONG IF LEFT IMPLICIT — the billing boundary

The settle gate requires *"a coverage manifest that ACCOUNTS FOR THE WHOLE CATALOGUE"*, and its own
comment explains why: *"A `chain-unreachable` report carries an EMPTY manifest… so it fails (2) even
before (3) is consulted."* ⭐⭐ **COVERAGE-EMPTINESS IS HOW THE GATE CURRENTLY DETECTS AN OUTAGE.**
Populate every group with a reasoned `notChecked` and a total outage becomes structurally identical
to a thin answer — and the service bills full price for a report that checked nothing because our own
endpoints were down. The published terms forbid it verbatim: *"an outage, AN UNREACHABLE CHAIN, or a
refusal returns the report free… 'We COULD NOT check' is OUR instrument failing and is FREE."*

So: **partial instrument failure BILLS** (a thin answer is an answer); **total instrument failure
REFUSES**. ⚠️ A DISAGREEMENT is neither — we DID read, they conflicted — and bills, because it is a
finding about the providers rather than about us. Laundering it into a free outage is explicitly
tested against.

### THE THREE STATES, WHICH ARE NOT INTERCHANGEABLE

| tag | about | retryable | bills |
|---|---|---|---|
| `rpc-unreadable` | **us** — the instrument failed; says nothing about the chain | yes | free if total |
| `rpc-disagreement` | **them** — a provider is serving something FALSE | ⚠️ no: a retry may return agreement and ERASE the evidence | yes |
| `rpc-quorum-unmet` | a value EXISTS and is refused — a lone survivor is a one-step downgrade | yes | free if total |

⭐ A disagreement is **the only signal that proves a single-endpoint build would have SIGNED AND SOLD
a false claim.** Everything else is a non-event.

### ⭐⭐ CONDITION 2: THE ESCALATION IS STRUCTURALLY UNREACHABLE FROM THE BILLING BRANCH

Charging for a disagreement makes a provider-integrity failure **revenue-positive** — the flat-price
argument (*"a coverage-scaled price would pay us more for reporting more coverage, an incentive to
overstate"*) aimed at a different variable. The defence is **structural, not procedural**:
`escalateProviderIntegrity(report, correlationId)` takes the report and nothing else, and is called
from inside `produceReport` — which runs BEFORE `runPaidAnalysis` decides anything and never learns
the outcome. **The charge decision is not in scope and cannot be branched on, because it does not
exist yet.** The reason is written at the code, with a "do not simplify these together" warning.

### CONDITION 1: the split is disclosed at REPORT level

`sources.integrity` now carries `providerDisagreement` + the splitting slots + a note saying it
**bears on every check in the report, not only the ones listed** — because the slots that AGREED were
read from the same set, one member of which is now known to be wrong about something. ⚠️ Single-RPC
mode reports `providerDisagreement: null`, never `false`: with nothing to compare against, a provider
serving something false is indistinguishable from one serving the truth.

### ⚠️ TWO CORRECTIONS MADE WHILE BUILDING

* **Three manifest reasons, not four.** Both mappers deliberately collapse `chain-disagreement` into
  `rpc-disagreement`. Defensible — the chain guard catches it before any slot is read — but claiming
  a fourth would be inventing a state nothing emits. 🚧 The mapping is duplicated in `quorum.mjs`
  AND `coverage.mjs`.
* 🚨 **`scripts/` IS DEPLOYED CODE OUTSIDE THE STAMPED SURFACE.** `dd-analyze` imports `chainClient`
  and `attest-circle.mjs` from `scripts/dd/`, pulling in `client/chains/rpc/attest-circle` — none of
  them hashed. ⭐ **Including `scripts/dd/chains.mjs`, the file this thread originally pointed at.**
  The new endpoint set was put in `shared/` so it adds no debt; the pre-existing gap is ITS OWN item
  — a file move does not belong in a money-path behaviour change.

### PROOF — and the mutation testing earned its keep twice

`verify-quorum-billing.mjs` (new, 21 checks) + `verify-analyze` 85/0 (8 new) + all 14 DD suites +
bridge green + tsc + build clean.

**Mutations:** systemic failure bills → red. A disagreement laundered into a free outage → red.
Report-level disclosure removed → red (4).

⭐⭐ **AND ONE MUTATION EXPOSED A DEAD CHECK — TWICE OVER.** Deleting the escalation call left the
suite GREEN. First cause: `indexOf` returns `-1` when absent and `-1 < anything` is TRUE — absence
reading as safe, inside a check written about structural guarantees. Second cause, found after fixing
the first: the search string also matched the FUNCTION DECLARATION, so the check would have passed
forever while the escalation never ran. ⭐ **"The string appears" is not "the call happens."** Now
matched as a statement form, and the mutation fails as it should.

⚠️ A malformed mutation also nearly produced a false pass again (the deletion did not apply the first
time). **Verify the mutation mutated before believing the green** — that is now three times this
session.

### STATE

* ⛔ **UNDEPLOYED.**
* 🚧 **`scripts/dd/{client,chains,rpc,attest-circle}.mjs` deploy unhashed.** Its own commit.
* 🚧 The `chain-disagreement` → `rpc-disagreement` collapse is duplicated across two mappers.

## 2026-08-16 — ⭐⭐ ONE RPC PER CHAIN WAS THE ARCHITECTURE, NOT THE INCIDENT. Every chain now has two.

### 🚨 THE RECORD HAS NOT RESOLVED — and that is the honest headline

`o/0xfd801d08…/0xccc02035…` still reads `mint_unconfirmed`, `delivery: predicted`,
`amountDelivered: null`, `lastCheckedAt: 2026-08-14T22:20:22Z` — unchanged, `settlingSince` absent.
**No settler has run since the RPC fix.** Not a failed fix; nothing invoked it.

⭐ **BUT THE MONEY IS PROVEN TO HAVE ARRIVED**, read-only, replicating exactly what the settler does:

| instrument | result |
|---|---|
| IRIS | `status: complete`, `forwardState: COMPLETE`, `forwardTxHash 0x7953bfb9…` |
| Polygon Amoy, new RPC | receipt `status 0x1`, block **43,849,013** |
| USDC Transfer log | **0.94899 USDC** to `0x058957de…` |

The record's `netPredicted` is **0.94899** — the arrival matches the prediction exactly. ⭐⭐ **The
bridge worked perfectly on 2026-08-02; only our ability to READ it failed.** The verification that
failed ~1,730 times now succeeds on the first attempt.

### ⚠️ THREE CORRECTIONS TO THE GENERALISATION

The instinct — *one endpoint per chain is a single point of failure* — is **right**, and is now fixed.
Three details were not:

1. **Wrong file.** The incident came from `DESTINATION_CHAINS` in `netlify/functions/_receipt.mjs`.
   `scripts/dd/chains.mjs` is the DD engine's separate table and had nothing to do with it. Both had
   the SPOF; only one caused this.
2. **Quorum's second endpoint IS configured** — `QUORUM_ENDPOINTS` has two (Arc public + dRPC, with a
   documented distinct-backend check). ⭐ The real gap is worse: **the live `dd-analyze` endpoint does
   not use quorum at all** (`analyze(addr, { client: chainClient(chain) })`, single endpoint).
   Quorum is reachable only from the CLI and tests. **Still open.**
3. **"Nothing distinguishes waiting-on-a-mint from can't-read-the-chain"** was true when written, but
   that is option (b) and it shipped in `b7f6f35`/`2fa7378`: `cause: chain_unreadable` vs
   `never_appeared`, plus `lastVerifyFailureKind: unreachable|transient`.

So (b)'s core existed; **(a) was the one still missing.**

### THE FIX — FALLBACK, DELIBERATELY NOT QUORUM

All 8 chains now carry two endpoints from different providers, each verified live (16/16).
⚠️ **Fallback, not quorum, and the distinction is load-bearing.** Integrity here is already pinned
three ways — chainId, the USDC contract address, and a Transfer log paying the recorded recipient —
so requiring AGREEMENT would convert a second endpoint being down into a **refusal**: an availability
fix that invents a new way to fail. That is the same BLOCK-rate objection `quorum.mjs` itself raises
against putting quorum on the deposit path.

⚠️ **A chain-id mismatch is NOT retried onto the sibling.** That is a configuration fault, not an
availability one; falling through would hide the very misconfiguration the pin exists to catch.
⚠️ **The aggregate kind is `unreachable` only if EVERY endpoint was** — one transient alongside a dead
host must not be reported as permanent.

### ⭐⭐ THE FALLBACK CREATES A NEW WAY TO GO QUIET, AND THE GATE NOW COVERS IT

With two endpoints, a dead one is **invisible at runtime** — the survivor answers and verification
succeeds, while the chain is silently back to a single point of failure. **An availability
improvement that hides its own degradation is how the original defect returns wearing a redundancy
badge.** So `gate:rpc` checks EVERY endpoint, fails on any permanently-dead one, names a
single-endpoint chain as the residual SPOF, and headlines `REDUNDANCY DEGRADED`.

### PROOF

Calibrated on three real configurations: a dead secondary (**fails**, and is not mistaken for
healthy), a chain reduced to one endpoint (**warns**, named as a SPOF), and both endpoints dead
(**fails**). ⭐ **That calibration caught a defect in the new gate itself:** with 0/2 usable, the
summary claimed *"verification still works"* about a chain that could not be read at all. Fixed with
a `healthy >= 1` guard — the same false-reassurance class this whole thread has been about.

**Five mutations, all red, restore green:** remove the fallback, let a wrong-chain primary fall
through, force the aggregate kind to `unreachable`, drop a chain to one endpoint, delete the
degraded-redundancy headline.

`verify-bridge-receipts` **180/0** (9 new), copy 32/0, gate:rpc 8 chains / 16 endpoints, routes 5/0,
tsc + build clean.

⭐ **A live transient was observed and handled correctly mid-run:** `1rpc.io/sepolia` failed one gate
pass and passed 6/6 on direct probing — warned, not failed, exactly as the transient/permanent split
intends.

### STATE

* ⛔ **UNDEPLOYED.**
* 🚧 **The record still needs a settle.** It resolves when the owner opens the Bridge panel — the
  read path re-triggers on `isRecheckable`, deliberately NOT on the auto-retry bound. Expect
  `minted` / `measured` / `0.94899`.
* 🚧 **`dd-analyze` still reads from a single endpoint** while a tested quorum layer sits unused.
  That is the same SPOF, one subsystem over, on the path that takes money.

## 2026-08-15 (night) — ⭐ `src` JOINS THE STAMPED SURFACE. Two production deploys had passed a tree check that could not see what changed.

✅ **The copy-suite conversion deployed first** — `dd16f23` live as `6a80206da3bffeead9e12042`,
`gate:deployed` ran (eight for eight), and pushed.

### 🚨 THE DEFECT, VISIBLE IN THE GATE'S OWN OUTPUT TWICE

`SURFACES` was `["netlify/functions", "shared"]`. The tree hash is documented as THE IDENTITY of a
deployed artifact, and `verify-deployed` compares it to decide whether production serves the build in
hand. But a commit touching only `src/` produced a **byte-identical tree** — so `0d16bfc` and
`dd16f23` both reported `✓ production serves THIS tree` against a hash that could not have
distinguished them. ⭐⭐ **THE CHECK PASSED WITHOUT EXAMINING THE THING THAT CHANGED: the client
bundle.** Only the COMMIT line verified those two deploys, and the commit is explicitly documented as
provenance rather than identity.

⚠️ A hash that cannot see the change under test is not a weaker check — it is a check reporting on
something else, and it reported PASS both times.

### ⭐ AND THE DRIFT GUARD WAS BLIND IN EXACTLY THE DIRECTION THIS CHANGE MOVES

`checkTreeClean` keeps a deliberate second copy of `SURFACES` and asserts it against the stamp's
source, with a header warning about precisely this: *"the stamp would start hashing a directory this
gate never checks, and the gate would pass while the artifact drifted."* But the comparison asked
only **"is every dir I know still named in the stamp?"** — which catches a REMOVAL and is blind to an
ADDITION. ⭐⭐ **Widening SURFACES would have sailed straight past it**, leaving the gate checking the
narrower surface while the stamp hashed the wider one.

It now parses the real array and compares **as a set, in both directions**, naming which side is
missing what and why it matters.

### MEASURED, NOT ASSUMED

| | before | after |
|---|---|---|
| `tree` | `3a18eb54d4db…` | **`5f45be3be525…`** changed |
| `ddTree` | `f4c8ec9bfa4d…` | **`f4c8ec9bfa4d…`** UNCHANGED |
| files | 119 | 155 |

⭐ **I HAD WARNED THAT WIDENING WOULD SHIFT `ddCodeIdentity`. THAT WAS WRONG.** `ddPaths` is filtered
out of the same walk by `DD_SURFACE_DIRS`/`DD_SURFACE_FILES`, none of which match `src/` — so the DD
health identity keeps its exact meaning and no DD refusal window opens. Checked in the code and then
confirmed by the regenerated stamp, rather than trusted either way.

⚠️ **`dist/` stays excluded** — it is build OUTPUT, so hashing it would make the stamp depend on the
build it is stamping. `src/` is that output's INPUT and is stamped in `prebuild`, before vite runs.

### PROOF

**Four mutations, all red, restore green:**

| mutation | verdict |
|---|---|
| stamp ADDS a surface the gate does not check | ❌ *"The stamp hashes config and this gate does NOT — a dirty deploy on those paths would pass unnoticed"* |
| stamp REMOVES a surface | ❌ named in the other direction |
| the SURFACES array becomes unparseable | ❌ refuses rather than guessing |
| a DIRTY `src/` file | ❌ **GATE FAILS. DO NOT PROMOTE** — the new behavioural consequence |

Full repo green: DD 14 suites, bridge 171/111/72/78, copy 32, vault, ub, quote, routes, rpc,
strong-read-watch 230, blobs-probe 71, tsc + build clean. `gate:watch` now reports
*"clean across netlify/functions, shared, src"*.

### STATE

* ⛔ **UNDEPLOYED** — and this deploy is the one that matters: it is the first whose tree hash
  genuinely covers the client. Every subsequent client-only change will be verified by the tree
  rather than by the commit alone.
* ⚠️ **A DIRTY `src/` NOW BLOCKS PROMOTION.** That is the intended consequence and it is stricter
  than before — an uncommitted client edit is now deploy drift, because it now IS.

## 2026-08-15 (evening) — ⭐ THE LAST SOURCE-SCANNING COPY GUARD IS GONE. Its own header asked for this, and had done since the day it was written.

✅ **The silent-row fix deployed first** — `af28b53` live as `6a80187cb24a4ab9c0828c46`, both gates
ran, seven for seven, and pushed. ⭐ Unlike the previous deploy, that one's tree hash was a **real**
comparison (`3a18eb54d4db`, new) because it touched `netlify/functions`.

⚠️ **A deploy-hygiene note worth keeping:** the push was made WHILE the deploy was bundling, and
`npm run stamp:clear` was deliberately NOT run until it finished. esbuild inlines
`shared/build-stamp.generated.mjs` into each function as it bundles, so clearing the stamp mid-bundle
could bake a NULL stamp into functions not yet processed — producing an artifact that reports
UNRESOLVED provenance and fails `gate:deployed`'s third check. Uncommitted changes are not pushed, so
the push needed no such step anyway.

### THE CONVERSION — `verify-unified-balance-copy.mjs` → `.tsx`

Its own header had carried this since it was written: *"this reads SOURCE, not rendered output. It
cannot see text built from variables, text in props of components it does not know about, or a NEW
file carrying the falsehood. See PROGRESS.md: the guard should render the components."*

⭐ **RENDERING TURNED OUT TO NEED NO EXTRACTION HERE** — unlike the bridge panel. Both components
render under `renderToStaticMarkup` with a plain wallet stub. Only `useGatewayBalance` had to be
mocked, and for a precise reason: **SSR does not run effects**, so the hook would sit at `loading`
forever and the parked-funds branch — the one carrying the disclosure — is unreachable otherwise.
Mocking the DATA renders the REAL component in the REAL state a user with parked funds sees.

### THREE THINGS THE SOURCE SCAN COULD NOT DO

1. ⭐⭐ **`badge="Exit built · about seven days"` is a PROP handed to `<Pocket>`** — a component the
   old guard never opened. "The literal exists in the file" was the most it could ever say; this
   proves it **reaches the output**. That badge has been wrong twice, and four words next to a
   number get read more than the paragraph beneath them.
2. ⭐⭐ **The YourMoney disclosure is gated on `gwParked > 0`** — and the old count of `1` was silent
   on whether a user ever reaches it. Now asserted in BOTH directions: present when funds are
   parked, **correctly absent when none are** (nothing at stake to disclose). That pins the GATE, so
   neither a user with funds losing the warning nor an empty account growing a spurious one can
   happen unnoticed. ⭐ And the counterpart is pinned too: the **before-deposit** disclosure in
   UnifiedBalancePanel must NOT be balance-gated — it is read before there is a balance.
3. ⭐ **Forbidden phrases are checked against the whole rendered tree in three states** (parked,
   empty, signed-out), so a falsehood cannot hide in a branch that happens not to render — nor in a
   child component whose file the old scan never opened.

### PROOF

**Six mutations. The formatting one stays green; all five meaning ones go red.**

| mutation | verdict |
|---|---|
| **wrap a phrase across four lines** | ✅ **stays green** |
| restore the v3 falsehood "There is no path that returns it" | ❌ red |
| the badge reverts to "No withdrawal built" | ❌ red (4 checks) |
| the warning fires when NOTHING is parked | ❌ red |
| the before-deposit disclosure becomes balance-gated | ❌ red |
| a site is silently dropped (count 2 → 1) | ❌ red |

⚠️ **ONE MUTATION WAS MALFORMED AND I ALMOST RECORDED A FALSE PASS.** The balance-gate mutation first
inserted a dead `{false && …}` expression, which gates nothing — the suite stayed green and briefly
looked like a hole. Re-run as a REAL gate it failed, on exactly the check named for it. ⭐ A mutation
that does not actually change behaviour proves nothing about the test; the green was evidence about
my sed, not about the suite.

`test:copy` **32/0** rendered, bridge 171/111/72/78, tsc + build clean. The `.mjs` is **deleted, not
kept alongside** — two guards on one claim, one of which cries wolf, teaches people to ignore both.

### STATE

* ⛔ **UNDEPLOYED** — but this one touches only `src/` and `scripts/`, so the stamped surface is
  unchanged and the tree check will again be a no-op. The COMMIT check is what will verify it.
* ⭐ Every copy guard in this repo now asserts on rendered output. The `.mjs`-era note in
  `assert-on-rendered-output-not-source-regex` finally has mechanisms everywhere it pointed.

## 2026-08-15 (later still) — ⭐ THE SILENT ROW IS CLOSED — and closing it found a receipt row showing a FABRICATED `0.0000 USDC`.

✅ **The rendering test deployed first** — `0d16bfc` live as `6a8010faba99f17f3fd516e2`, both gates
ran (`gate:rpc` 8/8 pre-build, `gate:deployed` post-deploy, six for six), and pushed.

⚠️ **One honest note on that deploy:** its served tree `a6fb033d967b` was **identical to the previous
one**, because the stamped surface is `netlify/functions` + `shared` and that commit touched only
`src/` and `scripts/`. So the tree check was a NO-OP; what verified it was the COMMIT check. For a
client-only change the tree hash is blind. 🚧 Widening `SURFACES` would shift `ddCodeIdentity` and
every tree hash in the repo — flagged, not done.

### THE FALLBACK — silence was the worst available answer

An unrecognised state rendered **nothing**: the row still showed an amount and a destination, so it
looked like every ordinary row while saying nothing about the money. ⚠️ **Strictly worse than an
error** — an error prompts someone to look, a blank does not.

The fallback names the raw state (the one datum that makes the row actionable) and ⭐ **claims
nothing in either direction** — asserted both ways: it must not imply arrival, and must not imply
failure. A receipt with no state at all says *"no status was recorded"*.

### ⭐⭐ THE BINDING — because the realistic bug is not a typo

The dangerous version is someone adding a **legitimate new state server-side** that the client never
learned. Nothing would fail; one row would quietly go silent. So:

* `ALL_RECEIPT_STATES` is now **composed** on the server from the existing constants, never
  transcribed — `SUBMITTED_STATE + SUBMIT_FAILED_STATE + BURN_CONFIRMED_STATE + TERMINAL_STATES`.
* `KNOWN_RECEIPT_STATES` in the client **is** a transcribed copy, and that is stated plainly as a
  duplicate source of truth. It is unavoidable — `_bridge-receipts.mjs` imports `@netlify/blobs` and
  cannot enter the browser bundle — so ⭐ **the duplication is made safe by a test that reads BOTH
  SIDES**, in both directions, rather than by hoping. *A binding can only be tested across what it
  binds.*
* And every **writer** is checked against the vocabulary, with the writer list **derived** from "who
  imports a receipt writer" rather than hardcoded — so a new writer file cannot escape it.
  ⚠️ A first attempt scanned every function and flagged `approving`, `pending`, `completed`… — the
  JOB/DCA/x402 state machines, different stores entirely. `job-bridge-approve.mjs` writes its own
  `burn_confirmed` into a **separate** receipt system and is correctly excluded by the derivation.

### 🚨 AND RENDERING FOUND ANOTHER ONE: `0.0000 USDC`, FABRICATED

`Number(null)` is **0**, not NaN. So a receipt with `netPredicted: null` rendered:

> *"in flight — estimated **0.0000 USDC** to arrive"*

⚠️ **A specific, confident, WRONG figure for an amount nobody ever recorded** — and REACHABLE:
`recordPendingBridge` writes `netPredicted: c.netUsdc ?? null` when there is no consent context, and
the reconcile job carries that null into the **durable** receipt. So a bridge recovered by the job I
wrote two commits ago could show a user `0.0000` as an estimate. ⭐ **NaN at least looks broken;
0.0000 looks like an answer.** An absent field rendered `NaN` — bad, but the less dangerous of the two.

All four amount sites now go through a `usdc()` helper returning **null rather than a number** when
there is nothing to show, and each call site says something true instead. Measured before and after,
not assumed.

### PROOF

**Six mutations, all red, restore green:** remove the fallback (silence returns, 6 red), make the
fallback claim funds are safe, have the client forget a state the server writes, have the **server
add a state the client never learned**, have a **writer emit an undeclared state**, and restore the
`0.0000` fabrication (5 red).

`verify-bridge-receipts` 171/0, fee-band 111/0, quote 72/0, **bridge-copy 78/0** (25 new, from 53),
tsc + build clean.

### STATE

* ⛔ **UNDEPLOYED** — moves the stamped surface (this one genuinely does: `netlify/functions`).
* ⭐ Both defects in this entry were found by RENDERING, neither by a test anyone thought to write.
  That is now two commits running where the rendering harness paid for itself immediately.
* ✅ **CLOSED 2026-08-15** — `verify-unified-balance-copy` is now a RENDERING suite too. See the
  entry above.

## 2026-08-15 (later) — ⭐⭐ THE RENDERING TEST — and on its FIRST RUN it caught a sentence the source regex had let me silently delete.

✅ **The RPC fix deployed first** — `2fa7378` live as `6a800701563075acd9f6ffeb`; **both** gates ran:
the new `gate:rpc` pre-build (8/8 healthy, polygon now green) and `gate:deployed` post-deploy (five
for five). All nine commits then **pushed** — `044ab44..2fa7378`, origin and local now equal.

### 🚨 THE GUARD WAS WORSE THAN NOTHING, AND HERE IS THE PROOF

The panel copy was guarded by source regexes. Across five commits they broke **five times**, and
every break was text **MOVING**, never meaning changing:

| # | what moved | it was "fixed" by |
|---|---|---|
| 1 | JSX wrapped `could not be / determined` onto two lines | matching `\s+` |
| 2 | the `unresolved` row grew an attempt branch, pushing the phrase past the window | widening 400→900 |
| 3 | the settler gained three fields between two anchors | widening 900→2200 |
| 4 | (same shape again in the receipts suite) | widening |
| 5 | the copy moved to a new file entirely | retired today |

⭐⭐ **FIVE FALSE ALARMS, ZERO TRUE ONES — AND THE "FIXES" WERE ALL LOOSENING.** Then it missed a real
one. `d8483f1` rewrote the `unresolved` row to add the attempt count and **silently deleted "This
will not resolve on its own"**. The regex — widened in that very commit — still passed, because it
only asserted the phrase that survived (`reconcile this transaction against Circle`).

⚠️ **THAT SENTENCE IS LOAD-BEARING.** "Reconcile by hand" is an instruction; only "this will not
resolve on its own" tells a user that **waiting is futile**. Without it someone can reasonably sit
and wait for a record nothing will ever resolve. Restored, verified against `7622cd3` in git rather
than from memory.

### THE FIX IS ARCHITECTURAL, NOT A BETTER PATTERN

**`src/components/bridgeReceiptStatus.tsx`** — the copy extracted as a pure component: no hooks, no
wallet, no fetch, no props but the receipt. ⚠️ It holds **no logic of its own** — every band, cause
and cap is computed server-side and arrives on the receipt; a second copy of the age cap in the
client is the duplicate-source-of-truth bug this system keeps designing around.

**`scripts/verify-bridge-copy.tsx`** (`npm run test:bridgecopy`, chained into `test:bridge`) renders
it with `react-dom/server` and asserts on **TEXT CONTENT** — 53 checks. It sees four things no regex
can: a branch present in source that never renders; text assembled from variables; **two branches
matching at once** (two contradictory sentences in one row); and a state that renders **nothing**.

### PROOF — the mutation result is the whole argument

⭐⭐ **SEVEN MUTATIONS. THE FORMATTING ONE STAYS GREEN; ALL SIX MEANING ONES GO RED.**

| mutation | verdict |
|---|---|
| **wrap a phrase across four lines** (what broke the regex 5×) | ✅ **STAYS GREEN** |
| delete "will not resolve on its own" again (the real regression) | ❌ red |
| let "yet" back into the `unwitnessed` row | ❌ red |
| `chain_unreadable` reverts to "it may still land" | ❌ red |
| two branches match at once | ❌ red |
| a state renders nothing | ❌ red |
| the attempt count stops being interpolated | ❌ red |

**Insensitive to formatting, sensitive to meaning** — exactly inverted from what it replaces.

`verify-bridge-receipts` 171/0, fee-band 111/0, quote 72/0, **bridge-copy 53/0**, tsc + build clean.

⭐ **THE SUPERSEDED REGEXES ARE DELETED, NOT KEPT ALONGSIDE.** Two guards on one claim, one of which
cries wolf, teaches people to ignore both — and the ignoring is what let a real deletion through.

### 🚧 A GAP FOUND BY RENDERING, ASSERTED RATHER THAN HIDDEN

An **unknown state renders NOTHING** — a row showing an amount and destination with no status,
which reads as ordinary. That is the panel's own core failure mode, and no source regex could ever
have detected it. ⚠️ **It is NOT fixed here.** It is pinned by a check that asserts the empty render,
so the check **starts failing the moment someone adds a fallback** — which is the reminder to.

### STATE

* ⛔ **UNDEPLOYED** — moves the stamped surface.
* ⚠️ `tsconfig` `include`s only `src`, so `tsc --noEmit` does **not** typecheck the test file; it is
  verified by RUNNING. Same gap forces an explicit `import React` (classic transform under `tsx`);
  a `@jsxImportSource` pragma does not help, as that only redirects an already-automatic transform.
* ✅ **CLOSED 2026-08-15** — converted to a rendering suite. See the entry above.

## 2026-08-15 — 🚨🚨 THE ROOT CAUSE: `rpc-amoy.polygon.technology` HAS NO DNS RECORD. Twelve days, ~1,730 failures, one decommissioned hostname.

✅ **The Polygon record fix deployed first** — `b7f6f35` is live as `6a7f8fd24bbcc3c88c0684c9`,
`gate:deployed` ran automatically (four for four) and was **independently re-run ~7h later** against
live prod: still `ready`, still serving tree `db19a528b135`.

### 🚨 THE MEASUREMENT — two independent resolvers, and a differential

| instrument | `rpc-amoy.polygon.technology` | control |
|---|---|---|
| local resolver | **NO RESOLUTION** | `polygon.technology` resolves |
| Google public DoH | **NOERROR, SOA only, NO A RECORD** | `polygon.technology` → 104.18.41.110 |
| `curl` | **exit 6, "Could not resolve host"** | base/optimism/ethereum RPCs → HTTP 200 |

⭐ **THE DIFFERENTIAL IS WHAT MAKES IT CONCLUSIVE.** Three other testnet RPCs answered 200 from the
same machine in the same second, so this is not a sandbox network fault. The endpoint is
**decommissioned**. A full audit of all 8 destinations: **7 healthy, polygon the only dead one.**

⭐⭐ **AND 100% FAILURE WAS THE TELL NOBODY READ.** Rate limits and flaky nodes are INTERMITTENT; a
dead DNS name fails *every single time*. Twelve days of a perfect failure rate was itself the
evidence, and it was visible from the first hour. ⚠️ Yesterday's entry called this "a chain we cannot
read" — right, but it read as bad luck. It was a one-line config fault the whole time.

**Fixed:** `https://polygon-amoy-bor-rpc.publicnode.com` — chainId 80002, `eth_getTransactionReceipt`
permitted (returns `null` for an unknown hash rather than erroring), synced at block 44,954,674, and
⭐ the **pinned Amoy USDC address has 1,798 bytes of code on it**, which cross-checks that the
endpoint really is Amoy and the address we match Transfer logs against is real. publicnode was
already this file's choice for ethereum-sepolia, so it is not a new dependency.

### 🚨 THE THIRD THING THAT LINE DISCARDED

`verifyMintOnChain` has **always** returned a `detail`, and the settler has **always** stored only
the one-word `reason`. So the record said `rpc_error` while the actual message — a DNS failure naming
a host that no longer exists — was computed, thrown away, and recomputed ~1,730 times.
⭐⭐ **THE DIAGNOSIS WAS IN HAND ON EVERY SINGLE ATTEMPT AND WAS NEVER WRITTEN DOWN.** Now persisted
as `lastVerifyFailureDetail`, `lastVerifyFailureKind` and `lastVerifyRpc`.

*(That is three separate discards on one line, found on three consecutive passes: the IRIS-claimed
mint hash, the failure detail, and the cause. Each was in scope; each was dropped.)*

### ⭐ THE DISCRIMINATOR — permanent vs transient

`classifyRpcFailure` splits `unreachable` (ENOTFOUND / ECONNREFUSED / bad cert — **ours, permanent,
one line**) from `transient` (timeout / 5xx — **theirs, probably fine in a minute**). `fetch` reports
both as an opaque "fetch failed"; the real cause hides in `e.cause.code`.
⚠️ **UNKNOWN DEFAULTS TO `transient`, deliberately** — calling something permanent is a claim that a
human must go change configuration, so permanence has to be EARNED by a recognised signal.

### ⭐⭐ THE CLASS FIX — `gate:rpc`, because the URL is not the fix

The URL is one line. The actual defect is that **a decommissioned endpoint could decay silently for
twelve days**, because nothing ever asked "is this endpoint alive?" outside a money-path check that
only runs when a bridge happens to need it. `scripts/verify-destination-rpcs.mjs`, wired into
`deploy:prod` **before the build**, asks per chain:

1. does it answer `eth_chainId` at all
2. does that chainId **equal the pinned one** — ⚠️ a healthy RPC for the WRONG chain is worse than a
   dead one, because the chain-pin would reject every mint while the endpoint looked green
3. is `eth_getTransactionReceipt` **permitted** — some endpoints answer `eth_chainId` and refuse the
   method we actually depend on, which would fail for the first time on a user's bridge
4. does the **pinned USDC contract have code** there — proof of both the chain and the address

⚠️ **A TRANSIENT FAILURE WARNS, IT DOES NOT FAIL THE GATE.** If a third-party testnet node having a
bad minute could block a deploy, the gate would be disabled within a week — and a disabled gate
protects nothing. `--strict` fails on both. ⭐ That split is what makes a blocking gate survivable.

### PROOF

⭐ **CALIBRATED ON ALL THREE FAILURE BRANCHES BEFORE BEING TRUSTED** — each proven by a real run:
· the dead URL → `✗ polygon … eth_chainId failed [unreachable] — fetch failed (ENOTFOUND)`, exit 1,
  **in one second** (the diagnosis that took twelve days)
· a healthy endpoint on the wrong chain → `CHAIN MISMATCH — pinned 80002, endpoint reports 84532`
· a bogus pinned USDC → `PINNED USDC 0x…dEaD HAS NO CODE on this endpoint`

`verify-bridge-receipts` **180/0** (17 new, from 163), fee-band 111/0, quote 72/0, tsc + build clean,
`gate:rpc` 8/8 healthy. ⭐ **MUTATION-TESTED — six mutations, all red, restore green:** default
unknown failures to `unreachable`, classify DNS as `transient`, restore the dead URL, discard the
detail again, remove `gate:rpc` from `deploy:prod`, and drop the chainId-pin check.

⚠️ **A TEST-INFRASTRUCTURE TRAP WORTH RECORDING:** `_receipt.mjs` is mocked at the top of the receipt
suite, so the first version of these checks imported the STUB and would have tested the mock rather
than the code. Bypassed with a `?real` query specifier, and said so in the file — a green check
against a stub is worse than no check.

### STATE

* ⛔ **UNDEPLOYED** — moves the stamped surface.
* ⚠️ **The 12-day record still will not self-heal**, and that is correct: it is past the 7-day
  unattended-retry bound from `b7f6f35`. It is now recoverable **on demand** — the owner opening the
  panel re-triggers a settle, and that settle will now reach a working RPC. ⭐ The two fixes compose:
  the bound stopped the pointless retrying, this makes the retry that a human triggers actually work.
* ⚠️ Its IRIS-claimed mint hash is still unrecoverable (discarded before the fix), so verification
  will re-derive it from IRIS on the next attempt rather than reading it from the record.
* 🚧 The panel copy is STILL source-pinned only. The regex has now broken **four** times across four
  commits, every time from text moving rather than meaning changing. It needs a rendering test.

## 2026-08-14 (night) — 🚨 THE 12-DAY RECORD WAS NEVER A PENDING MINT. IRIS SAID IT LANDED, AND WE THREW AWAY THE HASH 1,730 TIMES.

✅ **The reconcile job deployed first** — `d8483f1` is live as `6a7f842d8f85092df7456b94`, and
⭐ **`gate:deployed` ran automatically again** (three for three): published `ready`, served tree
`c39ab9f0927e` == local, both instruments agreeing, no orphans.

### 🚨 THE REFRAME — verified at a single write site

`lastVerifyFailure` is written on **exactly one line** of `bridge-mint-settle-background.mjs`, and
that line is reachable **only** after `status.state === "minted"`. The branch structure is decisive:

```
if (status.state === "failed")  -> mint_failed              (no lastVerifyFailure)
if (status.state !== "minted")  -> pending; deadline -> mint_unconfirmed  (no lastVerifyFailure)
// ==> from here, IRIS HAS SAID "minted"
chk = verifyMintOnChain(...)
  if (rpc_error | receipt_not_found) and past deadline -> mint_unconfirmed + lastVerifyFailure  ← the only site
```

⭐⭐ **THEREFORE `lastVerifyFailure` PRESENT ⟹ IRIS REPORTED THE MINT AS LANDED.** So
`o/0xfd801d08…/0xccc02035…` was never "a mint we are waiting on". It is: *Circle reported this mint
completed on Polygon Amoy on 2026-08-02, and our own read of that chain has failed every time since.*
**The money almost certainly arrived.** The panel called it *"unproven … it may still land"* — wrong
in both halves, and it filed **an infrastructure fault on our side as a pending bridge** for twelve days.

⚠️ Yesterday's entry said *"a chain we cannot read"* and that this was "its own signal". Correct, and
weaker than the truth: the record could always distinguish these two, and nothing ever read the field
that distinguished them.

### 🚨 THE SECOND DEFECT — the one datum a human needs was DISCARDED, once per retry

On that same branch the settler has `status.mintTxHash` in scope — IRIS has just supplied the hash it
claims landed — and **did not record it**. `irisClaimedMintTxHash` was written only on the
`mint_unverified` branch. Confirmed absent from the live record.

⭐ **A record whose whole remaining value is "a human should check this" had thrown away the thing
they would check — ~1,730 times over twelve days.** Now recorded, alongside a `verifyFailureCount`
streak so "we failed to read the chain N times" is a **measurement** rather than an inference from
age — and so a persistent RPC fault is distinguishable from a settler that never ran.

### THE BOUND — on unattended retry, NOT on recovery

`MINT_AUTO_RETRY_MAX_AGE_MS` = 7 days, measured off `burnedAt`. ⭐ **`job-sweep.mjs` has carried
exactly this clause all along** — *"AGE CAP (> 1h → marked failed, not nudged forever)"* — and it was
simply never carried across to the bridge sweeper.

⚠️ **WHAT IT MUST NOT DO, AND DOES NOT: undo the 2026-08-01 fix.** `mint_unconfirmed` was made
re-checkable *because a mint can land after we stop waiting*, and treating it as resolved had made a
demonstrably-successful bridge read "unproven" forever. So this bounds **the cron's unattended
retry** and nothing else: a 12-day record is still `isRecheckable`, still `isStranded`, and still
recovered by the owner-scoped read path when a human opens the panel. ⭐ **A human looking is a
bounded, paid-for retry; a cron is not.** Mutation-tested in both directions — bounding it by
foreclosing recovery turns the suite red.

⭐ **AND `isStranded` KEEPS ONE DEFINITION.** The sweeper does not get a second, drifted copy; it
composes the shared predicate with a *named* `isAutoRetryExhausted`, so the difference between the
cron and the read path is a visible clause rather than a divergence.

⚠️ An **undateable** burn counts as exhausted — diverging from `isPastDeadline` for the same reason
`provisionalStatus` does: that predicate *starts* an action so an unknown must not trigger it; this
one *stops* one, and a record nobody can date must not receive infinite machine effort.

### ⭐ STRANDED vs ABANDONED — the alert-noise fix, at its source

One stale record kept `stranded` permanently ≥ 1 and flapping, so any alert on it was noise from a
single case — **and an alert that always fires is one nobody reads, which is worse than none.** Past
its retry budget a receipt leaves that bucket, so `stranded` means "act on this" again.

⚠️ **LEAVING THE QUEUE IS NOT LEAVING THE SYSTEM.** Abandoned records are counted, named and logged
`console.error` on **every** tick, before the clean early-return — so "we stopped retrying" can never
quietly become "we stopped mentioning". ⭐ The log names the **cause**, because it decides who owns
the problem: `chain_unreadable` is our RPC, `never_appeared` is the bridge. ⚠️ A degraded scan reports
`abandoned: null`, never `[]`.

### PROOF

`verify-bridge-receipts` **163/0** (25 new, from 138), fee-band 111/0, quote 72/0, `gate:routes` 5/0,
tsc + build clean. ⭐ **MUTATION-TESTED — seven mutations, all red, restore green:** remove the bound,
**bound it by foreclosing recovery** (the one that matters), let an undateable burn retry forever,
collapse the two causes into one, put abandoned records back in the stranded bucket, discard the IRIS
hash again, and report `abandoned: []` instead of `null` on a degraded scan.

### STATE

* ⛔ **UNDEPLOYED** — moves the stamped surface.
* ⚠️ **The existing record cannot be retro-repaired.** Its IRIS-claimed mint hash was discarded on
  every one of ~1,730 retries and is not recoverable from the record; `verifyFailureCount` starts at 0
  for it. The sweeper will say so in as many words — *"NO claimed mint hash was recorded"* — rather
  than printing a confident zero. Both are captured for every future occurrence.
* 🚧 **STILL NOT ANSWERED: why the Polygon Amoy read fails at all.** This makes twelve days of RPC
  failure legible, bounded and correctly attributed; it does not fix the RPC. That is now a named
  problem with an owner instead of an unexplained "unproven mint", which is the point — but it is
  not the same as fixed.

## 2026-08-14 (evening) — ⭐⭐ THE RECONCILE JOB IS BUILT. And building it found two ways it would have FABRICATED a money-movement record.

✅ **The cap deployed first** — `7622cd3` is live as `6a7f7912ba99f16548d51726`, and ⭐ **`gate:deployed`
ran AUTOMATICALLY at the end of the chain**, its first real execution: published deploy `ready`, served
tree `bbb9a639…` == local, both instruments agreeing, no orphans. The guard added that morning did its
job on the very next deploy without anyone invoking it. Bundling took 21m 54s.

**Why this job exists.** The cap made an aged-out row honest — *"needs review, this will not resolve on
its own, reconcile against Circle by hand."* True, and still asking a person to do something the server
can do itself. ⭐ **The cap makes the absence LOUD; it does not replace the thing that is absent.** This
is the thing.

### 🚨 TWO DEFECTS FOUND WHILE BUILDING IT — both would have written a receipt for money that never moved

**1. `waitForTx` IS CALLED TWICE, AND THE ERROR ONLY CARRIES AN ID.** `agentBridge` awaits Circle for
the USDC **approve** (`_bridge.mjs:270`) and then for the **burn** (`:281`). Both raise `TxPendingError`,
which carries only the id of whichever stalled — so a provisional `txId` is **not necessarily the burn
transaction**.

⭐⭐ **A NAIVE RECONCILE WOULD HAVE READ THE APPROVE'S `txHash` AND WRITTEN IT AS A `burnHash`.** The panel
would then say *"in flight — estimated N USDC to arrive"* for a bridge whose burn was never submitted,
and the settler would spend its life asking IRIS about a hash that is not a CCTP burn. ⚠️ **The
fabricated receipt would read as MORE trustworthy than the provisional record it replaced** — the worst
possible direction for a mistake in a receipt system.

Fixed upstream (`_bridge.mjs` tags `e.stage`), enforced downstream: ⚠️ **an absent or out-of-set stage is
REFUSED, never assumed to be `burn`.** Every record written by the deploy that shipped `412e8d0` has no
stage, and those land in the refusal branch **by design** — they need a human. Absence must not read as
safe, including the absence of a stage. The closed set is enforced at the WRITE too, so a junk value
becomes `null` rather than passing through.

**2. `verifyMintOnChain` HARD-REQUIRES `recipient`** and answers `bad_recipient` without it. A recovered
receipt missing it would park at `mint_unconfirmed` and be re-checked every 10 minutes **forever** —
landing precisely in the 12-day Polygon shape this session spent the morning documenting. ⚠️ The
recipient is the **agent's SCA**, not the session owner, so nothing downstream can re-derive it from the
record's own keys; it must be captured in `_actions.mjs` at throw time and carried on the provisional
record. It now is.

### THE JOB — `bridge-reconcile-background.mjs`

| Circle says | stage | outcome |
|---|---|---|
| `COMPLETE` | `burn` | durable receipt written under the REAL hash, settler triggered, provisional retired |
| `COMPLETE` | `approve` | terminal — the allowance landed, the bridge call was never made, **no burn exists** |
| `FAILED`/`CANCELLED`/`DENIED` | any | terminal — **no funds moved** |
| anything else | any | still pending, attempt recorded, record untouched |

⭐ **THE SWEEP TRIGGERS, THE JOB WRITES** — the same split the settler already uses, so
`bridge-mint-sweep` keeps its no-writes invariant (asserted by substring). ⚠️ The trigger runs **before**
the `total === 0` return, for the same reason the census does: a provisional record is never *stranded*,
so reconciling after that return would mean never reconciling at all.

⭐ **WRITE-THEN-DELETE, AND NEVER CLOBBER.** The durable receipt is written first and the `tx-` key
retired after; a failure between leaves a visible duplicate the next tick cleans up, where delete-first
risks losing the record. And a receipt the settler has already advanced is **never overwritten** — a
second tick must not replace `minted` + a measured amount with a fresh `burn_confirmed` and un-prove a
proven bridge.

⚠️ **CONSENT EVIDENCE IS CARRIED, NEVER RE-DERIVED.** `ackAcceptedAt` was the entire reason the
provisional record exists; recomputing it here would invent evidence rather than preserve it. The
recovered receipt is also marked `reconciledFromTxId`/`reconciledAt` — ⭐ it was **recovered, not
observed live**, and a reader who cannot tell the difference cannot weigh it.

⚠️ **AN UNREACHABLE CIRCLE IS NOT AN ANSWER** — the record is left exactly as it was. ⚠️ **An
unrecognised Circle state is treated as pending and NAMED**, never bucketed into a known outcome.
⚠️ **`COMPLETE` with no usable `txHash` writes nothing** — a hash is never invented to fill the slot.

### ⭐ THE EFFORT BOUND IS THE SAME BOUND AS THE CLAIM

Past the 24h cap the job **stops asking Circle**. Polling forever behind a row that says *"a human must
look"* would make that text false — and would be the Polygon record's unbounded re-check wearing a new
name, re-introduced by the very commit meant to answer it. Instead the record now carries
`reconcileAttempts`, so ⭐⭐ **an aged-out row is EVIDENCE rather than inference**: *"we asked Circle N
times and never got a confirmation"* versus a silent `0`, which means **nothing ever checked it** — a
different and more alarming problem, and the panel says so in those words.

### PROOF

`verify-bridge-receipts` **138/0** (27 new, from 111), fee-band 111/0, quote 72/0, `gate:routes` 5/0,
tsc + build clean. ⭐ **MUTATION-TESTED — seven mutations, all red, restore green:** drop the stage
guard, treat an approve as a burn (the fabricated-hash bug, 2 red), clobber an already-settled receipt,
stop carrying the recipient, let an unreachable Circle terminate the record, remove the 24h effort
bound, and let the writer pass an out-of-set stage through.

⚠️ Same coverage boundary as the cap: the job, the guards and the writer run for real against the real
store and key layout with Circle's answer injected; **the panel copy is SOURCE-pinned only.** ⭐ That
regex broke a third time here — the `unresolved` row grew an attempt-count branch and the matched phrase
moved past the window. Nothing a user sees changed. The note stands: this needs a rendering test, and a
source regex keeps proving why.

### STATE

* ⛔ **UNDEPLOYED** — moves the stamped surface. `npm run deploy:prod` (foreground, ~25 min);
  `gate:deployed` will confirm or refuse.
* ⚠️ **Existing provisional records cannot be reconciled** — they predate `pendingStage` and are refused
  by design. There are currently **zero** in the store, so this is a statement about the mechanism, not
  a backlog.
* 🚧 OPEN, still untouched: the Polygon record's unbounded `isRecheckable` and the missing age cap in
  `bridge-mint-sweep`. Its own item. ⭐ This commit repeatedly declined to re-create that bug; it has
  still not fixed the original.

## 2026-08-14 (later still) — ⭐ THE PROVISIONAL RECORD IS CAPPED. The word that was the lie was "yet".

🚨 **NOT DEPLOYED.** This touches `netlify/functions` and `src/`, so the tree hash has moved and prod
still serves `412e8d0`'s surface. `npm run gate:deployed` will report the mismatch until it ships —
which is the entire point of the gate added an hour ago, now doing its job on the very next commit.

**The defect, from the audit that went in expecting the opposite.** The fear was that `tx-<txId>`
would inherit the unbounded RETRY the 12-day Polygon record demonstrates. It could not — nothing
retries it at all. What it had instead is worse in one specific way: **it had no cost signal to
notice.** A record that retries forever burns invocations somebody eventually sees. A record that is
write-only and immortal costs nothing and says the wrong thing forever, for free.

⭐⭐ **THE WORD THAT WAS THE LIE IS "YET".** The panel said *"the Arc burn has not been confirmed yet"*
for the entire life of the record. "Yet" tells the reader someone is still waiting. **Nobody was** —
there is no sweeper, no settler and no reconcile job for a `tx-` record, so the sentence was false
from the first second, not merely aged. ⚠️ And it was false in the costly direction: **a user who
believes a process is watching will not go look themselves.** The copy was quietly discouraging the
only action that could have resolved it.

### ⚠️ CORRECTION to yesterday's entry — the sort claim was overstated

That entry said the sort *"floats it to the TOP permanently"*. Precisely: `listByOwner` sorts on
`burnedAt || submittedAt` **descending**, so a provisional record takes its normal chronological
place and sinks as soon as anything newer exists. It is pinned to the top only when nothing newer is
ever written — which is exactly the bridge-once-and-never-return user the sweeper was built for, so
the case is real, but it is conditional and was stated as unconditional.

⭐ **AND THAT IS WHY THE SORT IS LEFT ALONE.** Once the copy earns its prominence — an aged record now
says *"needs review, this will not resolve on its own"* — being first is correct, not a defect. The
bug was never the position; it was a permanent claim that got less true the more visible it became.

### THE CAP — derived at read time, never written

`provisionalStatus(receipt, now)` in `_bridge-receipts.mjs`, pure and `now`-injectable. Three bands,
a CLOSED set:

| band | age | says |
|---|---|---|
| `settling` | < 30 min | "not confirmed **yet**" — the only band where "yet" is honest |
| `unwitnessed` | 30 min – 24 h | "still unconfirmed, and **nothing is checking this automatically**" |
| `unresolved` | > 24 h | TERMINAL — "**will not** resolve on its own; reconcile against Circle by hand" |

⭐⭐ **DERIVED, NOT WRITTEN, AND THE REASON IS IN THIS FILE ALREADY.** A *written* terminal state is a
mistake this repo has already made one record-type over: `mint_unconfirmed` was treated as resolved,
which made it permanent, and a bridge that demonstrably succeeded on-chain was labelled unproven
forever (fixed 2026-08-01 by making it re-checkable). Writing `burn_abandoned` would repeat it
exactly. A derived band is correct as of now, needs no migration, adds no writer, no cron, no lease
and no consistency seam — and stops being consulted the day a reconcile job backfills a real hash.
**The record is a fact; only its interpretation ages.**

⚠️ **AN UNDATEABLE RECORD IS `unresolved`, NOT `settling` — deliberately diverging from
`isPastDeadline`**, which returns false on an unparseable clock. The divergence IS the point: there
the predicate gates an **action** (re-trigger a settle), so an unknown must not escalate; here it
gates a **claim**, so an unknown must not read as fresh. A record nobody can date can never age out
on its own. Both directions are asserted, so nobody "fixes" them into agreement.

### ⭐ THE ESCALATION — excluded from recovery is not excluded from visibility

`isStranded` still returns false for a provisional record, correctly: no burn hash means nothing to
settle and nothing to ask IRIS. But that exclusion had been silently widened into *no visibility at
all* — a record could pass 24 h and **nothing anywhere would say so.**

`listAllStranded` now counts the bands **in the same scan pass** (no second listing) and the sweeper
logs the census — ⚠️ **before the `total === 0` early return, which is load-bearing.** A provisional
record is never stranded, so `stranded=0` is the NORMAL state of a store full of aged-out `tx-`
records; logging after that return would have made the one condition worth escalating the one
condition that prints "clean" and exits. ⭐ Same lesson the sweeper itself was built on — recovery
that needs a human to happen to look — applied to the sweeper's own log line.

⚠️ **A degraded scan reports `provisional: null`, never zeros.** An unreadable store answering
"nobody needs help" is the absence-reads-as-safe shape, and zero must only ever mean *we looked*.
⚠️ **The sweep still owns no writes** — a census is a count, not a state machine. The reconcile job
remains unbuilt and is not faked with a trigger that would chase a mint for a burn that may not exist.

### PROOF

`verify-bridge-receipts` **111/0** (22 new, up from 89), fee-band 111/0, quote 72/0, tsc + build clean.
⭐ **MUTATION-TESTED — six mutations, all red, restore green:** delete the 24h branch (→ 5 red, incl.
the pinned *"a 30-DAY-old record is not still settling"*), drop the census, return zeros instead of
null on degraded, let an undateable record fall through to `settling`, move the census after the clean
return, and revert the panel to the single unconditional "yet" row (→ 4 red).

⚠️ **COVERAGE BOUNDARY STATED, NOT IMPLIED.** The predicate, the census, the degraded path and the
READER's projection are driven for real against the real store and the real key layout. **The panel
copy is SOURCE-pinned only** — this suite has no React renderer, so those four checks prove the
branches exist and that the unconditional "yet" is gone; they do not prove what a browser paints.
`assert-on-rendered-output-not-source-regex` remains unmet there and is named in the suite rather
than glossed. ⭐ It also demonstrated itself: the fallback-branch check FAILED first because JSX had
wrapped *"could not be / determined"* across two lines — text that exists on screen and not in the
source as one string. Left visible, with the reason, inside the check whose own comment admits it
cannot render.

### STATE

* ⛔ **UNDEPLOYED — prod serves `412e8d0`'s surface.** Ship with `npm run deploy:prod` (foreground,
  budget ~30 min); `gate:deployed` now runs automatically at the end and will confirm or refuse.
* 🚧 Still unbuilt, and now clearly named in code rather than implied: **the reconcile job** that asks
  Circle what became of a `txId` and backfills a landed burn. The cap makes its absence loud instead
  of silent; it does not replace it.
* 🚧 OPEN, untouched: the Polygon record's own unbounded `isRecheckable` / missing sweeper age cap.
  Its own item — the same shape as this one, on the retry side rather than the inert side.

## 2026-08-14 (later) — ✅ `412e8d0` IS LIVE. 🚨 AND THE REASON IT WAS NOT IS A FAILURE CLASS WITH NO SYMPTOM: five deploys were created and never finished, and every one read as a success.

**The previous session built `412e8d0`, tested it 89/0 + 111/0 + 72/0, committed it, issued the deploy
instruction and closed. It never shipped.** Production served `f8e18e7` for the next six hours, so the
202 provisional record was absent from prod the entire time — confirmed at the data layer, not inferred:
`blobs:list bridge-receipts` returned 24 keys and **zero** with the `tx-` prefix.

### 🚨 THE FINDING — a `new` deploy record is indistinguishable from a shipped one

`app.tikpema.xyz` served commit `f8e18e7`, deploy `6a7e46c0c5a0a131d2a1d9ca`, stamped 2026-08-13T22:35Z.
The working tree's build stamp said `412e8d0`, clean, generated 2026-08-14T13:40:17Z — so `npm run build`
HAD run. The publish is what died:

| deploy | state | context | created |
|---|---|---|---|
| `6a7f1abe639d3c2d0e78aedf` | **new** | production | 2026-08-14T13:40:14Z ← `412e8d0` |
| `6a7ee3dbd437680889f43855` | **new** | production | 2026-08-14T09:46:03Z |
| `6a7ee1a41cdeffd1fc5cf58e` | **new** | production | 2026-08-14T09:36:36Z |
| `6a7e46c0c5a0a131d2a1d9ca` | ready | production | 2026-08-13T22:35:44Z ← actually serving |

⭐⭐ **THE RECORD CARRIES NO SYMPTOM.** `error_message: null`. Nothing red anywhere. `updated_at ==
created_at` and `required_functions: null` — the CLI created the deploy and never reached the
function-digest step. Five accumulated across one day; the only thing that surfaced any of them was a
human asking a fresh session *"did it actually ship?"*

### ⚠️ CORRECTION — the first attribution was WRONG, and the foreground deploy disproved it

The initial read was *"a backgrounded deploy whose session ended underneath it."* Then this session ran
`npm run deploy:prod` in the FOREGROUND and watched it sit at `new` while `netlify deploy` burned 150%
CPU alongside an esbuild service. It finished, and reported why: **`Functions bundling completed in
25m 5.4s`**, 28m 41.6s total. The deploy is not dying instantly — it is bundling 102 functions, and the
record legitimately reads `new` for that entire window. Anything that kills the CLI inside it — a closed
session, a reaped background job, a 600s tool timeout — orphans the deploy in exactly this state.
⭐ **The cause is not carelessness about backgrounding; it is that this deploy takes far longer than the
window it kept being given.** A 10-minute patience budget cannot ship a 25-minute bundle.

### ⭐ THE MISSING GUARD WAS POST-DEPLOY. `gate:watch` runs before; nothing ran after.

`deploy:prod` was `gate:watch && build && netlify deploy --prod` — every link runs BEFORE the artifact
leaves the machine. New: **`scripts/verify-deployed.mjs`** (`npm run gate:deployed`), appended to
`deploy:prod` and runnable standalone. Five checks:

1. the LOCAL build is stamped — else there is no identity to compare against
2. the PUBLISHED deploy reached `ready` — every other state is named and failed
3. the SERVED tree == the local tree — `ready` proves *a* deploy landed, never *which*
4. the two instruments AGREE on the deploy id — Netlify's control plane vs the running function's own
   `x-nf-deploy-id`. A gap here is the signature of a pinned deploy (`nf_dpl`) — the open question from
   this morning's `no-store` entry, now permanently instrumented
5. NO ORPHANED production deploys

⚠️ **COMPARE ON `tree`, NOT `commit`** — `shared/build-stamp.mjs` is explicit that the tree is the identity
and a dirty commit names only a starting point. ⚠️ **Every unknown is a FAILURE** — unreachable probe,
absent field, unreadable deploy list. This file exists because an absence was read as a success.

⚠️ **THE COVERAGE BOUNDARY, STATED RATHER THAN IMPLIED.** Checks 1–4 chain on `&&`, so they run only if the
CLI EXITS — and the five failures did not exit, they were killed. A killed shell takes its own later
commands with it; nothing inside a process tree survives its own death. **So checks 1–4 would NOT have
caught the five.** They cover a different class: *the CLI returned success and production still serves
something else.* ⭐ **Check 5 is what closes the killed case**, because an orphan is DURABLE — run
standalone at the top of any session it finds deploys abandoned days earlier. ⚠️ It scopes to orphans
NEWER than the published deploy: once a good deploy lands, earlier attempts stop being "a change you
believe shipped" and check 3 answers that directly. So the scan narrows to zero after a successful
publish — correct for *"did I lose MY deploy"*, and not a claim the old records vanished.

⭐ **CALIBRATED BEFORE IT WAS TRUSTED.** Run while prod provably served the OLD build, it FAILED and named
`local tree 5dd4439eb404 / production serves 1c1f6e7076bd`. Check 5 listed exactly the three orphans above
while correctly excluding the then-in-flight deploy as in flight. ⭐ That run also found a real bug in the
gate itself: `listSiteDeploys` blew `execFileSync`'s 1MB default with `ENOBUFS`. The fail-closed design
reported it as **FAILED** rather than "no orphans found" — the correct shape — but check 5 would have been
useless on every run. Fixed with an explicit `maxBuffer`. *A probe that has only ever returned ok is
uncalibrated*, and this one was made to return not-ok first.

**VERIFIED GREEN on the real deploy:** all five pass against `6a7f6b98151f1e3cff8cd0cc`, published
2026-08-14T19:53:53Z, serving tree `5dd4439eb404` / commit `412e8d0e0382`, both instruments agreeing.

### ⚠️ PROGRESS.md WAS ACTIVELY MISDESCRIBING THE STATE

The top section still read *"⭐ ONE CHANGE CLOSES IT — the provisional 202 record — and it is now a code
task with a known shape"*, i.e. **unwritten**, when `412e8d0` was written, tested and merely unshipped.
⭐⭐ **A session trusting PROGRESS.md would have rebuilt it; one trusting `git log` would have assumed it
was live. Both wrong, in opposite directions.** The clause is now marked SUPERSEDED **in place** rather
than rewritten — it is the exact sentence a later session would have believed, and deleting it hides the
failure mode.

### 🚨 WHAT `412e8d0` DOES NOT DO — the provisional record is INERT FOREVER

Audited on the way in, because the fear was that `tx-<txId>` would inherit the unbounded retry the Polygon
record demonstrates. **It does not — the opposite, and worse in one way.** Every consumer in the tree:

| site | role |
|---|---|
| `agent-bridge.mjs:92` | writes it |
| `agent-execute-plan.mjs:281` | writes it |
| `_bridge-receipts.mjs:272` | `isStranded` → `false`, by name |
| `BridgePanel.tsx:346` | renders it |

That is the complete list. No sweeper, no cron, no settler, no reconcile job. `burn_submitted` is in
**neither** `TERMINAL_STATES` nor `RESOLVED_STATES`, so no existing state machine can move it, and the
reconcile job that would is explicitly unbuilt. The record is **write-only and immortal**: no age cap, no
escalation, no path to a terminal state.

⭐ **AND THE SAME COMMIT'S SORT FIX FLOATS IT TO THE TOP.** `listByOwner` now sorts on `burnedAt ||
submittedAt` — correct, and it means a provisional record renders FIRST, permanently. *"The Arc burn has
not been confirmed yet"* is displayed most prominently exactly when it has aged into meaning least.
🚧 **CAPPING IT IS THE NEXT TASK** — deliberately not folded into this deploy.

### 🚧 STILL OPEN — the Polygon record, unchanged and its own item

`o/0xfd801d08…/0xccc02035…` — 1 USDC to Polygon Amoy, burned 2026-08-02, still `mint_unconfirmed`
**twelve days later** with `lastVerifyFailure: "rpc_error"`. Read live this session:
`lastCheckedAt: 2026-08-14T19:10:24Z` — re-checked minutes before the read, and due again every 10.

Mechanism, confirmed in code: `isRecheckable` gates only on state plus a 5-minute floor and has **no upper
bound**; `bridge-mint-sweep` runs `*/10` with `MAX_PER_TICK` as its only cap and **no age logic at all**.
⭐ Contrast `job-sweep.mjs`, written from the same template, which does carry *"AGE CAP (> 1h → marked
failed, not nudged forever)"* — the clause was simply never carried across. `mint_unconfirmed` being
re-checkable is the CORRECT 2026-08-01 fix (a mint can land after we stop waiting); it just has no floor.
**"Re-checkable" was never bounded to "re-checkable for a while."**

⚠️ **Any alert keyed on `stranded > 0` is permanently noisy from this one record.** On the observed
`stranded=1`/`stranded=0` flap: `settledAt == lastCheckedAt` exactly, so the settler is taking its
`!isRecheckable` early return rather than polling — consistent with the sweeper's eventually-consistent
list and the settler's own read disagreeing across the 5-minute boundary. ⚠️ Measured from the record and
the code, NOT from the log stream — strong, not confirmed.

⚠️ Independently: `rpc_error` for twelve straight days is its own signal. This is not a mint we are waiting
on, it is a chain we cannot read — and nothing in the record distinguishes those two.

### STATE

* ✅ **`412e8d0` LIVE** — deploy `6a7f6b98151f1e3cff8cd0cc`, verified green on all five checks.
* ✅ `gate:deployed` wired into `deploy:prod`, calibrated against a known-bad state before being trusted.
* ⚠️ **DEPLOY DISCIPLINE CHANGED: run `deploy:prod` in the FOREGROUND and budget ~30 minutes.** The old
  note "run it backgrounded" is what produced five orphans; backgrounding is safe only if nothing reaps
  the process, and something always did.
* 🚧 **NEXT: cap the provisional record** — terminal state + age cap + what the panel says once it ages out.
* 🚧 OPEN: the Polygon record — age cap / escalation / terminal state. Its own item, not folded in.

## 2026-08-14 — 🚨 A `no-store` QUOTE WAS SERVED FROM THE CDN. `4c6af65`'s verification arrived sideways and FAILED — and the ack-gate proof could not start because of it.

**Set out to fire the acknowledge band live (`ackAcceptedAt` is null on all 15 receipts). Spent the
session unable to obtain a server-priced quote at all.** Nothing was spent; wallet unchanged at
15.635654 USDC; 15 receipts; 2 quote records.

### 🚨🚨 THIS ENTRY IS PROVISIONAL — the "platform ignored `no-store`" reading may be WRONG

**Added 08:26Z, after a paired probe.** A 401 fired from the browser and an identical 401 fired from
the CLI **1 minute apart, same URL, same method**: only the CLI's appears in the published deploy's
log stream (2 invocations in the window, both mine). ⭐ **So that tab's requests are served by
something the published deploy's logs cannot see** — most likely a PINNED DEPLOY (`nf_dpl`).

⚠️ **IF THE SERVING DEPLOY PREDATES `4c6af65`, ITS RESPONSES NEVER CARRIED `no-store` AT ALL** — and
the Durable Cache storing them is CORRECT behaviour, not a platform defect. The observations below
(a `hit`, no invocation, no quote record) all stand; **their ATTRIBUTION does not.** Do not cite this
as "Netlify ignores `no-store`" until the serving deploy id is known and compared against
`6a7e46c0c5a0a131d2a1d9ca`. The same shape as every other error in this document: two true facts
joined by an inference.

### THE FINDING — the directive is correct on the wire, and pre-existing entries are served anyway

A `POST /api/agent-act` from a fresh tab, live session, correct owner returned **200 in 1.8 s with
`cache-status: "Netlify Durable"; hit`**. No function ran. No quote record was written. The card
rendered from bytes stored before `4c6af65` shipped `no-store`.

| checked | result |
|---|---|
| `4c6af65` deployed? | ✅ ancestor of the live commit `f8e18e7` |
| does `agent-act` use the shared helper? | ✅ imports `json` from `_arc.mjs`, all 42 exits |
| is `no-store` on the wire? | ✅ `cache-control: no-store,…` + `cdn-cache-control: no-store`, measured live |
| competing rule in the repo? | ✅ none — **no `[[headers]]` blocks at all**, plain `status = 200` rewrite |

⭐ **THE FIX WAS PARTIAL IN A WAY NOBODY WOULD PREDICT FROM READING IT.** `4c6af65` stops NEW
responses being stored. It cannot evict what was stored BEFORE it, and `netlify-vary: body` keys the
cache on the request body — so **re-typing a phrasing used before the fix re-serves the pre-fix
entry, indefinitely.** A unique body bypasses (measured: `fwd=bypass` on a novel body, `hit` on a
familiar one). The fix's own "two-press verification outstanding" line should be replaced with this.

### 🚨 THE CONSENT CONSEQUENCE — the first mechanism that could write a FALSE `ackAcceptedAt`

The `ackToken` binds to `owner|destination|amount|band` and deliberately **not** to the fee, so it
survives fee drift. That is exactly what makes it survive being served from a cache. A card cached on
2026-08-01 carries a token that **still verifies today**: tick it, confirm, and `_actions` recomputes,
matches, executes, and writes a real `ackAcceptedAt` for a disclosure priced weeks ago and never shown
live. ⚠️ The band-binding that makes the token robust to volatility is what makes it replayable.

⚠️ **AND IT REOPENS `a7ca274` SELECTIVELY.** A cached response means no function ran, so no quote
record exists — the runs that get cached are precisely the runs with no provenance. "What was
proposed" is unrecoverable for exactly the cards most likely to be stale.

⚠️ **RETRO-SUSPICION, NOT A FINDING:** the 2026-08-01 "a rendered plan outlives its session" item may
always have been this, one layer lower. Testable; not tested.

### ⭐⭐ `Age` IS NOT THE DETECTOR — `cache-status` IS

A probe with a novel body, a proven MISS that definitely ran the function, returned **`age: 2`**
(slow cold-start origin; `age` counts from generation, not from cache insertion). Reading a non-zero
`Age` as "served from cache" would have convicted the platform of ignoring `no-store` on a request it
honoured. **Checking `cache-status` before trusting a quote card is now permanent.**

### ⚠️ THREE INSTRUMENT FAILURES OF MY OWN, ALL THE SAME FAMILY

1. **A `grep -v` of the cron noise, then reading the tail as complete** — the filtered-read trap,
   run by the person who wrote the rule down.
2. **`netlify logs --since 6m` CLIPPED a known-present line** (my own probe, 21 s inside the window);
   the same query at `15m` shows it. ⭐ **Short windows are unreliable — use ≥15m and always carry a
   known-present control.**
3. **The `x-nf-request-id` join is IMPOSSIBLE** against `netlify logs --source functions`: the format
   carries no ids at all (0 ULIDs in any window), and the field where one would sit reads `undefined`.
   ⭐ Proven by POSITIVE CONTROL — a request I knew was logged failed the join — rather than asserted.

### ⭐ ackAcceptedAt IS EVIDENCE OF ACCEPTANCE ONLY TRANSITIVELY (recorded before the run, unrelated to the cache)

The field is derived from the **band** at execution (`acknowledged = bandInfo.band === "acknowledge"`),
never from the token. What makes it mean "the user accepted" is that a **refusal** made that line
unreachable without a matching token — `_actions` ~25 lines above, and on the plan path
`agent-execute-plan`'s pre-flight, **in a different module**. Weaken either and the field keeps being
written, keeps reading as consent, and stops witnessing any; no test of the record module would fail.
Comment at `_bridge-record.mjs:103`, pinned in `verify-bridge-fee-band.mjs` §9 as **ordering**
assertions (presence was already covered and is not the property). 93/0, mutation-tested: bypassing
the executor refusal → 3 red, removing the plan refusal → 2 red, deleting the comment → 1 red.

### 🚨 THE AFTERNOON: A BROWSER THAT REPORTS SUCCESS, AND THREE SYSTEMS THAT SEE NOTHING

After the purge, a second route was tried — **the Bridge page (`BridgePanel` → `/api/agent-bridge`),
which needs no `agent-act`, no plan and no quote record.** Press 1 (no ack) returned the refusal and
the disclosure box rendered: ⭐ **the acknowledge band DID fire against a live server.** Press 2
(ticked) reported `cache-status: miss`, **6.2 s**, and a `burnHash`.

**Nothing happened.** Verified against three independent systems:

| instrument | reading |
|---|---|
| Arc — SCA USDC balance | `15.635654 → 15.635654`, **delta 0** |
| Arc — USDC `Transfer` logs, ±25 min | **0 in, 0 out** |
| Arc — EntryPoint `UserOperationEvent`, sender = our SCA, ~34 min | **0** — while 10 OTHER senders fired 60+ in the same window (instrument validated) |
| `bridge-receipts` | 15 (ours) / 22 (all owners), unchanged 8+ min later |

⭐ **THE REVERT HYPOTHESIS IS RULED OUT, BY THE READ THAT WOULD HAVE CONFIRMED IT.** A reverted inner
call still emits `UserOperationEvent{success:false}`. Zero events means nothing was ever included.
(It was the best explanation available — real hash, real 6.2 s, unmoved balance — and it was right to
chase.)

### ✅ RESOLVED — IT WAS A **202 `TxPendingError`**. THE BRIDGE IS STUCK, NOT FAILED.

**The question nobody asked for two hours was the STATUS CODE.** It was **202**, and the identifier
was a **UUID, not a hash** — `agent-bridge.mjs:87`, the `TxPendingError` path. Everything reconciles
with nothing left over:

| observation | cause |
|---|---|
| 6.2 s of real work | the gate ran, the token verified, the userOp was **submitted** |
| a UUID | Circle's `txId`, not a burn hash |
| **no receipt** | **BY DESIGN** — `recordBridge` runs only on the 200 path (`_bridge-record.mjs:81`) |
| nothing on chain | the userOp never mined — 0 userOps, balance unchanged **50 min later** |
| request arrived | independently certified by Test A below |

⭐ **This is the Circle unstaked-nonce trap already in this project's memory** (userOps stick in SENT
on Arc). Not new, not a code defect here — but its consequences below are.

⚠️⚠️ **A FABRICATED UI DEFECT, MANUFACTURED BY BOTH OF US IN TWO STEPS. THE UI WAS HONEST.**
`BridgePanel:145` has a dedicated branch — `pendingBurn = run && !error && !run.burnHash` — rendering
*"Bridge submitted — the Arc burn is still confirming. Check back shortly."* It never claimed success.

1. **The assistant inferred it**: from the operator's shorthand ("burnHash 0x…") it claimed the panel
   "rendered a txId where a burnHash belongs", **without reading the branch**.
2. ⭐ **The operator then amplified it**: restating that inference as an established defect rather
   than as *the assistant's reading of the operator's own question* — so a guess acquired a second
   apparent source and started to look corroborated.

⭐⭐ **THIS IS THE HOUSE FAILURE MODE WITH TWO PARTICIPANTS INSTEAD OF ONE.** Every other instance in
this document is one party joining two facts by inference; here the inference was laundered into
evidence by being repeated back. **A claim does not gain support by being restated by the person it
came from.** Recorded because it is the exact thing this document exists to catch, and it nearly
survived — the entry was drafted before anyone read `BridgePanel:145`.

### ⭐ PARTIAL SUCCESS — THE GATE IS PROVEN TO **RUN**. WHAT FAILS IS THE **EVIDENCE LAYER**.

🚨 **"The acknowledge band has never fired live" IS NO LONGER TRUE, and the replacement sentence is
materially different.** On 2026-08-14, on the single-action surface, ALL of this executed against a
running server for the first time:

* the band was computed live from a real fee (53.2%) → `acknowledge`
* the server **REFUSED** and returned a disclosure with a token it minted
* the disclosure **RENDERED** (box, copy, disabled button)
* the returned token was **recomputed server-side and MATCHED**
* execution **proceeded only because of that match**, and a userOp was submitted

⭐ The consent mechanism is proven end-to-end **up to the point where money moves**. What is unproven
is the DURABLE EVIDENCE: `ackAcceptedAt` has still never been written, because the transaction went
pending and the receipt write lives on the success path only.

### 🚨 THE DEFECT — CONSENT EVIDENCE IS LOST EXACTLY WHEN A TRANSACTION GOES PENDING

The user acknowledged a 53% fee; `_actions` recomputed the token, matched it, passed the band gate
and submitted. **The gate ran end-to-end.** But the response was 202, so **no receipt was written** —
`ackBand`, `feeRatio` and `ackAcceptedAt` exist nowhere.

⭐⭐ **"Who accepted losing 53%, and when" is unrecorded for PRECISELY the case that most needs
following up: a money movement that is stuck.** The receipt write is gated on the success path, so
consent evidence survives only when nothing went wrong. Same absence-fills-the-slot family as the
rest of this document; **first ever exercised 2026-08-14**, because the acknowledge band had never
fired live before.

🚧 **LIVE LOOSE END — WATCH IT.** If that userOp ever lands, 0.1 USDC bridges with **no receipt, no
settler trigger, and invisible to the sweeper** — an unrecorded bridge, the same class as
"plan bridges left NO record at all". The Circle txId (the UUID from that 202) needs checking for a
terminal state, and a landed burn needs its receipt backfilled.

### ⭐⭐ THE FIX IS ONE CHANGE THAT CLOSES BOTH GAPS — a PROVISIONAL record on the 202 path

**Write a receipt keyed on the `txId` when the 202 fires**, carrying the consent fields
(`ackBand`/`feeRatio`/`ackAcceptedAt`) and a state meaning *submitted, burn unconfirmed*. That single
write yields **both** missing things: the consent evidence, and a **recovery hook the sweeper can
act on** — a key to reconcile against Circle and to backfill the burn hash if it lands.

🚨 **THE PREMISE IT RESTORES.** This receipt system exists so that an unattended bridge is
recoverable. Today **the ONE outcome that cannot be recovered is the one where nobody knows what
happened** — success is recorded, refusal is recorded, and *pending* — the only state that actually
needs following up — writes nothing at all. That is backwards.

⚠️ Design notes for whoever builds it: the key must be the `txId` (there is no burn hash yet — the
`_bridge-record.mjs:81` no-op exists precisely because the current key is the hash); the state must
be distinguishable from `burn_confirmed` so the settler does not chase a mint for a burn that may
never exist; and the write must stay `neverThrows`, because a diagnostics failure must not turn a
submitted transaction into an error.

⚠️ **A CIRCLE SCA'S ACTIVITY IS NOT VISIBLE UNDER "transactions from this address."** userOps arrive
via the EntryPoint, so `from` is a bundler. The decisive reads are **ERC-20 `Transfer` logs** and
**`UserOperationEvent` filtered on `sender`**. Reading an empty address page as "nothing was
submitted" would have manufactured the alarming branch out of normal SCA behaviour.

### 🚨 THE UNRESOLVED FINDING — THIS TAB'S INVOCATIONS ARE INVISIBLE TO `netlify logs`

Established by paired probes, same endpoint, same window, seconds apart:

```
08:30:48  blobs-probe   scheduled tick        ← visible
~08:31    blobs-probe   FROM THE BROWSER      ← ABSENT
08:33:49  blobs-probe   from my curl          ← visible
08:33:50  blobs-probe   from my curl          ← visible
```

The browser's fetch **executed** — it returned a live-computed `verdict D` with
`build.commit f8e18e72…` / `deploy 6a7e46c0…`, i.e. the SAME build I was watching, on an endpoint I
measured as never cached (`fwd=bypass`, `cache-control: no-store`). Same for three `agent-act`
probes: mine logged, the browser's never.

⭐⭐ **PROVEN THE STRONG WAY BY TEST A (below): a request CERTIFIED to have executed does not appear
in the log.** The browser POSTed a never-before-sent amount to `/api/ub-withdraw` and got back
`400 availableUsdc: 1.51` — a value read live off the Gateway contract, **predicted from chain BEFORE
the test**. The 08:50:09→09:04:13 window is populated (2 sweeper ticks) and contains **no
`ub-withdraw` invocation**. That is a positive control, not an argument from absence.

⚠️ **BUT IT IS NOT UNIFORM, AND THE CLAIM MUST NOT BE OVERSTATED:** at `07:17:09–07:17:21` the same
browser's `auth-challenge` / `auth-verify` / `my-wallet` / `gateway-balance` **did** appear. Something
separates the visible from the invisible and it is NOT "browser vs CLI". **Mechanism unknown.**

🚨 **THE CONSEQUENCE IS BROADER THAN THIS SESSION.** `netlify logs` is the instrument this repo has
used to answer "was this endpoint ever called?" — including the 2026-08-02 phantom-run diagnosis.
**A partial instrument was read as a complete one.** Every conclusion of the form "no log ⇒ it never
ran" is now suspect and needs re-deriving from stores or chain.

**FIVE HYPOTHESES DIED TODAY, EACH KILLED BY A READ RATHER THAN AN ARGUMENT:** deploy pin (no
`nf_dpl`), service worker (none registered), proxy/VPN/DNS (`Remote Address` identical to mine,
`63.176.8.218`), `no-store` violation (attribution retracted above), reverted tx (no
`UserOperationEvent`). ⭐ The OBSERVATIONS have held up throughout; only the MECHANISMS were wrong.

### ⭐⭐ IT IS NEW, NOT CONSTANT — AND THAT BOUNDS THE SEARCH TO ~48 HOURS

**On 2026-08-12 the SAME browser initiated the UB withdrawal and it verified on Arc**: `txHash
0x79d06776…`, receipt `success`, block `56671240`, Gateway log emitted — plus three independent
server-side reads corroborating the 409 guard test the same day. So this browser was producing
chain-verifiable, server-visible effects **within the last 48 hours** and is not now.

⭐ **THAT ARGUES FOR A CHANGE, NOT A LONGSTANDING DEFECT** — a browser update, a new/updated
extension, or a changed network path — and it bounds the window to 2026-08-12 → 2026-08-14. Search
there first; a defect that has "always been there" would have broken the UB withdrawal too.

### ✅ THE AUDIT LIST — WRITTEN 2026-08-14, derived from the document rather than from memory

⭐⭐ **THE DISCRIMINATOR IS NOT "browser vs CLI". IT IS POSITIVE ARTIFACT vs NEGATIVE CORROBORATION.**
A browser-reported result is trustworthy when the server left something **only it could have
created** — a tx, a record with server-set fields, a Circle-side object. It is NOT rescued by
corroboration that consists of *nothing changed*, because **"the guard refused" and "the request
never arrived" produce identical negative evidence.** That equivalence is what today's anomaly
creates, and it is the whole audit.

**✅ STANDS — a positive artifact exists, immune to how the browser reported it**

| proof | the artifact |
|---|---|
| UB withdrawal, 2026-08-12 | tx `0x79d06776…`, block 56671240, Gateway log, balance delta exactly `1000000`, record carrying `initiateTxHash`. ⭐ **also the positive control that dates the anomaly** |
| DCA create end-to-end, 2026-08-13 | mandate `0d9f0e14` `status:active`, read back through **`dca-list` — a different runtime**, not the writing path |
| Overdue-alert calibration, 2026-08-12 | `overdueAlerted:true` + `lastAlertedAt` written by the SWEEPER (cron, no browser), message human-confirmed in the money channel |
| strong-read-watch stale→recovered, 2026-08-12 | cron-written records, both Discord messages human-confirmed, `calibration` marker attributing authorship |
| both DD purchases · code-hash binding | chain + store, pre-window |

**✅ STANDS — verified from the CLI/suite side, which is demonstrably visible**

Content negotiation + `/api/dd-openapi` (2026-08-13, my curl + smoke 21/21); provisioning-503 across
13 endpoints (offline allowlist guard); health-key hash predictions (store reads). ⭐ My own requests
were proven this session to reach the origin AND appear in the log — three paired probes — so
CLI-side verification is the one channel with a positive control behind it.

**⚠️ WEAKENED — the corroboration is entirely NEGATIVE, so it cannot exclude non-arrival**

* ✅ **UPGRADED — RE-DERIVED 2026-08-14 AND NOW STANDS.** "THE 409 IS PROVEN LIVE" and "THE 409
  SURVIVED THE PREDICATE REWRITE — proven live TWICE" (2026-08-13). Their only real weakness was that
  **non-arrival** could not be excluded: every corroborating check (record count 1, `updatedAt`
  frozen at `20:49:12.640Z`, chain `1510000` unchanged, sweeper `open:1`) establishes only that
  *nothing was written* — which non-arrival also produces.
  ⭐ **TEST A CLOSED THAT LEG POSITIVELY.** A never-before-sent `amountUsdc: 9.876543` POSTed from the
  same browser to the same endpoint returned **`400` with `availableUsdc: 1.51`** — the Gateway
  contract's live `availableBalance`, **predicted from chain before the test**. A value the browser
  cannot hold, computed fresh, for a body no cache can have seen. **Arrival is demonstrated; the
  competing hypothesis is gone.** Store unchanged afterwards (`heartbeat` + one record,
  `updatedAt` still `2026-08-12T20:49:12.640Z`) — a refusal 60 lines above `createRecord` touched
  nothing, as designed.
  ⭐ **THE METHOD IS THE REUSABLE PART:** to prove a REFUSAL live, do not look for what it didn't
  write. Send an input whose refusal must echo **server-held state you predicted independently**.

**🚧 NEEDS RE-DERIVING — browser-reported and nothing else**

* 🚧 "**DCA read path proven signed-in — 200 from the browser, not inferred**" (`25580bd`,
  2026-08-13). Partly rescued by the create above (the path demonstrably works), but the specific
  signed-in-200 claim has no artifact.
* 🚧 "**Known-value render — `1.000000 USDC — waiting`**" (2026-08-13). A screen observation. Low
  stakes, listed because it is the class, not because it is dangerous.

**🚧 SEPARATE AND OLDER — the `netlify logs` absence family (start date UNKNOWN, so not bounded to 48h)**

* 🚨 **2026-08-02 "PHANTOM RUNS" MAY HAVE BEEN THIS ANOMALY, NOT OPERATOR ERROR.** That entry
  concluded *"the connect happened in the NEW tab and the confirm was pressed in an OLD one"* from
  `Zero server traffic` — no `agent-act`, no `agent-execute-plan`, `agent-quotes` empty. **Today
  produced exactly that signature from a tab we watched do the opposite.** ⭐ A diagnosis that
  attributed the failure to the person at the keyboard now has a competing mechanism that does not.
  Do not cite it as settled.
* ✅ **`4f2a1c8e` "DOES NOT EXIST" SURVIVES** — its check #4 was log-absence, but checks #1-3 and #5
  (the route did not exist yet) plus the chain balance are independent and decisive. ⭐ **A worked
  example of why five checks beat one:** the audit removes one leg and the conclusion still stands.
* 🚧 The standing rule *"an empty log window is not proof of absence"* is **reinforced and now has a
  mechanism** — it was written as a timing caution; it is also a completeness one.

### ⚠️ CORRECTION MADE IN-FLIGHT — two different consent surfaces, and I conflated them

"Rows 5 and 6 cleared" was **WRONG**. Those rows were about the **plan card's per-step box**
(`d64bb7f`). What fired was **`BridgePanel`'s single-action disclosure** (`bdb7446`) — different
component, different endpoint, different code path. The single-action band is now known to fire live;
**the plan path's per-step consent remains completely untested**, as does the ⭐ discriminator
(`ackAcceptedAt` on the 0.1 receipt ONLY).

### STATE / NEXT

* ⭐ **THE GATE IS PROVEN TO RUN; THE EVIDENCE LAYER IS NOT.** Band computed live, refusal issued,
  disclosure rendered, token recomputed and matched, execution gated on that match — all first-ever,
  on the single-action surface. 🚧 **`ackAcceptedAt` still never written** (null on all 15 receipts),
  because the tx went 202-pending and the receipt write is on the success path only.
  ⭐ **ONE CHANGE CLOSES IT** — the provisional 202 record above — and it is now a code task with a
  known shape rather than a live-run task blocked on a browser.
  🛑 **SUPERSEDED — DO NOT READ THE CLAUSE ABOVE AS OPEN WORK.** That change was WRITTEN, TESTED AND
  COMMITTED as `412e8d0` later the same day; it then sat unshipped for six hours because the deploy
  never landed. See the `412e8d0` entry at the top of this file. This paragraph is left in place
  rather than rewritten because it is the exact sentence a later session would have believed.
  Fee measured repeatedly and stable all day: Base 1.0 → 5.32%
  `none`, 0.1 → 53.22% `acknowledge` (0.053216 / 0.053215). Bands unchanged (warn 0.10 / ack 0.25).
  Caps 25/10/60, day spend 0. Wallet **15.635654 USDC, untouched — nothing was spent today.**
* ✅ **CDN purge RUN AND VERIFIED** (site-wide, `202` at 08:20:48Z, confirmed by a cold `fwd=miss` on
  a path that had been cached). It changed the `hit` to a `miss` — and the run still did nothing.
* 🚨 **THE BLOCKING QUESTION IS NO LONGER THE GATE.** It is: *why does this browser report 200s,
  `cache-status: miss`, 6.2 s durations and a burnHash for operations that leave no trace in the
  function log, either blob store, or on Arc?* Until that is answered, **no browser-driven proof of
  anything on this site can be trusted** — which is a far larger finding than the one we set out for.
* ⭐ **NEXT SESSION SHOULD START HERE, NOT AT THE GATE.** Suggested first read: a money-path action
  from a DIFFERENT browser/profile, with the same three-instrument check (chain + store + log). That
  discriminates "this browser/tab" from "this site" in one run and costs nothing.
* ⭐ **Whether `a7ca274`'s record write works on a live server is STILL UNKNOWN** — every run that
  would have exercised it was served from cache. A third key in `agent-quotes` is a first, not a
  formality.

---

## 🔻 HANDOFF — UB EXIT. Written 2026-08-12 ~15:40Z, mid-deploy, before an UNSTARTED calibration.

⚠️ **START HERE for the unified-balance exit.** Written deliberately before the calibration below,
because that procedure ends in a cleanup step that a context-exhausted session would drop.

### STATE AT HANDOFF

| thing | value |
|---|---|
| HEAD / origin | in sync; working tree clean but for untracked `dd-service.DRAFT.json` |
| production | ✅ **`7f5d5de`** — published 15:50:39Z (deploy `6a7c91fcf9f1`). Alerting IS live. |
| `ub-withdrawals` store | ✅ **only `heartbeat`** — the calibration record was deleted and witnessed |
| chain (test SCA `0x3cb76ac6…`) | **2.000000 USDC available, 0 withdrawable** |
| sweeper | ✅ live on `*/30`, last tick `16:31:03` reporting `clean — scanned=0 open=0` |
| suites | `verify-ub-withdraw` 24/0 · `test:copy` 23/0 · `test:watch` 213/0 · `test:dd` green |

### ✅ RESOLVED — `4f2a1c8e-…` DOES NOT EXIST. NO CLOCK IS RUNNING.

A withdrawal with that id was believed to have been initiated. **It was not.** Five independent
checks, and the last is decisive on its own:

1. `ub-withdrawals` listed unfiltered → **empty**
2. grep for `4f2a1c8e` across all keys → **no match**
3. instrument validated — `blobs:list` shows `dd-watch`'s keys, so the empty listing is meaningful
4. `/api/ub-withdraw` invocations, all time → **exactly two**, both at 14:44:38/39Z, both my own
   unauthenticated 401 probes
5. ⭐ **THE ROUTE DID NOT EXIST UNTIL 14:43:45Z.** Any 202 from it before that is impossible — an
   unmatched path on this site returns SPA HTML.

Plus the chain: `availableBalance` is still **2 USDC**; an initiation would have left 1.
⚠️ **Same inference-recorded-as-observation shape as the ack anomaly.** Do not reopen this without
new evidence; re-deriving it cost a full round trip.

### ✅ THE CALIBRATION IS COMPLETE — the overdue-alert branch has EXECUTED, and the store is clean.

**Ran 2026-08-12 15:56Z → 16:31Z, deliberately SPLIT across sessions** so no session ended between
"record written" and "record deleted". Production was verified on `7f5d5de` first — a record swept by
the older build would have proved nothing.

| step | evidence |
|---|---|
| synthetic record written | `o/0x0000…dead/calibration-1786550171`, 24h past maturity vs a 6h grace |
| sweeper saw it | `16:01:02 scanned=1 open=1 waiting=1 failed=0` |
| ⭐⭐ **alert fired and DELIVERED** | `overdueAlerted:true`, `lastAlertedAt 16:01:04`, `lastError:null` |
| message visible in the money channel | ✅ **confirmed by a human** — `lastAlertedAt` only proves Discord returned 2xx |
| record deleted | `blobs:get` → "does not exist" |
| ⭐ **witness** | heartbeat `16:31:03 {"open":0,"totalKeys":0}` + `clean — scanned=0 open=0` |

⭐ **THE OVERDUE BRANCH IS NO LONGER SUITE-ONLY.** It has run against the real webhook, so its first
real firing will not be the day someone's money is genuinely stuck — the same first-success-branch
gap the DD alert path had, closed BEFORE it mattered rather than after.

⭐ **THE DISCRIMINATOR HELD UNDER REAL CONDITIONS:** the same tick reported `waiting=1 failed=0` AND
judged the record overdue. The alert came from TIME PAST MATURITY, not from a completion failure —
had those been coupled, `failed` would have been 1.

⭐ **THE HEARTBEAT EARNED ITSELF TWICE:** its first appearance proved the new build's sweeper was
live (it does not exist in `d71022c`), and its `open:0` proved the cleanup — the sweeper's OWN
account from a separate process, not the delete command repeating its own claim.

⚠️ **NOTHING IS OUTSTANDING FROM THIS PROCEDURE.** The store holds only `heartbeat`. If a
`calibration-*` key ever reappears, it is from a NEW run, not this one.

### (original procedure, for reference) — the calibration as designed

The overdue alert fires only when a record is past maturity **+ 6h grace**, which cannot occur
naturally for ≥7 days. So it is **suite-proven only**, and the first time it would ever run for real
is the day someone's money is genuinely stuck — the worst moment to discover a typo in the webhook
call. Same first-success-branch problem as the DD alert path, which needed a deliberate calibration.

**Preconditions:** production must be running `7f5d5de` or later (the alerting is NOT in `d71022c`).

**The synthetic record** — write directly into the `ub-withdrawals` store:

    key           o/0x000000000000000000000000000000000000dead/calibration-<epoch>
    owner         0x000000000000000000000000000000000000dEaD   ← burn address
    withdrawalId  calibration-<epoch>                          ← NOT a UUID, unmistakable
    amountUsdc    "0"
    state         "waiting"
    maturesApprox <now − 24h>                                  ← well past the 6h grace
    schema        "ub-withdrawal/1"

⭐ **WHY A SYNTHETIC OWNER IS LOAD-BEARING.** The sweeper calls `ubCompleteWithdrawal(owner)` on every
open record BEFORE the overdue check. With the burn address, `readExitState` returns zero withdrawable
⇒ `not-yet-matured` ⇒ **no chain write at all**. The real test SCA would also be safe *today* (its
withdrawable is 0) but only by luck of current state; this is safe **by construction**.

**Steps:** 1. confirm prod ≥ `7f5d5de` · 2. write the record · 3. wait ≤30 min for a tick ·
4. confirm `overdueAlerted: true` AND have a human eyeball the message ·
5. 🚨 **DELETE THE RECORD.**

🚨 **STEP 5 IS THE ONE THAT GETS DROPPED.** If the store contains any `calibration-*` key, the
cleanup did not happen — delete it. Leaving it pollutes the store and misleads the next reader.
⚠️ The alert goes to **`WATCH_ALERT_WEBHOOK`** (the MONEY channel, "Spidey Bot"), not the DD one, so
a test message lands in the channel that guards the kill switch. Deliberate — this is user funds —
but say so before anyone sees it.

### THE EXIT — what is built, and what is still inference

**Three hops:** `initiateWithdrawal` → ~1,209,600 BLOCKS (**≈7.1 days**, DERIVED at 0.5097 s/block;
`1209600 = 14 × 86400` is a COINCIDENCE) → `withdraw()` lands funds **in the SCA** → `agent-withdraw`
(pre-existing) returns them to the login wallet.

✅ **VERIFIED READ-ONLY:** Gateway impl unchanged (`0xa33d52b4…`, 22,818 bytes); `initiateWithdrawal`
simulated from our SCA **would succeed**; `execute()` drives it and **a random EOA is REFUSED** (the
load-bearing control — without it, "would succeed" could just mean simulation is permissive);
`getInstalledPlugins()` empty ⇒ no permission module. `readExitState` live-verified against chain.

🚧 **STILL INFERENCE — DO NOT PROMOTE:**
* ⚠️ **`eth_call` with `account:` sets the sender WITHOUT a signature.** It proves the CONTRACT would
  accept the call from that address. It does **NOT** prove Circle's signer produces a valid userOp.
  **That closes only by executing one.**
* 🚧 **The WRITE paths have never run with real funds** — `initiateWithdrawal` and `withdraw` both.
* 🚧 The sweeper has never completed a real withdrawal; every branch is injection-proven.
* ⚠️ **No cancel path found** (`cancelWithdrawal`/`abortWithdrawal`/`revokeWithdrawal` all absent) —
  so treat initiating as COMMITTING. **Absence is evidence about those NAMES only.**
* ⭐ **Initiate 1 USDC, not 2**: if the path is wrong you have committed half the balance to a week's
  wait and retain 1 to retry with.

### ⚠️ THE SWEEPER DECISION — recorded because it is a judgement, not a mechanism

**Hop 2 runs UNATTENDED, ~7 days after the request, with no human at the moment of movement.** This
is the first thing in this system that moves user funds with nobody present.

⭐ **IT WAS THE ONLY WAY TO GET OPTION (a) RATHER THAN (c).** "The user comes back in a week and
clicks" is a half-built exit wearing a nicer face: a clock started that nobody finishes while the
user believes they are leaving. On the bridge, "a user who never comes back" was the EDGE case; for a
WITHDRAWAL it is the ORDINARY one — someone asking for their money back is, by definition, leaving.

⭐⭐ **THE BOUNDS ARE LOAD-BEARING AND MUST NOT BE RELAXED.** The guarantee is **absence of
mechanism**: the sweeper can only call `withdraw(token)` for an owner who ALREADY initiated; it takes
**no amount** (the contract decides what matured); and `withdraw` pays **`msg.sender`** — the user's
own SCA. There is no code path in that function that can move money anywhere else. **Adding an
amount parameter or a destination would turn a bounded automation into an unbounded one.**

### ALERTING + `maturesApprox` — built `7f5d5de`, deployed only if that deploy landed

* Alerts when a record is **past maturity + 6h grace** and still open → **`WATCH_ALERT_WEBHOOK`**.
* ⭐ **The discriminator is TIME PAST MATURITY, never "completion failed."** A failed tick is normal
  (RPC blips, Circle 500s, and the contract refuses a premature withdraw); paging on it would fire
  every 30 min through a healthy week — the ack-gate failure.
* ⭐ **Unknown maturity ≠ expired**: no `maturesApprox` ⇒ never overdue, so a legacy record cannot page.
* ⭐ `maturesApprox` is **written at creation**, returned by the front door and quoted in the alert —
  "recompute it from `createdAt + delayBlocks`" is what nobody does a week later.
* Transition-only via `overdueAlerted` ON THE RECORD; the flag advances **only on confirmed
  delivery**, so an undelivered alert retries rather than being suppressed.

🚨 **THE STRUCTURAL GAP, UNRESOLVED:** the alert lives INSIDE the sweeper, so **a sweeper that never
runs cannot alert about itself** — the same silence this feature exists to break, one level up.
Mitigations only: `gate:watch` guards the schedule (**the highest-consequence row in
`GUARDED_SCHEDULES`** — a forgotten `dd-canary` makes DD refuse loudly; a forgotten
`ub-withdraw-sweep` makes withdrawals silently never complete), and the sweeper now writes a
**HEARTBEAT every tick including clean ones**, so its absence is detectable by something else.
⭐ **That heartbeat is a HOOK for an independent watcher, not a substitute for one.** Deciding
whether to build that watcher — or point `dd-watch`/`strong-read-watch` at the heartbeat — is the
last structural gap in this feature and is OPEN.

### ✅ 1 USDC WITHDRAWAL INITIATED 2026-08-12 20:49Z — the exit has been used, end to end.

```
owner          0x058957deff333c47c15c208a4425420af6947f9e   ⚠️ NOT 0x3cb76ac6… (see below)
withdrawalId   16be509f-b3fd-467e-8d2e-b68159b9ffe0
txHash         0x79d06776caeb5c33f90c33605b8bbe91e2c43cc775cdfb53cc0c2e57a3150899
amount         1000000 atomic (1.000000 USDC)
MATURES        2026-08-19T23:13:09.662Z   ← the date to come back for
```

**FOUR VERIFICATIONS, none trusting the endpoint's own claim:**

| # | check | result |
|---|---|---|
| 1 | **tx on Arc** (needs nothing from Netlify) | receipt `success`, block `56671240`; **the GATEWAY emitted `log[1]`**; callData carries `0xc8393ba9` + the Gateway + the SCA + `0xf4240` |
| 2 | **record, direct key read** | `state: waiting`, `initiateTxHash` identical to the chain hash, `amountAtomic 1000000`, `delayBlocks 1209600` |
| 3 | **balance** | `2510000 → 1510000` atomic — **delta exactly 1000000** |
| 4 | **sweeper** `21:00:48` | `scanned=1 open=1 waiting=1 failed=0`; heartbeat `open` 0 → **1** |

⚠️ `to` on the receipt is the **ERC-4337 EntryPoint** (`0x5ff137d4…`, selector `0x1fad948c` = `handleOps`),
NOT the Gateway. That is correct for a Circle SCA and it read as a red flag first time. The proof the
Gateway ran is that it **emitted a log**, not that it was the `to`.

### 🚨 WHAT THIS RUN COST, AND THE TWO RULES THAT CAME OUT OF IT

Roughly two hours were spent verifying withdrawals that had never started. Three separate causes,
each of which produced a "202" the operator reported in good faith:

1. **A provisioning 202** (`20:02:34`) — `ensureOwnerWallet` returns `202 {status:"provisioning"}`,
   which shares a code with `202 {status:"started"}`. **FIXED — see below.**
2. **A 401 read off the wrong console line** (`20:47:55`, 4.85 ms) — an expired session, 73 s before
   the real call.
3. **A deploy-preview session** — which also made the CLI's PRODUCTION-scoped logs void as evidence,
   and pointed the chain read at the WRONG SCA for an hour.

⭐⭐ **RULE 1 — RESPONSE DURATION IS A CHEAP AUTHENTICITY CHECK ON A CLAIMED ACTION.** A real
initiation must do a chain read, a blob write, a Circle execution and `waitForTx` polling. The
measurements are unambiguous:

```
  4.85 ms   401, expired session
244.24 ms   202 provisioning
3325.51 ms  ⭐ 202 STARTED — the only one that did any work
```

Anything claiming an on-chain action back in double-digit milliseconds did not perform one. This is
free, needs no ids, and would have collapsed every false round in seconds.

⭐⭐ **RULE 2 — PAIR IT WITH A RUN MARKER.** `RUN-<epoch>` printed on the same line as the status
binds a claim to ONE invocation. **The marker says WHICH call; the duration says whether it did any
work.** Every wasted round came from comparing a bare status code against artifacts with no way to
tell which call produced it.

⚠️ **AND: A PRODUCTION-SCOPED INSTRUMENT SAYS NOTHING ABOUT A PREVIEW.** `netlify logs` cannot scope
to a deploy preview. Reading them UNFILTERED does not help when the SCOPE is wrong — confirm the
origin (`location.origin`) before treating any prod-side read as evidence. Blobs, by contrast, are
SITE-scoped, so a preview write does land in the same store; that instrument survived.

### ✅ FIXED: the overloaded 202 on ub-withdraw

`202 {status:"provisioning"}` → **`503 {reason:"wallet-provisioning", retryable:true}`**, so the
STATUS CODE alone separates "nothing happened, retry freely" from "an irreversible ~7-day clock is
running". Same class as the balance-unreadable refusal, which already returns 503.
Guard: `scripts/verify-ub-withdraw-status-codes.mjs` 6/0, mutation-tested (restoring the 202 → 4 red).

🚧 **THE SAME COLLISION IS LIVE ON SIX MONEY PATHS AND IS WORSE THERE** — `agent-send:114`,
`agent-withdraw:152`, `agent-bridge:77`, `agent-act:541`, `job-bridge-approve:203`,
`agent-ub-deposit:163` all return 202 for provisioning AND for a transaction **IN FLIGHT**. A
mistaken retry there is a **DOUBLE SPEND**, not a double clock. NOT fixed: the front end branches on
the CODE in both directions (`useGatewayBalance.ts:51` and `useWallet.ts:313` read 202 as
provisioning; `approveProposal.ts:44` reads it as success), so this needs its own change and proof.

🚧 **`ensureOwnerWallet` WENT READY → PENDING** between the `19:59:46` GET (resolved an owner) and
the `20:02:34` POST (reported provisioning). Backwards, and both were cold starts. It failed safe
here, but the same helper gates every money endpoint above and may not fail as safely elsewhere.

🚧 **THERE IS STILL NO UI PATH.** `grep -rn "ub-withdraw" src/` returns NOTHING. The panel says
"Exit built · about seven days" to a user with no button. An exit reachable only from a devtools
console is not an exit for the person whose money it is — the original problem moved one layer down.

### ✅ THE EXIT HAS A UI — shipped `3b695e1`, live on `6a7d8e54` (published 2026-08-13 09:49:42Z)

Verified against a KNOWN VALUE rather than an empty state — the reason status shipped before the
button. The live withdrawal renders as **`1.000000 USDC — waiting — about seven days`**.

| # | check | result |
|---|---|---|
| 1a | money path, POST-publish tick `10:01:01` | `ok` / `steady-ok`; sweeper alive; **`open:1`** |
| 1b | DD health key | ✅ **UNMOVED — 6/6** |
| 1c | server smoke + bundle fingerprint | 8/8; all four new UI strings in the shipped JS |
| 2 | session owner | ✅ matches `0x058957de…` — the prerequisite, not a formality |
| 3 | known-value render | ✅ `1.000000 USDC waiting` |
| 4 | the 409 | ⚠️ **NEVER EXERCISED** — see below |

⭐ **1b WAS A PREDICTION, NOT AN OBSERVATION.** The local `ddTree` was read BEFORE deploying and
matched the live key, so "DD-clean deploy ⇒ key must not move" was falsifiable in advance; a second
64-hex key would have refuted the binding. ⚠️ What it does NOT prove: the deploy touched
`ub-withdraw.mjs` and frontend files, none of which are in the DD surface — so the honest reading is
"the hash correctly ignored changes OUTSIDE its surface", not "the hash ignores changes".

⚠️ **`open:1` ANSWERS THE DURABILITY QUESTION** raised when the sweeper was built: the record and its
monitoring survived a full production deploy.

⚠️ **I READ A PRE-PUBLISH RECORD FIRST.** The initial money-path reading was `producedAt 09:45:11`,
BEFORE the `09:49:42` publish — the old build. Caught by comparing against `published_at` rather
than trusting recency. That is now the fourth time in two days.

### 🚧 THE 409 IS AN UNEXERCISED SERVER GUARD — do not let the disabled button imply coverage

`POST /api/ub-withdraw` now refuses a second open withdrawal with **409** (`withdrawal-already-open`,
naming the existing id/amount/maturity, `retryable:false`), and refuses **503** when the list is
UNREADABLE rather than guessing. 11/0 offline, mutation-tested (remove guard → 4 red; unreadable
falls through → 1 red; treat `completed` as open → 2 red).

⚠️ **It has never run on prod.** The disabled button is SINGLE-TAB containment and is NOT evidence
about the guard — a refresh, a second tab or a direct call all bypass React state, which is exactly
why the server guard exists. Proving it needs a deliberate double-press. Same standing as
`still-failing-quiet` on the sweeper watcher: written, tested offline, unexercised live.

⭐ **WHY THE GUARD MATTERS MORE THAN "two clocks":** hop 2 is `withdraw(address)` — no amount, sweeps
everything matured in ONE tx. Two records maturing together are completed by a single transaction:
the sweeper marks one COMPLETED, the second reads `withdrawable:0` → `not-yet-matured` FOREVER, until
it trips the overdue alert as a stuck withdrawal that is not stuck.

### ✅ THE 409 IS PROVEN LIVE — and proving it exposed a LOCKOUT the guard itself created

A single POST while `16be509f` was `waiting` returned **409 naming `16be509f`** on production.
⭐ **No double-press was needed** — the first press happened the night before, so one request tested
the same thing at half the risk. Logic proven, not merely the fail-closed branch.

### 🚨 TWO CORRECT FEATURES COMPOSED INTO A DENIAL OF THE FEATURE

Preparing the test surfaced it, before it could bite:

1. **The validation and the conversion disagreed.** `amount > 0` passes for `0.0000001`, but
   `Math.round(amount * 1e6)` is **0**. So: `createRecord` wrote a record → `ubInitiateWithdrawal`
   threw on `units > 0n` BEFORE the chain call → the record was left `initiating`.
2. **The sweeper leaves an unconfirmable `initiating` record in that state FOREVER, on purpose**
   ("we cannot see it yet is not it did not happen"). And for `amountAtomic: "0"` its `landed`
   heuristic is `1510000n < 0n` — false forever, so it can never even reconcile.
3. **The 409 guard counted every `OPEN_STATE` as blocking.**

⭐⭐ Each is correct alone. Together, one malformed input would have blocked EVERY future withdrawal,
tripped the overdue alert, and never cleared — **no user-facing way out of the exit path**. The
original "a pocket with no exit" rebuilt by the guard meant to protect it.

**FIX 1 — validate the CONVERTED UNITS.** `units <= 0n` → 400 `amount-below-one-atomic-unit`,
BEFORE any record is written. ⭐ Two representations of one quantity must be validated as one;
checking the decimal and acting on the atomic value is duplicate-source-of-truth inside a function.

**FIX 2 — `blocksNewWithdrawal()`, separate from `OPEN_STATES`.** They answer different questions:
`OPEN_STATES` = "must the SWEEPER keep watching?" (deliberately generous — a record it drops is a
withdrawal nobody finishes). The guard = "could this be running a CLOCK?" (must be narrower — a
false yes denies the exit). Blocks on `waiting`/`completing` always; on `initiating` only when the
chain call *could* have happened:
  · `amountAtomic` 0 or absent ⇒ **provably never broadcast** — the sub-atomic case, AND the
    half-written case, because `amountAtomic` is written BEFORE the chain call. ⚠️ That ordering is
    load-bearing and is now noted at both ends.
  · older than **2× the sweeper period** ⇒ the sweeper has looked twice and found nothing.
⭐ THE TRADE, STATED: a false NO risks two clocks (usually both complete). A false YES is a
PERMANENT LOCKOUT with no recourse. The lockout is strictly worse, so it errs toward letting the
user act. Nothing is deleted or marked failed — the sweeper keeps watching what the guard ignores.

⚠️ **THE NEAR-MISS WAS MINE.** My own "use the smallest amount the endpoint accepts" advice is what
would have caused it. Caught by reading the CONVERSION rather than the VALIDATION — the endpoint
accepts `0.0000001` and it is the rounding, one line later, that makes it poison.

⚠️ **AND A TEST THAT PASSED FOR THE WRONG REASON.** The original "every OPEN state blocks" fixture
omitted `amountAtomic` and `createdAt`, so under the new logic `initiating` read as
never-broadcast — it had been passing on a shape no real record has.

Guard 19/0, mutation-tested three ways: revert to OPEN_STATES → 3 red; drop the units check → 2 red;
remove the age bound → 1 red.

### ✅ THE 409 SURVIVED THE PREDICATE REWRITE — proven live TWICE, and it wrote nothing

Live on **`6a7d9ddb`** (published 2026-08-13 10:52:12Z). A POST of `0.000001` while `16be509f` was
`waiting` returned **409 naming `16be509f`**.

⭐ **THE RE-TEST WAS NOT CEREMONY.** The guard's predicate changed from
`OPEN_STATES.includes(state)` to `blocksNewWithdrawal(rec)` — a completely different route to the
same decision — so the thing proven live two hours earlier was exactly what the change could break.
Re-proving after the rewrite is what makes the first proof still worth anything.

**AND IT WROTE NOTHING**, checked four ways rather than inferred from the status code:

| check | result |
|---|---|
| record count | **1** — no phantom written |
| ⭐⭐ the record itself | `waiting`, `updatedAt` **still `2026-08-12T20:49:12.640Z`**, `lastError: null` |
| chain | `1510000` atomic — unchanged |
| sweeper | `open:1 totalKeys:1` |

⭐⭐ **THE `updatedAt` CHECK IS THE LOAD-BEARING ONE.** A 409 that looked right but had written or
patched a record would be WORSE than no guard — the sweeper would then track a withdrawal that never
started. A timestamp frozen at the original initiation proves the refusal touched nothing. Value vs
value, not an absence.

⚠️ The sweeper's log LINE was not captured (the 15-min window had rolled past the 11:00:53 tick). The
heartbeat carries `open:1`, so the fact holds; the corroborating line simply was not read in time.
Said rather than left as a silent gap.

**Post-deploy checks:** money path `ok`/`steady-ok` on a post-publish tick (`11:00:51`); health key
**UNMOVED — 7/7**, predicted in advance from the local `ddTree` before deploying; smoke 8/8.
⭐ `open:1` also confirms `16be509f` has now survived THREE production deploys while still tracked.

⚠️ **THE SUB-ATOMIC 400 IS OFFLINE-ONLY BY CHOICE.** Triggering it live means sending the exact input
that used to cause the lockout. 21/0 offline is the coverage, and that is a deliberate stopping
point rather than an oversight.

### 📊 THE WALLET LEAK, COUNTED — 10 abandoned sets, ~20% of all provisions

Read-only census via `listWalletSets` (no create, no update, no transaction):

```
wallet sets total                     98
  named "Tikpema owner …"             49
  DISTINCT owner names                39
  ⭐ SETS BEYOND ONE-PER-OWNER        10      ← one leaked provision each
```

⭐⭐ **~10 of 49 provisions were leaks (~20%).** The read-miss was not rare — it fired roughly one
time in five. That is a much stronger justification for the confirm-read than "it happened once at
20:02", and it is the kind of number that only exists because someone asked for a count.

⚠️ **THREE CAVEATS, so the number is not over-read:**
1. Names use `address.slice(0,10)`, so a prefix collision between two real owners would inflate a
   duplicate. `extra` is an ESTIMATE, not a proof.
2. `0x70997970…` and `0x3c44cddd…` are the standard Hardhat/Anvil test accounts — part of this
   population is DEV CHURN, not real users.
3. Not every extra is necessarily read-lag: two genuinely concurrent first-logins produce the same
   shape. `onlyIfNew` handles both identically, so they are indistinguishable after the fact.

⚠️ The abandoned sets hold nothing (created BEFORE mapping, never funded) but they exist under the
entity secret and are not cleaned up. No action taken — deleting wallet sets is a mutation and would
need its own decision.

### 🚨 readJson DOES NOT CONTAIN THE FIVE 202 PATHS — recorded as its own gap

`readJson` catches an UNPARSEABLE body. It **cannot** catch a semantically-wrong 2xx from the
function itself, because that body is valid JSON. A `202 {status:"provisioning"}` passes `res.ok`
**and** passes the helper — so "nothing happened" still reaches the caller as a successful result.

⚠️ Filing that under "contained by readJson" would have been wrong, and the containment sits at the
wrong layer to fix it. **The fix is the STATUS CODE** (503, as on the eight already converted).
Still open on: `agent-ub-spend`, `agent-execute-plan`, `dca-create`, `agent-vault-deposit`,
`agent-vault-withdraw`. Now asserted in `verify-read-json` (9/0) so the bound is pinned rather than
assumed.

### ✅ PROVISIONING IS 503 EVERYWHERE IT SHOULD BE — 13 endpoints, live on `6a7de9e9` (16:21:45Z)

⭐⭐ **THE ENUMERATION FOUND A SIXTH THAT WAS NOT ON THE LIST, AND IT WAS THE WORST.**
`job-swap-approve`'s caller (`approveProposal.ts`) does `if (!r.ok && r.status !== 202) throw` — so a
provisioning 202 passed **deliberately**, fell through `data?.executed === false` (no such field on
that body), and returned `{ receipt: undefined }`: **a swap approval reported as successful with no
receipt**. And `approveProposal` routes BOTH `bridge_usdc` → `job-bridge-approve` (503 since round 1)
and `swap_tokens` → `job-swap-approve` (still 202), so one shared client function was seeing two
different contracts depending on the proposal. The fourth-refund-path shape: a list has what someone
remembered; an enumeration has what is there.

Also fixed `agent-vault-shares` — a read over POST, but its caller does `if (!r.ok) throw; return
data`, so provisioning arrived where share data belonged.

⭐ **THE JUSTIFICATION DIFFERS FROM ROUND 1.** These had only ONE 202, so it was never AMBIGUOUS. The
bug is the other half: `pending` means "nothing happened" and 202 passes `res.ok`. Ambiguity was a
separate, worse problem — this one exists without it.

⭐⭐ **THE GUARD NOW ALLOWLISTS INSTEAD OF SPOT-CHECKING.** It asserts the ONLY endpoints still
answering provisioning with 202 are exactly `agents`, `gateway-balance`, `my-wallet` — the three
whose clients branch on the STATUS CODE to drive a poll, and all three reads. A new 202 anywhere else
now fails the suite rather than waiting for the next enumeration. Spot-checks find what you thought
to look for.

**Post-deploy:** health key **UNMOVED — 9/9** (predicted from the local `ddTree` before deploying);
smoke **11/11**, now including the three pollers.
⭐ Live poller evidence via the DURATION discriminator: `16:26` showed `gateway-balance 201.90 ms`
and `my-wallet 193.51 ms` — ~4 ms is a 401, ~200 ms is real work, so authenticated polls are
completing on the new build.

⚠️ **WHAT IS STILL NOT PROVEN, STATED PLAINLY.** None of the above exercises the 202 branch itself —
it needs a first-login wallet race and cannot be triggered on demand. The normal path was never at
risk. What covers it: the source ALLOWLIST, and the caller check done BEFORE changing anything (none
of the seven branched on 202). ⚠️ A wrongly-503'd poller would fail SILENTLY — a NEW user's card
never fills, existing sessions show nothing — which is why it went in the smoke set rather than being
reasoned about.
⚠️ Money-path tick was still pre-publish at 16:27 (`16:15:21`); the previous deploy's post-publish
tick was clean, and this one is due on the next `*/15`.

### 🚨 THE DCA PANEL HAD BEEN 404ing FOR 22 DAYS — fixed, live on `6a7e108a` (19:16:21Z)

`src/lib/agentClient.ts` called `/api/dca-create`, `/api/dca-cancel` and `/api/dca-list` from
**19405ad (2026-07-22)**. `netlify.toml` never had a redirect for any of them — only the `dca-tick`
SCHEDULE. `DcaPanel` (rendered at `App.tsx:84`) reaches all three ONLY through `agentClient`, so
list, create and cancel were all dead.

⭐ **NOT A REGRESSION — BORN BROKEN.** `19405ad` ADDED all three methods with `/api` paths; there are
no removed lines and no earlier reference. The panel has never worked.

⭐⭐ **AND IT WAS RECORDED AS VERIFIED, THE SAME DAY.** The refactor note says *"SHIPPED + FULLY
VERIFIED — BACKEND AND UI… live in prod and IDLE — the correct resting state"*. The UI check was of
the MANUAL SWAP render, not of DCA creation — a verification of one surface recorded as verification
of the feature.
⭐⭐⭐ **"IDLE" WAS THE TELL.** A panel that cannot create anything is GUARANTEED to be idle, so idle
was indistinguishable from dead — and it was read as health. The same family as a zero balance from
an unreadable chain, but pointed at a whole feature. The 11 mandates in the store came from elsewhere.

**THE FLIP — the most falsifiable check of the session**, because a measured broken state existed
BEFORE:
```
/api/dca-create   404 → 401 ✓        smoke 17/3 → 20/20
/api/dca-cancel   404 → 401 ✓        health key UNMOVED 12/12
/api/dca-list     404 → 401 ✓
```
✅ **AND PROVEN FROM THE BROWSER, SIGNED IN:** `/api/dca-list` returns **200 with a mandates array**.
That is `DcaPanel.tsx:58`'s exact call — the panel's LOAD path works for the first time in 22 days,
verified rather than inferred from a status code.
⚠️ **CREATE IS STILL UNPROVEN.** `dca-list` is read-only; `dca-create` returns 201 and makes a mandate
`active` immediately, which `dca-tick` then acts on — a real swap. So the read half is closed and the
write half is not, and the "idle" reading that hid this for three weeks would look identical on the
write side. ⭐ The smallest honest test is one tick of budget with `endAt` ~65 min out, so it can fire
at most once and expires by construction rather than by anyone remembering to cancel.
⚠️ `mandates: []` would ALSO have been a pass — the list is OWNER-SCOPED, so contents prove nothing
about the route. The 200 is the signal.

### ⭐⭐ HOW IT WAS FOUND, AND THE GUARD THAT NOW DERIVES IT

Found while adding the remaining seven handlers to the smoke set. The smoke test's own rule —
**EXPLICIT paths, never derived from the `/api` convention**, added after the `job-run` false pass —
is what surfaced it. Assuming the convention would have reproduced the bug INSIDE THE TEST.

⚠️ **THE `/api` CONVENTION HAS NOW FAILED THREE TIMES**: `job-run` and `job-run-status` DELIBERATELY
(a direct-called family), DCA ACCIDENTALLY. It must never be assumed.

⭐ **AND THE 20-PATH SMOKE LIST WAS ITSELF AN ASSUMPTION.** A hand list answers "did I remember this
one?"; it cannot answer "is there anything I did NOT remember?". `npm run gate:routes`
(`verify-api-routes.mjs`, 5/0) now DERIVES both sides: every `/api` path referenced in `src/` against
every redirect in `netlify.toml` — **26 referenced against 31 declared**, and the three DCA ones were
the only gap. Matches template literals as well as quoted strings, pinned by an assertion.

⚠️⚠️ **A BUG IN THAT GUARD, CAUGHT BY MUTATION BEFORE IT SHIPPED.** Its first "every redirect points
at a real function" check tested the **FROM** path's name — silently assuming from and to always
match. Mutating a `to` target to a typo left the suite GREEN. It now captures the from/to PAIR and
checks the TARGET, plus an assertion that every route parsed WITH a target (else `routes` empties and
the check passes vacuously — the shape that let the typo through).
⭐ A dangling target is worse than a missing redirect: a 404 whose config READS as correct.

⚠️ **THE FIRST DEPLOY ATTEMPT FAILED CLEANLY** — `getaddrinfo EAI_AGAIN api.netlify.com`. Build
succeeded, upload never started, NO deploy record created, prod untouched. Loud (`CLI_EXIT=1`), not a
partial publish. ⚠️ My watcher only matched `Deploy failed|Build failed`, so it would have polled
forever for a publish that was never coming — `EAI_AGAIN|FetchError` added. Silence-isn't-success, in
my own tooling.

### ✅ DCA CREATE PROVEN END TO END — and a near-miss false defect report

`0d9f0e14`, `status: active`, created through the panel's own path and visible via `dca-list`. With
the earlier signed-in `dca-list` 200, the DCA feature is proven: **route, list, and create**. The
22-day outage is closed on both halves.

### 🚨🚨 I ALMOST FILED A FALSE DEFECT — "two independent reads" were ONE instrument, six times

`netlify blobs:list dca-mandates` showed **7 keys across six reads spanning ~8 minutes** after the
create. It still does. The FUNCTION's own read saw the mandate immediately.

I wrote: *"two independent reads agree — a 201 with no record, which is a real defect."*
⭐⭐ **THEY WERE NOT INDEPENDENT.** It was the same eventually-consistent instrument queried six
times. Repeating a lagging read does not corroborate it — it makes it CONSISTENTLY WRONG, which is
indistinguishable from consistently right. One more message and `dca-create` would have had a defect
filed against it for a bug it does not have.

⭐ **THE RULE, WHICH I HAD ALREADY WRITTEN DOWN AND THEN DID NOT APPLY:** `blobs:list` is eventually
consistent; `blobs:get` BY EXACT KEY is not. I used that correctly for the withdrawal record on
2026-08-12 ("direct key read, immune to list lag"), then reached for `list` here because I lacked the
id — and treated its repetition as confirmation instead of admitting I had no independent check.
⭐⭐ **THE GENUINELY INDEPENDENT PATH WAS THE FUNCTION ITSELF** (`dca-list`), which reads through a
different runtime. When two paths disagree, that disagreement IS the finding — not evidence for
whichever one you asked first.

⚠️ **WHAT THIS RETROACTIVELY WEAKENS, AUDITED RATHER THAN ASSUMED:**
| conclusion | instrument | verdict |
|---|---|---|
| wallet-leak census (10) | Circle `listWalletSets` — not blobs | ✅ unaffected |
| UB 409 wrote nothing | `blobs:get` by exact key + chain read | ✅ survives — the load-bearing evidence was `updatedAt`, not the listing |
| DCA "22 days dead" | `blobs:list` for mandate existence | ⚠️ that part is suspect — but the ROUTING bug was proven by `curl` 404, which is independent |

### ✅ dca-tick NOW SAYS WHAT IT DECIDED — live on `6a7e1f21` (20:17:08Z)

```
[dca-tick] 20:18:08  total=7 inactive=7 unreadable=0 scanned=0 submitted=0 fired=0
                     skipped=0 failed=0 stopped=0 terminal=0 notDue=0 deferred=0 errors=0 ms=264
```
Three consecutive ticks. Health key **UNMOVED — 13/13**. Smoke **20/20**.

⭐ **THE SHARPEST POST-DEPLOY CHECK OF THE SESSION.** `[dca-tick]` had **ZERO** occurrences in the
entire log history — its absence was the ground truth all evening. Predicting a specific string into
a place it has never appeared is falsifiable in a way "confirm X is still true" is not.

⭐⭐ **AND THE FIX DEMONSTRATES ITSELF IN ITS OWN FIRST OUTPUT:** `total=7 inactive=7 scanned=0`. That
is exactly the ambiguity hit two hours earlier, when a bare `scanned:0` could not distinguish "the
store is empty" from "seven mandates exist and all are cancelled".

### 🚨 THE DEFECT WAS SUBTLER THAN "IT DOESN'T LOG"

`beat` recorded every outcome all along — into `dca-heartbeat/"last"`, **ONE KEY OVERWRITTEN EVERY 60
SECONDS**. The state was diagnosable for one minute; by the time anyone asked, ~15 ticks had
overwritten the answer.
⚠️ I called this *"no diagnosable cause, by construction"* — **my third wrong explanation for the same
question** (the first two: list lag, then a period boundary). **THE OBSERVATION EXISTED AND DID NOT
SURVIVE**, which is a different defect from not observing and much harder to spot: reading the code,
the instrumentation looks complete.

**Two silent paths closed**, both producing a number that cannot be read:
· `if (!decision.due) continue;` left NO trace — a not-due mandate showed `scanned=1` and nothing
  else, indistinguishable from a tick that examined it and inexplicably declined. **That is the exact
  case we could not answer.** Now counted WITH `decision.reason`.
· the pre-scan skip made `scanned:0` ambiguous. Now `total` / `inactive` / `unreadable`.

⚠️ The heartbeat is written BEFORE the log line and unchanged — asserted, so a logging throw can
never cost the record.
⚠️ **THIS DOES NOT EXPLAIN THE ORIGINAL MANDATE.** That record was overwritten within 60s and is
gone. It makes the NEXT occurrence diagnosable; it does not recover the last one.

Guard: `verify-dca-tick-observability` 6/0 in `test:dca`, mutation-tested (bare continue → 2 red;
remove the log → 4 red).

### ✅ THE DD DISCOVERY GAP IS CLOSED — the curl from the refusal RUNS, live on `6a7e39bf` (22:01:53Z)

Extracted from the live 405 and run **verbatim**, no retyping:
```
curl -sS -X POST https://app.tikpema.xyz/api/dd-analyze -H 'Content-Type: application/json' \
  -d '{"address":"0x3600000000000000000000000000000000000000","chain":"arc-testnet"}'
→ HTTP 402 · accepts present · whatYouAreBuying present · price $0.06 USDC · subjectPreview present
```
⭐ A curious reader now gets from a clicked link to a working call without asking anyone — and
`subjectPreview` means they learn BEFORE paying whether the subject has contract code at all.
⭐ Extracting the string rather than retyping it is the point: retyping would have tested my
transcription, not what a reader copies.

### ⭐⭐ THE HEALTH KEY MOVED — TO THE EXACT HASH PREDICTED BEFORE DEPLOYING

```
9773162902932b73…4015d   ← the old surface
b17f491d37339372…28f4e6  ← computed locally BEFORE the deploy, and present after
```
**This is the strongest test the content-hash binding has had.** 13/13 DD-clean deploys only proved
it does not move SPURIOUSLY; a binding that never moves and one that tracks code are
indistinguishable until the code changes. This proves it moves WHEN IT SHOULD, and to the SPECIFIC
hash — not merely to something different.

⚠️ **THE PLAN SAID "DD-CLEAN → ANOTHER FREE FALSIFICATION". IT WAS NOT.** `dd-analyze.mjs` is in the
hashed surface (`stamp-build.mjs:68`), so the key HAD to move — and "unmoved" would have been the
failure. Caught by predicting the value before deploying instead of assuming the usual outcome.

### 🚨 THE REFUSAL WINDOW OPENED, AND ONE TEST WOULD HAVE MISREAD IT

`service-unverified` for **TWELVE consecutive attempts** (~8 min) while `dd-canary` attested the new
surface. ⭐⭐ Had the curl been tested ONCE and reported, the honest-looking conclusion would have
been "the example is broken" — when the endpoint was CORRECTLY REFUSING. The warned-about failure
(a reader concludes the service does not work) would have arrived by a route neither of us named:
not a malformed curl, but a correct one tested at the wrong moment.
⚠️ The verifier's own `count: 1` health reading in that run is STALE — taken pre-canary. Re-read
after: 2, as predicted. A number captured before the event it describes is not evidence.

⚠️ Money-path tick was still pre-publish at the time of reading (`22:01:09` vs `22:01:53`); sweeper
alive with `open:1`. Not counted — confirms on the next `*/15`.

🚧 **Content negotiation remains the proper version** — HTML for `Accept: text/html`, JSON for
machines, which also yields the `openApiUrl` Circle's Discovery schema wants. Before any listing.

### ✅ CONTENT NEGOTIATION IS LIVE — `6a7e46c0` (2026-08-13 23:03:05Z)

```
browser (Accept: text/html)  → HTML discovery page ✓
curl    (no Accept override) → application/json ✓      ← the failure that mattered did not happen
/api/dd-openapi              → HTTP 200, openapi 3.1.0, self-consistent openApiUrl
smoke                        → 21/21 (dd-openapi now covered on every deploy)
```
⭐ The OpenAPI document's own `openApiUrl` points at the address it was FETCHED FROM. That is the
exact property `/api/dca-*` lacked for 22 days: a published URL nobody dereferenced.

⭐⭐ **THE HEALTH KEY MOVED TO THE PREDICTED HASH AGAIN** — `f4c8ec9b…32b8ea`, three keys now. Two
consecutive DD-code changes, each tracked to a value computed BEFORE deploying. Far stronger than
13 deploys where it stayed put: those prove it does not move spuriously, these prove it moves when
it should, and to the right value.

⚠️ **JSON IS THE DEFAULT AND HTML NEEDS AN EXPLICIT SIGNAL.** Wildcard Accept (curl), absent Accept
(fetch), `application/json`, a non-string header, and `text/html` inside a PARAMETER all get JSON;
only a real browser Accept gets the page. Mutation-tested: loosening the matcher serves
`text/html; charset=utf-8` to curl. The status stays 405 for both — the method IS unsupported, and
200 would be a nicer lie.

⚠️ **ONE DESCRIPTOR, THREE SURFACES.** `_dd-descriptor.mjs` owns the chains, resource URL, openApiUrl
and sample address; the 405 JSON, the HTML page and the OpenAPI document all read from it — these are
the strings a STRANGER COPIES, and a drift sends a reader to a 404.

🚧 **NOT A CIRCLE DISCOVERY ENVELOPE.** The field names that registry wants could not be found in
Circle's published docs (searched: x402, discovery, marketplace metadata), so nothing claims to
satisfy a schema nobody here has read. `openApiUrl` is the OpenAPI convention and correct on its own
terms; service-specific fields are namespaced under `x-tikpema`. **Verify before submitting anywhere.**

### ⚠️ MY OWN TOOLING REPRODUCED THREE OF TONIGHT'S OWN LESSONS

1. **FOUR ad-hoc harnesses** built to check negotiation all returned 503, never 405 — each omitted the
   publication/health mocks and stopped at an earlier rung. I had COMMITTED that lesson an hour
   earlier. Fixed by extending the suite's own `call` helper to take headers.
2. **`reason=?` for ten retries**: the script did `curl | head -c 60` and then JSON-parsed those 60
   bytes. Truncated JSON never parses — a filtered read fed to a parser, printing `?` instead of the
   cause. The same silent-continue shape fixed in `dca-tick` two hours before.
3. **A health-key reading taken seconds after publish** reported "not yet" for a canary on a `*/10`
   schedule — a number captured before the event it describes.
⭐ None cost a wrong conclusion, because each was caught by re-reading rather than by trusting the
first answer. But the pattern is worth naming: the failure modes this codebase is built to resist
show up just as readily in the scripts written to verify it.

### NEXT, IN ORDER

1. ✅ DONE — deploy published `7f5d5de`, heartbeat appeared, calibration ran and cleaned up.
2. ✅ DONE — the independent watcher is **strong-read-watch**, not a new function and not dd-watch.
   Decided by the precedent already written into that monitor's own header: dd-watch guards DD,
   *which is going standalone and will leave this repo*, so folding user-funds monitoring into it
   would mean the exit loses its watcher the day DD moves out. A new function would have added a
   fourth schedule without adding the independence that matters — the independence needed is from
   THE SWEEPER, which strong-read-watch already has (different process, schedule and store).
   `shared/strong-read-watch/sweeper-heartbeat.mjs`, 55/0 + 16 handler-level checks in test:watch.
   ✅ **PRODUCTION-CONFIRMED** on deploy `6a7cab04` (published `17:40:36Z`): the first post-publish
   tick, `17:45:46Z`, carries `sweeperOk:true / reason:"alive" / ageMs 891698 / staleAfterMs 4200000`.
   ⭐ The record's `heartbeatAt` is `17:30:54.618Z` and `ub-withdrawals/heartbeat` reads
   `17:30:54.618Z` — a VALUE-vs-VALUE match, so it read the real store rather than a default.
   ⭐ Two kinds on one tick from separate prevs: money `steady-ok`, sweeper `first-ok`, both silent —
   the split is visible in production, and the gap closed without adding noise.
   ✅ **STALE + RECOVERED CALIBRATED ON PROD 2026-08-12**, both messages human-confirmed in the
   money channel. Method: wrote a back-dated heartbeat (`at` 14:45:00Z, carrying a `calibration`
   marker) into `ub-withdrawals/heartbeat` immediately after a genuine sweeper tick.
   | time | branch | outcome |
   |---|---|---|
   | 18:15:47 | `stale` → **`regressed`** | delivered ✓, human-confirmed. 211 min vs 70 min |
   | 18:30:59 | `alive` → **`recovered`** | delivered ✓, human-confirmed |
   ⭐⭐ **THE ADDITIVE PROPERTY HELD IN PRODUCTION UNDER REAL FAILURE:** both ticks reported money
   `ok:true` / `steady-ok` / `planned:false` while the sweeper verdict was false. That was 12
   fixtures and a mocked handler; it is now an observation.
   ⭐ `regressed` (not `first-failure`) proves the transition came off the sweeper's OWN prev.
   ⭐ **THE MUTATION ERRED TOWARD ALARM.** A back-dated heartbeat can only produce a false "sweeper
   down"; it cannot make a real outage look healthy. That is what made the drill safe to run against
   a live key rather than needing a synthetic one.
   ⭐⭐ **ATTRIBUTION BEFORE JUDGEMENT — and it earned its keep.** Recovery fired at 18:30:59, a full
   cycle EARLIER than predicted, because the sweeper wrote at 18:30:58.129 — **1.45 s** before the
   monitor read. Without a provenance check the natural move is to ask why the monitor stood down
   early, which is the wrong question. The discriminator was the `calibration` KEY's absence, not the
   timestamp: a timestamp invites inference, a marker names the author. A sweeper that failed to tick
   would otherwise look identical to a monitor that failed to stand down.
   ⚠️ **STILL SUITE-ONLY:** `still-failing-quiet` for the sweeper concern (the sweeper recovered 1.5 s
   before the tick that would have shown it — exercising it needs the stale state held across TWO
   monitor ticks, ~35 min not ~30), plus `missing` and `unreadable`.
   ⚠️ **The bound, stated rather than discovered later:** this closes the sweeper-died gap only. If
   strong-read-watch itself dies nothing watches it. Recursion stops there, deliberately.
3. **Then** initiate 1 USDC (operator-run; the endpoint needs a browser session and manufacturing one
   is ruled out). Verify: chain 2→1, a record in `waiting` with an `initiateTxHash`, sweeper reporting
   `open=1`. ⭐ **Completion can only be confirmed ~7 days later** — the first thing here whose proof
   takes a week, and the first real test that a `*/30` schedule survives that long.

---

## 2026-08-12 — ✅ THE UNIFIED BALANCE HAS AN EXIT. Option (a) built: two calls ~7 days apart, a sweeper that finishes it, and the wait disclosed BEFORE deposit.

**Commits `06d3a94` (the exit) · `ffe5ac3` (a suite that was passing on build residue) ·
`a8060ed` (v4 copy).** Decision was (a), taken deliberately: on testnet (b) was defensible, but with
real user money **a pocket with no exit that the user was TOLD about is still a pocket with no
exit** — disclosure changes who is culpable, not what the user can do. Mainnet **2026-09-16**.

### THE SHAPE — three hops, and hop 3 already existed

    1. initiateWithdrawal(token, amount)   starts a delay set by the CONTRACT
    2. ~1,209,600 BLOCKS ≈ 7.1 days        DERIVED at 0.5097 s/block
    3. withdraw(token)                     funds land in the user's SCA
    → agent-withdraw (pre-existing)        SCA → the user's login wallet

⚠️ **THE DELAY IS BLOCKS, NOT SECONDS.** `1209600 = 14 × 86400` is a COINCIDENCE that has already
misled a reader. Every user-facing string says **"about seven days"** and never a precise figure.

### 🚨 THE SWEEPER IS WHAT MAKES THIS AN EXIT RATHER THAN THE OPTION WE REJECTED

Option (c) — build only step 1 — was rejected on sight: **a half-built exit that starts a clock
nobody finishes is worse than no exit, because the user believes they are leaving.** But "the user
comes back in a week and clicks again" is the same failure wearing a nicer face.

⭐ **ON THE BRIDGE, "a user who never comes back" WAS THE EDGE CASE. FOR A WITHDRAWAL IT IS THE
ORDINARY ONE** — someone asking for their money back is, by definition, leaving. So `ub-withdraw-sweep`
(`*/30`) drives hop 2 with no session, no page load and no human.

⚠️ **THAT MEANS THE SERVER MOVES USER FUNDS UNATTENDED, ~7 DAYS AFTER THE REQUEST.** Deliberate and
bounded: it can only call `withdraw(token)` for an owner who ALREADY initiated, it takes no amount
(the contract decides what matured), and `withdraw` pays `msg.sender` — the user's own SCA. ⭐ The
guarantee is **absence of mechanism**: no path in that function can move money anywhere but back.

⭐⭐ **AND IT IS NOW THE HIGHEST-CONSEQUENCE ROW IN `GUARDED_SCHEDULES`.** A forgotten `dd-canary`
schedule makes DD refuse — loud, fail-closed, obvious. A forgotten `ub-withdraw-sweep` schedule means
withdrawals **silently never complete**: the promise "you do not have to come back" quietly stops
being true, nothing errors, nobody is paged, and the money stays put.

### DESIGN RULES CARRIED IN

* ⭐ **A RECLAIM IS NOT A SPEND.** No `assertNotPaused`, `canSpendDay`, `sendCapUsdc` or
  `recordAgentSpend` — those bound what the AGENT may spend, and **a paused agent must never trap the
  user's money.** Removing them NARROWS the surface: there is no `to` parameter anywhere and
  `withdraw(address)` takes no beneficiary, so funds can only land in the caller's own SCA.
* 🚨 **RECORD BEFORE CHAIN CALL.** The sweeper scans RECORDS, so an unrecorded initiation is a clock
  nothing finishes. If the handler dies or the 10s ceiling cuts it, the record survives in
  `initiating` and the sweeper RECONCILES against the chain — which is why the front door can stay
  synchronous. **Third time this codebase has needed this ordering** (`_dd-x402`, `dd-watch`).
* ⭐ **"COMPLETED" ≠ THE USER HAS THEIR MONEY.** Records carry `landedIn` + `stillNeedsAgentWithdraw`
  so nothing downstream can render "your money is back" from state alone.
* ⭐ **TRI-STATE TO THE EDGE.** Unreadable chain or store ⇒ `readable:false`, NEVER zero. "We could
  not read your balance" and "your balance is zero" are different answers to someone asking where
  their money is. The sweeper reports `store-unreadable` rather than a clean tick.
* ⚠️ **`not-yet-matured` IS A NORMAL RESULT**, seen every tick for a week — logging it as failure
  would alarm every 30 min and train everyone to ignore it.
* ⚠️ **IDEMPOTENCE IS THE CHAIN'S:** a premature or duplicate `withdraw` REVERTS (measured `"N;O"`),
  so open records can be retried safely. No guard that merely looks like the real protection.
* ⚠️ **NO `httpMethod` AUTH GUARD on the sweeper** — `dd-watch` shipped one and refused its own cron
  for five runs. A sweeper must never be able to refuse itself.

`scripts/verify-ub-withdraw.mjs` **15/0** — every branch by injection, including chain-unreadable,
store-down, a throwing completion, and INITIATING reconciled against the chain.

### 🚨 THE COPY GUARD HAD BECOME THE FALSEHOOD IT EXISTED TO PREVENT

`verify-unified-balance-copy` **REQUIRED** the strings *"we haven't implemented it or tested that it
works end to end"* and *"not that no path exists"*. Both were true and load-bearing when written.
**The moment the exit shipped, the guard would have FAILED THE BUILD FOR TELLING USERS THE TRUTH.**

⭐⭐ **THE MECHANISM WAS NEVER WRONG — IT OUTLIVED THE FACT IT PROTECTED.** A copy guard pins a claim,
and a claim has a shelf life. This is the **fourth** distinct way this paragraph has been wrong, and
the only one where the guard was the problem rather than the catch. Those strings are now FORBIDDEN
alongside every v1–v3 falsehood, for exactly the same reason.

**v4 IS NOT "you can get your money back."** The path is built and has **never been run end to end
with real funds**; claiming more repeats v2's error of inferring a working release path from the
existence of code. Both halves are asserted: **built and automatic** ("you do not have to come
back") **and unexercised** ("nobody has taken this route with real funds yet").

⭐⭐ **THE BEFORE-DEPOSIT DISCLOSURE IS THE SKIM-LINE.** The deposit card still LED with *"Treat this
as one-way"* while the paragraph beneath described a working exit. **The lead is what gets read; a
correct paragraph under a wrong skim-line is a wrong card.** It now reads *"Money goes in instantly
and takes about seven days to come back out"* — and the guard asserts the ORDER (cost before
mechanism), not merely the presence of the words.
⚠️ **I MISSED THAT SITE WITH A CASE-SENSITIVE GREP** ("Treat" vs "treat"); the guard's `/gi` caught
it — the same failure mode that let `badge="Server-released, delayed"` survive three reviews.
The badge has now been wrong twice and right twice: it reads **"Exit built · about seven days"**.

### 🚨 `test:dd` WAS PASSING OR FAILING ON LOCAL BUILD RESIDUE — 7 OF 17 SUITES

Same commit, two states: `npm run build` → `verify-endpoint` **77/0**; `npm run stamp:clear` →
**18 FAILURES**. `f714bb9` made the build stamp the DD identity, and every suite that let
`codeIdentity()` fall through to disk inherited a dependency on **whatever the developer last ran**.

⭐ **AND THE FAILURES NAMED THE WRONG THING** — *"expected 400 invalid-address, got 503
service-unverified"*. Nothing pointed at the stamp, which is how it went unnoticed. `test:dd` was
green earlier that day only because deploys had been running. **I introduced the coupling and did not
notice the suites had become dependent on it.**

**FIXED:** `verify-endpoint` + `verify-health-read-consistency` inject a deterministic stamp
(`scripts/dd/_test-stamp.mjs`) and pass identically in both states.
⚠️ **ONLY MITIGATED:** **ESM hoists static imports above module-level code**, so the mock lands too
late for suites importing the module under test statically — and it **no-ops silently**. ⭐ **A
mechanism that works in some callers and quietly not in others is worse than none**, so those three
calls were REMOVED rather than left looking like protection. `test:dd` now runs `npm run stamp` first
— reliable in aggregate, but a single suite run against a cleared stamp still fails with the same
misleading message.

### 🚧 WHAT IS NOT PROVEN

* 🚨 **THE WRITE PATHS HAVE NEVER RUN.** `initiateWithdrawal` and `withdraw` are unexercised with
  real funds — which is exactly what the copy now says. The read half IS live-verified.
* 🚧 The sweeper has never completed a real withdrawal; every branch is injection-proven only.
* ⚠️ `eth_call` proved the CONTRACT would accept the call; it does not prove Circle's signer produces
  a valid userOp. That closes only by executing one.

---

## 2026-08-12 — UNIFIED BALANCE EXIT: the capability is VERIFIED. 🚨 THE DECISION IS DUE, AND IT IS NOT AN ENGINEERING ONE.

**Read-only probe. NO state changed, nothing signed, nothing broadcast.** `eth_call` simulates
execution without touching the chain, which is what makes a capability answerable for free.

### WHAT IS NOW VERIFIED (was selector-presence only, since 2026-07-31)

| question | answer |
|---|---|
| Gateway proxy resolves to the same impl as July? | ✅ `0xa33d52b4…`, 22,818 bytes, **unchanged** |
| withdraw path present? | ✅ `initiateWithdrawal` `c8393ba9` · `withdraw` `51cff8d9` · `withdrawableBalance` `3bbe1ecd` |
| would `initiateWithdrawal` revert from our SCA? | ⭐⭐ **NO — simulated, would succeed** |
| can `execute()` drive it? | ⭐⭐ **YES**, and **a random EOA is REFUSED** |
| permission module blocking it? | ✅ `getInstalledPlugins()` → **empty**; no selector allowlist |
| the wait | ⚠️ **1,209,600 BLOCKS ≈ 7.1 days** |

⭐ **THE RANDOM-EOA REFUSAL IS THE LOAD-BEARING CONTROL.** Without it, "would succeed" could just mean
simulation is permissive. Authorisation is genuinely enforced and the owning account passes it.

⚠️ **`removeFund` IS ABSENT FROM THE CONTRACT** — it is the SDK name and calls `withdraw()`.
Selector-checking the SDK name yields a confident FALSE NEGATIVE. (Recorded before; re-confirmed.)
⚠️ **`getOwners()`/`entryPoint()` REVERT** on this impl, so the owner cannot be enumerated on-chain;
control comes from the Circle wallet model (`createWallets({accountType:"SCA"})`), not a chain read.
⚠️ **`withdrawalDelay` is BLOCKS, not seconds.** `1209600 = 14 × 86400` is a COINCIDENCE. The ~7.1
days is DERIVED from measured block time (0.5097 s/block), so copy must say **"about seven days"**.

🚧 **THE REMAINING INFERENCE, STATED:** `eth_call` sets the sender WITHOUT a signature. This proves
the CONTRACT would accept the call from that address; it does NOT prove Circle's signer will produce
a valid userOp for it. That closes only by executing one, which moves real money.

### 🚨 THE DECISION IS DUE — AND IT IS NOT ENGINEERING'S TO MAKE

**The probe is done; the decision is not.** Do not read "capability verified" as "path chosen".
Three honest options:

* **(a) BUILD IT.** Two calls, ~7 days apart, **with the wait disclosed BEFORE deposit** — not at
  withdrawal time, which is the same copy trap already fixed once on this page.
* **(b) DON'T BUILD IT, AND SAY SO PLAINLY.** Which is what the corrected copy already does.
* **(c) BUILD ONLY `initiateWithdrawal`**, disclosing that completion needs a second step.

🚨 **(c) IS THE TRAP AND SHOULD BE REJECTED ON SIGHT. A half-built exit that starts a clock nobody
finishes is WORSE THAN NO EXIT, because the user believes they are leaving.** An exit that exists
only up to the point of commitment is not an exit; it is a delay with a UI.

⭐⭐ **THE MAINNET FRAME DECIDES IT.** On testnet (b) is defensible — the money is play money and the
copy is honest. **With REAL USER MONEY, a pocket with no exit that the user was TOLD about is still a
pocket with no exit.** Disclosure changes who is culpable; it does not change what the user can do.
**Whether we are willing to ship that is the actual question, and it is the operator's to answer, not
an engineering one.** ⚠️ Mainnet is **2026-09-16**.

⚠️ **AND THE ASYMMETRY IS WHY THIS OUTRANKS THE DD BACKLOG:** every DD failure this week was
fail-closed and cost AVAILABILITY. This is the only open item where being wrong costs **someone else
their funds**.

---

## 2026-08-12 (later) — ✅ DD THREAD CLOSED. Alert path proven live end to end; three more monitor bugs found while proving it.

**Commits `9317cdf` · `b93d071` · `6679d99`. Production `6679d99`.** DD live, monitored, paid twice on
real money, three production-proven bindings, every monitor branch observed. **Treating this as
finished** — see the pivot at the end.

### ⭐ EVERY TRANSITION OBSERVED, NOT SUITE-PROVEN

`first-alert`+delivered · `suppressed-reminder` (~25 min, **exactly one message**) · **genuine
`recovered`** (`ok:true`; the only earlier one was FALSE) · `steady-ok` (read from `notify.kind`,
never from Discord being quiet) · **`path-divergence` derived cleanly** · **window opened+closed with
a 34.6 min duration** · **`induced` carry-forward `true` on close while `leverActive` was already
`false`** · **label dies with its window** (`false` on the next steady tick, same build).

### 🚨 THREE MORE BUGS, ALL ABSENCES

**D — `stale` COULD NEVER ALERT, AND THE STAND-DOWN LIED.** `reasons:['stale']` → `alert:false`: not
in the allow-list, not `no-record`, so it fell through into **silence** — and `stale` is the canary
having STOPPED WRITING. 25 minutes of refusal, no correct alert. ⭐ **The defect was the DIRECTION OF
THE ENUMERATION** — listing what alerts leaves anything added later silently unmonitored. Now
inverted: **a refusal alerts unless it is specifically `no-record` inside grace.** And
`decideNotify` transitioned on `alert` while claiming `ok`, announcing **"RECOVERED — both paths
serving again" WHILE BOTH WERE REFUSING**. ⭐⭐ **A false all-clear is worse than a missed alert: a
missed alert leaves you looking, an all-clear tells you to STOP.** ⭐ The fix earned itself in
minutes — 11:30:48, both paths `stale`, alerted correctly. ⚠️ That was **TTL expiry, not a rotation**.

**E — `windowHistory` RECORDED REFUSALS, NOT UNAVAILABILITY.** A path serving SPA HTML — **the
canonical payment target broken while the service looks fine** — left NO trace, because the window
was keyed on `refusingSince`. ⭐ **The dataset this monitor exists to build was under-reporting its own
subject**; a history that omits a class of unavailability reads as complete. Fixed by **splitting**
the clock (`refusingSince` for grace, `unhealthySince` for the window), not widening it.

**F — THE INDUCED LABEL OUTLIVED ITS WINDOW.** A healthy run showed `steady, induced:true`, so a
future **genuine** outage would inherit it. ⭐⭐ **The exact inversion of the bug the flag prevents:**
instead of a calibration masquerading as real, a real outage masquerades as a calibration and gets
**discounted** — worse, because it silences a true signal. ⭐ Fixing it exposed an assertion that was
**green from the wrong branch** (a `refusingSince` fixture never reached `window-opened`). **An
assertion that names a branch it does not reach reads as coverage.**

### ⭐ SELF-ATTRIBUTION — timestamps cannot attribute across a deploy

The stale-label fix changes only the steady ticks *after* a recovery, landing a minute from the
deploy that ships it. **A tick can straddle the transition**, so clock-based attribution credits old
code to new. Every record now carries `build:{commit,tree,resolved}` — **self-proving on arrival**,
since the field does not exist in the prior build. Measured: `11:25:24 build=ABSENT` →
`11:30:48 build=6679d99`. ⚠️ Same class as the settler probe: **a concurrent change makes an
observation unattributable however clean it looks.**

### 🚨 DISCIPLINE — I READ A STALE RECORD AND ACCUSED THE PLATFORM

**Third time today.** Read `leverActive:false`, concluded *"the deploy did not pick up the env
change"*, and started proposing remedies. Wrong:

    deploy created 10:35:57  published 10:55:19
    env set        10:35:17  ← 40s BEFORE creation, picked up correctly
    record read    10:55:08  ← 11 SECONDS BEFORE publish, on a */5 monitor

⭐ **`published_at` from `netlify api listSiteDeploys` is the discriminator; CLI exit is NOT publish.**
⚠️ Same shape each time: **query an eventually-updating source, get a pre-event value, treat it as
evidence about after.** Twice it produced a wrong accusation — once against the operator's sighting,
once against Netlify.

### ⚠️ TWO CALIBRATIONS WASTED, BOTH ON SEQUENCING

Unset a lever while its deploy was still resolving env (published inactive); ran `stamp:clear` while
a deploy was bundling (**nulled stamp → `build-unresolved` → ~30 min of real production outage**).
⭐ It **FAILED CLOSED**, which is the whole point of `null`-not-placeholder — demonstrated by accident
on production. ⭐ **THE RULE BOTH VIOLATE: a deploy in flight is a reason to touch nothing it reads** —
env, the stamp, the working tree.

### STILL NOT PROVEN

* 🚧 **POST-DEPLOY REFUSAL WINDOW UNMEASURED — eight deploys.** Today's `stale` was TTL expiry; the
  key never rotated. ⭐ The binding fix makes rotation **rare by design**, so it may be a long wait.
* 🚧 **Both `windowHistory` entries are INDUCED** — a genuine one has nothing to sit beside.
* ⚠️ **The 34.6-min entry has TWO causes** (induced lever + the real `stale` refusal). Correct for the
  carry-forward test; **not a clean "what a calibration costs" number.**
* 🚧 `no-record-persisting` and the always-real **renderings** remain suite-only.

`test:ddwatch` **98/0** · `test:dd` 17 suites · `test:watch` 212/0 · `gate:watch` exit 0.

### 🚨 PIVOT — DD IS DONE; THE MAINNET RISK HAS HAD NO WORK

**DD is a finished piece: live, monitored, paid twice on real money, three production-proven
bindings, every monitor branch observed.** Remaining DD items are refinements, not risks.

⭐⭐ **THE TOP MAINNET ITEM IS THE UNIFIED BALANCE HAVING NO EXIT PATH — real user money with no way
out — and it has had NO work at all. Mainnet is 2026-09-16.** Copy was corrected (`eb459a1`) and
`removeFund` was confirmed reachable, but **nothing is built**, and `withdraw()` has never been
exercised. ⚠️ **This is the one where being wrong costs SOMEONE ELSE something**, rather than costing
us a refusal — every DD failure this week was fail-closed and cost availability. That asymmetry is
why it outranks everything above.

---

## 2026-08-12 — THE REFUSAL WINDOW, THEN THE MONITOR. And the monitor's first live outage found three of its own bugs.

**Two items off the post-exposure list. `dd-watch` is live on `*/5`, DD serving on both paths,
production healthy.** Commits `f714bb9` · `90879f7` · `2d48790` · `59bff5d` · `edbbe11` · `e1b41a5` ·
`9d2bc06`.

### ⭐⭐ ITEM 1 — THE REFUSAL WINDOW: the health key was bound to the WRONG THING

**Measured over the last 40 commits: 20 touched the stamped surface, only 2 touched DD, and
18 WERE STAMP-DIRTY BUT DD-CLEAN.** Under deploy-id binding every one of those 18 rotated the health
key and refused the public service for up to a canary period — an outage caused by bridge, research
or agent work the canary's verdict says nothing about.

🚨 **THE PREMISE IN THE CODE WAS WRONG, NOT JUST THE VALUE.** `health.mjs` argued a deploy id was
*"the right binding, not merely the available one, because it changes on EVERY deploy."* **Changing
on every deploy is the DEFECT.** "Distinguishing deploys" was never the job — distinguishing CODE is.
Two deploys of byte-identical DD code deserve one verdict; we had already shipped tree `931f6666…`
twice under two deploy ids and watched the key rotate for nothing.

**The identity is now `ddCodeIdentity()` — a sha256 over the DD surface** (engine + facts + canary +
the DD handlers + the two modules `dd-canary` imports), emitted as `ddTree` by `stamp-build.mjs`.

* **BUILD TIME, NECESSARILY.** esbuild inlines `shared/` into each function, so the sources do not
  exist at runtime and cannot be re-hashed there.
* ⚠️ **THAT MAKES THE BUILD STAMP SAFETY-CRITICAL** — and that is not theoretical: see the outage below.
* 🚨 **UNAVAILABLE ⇒ UNBOUND.** `null`, never a fallback, never the deploy id. **There is NO env
  lever**: a variable that sets the code identity is `unknown === unknown` with a knob.
  `DD_BUILD_ID`/`COMMIT_REF`/`DEPLOY_ID`/`BUILD_ID` are now ignored, asserted.
* ⭐ **Content hashing absorbs dirtiness for free** — bytes on disk, not git state, so an uncommitted
  DD edit earns its own key and its own canary run.

⭐⭐ **PRODUCTION-PROVEN TWICE, ON TWO SEPARATE DD-CLEAN DEPLOYS.** Each time `tree` changed and
`ddTree` did not, and the key read back **by exact string**:

    tree   b4733fe9… → f31d1181… → 22b294b5…   CHANGED each time
    ddTree 9773162902932b73…4015d               UNCHANGED, and the key never moved

The first deploy after the change could not prove this — its fresh key was equally consistent with
the fix working and with it doing nothing. **Only a DD-CLEAN deploy producing the SAME key is
evidence**, and there have now been two.

### ⚠️ THE REMEDY IT INVALIDATED — a live misleading instruction

`dd-canary`'s rung-0 refusal told operators to *"set one of DD_BUILD_ID, COMMIT_REF, DEPLOY_ID,
BUILD_ID"* — knobs that are now inert. **Following that mid-outage would have burned an operator's
time on a disconnected lever.** It now names the build step, and the suite asserts the retired knobs
do NOT appear in the remedy.

### ITEM 2 — `dd-watch`: DD availability, both paths, every 5 minutes

⭐ **THE PROBE IS FREE, WHICH IS WHAT MAKES THE CADENCE AFFORDABLE.** `dd-analyze`'s rungs are
exposure(−1) → retrieve(−0.5) → HEALTH(0) → … → payment(6), so an unauthenticated POST can only reach
the 402: never settles, never charges, needs no session. **402 = past the health rung, 503 =
refusing.** The analyzer never runs, so the only per-probe cost is `subjectPreview`'s single
`eth_getCode`.

**BOTH PATHS, because divergence is its own event.** `/api/*` depends on a redirect that has been
observed serving SPA HTML while the functions path answered. That was measured ONCE; polling both
makes it a standing invariant. ⚠️ Differing `resource` between paths is **EXPECTED** (it binds to the
URL hit); differing `payTo` or price is a **split-brain in the money path** and gets its own critical
headline, never sharing one with "DD is refusing".

**THE PROBE SUBJECT IS THE ZERO ADDRESS, chosen deliberately:** nobody holds the key so it can NEVER
gain bytecode (any change in the preview is a real signal, not subject drift), it belongs to nobody
(hitting a third party ~576×/day reads as surveillance), and it exercises the thin `hasCode:false`
path. ⚠️ **Rejected: the delegate wallet an early draft used** — that is the wallet that BUYS.

**THE PROBE IDENTIFIES ITSELF** (`user-agent` + `x-tikpema-monitor`). A `dd-analyze` invocation is one
of the only signals a STRANGER touched DD; ~576 self-generated invocations a day would bury it.
⚠️ A marked probe can never be mistaken for a **purchase** — a 402 ends the exchange — only for
**interest**.

**SEPARATE CHANNEL (`DD_WATCH_WEBHOOK` → "DD-service"), gated like the money channel** — shape, live
existence GET, and a check that **FAILS** if the two fingerprints match. ⭐ The argument is not
"different urgency": **MUTING IS PER-CHANNEL**, so a chatty DD alert sharing the money channel would
train someone to mute the siren that matters.

⭐ **GATE ROWS FOR THE CALIBRATION LEVERS LANDED BEFORE THE FIRST CALIBRATION RUN.** Proving an alert
requires pointing the monitor at a broken target, and the act of proving it leaves the lever set — a
monitor aimed at a fake target watches nothing while looking healthy. `DD_WATCH_URL_API`/`_FN` and
`DD_WATCH_STORE` now gate production. Adding those rows afterwards would have left exactly one
unwatched window: the calibration itself.

### 🚨 THE MONITOR'S FIRST LIVE OUTAGE WAS NOT A DRILL — and it exposed three of its own bugs

**A calibration lever made `/api` return `not-json`. But `functions: refusing` had NO LEVER ON IT.**
That was a genuine production outage — `build-unresolved`, ~30 minutes — caught by a monitor live for
under an hour. ⚠️ **And then it mishandled the ending.** Both halves belong here; the catch alone
would be flattering and false.

**Cause of the outage, and it is mine:** the commit step ran `npm run stamp:clear` **while a deploy
was still bundling**. Netlify packages functions from `netlify/functions` + `shared` AT DEPLOY TIME,
so it shipped a **nulled stamp** → no `ddTree` → unbound → refuse. ⭐ **That is exactly the
safety-critical-stamp hazard written into `ddCodeIdentity` when it was built**, defeated by not
treating "a deploy is in flight" as a reason to leave the stamp alone.
⭐⭐ **IT FAILED CLOSED** — an unresolvable identity refused rather than serving unverified. Which is
the entire point of `null`-not-placeholder, demonstrated by accident on production.

**BUG A — THE MONITOR REFUSED ITS OWN CRON.** Five scheduled runs, store empty, no error anywhere.
**Netlify delivers scheduled invocations WITH an `httpMethod`**, so the auth guard's `looksHttp` was
true for the cron itself and every run returned 401 before probing. Durations gave it away: **23ms,
when two HTTPS probes cannot finish under ~200ms.**
⚠️ **THE WARNING FOR EXACTLY THIS WAS WRITTEN IN THAT BLOCK AT THE TIME.** Naming a failure mode is
not the same as choosing a discriminator that avoids it. **Fixed by REMOVING the enforcement:** the
platform 403s external HTTP on a scheduled function (measured), so no reachable external caller
exists — the check's false-positive kills the monitor and its true-positive is unreachable.
**A monitor must never be able to refuse itself.**

**BUG B — NOTIFY BEFORE PERSIST.** A failed write would have left `prev` null, so every run would
read `first-alert` and re-send **every 5 minutes forever** — and the reminder window built to prevent
that firehose would never be consulted, because the state proving there was anything to remind about
is what failed to persist. ⭐ **The same inversion `_dd-x402` already learned**, pointed at a webhook
instead of a payment. Now: **write state → send → write outcome (best-effort)**.

**BUG C — THE CLOSED SET POINTED THE WRONG WAY, AND THE STAND-DOWN LIED.**
🚨 `reasons: ['stale']` produced **`alert: false`**. `stale` was not in the alert-worthy allow-list
and was not `no-record`, so it fell through EVERY branch into **silence** — and `stale` is the canary
having STOPPED WRITING. **DD refused for 25 minutes and the monitor never alerted for the right
reason.** ⭐ The defect was the **DIRECTION OF THE ENUMERATION**: listing what alerts and letting
everything else be quiet means any reason added later, or any typo, is silently unmonitored. Now
inverted — **a refusal alerts unless it is specifically `no-record` inside grace** — so an
unrecognised reason alerts. Pinned with an invented future reason so the rule cannot rot.
🚨 And `decideNotify` transitioned on `alert` while the message claimed `ok`: it announced
**"✅ DD RECOVERED — both paths serving again" WHILE BOTH PATHS WERE REFUSING.**
⭐⭐ **A FALSE ALL-CLEAR IS WORSE THAN A MISSED ALERT: a missed alert leaves you looking, an all-clear
tells you to STOP.** The stand-down now requires `ok`; a de-escalation that is still unhealthy says
so in its own words and explicitly denies being a recovery.

⭐ **ALL THREE WERE ABSENCES, NOT WRONG VALUES** — a run that did not happen, a write that did not
land, an alert that did not fire. No suite was going to surface them; a real outage running through
the whole state machine did.

### ⭐ NOT FIRING ON ROUTINE WORK — the constraint that shaped the design

A DD-code deploy legitimately rotates the health key, so `no-record` is CORRECT until the next canary
tick. Paging on that would fire on **every** DD deploy by construction, and **an alert that fires
predictably on routine work is one nobody reads** — already recorded here for the ack gate.
⭐ **GRACE IS DERIVED FROM THE CANARY PERIOD (2 × `*/10`), never from the monitor's own `*/5`:**
silent through t+20m, first alert at t+25m, after the canary has had 2½ chances to write.

### WHAT IS PROVEN, AND WHAT IS NOT

| claim | status |
|---|---|
| code-hash binding survives a DD-clean deploy | ✅ **MEASURED TWICE**, exact string |
| monitor runs, both paths, `*/5` | ✅ live (durations 23ms → ~550ms once it stopped refusing itself) |
| alert fires and DELIVERS to DD-service | ✅ live |
| rate limiting | ✅ **MEASURED** — ~25 min in alert, exactly ONE message |
| `steady-ok` (the state it lives in) | ✅ **read from `notify.kind`**, never from Discord being quiet |
| a GENUINE `recovered` | 🚧 **UNPROVEN** — the only one that fired was the FALSE one |
| `no-record-persisting` + always-real renderings | 🚧 **SUITE-ONLY** — the calibration exercised `not-json` |
| **the post-deploy refusal window** | 🚧 **STILL UNMEASURED after five production deploys** |

🚨 **`windowHistory`'s only entry (29.9 min) IS INDUCED** — a calibration lever plus the
`build-unresolved` outage. It closed on a build predating the induced flag, so it defaulted to
`false` and was **patched to `induced: true` with a self-explaining note**, because a wrong label in
the data outlives any commentary about it. ⚠️ **It is NOT a refusal-window measurement.** The
rotation window has never been captured — and the binding fix makes it **rarer by design**, since
only DD-code deploys rotate the key now, so it may take a while to observe. That is the good kind of
problem.

⭐ **The `induced` label is DERIVED from `targets`, never remembered** — if either target differs from
its default a lever is set — **and it carries forward**, because the lever is normally removed while
the window is still open, which is how a calibration ends. Without carry-forward the CLOSING entry —
the one with the duration on it — would be labelled real and would lie.

### Suites

`test:ddwatch` **83/0** · `test:dd` 17 suites (incl. `verify-dd-code-identity` 30/0) ·
`test:watch` 212/0 · `test:probe` 71/0 · `gate:watch` exit 0.
⚠️ `verify-build-binding` and `verify-canary-endpoint-binding` were **REWRITTEN, not deleted** — the
latter is the only test that runs the real canary handler into the real endpoint handler through one
store, i.e. the only one that could catch the two sides drifting apart.

---

## 2026-08-11 (evening) — 🟢 DD IS LIVE ON PRODUCTION. The service is public, and three things changed character the moment it was.

**Deploy `6a7b57501c0748c9f7711418`, commit `d030f30`, tree `931f6666…`, `verdict D / calibrated true
/ selfChecks []`.** `DD_PUBLIC_ENABLED=true` and `DD_PAYTO_ADDRESS` set on the **production** context,
each read back by payload. `deploy-preview` untouched; **`--context all` never used.**

Deployed via `npm run deploy:prod`, so `gate:watch` ran automatically — the wiring built this morning
guarding its first real promotion.

### Step 4 — THE PRODUCTION SPLIT-BRAIN IS MEASURED. There is no split.

| path | HTTP | `resource` | payTo | amount |
|---|---|---|---|---|
| `/api/dd-analyze` | **402** | `https://app.tikpema.xyz/api/dd-analyze` | `0xb407967319d5…` | 60000 |
| `/.netlify/functions/dd-analyze` | **402** | `https://app.tikpema.xyz/.netlify/functions/dd-analyze` | `0xb407967319d5…` | 60000 |

⭐ **`/api/*` RESOLVES ON PRODUCTION** — unlike the draft, where it served SPA HTML. Identical payTo,
identical price, `subjectPreview` live on both. **The `MEASURED vs INFERRED` row for production
split-brain moves to MEASURED.**

**Step 5 — `resource` is CLEAN: `https://app.tikpema.xyz/…`, no doubled host.** The draft's
`…tikpema.xyz.tikpema.xyz` was the draft's own hostname, never a code defect — now confirmed on the
live surface rather than inferred.

⭐ **CANONICAL PATH: `https://app.tikpema.xyz/api/dd-analyze`.** Platform-independent, survives a move
off Netlify, and is the string a listing must carry. The functions path stays for diagnostics — it
tests the SERVICE rather than the ROUTING. ⚠️ **The two `resource` values differ by design** (it binds
to the URL actually hit), which is exactly why one had to be named before exposure: changing it later
invalidates anything pointing at the other.

### ⚠️ THE REFUSAL WINDOW WENT UNMEASURED — that is not the same as zero

The deploy published just before `:40`, the `*/10` canary tick fired, and the first probe at
**17:40:33Z** already got a 402. **No 503 was ever observed.**

🚨 **THAT WAS LUCK, NOT METHOD, AND IT MUST NOT BE RECORDED AS A RESULT.** Deploy duration varies
15–28 min against a 10-minute period, so landing near a tick is not controllable. **This run produced
NO evidence about the window's typical size** — treat it as unmeasured, not as measured-at-zero. Same
discipline as everything else here: an absence of observation is not an observation.

### 🚨 THE WINDOW IS NOW A SITE-WIDE, PUBLIC-FACING PROPERTY — and it is the TOP priority

**It fires on EVERY deploy to this site — bridge, research, agent, anything — not only DD deploys.**
Any deploy rotates the deploy id, which rotates the health key, and `dd-analyze` then refuses
`service-unverified` for up to the `*/10` period. Before today that was an internal inconvenience.
**DD is now a public service, so it is a public outage on every unrelated deploy.**

Escapes, each checked and closed: **manual canary trigger** — no, it is scheduled on prod, so 403;
**shorten the cron** — bounded by `MIN_RERUN(5m) < cron < TTL(30m)` plus `TTL ≥ 3×cron` and
`TTL < 4×cron`, leaving only `7.5 < c ≤ 10`, and `*/10` is suite-pinned exactly; **pre-warm the key**
— impossible, it contains a deploy id that does not exist until deployed; **loosen the binding** —
reopens the fail-open the build binding closed. ⭐ It is **fail-closed** (503 → no 402 → no
authorization can be signed), so it costs availability, never money.

### 🚨 THE REVENUE WALLET IS NO LONGER A CONTROLLED NUMBER

**`0.120000 USDC` was two KNOWN purchases, both ours.** From this deploy onward it is a **public
endpoint quoting a real price to anyone who finds it.**

⭐ **A BALANCE CHANGE IS NOW THE ONLY SIGNAL THAT SOMEONE EXTERNAL BOUGHT SOMETHING** — and nothing
watches it. There is no monitor, no alert, no ledger. The first external sale will be discovered by
someone happening to run a chain read.

⚠️ **This also degrades the reconciliation property.** The wallet's zero-history was what made
aggregate `availableBalance` attributable, and that worked because **every credit was one we made**.
With external buyers, the aggregate read can no longer be assumed to correspond to a purchase we
know about. It is still sound for "did the balance rise", but **"which payment" is now genuinely
unanswerable** rather than merely deferred — and `authorizationState` reverts on
`GatewayWalletBatched`, so the exact per-payment read remains unavailable.

### ⭐ ORDER OF THE NEXT THREE — deliberately reordered at exposure

1. **THE REFUSAL WINDOW.** Promoted to first because it changed character: site-wide, public-facing,
   and triggered by deploys that have nothing to do with DD.
2. **A MONITOR.** The service is live and unwatched. Until one exists, an external sale is invisible
   and so is an outage. ⚠️ Note the shape from [[strong-read-watch-monitor]]: silence must be the
   healthy signal, and liveness must be a value advancing — never an alert arriving.
3. **THE SUPERSESSION DOC.** Deliberately LAST. It is the **listing** precondition, and listing is not
   imminent — so **nobody is verifying `tokenURI(851891)` yet**. And because the frozen doc is
   commit-scoped to `3e27042`, it stays **honestly out-of-date rather than wrong** in the meantime.
   ⚠️ It becomes urgent the moment a listing is real, because a listing is exactly what brings
   verifiers to a document that denies signing exists.

**NO MONEY MOVED this round.** Revenue wallet steady at `0.120000`; both handles still redeemable.

---

## 2026-08-11 (pm) — THE BUYER NOW LEARNS THE COVERAGE CASE BEFORE PAYING. Plus both directions of the schedule conflict, gated.

**Draft `6a7b3db92363d31633c5b6a8`, commit `61cd6e7`, tree `931f6666…`. Production INERT throughout.
NO MONEY MOVED this round** — revenue wallet steady at `0.120000 USDC` from the two earlier purchases.

### The gap: honest terms are not informed consent

The thin purchase charged full price for a report covering **1 of 12** catalogue items. That is the
design working — but a stranger decides from the **402**, and *"a report that could check little"*
reads as *"occasionally fewer checks"*, not *"one item"*. **The seller could tell in advance**
(`eth_getCode` is one call, and the subject is named in the request that triggers the challenge)
**and did not say.**

Three changes, one deploy: `subjectPreview` (a real chain read at quote time), a stated **floor** in
`coverage`, and a new **`priceIsFlat`**.

⭐ **THE FLOOR AND THE REASON SHIP IN THE SAME BREATH, and that ordering is the point.** Disclosing
*"you may get minimal coverage"* alone makes the terms read WORSE, not more honest — the buyer's
immediate question is *"then why full price?"*. The answer is the strongest thing this service has to
say and it lived only in a code comment: **a coverage-scaled price would pay us more for reporting
more coverage — an incentive to overstate the one number a buyer cannot audit before purchase.**
A flat price removes the incentive, so the manifest can be believed.

`notCharged` now resolves a tension it always had with `coverage`: **"there was NOTHING to check" is
an ANSWER and IS charged; "we COULD NOT check" is our instrument failing and is FREE.** Thin coverage
alone is never a refund reason; a broken instrument always is.

### ⭐⭐ THE READ-ONLY VERIFICATION PATTERN — pre-payment disclosure is FREE to prove

**The 402 is issued BEFORE payment, so both live `subjectPreview` branches were proven at zero cost:**

| subject | bytecode | `hasCode` | `expectedCoverage` |
|---|---|---|---|
| `0x6db396c1…` | **0 bytes** | `false` | **MINIMAL** |
| `0x0077777d…` | **163 bytes** | `true` | **NOT PREDICTED** |

Both HTTP 402, both `basis:"predicted"` / `observedAt:"quote-time"`, the `9` derived from
`POWER_SIGS` at runtime rather than transcribed.

⭐ **GENERALISE THIS: any future change to pre-payment disclosure is verifiable for free, on a real
deploy, by POSTing for a 402 and reading the body.** No purchase, no settlement wait, no money at
risk. The paid path costs $0.06 and ~13 minutes per iteration; the disclosure path costs nothing —
so there is no excuse for shipping unverified copy on the pre-payment side. ⚠️ It does NOT extend
past the 402: anything in the delivered report still needs a real purchase or the suite.

### ⚠️ THE THIRD STATE IS SUITE-ONLY — two green branches do NOT imply three

**`could-not-read` (RPC failure at quote time) has never executed against a live server** and cannot
be induced without breaking RPC. It is proven by INJECTION only — throw, malformed reply, null, bad
address, missing address all resolve to `UNREADABLE` with `hasCode:null`, `expectedCoverage:null`.

🚨 **DO NOT LET THE PASS RATE SPEAK FOR IT.** `verify-subject-preview.mjs` is 55/0, and that means the
branch is **specified**, not that it has **run**. Same family as [[binding-tested-across-what-it-binds]]
— and *this very session* produced the cautionary case: a suite went green on `dd-canary` schedule
coverage that did not exist, because it asserted against the COMMITTED file.

⭐ **The design rule it encodes is the one that matters:** a failed read must never default to "has
code" or "full coverage". It renders `null` and **denies both readings in words** — *"NOT a statement
that the address has code, and NOT a prediction of full coverage… a no-code address is entirely
consistent with this result."* A new field is a new place for [[absence-must-never-read-as-safe]].

### ✅ PROVEN PROPERTY — THE ENTITLEMENT SURVIVES A REDEPLOY AND A NEW DEPLOY ID

**Observed, not argued from the comment.** Both handles were redeemed against a **different deploy**
than the one that sold them, after two intervening deploys:

| handle | HTTP | attestation | coverage | subject |
|---|---|---|---|---|
| `397b67b1-76fe-4578-9b88-ccf1e3773a3b` | **200** | signed | 15 / 0 | `0x0077777d…` |
| `e7e855fb-f477-4c49-bf42-f728289cd5c1` | **200** | signed | **1 / 11** | `0x6db396c1…` |

⭐⭐ **THIS IS WHAT MAKES "the entitlement never expires" TRUE RATHER THAN INTENDED.** Two mechanisms
were only ever *asserted* before: `getStore(PENDING_STORE)` is **site-scoped, not deploy-scoped**, and
**retrieve sits at rung −0.5, ahead of the health gate at rung 0**. A new deploy id orphans the health
artifact — and the handles redeemed anyway. **Retrieve works across deploy boundaries.** The 402
advertises `entitlementNeverExpires: true`; that promise is now measured across the exact event most
likely to break it.

⚠️ **A FABRICATED HANDLE NEARLY BECAME A FALSE ALARM ABOUT THIS.** The second handle was first tried
with a UUID **invented to fill an ellipsis** (`e7e855fb…` was truncated in the request; the remainder
was made up rather than looked up). It 404'd — correctly — and that 404 read exactly like *"the thin
entitlement did not survive the deploy"*, i.e. a defect in the property under test. ⭐ **The fix is
the rule: enumerate identifiers FROM THE STORE, never from memory or from a truncated display.**
Same family as every other invented-value failure here.

### 🚨 BOTH DIRECTIONS OF THE SCHEDULE CONFLICT ARE NOW GATED (`59fd8f8`)

**The same stanza is CORRECT for production and FATAL for a draft. That conflict is permanent** — and
each direction cost real time on the same day:

* **morning** — schedule left COMMENTED, promotion gate exited 0 anyway (`37cfefd`).
* **afternoon** — schedule correctly RESTORED, then a **draft deployed with it active**. On a draft
  `dd-canary` **403s on HTTP invoke AND its cron does not fire**, so it is unreachable by BOTH routes:
  no health artifact can exist, `dd-analyze` refuses `service-unverified` at rung 0, **no 402 is ever
  issued**. The draft was unusable the moment it was built. **~25 minutes lost.**

⭐⭐ **NO PROVENANCE CHECK CAN CATCH EITHER DIRECTION.** `netlify.toml` is outside the stamp's hashed
surface — both builds that day produced the **byte-identical** tree `931f6666…`. Only a gate reading
the working tree can see it.

**`npm run gate:draft`** refuses a draft while a draft-invoked schedule is restored; `gate:watch`
still refuses production while one is commented. Both proven in both directions.
🚨 **AND BOTH ARE NOW WIRED INTO THE DEPLOY COMMANDS** — `deploy:draft` / `deploy:prod` run their gate
first, and npm's `&&` halts on failure (**proven**: with the schedule commented, `deploy:prod` exits 1
and **no `vite build` line is emitted** — the build never runs). There had been **no deploy script at
all**, so `gate:watch` was guarded purely by habit; wiring only the new gate would have left the old
one depending on memory. ⚠️ **HONEST BOUND:** `netlify deploy` invoked directly still bypasses both,
exactly as `--no-verify` bypasses the pre-commit hook. This makes the guarded path the easy path; it
cannot make the unguarded one impossible.

### ⭐ THE RESTING STATE AFTER THE RESTORE — state it, so nobody rediscovers it by losing 25 minutes

`netlify.toml` is restored to the committed shape (`dd-canary` scheduled). **The consequence is
asymmetric and worth knowing before you next reach for a draft:**

* ✅ **THE EXISTING DRAFT `6a7b3db92363d31633c5b6a8` STAYS USABLE.** Its `netlify.toml` is **baked
  into the deployed artifact** with the schedule commented, so its canary remains HTTP-invocable and
  its health artifact refreshable. Restoring the file in the repo does not reach back into a deploy
  that already shipped. Both handles stay redeemable regardless (proven above).
* 🚨 **A NEW DRAFT CUT FROM HEAD WOULD HAVE `dd-canary` SCHEDULED** — 403 on HTTP invoke, cron does
  not fire, **no artifact, no 402**. Unusable for a DD proof the moment it is built. That is exactly
  the failure `gate:draft` now refuses, and the reason it is wired into `deploy:draft`.

⭐⭐ **THEREFORE `gate:watch` GREEN / `gate:draft` RED IS THE CORRECT RESTING STATE FOR THIS REPO,**
because HEAD is production-shaped. **A red `gate:draft` on a clean HEAD is not a defect and must not
be "fixed"** — it is the gate correctly reporting that HEAD is not draft-shaped. Comment the stanza
out when you want a draft, restore it when you are done; the two gates disagree by design and always
will, and that disagreement is the signal, not noise.

### Commits

`61cd6e7` subjectPreview + floor + priceIsFlat (`verify-subject-preview.mjs` 55/0, wired into
`test:dd`) · `59fd8f8` both-direction schedule gate + deploy wiring (`test:watch` 212/0).

**Restore verified three ways:** `netlify.toml` byte-identical to HEAD (`git diff --quiet`);
`gate:watch` exit **0** and `gate:draft` exit **1** — the disagreement above; and the existing draft's
`dd-canary` still answering **HTTP 200**, which measures the "baked into the artifact" claim rather
than arguing it.

---

## 2026-08-11 — 🎉 THE DD SERVICE TOOK ITS FIRST REAL PAYMENT. And the probe called it a failure.

**Draft `6a7ada8e57557d271adc561e`. Production INERT throughout** (`DD_PUBLIC_ENABLED` and
`DD_PAYTO_ADDRESS` both *"No value set"* at start and end; never `--context all`).

**402 → pay → 202 + handle → retrieve → 200, end to end, on real money, for the first time on any
surface.**

```
handle       397b67b1-76fe-4578-9b88-ccf1e3773a3b        polls 353
elapsed      798.5s  (13.3 min — INSIDE the measured 42s–15.5min band)
revenue      0 → 60000 atomic = EXACTLY 0.060000 USDC    (chain read, availableBalance)
report       refusal:null · coverage 15 checked / 0 not
attestation  signed · agentId 851891 · canon/1
             verifyAttestation vs live Arc → valid:true reason:"ok" method:"erc1271"
             keyClass:"registered" · ownerOnChain 0xc54D4721… · block 56435867
```

⭐ **THE JSON IS THE HANDLER'S WORD; THE CHAIN IS THE WITNESS.** Both agree, and they were read
independently — the operator ran the same `availableBalance` call by hand before and after.

### ⭐⭐ THE FINDING: A SUCCESS PATH IS THE LEAST-TESTED CODE IN A FAIL-CLOSED SYSTEM

The probe printed **`❌ 1 CHECK(S) FAILED`** and exited 1 on a transaction that had just succeeded
completely. Its assertion read `b.data.report`; `payX402`'s 200 branch returns the seller's response
under **`sellerBody`**, and there is no `data` key — there never was. So `executed:true`,
`payment.confirmed:true`, `polls:353`, HTTP 200 and a chain-verified signature all fell through to a
generic `else` that said "unexpected outcome".

🚨 **THAT ASSERTION HAD NEVER EXECUTED ONCE IN THE SERVICE'S LIFE.** Not "was under-tested" — had
**literally never run**, because there had never been a success for it to run on.

⭐ **THE CLASS, WHICH IS THE REUSABLE PART: FAILURE PATHS GET EXERCISED BY ACCIDENT; SUCCESS PATHS
ONLY BY SUCCESS.** Every refusal, gate, timeout and 503 on this path had been hit dozens of times
across three sessions — by draft misconfigurations, stale artifacts, routing misses, exposure flags.
The one branch that requires everything to go right had zero exercise. **In a fail-closed system that
has never succeeded, the success branch is by construction the least-tested code in it**, and it is
also the branch nobody thinks to review, because attention follows failures.

⚠️ **THIS NOW APPLIES TO EVERY OTHER FIRST-SUCCESS BRANCH ON THE PAID PATH.** Each of these has now
run exactly once (some zero times): the 200-serve branch, the `served:true` re-read, the settle
receipt decode, the confirmed-payment evidence block. **Treat "it worked once" as the beginning of
testing that branch, not the end.** The `--handle` redemption path was live-tested immediately after
this fix for exactly that reason (green, exit 0).

**Fixed:** the probe reads the shape defensively (`sellerBody.report` → `data.report`), and — more
importantly — an `executed:true` with **no report at any known key** now fails LOUDLY, names the
top-level keys actually present, and tells the operator to check the handle before concluding
anything. A generic "unexpected outcome" is what disguised a complete success as a failure.
Verified by replaying the REAL sold payload: every check resolves, and the old assertion resolves
`false`.

### 🚧 THE NOW-UNEXERCISED BRANCH — the THIN report, and it is the most-argued one in the design

**The sold report was `15 checked / 0 notChecked` — full coverage. So the settle gate's
THIN-REPORT-STILL-SETTLES path has never run on real money.**

⭐ **THE MOST DEBATED DECISION IN THIS SERVICE IS THE ONE NO PURCHASE HAS TOUCHED.** "A report that
could check little still settles and is still the product" is asserted in the 402's own
`whatYouAreBuying.coverage` — we are *selling* that promise — and it is proven by injection only.
Its neighbour is proven the same way and matters as much: **the engine failing to produce an answer
returns the report FREE with the authorization unspent.** Those two branches decide, on live money,
whether a caller is charged.

🚨 **BUY A DELIBERATELY THIN SUBJECT BEFORE ANY LAUNCH — an address with little to check (an EOA, or
a contract with no recognised powers). ~$0.06.** Discovering that branch with a paying stranger is
the expensive way, and the failure mode is the worst available: charging full price for a near-empty
artifact, or refusing to settle something we advertised as sellable. Neither is recoverable by
apology.

### Also this session — two real defects, both found while proving something else

1. **`gate:watch` NEVER GUARDED `dd-canary`** (`37cfefd`) — the one schedule a draft proof *must*
   comment out. The gate exited 0 with it commented, while PROGRESS.md's standing constraint AND
   `verify-strong-read-watch.mjs`'s own comment both asserted coverage. `verify-strong-read-watch`
   reads `git show HEAD:netlify.toml` — the COMMITTED file — by design, so it is structurally blind
   to working-tree drift; only half the division of labour was implemented. Now an exported
   `GUARDED_SCHEDULES` table, proven **both** directions (exit 1 commented, exit 0 restored).
2. **`_x402.mjs` HAD NO `AbortSignal` ANYWHERE** (`2fcedbf`) — a stall produced no persist, no
   handle, no money **and no error**. Per-stage deadlines with named stages (challenge 20s / sign
   30s / settle 90s / retrieve 20s). ⭐ **A settle timeout reports `charged: NULL`, never `false`** —
   aborting stops US waiting, not the seller, and `charged:false` invites the retry that is a double
   pay. Shared production money path: `_research.mjs` buys data through it.

### 🚨 DEBUGGING DISCIPLINE — three sessions chasing a stall that did not exist

**There was never a hang. There was settlement nobody waited out.** 798.5s is well inside the
measured band. Every earlier "hang" was almost certainly a normal batch flush, and the reason it was
unreadable is that **silence carried no timestamps**. The heartbeat ticker — 53 lines, 15s→795s —
converted "it hung" into "it is 13 minutes into a 15-minute window."

1. ⭐⭐ **THE INSTRUMENT MUST BE VALIDATED IN BOTH DIRECTIONS BEFORE A NEGATIVE MEANS ANYTHING.**
   Log absence was read as "the request never arrived" until five known-good origin hits were fired
   and confirmed to appear within ~19s, and the 402 was shown to be **never cached**
   (`cache-control:no-cache`, durable `fwd=bypass`, edge `fwd=miss`, distinct `x-nf-request-id`).
   Only then was a negative worth anything.
2. ⚠️ **FOUR HYPOTHESES MEASURED AND REFUTED** — Arc RPC throttle (115–138ms), Node fetch (54–159ms),
   proxy env vars (none), lingering processes (none). All refuted, none of them the answer, because
   **the premise — that something was stuck — was itself never measured.**
3. ⭐ **AN `awk` FILTER SILENTLY PRINTED EVERYTHING** (the `[𝒇 name]` prefix shifts field positions),
   nearly turning a filtered read into a false conclusion. Same family as
   [[filtered-read-is-not-absence]]: **read the unfiltered listing.**
4. ⭐⭐ **THREE OF THE NEW SUITE'S OWN CHECKS FAILED AGAINST CORRECT CODE**, each a documented
   failure mode: the settle window caught `charged:false` from the **comment forbidding it**;
   `indexOf` found the settle guard instead of the outer catch, pointing three assertions at the
   wrong block *while looking authoritative*; and a bare-`fetch` count matched **fetchStage's own
   implementation** (fifth instance of a checker including itself in its corpus). Fixed by stripping
   comments, delimiting by code landmarks, `lastIndexOf`, and asserting the **expected count** (=== 1)
   rather than zero.

### The frozen service doc — corrected in a mirror, not edited

`agent-metadata/dd-service.MIRROR-README.md`. **FOUR** claims were stale, not one: x402 metering,
HTTP interface, signed reports (including *"dev/throwaway key only, no registered service
identity"* — now an ERC-1271 attestation bound to registered agentId 851891) and canary/liveness.
⚠️ `mutable_companion` is **`null`**, so the frozen doc points nowhere; the mirror is discoverable
only from the repo, and says so. `dd-service.json` verified **byte-intact**, sha256
`d3734acc…` == the registered value, so `tokenURI == CID` still discriminates 851891 from 851823.

### State

Draft `6a7ada8e…` live; canary artifact deploy-id-bound. `netlify.toml` restored byte-identical to
HEAD, `gate:watch` green. `test:dd` 13 suites green · `test:watch` 207/0 · `test:probe` 71/0.
⚠️ Tree hash is now ahead of the deployed draft (`_x402.mjs` changed) — **the draft was NOT
redeployed**, deliberately, since that would mint a new deploy id and invalidate the health artifact.

---

## HANDOFF — start here. Current as of 2026-07-31.

⚠️ **THIS ENTRY IS AUTHORITATIVE FOR CURRENT STATE.** Everything below it is DATED and describes what
was true when written — several entries correctly say things like "facilitator (not built)" or quote
`6a69be4f` as a rollback target. Those were accurate then and are history now. Do not read a dated
entry as current.

### 🚨 IDENTIFIER RULE — READ THIS BEFORE ANY HEX STRING

| length | what it is | example |
|---|---|---|
| **24 hex** | **NETLIFY DEPLOY ID** | `6a6c2a74b0db965c94b85a3b` |
| **40 hex** | **GIT COMMIT SHA** | `de60384…` |

⭐ **The length is the discriminator.** Conflating these cost hours. The trap is live: the health
store holds a key ending in a **40-hex COMMIT** in a slot that now carries **24-hex DEPLOY IDs**,
left over from when `DD_BUILD_ID` (a commit) was the build source.

### IS PROD HEALTHY? — two commands, no interpretation

    curl -s https://app.tikpema.xyz/.netlify/functions/blobs-probe
      EXPECT: "verdict":"D"  AND  "calibrated":true      <- anything else, including UNCALIBRATED, is a FAILURE
              arms A=consistency-error  B=ok  A=consistency-error
              selfChecks: []

    netlify blobs:get strong-read-watch latest
      EXPECT: ok:true, reason:"ok", notify.kind "steady-ok"/"first-ok"
              producedAt ADVANCING on ~15 min

⚠️ **SILENCE IS THE HEALTHY SIGNAL.** The watch pushes on TRANSITIONS only, so no Discord message is
the expected steady state. Liveness is `producedAt` advancing — **never** an alert arriving.
⚠️ A 200 proves nothing on its own: an unmatched Netlify path returns **SPA HTML with status 200**.
Judge by body, never by status.

**Current:** production **[DEPLOY ID]** `6a6dea1ff6e9ccf6b543c031`, built from **[COMMIT]** `1955667`,
**`dirty:false`**. Rollback target is the prior published deploy `6a6ddc3a087fae16cef2c0de`.
Live here: plan-path bridge receipts, per-step consent + pre-flight re-price, the
IRIS-unreachable/band message split, and the structurally pinned band vocabulary.

Verified green here: `blobs-probe` **verdict D / calibrated true**, `selfChecks: []`, deploy id from
`x-nf-deploy-id`, stamp clean. ⭐ **`gate:watch` now REFUSES a dirty surface** (`f06469e`) and ran
before every deploy in this run.

### ✅ BRIDGE RECEIPTS — the direct path now records what the money DID, and proves it

**Shipped and proven on real money 2026-07-31 → 08-01.** The direct BridgePanel path kept
`burnHash` in component state (a reload stranded the user) and reported the amount REQUESTED, never
the amount that ARRIVED. Those were one gap. Server-side receipts keyed `o/<owner>/<burnHash>`,
a chain-verifying settler, an owner-scoped read, and a scheduled sweeper now close it.

⭐ **`delivery` advances `predicted → measured` on EXACTLY ONE PATH:** a destination-chain read that
returned `verified`. Deadline, poll exhaustion, RPC error and IRIS/chain disagreement all leave it
`predicted`. Both failure directions point at LESS claim, never at an arrival that did not happen.

**FOUR INDEPENDENT CHAIN MATCHES — receipt value == chain value, to 6dp:**

| burn | requested | fee | delivered (receipt) | chain |
|---|---|---|---|---|
| `0x0175cf7b…` | 1.0 | 0.053196 | **0.946804** | 0.946804 |
| `0xd65544dc…` | 1.0 | 0.053203 | 0.946797 | 0.946797 |
| `0x54678bf3…` | 1.0 | 0.053199 | **0.946801** | 0.946801 |
| `0x44bbdc76…` | **0.1** | **0.053212** | **0.046788** | 0.046788 |

🚨 **READ THE LAST ROW.** `fee 0.053212 > delivered 0.046788` — MORE WENT TO THE FEE THAN ARRIVED.
At the 2dp the UI used to render, both printed `~0.05` and that fact was **invisible**. The fee is
FLAT (the IRIS fee endpoint takes no amount parameter), so the ratio worsens as the amount shrinks.
**Never render a bridge amount at 2dp.** Measured drift on ONE route in ONE day: 0.0541 → 0.053520 →
0.053196 → 0.053212 → 0.0533, which is also why the copy renders `feeUsdc` and never a literal.

**THE THREE BUGS, EACH PROVEN FIXED ON REAL DATA:**

1. **The trigger was never sent.** `fetch(...).catch()` un-awaited — a Netlify function can freeze
   the moment the handler returns. `0x0175cf7b…` sat at `burn_confirmed` for **7h58m** while its
   mint had already landed. ⚠️ The identical warning was written twelve lines below it over the
   receipt write; the lesson was applied to the write and violated for the trigger in the same
   function. Fixed → two bridges settled in **21s and 25s** with `settle trigger sent … status=202`.
   ⚠️ The suite had pinned the BUG as an invariant ("the trigger is NOT awaited"), conflating
   *don't host the poll* with *don't await the trigger*. It passed for the defect's whole life.
2. **The deadline spoke before IRIS was asked.** A stranded receipt is past deadline BY DEFINITION —
   that is what recovery selects on — so a recovered settler wrote `mint_unconfirmed` without ever
   asking whether the mint landed, and `mint_unconfirmed` counted as terminal, making it PERMANENT.
   ⭐ **RESOLVED vs PROVISIONAL:** "we stopped waiting" is not "it did not arrive". Fixed → ask
   first, deadline only speaks about an unresolved mint; provisional receipts are re-checkable.
3. **Recovery needed a human to be looking.** It rode the owner-scoped read, which needs a live
   session **and** the owning wallet **and** a route that calls it. All three failed independently
   over hours. ⭐ **The case only a cron covers: a user who bridges once and never returns.**
   `bridge-mint-sweep` (`*/10`) → first tick: `scanned=11 stranded=2 triggered=2 remaining=0`,
   both settled 2s later, **no wallet, no page load**.

**CONSENT.** `bridgeFeeBand()` decides once and is threaded (the refundClass pattern) — warn ≥10%,
acknowledge ≥25%, fee-floor refusal unchanged. Above the acknowledge band `_actions` REFUSES until
the caller returns an ackToken it recomputes itself (the vault `gateDeposit` shape). The token binds
to owner|destination|amount|**band** — not the exact fee, or every tick would invalidate it and
train people to click through. `ackBand`/`feeRatio`/`ackAcceptedAt` persist on the receipt.
🚧 **UNEXERCISED: the `acknowledge` band has never fired against a live server**, so `ackAcceptedAt`
has never been written. Every live bridge was 1.0 at 5.3%.

⚠️ **THE SAME BRIDGE BEHAVED DIFFERENTLY BY SURFACE.** The Bridge page disclosed and gated; the
agent panel — the plain-language surface users actually reach — was refused server-side with no
disclosure and no way to accept. **The honest path was the one users were least likely to find.**
`agentClient.bridge` carried no ackToken. One missing wiring, two symptoms: `loadReceipts` lives on
the same path, so bridging from the agent panel never called `/api/bridge-receipts` either.

### ✅ (CLOSED 2026-08-02 — SEE THE RESOLUTION ABOVE) an ack box fired where no gate was required

🚨 **DO NOT RE-INVESTIGATE THIS.** The box was **correct and earned** — a 0.1 USDC step was
genuinely priced — and **the plan was never confirmed**, so it produced no receipt at all. The
1.0 USDC receipt below came from a different run. Every branch enumerated here rests on a join
between the box and that receipt that was **inferred, never observed**. The text is kept only
because the reasoning error is worth seeing; **its conclusions are void.**

**Written as UNRESOLVED on 2026-08-01, deploy `6a6dea1ff6e9ccf6b543c031`.** A plan was run with the intent of exercising the acknowledge band.
The ack box **appeared and was ticked** — but the only new receipt was:

    0xe98e31697a…  requested 1.0000  fee 0.0537  feeRatio 5.4%  ackBand none  minted/measured

5.4% is **below the 10% warn threshold**, so that step correctly required no acknowledgment. **The
box was not for that step.** Three shapes, unresolved because the plan card was not read out:

  (a) a 0.1 step WAS priced (box correct) but only the 1.0 executed
  (b) the 0.1 ran AFTER the 1.0 and was refused/errored, leaving no receipt — the executor stops at
      the first failure, so a later step that never ran leaves no trace in the store
  (c) "bridge 0.1" became 1.0 somewhere between the phrasing and the quote (model or parsing)

🚨 **EITHER BRANCH MATTERS, AND THE SECOND IS WORSE.** If a 0.1 step existed and did not execute,
that is a plan-path defect. **If the plan held only 1.0 bridges, then an ack box rendered where no
gate was required — and a gate that fires spuriously TRAINS CLICK-THROUGH AND DESTROYS ITS OWN
VALUE.** A consent control that appears when it should not is not a harmless false positive; it is
the mechanism by which the control stops being read at all.

### ✅ CLOSED — THE ACK ANOMALY WAS NEVER A DEFECT. The box was correct and earned.

**Resolved 2026-08-02 by reading the plan card that had been open in a browser tab since
14:37Z — the artifact the original entry said was never read out. It was still there.**

The card reads: step 2 = **"bridge 0.1 USDC to Base"**, priced, with the acknowledge box. So a
0.1 step WAS quoted — **shape (c) is dead**, nothing rewrote the amount between the phrasing and
the quote, and the gate fired exactly where it should have. And:

    step 1: NO mark.   no "Plan blocked — …" line.   "Confirm & execute" STILL SHOWING.

⭐ **That triple means the plan was NEVER CONFIRMED.** Nothing was executed, so of course no
receipt bearing an acknowledgment exists. The 1.0 USDC receipt came from a **different run**.

🚨 **WHY IT SURVIVED AS AN ANOMALY: THE LINK BETWEEN THE BOX AND THE RECEIPT WAS AN INFERENCE,
NEVER AN OBSERVATION.** Two facts were true — a box appeared, and a 1.0 bridge landed — and they
were joined by assumption. Every branch of the original entry ((a) priced but not run, (b) ran and
refused, (c) amount changed) presupposed that join. It was false, so all three branches were
answers to a question that did not exist. The same shape the debugging-discipline section below
already records: **a conclusion drawn from something that was never measured.**

⚠️ **THE ORIGINAL ENTRY ALSO MIS-ATTRIBUTED THE RECEIPT.** It named `0xe98e31697a…` as "the only
new receipt". The unfiltered log shows **TWO** plan runs that afternoon, each producing exactly one
1.0 USDC bridge at band `none`:

| quote | executor | burn | requested | fee | ratio | band | ackAcceptedAt |
|---|---|---|---|---|---|---|---|
| `agent-act` 14:08:49Z (1832ms) | `agent-execute-plan` 14:08:53Z (13039ms) | `0xe98e3169…` | 1.0 | 0.053669 | 5.4% | none | null |
| `agent-act` 14:37:27Z (1690ms) | `agent-execute-plan` 14:37:31Z (8924ms) | `0x1675ce4b…` | 1.0 | 0.053588 | 5.4% | none | null |

Neither is the card's plan. `ackAcceptedAt` is null on **all 11** receipts for
`0xfd801d08…`, consistent throughout.

### 🚨 THE PLAN CARD CANNOT DISTINGUISH "REFUSED" FROM "NEVER REACHED" — and that is three silences

**Found while closing the above; NOT yet fixed. Deliberately recorded before building.** A
server-side refusal on the plan path leaves **no receipt, no persisted outcome, and — in one case —
no visible mark**. Three independent silences for one event, which is why an unexecuted plan looked
like an executed one.

Reading `MyAgentPanel` (`mark = !r ? "" : r.ok ? " ✓" : " ✗"`), there are THREE cases, not two:

1. **A step that STOPPED the plan** (per-action cap, day ceiling, `executeAction` refusal) IS in
   `results` with `ok:false` → renders **✗ and the reason**. Already distinguished; fine.
2. **A step NEVER REACHED** (after the stop) has no entry → renders **blank**.
3. ⭐ **A WHOLE-PLAN PRE-FLIGHT REFUSAL** (the ack gate, or IRIS unreachable) returns
   `{executed:false, blocked, needsAck}` with **NO `results` array at all** → *every* step renders
   blank, and the only trace is one plan-level `Plan blocked — …` line.

**3-vs-2 is the ambiguity.** ⭐ The fix is cheaper than it looks: that refusal response **already
carries `stepDisclosures` keyed by the step index it refused**, so the data needed to mark the
right step is in the payload and simply is not used. Render the named index as refused-with-reason
and the remainder as explicitly not-run; then persist per-step outcomes, not only bridge receipts —
which is the same gap as "**the plan ran** is not persisted anywhere".

⚠️ Do NOT let the card's *absence of a mark* mean anything until then. Here it meant "never
confirmed", and it reads identically to "refused".

### 🚧 BACKLOG — THE PLAN TOTAL SUMS WHAT IS **TOUCHED**, NOT WHAT IS **LOST**

**Found in the first live quote record, 2026-08-02. Not fixed; deliberately NOT folded into the
cache fix.** The record for `"swap 1 usdc to eurc and then bridge 1 usdc to base"` reads
`totalUsdc: 2` — and the card says *"This is a 2-step plan totaling ~2.00 USDC"*.

⭐ **BUT ONLY THE BRIDGE TAKES MONEY OUT.** The swap stays with the user and changes denomination.
About **1 USDC plus the fee** actually leaves; `~2.00` reads as the cost and is nearly double it.
`totalUsdc` is `Σ valueOfStep`, which is a **cap-checking** quantity (what each step touches, the
right basis for a per-action bound) being reused as a **user-facing cost**. Two different
questions, one number.

⭐ **THE VOCABULARY ALREADY EXISTS IN THIS PRODUCT** — the dashboard distinguishes *"This leaves
you"* from *"Stays with you — only the denomination changes"*. The plan summary should say the same
three things: **what leaves, what stays, and the fee.**

⚠️ Same class as the two disclosure bugs already fixed on this path: the plan total that omitted the
bridge fee entirely, and the bridge that reported the amount REQUESTED rather than the amount that
ARRIVED. Each time, a number that was correct for an internal purpose was rendered as if it answered
the user's question.

### 🚧 BACKLOG — A RENDERED PLAN OUTLIVES ITS SESSION AND LOOKS IDENTICAL TO A FRESH ONE

**THREE PHANTOM RUNS IN TWO DAYS, ALL THE SAME MECHANISM. Not yet fixed; recorded before
building.** A plan card is `useState` only — nothing persists it, and nothing invalidates it. The
ONLY thing that clears `result` is a change of agent-wallet ADDRESS (`MyAgentPanel` useEffect). A
session expiring, or a card belonging to a tab that never had a session, clears nothing. So a quote
from hours earlier renders **pixel-identical to one just served**, ack box live and tickable.

**What it has cost, three times:**

* 2026-08-01 — the ack anomaly itself. A card from an abandoned quote was read as belonging to a
  bridge from a different run, and the false join survived a whole session (closed above).
* 2026-08-02 ~23:4x — "quote is done" against a card last served at 14:37Z. Zero server traffic.
* 2026-08-02 ~00:0x — "plan ran, confirmed with the box ticked". `auth-challenge`/`auth-verify` at
  23:55:42–51 and `bridge-receipts` ×2 at 23:55:52 prove a **fresh tab with a live session talking
  to the server** — `MyAgentPanel.tsx:90` calls `loadReceipts()` on panel load. Then nothing. ⭐ So
  the connect happened in the NEW tab and the confirm was pressed in an OLD one, whose session
  belongs to a different tab entirely (`sessionStorage` is per-tab). Receipt count stayed 11,
  `agent-quotes` stayed empty, no `agent-act`, no `agent-execute-plan`. Nothing moved.

🚨 **THE CONSENT ANGLE IS WHY THIS IS NOT COSMETIC.** The stale card renders a *live-looking
acknowledge box*. Ticking it feels like consent and produces nothing — and the flip side, a box that
appears where nothing can act on it, is exactly the "gate that fires spuriously trains
click-through" failure the band design exists to avoid. Already noted once in the discipline list
("a stale quote even rendered a live-looking consent box with no session behind it"); it has now
recurred twice more, so noting is not enough.

**FIX (two parts, neither started):**
1. **Invalidate or visibly mark a plan quoted under a session that is no longer present.** Tie the
   card's validity to the session it was quoted under, not to the wallet address. An expired or
   foreign session must make the card say so and refuse to look actionable.
2. ⭐ **MAKE A FAILED CONFIRM LOUD.** `confirmPlan`'s catch sets `planRun.error`, which renders as
   one line *under* the steps — the same near-invisible failure shape as the `loadReceipts` silent
   catch. A confirm that never became a request must not be reportable as "it ran".
3. 🚨 **DOUBLE CONFIRM IS UNGUARDED, AND THE PHANTOM RUNS ARE EXACTLY HOW IT GETS TRIGGERED.** A
   silent no-op invites a second press, and **nothing today distinguishes a repeat confirm of the
   same quote from a new plan** — so one intended bridge becomes two real ones. Disable the button
   on first press, and key execution idempotently on `quoteId` so a repeat is recognisable
   server-side.
   ⚠️ **BOUNDS ON THAT, STATED UP FRONT:** `quoteId` is client-echoed and unverifiable, so this
   makes a repeat **recognisable, never prevented** — a client can withhold or vary the id. And it
   must NOT become an authorization input: the moment a stored quote decides whether execution may
   proceed, the pre-flight re-price is back to being bypassable. Treat a repeat as a signal to
   REFUSE-AND-ASK, not as a fact to trust. (The genuine fix for at-most-once is a server-minted,
   server-stored single-use execution token — a bigger change, deliberately not smuggled in here.)

⚠️ Same family as everything else in this document: **a stale value rendering as current**, and an
absence (no session) with no visible representation.

### ✅ BUILT — `agent-act` NOW RECORDS THE PLAN IT PRICED (the gap below is closed in code)

**Store `agent-quotes`, key `q/<owner>/<ISO>-<quoteId>`. `netlify/functions/_quote-record.mjs`.
Suite `npm run test:quote` (also chained into `test:bridge`) — 66/0.**

The quote branch computed `stepDisclosures` and the totals, handed them to the browser and kept
nothing, so the ack anomaly above was answerable only from a screenshot. It is now persisted:
raw task text, the brain's steps and its `reasoning`, per-step value, per-step `feeUsdc`/`netUsdc`/
`feeRatio`/`band`/`ackTokenIssued`, both totals, the model that priced it, and the caps in force at
quote time. Every field server-sourced; the client sends only `task`.

⭐ **THE JOIN IS THE POINT, AND IT IS ONE IDENTIFIER.** `quoteId` is minted at pricing time,
echoed to the client, handed back on confirm, and landed on every bridge receipt that plan produces
(`quoteId` + `quoteStepIndex`). "Proposed vs ran" is now two lookups against one id instead of a
reconstruction. It is **client-echoed and unverifiable** — a client could send an id from a
different quote — which is acceptable ONLY because it is a pointer: the record it points at holds
the priced steps, so a false join is **detectable on inspection**, never authoritative.

🚨 **DIAGNOSTIC ONLY, AND THE PROHIBITION IS STRUCTURAL.** The next reasonable-sounding idea is the
trap: *"we already have the priced plan stored — validate the confirm against it instead of
re-pricing."* That deletes the pre-flight re-price, whose whole purpose is that the fee is volatile
and an on-screen quote goes stale, and makes a stored client-facing value load-bearing for consent.
⭐ So the module **exports no reader** — no `readQuote`, no `listQuotes`, no `/api` route. Reaching
the data needs the Netlify CLI, i.e. a human deciding to look. The suite fails the build if a
reader appears, if a money-path function imports one, or if the re-price/ackToken recomputation
stops being what decides.

**RETENTION IS A DECISION, NOT A DISCOVERY.** Most quotes are never confirmed, so this store grows
forever by default. **14-day TTL + a 200-per-owner cap**, pruned by the write path itself (no cron
to schedule, notice, or keep alive — the code that creates the garbage collects it), hard-bounded
at 25 deletes per write with the unfinished remainder logged rather than implied away. ⭐ **Two
bounds because either alone leaks:** the TTL cannot stop a burst inside its window, and the cap is
what eventually evicts a key whose timestamp cannot be read.

**TWO DEFECTS THE SUITE CAUGHT IN THE PRUNE ITSELF, BOTH FIXED BEFORE SHIPPING:**

1. **The budget is WALL CLOCK; the TTL is LOGICAL.** Deriving the prune deadline from the caller's
   injected `now` conflated two clocks — the deadline landed in the past and the prune deleted
   NOTHING while correctly reporting a backlog. In production that reads as a store that never
   shrinks, with no error anywhere.
2. 🚨 **`Date.parse` IS LENIENT: `Date.parse("NOT-A-DATE-0")` returns a real year-2000 timestamp.**
   So a key with no date in it read as a definite, ancient one and was deleted for age, while the
   code claimed to be conservative about unreadable dates. Same family as every other bug here
   where an absence quietly filled a result slot. The ISO shape is now checked before parsing.

### ⚠️ A DOCUMENTED FORCED PROMOTE-THEN-PROVE — the quote record (same shape as `_budget.mjs`)

**Shipped to production having never run against a live server.** Every branch is proven by
injection only (66/0), including the handler end-to-end with its network edges mocked and its real
pricing intact.

**Why a draft could not prove it — UNAVAILABLE, NOT SKIPPED.** A quote needs an authenticated
session, and a session needs a real browser wallet connect. Circle client keys are domain-restricted,
the Passkey Domain must match exactly, and `toCircleSmartAccount` derives the account from the
passkey — so a draft origin is **a different owner entirely** and connect fails with "Invalid
credentials". `SESSION_SECRET` is production-only besides. This is the same wall already documented
for `_budget.mjs` and the bridge settler. A draft `6a6e609e14b3bb1227cdccb8` was built and reached
`blobs-probe verdict D`, and could confirm only that `agent-act` deploys and 401s — nothing about
the record.

**Why promoting anyway is defensible here, and would not be in general:**

1. **NOTHING ON THIS PATH MOVES MONEY.** The quote branch proposes; it never executes. The worst
   available outcome is a missing diagnostic.
2. **IT CANNOT BREAK QUOTING.** `recordQuoteNeverThrows` swallows everything and the call site is
   fire-and-continue, suite-proven by injecting a store that throws: the plan is still quoted, with
   its disclosures intact. Same rule as the receipt write, for the opposite reason — the receipt
   write may not throw because the money already moved; this may not throw because a diagnostics
   failure would trade a real capability for an observation.
3. **IT AUTHORIZES NOTHING**, by absence of mechanism (above), so a wrong record cannot become a
   wrong decision.

🚨 **THE PROOF IS NOT DEFERRED, IT IS SCHEDULED:** a two-bridge plan quote on prod (`bridge 1 USDC
to Base then bridge 0.1 USDC to Base`), **stopped at the plan card**, then
`netlify blobs:list agent-quotes --prefix q/<owner>/`. Expect step 1 `band:"none"` and step 2
`band:"acknowledge"` — the exact discrimination the open anomaly lacked. Until that runs, treat the
record as **unproven on a live path**. ⭐ Quoting costs nothing, so unlike the settler this proof has
no price at all — there is no excuse for it to stay pending.

⚠️ **THE JOIN IS COMPLETE ONLY FOR BRIDGE STEPS.** A bridge lands `quoteId` on a durable receipt;
no other step type has a receipt to carry it, so a plan that stopped before its first bridge leaves
only a log line. "The plan ran" is still not persisted anywhere. Stated, not papered over.

### 🚨 (CLOSED IN CODE, ABOVE) DIAGNOSABILITY GAP — `agent-act` DID NOT LOG THE PLAN IT PRICED

The quote is the ONE artifact that answers "what was proposed vs what ran", and it was not kept
server-side. `agent-act`'s plan branch computes `stepDisclosures` (per-step band, fee, net, token)
plus `totalUsdc`/`totalFeeUsdc`, returns them to the browser, and keeps nothing. So the anomaly
above can only be settled from a **screenshot** — which is why it is still open.

⭐ **Logging the priced plan is cheap and would have resolved it in one query:** step list with
types and amounts, per-step band and fee, the totals, and the owner. `netlify logs` carries full
text for non-background functions (proven — see the scoping note below), so it is directly
readable. **This is the first thing to build next session** — not because the log is valuable in
itself, but because this class of question recurs and currently has no server-side answer at all.

⚠️ Same family as the `listByOwner` counts added on 2026-08-01: an outcome that cannot be
distinguished from a different outcome is not an observation. The counts closed that gap for reads;
the priced plan is the same gap for quotes.

### 🚧 THE ACKNOWLEDGE BAND HAS STILL NEVER FIRED LIVE — ON ANY SURFACE

⭐ **AND AS OF 2026-08-02 WE KNOW WHY, WHICH IS NEW.** The one plan that would have fired it — the
0.1 USDC step in the card above — **was never confirmed**. So this is not a gap in the gate; it is
simply a run that was quoted and abandoned. The proof therefore requires **pressing Confirm &
execute** on a plan with a 0.1 bridge step, which is the only step in this whole sequence that
costs money (~0.0536 to fee, ~0.046 arriving). Everything else here — quoting, the record, the
disclosure — is free.

`ackAcceptedAt` has **never been written**. The band classification records correctly everywhere
(`ackBand`/`feeRatio` are on every receipt), and the gate is suite-proven fail-closed, but the
`acknowledge` path itself has not executed against a running server on the Bridge page, the agent
single-action panel, or a plan.

⭐ **ONE RUN PROVES ALL THREE AT ONCE:** a plan with a **0.1 USDC bridge step** exercises the gate,
the per-step token surviving the pre-flight re-price, and `ackAcceptedAt` landing on the receipt.
At a ~0.0536 fee, anything under **0.213 USDC** crosses the 25% threshold. Cost of the proof is the
~0.0536 that becomes fee — which is precisely the loss the disclosure exists to make visible.

### 🚨 DEBUGGING DISCIPLINE — the three hours this cost, and exactly how

**The bugs above took a few edits each. Finding out WHERE they were took hours, and every hour lost
went the same way: a conclusion drawn from something that was never measured.** Recorded because the
failure was in the METHOD, not the code, so it will recur on unrelated work.

1. ⭐⭐ **AN EMPTY LOG WINDOW IS NOT PROOF OF ABSENCE.** Three separate times,
   `netlify logs --since Nm` returned "No logs found" and it was read as "the endpoint was never
   called". Twice the query simply ran BEFORE the invocation it was looking for; the calls were
   there all along, timestamped later. **The instrument was never validated.** The fix that finally
   worked: fire a call you KNOW happened, confirm it appears, and only then trust a negative — and
   always check returned timestamps are later than the event.
2. ⭐⭐ **A BINARY QUESTION CAN ONLY RETURN ONE OF ITS OPTIONS.** Asked "is it wallet A or wallet B?"
   The answer was a THIRD wallet (`0x74b7b561…`), invisible to the question. The instrumented log
   line named the owner outright the moment it existed. **Ask the system, not the person, and never
   offer a closed choice about an open set.**
3. ⭐ **FIVE HYPOTHESES, NONE MEASURED** — wallet not connected, wrong route, stale cached bundle,
   wrong owner, broken `list({prefix})`. Each was inferred from what the screen showed. The counts
   (`matchedKeys=N returned=M`) resolved it in ONE page load. **Instrument earlier: a hypothesis you
   can't measure is a guess, and guesses that look reasonable are the expensive kind.**
4. ⚠️ **`netlify logs` DROPS console output for `*-background` FUNCTIONS ONLY.** An earlier note
   generalised this to all functions — too broad, and it would have discouraged logging where it
   works. `agent-bridge` returns full text; `bridge-mint-settle-background` returns empty `INFO`
   lines. Both appeared side by side in one output.
5. ⚠️ **THE CLIENT FAILED SILENTLY, WHICH IS WHAT MADE ALL OF THIS POSSIBLE.** `loadReceipts`
   swallowed its error and a gated panel looks identical to an idle one, so "I loaded the app and
   accepted the disclosure" and "no request left the browser" were **the same picture**. A stale
   quote even rendered a live-looking consent box with no session behind it. ⭐ **A consent flow
   attached to nothing is not a consent flow** (`606a17b`).
6. ⚠️ **`git add -A` COMMITTED A NON-NULL BUILD STAMP** (`c5d368b`). Caught by `test:probe`, not by
   review. The deployed artifact was fine — `prebuild` regenerates it — but a deploy that skipped
   stamping would then have reported a STALE commit instead of `unresolved`. **Clear the stamp
   before committing, or stage explicitly.**

7. ⭐⭐ **A FILTERED READ IS NOT A MEASUREMENT OF ABSENCE — 2026-08-02, and it cost a full round
   trip.** `netlify logs --function agent-act` returned nothing for the window, and that was stated
   as "the request never arrived" while the user was looking at a rendered plan card. Two errors in
   one move: the filter presupposed which function was involved (a candidate rename would have been
   invisible to it), and `--since 6h` presupposed the window. ⭐ **The unfiltered read settled it in
   one command** — `netlify logs --source functions --since 24h` — and simultaneously refuted the
   rename hypothesis (nothing else ran at all), proved no session was ever established (no
   `auth-challenge`/`auth-verify`), and surfaced a SECOND plan run that a `tail -30` had silently
   cropped out of an earlier read. **Read the whole listing before concluding anything about what
   did not happen; a `grep`/`tail` on a diagnostic listing is itself an untested hypothesis.**
8. ⭐⭐ **ASK FOR THE DISCRIMINATOR, NOT THE INTERESTING FIELD.** Closing the ack anomaly, the
   obvious thing to read out was step 2 — the step with the box on it. Step 2 could not distinguish
   any of the branches. **Step 1's mark could**, and so could two things nobody had thought to ask
   for (whether a `Plan blocked` line was present, and whether the confirm button was still
   showing). The right question came from enumerating what each possible answer would RULE OUT,
   which is a different exercise from asking about the part that looks suspicious.

⭐ **THE COMMON SHAPE, AND IT IS THE ONE THIS REPO KEEPS RE-LEARNING:** an absence — no logs, no
receipts, no error, no section on screen — was read as information. It never is. Every one of these
was closed by making the system SAY the number rather than inferring it from what was missing.

🚨 **THE DEPLOY BEFORE THIS ONE SHIPPED DIRTY.** `6a6cb349bf7d962dc069fa5f` carried `dirty:true` —
three untracked files under `netlify/functions` plus a modified `agent-bridge.mjs`. Production ran
code that was in **NO COMMIT**: unreproducible, with no real rollback target, because the
deploy-id ↔ commit binding this document's identifier rule rests on was simply **false** for that
artifact. The stamp said so in its own `detail` field ("the commit names a starting point and does
not identify this artifact") and it went out anyway. Fixed forward: `3dab626` committed that exact
surface and re-stamping reproduced the LIVE tree `22caf6e0…` byte-for-byte, and **`gate:watch` now
REFUSES on a dirty surface** (`f06469e`). ⭐ The stamp had always MEASURED `dirty` and nothing ever
acted on it — the same gap the schedule assertion closed. A measured-and-displayed value that
nothing refuses on is a value that gets scrolled past.

🚨 **`netlify logs` DROPS console OUTPUT FOR `*-background` FUNCTIONS — do not build a check on
one.** Measured 2026-07-31: unauthenticated probes of `bridge-mint-settle-background` appear as
**empty `INFO` lines** — the invocation is listed, the message text never is.
⚠️ **NARROWLY SCOPED, corrected 2026-08-01:** this is NOT true of every function. The same query
against `agent-bridge` returns full text (`[bridge-receipt] settle trigger sent … status=202`), and
both appeared in one output. An earlier note here said "console output" flatly; that was too broad
and would have discouraged logging on the many surfaces where it works. `a652ab6` added
REFUSED/ACCEPTED log lines intending to make the internal-auth guard observable; **that does not
work**, and the constraint was already written down at `job-bridge-receipt-background.mjs:50-54`,
which is exactly why that verifier attaches telemetry to the RECORD instead. The lines are kept
(free, useful behind a log drain) but are **not evidence**.
⭐ **A background function's return value is DISCARDED** — Netlify answers every caller `202` with an
empty body, including no token, a bogus token, and the wrong HTTP method. So `return json(401)` never
reaches the wire and **an external probe cannot distinguish "refused" from "ran"**. "No `/api` route"
is necessary but NOT sufficient — every function is reachable at `/.netlify/functions/<name>`
regardless (same lesson as removing the `/api/dd-analyze` redirect and fixing nothing).
**THE ONLY SOUND PROOF IS BEHAVIOURAL AND NEGATIVE:** invoke it unauthenticated with a REAL
receipt's `owner`/`burnHash` and confirm the record does NOT change — no `settlingSince`, no state
transition. ⚠️ A refused call must never WRITE to prove it was refused; that puts a write on the very
path being guarded. **STILL OPEN — rides on the first deliberate bridge.**

⏳ **THE CITATION MEASUREMENT WINDOW IS OPEN.** `RESEARCH_CITATION_ENFORCE` is **UNSET in
production** (read back after the deploy, not assumed) ⇒ **LOG-ONLY**, which here is the
**PERMISSIVE** state — an uncited brief SHIPS. ⚠️ That is the OPPOSITE of `DD_PUBLIC_ENABLED`,
where unset = refuse. Do not "harmonise" them; see the flag block in `job-submit-background.mjs`.
**Exit criterion: ≥50 evaluable briefs with a signal present AND false-empty <10%, or 2026-08-31,
whichever first.** Grep `[research][citation-shadow]` (would-have-refunded, per-class) and
`[research][citation-retention]` (against the 64.4% backtest baseline). 🚨 If nobody flips this,
the guard is dead a THIRD time — by drift.
🚨 **THE MEASUREMENT WINDOW RESTARTS AT DEPLOY `6a6c9ec1faace12931e10cb8` (2026-07-31T13:34:11Z).**
Production served the **union** derivation until this deploy. Every `[research][citation-shadow]`,
`[research][citation-refusal]` and `[research][citation-retention]` line emitted **before** that
timestamp describes a derivation **THAT NO LONGER EXISTS** — `9a93c10` replaced union with
**PRECEDENCE** (a marker can dismiss a source) and `ea2c275` split the empty case into
`emptyReason: "unmatched-model-sources" | "no-signal"`. ⚠️ **THE ≥50-BRIEF / <10% FALSE-EMPTY
CRITERION MUST NOT BE MET WITH UNION-ERA AND PRECEDENCE-ERA DATA BLENDED** — the false-empty rate
is not comparable across the cutoff. Count only lines at or after this deploy.
⭐ `unmatched-model-sources` ("model named sources, none matched retrieval") means **fabricated URLs
or a URL-normalisation bug on our side** — both actionable, neither meaning "the model declined to
cite". It is a SUB-REASON, not a new refund class; the user-facing headline is unchanged.

🚧 **UNVERIFIED ON A LIVE PATH:** no research job has run since this deploy, so neither half of the
citation change (short list where cited / full retrieval where not) has been seen in production.
⚠️ A live check is **T's to run** — `_research.mjs` can autonomously buy data via `payX402`
(the ON-CHAIN branch), so a research job is fund-moving. Read the result from the
`job-deliverables` store (keyed by raw jobId) and from `jobTimeline.tsx:203-224`, which renders
`Sources:` and `Retrieved, not used:` as SEPARATE lists. Regression case: job **#160637**
(Kraken/Wirex called irrelevant in the answer, listed as sources anyway); job #160108 is the same
defect (two exchange FAQs matched on the word "Unified").
Money path `verdict D`. Watch on `*/15`. Canary writing deploy-id-bound artifacts.
🚨 **SUPERSEDED 2026-08-11 (evening): DD IS NO LONGER INERT — it is LIVE AND SERVING on production**
(`DD_PUBLIC_ENABLED=true`, `DD_PAYTO_ADDRESS` set, deploy `6a7b57501c0748c9f7711418`). The sentence
that stood here — *"DD is INERT"* — is FALSE as of that deploy. See the evening entry: canonical
resource is `https://app.tikpema.xyz/api/dd-analyze`, and **the revenue wallet is no longer a
controlled number.** Live values come from the build stamp and `git`, not here.

### ⚠️ A DOCUMENTED EXCEPTION TO "PROVE IT ON A DRAFT FIRST" — the bridge settler

**Same shape as the `_budget.mjs` exception below, same reason: the rule is STRUCTURALLY
UNAVAILABLE here, not inconvenient.** `bridge-mint-settle-background.mjs` shipped without ever
having run against real IRIS. Every branch in it is proven by INJECTION only
(`npm run test:bridge`, 48/0).

**Why a draft cannot exercise it:**

* The settler only runs after a **real Arc burn**, and a burn requires a **real browser wallet
  connect**. Circle client keys are **domain-restricted** and the SCA derives from the **passkey**,
  so a draft is a **different owner with a different wallet address** — the same wall documented for
  `_budget.mjs`.
* The branch that matters most — a **stalled mint** — is not inducible on demand anywhere. IRIS
  reports `failed` only on an explicit `forwardState==="FAILED"`; a true stall just stays `pending`.
  You cannot ask Circle's relayer to hang.
* A draft could therefore only ever have shown that the happy path did not break, on a wallet that
  is not the production wallet.

**Why promoting anyway is defensible here, and would NOT be in general:**

1. **The receipt write CANNOT FAIL THE BRIDGE.** It runs after the burn has landed, and
   `writeReceiptNeverThrows` swallows every error. The worst outcome is *no receipt* — which
   degrades the UI to exactly what it did before receipts existed. It can never turn a successful
   bridge into a reported failure, which is the one lie that would make a user retry and burn twice.
2. **`delivery` NEVER SELF-ADVANCES.** `predicted → measured` happens on exactly one path: a
   destination-chain read that returned `verified`. Every other exit — deadline, poll exhaustion,
   RPC error, IRIS/chain disagreement — leaves it `predicted`. So the failure direction is always
   "we still call this an estimate", never "we assert an arrival that did not happen".
3. All four terminal states, both termination bounds, the owner scope, the never-throw write and the
   absent `/api` route are **suite-pinned by fault injection**, including the deadline branch that is
   untestable by waiting.

⭐ **(1) and (2) are what make it acceptable.** Both failure modes point at *less* claim, not more.
Absent that, the correct call would have been to defer.

🚨 **THE VERIFICATION IS NOT DEFERRED — the first real bridge after this deploy IS the test, run
DELIBERATELY rather than waited for.** Watch one receipt through `burn_confirmed` →
`delivery:"predicted"` → `delivery:"measured"`, and confirm `amountDelivered` is **read from the
destination-chain Transfer log**, not equal to `netPredicted` (they differ: the fee is quoted as a
`maxFee` ceiling). ⚠️ Until that run happens, treat the settler as **unproven on a live path** — and
note the double-approve race, documented as narrowed-not-closed, is now also a `burnHash`-keyed-write
hazard.

### 🚨 UNIFIED BALANCE COPY IS FALSE — investigated, resolved, not yet fixed

The page says **"not by you, not by us. There is no path that returns it."**
Measured, **state (a): the path EXISTS and is REACHABLE.**

* SDK `@circle-fin/unified-balance-kit@1.2.1` exports `initiateRemoveFund` / `removeFund`.
  ⚠️ **NOTE the SDK names differ from the contract names** — `removeFund` calls `withdraw()`.
  **Selector-checking the SDK name finds nothing.**
* Gateway `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` is a **PROXY (163 bytes)** where even
  `availableBalance` appears absent. **Resolve EIP-1967 to
  `0xa33d52b46964495ea6e2bb09ce85faed05776e28` (22,818 bytes) before scanning**, or you get a
  confident **false negative**.
* Present: `initiateWithdrawal(address,uint256)`, `withdraw(address)`, `withdrawalDelay()`, plus
  controls `availableBalance` and `deposit`.
* `availableBalance(USDC, 0x3cb76ac688f3fc02dfe4033d388989a44f132de9)` = **exactly 2 USDC**,
  matching the UI. `withdraw()` takes **no beneficiary**, so the withdrawing account is
  `msg.sender` = that SCA, **which we drive**.
* `withdrawalDelay()` = **1209600 BLOCKS, not seconds.** Arc block time measured at **0.5097 s/block
  over 20,000 blocks** ⇒ **about 7 days**. `1209600 = 14 × 86400` is a **COINCIDENCE**. The figure is
  **derived**, so copy must say **"about seven days"**.

**VERDICT: "not by you" TRUE, "not by us" FALSE.** Copy drafted, not applied.

**STATUS as of 2026-07-31 — the copy lived in FOUR places, not two. All four now fixed,
`tsc --noEmit` clean, WORKING TREE ONLY / UNCOMMITTED:**

| site | state |
|---|---|
| `UnifiedBalancePanel.tsx` — "What you can get back" bullet | ✅ fixed |
| `UnifiedBalancePanel.tsx` — "Fund the unified balance" card | ✅ fixed |
| `YourMoney.tsx` — amber line pinned to Withdraw | ✅ fixed |
| `YourMoney.tsx` — `badge="Server-released, delayed"` → `"No withdrawal built"` | ✅ fixed |

⚠️ **A BADGE IS COPY.** The badge was false in the **v2 (optimistic) direction** — it claimed a
release mechanism we do not operate — and it **outlived the copy it belonged to**, sitting above a
v3 body that contradicted it on the same card. Prose got reviewed three times; the four words next
to it never did. **Audit labels, badges and column headers with the sentences.**

⚠️ Four guard comments carried the falsehood too, including `YourMoney.tsx`'s file-header pocket
table ("NO WAY OUT… by ANY path"), which is the file's organising principle. All corrected — a
comment that states the falsehood as rationale will regenerate it.

🚧 **DELIBERATELY WITHHELD — "and we drive that account" is NOT in any of the four sites.** It
asserts a capability for `withdraw()` that nobody has verified (see the delegate row below). The
wording chosen is true **regardless of how that read resolves.** ⭐ It is **deferred, not dropped**:
once the delegate question is answered, the disclosure **should go in**, per the vault-card standard
we hold others to. The guard comment in `UnifiedBalancePanel.tsx` says so, so the next editor does
not read the absence as a settled decision.

⭐ **`removeFund` is a REAL backlog item, not a euphemism.** The machinery is the same
dev-controlled-SCA `contractExecution` path withdraw/swap already use. **One genuine unknown:**
whether the **delegate** can sign it, or whether `msg.sender` must be the SCA itself — the delegate
grant covers *spends* and may not extend to `withdraw()`. That is a **read, not a build**. ⚠️ The copy
commits us in a way a backlog entry does not — if this sits untouched, "we haven't built it" quietly
becomes a promise.

### 🚧 BACKLOG — the copy guard must assert on RENDERED OUTPUT, not source regex

**Not started. Deferred deliberately, `eb459a1` shipped without it.**

The guard that keeps the unified-balance falsehood from returning is currently a **source regex over
two files**. It must instead **render the components in a test and assert on the resulting text
content.**

⭐ **One move closes four blind spots at once:** line wrapping, template literals, text built from
variables, and **text in PROPS**. Plus the one a two-file scan **structurally cannot** cover — a
**new file** carrying the falsehood.

🚨 **WHY THIS IS NOT COSMETIC.** Building the guard, the source regex produced a **false alarm**
(JSX wrapped `"Tikpema controls that account"` across a line break; the comment-stripper missed `//`
lines and flagged a comment *quoting* the old falsehood). Benign in that direction. **The same regex
can produce a false ALL-CLEAR** — and for a guard whose entire job is catching a falsehood
reappearing, that is the only failure that matters.

⚠️ The guard currently has **the exact blind-spot class it was built to close.** A source scan
focused on prose is **precisely how `badge="Server-released, delayed"` survived three careful
reviews** — nobody counted four words in a prop as copy.

⭐ **The rule, general:** **assert against STRUCTURE, not against text the asserter is part of.**
Same rule as the `_budget.mjs` / build-binding work this week.

**🚨 FOLD ALL THREE INTO THE GUARD WHEN BUILT — one alone would NOT have caught the near-miss.**
Verifying the memory-index compaction (2026-07-31), a transcript extractor matched **its own bash
command** and reported `✅ VERIFIED: all 0 shortened entries` — **zero entries examined, green
result.**

1. **EXCLUDE SELF from the corpus.** ⚠️ **Fourth instance this week:** `pgrep` matching its own
   wrapper shell, `pkill` killing the shell that issued it, a suite matching its own header
   comment, now an extractor matching its own command.
2. **ASSERT THE EXPECTED COUNT, not non-zero.** `=== 43`, never `> 0`. A self-including extractor
   usually matches *something* — **the zero-match was luck.** Had it matched one, a non-zero test
   would have passed cleanly.
3. **PRINT THE RAW MAGNITUDES the verdict rests on.** `pre-image chars: 838` (for a 20.9KB file) is
   what exposed it, and it was **incidental**. ⭐ **A verdict hides its own inputs — `✅ VERIFIED`
   is unfalsifiable by inspection, `838` is not.**

### 🔎 CIRCLE x402 MARKETPLACE — can DD get listed? (measured 2026-07-31, nothing registered)

**THE CLI IS CONSUMER-ONLY.** `circle services` = `search` / `inspect` / `pay`. Ten seller verbs
probed (`register`, `publish`, `list`, `add`, `create`, `submit`, `onboard`, `seller`, `provider`,
`directory`) — **all absent**. No publish path anywhere in the CLI, and none of Circle's seven
published skills is seller-side. ⚠️ `--help` works WITHOUT accepting the Terms; everything else is
gated. **How a third party gets listed is STILL UNKNOWN** — not the CLI, not a skill, no advertised
write method (`OPTIONS` on the discovery API → 404). Remaining candidates: an off-CLI form, a
partner process, or crawler ingestion (`lastUpdated` + a `stripe_payment_intent_id` in one row's
`extra` hint at a pipeline). `circle feedback submit` exists as a channel but is outbound contact.

**THE DIRECTORY, MEASURED IN FULL.** `GET https://api.circle.com/v2/x402/discovery/resources`
— public, no auth, **636 listings** (all 7 pages fetched, 636 unique). **15 networks:**
Base 802, Polygon 742, **Base Sepolia 396, Polygon Amoy 396**, Avalanche 141, Ethereum/Arbitrum/
Optimism/Unichain 99 each, Solana 35, X Layer 31, Sonic/World/Sei/HyperEVM 12 each.
⭐ **Arc (`eip155:5042002`) appears ZERO times.** Chain id resolved authoritatively — live
`eth_chainId` = `0x4cef52` = 5042002, matching `_arc.mjs:4`. ⚠️ **"It's a testnet" does NOT explain
it** — Base Sepolia and Polygon Amoy are a third of the directory.

**🚨 BUT THE DIRECTORY ROW IS STALE, AND THAT INVERTS THE CONCLUSION.** The one Arc-adjacent row is
`https://x402.quicknode.com/arc-testnet/` — **the seller Tikpema ALREADY PAYS.** Its directory row
(`lastUpdated` 2026-06-25) advertises **12 accepts[] entries, all Base/Polygon, no Arc**. The
**LIVE 402 challenge from the same URL returns 21 entries INCLUDING `eip155:5042002`**
(`GatewayWalletBatched`, amount `100` = 0.0001 USDC). So **Arc x402 settlement is live and
sellable TODAY; the directory index simply does not reflect it.** The absence of Arc in 636 rows is
an **INDEXING artifact, not a platform refusal** — do not read it as "Arc cannot be listed".

**HOW WE ALREADY PAY (read, not designed).** Production `DATA_SELLER_URL` =
`https://x402.quicknode.com/arc-testnet`. `_x402.mjs` hard-enforces
`EXPECTED_NETWORK = eip155:${ARC.chainId}` and selects the `accepts[]` entry matching Arc +
`BATCH_NAME = "GatewayWalletBatched"`, 502-ing if absent — so **the Arc path is not optional in our
buyer, and it works in prod.** Payer is the **delegate EOA** (`from == signer`, no depositor/signer
split in the batched header — see [[batched-x402-requires-from-equals-signer]]).

**⭐ NO ERC-8004 FIELD IN THE LISTING SCHEMA — AND THAT IS NOT A VERDICT ON THE IDENTITY WORK.**
A listing carries `resource, type, x402Version, lastUpdated, accepts[], metadata{provider{name,
website, docsUrl, description, category, tags}, path, method, description, mimeType, input, output,
siwx, supportsVanillax402, supportsCircleGateway}`. `metadata.provider` is **free text**, so
**agentId 851891 has nowhere to go IN A LISTING**. ⚠️ **Do NOT conclude the identity work was
wasted.** An **on-chain-verifiable ERC-1271 attestation is strictly stronger than anything a
listing carries** — every field above is self-asserted, unverifiable prose. It remains a real
differentiator **in the PRODUCT and the PITCH**; it just cannot be the differentiator **inside the
directory**, because the directory has no slot for it and no verification of it.

**⚠️ IF A BASE `payTo` IS EVER CHOSEN, IT COSTS A SECOND REVENUE WALLET.** DD's `payTo` is
`0xb407967319d56218c7e1c369125490e665a16ac4` (Arc). **Its clean history IS the design** — see
[[dd-revenue-wallet]]: Transfer-to-payTo reconciliation is attributable ONLY because that wallet's
entire history is DD revenue, so it must receive nothing else. A Base `payTo` therefore cannot
reuse it and needs a **second, equally clean wallet**, doubling the invariant to maintain.
🚧 And it is **blocked on an open precondition already recorded here: VERIFY THE BASE SEPOLIA
DELEGATE BEFORE FUNDING IT** — `_ubspend.mjs` warns the delegate grant is per-SCA and only Arc has
ever been exercised. ⭐ **Given the QuickNode finding, a Base `payTo` may be unnecessary** — the
Arc-serve/Base-settle workaround was inferred from a STALE row, not from a platform limit.

### MEASURED vs INFERRED — do not promote one to the other

| claim | status |
|---|---|
| canary binds to the **[DEPLOY ID]** from `x-nf-deploy-id` | ✅ MEASURED in prod, twice, value-vs-value |
| scheduled invocations carry that header | ✅ MEASURED on a genuine cron tick |
| all four env build sources absent at runtime | ✅ MEASURED — `DD_BUILD_ID`/`COMMIT_REF`/`DEPLOY_ID`/`BUILD_ID` all null |
| **URL-path split-brain — DRAFTS** | ✅ **MEASURED**: both paths returned the same 24-hex id, equal to the draft's own **[DEPLOY ID]** |
| **URL-path split-brain — PRODUCTION** | ✅ **MEASURED 2026-08-11 (evening), the moment exposure made it observable.** BOTH paths return a valid **402** with the same `payTo` and price; `/api/*` resolves on prod (it served SPA HTML on a draft). `resource` differs BY DESIGN — `https://app.tikpema.xyz/api/dd-analyze` vs `…/.netlify/functions/dd-analyze` — since it binds to the URL actually hit. ⭐ **Canonical = `/api/dd-analyze`.** |
| `_budget.mjs` `readable:false` refusal | ⚠️ SUITE-ONLY — not inducible; safe because it fails closed |
| DCA ledger-failure branch | ⚠️ SUITE-ONLY — live but unexercised (all 7 mandates cancelled/expired) |
| UB auto-allocation drawing from Base | ⚠️ UNPROVEN — no-op today (every Base Sepolia balance is 0.0) |
| Gateway withdrawal path exists + is reachable | ✅ **MEASURED** on the resolved implementation — selectors present, balance keyed to an SCA we drive |
| ~~the DELEGATE can sign `withdraw()`~~ → **MOOT.** We own the account outright | ✅ **MEASURED 2026-07-31 — the question was mis-framed.** The delegate is a **Gateway-level** grant for *spends*; it is **not the only way we drive the SCA**. Agent SCAs are **dev-controlled** (`_agent-wallets.mjs:61` `createWallets({accountType:"SCA"})` under `CIRCLE_ENTITY_SECRET` — the passkey is the *identity key* for mapping, **not** the signer). **`getInstalledPlugins()` = 0 on all three SCAs**, incl. the one we demonstrably drive → **no permission module, no selector allowlist**. Impl `0xd206ac7f…` exposes native `execute(address,uint256,bytes)`. ⭐ **Owner directly, unrestricted ⇒ `withdraw()` available BY CONSTRUCTION.** We never needed the delegate |

### STANDING CONSTRAINTS — each next to what it guards

* **The pre-commit hook needs `gitleaks` ON PATH, and it FAILS CLOSED without it.** `.githooks/`
  is tracked and activated by `core.hooksPath` (`npm run hooks:install`, also `postinstall`), but
  **the binary is not in the repo.** On this machine it lives at `~/.local/bin/gitleaks` (8.30.1)
  — `/usr/local/bin` is not writable and sudo needs a password — and `~/.local/bin` was **not on
  PATH**, so `~/.bashrc` now prepends it (guarded by a `case` so re-sourcing cannot duplicate it;
  backup at `~/.bashrc.bak-20260731`). ⚠️ **THIS IS MACHINE-LOCAL AND DOES NOT TRAVEL.** A fresh
  clone on a new machine gets the hook but not the binary, so **every commit there blocks** until
  gitleaks is installed — that is the intended behaviour (a scanner that silently no-ops is absent
  exactly where it is needed), and the block message carries the install commands. If commits
  suddenly fail on a new box, this is why. ⭐ The hook raises the floor only: `--no-verify` skips
  it and there is **no CI backstop**, since deploys are CLI-only.

* 🚨 **PINNED CIDs ARE NOW A PERMANENT, GROWING OBLIGATION — created by the first sale (2026-08-11).**
  `bafkreigton…` (dd-service.json, agentId 851891) must stay pinned **indefinitely**: two paid
  reports were produced under it, and verifying either resolves `tokenURI(851891)` → that document →
  the claims that were **live when the report was produced**. ⭐ **If the pin lapses the signature
  still verifies — `isValidSignature` is a chain call — but WHAT WAS ATTESTED TO becomes
  unresolvable**, leaving a buyer with a valid signature over claims nobody can retrieve. The product
  fails *after* delivery. ⚠️ **Monotonic:** `supersession_rules` forbids unpinning priors, so every
  future version ADDS a CID and removes none. **Never unpin to reclaim quota.** Operational copy is
  at the top of `scripts/pin-invariants.mjs`; reader-facing copy in
  `agent-metadata/dd-service.MIRROR-README.md`.
* **The frozen DD identity doc is KNOWN STALE on four capability claims — fix by SUPERSESSION, never
  by edit or mirror.** Its own `mutability_posture` prescribes it, and `setAgentURI` (`0x0af28bd3`)
  is verified present. ⚠️ **DEFERRED until the launch work settles** (exposure, refusal window,
  monitoring, any MCP surface) — a commit-scoped doc authored mid-flight needs superseding twice.
  ⭐ It is a precondition for **LISTING**, not for enabling: unlisted, no verifier arrives; a listing
  is what brings them, and they would read a document denying that signing exists.
* **`WATCH_ALERT_WEBHOOK` must NEVER be `--secret`.** `gate:watch`'s existence check READS the URL to
  perform a live GET; a secret value breaks the gate. Hygiene is fingerprint-not-print.
* **`WATCH_STORE` at deploy-preview is DELIBERATE ISOLATION, not a leftover.** Removing it lets a
  future draft write into production's store.
* **Restore any schedule commented out for a draft proof.** `netlify.toml` is OUTSIDE the build
  stamp's hashed surface, so a forgotten restore yields an **identical tree hash** and is invisible
  to every provenance check. `npm run gate:watch` refuses production while it is commented.
  🚨 **CORRECTED 2026-08-11 — THAT LAST SENTENCE WAS FALSE FOR `dd-canary` UNTIL THIS DATE.**
  `gate:watch` checked **`strong-read-watch` only** and had zero references to `dd-canary`, so a DD
  money-step draft — the one proof that *requires* commenting `dd-canary` out — left the gate
  exiting **0** with the schedule still commented. Measured, not theorised: the gate passed while
  the stanza was commented, in front of the operator who was relying on it.
  ⭐ **AND THE OTHER SUITE COULD NOT COVER IT, BY DESIGN.** `verify-strong-read-watch.mjs` asserts
  dd-canary's schedule against `git show HEAD:netlify.toml` — the **committed** file — precisely so
  a mid-proof comment-out does not turn it red for the wrong reason. Correct, and it means it is
  structurally blind to working-tree drift. Its own comment said "the WORKING TREE is the promotion
  gate's job"; only half of that was ever implemented, and **both documents asserted the whole.**
  ✅ **FIXED:** `gate:watch` now iterates `GUARDED_SCHEDULES` (exported table, `strong-read-watch`
  + `dd-canary`) and refuses production if **any** is commented; both directions proven (fails
  commented, passes restored), and `test:watch` now imports that table and asserts dd-canary is in
  it — a **structural** check, where the neighbouring one is a source regex that would go green on
  a rename that deleted the coverage. 207/0.
  ⚠️ **THE LESSON IS THE CLAIM, NOT THE CODE.** A documented guarantee that does not exist is worse
  than no guarantee: it is the [[absence-must-never-read-as-safe]] shape aimed at the operator
  rather than the machine. **Add a row to `GUARDED_SCHEDULES` whenever a schedule becomes
  comment-out-able**, or this rots again.
* **A draft proof is STRUCTURALLY IMPOSSIBLE for anything needing a real wallet connect.** Circle
  client keys are domain-restricted, the Passkey Domain must match exactly, and
  `toCircleSmartAccount` derives the account from the passkey — so a draft origin would be a
  **different owner entirely**. Plan fund-moving proofs for production, deliberately.
* **`netlify env:get` LIES about build variables** — it synthesises `COMMIT_REF` from the LOCAL git
  HEAD and reports `DEPLOY_ID`/`BUILD_ID` as `"0"`. None appear in `env:list`; none reach the
  function. **Only a running function can say.** ⚠️ And `env:set` has silently no-opped 3×: the
  confirmation line proves a command ran, **not** that a value was stored. **Always read back.**
* **Watch a PID, never a `pgrep` pattern.** `pgrep -f "netlify deploy …"` matches the monitor shell
  running it — it reported its own age as the deploy's, and a `pkill -f` killed the shell issuing the
  kill. Capture the PID once, `kill -0 <pid>`. Prefer the deploy-record state from
  `netlify api listSiteDeploys` (`new` → `uploading`, `req` counting down → `ready`) over guessing
  phase from process lists; esbuild is a persistent `--service` process and proves nothing.
* **Scheduled functions 403 on HTTP invoke, and cron does not fire on drafts** — unreachable by BOTH
  routes. Deploys take 15–28 min; two have died near ~29 min.

### 🚨 THE MONEY STEP — ONE SHOT, PLAN IT WHOLE

`DD_PAYTO_ADDRESS` is SET at **deploy-preview only** (the clean revenue wallet
`0xb407967319d56218c7e1c369125490e665a16ac4`), read-back verified. Production unset.

**Setting it is necessary but NOT sufficient.** On a draft the request passes rung −1 and refuses at
the **HEALTH** rung with `no-record`, because the draft's canary can never run. `dd-analyze` never
reaches the payment gate, so **no 402 is issued**.

⭐⭐ **THE ARTIFACT IS BOUND TO ONE [DEPLOY ID]**, no longer to a pinned `DD_BUILD_ID` **[COMMIT]**
that could span deploys. **So the canary run AND the purchase must happen on THE SAME DRAFT DEPLOY,
with NO redeploy between them.** Any redeploy mints a new id, the artifact stops matching, and the
sequence restarts (~25 min).

⚠️ **Therefore set EVERYTHING before deploying** — schedule comment-out, `DD_PUBLIC_ENABLED`,
`DD_PAYTO_ADDRESS`, probe config. **Env changes do not reach a live function** (measured), so setting
one afterwards costs a redeploy, which is exactly what invalidates the artifact.

    1. comment out dd-canary's netlify.toml schedule   2. deploy (ONE deploy)
    3. invoke dd-canary over HTTP -> writes the artifact
    4. probe-dd-purchase.mjs bare, THEN --confirm      5. GATED restore of the schedule

⚠️ A 502 means `charged: **null**`, never `false` — **NEVER blind-retry**; poll the handle and read
the chain. Strictly sequential: confirmation is `availableBalance(USDC, payTo)`, an **aggregate**, so
two concurrent equal payments cross-confirm each other. Baseline the revenue wallet IMMEDIATELY
before. Read the amount off the 402, not from memory.

### OPEN WORK — preconditions attached, not listed separately

1. ✅ **The money step — DONE 2026-08-11.** Two real purchases, full and thin, chain-verified.
2. ✅ **Enabling DD in production — DONE 2026-08-11 (evening).** Three-way check run at exposure:
   both paths serve valid 402s, `resource` clean on `app.tikpema.xyz`, canonical =
   `/api/dd-analyze`. `--context all` never used.
   ⭐ **THE THREE THAT REPLACED IT, IN THIS ORDER — the ordering is the decision, not a list:**
   1. ✅ **THE REFUSAL WINDOW — ADDRESSED 2026-08-12.** The health key was bound to the DEPLOY ID, a
      bad proxy for "this code": 18 of the last 20 stamp-dirty commits were DD-CLEAN, and each
      rotated the key for nothing. Now a content hash of the DD surface (`ddTree`), **production-
      proven twice on DD-clean deploys**. ⚠️ The window still exists for DD-CODE deploys and its
      size is **STILL UNMEASURED after five production deploys** — but it is now rare by design.
   2. ✅ **A MONITOR — `dd-watch` IS LIVE AND FULLY CALIBRATED (2026-08-12).** `*/5`, both paths, own
      store, own channel. **Every transition observed live**, including a genuine `recovered` and the
      `induced` carry-forward. ⚠️ Residual: the always-real alert RENDERINGS are suite-only, and both
      `windowHistory` entries are induced.
   3. ✅ **UNIFIED BALANCE EXIT — BUILT 2026-08-12 (option a).** `initiateWithdrawal` → ~7 days →
      `ub-withdraw-sweep` (`*/30`) completes it automatically → `agent-withdraw` returns it to the
      login wallet. Wait disclosed in the deposit card's LEAD sentence. `verify-ub-withdraw` 15/0.
      🚨 **THE WRITE PATHS HAVE NEVER RUN WITH REAL FUNDS** — the read half is live-verified, the
      sweeper has never completed a real withdrawal, and the copy says so. That proof is the
      operator's to run and is the last thing between this and mainnet (2026-09-16).

### SUITES

`npm run test:dd` (12 suites) · `test:watch` · `test:probe` · `test:ub` · `test:dca` · `test:vault` ·
`gate:watch` (promotion gate) · plus `scripts/verify-{budget,pause,ledger,sweep,swap-cap}-*.mjs`.
⚠️ Known-failing and NOT a regression: `verify-per-user-threading` 2/18 — local `.env` cap 100 vs
deployed 25, plus a delegate read.

---

## 2026-07-30 (afternoon) — the watch is LIVE; a hardcoded rollback target that pointed at the fail-open build; and why a draft cannot prove a fund-moving path

### IS PROD HEALTHY? — two reads, no interpretation needed

    GET https://app.tikpema.xyz/.netlify/functions/blobs-probe
      -> verdict "D" AND calibrated true. Anything else, including UNCALIBRATED, is a failure.

    netlify blobs:get strong-read-watch latest
      -> the last cron observation: ok, reason, probe arms, build, lastGood, notify.

⚠️ **SILENCE IS THE HEALTHY SIGNAL.** The monitor pushes on transitions only, so no Discord message
is the expected steady state. Liveness is `producedAt` advancing in the record, **never** an alert
arriving. A healthy first run after any promotion is silent by design.

### SHIPPED

**The strong-read watch is in production**, `*/15`, polling `blobs-probe` over HTTP and pushing to a
dedicated Discord channel. All seven post-promotion checks passed. ⭐ **Money path FIRST** — the probe
was verified `verdict D` before anything about the monitor was assessed, because the watch ships to
the same site as `_pause.mjs` and `_budget.mjs`; a monitor is never the reason to accept a money-path
risk.

**🚨 THE ROLLBACK TARGET IN THE ALERT WAS THE FAIL-OPEN BUILD.** The known-broken message hardcoded
the HOTFIX deploy — the build with all three safety reads degraded to `eventual`. Following it at 3am
would have landed prod in precisely the state the money path had just been rescued from, and it was a
**no-op anyway** if the probe genuinely reported HOTFIX. The most dangerous line in an alert is the
one telling you what to do about it.

Now **derived**: the last deploy whose probe *this monitor observed* reporting `verdict D`, carried
forward from healthy runs only, with the **age** stated (14 minutes and 9 days are different
instructions). Absence says so loudly — no constant, no omission, because omitting reads as "no
rollback needed".

⚠️ **Sourced from the `x-nf-deploy-id` HEADER, not `DEPLOY_ID`.** A CLI deploy runs no build, so
build-time variables are absent — the same reason `commit_ref` is null on every deploy this project
makes. Shape-validated, because the value *becomes an instruction*.

**⭐ DESIGN COMMITMENT, PINNED STRUCTURALLY: a tree change can never CAUSE an alert, only decorate
one.** Every legitimate deploy changes the tree; if that paged, every deploy would page and the
channel becomes noise — which costs you the alert that matters. `decideNotify` does not take
`treeChanged` as a parameter at all, and a suite assertion reads the function's own source, so a
future change wiring it in fails immediately rather than being discovered by someone getting paged
on a routine promotion.

### DIAGNOSED, NOT SHIPPED — `_budget.mjs` `catch(() => null)`

**It is NOT a fail-open.** Two states collapsed into one `null` — key absent (the first spend of the
day) and store unreadable — and `mutate(null)` builds a **from-zero record**, i.e. the full daily
ceiling handed over. But `setIfMatch` degrades to `onlyIfNew` when there is no etag, so an existing
key **rejects** the write and the counter cannot be reset.

⭐ **Fail-closed by a guard one layer BELOW the defect.** The catch is load-bearing-*adjacent*, not
load-bearing — worth stating precisely, because "it's safe" and "the thing next to it is safe" invite
different amounts of care.

**The real defect was a FALSE DIAGNOSIS**: an unreadable store reported as `(contention)`, a cause
never established — after ~19 futile retries at full backoff inside a 10s ceiling, so the likely
user-visible result was a **timeout**, not the intended loud error. Same shape as the alert fixed
this morning: a failure to *observe* reported as an observed failure of a different kind.

Fix built, committed and suite-covered; **NOT DEPLOYED**. Money-path module, unproven on a deploy.

### OPERATIONAL FACTS MEASURED TODAY — the durable part

**A scheduled function CANNOT be HTTP-invoked.** Netlify 403s any function carrying a schedule, and
cron does not fire on drafts — unreachable by BOTH routes. The only way to exercise one on a draft is
comment the schedule out, deploy, invoke, **restore**. ⚠️ **Gate the restore**: `netlify.toml` is
outside the build stamp's hashed surface, so a forgotten restore produces an identical tree hash, a
passing provenance check, and a monitor that never runs. Silently.

**`function_schedules` on the deploy is the authority on what cron was REGISTERED.** Do not infer it
from observed intervals: records exist only at firing times, so an observed gap is a MULTIPLE of the
interval, and dedupe plus eventual reads only ever LENGTHEN it. Timing bounds the interval from
ABOVE and is blind to a schedule that is too FAST — the unsafe direction.

**🚨 CIRCLE CLIENT KEYS ARE DOMAIN-RESTRICTED, so a real-client wallet connect has never worked on a
draft origin and never will without a Circle-console allowlist.** Proven by elimination rather than
guessed: the client bundle is BYTE-IDENTICAL between prod and draft, so the baked credentials are the
same; same key + same code + different result leaves only the origin. Draft URLs are unique per
deploy, so unless Circle supports a wildcard, **every draft needs re-allowlisting**. `SESSION_SECRET`
is production-only — a second, independent blocker on the same path.

⭐ **This changes how any fund-moving proof must be planned.** "Prove it on a draft first" is not
available for anything requiring a real wallet connect. Either arrange the Circle-side allowlist in
advance, or accept that the proof happens on production and choose that deliberately.

**Verify a draft is serving the build you think it is** — match `blobs-probe`'s `build.commit` and
`build.tree` before using it. ⚠️ The CLI's printed "Draft URL" is MALFORMED on this site (renders as
`…app.tikpema.xyz.tikpema.xyz`); the form that resolves is
`https://<deploy-id>--tikpema-predict-test.netlify.app`.

**`WATCH_ALERT_WEBHOOK` must NEVER be `--secret`** — the promotion gate's existence check has to READ
the URL to perform its live GET. Its credential hygiene comes from fingerprinting instead of printing.

**`WATCH_STORE` at deploy-preview is DELIBERATE ISOLATION, not a leftover to tidy.** Removing it
would let a future draft write into production's store.

### ⚠️ A DOCUMENTED EXCEPTION TO "PROVE IT ON A DRAFT FIRST" — `_budget.mjs`

**The rule is not optional. This is an exception with a stated reason, and the reason is that the
rule is STRUCTURALLY UNAVAILABLE here — not inconvenient, not expensive. Unavailable.**

Settled against Circle's own documentation, not by inference:

* A client key carries a **Web Allowed Domain**. Exact domains only; **no wildcard form is
  documented**, and draft URLs are unique per deploy.
* The **Passkey Domain Name** is a second console setting, and Circle requires it to **match the
  client key's Allowed Domain exactly**. It is ONE domain, not a list — pointing it at a draft would
  BREAK PRODUCTION.
* `toCircleSmartAccount` is called with **no explicit `address`**, so the smart account is derived
  from the passkey credential. Passkeys are origin-bound, so a draft would need a NEW passkey — a
  new owner, **a different wallet address**, no funds, and a different `day:<owner>:<date>` key.

⭐ So a draft could not have exercised the same owner even with a per-draft allowlist and a second
client key. It would have proven something about a different wallet.

**Why promoting anyway is defensible here, and would NOT be in general:**

1. The change **FAILS CLOSED**. If `readable` is wrong, spends REFUSE. The failure mode is a blocked
   spend, never a widened cap — the opposite direction from the defect it fixes.
2. The branch that actually matters (`readable:false`) is **not inducible on a draft either** — you
   cannot make a Blobs store unreadable on demand. A draft could only ever have shown the refactor
   did not break the happy paths.
3. Both nulls, the persisted record shape, and the `onlyIfNew` guard beneath it are all suite-pinned.

🚨 **AND THE VERIFICATION IS NOT DEFERRED.** Nothing monitors the budget path — the strong-read watch
observes strong reads, not spend accounting. If this breaks, spends refuse and the only detection is
a human noticing. So the two spends ARE the verification and they happen promptly, not tomorrow:
a first spend of the UTC day (readable + absent → fresh record) and a second (existing key → CAS
increment, total advances). ⚠️ The first is a ONE-SHOT-PER-UTC-DAY window; any autonomous spend
consumes it.

**What made this acceptable is (1) and (3). Absent a fail-closed failure mode, the correct call would
have been to defer, not to promote.**

### ✅ THE EXCEPTION, DISCHARGED — both spends run on production, promptly

`_budget.mjs` promoted. Prod verified serving the promoted build BEFORE spending (`blobs-probe`
`build.commit` + `build.tree` matched), money path checked FIRST (`verdict D`, `calibrated true`),
and the once-per-UTC-day window confirmed still open immediately before spend 1.

| path | result |
|---|---|
| fresh record — readable + ABSENT key (first spend of the day) | ✅ created, amount correct |
| CAS increment — existing key (second spend) | ✅ total **advanced**, did not reset |
| persisted shape `{date, owner, spentUsdc}` | ✅ unchanged — `readable` never reaches the store |
| `readable:false` refusal branch | **SUITE-ONLY** — not inducible anywhere, safe because it fails closed |

⚠️ That last row is not written up as proven and should not be. The refusal branch has executed
nowhere but the suite; its safety rests on the failure direction, not on observation.

**The verification was not deferred, and that was the load-bearing condition.** Nothing monitors the
budget path — the strong-read watch observes strong reads, not spend accounting — so if this had
broken, spends would refuse and the only detection would be a human noticing.

⭐⭐ **THE METHOD POINT, WHICH NEARLY COST THE WINDOW.** The spending wallet was NOT the address
inferred from the previous day's send. The plan was to **LIST the store, not probe the expected
key** — and probing the inferred address would have found it ABSENT, which on the fresh-record path
reads as *"the record was not created"*: a FALSE FAILURE on a one-shot window, manufactured by
confirming an inference instead of reading a value. Same shape as reading `function_schedules`
rather than inferring cron from observed gaps, and `published_deploy` rather than trusting that a
deploy command succeeded.

🔍 **Worth a look later:** the two spends were 0.1 then 0.2, and the stored total is EXACTLY `0.3` —
not the `0.30000000000000004` a naive IEEE-754 add would produce. So the counter is not accumulating
float error, but the mechanism has not been read. These are the amounts that would expose it.

### CORRECTIONS TO THE RECORD

**Yesterday's 0.1 USDC send went through PRODUCTION, not a draft** — settled by checking which deploy
was published when it landed, not by recollection.

**🚧 OPEN — was Option D ever actually proven on a draft?** The session handoff described a
draft-based pause-toggle proof with a real client. If a real-client connect cannot work on a draft
origin, that proof either used a different auth path or also ran against production. **Method to
settle it:** identify the send, then check which deploy was published at that timestamp — the same
method that settled the question above. ⚠️ This does **not** change the outcome: D is independently
proven on production by `blobs-probe`'s two-arm differential, which needs no wallet at all.

*(Checked while here: the pre/post-`210ffeb` contradiction over the DD exposure guard was already
corrected by `9168a9b` — no surviving "not built" claim remains. And the specific `22.08 → 21.98`
figure does not appear in this file; that came from the handoff, not the record.)*

---

## 2026-07-29 → 07-30 — A PROMOTION THAT SILENTLY FAILED FOR 7.5 HOURS, and the discriminator + monitor built because of it

**Prod is on `6a6b4b7ac6918d8872b521f3`, tree `de91653b…`, verified.** Money path green throughout.

### 🚨 THE FIND: Option D was NOT in production, and everything said it was

Yesterday's fix (`connectBlobs` re-injecting the `url_uncached` that `connectLambda` drops) was
reported promoted and verified. It was not. `getSite.published_deploy` was still
`6a69be4fc7aa0d2c6843fc3c` — the **hotfix**, all three safety reads degraded to `eventual`, fail-opens
open — and had been for **7.5 hours**.

The prod deploy `6a69ff28…` (13:24:56Z) died mid-upload with 23 function bundles outstanding and was
canceled ~29 min in. Not a build error: `summary.status:"unavailable"`, no messages, nothing rejected.
It simply never finished, and **the failure was silent to whoever ran it**.

⭐⭐ **WHY NOTHING CAUGHT IT — three checks that could not see what they claimed to check:**

| check | why it was blind |
|---|---|
| 12 green suites | run in-process against the **working tree**; they cannot see a deployed build |
| the live pause toggle | **passes on BOTH builds** — an eventual read still blocks correctly whenever the flag is readable and fresh. "Blocks-then-allows" never discriminated |
| the build stamp / platform | Netlify records `commit_ref: null`, `build_id: null` on every CLI deploy — no build runs |

The chain balance was also wrong in the handoff: chain says **17.399 → 17.299** (tx
`0x7f8a243b…`, block 54260785, gas fully sponsored), not 17.30 → 17.20. And the send landed
**13:19:20Z**, five minutes *before* the canceled promotion — so the whole prod verification ran
against the hotfix.

### ⭐ THE DISCRIMINATOR — `GET /.netlify/functions/blobs-probe` (`127c563`)

Asks the DEPLOYED artifact whether a strong read works, **by doing one**, with the negative control
carried INSIDE every invocation:

    ARM A   connectLambda alone      -> MUST THROW BlobsConsistencyError  (the hotfix's own path)
    ARM B   connectBlobs             -> ok under D
    ARM A2  connectLambda after B    -> MUST THROW (proves B's mutation did not leak)

PASS = `verdict:"D"` **AND** `calibrated:true`. Arm A returning ok ⇒ **UNCALIBRATED**, never a verdict.
Across all 64 arm combinations "D" is reachable from **exactly one**.

⚠️ **The two-tree calibration was NOT CONSTRUCTIBLE** — `connectBlobs` was *added* by the fix, so on
the hotfix tree the probe's own mechanism does not exist. Hence the in-invocation control, which also
never expires (prod-as-negative-control disappears the moment D publishes).

⚠️ **`strongReadAvailable()` CAN LIE.** `getEnvironmentContext` reads `globalThis.netlifyBlobsContext`
BEFORE `process.env`; `getEnvironment()` prefers `Netlify.env`/`Deno.env`. `_blobs.mjs` repairs only
the `process.env` copy. Measured on prod: globalThis absent, `envKind:"process.env"` — sound today, but
a platform change could un-repair it with no commit of ours. Never gate on it.

### BUILD STAMP — provenance baked into the artifact (`127c563`)

`commit` + `dirty` + `tree`. A commit SHA alone is not enough when `--dir=dist` ships the **working
tree**: `dirty:true` means the commit is a *label*, not an identity. **`tree` is the identity.**
Committed value is **`null`** — an unstamped deploy self-reports UNRESOLVED rather than a stale SHA.

🪤 Its own first bug: `git()` trimmed the whole `git status --porcelain` blob, eating the leading
status column of the **first line only** and shifting its path by one char, so the self-exclusion
missed and `dirty` was permanently true. A dirty flag that cries wolf is one people learn to ignore.

### ⭐ STRONG-READ WATCH — the monitor (`3a49136`, `a2ff8ac`, `cf9bc6c`, `de47b5c`, `b071f19`)

`*/15` cron → HTTP-polls `blobs-probe` → records → **pushes to Discord**. 188/0.

🚨 **NAMES NO READ MODE ANYWHERE.** Strong bookkeeping would make the monitor die in exactly the
outage it exists to report. And "don't read with strong" is **not a strong enough rule**:
`getFinalRequest` serves EVERY op and resolves `opConsistency ?? this.consistency`, so a STORE-LEVEL
default leaks into **writes**. Rule = zero occurrences in code, bare `getStore(name)`, grep-asserted.

⭐ **Detection cannot live on the read side.** Cached bookkeeping ⇒ a reader can be served a stale
record. Append-only `failure:<ISO>` keys narrow it and do NOT close it — an eventual LIST can also
miss the newest key. Structural: **the record is the audit trail, the push is the detection.**
Record FIRST, notify SECOND; `lastNotifiedAt` advances only on CONFIRMED delivery.

### 🚨 A FAILURE TO OBSERVE IS NOT AN OBSERVED FAILURE (`a2ff8ac`)

The first real alert was wrong in the costly way. The target did not exist, so **nothing was
observed** — yet the message asserted the kill switch was reading a cache AND attached a rollback id.
An instruction, read at 3am, to roll back a **healthy** deploy. The headline was merely alarming;
**the consequence paragraph was the danger.**

| class | reasons | headline | consequence | rollback id |
|---|---|---|---|---|
| cannot-verify | unreachable, timeout, http-error, not-json, wrong-shape | ⚠️ CANNOT VERIFY | none — "not evidence the money path is broken" | **absent** |
| known-broken | hotfix, uncalibrated | 🚨 ARE BROKEN | kill-switch/spend-ceiling text | present |

An UNRECOGNISED reason falls to **cannot-verify**. Claiming a breakage you did not see costs a
rollback on a healthy deploy.

### 🚨 THE ROLLBACK ID WAS THE FAIL-OPEN BUILD (`de47b5c`)

The known-broken alert said *restore `6a69be4f`* — **the hotfix**. Following it lands prod in the
fail-open state this whole effort exists to close, and it is a **no-op** if the probe really said
HOTFIX. Now **derived**: `blobs-probe` reports `deploy:{resolved,id,source}` from the
**`x-nf-deploy-id` header** (not `DEPLOY_ID` — a CLI deploy runs no build), shape-validated to 24 hex
because it *becomes an instruction*; the watch carries `lastGood:{deployId,tree,commit,observedAt}`
forward from healthy runs only. **Absence says so loudly** (no constant, no omission — omitting reads
as "no rollback needed") and the alert states the **age**: 14 minutes vs 9 days are different
instructions.

⭐ Deliberately **not** in the build stamp: the stamp is made at BUILD time and cannot know which
deploy it lands in.

### PROMOTION GATE — `npm run gate:watch`, five checks, every one earned

1. **schedule declared AND uncommented** in the working-tree `netlify.toml` (`commented-out` is its
   own reason code — the build stamp is structurally blind, `netlify.toml` is outside the hashed
   surface, so a forgotten restore yields an IDENTICAL tree hash)
2/3. **`WATCH_TARGET_URL` / `WATCH_STORE` unset or equal the default** — the HOTFIX fixture ships to
   prod; a leftover pointer would mean a permanent fake outage paging hourly
4. **webhook shape** — ⭐ a `discord.gg` INVITE LINK is a valid https URL and **PASSED** the original
   prefix-only check. URL-shaped is not usable
5. **existence** — a live read-only GET; a Discord webhook returns its own metadata and posts NOTHING

Calibrated in **four** directions on real infrastructure: `unset` → fail, literal `<url>` → fail,
invite link → fail, real webhook → `GET 200` live.
⚠️ **`WATCH_ALERT_WEBHOOK` must never be `--secret`** — the gate must READ it. Hygiene =
fingerprint-not-print.

### MEASURED, NOT ASSUMED (Netlify)

- 🚨 **Scheduled functions return 403 to HTTP invocation.** Measured 4 paths on one draft: unscheduled
  200 JSON, `strong-read-watch` 403, `dd-canary` 403, absent path 200 SPA HTML. Combined with "crons
  do not fire on drafts", a scheduled function is unreachable on a draft by **BOTH** routes. Only
  route = comment the schedule out, deploy, invoke, restore. **This corrects the previous
  "trigger it by hand" instruction, which was impossible.**
- **Env changes require a redeploy** to reach a live function. CLI says so; A/B measured it.
- ⭐ **Read the REGISTERED schedule as a value** (`getDeploy` → `function_schedules`), never infer it
  from timing. Records exist only at firing times, so an observed gap is a MULTIPLE of the interval;
  dedupe and eventual reads only LENGTHEN it. Timing can never rule out a schedule **faster** than
  observed — the unsafe direction. Confirmed `strong-read-watch` on `*/15`, `dd-canary` on `*/10`.
- Deploys here run **15–28 min**; two have died near the ~29 min mark.

### Live proof — every notify branch fired on real infrastructure

none→fail ✅ · dedupe ✅ · corrected cannot-verify wording ✅ · still-failing-quiet (<60m) ✅ ·
still-failing (≥60m, `lastNotifiedAt` advanced) ✅ · fail→pass `recovered` ✅

Post-promotion, all seven checks: money path `D`/calibrated ✅ · published_deploy changed + tree
`de91653b` ✅ · **`deploy.id` == published id ON PRODUCTION** ✅ (closes the deploy-preview
inference — one measured context licenses nothing about another) · **`lastGood` populated** ✅ ·
**first-ever `treeChanged:true` and SILENT** (`steady-ok`, nothing sent — a legitimate deploy must
never page) ✅ · absence window observed as `lastGood:null` **in the record**, not as an alert ✅ ·
`producedAt` advanced ✅

### 🚧 OPEN

- `WATCH_STORE=watch-rollback-proof` still set at **deploy-preview** (harmless, fails safe; prod clean
  and gate-enforced)
- Untouched backlog: DD-standalone scoping comments for `_dd-health.mjs`/`_blobs.mjs`,
  `pauseStates:116` roster fix, `_budget.mjs:115` `getWithMetadata(...).catch(() => null)`

### The thread

Every real defect today was found where **a check could not see what it claimed to check**: suites
blind to the deployed build, a pause toggle blind to strong-vs-eventual, a stamp blind to
`netlify.toml`, a gate that accepted URL-shaped as usable, an alert asserting a state it never
observed, and a timing measurement that could only bound the interval from one side.

---

## 2026-07-29 — DD FACILITATOR BUILT + LIVE-PROOF TO THE 402. Caught a REAL PROD FAIL-OPEN in the canary version binding.

**Draft deploy only. NO MONEY MOVED. Production verified INERT throughout** — `DD_PUBLIC_ENABLED`
returns *"No value set in the production context"* at the start and end of the session.

Stopped **deliberately** at the last checkpoint before the money step: a real 402 challenge, quoting
the right wallet at the right price, with the read-only half of the purchase probe green.

### ⭐⭐ THE FIND: the canary version binding was a NO-OP, and it was heading for PROD

`codeIdentity().build` fell back to the literal string `"unknown"`:

```js
build: build ?? process.env.COMMIT_REF ?? process.env.BUILD_ID ?? "unknown"
```

When the build id could not be resolved, **both** the canary and the endpoint stamped `"unknown"` —
and `"unknown" === "unknown"` **MATCHES**. So the binding did not fail closed, it silently became a
no-op: **an old deploy's passing canary would have vouched for new code.** The deploy gate — the
entire reason shipping new code invalidates the old vouch — had stopped existing, and nothing said so.

⚠️ **Why it was always unresolved here:** `COMMIT_REF` / `BUILD_ID` are **build-time** Netlify
variables, and a CLI manual deploy (`netlify deploy --dir=dist`) **runs no build**. That is the deploy
type this service is tested on, so the binding was inert on exactly the path being exercised.

**THE FIX — `1dd8f75`:** a single `resolveBuildId()` in `shared/dd-canary/health.mjs`, source order
`DD_BUILD_ID → COMMIT_REF → DEPLOY_ID → BUILD_ID`. Unresolvable returns **`null`, never a placeholder**
— any constant returned on failure compares equal to itself on the other side, which was the whole
bug. The literal `"unknown"` is also **rejected as an env value**, so it cannot be reintroduced by
setting a variable. Three consumers refuse instead of comparing: `evaluateHealth` step 0 (ahead of
the record, so `build-unresolved` outranks stale/no-record/malformed), `shouldSkipRerun`, and
`dd-canary` rung 0 — which now writes **nothing**, killing the green-canary-beside-refusing-service
contradiction that made this hard to read. Same commit surfaces the identity evidence
`dd-analyze` had been computing and discarding (`refusal.diagnostic`).

⚠️ **`b9de582` is TEST-ONLY — no source change.** The reported symptom was *"dd-analyze resolves from
a different source than the canary"*; investigation found **no second source to repoint**.
`resolveBuildId` and `codeIdentity` each have **one** definition, both handlers make **byte-identical**
calls (`dd-canary.mjs:50`, `dd-analyze.mjs:186`) into the same module instance
(`a.codeIdentity === b.codeIdentity` at runtime). "Pointing it at the shared resolver" would have been
a **no-op that looked like a fix** — the worst outcome for a gate, since the next failure arrives with
the repair apparently already applied. So `b9de582` adds the proof instead:
`verify-canary-endpoint-binding.mjs`, the first test that runs the **real canary handler → real
endpoint handler through one shared store**.

**Verified live:** the canary reported `buildResolved:true, build:1dd8f75…, buildSource:"DD_BUILD_ID"`
(read directly). The endpoint side is proven by its refusal turning to **`stale`** — a reason only
reachable *after* the record is found and its identity matched, i.e. `healthKey(canary) ===
healthKey(endpoint)`. Both sides agree.

### ⭐ FIVE DEPLOY-ONLY GAPS THAT TWELVE GREEN OFFLINE SUITES COULD NOT SEE

1. **Routing, not the service** (`49dfe8e`) — the probe and doc targeted `/api/dd-analyze`; the
   redirect did not resolve on that draft while `/.netlify/functions/dd-analyze` answered normally.
   The catch-all serves SPA HTML for anything unmatched, so a routing miss and a missing function are
   **indistinguishable by status code** (observed as 404 here, 200 previously). Verified both paths
   produce a valid 402 and bind `resource` from `event.path`, so the functions path is
   self-consistent — it tests the **service** rather than the **routing**.
2. **The build fail-open** — above.
3. **Reported as a half-wired binding** (canary resolved, endpoint did not) — **no such code defect
   existed.** Do not go looking for one. See 4.
4. **Refusals were being read off a STALE PRE-FIX DRAFT.** The draft under test (`6a690473…`, 19:35)
   **predated `1dd8f75`**, so its endpoint was running the old code. ⭐ The discriminator that settles
   this class of confusion: after `1dd8f75` the string `"unknown"` can no longer be **produced** — it
   survives only as a value the resolver **rejects**. So `running.build:"unknown"` means *old code
   deployed*; `null` + `build-unresolved` means *new code, env not reaching it*. Different repairs.
5. **Canary artifact staleness** (`0713b11`) — 🚨 **the `*/10` cron does NOT fire on a draft.** Netlify
   runs scheduled functions on the **published** deploy only. On a draft the canary produces an
   artifact **only when invoked by hand**, and the 30-minute TTL expires it with nothing to refresh
   it. Measured: a record **60 minutes old** under a `*/10` schedule — six missed ticks. This is very
   likely the ORIGINAL `service-unverified` that opened this thread, predating all the build work.

⭐ **A stale artifact CANNOT strand a payment** — retrieve sits **ahead** of the health gate by
deliberate placement (retrieve rung -0.5, health rung 0). Settlement takes ~15.4 min against a 30-min
TTL, so an artifact expiring mid-poll is *likely* — and is a non-event, because an already-paid handle
never consults health. An earlier design decision paying off exactly where it was aimed.

### THE FACILITATOR — BUILT (`961ff80`)

`netlify/functions/_dd-x402.mjs`. Ordering is the product: **analyze → decide → snapshot → persist →
settle**, so a slow analysis burns the request budget *before* any settlement is attempted and a
timeout costs the caller nothing. The report is **frozen at settle time** and stored with the handle;
retrieve serves those exact bytes and never re-runs. **Persist happens BEFORE broadcast** — if the
process dies between the two, the caller still holds a redeemable handle; the natural order loses the
entitlement in exactly the case where the money *did* move. Two throw classes kept distinct because
collapsing them would be the whole bug: `SettleAborted` (nothing broadcast, `charged:false` is a
structural fact) vs `SettleIndeterminate` (`charged:null`, **not false**, and a handle survives).
`payTo` has **no fallback** — `SELLER_ADDRESS` sits in the same env and would "work" while destroying
the zero-history property that makes aggregate reconciliation attributable.

**⭐ UNSIGNED DOES NOT SETTLE** (`settleDecision` condition 4). The 402 advertises a signed ERC-1271
attestation; `attachAttestation` degrades to `{status:"unsigned"}` on a signer outage. *"Do not
destroy the report"* and *"charge full price for it"* are different decisions and only the first had
been made. A signer outage is **our** failure — same category as the RPC outage that already does not
settle. Fail-closed via a `Set`, not truthiness, and `status:"signed"` alone is **not enough**: without
`signature/agentId/verifyingContract/chainId` nobody can check it, so that is a separate reason
(`attestation-unverifiable`) — which also means a bug in the signing path cannot silently start
billing. The caller still gets the complete report, **free**.

### END STATE — the chain is wired end to end over live HTTP

**exposure flag ✅ → build binding ✅ (matched) → canary health ✅ (fresh) → real 402 challenge**,
quoting revenue wallet **`0xb407967319d56218c7e1c369125490e665a16ac4`** at **60000 atomic ($0.06)**.
The read-only half of `probe-dd-purchase.mjs` confirmed payTo and price. **STOPPED before `--confirm`
deliberately** — money-moving proof is the operator's to run.

### ⭐ THE PORTABLE LESSON

**A binding can only be tested across the thing it binds.** Twelve green suites missed a live
fail-open because every one of them ran in ONE process with ONE environment, where the two sides are
trivially identical and the comparison succeeds **for the wrong reason** — and the suites that mock
`readHealth` to always vouch cannot see a disagreement at all, because they remove it. Six suites went
red the instant the binding was made fail-closed: direct proof they had never exercised resolution.
Same family as [[absence-must-never-read-as-safe]] — an absence filled the result slot and read as
**agreement**.

### Commits
`961ff80` facilitator + unsigned-doesn't-settle · `609bec6` live-proof procedure + purchase probe ·
`49dfe8e` functions path on drafts · `1dd8f75` build binding fails closed (+ endpoint diagnostic) ·
`b9de582` cross-handler binding test (TEST-ONLY) · `0713b11` cron does not fire on drafts ·
(`9168a9b` exposure-flag drift correction). All pushed. **13 DD suites, `test:dd` exit 0.**
Deposit path untouched throughout: `_vault.mjs` and `shared/onchain-facts/` pass `git diff --quiet`.

### NEXT SESSION — THE MONEY STEP (fresh start, `docs/dd-live-proof-procedure.md`)

1. **Re-trigger the canary by hand** (the cron will not do it), then proceed **within 30 minutes**.
2. `probe-dd-purchase.mjs --confirm` — spends **$0.06 USDC**.
3. `202 + handle → retrieve polls → 200`. Settlement is a ~15.4 min batch flush, so expect anywhere in
   (0, ~15.4 min). Running out of poll budget is **not** a loss — the entitlement is permanent.
4. Confirm **from chain, not from the seller**: report `attestation.status === "signed"` and verifying
   on-chain (`isValidSignature → 0x1626ba7e`, EIP-191 digest **not** raw keccak256), and the revenue
   wallet's Gateway balance up **exactly 60000** (`availableBalance`, selector `0x3ccb64ae` — **not**
   an ERC-20 Transfer, which is never emitted).
5. **Then the no-charge path**: break the signer on the draft (invalid `CIRCLE_API_KEY`,
   `deploy-preview` only) and buy again. Must cost **$0.00** — and the proof is not the JSON saying
   `charged:false`, it is the **balance NOT moving**.

🚨 **Prod `DD_PUBLIC_ENABLED` is still "No value set" — KEEP IT THAT WAY.** All env work stays
`--context deploy-preview` (confirmed: CLI drafts land in that context). **NEVER `--context all`** —
that includes production and re-arms exactly what `210ffeb` disarmed.

⚠️ Also still open: the frozen service doc (`bafkreigton…`) says *"payment / x402 metering — NOT
built"*. Its bytes cannot change; the correction goes in the **mirror README**.

---

## 2026-07-28 — DD SERVICE: engine COMPLETE, facilitator DECIDED + DE-RISKED (not built). x402 phantom-charge fixed in prod code.

**Everything below is on `main` and pushed. NOTHING is deployed to prod** — all wire-proof ran on
DRAFT deploys, deliberately (see the exposure trap below). Covers the DD engine finish (endpoint,
settle-gate, ERC-1271 attestation, canary), the facilitator decisions, and two defects found and
fixed in the already-shipped `x402-quote`.

### DD ENGINE — COMPLETE
- **`POST /api/dd-analyze`** (`885d1be`) — analyze() exposed. Wire-verified on a draft: 108/0, including
  the property only a real deploy can show — Netlify does NOT interpose its own error page on bad input,
  so the handler's structured 400/405 refusals arrive intact.
- **ERC-1271 attestation under agentId 851891** (`375993f`) — canon/1 + signing, 55/0 incl. a live pass.
  Binding is two on-chain reads (`ownerOf` → the SCA, then `isValidSignature` → `0x1626ba7e`); nothing
  is declared, so nothing must be trusted. ⚠️ The digest is the **EIP-191** hash, NOT raw keccak256 —
  raw returns `0xffffffff` and a verifier hashing report bytes directly reads a VALID signature as
  invalid.
- **x402 settle-gate** (`d9df4fa`) — 48/0. ⭐ Charge for answers, not outages. The gate is NOT "did
  analyze() return a report object" (that would have CHARGED FOR AN OUTAGE — analyze returns a report
  for everything except programmer error); it requires a report + a coverage manifest accounting for the
  whole catalogue + `refusal === null`. THIN reports settle; outages do not.
- **Canary + safe-public schedule** (`1f6f106`, `ff46b1d`) — 54/0 and 58/0. Dead-man's switch INVERTED:
  the canary only ever writes PASS, so absence / staleness / unreadability / version-drift all REFUSE.
  12 ways it can die, none returns `serve:true`. Public invocation is safe by ABSENCE OF A CHANNEL — the
  handler reads only platform-injected `event.blobs`; 9 hostile payloads + an empty request produced
  BYTE-IDENTICAL records.

🚨 **THE PUBLIC ROUTE WAS NEVER "WITHHELD" IN CODE — THAT WAS A TRAP, NOT A DECISION.** The
`/api/dd-analyze` redirect is COMMITTED in `netlify.toml`. Prod was clean only because nobody had run
`netlify deploy --prod`; the next one would have published a free public signed-attestation endpoint
with no further action. Netlify has no per-function deploy, and **removing the redirect would NOT have
fixed it** — every deployed function is reachable at `/.netlify/functions/<name>` regardless of
redirects. Deployed-but-inert therefore required an in-code fail-closed flag.

✅ **CLOSED — the flag is BUILT (`210ffeb`, 36/0).** `netlify/functions/_dd-exposure.mjs`, checked at
**RUNG -1** in `dd-analyze` (before health, before validation, no blob or chain read).
**`DD_PUBLIC_ENABLED` unset = DISABLED**, and so is anything unrecognised — only
`{1,true,on,yes,enabled}` (trimmed, case-folded) serve. Refusal is a structured `service-not-enabled`
/ 503 / unsigned report, so it composes with the settle gate for free via `refusal !== null`.
⭐ The INVERSE of `_pause.mjs`: that is a kill switch (unset = RUNNING), this is an exposure flag
(unset = OFF). Same rule — a typo must never widen — opposite directions.
**Verified in prod 2026-07-28**: `netlify env:get DD_PUBLIC_ENABLED --context production` returns the
*"No value set…"* sentinel, i.e. UNSET → DISABLED. Deploying is no longer the same act as publishing.

⚠️ **PRECISION — the gate covers `dd-analyze`, NOT `dd-canary`.** `dd-canary` has zero references to
`_dd-exposure`/`DD_PUBLIC_ENABLED` and its `*/10` schedule is in `netlify.toml`, so **a prod deploy
starts the canary cron**. That is the INTENDED design, not an oversight: the canary is hermetic and
safe-public (it reads only platform-injected `event.blobs`, writes only PASS, and touches neither
`_vault.mjs` nor `_pause.mjs`), and it must run to keep the health artifact warm — without it
`dd-analyze` would refuse `service-unverified` anyway. So the correct framing of a prod deploy today
is **"lands `dd-analyze` inert and starts the canary cron by design"** — NOT "publishes free
attestations".

### FACILITATOR — decided + de-risked, BUILD NOT STARTED
- **Confirmation read**: `availableBalance(USDC, payTo)` on GatewayWallet
  `0x0077777d7EBA4688BDeF3E311b846F25870A19B9`, selector **`0x3ccb64ae`**, threshold against a baseline
  snapshotted BEFORE settle. Fail-closed: an unreadable balance is INDETERMINATE, never "unpaid".
  ⚠️ **NOT nonce-scoped, and NOT per-payment attributable.** `authorizationState(address,bytes32)`
  (`0xe94a0102`) exists on Arc USDC but **REVERTS on GatewayWalletBatched**, so the exact per-payment
  read is unavailable on this path. `availableBalance` is an AGGREGATE, so concurrent equal-amount
  payments CROSS-CONFIRM. Aggregate-correct only — do not let anything needing true attribution inherit
  it. (A dedicated payTo is what keeps it sound at all.)
- **payTo**: dedicated revenue wallet **`0xb407967319d56218c7e1c369125490e665a16ac4`**
  (walletId `819fe387-f553-554d-b095-9b7ced9e49a4`, `235d6dc`). Verified 0.000000 at creation. ⭐ Its
  zero history IS the design — Transfer/balance reconciliation is attributable ONLY if the wallet's
  entire history is DD revenue. **It must receive nothing else and must not be funded.** Every existing
  wallet was disqualified by holding a float (VANILLA_SELLER's non-round 0.308114 = prior receipts).
- **v1 pricing**: flat **$0.06/report**. Thin and unknown-shape reports SETTLE — coverage is a
  first-class answer and the manifest ships inside the artifact.
- **Shape**: `402 → pay → 202 + handle → retrieve → 200`. Built and WIRE-PROVEN on `x402-quote`
  (`1ac1388`), end-to-end on a real draft deploy: 165 retrieve polls all `202`, then `200` with evidence
  `baseline 8000 → balanceNow 9000, amount 1000`.

### ⭐ SETTLEMENT LATENCY — a ~15.4 min BATCH FLUSH CYCLE, not open-ended variance
Measured by real settlements (`scripts/dd/probe-settlement.mjs`, `probe-settlement-batch.mjs`),
n=5 confirmed of 5 attempted:

**RANDOM-PHASE samples — these characterise a real payment** (each fired cold, from a separate probe
run, so it arrived at an arbitrary point in the cycle):

| # | latency |
| --- | --- |
| A | **41.9 s** |
| B | ~3 min |
| C | 14.5 min |

**SEQUENTIAL samples — these measure the CYCLE, not a payment** (each fired immediately after the
previous confirmed, i.e. right after a flush, so each waited a full cycle):

| # | latency |
| --- | --- |
| D | 928.3 s (15.5 min) |
| E | 930.1 s (15.5 min) |
| F | 929.4 s (15.5 min) |
| G | 914.7 s (15.2 min) |

⭐ **D-G agree to within 15 s on ~925 s (1.7% variation). That is a CLOCK, not a distribution — the
Gateway BATCH FLUSH INTERVAL, measured four times.** And A-C (0.7 / 3 / 14.5 min) are spread across
that interval exactly as uniform arrival into a fixed cycle predicts.

🚨 **METHODOLOGICAL FLAW, stated because it inverts the naive reading.** The batch prober is
STRICTLY SEQUENTIAL — necessarily so, because concurrent payments to one payTo CROSS-CONFIRM against
an aggregate balance and would have fabricated a fast distribution. But sequencing means each run
fired *immediately after the previous one confirmed*, i.e. immediately after a flush, so every run
after the first waited a FULL cycle. **The design systematically worst-cased samples 2-5.** Only
sample 1 (41.9 s) observed a random arrival phase.

**So the earlier "untunable, ~22x spread" framing was TOO STRONG and is corrected here.** The 22.2x
figure is a measurement artifact, not system variability. For a randomly-timed payment the expected
behaviour is ~uniform over **(0, ~15.4 min)**, averaging ~7.7 min, with the tail **BOUNDED BY THE
FLUSH CYCLE** rather than open-ended.

**What survives the correction, and is still the point:** a payment DID exceed the 15-minute
`RETRIEVE_TIMEOUT_MS` and the artifact was **still delivered**, because timeouts bound POLLING ADVICE
ONLY and never gate the entitlement. That structural property does not depend on the flush interval
being knowable — and a flush interval is Circle infrastructure that can change without notice, so an
entitlement that survives a wrong timeout stays correct either way. ⭐ *Choose the failure direction
so a wrong number costs a round trip, never a paid-for entitlement.*

⚠️ Two latency figures previously cited were NOT measurements: "~470 ms" was **canned demo text** inside
`liveDataset()`, and "7 days" was over-reading `minValiditySeconds` (which bounds the AUTHORISATION's
validity, not settlement).

### x402-quote — TWO defects found in shipped code, both fixed
1. **Phantom charge, mirror image** (`1ac1388`) — it served the artifact on `facilitator.settle()`
   success, which is ~3 min to 15.5 min BEFORE the money moves. Now serves on CONFIRMATION. The shape
   change was unavoidable: the file's own header said settlement "must finish inline", impossible at
   minutes against a 10s ceiling. Buyer (`_x402.mjs`) taught the 202 shape in the same commit — without
   it a working payment reads as a 502 seller failure. 34/0.
   ⚠️ Settlement is an **INTERNAL GATEWAY LEDGER credit, NOT an ERC-20 Transfer** — payTo's token
   balance never moves and ZERO Transfer logs are emitted, so the obvious `eth_getLogs` confirmation
   would have found nothing FOREVER while failing to look exactly like "payments pending".
2. **Fiction labelled as fact** (`b906a42`) — the payload asserted invented figures as present-tense
   measurements. ⭐ The honest qualifier was in the field being DISCARDED: `extractFacts` resolves
   `source: String(f.source ?? src)`, so a fact's own source wins and the honest fallback applies only
   when a fact has none. Fixed at the per-fact `source`; `asOf` → null (a fresh timestamp on unmeasured
   values is what made them read as current); the precise `~0.92 s` figure REMOVED rather than
   relabelled; the `~470 ms` claim now states it was wrong and gives the measured range.
   🚨 This was not hypothetical: that fabricated ~470 ms was cited back as EVIDENCE in this thread's own
   design discussion while probes measured 42 s to 15.5 min.

### Commits this thread
`75bd7bc` probe · `235d6dc` revenue wallet · `1ac1388` x402-quote phantom fix (both sides) ·
`b906a42` x402-quote relabelled honest · `210ffeb` inert-deploy exposure flag ·
(earlier: `885d1be` endpoint, `375993f` attestation,
`d9df4fa` settle-gate, `1f6f106` canary, `ff46b1d` safe-public schedule)

### Honest limits
- **Nothing is deployed to prod.** All wire-proof is on draft deploys.
- The DD `/api` route is committed — see the trap above. The inert-deploy flag IS built (`210ffeb`)
  and prod's `DD_PUBLIC_ENABLED` is verified UNSET, so a prod deploy would land `dd-analyze` inert.
  ⚠️ The same deploy DOES start the `dd-canary` `*/10` cron — by design, and not covered by the flag.
- Facilitator build not started. `SettleResponse.transaction` contents still unknown (`_x402.mjs`
  discards the receipt).
- x402-quote is publicly payable by anyone; now honestly labelled, still a demo instrument.


---

## 2026-07-17 — #/unified deposit throttle handling: hex fix → tri-state → widen → Lever 1 (Multicall). Lever 2 parked.

**Shipped to `main`, NOT deployed (deploy is the user's terminal).** Four commits, one UI + three on the
unified-balance deposit path. Prompted by a prod screenshot: `#/unified` deposit rendered a wall of raw
viem hex ("request limit reached"). Evidence throughout is prod Blobs records in the `ub-deposits` store,
not guesses — pulled with `netlify blobs:get ub-deposits dep:<id>`.

### What the throttle actually is (settled from source + records, several wrong theories discarded)
Arc's public RPC (`rpc.testnet.arc.network`) rate-limits at a few calls/sec and answers with a **JSON-RPC
error body** — viem's `RpcRequestError`, message `RPC Request failed.` + `Details: request limit reached`,
**no HTTP status**. viem's `shouldRetry` retries only the numeric codes `-1/-32005/-32603/429` (verified
verbatim in viem 2.52.2, `shouldRetry` in `utils/buildRequest.js`: `-1`, `LimitExceededRpcError.code`=−32005,
`InternalRpcError.code`=−32603, `429`, then `return false` for any other numeric code). Arc's code isn't
among them, so **viem never retried** — proven independently by timing: its backoff forces ≥1.05s, yet two
failures finished the whole function in ~0.61s. (The timing is what's directly observed; "Arc's code is
outside the retry set" is what that timing ENTAILS — the records captured the text "request limit reached",
not Arc's numeric JSON-RPC code, so don't go hunting for a captured code that was never recorded.) NOT an
HTTP 429, so "429-without-Retry-After" is the wrong
mechanism — corrected before it entered a commit message. The reliable classifier is therefore a **message-regex on
`request limit`** (the DD tool's `TRANSIENT` pattern), not viem tuning.

### The commits (newest last)
- **`08b53ec`** — UI only: moved the "Your money" three-card block off the Dashboard onto `#/wallet`'s
  connected state (`YourMoney.tsx`). Onboarding path preserved; faucet/Disconnect/EURC carried over.
- **`e796a80`** — `_retry.mjs` (bounded backoff, `TRANSIENT` regex + 250·2ⁿ, own copy — no prod→`scripts/dd`
  dependency); `_delegate.mjs` `.catch(()=>false)` → tri-state (`readAuthorizationTriState`): a throttled
  auth read is **UNKNOWN** (`DelegateAuthUnknownError`), never a false "not authorized", and never falls
  through to a gas-paying `addDelegate` on unobserved state. Raw `e.message` → `errorDetail` (unrendered).
- **`14f5bee`** — widened: ALL four reads via `withRetry` (the first fix wrapped only the two in the logs;
  the next deposit throttled on the unwrapped `allowance` read — record `dep:07fdbcb0`). Flag honesty:
  `transient` now derived from `isTransient(e)` walking `.cause`, not a `withRetry` stamp (a stamp
  false-negatives on any unwrapped read). Fixed unconditional `this.transient=true` that would flag a revert
  as a rate-limit; generic fallback no longer asserts "temporary" for genuine failures.
- **`19a1cfd`** — Lever 1 (below).

### Lever 1 — DONE (commit `19a1cfd`). Fewer RPC round-trips.
Removed the redundant `allowance` read (**proven safe on-chain**: USDC on Arc is FiatTokenV2, and a
Multicall3 `[approve(100), approve(200), allowance]` eth_call returned `200` — a non-zero→non-zero approve
overwrites directly; no USDT-style `require(allowance==0)`, so the reset-to-0 dance defended a hazard this
token doesn't have). Batched the **two genuinely pre-write reads** — `balanceOf` + `isAuthorizedForBalance`,
both before the `addDelegate` write at `_ubdeposit.mjs:201` (batch at :160, only an in-memory funds check
between) — into **one Multicall3 call** (verified deployed on Arc testnet at `0xcA11…CA11`, 3808 bytes,
aggregate3 agreed with direct reads on both contracts). The post-grant `balanceOf` re-read stays sequential
by design — it exists to observe the grant's gas effect, so batching it would read stale pre-grant state.
**Net: common deposit path 3 reads → 1 round-trip** (first deposit 3 → 2).

**Effect: REDUCES throttle EXPOSURE** (fewer round-trips = fewer chances to hit the limiter). It does **NOT**
make a deposit survive a **sustained (90s+) throttle** — one Multicall3 call is still one call, and a
limiter saturated beyond `withRetry`'s ~3.75s budget still fails (now with correct `transient:true` + a calm
message, no hex). This morning's throttle outlived 90s, so that case is real.

### Lever 2 — PARKED (the reliability fix for sustained throttle). Do not re-investigate Lever 1.
The fix for a **sustained** throttle is **Lever 2 ONLY** — a better/paid RPC endpoint or a fallback
provider — **not** more read-shaving. Lever 1 is done and there is no further safe batch: the remaining
reads are write-separated (the post-grant re-read must see the grant), so they cannot be collapsed. **Pull
Lever 2 only if a sustained throttle bites a real deposit in practice.** Recorded so Lever 1 is not
re-opened.

### Honest limits (unchanged by any commit above)
- **Live throttle across the batched path is still unproven** — the batch is verified end-to-end against a
  quiet chain; no throttle has hit the widened/batched code in prod yet.
- One reporting nuance: a throttle on the (now batched) `isAuthorizedForBalance` read surfaces as
  `TransientChainError` (`fundsMoved: undefined`) rather than `DelegateAuthUnknownError` (`fundsMoved:
  false`). User message is equivalent; makes the two pre-write reads consistent. Plumb back only if that bit
  matters when seen in a record.

---

## 2026-07-16 — COMPETITIVE RECON (read-only): is anyone building Tikpema on Arc? Arcent + anchor-x402 chain-checked.

**Not a park — a landscape read.** Question asked: are many Arc builders building something similar to
Tikpema? Answer: **the category is crowded, the discipline is not, and on Arc specifically there is
currently no working competitor.** Nothing built, integrated, signed, or paid; GETs and unpaid 402
challenges only.

### The ecosystem is agent-saturated
[ETHGlobal HackMoney 2026](https://www.arc.io/blog/meet-the-arc-track-winners-from-the-hackmoney-2026-hackathon-and-what-we-learned):
**155 teams on Arc Testnet**, and per the organizers **97% of submissions used AI agents**, 56%
crosschain. Agora Agent Hackathon: 252 submissions. lablab has run ≥3 Arc agent hackathons. So
"AI agent that pays with USDC on Arc" is **the single most common idea on the chain** — not a niche.
Winners were capability plays: **arctan(x)** (institutional FX DEX), **Text-to-Chain** (SMS wallets),
**ArcFlow** (self-paying treasury), **Versus** (creator-economy agents); honorable mentions for invoice
escrow, treasury rebalance, prediction-market capital. **Per that write-up, NONE documents** a passkey
wallet, multi-agent spending caps/kill switches, an audit trail of agent spend, x402-paid research, or
ERC-4626 owner-power inspection. Everyone builds what an agent *can do*; almost nobody builds proof it
*cannot rob you*. That gap is Tikpema's actual differentiator — not the agent, the disclosure layer.

### ARCENT (`github.com/cutepawss/arcent`) — claim UNSUPPORTED. Not a competitor.
Claims *"The first x402 implementation on Arc Network with Pay-on-Success Protection"* (Gemini
Honorable Mention, Agentic Commerce on Arc).
- **Its Arc settlement path targets a contract that does not exist on Arc.**
  `gateway/services/arcExecutor.js` — header: *"Executes real on-chain transactions using
  transferWithAuthorization … submits Agent's signed authorization"* — hardcodes
  `usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e'`. That is **Base Sepolia's USDC**. Verified:
  `eth_getCode` on Arc testnet returns **`0x` — NO CODE** at that address, while Arc's real USDC
  (`0x3600…`) returns 3,598 chars. The address is **hardcoded with no env override**, so it was never
  configurable. Every `transferWithAuthorization` on that path calls a non-contract ⇒ **it cannot have
  settled on Arc.**
- **No counter-evidence exists:** zero tx hashes in the repo, no arcscan links. `arcent.vercel.app`
  serves a frontend (200) but every gateway API path **404s** — backend not deployed.
- **Dead:** created 2026-01-21, **last pushed 2026-01-22** (a 2-day hackathon build, cold ~6 months),
  0 stars, 0 forks.
- **Read it as an unchecked copy-paste, not dishonesty** — but the lesson is the file's own:
  a badge is not a deployment. **The only claimed Arc x402 implementation does not work. Nobody is
  competing with Tikpema on Arc today.** (Its "executor pays gas, agents only sign" idea is sound —
  Tikpema does that properly via Gas Station + paymaster.)

### ANCHOR-X402 (`api.anchor-x402.com`) — REAL, and it independently validates our primitive.
- **Live and maintained:** `/health` ok, OpenAPI **v0.3.0**, 21 paths, **18 services** on three rails,
  uptime monitor, npm `anchor-x402-mcp`, MIT.
- **⚠️ It runs OUR EXACT PRIMITIVE — verified on the wire.** Unpaid 402 on `/v1/roll` returns
  `network eip155:8453`, `scheme "exact"`, `asset 0x833589fC…` (Base USDC), and
  **`extra: {"name": "USD Coin", "version": "2"}`** — i.e. **the USDC token's own EIP-712 domain**
  (cross-checked on-chain: Base USDC `name()`=`"USD Coin"`, `version()`=`"2"`). **Token-domain
  EIP-3009, `payTo` straight to the seller EOA, no operator hop, no pooled pre-deposit.** Its docs
  state the same rule we enforce: *"no standing approval"*, one signature per call, exact amount shown
  before signing. **An independent live mainnet operator converged on the same design as
  [[vanilla-x402-pair-built-proven]] and the same objection we used to park Mahshar.** That is the
  strongest external validation of the primitive choice we have.
- **Real mainnet volume (modest):** `payTo` `0x127462e2…` (**EOA**) held **15.113 USDC**, with **25
  inbound payments over ~33h** (~60k Base blocks, tip ~48,723,024 on 2026-07-16). A **steady drip, not
  a burst** — contrast Mahshar's Arc-testnet 0.1134 USDC lifetime with 114/126 in a single day.
- **✅ BUYER IDENTITY CHECKED (upgraded from "inferred" — the demand looks genuinely independent).**
  The 25 payments came from **9 DISTINCT buyer EOAs** (11 / 4 / 3 / 2 / 1×5 payments each), spending
  **0.001–0.35 USDC across different endpoints** — i.e. exercising the catalogue, not replaying one
  call. Then the decisive test: **who funded the buyers?** A self-test fleet shows **one funder fanning
  out to many wallets**. That is **NOT** the pattern — the 9 buyers were funded by **11 DISTINCT
  sources** (49.96, 50.0, 30.0, 5.0 USDC etc.), each buyer with its own funder(s), and **the operator's
  `payTo` is NOT among the funders** (verified over ~240k blocks ≈ 5.5 days). One buyer has
  **nonce 605** — a long-lived wallet with real history, not freshly minted for a demo.
  - **Why several buyers show nonce 0 — this is CORRECT, not suspicious:** in vanilla x402 the buyer
    only **signs**; the facilitator submits and pays gas. A buyer that never sends a tx is the expected
    signature of a working EIP-3009 flow. (Useful tell for reading any x402 seller's books.)
  - **Residual caveat (unfalsifiable from chain alone):** common ownership across wallets can never be
    fully disproven, and one buyer self-transferred 20 USDC (mild clustering). But there is **no
    operator-funding link**, which is the falsifiable part — and it came back clean.
- **NOT on Arc, and not a competitor.** Rails are Base USDC / Solana USDC / JPYC-on-Polygon
  (`0x431D5dfF…`, `"JPY Coin"` v1). **Arc appears nowhere.** And it is the **SELL side** (18 paid
  services + a chat client); Tikpema is the **buy side** (agent console + roster). **It is a supplier,
  not a rival** — precisely what our Researcher would buy from *if we were on Base*.

### Strategic implications (no action taken)
1. **No Arc competitor exists today.** The only claimed one is a dead repo pointed at the wrong chain's
   token address.
2. **The primitive choice is externally validated.** The one real operator found uses token-domain
   EIP-3009 with no standing approval — the same conclusion we reached independently.
3. **The real x402 economy — actual money, actual sellers — is on Base/Solana MAINNET, not Arc.** This
   does not overturn the BlockRun/AgentCash parks; it explains *why* someone would eventually cross, and
   those entries already require the crossing to be **its own deliberate mainnet decision**, never a side
   effect of wanting a data source. **Unchanged: do not cross now.**

Sources: Arc HackMoney-2026 winners blog; lablab Arc hackathon recaps; `raw.githubusercontent.com/cutepawss/arcent`
(`README.md`, `gateway/services/arcExecutor.js`) + GitHub API repo meta; `api.anchor-x402.com`
(`/health`, `/openapi.json`, `/.well-known/x402.json`, unpaid 402 on `/v1/roll`); Arc RPC + Base RPC
`eth_getCode`/`eth_call`/`eth_getLogs`.

---

## 2026-07-16 — AGENTCASH (agentcash.dev): PARKED / DO NOT INTEGRATE — same reasoning as BlockRun (wrong chain).

Read-only recon of AgentCash, an x402 agent-payments platform. **Verdict: PARKED, do not integrate
— same reasoning as the BlockRun park (2026-07-08): it is a MAINNET/Base crossing, not an Arc
integration.** Nothing was built, integrated, signed, or paid.

- **It is a real x402 surface.** `/.well-known/x402` (version 1) and `/openapi.json` (v0.1.2,
  "Wallet management, search, and payment APIs") both serve live. `POST /api/search` with no payment
  returns a real **HTTP 402**, `x402Version: 2`, with a proper `resource` block. This is not vapor.
- **It settles on Base mainnet / Solana. There is NO Arc option — confirmed on the wire.** The 402's
  `supportedChains` are **`eip155:8453` (Base mainnet)** and **`solana:5eykt4Us…` (Solana mainnet)**.
  **Chain 5042002 is not offered.** So integrating means bridging to Base and signing **real mainnet
  USDC** — precisely the BlockRun trap already parked: it splits the one-chain Arc trust story and
  forces Tikpema's deferred mainnet crossing as a side effect of buying data.
- **The EIP-712 domain-mismatch hazard is REAL — now verified on-chain, both sides.** Arc USDC
  (`0x3600…`) `name()` = **`"USDC"`**; Base mainnet USDC (`0x8335…`) `name()` = **`"USD Coin"`**,
  `version()` = `"2"`. Different domain ⇒ **silent signature-verification failure**, not a loud error:
  a signature built with Arc's domain is simply invalid on Base. See [[arc-usdc-supports-eip3009-vanilla-x402]].
- **⚠️ Its non-custodial model is NOT chain-verified — do not record it as confirmed.** The 402
  returned **`accepts: []`**, because AgentCash gates payment terms behind **SIWX** (sign-in-with-X,
  `eip191`) *before* it will quote an asset, amount, or `payTo`. **So the settlement path — custodial
  vs. per-call non-custodial, and the signing domain — was NOT observable without authenticating, and
  I did not authenticate.** Per-call-x402-shaped is what the docs and the ecosystem
  (x402scan / mppscan) assert; it is **not disproven, just unverified** — this file's standard
  (`named ≠ deployed ≠ funded`). Any revisit must re-check it on the wire, not from the landing page.
- **Not permissionless, contra the usual x402 "no signup" pitch.** It requires a **SIWX wallet
  sign-in** before quoting a price, and exposes an `/api/invite-codes` endpoint — i.e. an identity
  gate plus a plausible invite gate. Vanilla x402's selling point is that neither exists.
- **Provider-side quickstart.** The quickstart reviewed was the **PROVIDER/sell side**
  (`/docs/sell-to-agents`), not the agent-buy path Tikpema would actually need. (The site does appear
  to document both; only the sell-side flow was read, so the buy-side integration surface is
  unassessed.)

**⚠️ Correction carried in from the Mahshar entry below — do NOT reintroduce it.** This park was
originally reasoned as "correct non-custodial model, **unlike Mahshar's drainable pool**." **Mahshar
has no pool and no drain — it has no contract at all** (verified: its `payTo` is an operator EOA and
settlement rides Circle's Gateway, whose ABI has no drain function and does have depositor-initiated
`initiateWithdrawal`/`withdraw`). Mahshar's real disqualifier is **counterparty risk — you pay an
operator's private key and nothing on-chain enforces the seller's payout**. The contrast to draw
against AgentCash is that one, not a drainable pool that does not exist.

**Status: PARKED. No spec, no code, no integration, no signature, no payment.** Revisit only if
EITHER: (a) AgentCash — or x402 generally — settles **natively on Arc** (chain 5042002, against the
Arc USDC token domain `name: "USDC"`), **or** (b) Tikpema itself moves to mainnet and the
Base-trust-story tradeoff is reconsidered **deliberately**, as its own decision rather than a
side effect of wanting a data source. On any revisit, re-verify the settlement model past the SIWX
gate first — it is currently unverified. Sources: `agentcash.dev/.well-known/x402`, `/openapi.json`,
a live unpaid 402 on `/api/search`, Arc RPC + Base RPC `eth_call` (`name()`/`version()`).

---

## 2026-07-16 — MAHSHAR (mahshar.xyz) x402 MARKETPLACE: PARKED / DO NOT INTEGRATE.

Read-only recon of Mahshar, an x402 API marketplace on Arc testnet (chain 5042002). **Verdict:
PARKED, do not integrate.** Nothing was built, integrated, or paid. Every fact below was verified
against `rpc.testnet.arc.network` + `testnet.arcscan.app`, not taken from Mahshar's docs.

**The verdict is right; the mechanism is NOT what it looks like from the outside.** The park was
originally reasoned as "a pooled `depositFunds` contract with an `onlyOwner emergencyWithdraw`,
owner-drainable, no depositor-withdraw path, and no confirmed settlement." **On-chain, all four of
those are false**, and they are recorded here corrected — a park note that misdescribes the thing
parked is how a future revisit gets mis-triggered (and this file's own standard is
"named ≠ deployed ≠ funded").

- **Mahshar has NO contract. Not a drainable one — none at all.** There is no `depositFunds`, no
  `emergencyWithdraw`, no escrow, no pool of theirs. The entire advertised payment path is
  **Circle's**: GatewayWallet `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` (ERC1967Proxy → impl
  `0x44eedDc963A48Eaff9e05200CaFf733f3721fC17`, **verified** on arcscan) and the Gateway Minter
  `0x0022222ABE238Cc2C7Bb1f21003F0a260052475B`. Mahshar's on-chain footprint is one private key.
- **The custodial risk is REAL but it is counterparty, not owner-drain.** The 402's `payTo` is
  `0x052650D1764406d702252B20B2294346A594A1ef` — **an EOA** (no bytecode; 17.06 USDC; 456 txs) and
  the *same* address that submits the `gatewayMint`. **The buyer pays the operator, not the seller.**
  Mahshar then pays the seller separately, and **nothing on-chain enforces that second leg**. The
  counterparty is a private key, not a contract you can read. That is the disqualifier.
- **A depositor-withdraw path EXISTS and is NOT owner-drainable** (the opposite of the original
  reasoning). Circle's GatewayWallet ABI carries `initiateWithdrawal` / `withdraw` /
  `withdrawableBalance` / `withdrawalDelay` — depositor-initiated, behind a delay. There is **no**
  drain/rescue/sweep function. Circle *can* `upgradeToAndCall` (UUPS; `owner()` `0x5b967871…`),
  `pause` (`pauser()` `0x3ee90d53…`, currently unpaused), `denylist`/`unDenylist`, and
  `updateWithdrawalDelay`. So: upgradeable, pausable, freezable **by Circle** — the same trust base
  as USDC itself — not by Mahshar.
- **The BUYER-SIDE objection survives; the general "pooled ≠ atomic" framing does NOT — see the
  correction below.** The primitive is an exact lookalike and is **not interchangeable** with the
  Researcher's. Same EIP-712 struct (`TransferWithAuthorization(from,to,value,validAfter,validBefore,nonce)`),
  same `scheme: "exact"` — but `domain.verifyingContract` is **`GatewayWalletBatched` (`0x0077777d…`),
  NOT the USDC token (`0x3600…`)**. Different domain separator ⇒ a `_research.mjs:301` signature is
  invalid here. Their docs: *"A raw EOA USDC balance on Arc testnet is not accepted — the facilitator
  checks Circle Gateway balance, not the token contract."* **To BUY, we would have to pre-load USDC
  into Circle's Gateway pool and then hit the known `GatewayWalletBatched` requires `from == signer`
  wall — the agent SCA cannot spend via a delegate signer.** That is a real, unchanged blocker. See
  [[batched-x402-requires-from-equals-signer]].
- **⚠️ CORRECTION (2026-07-16, found by reading our OWN prod): "pre-loaded pool" is NOT a stick to beat
  Mahshar with — WE SHIP THAT SCHEME.** `netlify/functions/x402-quote.mjs` is a **live seller on prod**
  (`POST app.tikpema.xyz/.netlify/functions/x402-quote` → real 402) and it advertises
  **`extra: {name:"GatewayWalletBatched", version:"1", verifyingContract:"0x0077777d…"}`** — the *same
  scheme and the same contract* as Mahshar. Our buyers must pre-fund Circle's Gateway to pay us. So
  pooled pre-deposit is **a property of Circle's nanopayments design, not a Mahshar defect**, and it
  cannot be cited as a trust-model demerit while we run it in production.
  **The Mahshar-specific disqualifier is narrower and still stands: the OPERATOR HOP.** Its `payTo` is
  an operator EOA that then pays the seller, with nothing on-chain enforcing that second leg. **Our
  `payTo` is our own wallet — the buyer pays the seller directly, no hop.** That distinction — not
  Gateway itself — is the whole objection. Keep it precise.
- **Real per-call settlement HAS occurred (also contra the original reasoning) — but it is de
  minimis and burst-shaped.** Confirmed: **126 `gatewayMint` payouts of exactly 0.0009 USDC** to
  seller `0x9bb9a984…`, **0.1134 USDC total** (~11 cents, lifetime, whole marketplace), window
  2026-06-27 → 2026-07-16, most recent **today**. But **114 of the 126 landed on one day** (07-14, the
  day after a 101-listing bulk import), then 7, then 1. That is the shape of an operator testing its
  own marketplace, not organic demand. Both seller wallets currently hold 0.000000 USDC.
- **Thinly populated, and the sellers do not own what they sell.** 118 listings (all `is_active`;
  the `/api/agent/discover` view caps at 50 and understates it) — but **107 of 118 from ONE wallet**,
  only **two distinct sellers total**, 101 created on a single day. `verified_at` set on **1 of 118**;
  `uptime` null on **all 118**. The upstreams are the well-known **free public-API directory**
  (`dog.ceo`, `catfact.ninja`, `pokeapi.co`, `jsonplaceholder`, `api.ipify.org`, `open-meteo`) resold
  at $0.001–$0.01/call.
- **Flags found in passing, if ever revisited.** (1) **Fee is ~18%, not the 10% advertised**: a
  listed 0.001 API bills **1100** micro-USDC (10% *on top*) while the seller receives **0.0009** (10%
  *off* the list) — Mahshar keeps 0.0002 of every 0.0011. (2) **Every 402 co-offers Base MAINNET**
  (`eip155:8453`, same `payTo`, same amount) — picking the wrong `accepts` entry spends **real money**.
- **⚠️ RETRACTED FLAG — the ~7-day authorization window was NOT a Mahshar red flag.** Originally filed
  as *"their docs recommend `validBefore = now + 604900`, versus ~60s for vanilla x402"*, implying they
  chose a footgun. **False. 604900 is Circle's `GatewayEvmScheme` DEFAULT**, inherited by anyone
  porting `circlefin/arc-nanopayments` — **including us**: `x402-quote.mjs:68-69` reads
  *"GatewayEvmScheme uses 604900s (7 days + buffer)"* and our **live prod 402 returns
  `maxTimeoutSeconds: 604900`**. A 7-day signed claim is still worth knowing about as a property of the
  batched scheme; it is **not evidence about Mahshar**, and the ~60s comparison was against a different
  scheme (token-domain vanilla), which is not what either of us runs here.

**Status: PARKED. No spec, no code, no integration, no payment.** Revisit only if ALL THREE — and note
each clause exists for a **different** reason, so do not collapse them (the first draft did, by
demanding they drop a pooled balance while we ship one):
1. **TRUST — the operator hop is gone.** `payTo` must be the **seller**, not an operator EOA that
   promises to forward. This is the actual disqualifier and it is about *them*. (Gateway/pooled
   pre-deposit is NOT part of this bar — we run that scheme ourselves on prod.)
2. **ABILITY — we can actually sign it.** Either it settles against the **USDC token domain**
   (EIP-3009, our `_research.mjs:301` primitive), **or** the `GatewayWalletBatched`
   **`from == signer`** wall is resolved for our agent SCA. This clause is about *us*, not a
   criticism of them: it is the buyer-side blocker.
3. **DEMAND — organic third-party volume.** The bar is not "any settlement" (that already exists, at
   11 cents) but volume from **independent** buyers/sellers not sourced from the operator's own
   wallet. Test it the way anchor-x402 was tested: a self-test fleet shows **one funder fanning out to
   many buyer wallets**; independent demand shows many buyers with **distinct** funders and no
   operator-funding link.

Sources: `mahshar.xyz/api/agent/discover`, `/api/apis`, a live unpaid 402 challenge, arcscan contract
verification, Arc RPC `eth_getCode`/`eth_call`/storage; corrections cross-checked against our own
`netlify/functions/x402-quote.mjs` and its live prod 402.

---

## 2026-07-15 — STAKING AGENT: PARKED / DECIDED — Arc has NO native staking by design. Do not re-investigate.

Read-only recon for a possible staking agent on Arc testnet (chain 5042002). **Conclusion: not
buildable as a staking agent; parked.** Recorded here so it is not re-investigated.

- **NO Arc-native staking — by design, not by absence.** Arc is **permissioned Proof-of-Authority**,
  not Proof-of-Stake. Per Arc consensus docs (`/arc/concepts/consensus-layer`): *"a permissioned
  Proof-of-Authority (PoA) model instead of anonymous economic staking… rather than anonymous
  participants staking tokens."* ~20 SOC 2 institutional validators, permissioned; full nodes cannot
  join consensus. **There is no staking token** (Circle's CEO is only "exploring" one; the Malachite
  roadmap notes a *potential* future PoA→permissioned-PoS shift — nothing exists, nothing announced).
  So a validator/security staking agent has nothing to call. This is not "empty like the x402 bazaar"
  — it structurally does not exist.
- **NO app-level staking contract verified live.** The first-party Arc contract-addresses page lists
  none (only USDC, EURC, USYC, CCTP, Gateway, FxEscrow, utilities). Curve/Euler/Fluid are *named*
  testnet participants but — same discipline as the vault recon — named ≠ deployed ≠ funded; no
  staking address surfaced. Not disproven, just unverified and not on the official list.
- **Nearest yield primitive = USYC — a possible FUTURE *yield* agent, NOT staking, different interface.**
  USYC (Hashnote tokenized T-bill yield) is first-party listed: token `0xe9185F0c…db86C`, Teller
  `0x9fdF14c5…dC105A`, Entitlements `0xcc205224…c26113`. Its exit is the *opposite* of the unbonding
  trap: redeems to USDC via the Teller **24/7, atomic, T+0 — no lock-up/unbonding/cooldown** (only a
  2pm-ET pricing cutoff). **The real gate is PERMISSION, not time: whitelist-gated via Entitlements** —
  a non-onboarded wallet can neither mint nor redeem. It is **Teller-based, NOT ERC-4626**, so the
  vault agent's `approve→deposit→redeem` machinery does **not** transfer. One item left unverified if
  ever revived: USYC's live testnet liquidity/funding on-chain (reads only; no writes were made).

**Status: PARKED. No spec, no code, no deploy.** If yield is revisited, the target is USYC-as-yield
(Teller + Entitlements interface), explicitly not "staking." Sources: Arc consensus-layer docs, Arc
contract-addresses, Hashnote USYC subscription/redemption docs.

---

## 2026-07-15 — THE VAULT AGENT: live rehearsal COMPLETE, chain-verified on Arc TESTNET. NOT ON MAINNET.

The Vault agent's deposit → withdraw → paused-semantics rehearsal ran end-to-end on prod against a
real ERC-4626 vault, and **every UI claim was verified read-only against Arc testnet** — no number
taken on trust. This is a **testnet dress rehearsal only. Nothing here is on mainnet, and no real
value moved.** The agent stays hidden from the user (registry `unlisted`, Dashboard card commented
out, `2342ed2`) — the rehearsal is done, but "rehearsed on testnet" is not "shipped."

- **Vault:** XyloNet USDC Vault (`xyUSDC`) `0x240Eb85458CD41361bd8C3773253a1D78054f747` — custom,
  unaudited ERC-4626 by ForgeLabs, the one live vault recon found on Arc testnet.
- **Agent SCA:** `0x60C369c5d9EE7b98d32856649549528c4f462710` · **USDC:** `0x3600…0000` · chain 5042002.

### THE THREE TRANSACTIONS — each confirmed `success` on-chain
| row | action | tx | on-chain result |
|---|---|---|---|
| 5 | deposit 1.01 USDC | `0x7e3af6aa70cc819869d45199fc4c94f88596a6d121dc82230a60d16b5370df1f` | minted 1009998 xyUSDC; SCA USDC 3.00 → 1.99 (delta = deposit exactly, gas sponsored) |
| 6 | withdraw (full) | `0xfd8456efc19afa057e419facf19122d6df1eac4190f066477bdb0c639ca880ab` | redeemed 1009998 sh → 1.00899 USDC net; **fee 1009 units = 0.0999% of gross** (≤ 0.10%) |
| 7 | withdraw **while AGENT.VAULT paused** | `0x6ea7f7589c24955153d2e2c83bb94db66de8284414664726893cac55d080985a` | redeemed 5999988 sh → 5.993997 USDC net; **fee 5999 units = 0.09998% of gross** (≤ 0.10%) |

### WHAT THE CHAIN PROVED (not the UI — the chain)
- **Round-trip integrity.** Deposit minted the shares the UI reported; withdraw returned the USDC
  the UI reported; the SCA's USDC balance moved by exactly those amounts, gas sponsored (no native-
  USDC gas skimmed from the balance).
- **The 0.10% exit fee is real and never exceeded.** On both withdraws the fee was a distinct
  on-chain USDC transfer to the fee recipient `0x94e0dc7AD29b94EC9819f6cEC3364DD34f41b3c6`, and in
  both cases the vault **rounded the fee DOWN** — 1009 vs a full 1010, 5999 vs a full 6000 — so it
  charged one unit *under* the disclosed 0.10%, never over. Disclosure held.
- **Pause semantics hold on-chain, not just in the UI.** With AGENT.VAULT paused: a deposit was
  attempted and BLOCKED — and left **zero on-chain trace** (the setup shows exactly 6 pre-pause
  deposits, no 7th; no Deposit event in the ~2.5-min gap before the paused withdraw). It was a real
  block, not a UI message — the deposit signed nothing. The withdraw in the same window SUCCEEDED,
  because a reclaim is deliberately pause-exempt (`_actions.mjs:107,127`).
- **Full share reconciliation, exact.** Across the whole rehearsal: deposits total **7009986** sh ==
  withdraws total **7009986** sh, residual **0**, live `xyUSDC.balanceOf` == **0**. A blocked deposit
  that had leaked would show as an extra Deposit event *and* leave residual shares. Neither exists.

> ⚠️ **TESTNET ONLY — NOT ON MAINNET.** Arc testnet (chainId 5042002), against an unaudited
> third-party vault, with test USDC. The rehearsal is chain-verified and complete; a mainnet path
> is NOT built, NOT proven, and NOT claimed. The one honest boundary: the exact instant the pause
> flag flipped lives in Netlify Blobs (off-chain), so "the pause window" is inferred from the
> behavioral sequence + block timestamps — every on-chain fact supports it, but that one edge is
> not itself an on-chain record.

---

## 2026-07-15 — THE THREE ERC-8004 INVARIANTS: written, audited, PINNED to IPFS, WIRED. NOT YET ON-CHAIN.

The bytes we intend to record as each agent's on-chain identity now exist, are pinned, resolve
from independent public gateways, and are wired into the endpoint — **but nothing is registered
on-chain yet.** The whole point of the exercise: an ERC-8004 identity is a permanent pointer, so
every claim in it had to be checked against the code that RUNS, not against how it sounds.

### THE DOCUMENTS — audited line by line, verified against the running code (`cdd4530`)
`agent-metadata/{researcher,second-opinion,executor}.json`. **Four claims were FALSE and are
fixed; three more were overstated and are reworded.** Each was checked against a code path.

**FALSE — fixed:**
| claim | truth |
|---|---|
| Researcher `propose_only` | → `autonomous_spend_within_caps`. It buys data with NO per-purchase approval — `decidePurchase` → `canSpend()` → signs. The user approves the JOB, not the purchase. |
| Executor: "funds in a wallet only their passkey can open" | **The most dangerous line.** FALSE — the float is a Circle DEV-CONTROLLED SCA (only the server moves it, `agent-withdraw.mjs:7`); the passkey opens the user's OWN MSCA. Replaced with the custody truth, blunt: "custodial and we do not dress it up." |
| Second Opinion `kill_switch: true` | Was a **DEAD switch** — nothing honoured it. Fixed in code (`89f154c`, below) BEFORE the document was allowed to assert it. |
| Researcher: "cannot pay an arbitrary address" | `payTo` comes from the SELLER's x402 challenge — not constrained by our code. Now disclosed as a trust assumption in the configured seller, not a guarantee. |

**OVERSTATED — reworded:** Executor "proven on-chain" → "BY CONSTRUCTION" (withdraw contains no
pause check at all — a stronger, honest claim; no test proves withdraw-while-paused so we claim
none) · Executor autonomy → `never_autonomous_user_approval_required` · Second Opinion "blinded
from the first analyst" → sees the PROPOSAL but never the reasoning/sources, and re-derives every
figure. `owner_key_custody` is now **byte-identical across all three** (sha256 `6743581f05c2…`) —
three documents describing the same key must not differ by a sentence. The cold owner key stays
untracked (`.gitignore`: `.keys/`, `*.key`, `*.privkey`, `cold-owner*.json`).

### PINNED & VERIFIED (`ee40c93`, `4a7b3a2`) — `scripts/pin-invariants.mjs`
Pins the three files to Pinata **as raw bytes** (no re-serialization), asserts each file's sha256
against its `cdd4530` commit hash BEFORE pinning, then fetches each CID back **from a neutral
public gateway** (ipfs.io / dweb.link / cloudflare) and re-hashes — proof the pin is real, public,
and unmodified. `cidVersion: 1`, raw-codec `bafkrei…` CIDs (the form agent metadata URIs use),
derived locally and deterministically from each file's own sha256 so the CID does not depend on
what Pinata returns.

> 🔑 **THE JWT-SHAPE AUTH GATE.** `PINATA_JWT` must be whitespace-free, start with `ey`, have
> exactly 3 dot-segments, and exceed 100 chars — else it dies AT THE GATE before any network call.
> Why shape, not non-emptiness: `netlify env:get VAR` prints "No value set…" to **stdout with exit
> 0** when the var is absent, so `export VAR=$(…)` captures that 74-char sentence as a fake
> non-empty value and `[ -n "$VAR" ]` waves it through — exactly the trap that made `PINATA_JWT`
> look set when it wasn't, and Pinata then 401'd. (Same env-var trap logged in memory.)

### WIRED (`a608c0d`) — the endpoint stops claiming an authority it cannot provide (`9beb394`)
`/api/agent-parameters/<id>` now serves the per-agent CID. **DONE** — verified in the shipped file:
```
researcher     ipfs://bafkreicdicy7hhb45ayygkt457jfx4ucswey7nknhcvg2gexsp4opbminy
analyst_b      ipfs://bafkreifzi7ia4djdp7ukbnf2hwndeys5p7cwre66lrlnroqmwpyaqqo7om
executor       ipfs://bafkreic5eefpf3c67l2ti2mxmgpo7qwtzao3mtrc23cmcrlrefazqgxxdi
```
The block was reworked FIRST (`9beb394`): it used to serve `kind: "immutable-invariants",
mutable: false` — a lie, because this is a mutable server anyone who can deploy can edit, and the
reader has no hash to check it against. **An unverifiable claim of immutability is WORSE than no
claim.** It is now `kind: "pointer-to-authoritative-invariants"` with
`invariantsUriStatus: "PINNED & RETRIEVABLE, NOT YET ON-CHAIN"` and a `howToVerify` that routes
the reader to `tokenURI(agentId)`, not to us. The `/api/v1/` route is frozen with a DO-NOT-CHANGE
banner in `netlify.toml` because a chain pointer here would be permanent.

### ⏳ PENDING — do not soften the status until these land
- **On-chain registration of the three real agents — NOT DONE.** They remain UNREGISTERED. The
  only agent on-chain is throwaway `850337` (the probe, below). Until `tokenURI(agentId)` records
  the exact CID above, the served URI has **no on-chain authority** and the status string says so.
- **Second-provider IPFS redundancy — NOT DONE.** Pinned to Pinata only; one pinning provider is a
  single point of failure for a pointer meant to outlive us.
- **`git push` — NOT DONE.** ~20 commits (this arc) are LOCAL only.

---

## 2026-07-14 — THE KILL SWITCH WAS DEAD: the Second opinion's pause enforced NOTHING. FIXED.

The Agents page offered a pause toggle for the Second opinion and **nothing honoured it.**
`assertNotPaused` was called for `RESEARCHER` (`_research.mjs:284`, `job-run.mjs:85`) and
`EXECUTOR` (`agent-send:64`, `_actions:85`, `agent-ub-spend:78`) — and **NEVER for `ANALYST_B`.**
Its sole caller ran `analystB()` regardless. A user could pause the agent, watch the UI say
"paused", and it kept running. **A control the UI presents and the code ignores is worse than no
control.** Found while auditing the metadata about to be recorded permanently on-chain — the
document claimed `kill_switch: true`, which would have made a dead switch immutable.

**THE FIX (`89f154c`).** `assertNotPaused({ owner, agent: ANALYST_B })` before `analystB()`. A
paused B maps to verdict `cannot_verify` — the SAME state as B crashing — which `_synthesis.mjs`
already treats as `proposalSurvives: false`. So:

> **PAUSING THE REVIEWER DISABLES PROPOSALS. It does not silently disable the CHECK on them.**

That is the only fail-closed reading — letting a proposal through unreviewed because the reviewer
is off would turn a safety switch into a safety hole. It falls out of the existing design, not a
new branch. **MISFIRE CHECK** (the guard must not kill every proposal in prod): `connectLambda`
runs before the guard so Blobs is configured; `isAgent("analyst_b")` is true; owner is already
required (400 without it). **DISARM CHECK**: the two files referencing the handler exercise neither
`analystB` nor `compareAnalyses` — nothing downstream is neutered.

---

## 2026-07-14 — GATEWAY MONEY HAS NO WAY OUT: production copy said "time-delayed release" — FALSE. FIXED.

The UI told users their unified-balance money could be released, just slowly:
*"Releasing it is time-delayed and goes through the server."* **That is false. There is NO release
path — not a slow one, none.** No `initiateWithdrawal`, no `gatewayWithdraw`, no delay constant
anywhere in this codebase. `_gateway.mjs` holds an address and nothing else. The only Gateway WRITE
path (`_ubspend.mjs`) **spends** the balance cross-chain. And the user cannot route around the
server: the agent wallet is a Circle DEV-CONTROLLED SCA. **Deposited Gateway funds are SPENDABLE
CROSS-CHAIN ONLY.**

**ROOT CAUSE (`agent-withdraw.mjs:38`).** A comment described the *contract's* delayed-withdrawal
capability (`initiateWithdrawal + withdraw after withdrawalDelay`). Every downstream reader took it
to mean a path EXISTS and is merely slow, and shipped copy saying so. **A capability the contract
has and we never built is not a capability the user has.** Circle's GatewayWallet exposes it; THIS
APP IMPLEMENTS NO PART OF IT.

**THE FIX (`9f2d4d0`).** All user-facing strings now say the same true thing — *"Money in the
unified balance cannot be withdrawn back to you — not by you, not by us… It can only be spent."*
Fixed across the Fund button + balance explainer (`UnifiedBalancePanel`), the Withdraw warning
(`Dashboard`), and the SERVED string in `agent-parameters.mjs` (now `irreversible: true`,
`canFundsBeReturnedToTheUser: "NO"`). Dropped "not lost" everywhere — if there's no way back,
"not lost" is a distinction without a difference. **The claim no longer survives a grep**; every
remaining hit is a labelled post-mortem asserting the mechanism does NOT exist.

---

## 2026-07-14 — THE giveFeedback PROBE: a passkey MSCA CAN attest gaslessly (agent `850337`).

The question under test, and nothing more: **can a user's passkey MSCA call
`ReputationRegistry.giveFeedback` gaslessly?** Answer: **YES.** Control (`USDC.transfer(self, 0)`)
and test (`giveFeedback`) were BOTH sponsored by Gas Station from the same wallet in the same
session, paymaster `0x03dF76C8…3103b`, the MSCA's USDC balance **unchanged across both**. The
earlier *"paymaster stake or unstake-delay too low"* failure was the **account-DEPLOYMENT**
sponsorship surface, not the target contract — it disappears once the wallet is already deployed.
(Confirms the memory note: probe with an already-deployed wallet + a control op.)

`scripts/probe-register-agent.mjs` is committed (`bcb6105`) as the **RECORD** of how throwaway
agent `850337` came to exist — `agentId 850337`, owner `0xc54D4721…e621` (the dev SCA), tx
`0x1ba87277…3337`. It registered from the DEV-CONTROLLED SCA self-paying gas (no paymaster) *on
purpose*, so getting an agentId wouldn't become a second variable in the question under test.
**Header marked ⚠️ ALREADY RUN — DO NOT RE-RUN**: running it again mints another agent on-chain
for no reason. The three real agents remain UNREGISTERED.

---

## 2026-07-13 → 07-14 — /api/agent-parameters: the endpoint born, then hardened against its own lies.

A read-only, public, no-auth `GET /api/agent-parameters/<agent>` reporting the caps and invariants
each agent is actually bounded by (`90318ff`). **Every number comes from the same fail-closed
helpers the money paths call** (`sendCap`/`swapCap`/`bridgeCap`/`maxSpend` + the `ub*` trio,
`budgetConfig`) — it reads no env var of its own and hardcodes no value, so the view cannot drift
from what is enforced: if it says the send cap is 10, `agent-send` rejects 10.000001. Two
distinctions are structural: **parameters vs invariants** (a dial vs a wall — an absent code path,
not a cap of zero) and **maximum vs minimum** (the UB spend FLOOR is a minimum; a floor of 10 in a
list called "caps" reads exactly backwards). Misconfiguration is REPORTED, not hidden:
`status: "misconfigured", usdc: null, enforced: "REFUSED"`.

Building it forced a chain of corrections — the endpoint exists to stop a reader mistaking a dial
for a wall, and it had no business doing the same thing itself:

### 1. THE RESEARCHER DOES MOVE FUNDS — a false invariant, corrected (`c7ab2e7`, `b35e788`, `08315e0`)
The endpoint shipped: *"This agent CANNOT move your funds. There is no code path…"* **False.** The
call graph has exactly one exit to value: `_research.mjs:301 payX402()` → `_x402.mjs
signTypedData()` → EIP-3009 `TransferWithAuthorization` → **real USDC leaves the user's wallet to
pay a data seller.** A parameters endpoint reporting a live spend path as no-path-at-all is the
worst thing it can do — the reader's takeaway is the opposite of the truth. `movesFunds` flipped to
**TRUE** for the Researcher, the x402 purchase listed as the movement surface it is. **`movesFunds`
is now a first-class REGISTRY field** (`researcher: true`, `analyst_b: false` — audited: quotes +
fee API + price read, no signer; `executor: true`), set by auditing the call graph. The endpoint
reads it from the registry, not its own `MOVES_FUNDS` copy — the **third** time a duplicate money
claim was collapsed into the registry this arc (see the card fix below). Bonus: `/api/agents` is
session-gated, but `/api/agent-parameters` is public, so a correct response now PROVES the registry
field is live rather than leaving it inferred. *(Matches memory: duplicate source of truth is THE
recurring bug.)*

### 2. TWO FAIL-OPEN CAPS — the NaN pattern, twice (`b35e788`, `e7b47da`)
> Every cap check in this repo is a `>` comparison, and **every comparison against NaN is FALSE** —
> so ONE non-finite value disables the gate. This project has now been bitten by it repeatedly.

- **`canSpend()`** returned `{allowed: true}` on a non-finite input — all three checks passed
  vacuously. Proven: `canSpend({amountUsdc: NaN}) → allowed`. Survivable only because the caller
  guarded first (`_research.mjs:262`) — **safety that lives in the caller is not safety.** The
  refusal moved INTO the gate (non-finite / `<= 0` → `{allowed: false}`), the caller guard kept as
  defence-in-depth.
- **`valueInUsdc()`** could return NaN and it is a CAP INPUT compared with `>` at **five sites** —
  a single NaN disabled all five at once: `_proposal.mjs:165` (over-cap swap gets PROPOSED),
  `job-swap-approve.mjs:124` (that proposal EXECUTES, uncapped), `_actions.mjs:123` (DAY CEILING
  fails open), `agent-execute-plan.mjs:66` (PLAN CEILING fails open), `agent-act.mjs`. **Propose
  and approve COMPOUND**: written unbounded, approved unbounded, the day ceiling that should
  backstop it also NaN-poisoned — no guard survived. Two NaN sources: `USDC` returned `amt`
  unvalidated; the rate guard rejected only FALSY, so a truthy-unparseable rate (`"N/A"`, `"1,08"`,
  an object) × amount = NaN. Now throws unless it can produce a finite POSITIVE number (amount
  finite & `> 0`, rate PARSES & `> 0`, product asserted finite). Every caller already treats a
  throw as "cannot price → refuse" — the correct direction, simply unreachable. Swept the other 11
  cap comparisons; all safe. `_budget-test.mjs`: 28 passed.

### 3. THE UB DEPOSIT BOUND IS NOT AN AGENT CAP — a user footgun guard (`2d74098`, `c2f445d`)
An audit of what can reach `agent-ub-deposit` found `ub_deposit` **is not in the executor's
vocabulary at all** — `_actions.mjs` knows `transfer_usdc`/`pay_for_service`/`swap_tokens`/
`bridge_usdc` and throws `unknown step type` on anything else. No proposal can propose it, no plan
can contain it; the sole caller is the **Fund button**. So it was reclassified:
- **Moved out of `unifiedBalanceCaps` into its own `userControls` block** — `boundsWhom: "THE USER,
  not the agent"`, `isAgentCap: false`. (The genuine UB spend cap + floor STAY — those bind the
  Executor.)
- **The pause skip is deliberate, not a gap.** Pause/halt bind what the AGENT may SPEND; they must
  never bind what the USER may COMMIT or RECLAIM. A paused agent must not trap the user's money in
  either direction — same principle as withdraw surviving pause (below).
- **Re-justified.** The old comment defended it with "the swap-cap trap" — an agent-escape argument
  transplanted here without checking the premise held. It didn't. The real reason: **a Gateway
  deposit is the ONE IRREVERSIBLE MOVE in the app** (there is no release path — see the Gateway
  copy fix), so a mistyped DEPOSIT isn't recoverable the way a mistyped WITHDRAWAL is. It bounds
  the blast radius of an extra zero — it is NOT an agent cap and NOT a Circle protocol limit.
- Renamed `ubDepositCapUsdc → ubDepositMaxPerTxUsdc` (it sat among the agent caps and read as one);
  value **25 → 100** (25 was inherited from the BRIDGE cap and forced four clicks through the
  irreversibility warning — and a warning dismissed four times is a warning nobody reads). Stale
  `AGENT_UB_DEPOSIT_CAP_USDC=25` unset in the Netlify prod context; helper reads the new name and
  falls back to the legacy one so a rename-before-deploy can't silently drop to a default.

### 4. THE CARD READ A STALE COPY, NOT THE ROSTER (`96b3930`, `6da9db1`)
The live Agents card showed ⚠ *Can move your money* over a stale line — `AgentsPanel` had its own
hardcoded `ONE_LINER` map that ALWAYS won over the API's `a.spends`. So when the registry was
corrected, the badge flipped (read from the API) but the sentence a user reads never consulted the
API. **A second source of truth for a money claim, gone stale exactly as the pattern predicts —
third time this arc.** `ONE_LINER` deleted; the card renders `a.spends` from the roster. Second
opinion's line also rewritten to say what it's FOR (*"Buys nothing"* — the one agent that touches
no money) rather than repeating the 🔒 badge.

---

## 2026-07-13 — ONE MONEY MAP + THE WITHDRAW EXIT: the custody model made visible. PROVEN LIVE.

The custody foundation the whole arc above rests on. The agent wallet is a Circle DEV-CONTROLLED
SCA — only the server can move it. That bounds the user's exposure (they choose the float) but
without a withdraw path the float was **custodial with no way out** — the only exit was
`agent-send`, governed by the AGENT's controls (send cap, day-ceiling, pause). **A paused agent
could trap the user's money**, rebuilding the custody problem one layer down.

**THE WITHDRAW EXIT (`40ed27b`).** `/api/agent-withdraw` deliberately does NOT call
`assertNotPaused`, `canSpendDay`, or `sendCapUsdc`, and does not `recordAgentSpend` — those bound
what the AGENT may SPEND, never what the USER may RECLAIM. **Dropping the guards NARROWS the
surface**: there is no `to` parameter, so a withdrawal can only ever pay the session's own verified
address. Withdraw moves PLAIN USDC only (`balanceOf(SCA)`); the Gateway unified balance is shown
next to the button, never silently left behind. **PROVEN LIVE: a withdrawal succeeded while the
agent was PAUSED, USDC landed in the MSCA.** That was the gate. Also re-ranks the funding panel —
fund YOUR MSCA, then hop-A into the agent — because the passkey MSCA is now the funded wallet the
user holds the key to (reversing `b522d81`, correct for the empty-MSCA model it was built for).

**ONE MONEY MAP (`57f2f28`, `1339567`).** Six identical cards, four of which moved money, nothing
distinguishing "between my own pockets" from "gone, no undo" — and the app's own author clicked
Bridge when he meant Deposit. A design failure, not a user error. The Dashboard "Your wallet" card
was reading `w.agentWallet` — the AGENT's SCA — so the user's own wallet was never shown at all
(this is the "same address, two balances" bug: only the label lied). Now **three pockets, ranked by
what the user can reclaim ALONE**: Your wallet (MSCA, 🔒 you hold the key) → Agent's wallet (SCA,
🔒 withdraw any time) → Unified (Gateway, ⚠ — later corrected to "no way out"). Actions moved to
sit beside the balances they act on; grouped by CONSEQUENCE not feature; consequence in the LABEL,
read before the click — deliberately no confirmation dialogs (they only train click-through).
Presentation + relocation only; same endpoints, same caps. Proven live on prod.

---

## 2026-07-12 — BRICK 2: THE SECOND ANALYST. Disagreement is the product. PROVEN LIVE.

Same question, TWO INDEPENDENT analysts. When they disagree, the proposal DIES — and the user
is shown WHY. A killed proposal is the system PROTECTING them, not failing.

### INDEPENDENCE IS STRUCTURAL, NOT PROMPTED

Asking one model to "double-check" itself is theatre. B is independent because it **cannot see
A's argument and does not use A's evidence**:

| | Analyst A (`job-submit-background`) | Analyst B (`_analystb.mjs`) |
|---|---|---|
| Evidence | Exa web retrieval — prose, news, forecasts | CoinGecko + the LIVE CHAIN — numbers only |
| Answers | "SHOULD you?" | "Do the numbers hold?" |
| Sees A's reasoning | — | **NO. Blinded.** Receives only the action's SHAPE. |

`scripts/verify-second-opinion.mjs` has a **blinding tripwire** (`sawA`): if B's inputs ever
carry A's prose, the suite fails. Independence is a test, not a promise.

### THE SYNTHESIZER IS PLAIN CODE. NO MODEL ADJUDICATES.

`_synthesis.mjs` is deliberately dumb. A model asked to reconcile two analysts would
**smooth over exactly the conflict this brick exists to surface** — it would blend "buy" and
"this is impossible" into "medium confidence", which is worse than either input alone.

> **THE DISAGREEMENT IS PRESERVED, NEVER AVERAGED.** There is no confidence score anywhere in
> this brick. `REFUSE` → `hard_disagree` → `proposalSurvives: false`. `CANNOT_VERIFY` → no
> proposal. B failing is NOT a licence to act on one analyst.

Four outcomes, and `no_action` is NOT a disagreement — A proposing nothing is an honest null,
and crediting B with a save it never made would be a lie:

| A proposed | B says | agreement | Proposal |
|---|---|---|---|
| yes | proceed | `agree` | **survives** + "second opinion confirmed" band |
| yes | caution | `caution` | survives, tension shown VERBATIM |
| yes | refuse | `hard_disagree` | **KILLED** |
| yes | B crashed | `unverified` | **KILLED** (fail closed) |
| **nothing** | — | `no_action` | none — a valid outcome, not a failure |

### 🔑 THE KILLED CASE WAS INVISIBLE. THAT WAS THE BUG.

Before this, a killed proposal simply *did not render* — so the user concluded the agent had
FAILED, when in fact it had PROTECTED them. `SecondOpinionCard` now renders **precisely BECAUSE
there is nothing to approve**: amber, not red (a withheld action is not an error), showing
**BOTH views side by side** — what A argued, and what B objected to, with B's facts listed so
the objection is CHECKABLE rather than just a second opinion you are asked to trust.
(This is why `brief.proposal` — A's RAW proposal — is persisted even when it is killed.)

The agree case renders the proposal as before, PLUS the confirmation band **ABOVE the approve
button**: the user reaches "a second analyst independently priced this" BEFORE they reach the
thing that spends their money.

### WHAT B ACTUALLY CATCHES (things A structurally CANNOT see)

- **ROUND-TRIP ARBITRAGE** — a round trip that GAINS is impossible. It means the quote is
  broken. Instant refuse.
- **ASYMMETRIC SPREAD** — the first cut waved a 16% *better-than-fair* rate through as "a
  normal spread". An implausibly GOOD quote is a RED FLAG. Thresholds now bound **absolute**
  spread.
- **TWO PRICE REFERENCES** — CoinGecko vs App Kit/ECB. One reference cannot be cross-checked.

### PROVEN LIVE (both directions, per-user, real chain)

**KILLED** — run `d12a88ba`: A proposed swapping 5 USDC→EURC at ~0.8626. B: fair 0.877031
(CoinGecko) / 0.876211 (ECB) — two references 0.09% apart; executable 0.788639 = **10.08% off
fair**; round trip 5 USDC → 3.943193 EURC → 5.420943 USDC = **+8.42% IMPOSSIBLE GAIN**.
`hard_disagree` → **proposal killed**.

**AGREE** — job **#156385**, run `4a3fe340`: A proposed bridging 1 USDC → Base Sepolia (prose
only — A's reasoning contains NO numbers). B independently priced it off live IRIS: fee
**0.053635 USDC**, ~0.946 arrives, 5.36% burn → `proceed`. `agreement: agree`,
`proposalSurvives: true`, band renders above the approve button (user-confirmed on prod).
B's 0.0536 matches an INDEPENDENT pre-flight IRIS read (0.0533 flat to Base) — proof B priced
the chain itself rather than paraphrasing A.

The forwarder fee is FLAT, so burn scales INVERSELY with size: 1 USDC → 5.36% (proceed),
0.5 USDC → would flip to `caution`. Ethereum's flat fee is **5.4465** — a 5 USDC bridge there
nets NEGATIVE and B refuses on plain economics. Same analyst, a different failure mode from
the swap's arbitrage kill.

### A CAP TEST WAS SILENTLY NOT TESTING THE CAP

`verify-swap-cap` went red. Not a prod bug — the pause chokepoint (previous brick) FAILS CLOSED,
and with no Blobs in a zero-money test it refused every action with "could not verify the pause
switch" **before the cap was ever reached**. The assertions were passing/failing on the PAUSE
message; the cap was never exercised. Fixed by mocking `_pause` to "running" in that suite
(pause has its own proof in `verify-pause-enforcement`). The EURC trap is genuinely re-proven:
22 EURC (raw < cap 25!) ≈ 26.40 USDC → **BLOCKED**.

**A fail-closed guard added upstream can silently disarm a test downstream. Green ≠ tested.**

### Tests: 18 suites green, zero money
`verify-second-opinion.mjs` (32) — blinding tripwire, round-trip arbitrage, too-good-to-be-true,
two-references-disagree, the caution/kill boundaries. `smoke-analystb.mjs` runs B against the
REAL CoinGecko and the REAL router (a fully-mocked suite hid two SDK bugs last brick).

---

## 2026-07-12 — OBSERVABILITY + PAUSE/STOP: the AGENTS PAGE. Ledger races fixed. PROVEN LIVE.

Brick 2's prerequisite. Two agents exist TODAY (not one), and the roster is built for N so the
second analyst + synthesizer become entries in `_agents.mjs`, never a redesign.

### 🔑 THE TRUST DISTINCTION IS THE PRODUCT
**Researcher CANNOT move funds** (buys data only). **Executor CAN** (send/swap/bridge/pay/UB).
`movesFunds` is a FIRST-CLASS API FIELD and the first badge on each card — not prose buried in
a description. It is the single most important thing a user can know about an agent that holds
a wallet, and it is what makes "autonomous agent with a wallet" feel safe.

### THE LEDGER HAD A MONEY-SAFETY RACE, NOT A BOOKKEEPING ONE

`_budget.mjs` had TWO read-modify-write races:
1. `appendAudit` — read the whole array, push, write back → concurrent appends **drop entries**.
2. **`recordSpend`/`recordAgentSpend` — read `spentUsdc`, add, write back → concurrent spends
   BOTH read X and BOTH write X+amount. A SPEND VANISHES FROM THE RUNNING TOTAL, so
   `PERIOD_CEILING_USDC` UNDER-COUNTS and the daily cap DOES NOT HOLD.**

Measured against the old implementation (`scripts/verify-ledger-concurrency.mjs`):
**25 concurrent spends of 0.1 → day total read 0.1 instead of 2.5. 24 of 25 spends vanished.**
The ceiling was barely counting. Brick 2 (two analysts both buying data) is exactly that
concurrency.

**FIXED:** per-entry immutable audit keys (`audit:<owner>:<date>:<ts>-<rand>`, create-only
writes — an append cannot clobber another append; there is no read-modify-write left to race)
+ **compare-and-set** on the counters (`getWithMetadata` etag → `onlyIfMatch`, retry on loss).
⚠️ A plain 6-try CAS loop LIVELOCKS at 25 contenders — it needs **jittered exponential
backoff**. It fails LOUD on exhaustion: a dropped spend is a WIDENED CAP, never swallow it.

Also fixed a lie: `recordAgentSpend` already had a field called `agent` — set to the WALLET
ADDRESS. It recorded *whose* wallet, never *which* agent.

### ⚠️ THE CHOKEPOINT MATTERS MORE THAN THE BUTTON

`executeAction` is NOT the only spend path. These move money WITHOUT it, and a pause enforced
only there would have left them WIDE OPEN:
- **`agent-send`** — direct `transfer()`
- **`agent-ub-spend`** — direct `ubSpend()`
- **`job-run`** — starts a job that funds escrow and buys data
- **`maybeBuyData`** — the researcher's x402 purchase, mid-research

All five call `assertNotPaused` directly. `agent-act` (the chat path), `agent-execute-plan`,
`agent-bridge` and BOTH approve endpoints spend only via `executeAction`, so they are covered
transitively. **Adding a new spend path means adding the call — there is no ambient
enforcement that will catch you if you forget.**

### FAIL CLOSED, TWICE (caps have failed OPEN three times in this repo — the halt is not the fourth)
- **Pause flag unreadable → PAUSED.** A kill switch whose failure mode is "keep spending" is
  not a kill switch. A Blobs hiccup blocks spending; that is the safe direction, deliberately.
- **`AGENT_HALT` garbled → HALT.** `1/true/on/yes` halt · `0/false/off/no` run · **anything
  else halts** — a typo must never mean "keep spending". Tested: `AGENT_HALT="banana"` halts.
- **No owner → refuse.** We cannot read a switch we cannot key.

### LIVE PROOF (chain UNCHANGED throughout: USDC 17.390000 / EURC 13.471551)
| step | result |
|---|---|
| pause Executor → swap | `"Your Executor is paused."` |
| pause Executor → **agent-ub-spend** (bypasses executeAction) | **409 paused** |
| pause Executor → **agent-send** (bypasses executeAction) | **409 paused** |
| resume Executor, pause Researcher → swap | **RUNS** (hit the CAP, not the pause ⇒ it got PAST the gate) |
| …→ research job | **409** `"Your Researcher is paused."` |

Per-agent independence works: "stop the executor, let the research finish" — and its inverse.

**Tests:** ledger-concurrency 11 (incl. the bug demonstrated against the old impl) ·
pause-enforcement 24 (every money-mover wired as a TRIPWIRE — the assertion is that NONE was
reached, not that a flag flipped) · budget 28.

### KNOWN (UI honesty)
The Agents page polls every 15s and Blobs is eventually consistent (~11s), so a just-toggled
pause can DISPLAY stale for a few seconds. ENFORCEMENT is immediate and correct; only the view
lags. Seen live: a resumed Executor still read `paused: true` while an action provably ran.

---

## 2026-07-11 — SWAP IS PROPOSABLE (proposal domain expanded; Brick 2 groundwork). PROVEN LIVE.

The proposal loop was bridge-ONLY. It now also proposes a **SWAP (USDC↔EURC on Arc)** — a
stablecoin FX conversion between two first-party Circle assets. Same spine, per-user, and the
approve→execute→receipt discipline is preserved (though the receipt is a NEW same-chain twin,
not a reuse — a swap has no burn, no attestation, no destination mint).

**Regulatory line, held deliberately.** `plan-quote` accepts "swap 5 USDC to EURC" and still
DECLINES "should I buy PEPE?" ("investment opinion on an arbitrary token, not a supported
on-chain action"). USDC↔EURC only. That is what keeps the vetting gate at `_proposal.mjs:86`
legitimately empty — there is nothing unvetted to refuse. A coin-safety gate remains a FUTURE
brick, and expanding to arbitrary tokens REQUIRES it first.

### THE LIVE PROOF (agent SCA `0xbafec950…95a3`, owner `0xe0516f81…6247`)

| gate | evidence |
|---|---|
| **cap fires** | 30 USDC → `exceeds per-swap limit of 25 USDC (30 USDC ≈ 30.00 USDC)`; reject-not-clamp, nothing signed |
| **bound inclusive** | 25 USDC → NO cap message (passed the gate), then failed on funds |
| **proposal validated** | server-authored: `action:"swap_tokens"` (model wrote `"swap"`), tokens re-derived from the allowlist, `valueUsdc:5`, `cap:25`, `indicativeAmountOut:4.283006` priced LIVE |
| **hostile body ignored** | sent `tokenIn:"EURC"`, `amountIn:999999`, `txHash:"0xbadbad…"`, `state:"confirmed"` → receipt says `USDC`, `5`, `null`, `submitted_no_hash`. ONLY `runId` is read. |
| **executed** | USDC **15.39 → 10.39** (−5.00 exact) · EURC **0 → 4.281949** |
| **receipt** | `confirmed`, `verifiedBy:"balance-delta"`, `amountOut:4.281949` — matches chain to 6dp |
| **day-ledger** | `{"owner":"0xbafec950…95a3","spentUsdc":5.1}` — owner-keyed (5.0 swap + 0.1 earlier pay) |

**The null-hash path fired FOR REAL.** `_swap.mjs` returned `txHash: null` (the 1098
async-waiter quirk), so the receipt went `submitted_no_hash` and was confirmed by **BALANCE
DELTA** against the snapshot `job-swap-approve` takes before executing. That was the riskiest
new code and it was exercised live on the first attempt.

### EIGHT BUGS, NONE FINDABLE FROM STUBS

1. **`agent-act` swap cap was FAIL-OPEN** (live, pre-existing): `Number(env || "1")` → NaN →
   `usdValue > NaN` always false → **every swap passed uncapped**. The same bug that killed
   `gateway-deposit`. Now `swapCapUsdc()`, which throws on garbled config.
2. **Same fail-open bug on `pay_for_service`** (live, pre-existing) → now `maxSpendUsdc()`, the
   fail-closed helper that had existed in `_arc.mjs` all along and simply wasn't used.
   **Repo-wide audit: ZERO fail-open caps remain.**
3. **TWO caps for one action**: chat bounded swaps at `AGENT_MAX_SPEND_USDC` (10), the PROPOSAL
   path at `swapCapUsdc` (25) — the *executing* path was the LOOSER one. Unified.
4. **`plan-quote` DECLINED every swap task** at the front door ("the agent can only bridge").
   Every layer below worked; the path was unreachable end-to-end. **Expanding a proposable
   domain means finding every gate on the way IN, not just the validator on the way out.**
5. **Invented SDK field**: read `estimate.amountOut ?? estimate.toAmount`. The real one is
   `estimatedOutput: { token, amount }` (amount is a decimal STRING).
6. **Wrong SDK type**: passed `amountIn` as a NUMBER; App Kit demands a STRING. Now coerced in
   `buildSwapParams` — one chokepoint, so no caller can get it wrong again.
7. **Verifier had no Blobs READ-RETRY.** Blobs is eventually consistent (~11s) and
   `job-swap-approve` writes the receipt and triggers the verifier in the same breath — the
   first read saw nothing, returned 404, and **stranded the receipt with the swap already
   on-chain**. `job-bridge-receipt-background` had solved this already (10 × 1.5s); mine hadn't.
8. **(Diagnostic, mine)** `_auth.mjs`'s `hmac` is **b64url, NOT hex**. Every manual
   internal-token call I made was malformed → silent 401 → an hour chasing ghosts.

⚠️ **5 and 6 BOTH hid behind a green, fully-mocked test suite.** A mock cannot violate the
contract it stands in for. `scripts/smoke-swap-estimate.mjs` now calls the **REAL App Kit**
(estimateSwap is free and read-only — there was never a reason not to). It caught both.

### ⚠️ A BACKGROUND FUNCTION FAILS INVISIBLY — write telemetry INTO THE RECEIPT

Netlify acks 202 **before** a background function runs, so its response is discarded, and its
`console.log`/`console.error` do **NOT** surface through `netlify logs`. A throw therefore
strands a receipt with money already moved and **no way to learn why**. This was the single
biggest time-sink of the session. `job-swap-receipt-background` now writes `verifierRanAt` /
`verifierError` onto the receipt — the one place that is readable. Do the same for any future
background worker.

### CORRECTION TO `ab48f6f` (the UB deposit hardening)

That commit claimed the single-use claim guard was "verified on prod with a VALID internal
token". **It was not** — the token was hex-encoded, `requireInternal` 401'd it, and the chain
therefore didn't move because AUTH rejected the request, NOT because the claim guard worked.
**Now genuinely proven** with a correct b64url token (`internal=true` confirmed independently):
replaying a COMPLETED depositId left the chain at `10.390000 / 4.506500`, unchanged.

### ⚠️ THE SWAP CAP IS IN USDC-EQUIVALENT, NOT RAW TOKEN UNITS

EURC != $1. **22 EURC ≈ 26.40 USDC sails straight past a raw cap of 25.** So the check runs
AFTER `valueOfStep` converts, but BEFORE `canSpendDay`, so an over-cap swap still returns the
CAP message rather than the ceiling one (matching send/bridge). Both `_actions.mjs` and
`_proposal.mjs` enforce it this way.

### Files
NEW: `job-swap-approve.mjs`, `job-swap-receipt-background.mjs`, `_arc.mjs:swapCapUsdc`,
`_swap.mjs:estimateSwapOnly` + `buildSwapParams`.
CHANGED: `_proposal.mjs` (`validateSwapProposal`), `_actions.mjs` (swap cap), `agent-act.mjs`
(both fail-open caps), `plan-quote.mjs` + `job-submit-background.mjs` (prompts).

**Tests:** swap-cap 7 · swap-proposal 20 · swap-approve 33 · swap-receipt 16 ·
smoke-swap-estimate 11 (REAL SDK). Regression: per-user-threading 18 · approve-writepath 25.

### THE UI — SHIPPED, and proven through the app (job #156134)

`Proposal` is now a discriminated union (`BridgeProposal | SwapProposal`) keyed on the SAME
`action` field the server normalizes and the approve endpoints dispatch on — so a third
proposable action cannot silently render as a bridge; TypeScript forces every surface to
handle it. `ProposalCard` dispatches into two bodies sharing one `ProposalShell`, so the cards
cannot drift apart (same reasoning-first layout, same "it cannot check this is a GOOD idea"
disclaimer). Approve routing lives once in `src/lib/approveProposal.ts` — both panels used to
inline the same bridge fetch, and routing swap in one and not the other would have sent swap
proposals to the bridge endpoint ("this brief carries no bridge proposal").

**LIVE THROUGH THE UI (job #156134, 1 USDC → EURC):**
`confirmed` · `verifiedBy: "balance-delta"` · `txHash: null` · `amountOut: 0.835096` ·
verified 7s after approve. Chain: USDC **18.39 → 17.39** (−1.00 exact), EURC
**12.636455 → 13.471551** (+0.835096 exact). Day-ledger owner-keyed. Cap re-proven live: 30
USDC → `exceeds per-swap limit of 25 USDC`, chain unmoved; 25 USDC → NO cap message (inclusive
bound holds).

### 🔑 THE BALANCE-DELTA PATH IS THE *NORMAL* PATH, NOT AN EDGE CASE

Both live swaps returned `txHash: null` (the 1098 async-waiter quirk). That is how the Circle
SCA swap behaves in practice. **Had the receipt been keyed only on a tx hash — which is what
the SDK's own return value invites — EVERY swap receipt would strand**, with money already
moved and no confirmation. The balance-delta fallback (snapshot before, compare after; the
CHAIN is the witness, not the SDK) is the primary path. Do not "simplify" it away.

### FOLLOW-UP: `agent-act` has no pre-flight balance gate
An at-cap swap the wallet can't fund fails with a raw 500 (`"No route available"`) instead of a
clean 402 with `have`/`need`. `job-swap-approve` and `job-bridge-approve` both gate; the CHAT
path does not. Cosmetic (nothing moves), same class as the bridge's job #155341 fix.

---

## 2026-07-11 — PER-USER GATEWAY: COMPLETE, proven live on prod (fund → grant → deposit → spend)

Gateway (deposit + spend) is now scoped to the session's OWN agent SCA (`ensureOwnerWallet`)
instead of the shared `AGENT_WALLET_ADDRESS`. Proven end-to-end on a **virgin** per-user wallet.

**THE LIVE PROOF** — agent SCA `0xbafec950…95a3` (owner `0xe0516f81…6247`), faucet-funded 20 USDC,
`isAuthorizedForBalance` = false at the start:

| step | evidence |
|---|---|
| deposit #1 (2 USDC) | `delegateTxHash 0x9335b64c…` · `delegateAlreadyAuthorized:false` — **grant fired** |
| chain | `isAuthorizedForBalance` **false → TRUE**; unified 0 → 2.0 |
| deposit #2 (0.5) | `delegateTxHash: null` · `delegateAlreadyAuthorized:true` — **grant-once, idempotent** |
| spend (`pay_for_service` 0.1, natural language) | unified 2.5 → 2.3965; recipient `0xc54d…e621` +0.100000 |
| SCA plain USDC | 20.00 → 18.00 → 17.50 → 17.40 — every cent = deposits |

**SPONSORSHIP — SETTLED.** The `addDelegate` tx cost the user **NOTHING**: 20.00 → 18.00 after a
2.00 deposit, exact to 6dp. Circle's paymaster (`0x7ceA357B…0a25`) pays, and it **does** cover the
GatewayWallet contract — the one caveat Phase 2 could not prove. (The ordering never depended on
this; both outcomes were designed to work. Now the truth is on record rather than assumed.)

**THE ORDERING (load-bearing).** `fund → ensureDelegate → deposit → spend`. `ensureDelegate` lives
INSIDE `ubDeposit`, AFTER the insufficient-funds check — so `addDelegate` is **structurally
unreachable on an empty wallet** (the funds check throws first), and on Arc a funded wallet is a
gassed wallet (USDC *is* the native gas token — verified identical on 50/50 wallets). Grant runs
BEFORE approve/deposit, so a grant failure leaves USDC plain in the user's SCA — clean and
retryable, never stranded in Gateway. **Do not let a refactor reorder this.**

**THE SEAM (cap-bypass trap) — CLOSED.** `_ubdeposit` / `_ubspend` / `_pay` no longer read
`AGENT_WALLET_ADDRESS`; they REQUIRE an owner/sourceAccount param and **throw** rather than fall
back. `_actions.mjs` threads `ctx.walletAddress` into `agentPay` (it previously ignored it — a
per-user pay would have drained the SHARED balance). Zero live env reads remain in the money path.
The `pay_for_service` block at `_actions.mjs:97` is removed — that block *was* the feature request.

**DAY-LEDGER.** `agent-ub-spend` now gates on `canSpendDay` BEFORE signing and writes
`recordAgentSpend` after — owner-keyed. It was the last money path ignoring `PERIOD_CEILING_USDC`.

**AUTH.** `gateway-balance` was a PUBLIC read of the shared wallet; now `requireSession` +
per-user. Three UI states (signed-out / provisioning-202 / ready), `$0` reads as "fund me".
Deleted `gateway-deposit.mjs` + route — zero callers and a **fail-OPEN** cap
(`Number(env || "1")` → NaN → `amount > NaN` always false → every spend passed).

**BUG B — waitForTx poll granularity (fixed, not eliminated).** Deposits ran ~8.9s against
Netlify's **10s** sync-function ceiling — 90% of budget, permanently. Measured the real cause:
Circle txs confirm in **2–3s** (createDate→updateDate), but `waitForTx` slept a flat **2s** between
polls, so a tx confirming at 3.0s wasn't seen until ~4.3s — 1–2s lost PER TX, ×2 txs. Fixed:
1.5s first wait, then **400ms** polling, deadline-based (same 60s budget). Measured on prod:
**8938ms → 6442ms** (−28%, now 64% of budget). Speeds every Circle path (send/swap/bridge/jobs).
⚠️ **Irreducible floor ~6s** (2 sequential txs × 2–3s + 0.7s reads). The durable fix is a
background function (pattern already in-repo) — see follow-up.

**Test:** `scripts/verify-per-user-threading.mjs` (14/14 — no-env-fallback, seam, ledger gate,
401s, ensureDelegate idempotence + the empty-wallet guarantee). `_budget-test.mjs` 26/26 and now
**ceiling-agnostic** (it hardcoded 2.00 and silently went stale when the deployed ceiling moved to
60 — it now derives amounts from the live `PERIOD_CEILING_USDC`).

**⚠️ SESSION TTL IS 30 MINUTES** (`_auth.mjs:17`) and this cost most of a session: a stale
`sessionStorage` token — **62h expired, and for a DIFFERENT passkey** than the funded wallet's
owner — made three "deposits" silently never reach the server (zero invocations, zero on-chain
txs). **Decode the token first** (`sub` + `exp`) before diagnosing anything else; it settles in
seconds what took hours of wrong theories (a timeout theory and a bad bisect, both of which the
logs later refuted).

---

## 2026-07-11 — UB deposit is now a BACKGROUND function (Bug B CLOSED)

`agent-ub-deposit` is split into a fast sync front door + `agent-ub-deposit-background`
(15-min budget) + `agent-ub-deposit-status` (poll). **Front door: 6442ms → 686ms** — from 64%
of Netlify's 10s sync ceiling down to ~7%. Proven live: 202 `{depositId}` → `executing` →
`completed` in ~7.3s of worker time; chain moved exactly 0.1 (plain 15.49→15.39, unified
4.4065→4.5065) with `delegateTxHash: null` (grant-once still holds).

**Every REJECTION stays SYNC** — auth 401, cap 400, insufficient funds 402 — so a user who
types too large a number gets an immediate honest answer instead of polling to a "failed".
Nothing signs on those paths, and the background worker isn't even invoked.

**The ordering is untouched.** `funds-check → ensureDelegate → approve → deposit` still lives
inside `ubDeposit`. Moving the executor off the sync clock must NOT move the grant — that is
what keeps `addDelegate` structurally unreachable on an empty wallet.

⚠️ **`agent-ub-deposit-background` is PUBLICLY REACHABLE** at `/.netlify/functions/…` (Netlify
exposes every function there; only the `/api/*` route is withheld) and it is **UNCAPPED** — the
guards live in the front door. `requireInternal` (HMAC over SESSION_SECRET) is the ONLY thing
between it and an arbitrary deposit. Verified: an unauthenticated call with `amountUsdc: 999`
produced **zero on-chain txs**. Note a background function returns **202 before the handler
runs**, so its status code proves nothing — check the CHAIN, not the response.

---

## FOLLOW-UP (DONE — see entry above): make the UB deposit a background function

`agent-ub-deposit` runs ~6.4s of a 10s Netlify sync ceiling even after the waitForTx fix, with an
irreducible ~6s floor (approve + deposit, each 2–3s on-chain). A latency blip still tips it over.
The repo already has the pattern (`job-run-background`, `job-submit-background`): move the
executor to a `-background` function (15-min budget) and have the UI poll. Not urgent — it
succeeds today — but it is the only way to get real margin.

---

## 2026-07-11 — hop A DEMOTED (follow-up below: DONE)

`MyAgentPanel`'s funding section is re-ranked. **PRIMARY** is now the agent wallet's ADDRESS
(`AddressDisplay`, masked + copy) with "send USDC here — works from any wallet, exchange, or
faucet". **Hop A is a disclosure** ("Or move USDC from your login wallet (N USDC) →"), and it is
**hidden entirely when the login wallet holds 0** — which is exactly the state a fresh passkey
login is in, and the state that made the old primary door refuse with "insufficient funds" and
strand the user. Hop A itself is unchanged (still guarded, still refuses the shared wallet); only
its position changed. tsc + build clean.

---

## FOLLOW-UP (DONE — see entry above): demote hop A in the UI

**The wallet model, verified 2026-07-11 (code + Blobs + chain) — there are TWO wallets:**
- **Login wallet** — a client-side Circle **Modular** SCA minted by the passkey
  (`toCircleSmartAccount`, `useModularWallet.ts:322`). NOT on the Circle entity. It is a real
  on-chain account that **can hold and spend USDC** (`fundJobAsUser` / `placeBetAsUser` spend
  from it) — it is *not* auth-only.
- **Agent SCA** — a server-side Circle **dev-controlled** SCA from `ensureOwnerWallet`. This is
  the ONLY wallet the agent spends from; the server has no key for the login wallet.

Worked example (the live-proof user): login `0xe0516f81…6247` (0.00 USDC) → agent SCA
`0xbafec950…95a3` (20.00 USDC, faucet-funded directly).

**THE PROBLEM.** Hop A ("Fund your agent" — login wallet → agent SCA) is presented as the
PRIMARY funding door. That is right for **MetaMask** logins (the EOA holds the user's real
funds) but a **dead end for passkey** logins: the passkey MSCA is minted EMPTY, so hop A's
source wallet has nothing in it. A passkey user sees the primary funding control refuse with
"insufficient funds" and has no obvious next step. **This confused an entire working session.**

**THE FIX (reposition, don't delete — ~250 lines, all guarded and working):**
1. **Primary affordance = "send USDC to your agent wallet address."** This already exists (the
   Dashboard renders the SCA address + copy button) and already works — it is how the 20 USDC
   above arrived. It is the path that works for EVERY login method.
2. **Hop A demoted to secondary:** *"or move funds from your login wallet."* Keep it — it is
   the correct path for MetaMask users.

Note the `fund → delegate → deposit` ordering does NOT care how the SCA got funded — it only
requires `balanceOf(SCA) >= amount` when `ensureDelegate` fires. So hop A is a convenience,
never a prerequisite.

---

## 2026-07-11 — PER-USER GATEWAY, Phase 0: recon proven, fail-open endpoint deleted

Groundwork for scoping Gateway (deposit + spend) to the session's own SCA
(`ensureOwnerWallet`) instead of the shared `AGENT_WALLET_ADDRESS`. Read-only probes first;
no money moved.

**PROBE 1 — the delegate does NOT carry over** (`scripts/probe-delegate-status.mjs`).
`isAuthorizedForBalance(USDC, depositor, DELEGATE)` on the deployed GatewayWallet reads
`true` for the shared SCA (the baseline that makes spend work today) and **`false` for all
48 other SCAs on the entity** — every per-user wallet included. Nothing in this repo ever
called `addDelegate`, so the shared SCA's authority was established out-of-band. Each
per-user SCA therefore needs its own one-time `addDelegate(USDC, delegate)`.

**PROBE 2 — per-user SCA gas IS paymaster-sponsored** (`scripts/probe-addDelegate-gas.mjs`).
Decoded the EntryPoint `UserOperationEvent` from real confirmed per-user-SCA txs: all 5
sampled userOps were paid by paymaster `0x7ceA357B5AC0639F89F9e378a1f03Aa5005C0a25`, across
different wallets AND different wallet-sets (each user gets their own set), so sponsorship
is not a hand-tuned policy on the shared wallet. ⚠️ Caveat: Gas Station policies CAN be
contract-scoped and GatewayWallet is not *proven* in scope — but see the ordering below,
which makes this moot.

**THE ORDERING IS THE DESIGN — do not let a refactor reorder it.**
`fund (hop A) → ensureDelegate → deposit → spend`. Deposit is impossible before funding, so
hop A is forced first anyway; putting `addDelegate` *after* it means the SCA already holds
USDC — which on Arc IS gas. So if sponsorship covers GatewayWallet the paymaster pays, and
if it doesn't the SCA self-pays (~0.07). Either way it works. **`delegate-during-provisioning`
was REJECTED**: it is the only ordering that depends on sponsorship being true, and it would
put an on-chain tx into a login path that is deliberately chain-free.

**DELETED `gateway-deposit.mjs` + its `/api/gateway-deposit` route** — zero callers, and it
re-derived its own cap as `Number(process.env.AGENT_MAX_SPEND_USDC || "1")`, which is
**fail-OPEN**: a garbled env value yields `NaN` and `amount > NaN` is always false, so every
spend passed. The live deposit path (`agent-ub-deposit`) uses the fail-closed
`ubDepositCapUsdc()` from `_arc.mjs`. Retired `probe-gas-sponsorship.mjs` (its verdict logic
was unsound — on Arc native gas IS USDC, so "transacted with zero native balance" reads as
sponsorship when it actually just means "transacted then drained").

**Shared SCA's Gateway balance is deliberately ORPHANED-FROM-UI post-repoint — NOT stuck.**
Verified read-only (`scripts/probe-withdraw-path.mjs`): the deployed GatewayWallet really
implements `withdrawingBalance` / `withdrawalBlock` (not just SDK typings), nothing is
pending, and the exit — `initiateWithdrawal(token,value)` → delay → `withdraw(token)` — is
called by the **depositor**, needing NO delegate. So repointing the UI/delegate at per-user
wallets cannot strand it. Balance at time of writing: **2.0746 USDC** (grown from the 0.7755
in the entry below).

---

## 2026-07-08 — UB SPEND fee-guard (floor + cap) SHIPPED; fee finding RESOLVED

Follow-up to the SPEND-PROVEN entry below, closing its ⚠️ fee finding. Read-only fee
diagnosis first, then economic guardrails (not a fee reduction), verified on prod.

**FEE FINDING RESOLVED — the ~0.2 fee is NOT a bug, it's a FLAT per-transfer forwarder fee.**
- Diagnosis (from the proof capture + Circle App Kit docs): the fee decomposes into a tiny
  proportional CCTP `provider` fee (1–14 bps, ~0 on testnet), tiny real Arc gas (**~0.003** —
  Arc's stable-cheap-fee design), and the dominant **`forwarder` fee ~0.202 which is FLAT**
  (amount-independent). Docs confirm 0.20 flat whether sending 500 or 1,000 USDC; it's the
  Forwarding Service's destination-mint cost priced in USDC.
- SAME structure as our bridge (`_bridge.mjs`: `forwarderFee = fwdTier.forwardFee.high`, no
  amount term; ~0.2 to an L2, 1.5–14 to Ethereum L1). Our 0.202 sits in the L2 band.
- So a flat fee → tiny spends have absurd ratios (0.1 = ~200%) but realistic ones are trivial
  (**<2% at ≥10 USDC**, 1% at 20). No cheaper mode: SLOW/STANDARD only zeroes the ~0 CCTP
  protocol fee, not the forwarder; skipping the forwarder needs a destination signer the SCA
  can't provide. **Fix = economic guardrails, not fee reduction.**

**What shipped (2 files):**
- **`_arc.mjs`** — new **`ubSpendFloorUsdc()`** (default 10, fail-closed same as the cap) +
  raised **`ubSpendCapUsdc()`** default **1 → 50** (the 1 was a first-proof value).
- **`agent-ub-spend.mjs`** — enforces **floor then cap** in the wrapper, BEFORE any UB call.

**Guardrails:**
- **MINIMUM FLOOR** `AGENT_UB_SPEND_FLOOR_USDC=10` — rejects `< 10` with an educational
  message ("below minimum spend of 10 USDC — cross-chain fee (~0.2 flat) makes smaller
  amounts uneconomical").
- **CAP raised 1 → 50** `AGENT_UB_SPEND_CAP_USDC=50`. **⚠️ This raises the per-spend ceiling
  50× — deliberate.** Operational range is now **10–50 USDC** (fee <2%).
- Both **reject-not-clamp, before signing, fail-closed**: garbled/negative env throws
  (refuses to spend); a `floor > cap` misconfig rejects everything (fail-safe, never opens a
  hole). Floor checked before cap.

**Verified on PROD (deploy `6a4f8401…`, live):** authenticated money-safe check —
`amount 5 → 400` (below floor), `amount 999 → 400` (above cap), **no funds moved**. Deployed
env is authoritative: `floor=10`, `cap=50` confirmed via `netlify env:get --context
production` (old cap `1` overwritten). The in-range ALLOW (10–50) was NOT re-fired — it would
spend a real ≥10 USDC and the spend mechanism is already proven (the 0.1 direct test below).
Auth note: the money-safe prod check used a token minted from prod's `SESSION_SECRET` (piped,
never printed) — the full authenticated HTTP path remains the deferred follow-up below.

**UB proof helper scripts (in `scripts/`, UNTRACKED test tooling — re-run, don't rewrite).**
A future session doing the in-range authenticated HTTP-spend proof should reuse these:
- **`fire-ub-spend.mjs`** / **`fire-ub-spend-direct.mjs`** — fire a REAL spend (HTTP endpoint
  vs. direct `ubSpend()` executor), snapshot Arc unified + recipient Base before/after, poll
  the async mint, and print a PROVEN/PARTIAL/UNPROVEN verdict + a durable capture in
  `scripts/ub-spend-captures/`. ⚠️ Move real money — an in-range amount (10–50) will spend.
- **`probe-ub-auth.mjs`** — zero-money endpoint/auth/cap health check (mints a token, sends an
  over-cap amount; 400 = trusted+capped, 401 = SESSION_SECRET mismatch).
- **`verify-ub-guards.mjs`** — money-safe floor/cap check (fires only below-floor + above-cap,
  expects 400s). Accepts `SESSION_SECRET=<prod-secret>` (piped) or `TIKPEMA_TOKEN=<bearer>`.

---

## 2026-07-08 — Unified Balance SPEND PROVEN (cross-chain mechanism; full HTTP path deferred)

The SPEND (write) half of Unified Balance — deferred in the VIEW entry below for
SCA-authorization risk. That risk is now **retired for the mechanism**: a delegate-signed,
cross-chain Arc→Base Sepolia unified-balance spend via the Forwarding Service **moves real
money, both sides verified**.

**PROVEN (hard balance movement, tied to this one spend):**
- Fired a **0.1 USDC** spend from the agent SCA's Arc unified balance to an external
  recipient on **Base Sepolia** (`0x1e18…31Be`).
- **Arc unified: 0.7755 → 0.469876** (dropped) AND **recipient Base Sepolia: 0 → 0.1**
  (rose). Both sides snapshotted before/after and tied to this transfer — not a flat
  no-op like the earlier failed attempts.
- Circle kit returned `state:"completed"` (no 1098 async-waiter quirk this run); all four
  steps succeeded: buildBurnIntents → signBurnIntents → fetchAttestation → mint.
- transferId `b2d3178a-524f-4cd3-ab27-2807044f2be1`; mint tx on Base Sepolia
  `0xc1644c1972a9f62123299d15dd5ebaf667ca1eb661ee4501833fcfaf383c5f4e`.
- Signing model confirmed live: `from.address` = DELEGATE (signer, ready on Arc),
  `from.sourceAccount` = AGENT SCA (holds the balance), source `Arc_Testnet`,
  `to = { Base_Sepolia, recipientAddress, useForwarder:true }`. A Circle SCA can't sign
  its own Gateway spend; delegate-signed exactly like `_pay.mjs`. This works.

**HOW it was proven — direct executor, NOT the HTTP endpoint:**
- Fired via a direct `ubSpend()` call (`scripts/fire-ub-spend-direct.mjs`, uncommitted
  proof tooling), using the same CIRCLE creds prod uses. This is the SAME on-chain spend
  the endpoint performs; it isolates and proves the risky unknown (does the cross-chain
  SCA-delegate spend move money?) without the session-auth layer.

**NOT yet exercised end-to-end — the full HTTP path (deferred follow-up):**
- endpoint → session auth → cap wrapper → `ubSpend()` has **not** been fired by a real
  authenticated user call. What IS verified: the route is live and the auth gate works
  (unauthenticated `POST /api/agent-ub-spend` → **401**), the cap lives in the wrapper
  BEFORE any UB call (reject-not-clamp; an over-cap request → 400, nothing signs), and
  `agent-ub-spend.mjs` is thin glue over the now-proven `ubSpend()`.
- **Blocker:** a locally-minted session token is **rejected by prod (401)** — prod's
  `SESSION_SECRET` ≠ local `.env`'s. Confirmed with a zero-money probe
  (`scripts/probe-ub-auth.mjs`: valid-shape token + over-cap amount → 401, not the 400 a
  trusted token would get). So the browser-console token method failing earlier was the
  same root cause, not an endpoint bug.
- **To close:** fire `scripts/fire-ub-spend.mjs` with a token prod trusts — either a real
  browser login on prod (challenge→sign→verify), or align local/prod `SESSION_SECRET`.

**⚠️ FEE FINDING (must record — economics are the real open risk, not the mechanism):**
- Sending **0.1** cost the Arc side **0.305624** total (unified dropped by exactly that):
  spend 0.1 + **gasFee 0.205619** + provider 0.000005 — i.e. **~2.06× the transferred
  amount in verified on-chain fees** on Arc Testnet.
- The kit result ALSO reported a **`forwarder` fee of 0.202124 USDC** with **no Arc
  allocation**. It did NOT show up in the Arc balance delta (Arc dropped exactly
  spend + maxFee) and the recipient received the full 0.1 — so **where/whether the
  forwarder fee is actually charged is UNRECONCILED from balances alone.** Open: reconcile
  it against an actual balance (delegate? a fee account?) before trusting the economics.
- These are `maxFee`-style estimates (buildBurnIntents `maxFee` 0.205624 == gasFee +
  provider), likely inflated testnet gas — actual burn may be lower. But **as-is this path
  is uneconomical for sub-dollar transfers.** Before any user-facing spend: validate real
  fee vs maxFee, and add a minimum-amount / fee-ratio guard + expectation-setting.

**Committed:** the 4 SPEND files (`agent-ub-spend.mjs`, `_ubspend.mjs`, `_arc.mjs`
ub-spend cap, `netlify.toml` redirect) — already deployed to prod in a prior session;
this commit records them now that the mechanism is proven. Proof tooling
(`scripts/fire-ub-spend*.mjs`, `scripts/probe-ub-auth.mjs`) and the durable capture
(`scripts/ub-spend-captures/`) left uncommitted.

---

## 2026-07-08 — Unified Balance VIEW SHIPPED (read-only; SPEND half deferred)

The safe half of the Unified Balance capability: a multi-chain **VIEW** of the agent
wallet's Gateway/unified USDC balance. **Read-only — no deposit, no authorize, no
spend; it cannot move money.**

**What shipped:**
- **`gateway-balance.mjs`** — extended the Arc-only `/v1/balances` read to **multi-chain**:
  Arc Testnet (domain 26) + Base Sepolia (domain 6), read **per-domain via
  `Promise.allSettled`** so one chain failing degrades to the other (graceful per-chain).
  Returns `{ depositor, unifiedBalanceUsdc, perChain:[{chain,domain,usdc,ok}] }`;
  unified = sum over the chains that read OK. Public read keyed by depositor.
- **`_gateway.mjs`** — `+BASE_SEPOLIA_DOMAIN: 6`.
- **`Dashboard.tsx`** — a distinct low-key **"Agent unified balance · across chains"**
  card ("$X across chains" + per-chain breakdown Arc / Base Sepolia), its OWN
  `useEffect` fetch of `/api/gateway-balance` (NOT in `useWallet`), so a failure never
  touches the per-user balance. Graceful: failed chain → "unavailable"; total failure →
  "Unified balance unavailable."

**Decisions (both confirmed):**
- **REST-extend, NOT `kit.unifiedBalance.getBalances`** — it's a public read keyed by
  depositor; the REST path reuses proven code and needs NO kit/adapter/entity-secret,
  avoiding the kit/1098/SCA machinery entirely.
- **Option B (agent wallet), NOT per-user** — the depositor is the shared
  `AGENT_WALLET_ADDRESS` (the only funded wallet); surfaced as the **agent's**
  cross-chain balance, visually **distinct from "Your wallet"** (per-user). This avoids
  the misrepresentation the Dashboard comment already warns against; a per-user variant
  would read ~$0 for everyone (no user has a Gateway deposit).

**Verified live on prod:** `POST /api/gateway-balance` → 200 with real data — Arc Testnet
**0.7755 USDC**, **Base Sepolia 0** (both `ok:true`), unified **0.7755**. Build hash
`index-eNrJOe2E.js`. **Base reads $0 by design** — the agent has no Base Sepolia deposit
yet; the view proves multi-chain READING works, and $0 is a valid honest balance.

**SPEND half DEFERRED** (deposit / `addDelegate` / cross-chain `spend`) — it carries the
**SCA-authorization risk**: the delegate auth is out-of-band/undocumented in-repo
(confirm via read-only `getDelegateStatus` first), and any new `depositFor`/`addDelegate`
on the SCA hits the known 1098-async + `allowanceStrategy:"approve"` quirks (solvable via
the catch / direct-contract path used for swap/bridge/pay). No mainnet wall (Arc Testnet
+ Base Sepolia, faucet USDC). Files: `gateway-balance.mjs`, `_gateway.mjs`,
`Dashboard.tsx`. tsc + build clean.

---

## 2026-07-08 — FIX (pre-existing, arXiv-INDEPENDENT): synthesis max_tokens 1024→8192 truncation-refund bug

**The more important find of the two shipped today.** The research SYNTHESIS call was
capped at `max_tokens: 1024` (in the shared `callAnthropic`, `_research.mjs`), which
**silently TRUNCATED rich briefs mid-JSON** → `extractJson` returned null → `research()`
returned `decision: null` (`:416` "unparseable (exa path)") → `job-submit-background.mjs:262`
**refunded** with "no usable brief — missing decision or sources".

**Pre-existing — predates arXiv AND crypto.** It was silently refunding ANY rich-answer
job whose brief exceeded 1024 tokens, regardless of capability. Surfaced by the diffusion
query but proven **arXiv-independent**: in the diagnostic, scenario **B (papers bypassed)**
went from reliably-FAIL to a full parsed brief **with ONLY the cap changed** — while
scenario A (papers included) had already passed and C (papers forced) had also failed, so
papers-presence never determined the outcome; answer-length vs the 1024 cap did.

**Fix:** added an optional `maxTokens` param to `callAnthropic` (default **1024**, so the
tiny classifier/filter calls are untouched) and pass `BRIEF_MAX_TOKENS = 8192` at the
THREE brief-producing calls only — the Exa synthesis + the web-search path's initial +
pause_turn resume. 8192 is comfortable headroom (real briefs ~1200–1840 chars ≈ well
under; only generated tokens billed, so idle headroom costs ~nil). **Root cause = the
cap, not arXiv, not crypto.**

**Verified:** local re-run of the diffusion query → all three scenarios SUCCESS (B, the
reliable-fail case, now returns a full brief: 1815 chars, 6 sources, conf 0.93). Then
prod-verified by user (diffusion query succeeded). Files: `_research.mjs`. tsc + build clean.

---

## 2026-07-08 — arXiv deeper-research capability (CUT 1) SHIPPED + PROVEN on prod

**What:** the research agent now pulls real academic papers (titles, authors, abstracts,
arXiv IDs) into briefs via arXiv's FREE public API — no key, no wallet, no payment, a
plain HTTPS GET returning Atom XML. Simpler than crypto because it's free (no x402, no
gate, no ceiling); it's a `market`-style FREE branch.

**Design:**
- **Classifier** — a new `"papers"` kind in `decidePurchase` (`_research.mjs`); the
  crypto `onchain`/`market`/`none` routing is **untouched** (added a 4th kind + one
  branch). Gated in the prompt to genuinely SCIENTIFIC/TECHNICAL/ACADEMIC questions —
  NEVER prices, current events, or who/when/where lookups.
- **Router** — a free `papers` branch in `maybeBuyData` (next to `market`): fetch →
  strict filter → facts. No x402, no budget gate, no spend.
- **`_arxiv.mjs` (new)** — `searchArxiv` (HTTPS GET, `sortBy=relevance`, `max_results=6`,
  8s timeout) + **DEFENSIVE regex Atom parse** (no dep): a paper is emitted ONLY if ALL
  fields (title/summary/id/year/authors) extract cleanly; any partial/malformed entry is
  DROPPED; malformed/empty XML → `[]`; never throws. `arxivToFacts` → `{claim,source}`
  (source = arXiv abs link).
- **STRICT LLM relevance filter** (`filterRelevantPapers` in `_research.mjs`, default
  1024 tokens) — biases hard to DROP ("keep ONLY papers that DIRECTLY address the
  question; better to keep NONE than a tangential one"); any failure → drop all →
  Exa-only. Proven dropping: 6 fetched → 5/3 kept in tests.
- **Additive merge** — papers fold into the grounding block + sources exactly like
  crypto/Exa (`_research.mjs:~381/:410`), source-agnostic; it **augments, never replaces**
  the Exa/web sources, so it can't empty a brief.

**Verified on prod (user-run, passkey):** transformers/RLHF questions cite relevant
arXiv papers; a BTC-price question pulls NONE (classifier gate holds — no over-trigger).
Money path untouched. Deferred: `eth_call`-style contract reads have no analogue here;
out of scope = PDF full-text, pagination, non-arXiv sources. Files: `_arxiv.mjs` (new),
`_research.mjs`. tsc + build clean.

---

## 2026-07-08 — Contact block in sidebar footer (copy-only)

Contact block in sidebar footer: `tikpema274@gmail.com` mailto + `@tikpemaGB` →
x.com/tikpemaGB, low-key (muted/amber, stacked) under Feedback. `src/App.tsx` only;
copy+links, no backend/logic. Deployed to prod (hash `index-TWRm4hxm.js`), block
confirmed in the live bundle.

---

## 2026-07-08 — Crypto-analysis capability (CUT 1) SHIPPED + PROVEN on prod

**What:** the research agent can now fetch crypto facts mid-research and cite them —
**on-chain** (via the existing paid QuickNode x402 path) and **market** (via free
CoinGecko). A classifier routes each question to `onchain` / `market` / `none`.

**Design (all in `_research.mjs` + new `_cryptodata.mjs`):**
- **Classifier** — `decidePurchase` returns `{kind:"onchain"|"market"|"none", method,
  params, justification}` (+ back-compat `buy = kind!=="none"` so `_autonomy-test.mjs`
  and the legacy `forceDecision` seam still work). Priority rule IN the prompt: prefer
  the paid on-chain path where a listed method can serve; use free CoinGecko ONLY for
  price/market-cap/volume RPC can't give; else `none`.
- **Router** — `maybeBuyData`: `market` → free `fetchMarketData` (NO challenge/gate/
  spend); `onchain` → `buildRpcBody` → the EXISTING x402 pay path UNCHANGED (challenge
  → ceiling → gate → `payX402` → `recordSpend`; only the request BODY varies and the
  fact PRODUCTION swaps to the decoder). Legacy `{buy:true}` (no kind) → static-env body.
- **Decoders** (`_cryptodata.mjs`, pure): `eth_blockNumber` hex→int, `eth_gasPrice`
  hex wei→gwei, `eth_getBalance` hex wei→human USDC. `hexToBigInt` is the choke point —
  any non-hex/missing result is DROPPED (returns []); a raw `0x…` can NEVER become a
  claim. `buildRpcBody` validates the method/params and refuses unsupported methods.
- **Market** — CoinGecko keyless public GET `/simple/price` (price/cap/vol); ids
  restricted to an ALLOWLIST (bitcoin, ethereum, usd-coin, tether, solana, binancecoin,
  ripple, cardano, dogecoin, avalanche-2, polygon-ecosystem-token); off-list → dropped.
- **Merge unchanged** — both branches return `{claim,source}[]`, folded into the
  grounding block at `_research.mjs:~305`. Graceful degradation everywhere: any failure
  → `[]` → Exa-only, never crash, never emit garbage.

**⚠️ ARC GOTCHA (recorded — cost a wrong-decimals near-miss):** `eth_getBalance` on Arc
returns an **18-DECIMAL NATIVE** value, NOT 6 — even though **USDC the ERC-20**
(`0x3600…0000`) is 6-dp. Both encode the SAME USDC value at different scales:
`eth_getBalance ÷1e18 == USDC balanceOf ÷1e6`. Proven live: `0xc54d…e621` = **43.75
USDC at ÷1e18** (matches `balanceOf ÷1e6` = the Arcscan balance; also `0x6db3…b380` =
0.09==0.09). Decode native with **18**; `÷1e6` would print a value 1e12× too large — a
FALSE number. The `DECIMALS_VERIFIED` gate CAUGHT the wrong 6-dp assumption at build
time (balance decoder stayed inert AND `buildRpcBody` refused to PAY for the read until
a live cross-check matched), then was flipped to `true` only after the match. Don't
trust a stated decimals value — cross-check native balance vs USDC `balanceOf`.

**Verified on PROD (user-run, passkey wallet — draft can't passkey-login, domain-bound):**
- Market: BTC price via CoinGecko, decoded + cited (free, no spend).
- On-chain: Arc block **50,762,442** via the QuickNode paid path — decoded from hex, x402
  settled (sub-cent, through the proven ceiling + budget gate).
- Classifier discipline: a carbon-capture question → Exa-only (no crypto over-trigger).

**Scope / deferred:** cut 1 = balance + gas + block + CoinGecko market. **Deferred:**
contract reads (`eth_call` / ABI decode), token-balance-by-contract, historical charts.
**Known cosmetic TODO:** the research price-preview card copy is stale for non-price
questions (says "single price source" for all) — cosmetic, not wired to the new router.

**Money path UNCHANGED:** no edits to `_x402.mjs`, the per-buy ceiling, or the budget
gate. On-chain reads reuse the proven pay path with a varying body; CoinGecko never
touches it. Files: `_cryptodata.mjs` (new), `_research.mjs` (classifier+router). tsc +
build clean; decoders + live CoinGecko smoke-tested; deployed to prod (functions-only,
frontend hash unchanged `index-qEtshKBL.js`).

---

## 2026-07-08 — RECON (read-only, no build): agent pays BlockRun via UB-funded Base wallet

**Goal explored:** let the research agent pay **BlockRun** (a pay-per-call x402 data/LLM
gateway that settles USDC on **Base mainnet**) for new capabilities, by (a) funding a
Base wallet from our Arc USDC via Circle Unified Balance + Forwarding Service, and (b)
letting BlockRun's own SDK handle the x402 payment. Two external research streams
(BlockRun SDK source; Circle UB docs) + codebase + Arc-mainnet status.

### Verdict: both linchpins GREEN mechanically, but the seam has a FATAL premise gap
"Fund a Base wallet **from our Arc USDC**" is **NOT achievable today** — **Arc has no
mainnet yet** (public testnet only as of 2026-07; mainnet beta scheduled 2026, and Arc
is not yet a Gateway mainnet source). BlockRun is **Base mainnet**. Testnet USDC can't
become mainnet USDC, and Gateway/UB is network-segregated (testnet→testnet only). So the
funding source must be **real mainnet USDC on an existing Gateway chain (Base/ETH/…),
NOT our Arc testnet balance.** This is a deliberate **mainnet, real-money, multi-session**
project — Tikpema's first mainnet crossing (the "deferred crossing" prior entries flagged).

### 1. BlockRun SDK wallet model (linchpin — RESOLVED: we provide the key)
- Accepts a key WE control: `new LLMClient({ privateKey })` or env
  `BASE_CHAIN_WALLET_KEY`/`BLOCKRUN_WALLET_KEY`, resolved FIRST before any generation
  (`blockrun-llm-ts/src/wallet.ts:102`; `src/types.ts` `LLMClientOptions = {privateKey?,
  apiUrl?, timeout?}` — no signer/account/apiKey param).
- Fallback only (no key): mints a fresh EOA, writes the raw key to `~/.blockrun/.session`
  (`wallet.ts:41–58`), exposes it via `getWalletAddress()` (`:133`).
- Signs with a **raw EOA private key** (viem `privateKeyToAccount`), NOT a Circle SCA/
  delegate. Settles **Base mainnet** (`src/x402.ts`: `BASE_CHAIN_ID=8453`,
  `USDC_BASE=0x8335…2913`), EIP-712 `TransferWithAuthorization`, **auto-pays on 402**
  (`src/client.ts handlePaymentAndRetry`) — no explicit pay(). So the SDK handles the
  x402 payment itself; we don't need our own x402 buyer. BlockRun is **mainnet-only** (no
  testnet endpoint) → the first real test IS a mainnet money test; no testnet dry-run.

### 2. Unified Balance fit (RESOLVED: it's the documented SCA path, already in use)
- We ALREADY call `kit.unifiedBalance.spend()` with the delegate model, proven on-chain:
  `_pay.mjs:47` (params `:29–44` — delegate EOA signs, SCA `sourceAccount` holds balance,
  `to.chain="Arc_Testnet"` today).
- Circle docs confirm this is REQUIRED for a Circle SCA ("*SCAs cannot sign their own
  Unified Balance spends… use the delegate workflow*"; "*SCA deposits require
  `allowanceStrategy:"approve"`*") — exactly our stack (`@circle-fin/app-kit@1.8.1` +
  `unified-balance-kit@1.2.1` + Circle Wallets adapter, installed).
- Fund an address we don't control: `spend({to:{chain:"Base…", recipientAddress,
  useForwarder:true}})` (no dest adapter) — documented server-side/custodial Forwarding
  mode. **No kit key** (just Circle API key + entity secret, which we have).
- Same Gateway burn→attest→mint primitive as our existing `_bridge.mjs` CCTP forward,
  which already mints to an arbitrary Base recipient (`_bridge.mjs:140,158`). Two working
  TESTNET mechanisms for the Arc→Base hop already exist.

### 3. The seam (mechanically yes; blocked by network reality)
Plumbing closes: Arc USDC → `unifiedBalance.spend`/bridge (`useForwarder`+
`recipientAddress`) → BlockRun EOA's Base address → BlockRun SDK signs from that key →
auto-pays x402. Two mismatches: **(fatal) network** — Arc testnet vs Base mainnet, no
path, Arc not a mainnet Gateway source yet → "from our Arc USDC" cannot hold; **(minor)
signer shape** — BlockRun wants a raw EOA; our wallet is a Circle SCA, so the BlockRun
payer is a SEPARATE raw mainnet EOA we generate + hold server-side (new hot-key mgmt).

### 4. Scope / risk
- BlockRun SDK integration: **SMALL** (`new LLMClient({privateKey})` + call; auto-pays).
- UB/funding call: **SMALL–MEDIUM** (delta from `_pay.mjs` is `to.chain:Base` +
  `useForwarder` + `addDelegate` on source; mainnet config net-new).
- Base wallet mgmt: **MEDIUM** (raw mainnet EOA private key, real hot wallet, fund+monitor).
- The mainnet crossing: **BIG** — real USDC, mainnet hot-wallet key, mainnet Gateway/UB
  config, and the funding source can't be Arc (premise gap); possible compliance screening.
- **Biggest risk:** testnet→mainnet real-money crossing + no Arc mainnet source + mainnet
  hot key + no testnet dry-run (BlockRun mainnet-only). **Multi-session, gated on a
  mainnet go/no-go — NOT a 1-session build.**

### The one decision before any scoping
Where the MAINNET USDC comes from (can't be Arc): (i) hold mainnet USDC on Base directly
and fund the EOA locally — simplest, no cross-chain; (ii) hold it on another mainnet
Gateway chain and spend/bridge to Base; (iii) wait for Arc mainnet + Gateway to make the
original "from Arc USDC" story real.

Sources: BlockRun `github.com/BlockRunAI/blockrun-llm-ts` (wallet.ts/types.ts/x402.ts/
client.ts); Circle App Kit UB docs (`docs.arc.io/app-kit/unified-balance`,
`.../use-forwarding-service`); Arc testnet-only + Gateway mainnet
(`circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet`,
`arc.io/blog/circle-launches-arc-public-testnet`, `circle.com/gateway`). Code:
`_pay.mjs:29–47`, `_bridge.mjs:140,158`. No code changed — recon only.

---

## 2026-07-08 — AI Agent guided actions COMPLETE: Bridge panel SHIPPED (all 3 cards live)

**Brick:** activated the last "Quick actions" card on the AI Agent page — Bridge (`Soon`
→ active amber `Bridge →`, routes to a new **`BridgePanel.tsx`**). Send · Swap · Bridge
are now all live guided panels. Also removed the now-dead `soonTag`/`CSSProperties` in
`MyAgentPanel.tsx` (Bridge was its last consumer). Multi-task box untouched.

**Call path (the guaranteed cap-enforcing door):** the panel POSTs to
**`/api/agent-bridge`** (new `bridgeFromAgent` in `useWallet.ts`, raw fetch like
SendPanel→`/api/agent-send`). It does NOT call `executeAction`/`agent-execute-plan`/the
bridge kit directly. `agent-bridge.mjs:46` → `executeAction(step,{walletAddress,session})`
→ the **per-bridge cap is compared at `_actions.mjs:91`** (`if (Number(step.amountUsdc) >
bcap)`, `bcap = bridgeCapUsdc()`), **before** the Arc burn (`agentBridge` at
`_actions.mjs:190`). Same path also enforces the live fee-floor (`:184–189`) and
day-ceiling (`:114`). Unlike swap, the bridge cap lives INSIDE `executeAction`, so the
dedicated endpoint is cap-safe — no one-step-plan indirection needed.

**Cap (deployed-confirmed):** `AGENT_BRIDGE_CAP_USDC=25` (via `netlify env:get …
--context production` — authoritative, not the code default). Operator is `>`, so 25
passes at the limit; over-25 blocks. A cap/fee-floor block returns HTTP 200
`{executed:false, blocked}`; `bridgeFromAgent` surfaces it as an error (not a silent
no-op).

**UX = Option A (fire-and-inform):** the Arc burn is synchronous; the destination mint
is async (Circle relayer). On submit the panel shows the burn tx + net arrival and lets
the user leave — the bridge completes server-side. One optional "Check status" button
does a SINGLE `agent-bridge-status` poll (`submitted → pending → minted|failed`), no
blocking loop.

**Fee shown POST-submit (pre-submit preview deferred):** the live IRIS fee/net is
surfaced from the `agent-bridge` response on the confirmation. A *pre-submit* fee preview
isn't available via existing surfaces — it would need a small fee-quote endpoint exposing
`bridgeFee` (`_bridge.mjs:109`), out of this UI-only brick's scope. Deferred; degrades
gracefully (bridge never blocked on a fee estimate).

**Arrival copy — aligned honestly:** originally "~10–20 min"; the prod test showed Base
Sepolia arrives faster, so the copy now reads "in a few minutes (up to ~20 for some
chains)" — honest across fast L2s and slower L1.

**Verified on PROD (user-run, passkey wallet — the draft can't passkey-login, domain-
bound):** (1) over-cap **26 USDC → rejected** "exceeds per-bridge limit of 25 USDC", no
funds moved; (2) happy path **5 USDC → Base Sepolia**: burn on Arc, **ARRIVED on Base
(~4.80 USDC, BaseScan mint tx confirmed), ~0.20 fee**; (3) "Check status" reflected the
mint. All 3 tests pass. Prod build hash `index-jKg6nPNR.js`; endpoints healthy
(`/api/agent-bridge` 405, `/api/agent-bridge-status` 405, `/api/my-wallet` 401).

Files: `BridgePanel.tsx` (new), `useWallet.ts` (+`bridgeFromAgent`, +`checkBridgeStatus`),
`App.tsx` (+`case "bridge"`), `MyAgentPanel.tsx` (Bridge card active, dead `soonTag`
removed). `#/bridge` is nav-less (like `#/swap`). Backend untouched. Build + tsc clean.

---

## 2026-07-07 — AI Agent page guided actions: Swap button (Swap brick) SHIPPED

**Brick:** activated the Swap card on the AI Agent page (`MyAgentPanel.tsx`) from
"Soon" to an active amber `Swap →` (identical treatment to the Send card), routing to
a new **`SwapPanel.tsx`** — a real USDC↔EURC form matching `SendPanel` (gated on
`w.agentWallet`, token selector + amount, async-"submitted"-aware confirmation, tx
link). Bridge stays "Soon"; multi-task box untouched.

**Call path (Option B — the cap-enforcing route, chosen deliberately):** the panel
does NOT touch the swap engine (`_swap.mjs`/App Kit) or call `agentSwap`/`kit.swap`.
It builds a structured one-step plan `[{type:"swap_tokens", tokenIn, tokenOut,
amountIn}]` and POSTs it through the EXISTING **`/api/agent-execute-plan`** executor
(new `swapFromAgent` in `useWallet.ts`; reuses `agentClient.executePlan` shape). No
LLM parse, no confirm round-trip — the form submit IS the confirmation.

**⚠️ WHY the plan-route, not a direct `executeAction` call (money-safety — do NOT
"simplify" this):** `executeAction` does NOT enforce a per-transaction cap on swaps.
Its per-tx caps are type-specific — send cap is `transfer_usdc`-only
(`_actions.mjs:79`), bridge cap is `bridge_usdc`-only (`:89`); the swap branch
(`:127`) goes straight to `agentSwap` with only the day-ceiling (`:114`) above it.
The per-action swap cap lives in the WRAPPERS. So the swap's caps are enforced at
**`agent-execute-plan.mjs:104`** (per-action cap, `capForA` → `sendCapUsdc` by USD
value) and **`:114`** (cumulative day-ceiling), BEFORE it calls `executeAction` at
**`:128`**. **Rewiring swap to call `executeAction` directly would BYPASS the per-tx
cap** (only the day-ceiling would bind). The plan-route is the cap-enforcing path —
leave it.

**CORRECTION (2026-07-07) — the real enforced cap is 10 USDC, not 5/1.** The two
lines below originally read "caps a swap at `sendCapUsdc` (5 USDC) … looser than the
text-box swap's `AGENT_MAX_SPEND_USDC` (1)". **That was a misstatement**: 5 and 1 are
only the code *defaults* (`_arc.mjs:72` / `agent-act.mjs:271`); the **deployed prod
env** sets both `AGENT_SEND_CAP_USDC=10` and `AGENT_MAX_SPEND_USDC=10` (confirmed via
`netlify env:get … --context production`, which manual `netlify deploy` also uses — so
drafts run the same 10). This doc-vs-env gap is what made a working 10-cap look like a
bypassed 5-cap when a 10 USDC swap passed. **Verified, no code bug:** the per-action
check is `if (vA > capForA(step))` — `>`, not `>=` (`agent-execute-plan.mjs:104`), and
the block message says "**exceeds** … limit of 10 USDC". So a swap of **exactly 10
passes by design** (10 is at the limit, not over); anything over 10 blocks (observed:
10 USDC swap passed; 12 EURC ≈ 13.68 USD blocked).

**Enforced cap (corrected):** the plan-route caps a swap at `sendCapUsdc` = **10 USDC**
(deployed) + the day-ceiling — the SAME caps a swap-as-a-plan-step gets. In prod the
text-box single swap's `AGENT_MAX_SPEND_USDC` is **also 10**, so the two paths enforce
the *same* 10; the earlier "looser 5-vs-1" framing does not hold for the running env.

**Deferred:** no pre-swap estimate preview yet (needs a `_swap.mjs` standalone
estimate export + an `agent-act` estimate branch — left for later). `#/swap` is a
**nav-less** route (like `#/nanopay`), reached via the AI Agent Swap card; no sidebar
item highlights (matches the "nav = working tools only" design).

**Verified end-to-end on a draft deploy** (`netlify deploy`, no `--prod`): happy-path
swap on-chain + over-cap rejection both confirmed. Then shipped to prod via Netlify
CLI (backgrounded), verified real: prod `index.html` references the new build hash
`index-fn9fa5h3.js`; `/api/agent-execute-plan` 405 (POST-only), `/api/my-wallet` 401
(auth-gated).

Files: `SwapPanel.tsx` (new), `useWallet.ts` (+`swapFromAgent`), `App.tsx`
(+`case "swap"`), `MyAgentPanel.tsx` (Swap card active). Build + tsc clean.

---

## 2026-07-07 — AI Agent page guided actions: Send button (Send brick) SHIPPED

**Brick:** the AI Agent page (`MyAgentPanel.tsx`) grew a "Quick actions" row of guided
shortcuts above the free-text box. **Send** routes to the existing Send view (sets
`window.location.hash = "/send"`; the sidebar highlights Send) — it reuses the same
`SendPanel`, not a duplicate money path. **Swap** and **Bridge** are present but
`disabled` with a muted "Soon" tag (placeholders until their own bricks; both remain
reachable today via natural-language tasks in the box below). The free-text multi-task
box was repositioned below the shortcuts as the general multi-step entry point, with a
tightened intro lede. Frontend-only — no function, `_actions.mjs`, cap, auth, or
`/api/*` change; `agent-send` untouched.

**Verified end-to-end on a draft deploy** (`netlify deploy`, no `--prod`, throwaway URL
with functions — didn't touch prod): navigation clean, one real **0.1 USDC send landed
on-chain**. Then shipped to prod via Netlify CLI (backgrounded), verified real:
prod `index.html` references the new build hash `index-CRUTDDnV.js` + control endpoints
healthy (`/api/my-wallet` 401 auth-gated, `/api/agent-send` 405 POST-only).

Files: `src/components/MyAgentPanel.tsx` (only). Build + tsc clean. Phase 1
(dashboard/wallet clarity) was committed separately in `9ca7a23`/`7cfd568`.

---

## 2026-07-07 — Phase 1 dashboard/wallet clarity COMMITTED (was live-but-uncommitted)

**Git/prod sync fix.** Phase 1 (dashboard + wallet clarity) had shipped to prod but
was NEVER committed — `git log` had no Phase 1 commit, so origin/main and prod were
out of sync. Closed that gap: committed the Phase 1 files only (`9ca7a23`), leaving
the in-progress Send brick (`MyAgentPanel.tsx`) uncommitted in the working tree.

Phase 1 surface (all live on prod already): masked wallet address with click-to-expand
+ copy (new `AddressDisplay.tsx`), USDC + EURC balances, wallet auto-refresh, three
logged-out options (incl. `#/wallet?new` create-intent), safe disconnect, and the old
login-wallet line removed. Files: `App.tsx` (parseHash strips `?intent` query so
deep-links resolve), `Dashboard.tsx`, `ConnectPasskey.tsx`, `useWallet.ts`, `_arc.mjs`,
`my-wallet.mjs`, `AddressDisplay.tsx` (new). Build + tsc clean.

Send brick (QUICK ACTIONS row: Send active, Swap/Bridge "Soon", repositioned
multi-task box) stays uncommitted for continuation this session.

---

## Session update — pay_for_service + shared execution refactor

All committed on `main` (local; no GitHub remote configured yet).

### What shipped
- **`pay-service` function** (`_pay.mjs` + `pay-service.mjs`) — the delegate-signed Gateway spend, proven last session as a script, now a guarded Netlify endpoint. Agent pays USDC from its Unified/Gateway balance via the EOA delegate; spend cap enforced; the code-1098/5001 async-waiter quirk caught and reported as `submitted`. Proven on-chain (seller wallet climbed correctly).
- **`pay_for_service` wired into the agent** (`agent-act.mjs` + `AgentPanel.tsx`) — the agent now triggers the Gateway payment from natural language ("pay 0.1 USDC from the Gateway balance to 0x…"). Disambiguation holds: plain "send" → `transfer_usdc` (regular balance); "pay from Gateway / for a service" → `pay_for_service` (delegate). Both proven on-chain.
- **Shared execution refactor** (`_actions.mjs`, branch `refactor/agent-act-shared-execution` → merged to `main`, commit `3349d46`) — extracted swap/pay/transfer execution into `executeAction(step, ctx)` + `valueOfStep(step)`. All three agent branches now route through this shared layer. Cap stays in the caller; `executeAction` validates shape + executes only. Verified: all three actions behave identically on-chain (transfer tx `0x16b5…3893`, swap tx `0x5164…7e67`, pay settled, Gateway balance → 1.086). This is the foundation for multi-step AND future surfaces (UI, research flow).

### The agent's money actions (all live, all guarded, all natural-language)
- `transfer_usdc` — send from regular balance
- `swap_tokens` — USDC↔EURC
- `pay_for_service` — pay from Gateway balance via delegate

### Next session — the multi-step feature (designed, not built)
Build the plan → confirm → execute layer on top of `executeAction`. Design calls already made:
- **Stop-on-failure** (on-chain can't roll back; do steps in order, stop at first failure, report what completed).
- **Total cap** (sum the USD value of all steps via `valueOfStep`, check against AGENT_MAX_SPEND_USDC before executing any).
- **Plan-then-confirm** (two-turn flow): `agent-act` detects a multi-step task and returns `{ needsConfirm, plan, totalUsdc }` instead of executing; UI shows the plan + a "Confirm & execute" button; a new `agent-execute-plan.mjs` endpoint loops `executeAction` over the confirmed steps. Client holds the plan between turns (server stays stateless).

### Loose ends
- **GitHub backup** not set up (no remote, no gh CLI). Clean standalone task when fresh: create repo, set up a PAT or `gh auth login`, push all history.
- `x402-pay.mjs` still parked (x402-protocol buyer, blocked on SCA signature — which the delegate now solves; could be revived).

---

# THREE-SESSION SUMMARY — pay_for_service → multi-step → x402 buyer

## Session 1 — pay_for_service + shared execution refactor
- **`pay-service`** (`_pay.mjs` + `pay-service.mjs`) — the delegate-signed Gateway
  spend became a guarded Netlify endpoint. Agent pays USDC from its Unified/Gateway
  balance via the EOA delegate; spend cap enforced; code-1098/5001 async-waiter
  quirk caught and reported "submitted". Proven on-chain.
- **`pay_for_service` wired into the agent** — natural-language Gateway payments
  ("pay 0.1 USDC from the Gateway balance to 0x…"). Disambiguation holds: plain
  "send" → transfer_usdc (regular balance); "pay from Gateway" → pay_for_service
  (delegate). Both proven on-chain.
- **Shared execution refactor** (`_actions.mjs`, commit `3349d46`) — extracted
  swap/pay/transfer into `executeAction(step, ctx)` + `valueOfStep(step)`. All three
  agent branches route through it. Cap stays in the caller. Foundation for multi-step
  AND future surfaces. Verified: all three actions behave identically on-chain.
  (Note: heavy edit-mechanic friction with heredocs — handed the extraction to
  Claude Code, which edits files directly. Lesson institutionalized.)

## Session 2 — multi-step feature (plan → confirm → execute)
The agent now handles multi-action tasks, built on `executeAction`. Three commits:
- **Executor** (`agent-execute-plan.mjs`, `f4a6e47`) — TOTAL cap up front (sum all
  steps' USD value, block before executing any), STOP-ON-FAILURE (in order, halt at
  first failure, no rollback), batched-settlement-aware per-step state ("submitted"
  vs "completed"). Pending transfer stops the plan (conservative).
- **Plan-detection** (`agent-act.mjs`, `a988e14`) — agent returns
  `{ needsConfirm, plan, totalUsdc }` WITHOUT executing. Distinct from
  needs_confirmation (which refuses scheduling/conditional).
- **UI** (`AgentPanel.tsx` + `agentClient.ts` + `netlify.toml`, `8fc354b`) — renders
  the plan + "Confirm & execute" button; on click POSTs to agent-execute-plan and
  renders per-step ✓/✗ results.
- Proven end to end in-browser, on-chain (seller reached 0.8 USDC via a multi-step pay).

### THE REDIRECT BUG (worth remembering)
The final blocker was self-inflicted: editing netlify.toml stripped `status = 200`
from the `/api/agent-act` rewrite, turning it into a 301 redirect. A browser follows
a 301 on a POST and DOWNGRADES it to GET → function 405s "POST only." curl masked it
(doesn't follow redirects by default), so it failed ONLY in-browser. Diagnosed via
curl-vs-browser isolation + a JS stack trace pointing at `act` + `num_redirects=0`
after the fix. **LESSON: every `/api/*` → function redirect in netlify.toml MUST have
`status = 200` (rewrite preserves POST). A 301 downgrades POST→GET.**

## Session 3 — x402-protocol buyer revived (commit `6909b64`)
Revived the parked `x402-pay.mjs` into a WORKING true x402 buyer (402 → sign → settle).
Proven on-chain: closed-loop test (our buyer → our x402-quote seller) returned HTTP 200,
`settleReceipt.success: true`, delegate Gateway balance debited exactly 0.001 USDC.

### The key architectural finding (proven by testing, not assumed)
- **The SCA's Gateway balance is UNREACHABLE via the batched x402 scheme.** The
  `@circle-fin/x402-batching` facilitator enforces `ecrecover(signature) == from`
  off-chain — there is NO depositor/signer split in the batched header format. So:
  SCA sig is ERC-1271 → rejected; a delegate sig signing for the SCA recovers to
  ≠`from` → rejected. (Confirmed via live /v1/x402/verify test, not guessed.)
- **This differs from the general Gateway delegate model** (`_pay.mjs` /
  pay_for_service), which DOES support depositor≠signer — but that uses the full
  burn-intent / App Kit spend flow, NOT the batched x402 header path. Two different
  layers; the depositor/signer split works in one, not the other.
- **Correct model = EOA-as-payer:** the payer EOA holds its OWN Gateway balance AND
  signs `from = itself`. Matches Circle's own documented "EOA-only for signing"
  guidance. The failed "elegant decoupling" attempt (SCA balance + delegate sig) was
  refuted by the test; we let the result redirect us to the correct architecture.
- **`depositFor` funding technique:** the SCA funded the delegate EOA's Gateway
  balance directly via `depositFor(USDC, delegate, 5e6)`, since the delegate EOA had
  no native USDC for gas. Reusable trick for funding an EOA's Gateway balance from
  the SCA.

### Status: PROVEN STANDALONE, NOT WIRED
x402-pay is committed as a proven standalone buyer, deliberately NOT wired into
agent-act. Reason: there are no external Arc x402 sellers yet (Exa's x402 is
Base/Solana only), so the only seller it can call is our own x402-quote — wiring it
into natural-language chat now would add a second confusing payment path (delegate
EOA balance vs SCA balance; x402 protocol vs App Kit spend) for a demo-only capability.
**Trigger to wire it later: an actual external Arc x402 seller to buy from.**

## Agent capabilities now
- Single actions: transfer_usdc (regular balance), swap_tokens (USDC↔EURC),
  pay_for_service (SCA Gateway balance via delegate) — all guarded, natural-language.
- Multi-step plans: decompose → confirm → execute, total cap + stop-on-failure.
- x402 buyer: proven standalone (not agent-wired), delegate-EOA-funded.
- Research-for-hire: ERC-8183 job loop live (job #145459 — priced, funded, Exa-
  researched, evaluated, settled on-chain, sourced answer delivered).

## Still open (no urgency)
- Wire x402-pay into agent-act — WHEN an external Arc x402 seller exists.
- Research-bound payment — deepen the "pay for data, get research" loop (partly live
  via ERC-8183).
- Compliance Engine (wallet screening / address pre-screening) — a MAINNET concern,
  relevant only if the agent pays arbitrary external recipients on mainnet. Not now.
- GitHub backup — still no remote (deploys via Netlify CLI); clean standalone task
  when fresh: create repo, PAT/gh auth, push all history.

---

# SESSION — Autonomous mid-research data purchases (Phase 2a) COMPLETE

## The vision, realized
Tikpema's research agent can now **autonomously buy paid data mid-research**, governed
by a budget spine with hard caps, incorporate the bought data into the delivered brief,
and settle on-chain — all proven end to end on testnet against our own stand-in seller.
This is the "AI Research Analyst that pays for its own inputs" North Star, proven safely.

## How we got here — the ecosystem investigation
- Discovered the **Circle Agent Marketplace** (agents.circle.com) — 474 resources across
  20 providers, agents paying APIs in USDC via x402. Real external data sellers exist
  (Exa, Parallel, Tavily, Google Scholar, Messari, etc.).
- **Ground-truth finding (via Circle's discovery API `GET api.circle.com/v2/x402/discovery/resources`):**
  the marketplace is **mainnet-only** — ZERO testnet endpoints anywhere. Base-dominant
  (eip155:8453), plus Polygon/Ethereum/Arbitrum/etc. and Solana. No Arc.
- **Two schemes:** vanilla x402 (`extra.name:"USD Coin"`, on-chain USDC transfer) — the
  majority incl. Exa & Parallel; and Gateway-batched (`GatewayWalletBatched`,
  supportsCircleGateway) — only 4 providers (AIsa, Alchemy, Arrays, BlockRun.AI). Our
  proven x402-pay buyer speaks ONLY the batched scheme.
- **Consequence:** reaching the research-relevant sellers (Exa/Parallel) needs a
  NEW vanilla-x402 buyer on Base MAINNET with real USDC — a deliberate mainnet project,
  deferred. So Phase 2a proves the whole pattern on TESTNET against our own stand-in.

## Design decisions (locked)
- Budgets: **persisted** (Netlify Blobs) — real per-day/per-period caps across jobs.
- Money: data allowance **carved from the user's job payment** (their price includes a
  data allowance the agent spends on their behalf).
- Trigger: **Claude-brain decides mid-research** ("I need source X") — genuine autonomy.
- Purchase failure: **graceful degradation** — proceed Exa-only, charge only on confirmed buy.
- Decision: **binary** (buy the one stand-in dataset or not), fixed price.

## What shipped (all committed, testnet, brick-by-brick)
1. **Budget spine** (`_budget.mjs`, commit `91ed463`) — three env-configurable caps:
   DATA_ALLOWANCE_PCT=0.30 (per-job allowance = price × pct), PER_PURCHASE_PCT=0.50
   (max single buy = allowance × pct), PERIOD_CEILING_USDC=2.00 (rolling UTC day).
   Exports canSpend/recordSpend/recordBlocked/jobSpend/daySpend/auditLog. Float-safe
   (cap math in atomic 6dp integers). Store-injectable (in-memory for tests, Blobs in
   prod). 26 isolated assertions pass. (Note: test file renamed `_budget-test.mjs` —
   dots break Netlify function names.)
2. **x402 buyer refactored to importable** (`_x402.mjs`, exports `payX402({sellerUrl,
   jobContext})`; `x402-pay.mjs` slimmed 270→27-line thin wrapper). Pure refactor,
   closed-loop test still passes identically.
3. **Plumbing** — `jobId`+`jobPrice` threaded into `research()` (jobPrice surfaced from
   `job.budget` already read on-chain in C1; atomic→USDC verified: 5000000→5 USDC).
   Stand-in seller `x402-quote` returns canned `{topic, facts:[{claim,source}×3]}` on
   paid 200 (402/settle unchanged).
4. **The autonomous loop** (`_research.mjs` Exa branch, commit `707d5db`) — two-phase:
   exaSearch → **decision call** (decidePurchase → {buy, justification}) → **budget gate**
   (canSpend) → **purchase** (payX402, graceful degradation, recordSpend only on success)
   → **merge** (purchased {claim,source} folded into grounding block AND the line-97
   sources override so citations survive) → synthesis. Downstream (hash/submit/evaluate/
   settle) untouched — consumes only the final brief.

## Both paths PROVEN (isolated harness, real on-chain job 1, jobPrice=5 USDC, real Exa+Anthropic+x402 settle)
- **ALLOWED:** decision BUY → gate allows → payX402 settled → 3 facts bought for $0.001 →
  purchased sources CITED in brief (merged with Exa) → recordSpend (allowed:true) →
  delegate debited 4.997→4.996.
- **BLOCKED:** decision BUY → gate blocks (per-purchase cap) → recordBlocked (allowed:false)
  → no purchase, no spend, Exa-only brief, balance unchanged.
- **Graceful degradation** proven incidentally (a payer-config failure → no spend, job continued).

## Honest notes
- The **genuine decision call runs in production** and returns reasoned verdicts — it
  SKIPPED when Exa already sufficed (the stand-in data is redundant with Exa by design).
  The buy-branch mechanics are proven via a TEST-ONLY `opts.forceDecision` injection;
  production never sets it, so the real agent always decides for itself.
- This means: the autonomy *mechanics* are proven, but the genuine agent rarely buys the
  redundant stand-in. A real "genuine buy" needs a stand-in dataset NON-redundant with
  Exa (data Exa can't retrieve), so a frugal agent rationally chooses to buy.

## Next steps (two distinct, decide deliberately)
- **Testnet refinement (safe):** give the stand-in a dataset genuinely non-redundant with
  Exa, so the GENUINE decision (no injection) chooses to buy because it's actually worth it.
  Completes the "genuine autonomy" picture on testnet.
- **Mainnet project (deliberate, real money):** reach real marketplace sellers (Exa/Parallel).
  Requires a NEW vanilla-x402 buyer + Base mainnet setup + real USDC + likely compliance
  screening. Tikpema's first mainnet crossing — scope consciously, not by momentum.
- Still open: wire x402-pay into agent-act (when a real external Arc seller exists);
  GitHub backup (no remote yet).

---

# SESSION — Codebase sharpening + GENUINE autonomy proven

## Strategic context
- Read Circle/Arc's "money's second act" manifesto (Rachel Mayer) — Arc positioned as
  the chain for the machine economy: "an agent is a worker… pays for compute, routes
  liquidity, settles with other agents constantly." Tikpema IS a working instance of
  this thesis. Validation + vocabulary for the "why Arc" narrative, not a redirect.
- Joined the **Arc Builders Fund** waitlist (agentic-commerce vertical maps directly to
  Tikpema). "Coming soon" — no deadline pressure; the fund bar is "apps that can only
  exist on Arc." Project-vs-company question left open, to decide deliberately.

## Radical move = SUBTRACTION (committed to the pivot)
Considered reviving prediction markets (agent-takes-positions) but decided AGAINST it —
reopens the gambling/asset-mgmt regulatory door deliberately closed, the closed-demo
version is "theater" (agent bets into empty pool, human resolves), and post-milestone/
pre-fund timing calls for consolidation not expansion. Instead:
- **`e79bfb8`** — removed 10 vestigial prediction files (1,053 lines): predict-bet,
  predict-analyze(+background), predict-start/status, predict-resolve-* (propose/
  background/start), research-start/background. Stripped 6 dead netlify.toml redirects
  + 2 orphaned timeout blocks. Grep-verified zero live references before deleting;
  build+deploy+smoke confirmed live product unaffected (predict-markets still serves,
  research job still runs). KEPT: predict-markets (live), _predict.mjs (publicClient is
  the shared chain-read client), PredictPanel/ResearchPanel/_research.
- **`1a702d2`** — comment hygiene: removed stale references to the deleted files across
  6 modules + netlify.toml. Comments-only, build passes.
- **`2e39b85`** — comment accuracy: `_research.mjs` header now truthfully states it CAN
  spend money (Exa path → maybeBuyData → payX402, budget-gated) — was falsely marked
  "READ ONLY, no transaction". `job-quote.mjs` range corrected [2,15]→[0.20,0.60] to
  match actual code. Deployed; prod in sync.
Note: Claude Code's cursor repeatedly auto-suggested reviving prediction markets (3×);
held the line each time — a tool suggestion is not a decision, and this one was made.

## THE MILESTONE — genuine autonomous economic judgment PROVEN (`5841181`)
Phase 2a proved the purchase *mechanics* but only via the test-only `forceDecision`
injection — because the stand-in data was redundant with Exa, so the honest decision
correctly SKIPPED. This session closed that gap by making the non-redundancy
**structural**, then proving the UNFORCED decision fires.

Build:
- `x402-quote.mjs` paid-200 body → `liveDataset()`: current Arc Testnet metrics (block
  time ~0.92s, Gateway settlement ~470ms, USDC peg) stamped with an `asOf` timestamp
  generated at request time — data indexed web search STRUCTURALLY cannot have. 402/
  settle path untouched.
- `_research.mjs` decision prompt now reasons about recency (web search is indexed/
  stale; a live feed reports "as of now") — but remains free to SKIP. No forced buy.
  `decidePurchase` exported so the proof drives the REAL production path, not a copy.

The two-case gate (real `decidePurchase`, NO injection):
- **CASE A — BUY 2/2** (go/no-go ops brief needing today's live figures, no buy hint):
  genuine reasoning — "requires present-moment figures… retrieved sources only provide
  design-target values, not live operational metrics." → budget ALLOWS ($0.001 vs
  $0.105 allowance) → live figure merged & CITED → recordSpend logs the model's own
  verbatim justification. The delivered brief reads: "GO — Arc Testnet is healthy as of
  2026-07-02T15:25:10Z. Current average block time ~0.92s… settlement latency ~470ms…
  Safe to ship" — citing the paid real-time feed. The bought data CHANGED the answer.
- **CASE B — SKIP 2/2** (definitional "what is Arc/x402" brief, no buy hint): genuine
  decline — "retrieved sources already provide sufficient information… no live figure
  is needed."

BUY-when-warranted AND SKIP-when-not, both from the genuine decision = real judgment,
not a rigged always-buy. Honesty confirmed: no question hints at buying; decidePurchase
logic unchanged (only recency awareness added to the prompt); it still skips B.

**What this proves:** the agent, unprompted, correctly decides WHEN real-time data is
worth paying for, buys it within budget, produces a better answer for it — and declines
when it isn't warranted. The manifesto's machine-economy claim, demonstrated on testnet
with an honest two-case proof. This is the fund-worthy result.

## The one caveat (honest)
The on-chain `payX402` byte-movement was NOT re-run in this proof — the decision→gate→
merge→record loop is proven fresh with real modules, but the actual on-chain settlement
rests on Phase 2a having settled that identical hop live (`4.997→4.996` earlier). A
single fully-end-to-end run (genuine decision → real on-chain settle in one shot) needs
the Gateway-funded delegate EOA in the env — worth doing eventually for the cleanest
pitch/demo artifact, not required to call this proven.

## State / next
- All committed on main (linear, local): `e79bfb8` → `1a702d2` → `2e39b85` → `5841181`.
  Prod in sync. Proof harness `_autonomy-test.mjs` committed inert; re-run:
  `node --env-file=.env netlify/functions/_autonomy-test.mjs`.
- Codebase is now cleanly the agentic-research product: clutter gone, comments honest,
  genuine autonomy proven.
- Open (deliberate, unhurried): (1) single fully-on-chain end-to-end run of the genuine
  decision (needs funded delegate EOA); (2) the mainnet real-seller project (vanilla
  x402 buyer on Base — the deferred crossing); (3) project-vs-company / Builders Fund
  decision; (4) GitHub backup (no remote yet).

---

# MILESTONE — Published a working vanilla-x402 reference for Arc (open source)

## The insight
Hit a real wall: no reliable x402 facilitator on Arc testnet (verified Xylo/
XyloFacilitator broken firsthand — route creation didn't persist; Circle's
marketplace is mainnet-only, all batched scheme). Diagnosed this as an
ECOSYSTEM-WIDE gap, not just ours. Decided to build the missing primitive —
scoped deliberately to Tier 1 (a minimal working reference), NOT a platform
(resisted the "build a public facilitator product" daydream). Primary goal:
unblock our own real-seller testing; secondary: a genuine community/PR artifact.

## Verify-first (on-chain, before building)
Proved Arc testnet USDC (0x3600…0000) is a Circle FiatTokenV2 with full EIP-3009
support — directly on-chain via cast:
- transferWithAuthorization reverts "FiatTokenV2: invalid signature" on garbage
  sig → function exists, runs real ecrecover logic. receiveWithAuthorization
  reverts "caller must be the payee". authorizationState present. Full EIP-3009
  surface live.
- EIP-712 domain confirmed bit-for-bit against on-chain DOMAIN_SEPARATOR():
  {name:"USDC", version:"2", chainId:5042002, verifyingContract:0x3600…0000}.
- Key constraint (same as batched): buyer MUST be an EOA (ecrecover → from==signer;
  an SCA can't produce a valid vanilla auth). Use the delegate EOA.

## Built + proven (brick 1, in Tikpema repo, commit 1fc484f)
Vanilla x402 "exact" seller + buyer pair, settling real USDC on Arc testnet:
- x402-vanilla-seller.mjs: unpaid → spec 402; on X-PAYMENT → guards → settles
  receiveWithAuthorization on-chain from its own wallet (msg.sender==payTo) →
  200 + data + receipt.
- _x402-vanilla.mjs: payX402Vanilla() — 402 → sign EIP-3009 auth (delegate EOA,
  ecrecover-compatible) → X-PAYMENT → settle result.
- Gate passed on-chain: settle tx 0xb7fa38…c551d8, buyer −0.01 / seller +0.01,
  receiveWithAuthorization selector 0xef55bec6, replay rejected (nonce consumed).

## Extracted + published (bricks 2a→2b→2c)
- 2a: extracted to a clean STANDALONE project at ~/arc-x402-reference/ — pure viem
  + local keys, ZERO Tikpema/Circle coupling, PLUGGABLE signing (viem-LocalAccount
  shape), simulateContract-before-settle (gas-efficient, improves on brick 1).
  Re-proven standalone on-chain: settle tx 0x759cbc…70f11. Fresh throwaway EOAs.
- 2b: honest README (flow diagram, the hard-won gotchas — EOA-only buyers, the
  receiveWithAuthorization msg.sender constraint, the exact-EIP-712-domain warning,
  Arc gas floor) + a clear "minimal reference, not audited, use at your own risk"
  scope disclaimer. MIT LICENSE, Copyright (c) 2026 Salifu Sandow Jargani.
- 2c: PUBLISHED PUBLIC → https://github.com/tikpema274/arc-x402-reference
  Verified: repo public, no .env/secrets on the remote, LICENSE name correct.
  (Also: set up gh CLI auth as tikpema274 — GitHub auth now configured, which
  unblocks the long-deferred Tikpema repo backup.)

## What this unblocks / next (deliberate, unhurried)
- We now have a PROVEN vanilla buyer + a REAL vanilla seller — the original goal
  (agent buying from a genuine third-party seller) is much closer; our own vanilla
  seller is a more honest "third party" than the batched stand-in.
- The vanilla buyer is the piece needed for the mainnet Circle marketplace
  (Exa/Parallel are vanilla on Base) — now proven on testnet first, de-risking the
  eventual mainnet crossing.
- PR/visibility (when ready): share the reference in Arc/Circle & Xylo Discords,
  tag the Arc team — converts "published repo" into ecosystem recognition. Ties to
  the Builders Fund thesis (a real shared primitive, not just a private app).
- GitHub backup of the Tikpema repo itself — now trivial (gh authed).

## State
Tikpema repo: brick-1 committed (1fc484f), otherwise untouched, prod in sync.
Standalone reference: live & public at github.com/tikpema274/arc-x402-reference.

---

# Cross-chain bridge: from "it's blocked" to a shipped agent capability (2026-07-05)

## The wall that wasn't
A prior recon had concluded outbound Arc→elsewhere bridging was BLOCKED — "the
agent can't sign the destination mint." That was true only of the RAW CCTP path
(depositForBurn + manual receiveMessage, which needs a destination-chain
signature). Disproved it: Circle App Kit's forwarding path needs just ONE Arc-side
signature — the Orbit relayer does the destination mint. So the real question was
never "can we bridge" but "can the agent's dev-controlled SCA make that one call."

## Verify-first (read the SDKs, not the docs)
Traced the proven path end-to-end through the installed @circle-fin packages:
- Arc Testnet has a custom BridgingKitContract (kitContracts.bridge =
  0xC5567a5E3370d4DBfB0540025078e283e36A363d) → App Kit takes the CUSTOM flow.
- With useForwarder:true the source-chain calls are two on-chain txs:
  usdc.increaseAllowance (preapproval) then cctp.v2.customBurnWithHook →
  contract method bridgeWithPreapprovalAndHook(BridgeParams, hookData). hookData =
  ASCII "cctp-forward" magic bytes. NO EIP-2612 permit on this path → the
  ecrecover-vs-ERC-1271 problem that forced allowanceStrategy:"approve" on swap
  never even arises. The Circle Wallets adapter has first-class SCA handling
  (withScaFeeInterceptor strips SCA-incompatible fee fields).
- kit.estimateBridge (free) resolved the full route for the agent SCA. Feasible.

## The spike + the App Kit dead-end (the honest failure)
Prepared scripts/spike-bridge.mjs (App Kit kit.bridge()). Live attempt FAILED —
but informatively: the approve LANDED on-chain (allowance set), yet App Kit
reported it as code 1098 "Transaction hash is required" (FATAL) because the Circle
SCA submits async and the hash isn't ready synchronously — the SAME race
_swap.mjs documents. App Kit's step state machine halts before the burn. Swap
survives this 1098 (single step, already effective); bridge dies on it (multi-step,
aborts before value moves). No funds lost — the failure was safe.

## The fix: the direct-contract path (scripts/bridge-direct.mjs)
Drove the bridge through Circle's dev-controlled createContractExecutionTransaction
+ waitForTx (the same plumbing that reliably moves funds for send/bets) — it polls
the Circle tx by id and returns the REAL hash, sidestepping the 1098 race. Built
the calldata directly with viem + the exact ABI extracted from adapter-viem-v2;
fetched maxFee live from Circle's IRIS API (providerFee ~0 + forwarderFee, volatile
with destination gas). PROVEN LIVE (user ran it): 15 USDC Arc→Sepolia, burn
0xaf6f5ba2… → Sepolia mint 0xa9fea2c8…, one Arc signature, relayer minted.

## Productized as a real agent action (commit edc119f, deployed prod)
"bridge X USDC to Ethereum" in plain language → agent PROPOSES (amount, live fee,
net) → user confirms → Arc burn → async destination mint, both tx links inline.
- _bridge.mjs: the executor (promoted spike) + bridgeFee() + bridgeMintStatus() +
  8 destinations (Ethereum/Base/Arbitrum/Optimism/Avalanche/Polygon/Unichain/
  Linea), each gated by a live IRIS forwarding tier.
- ONE secure path: bridge_usdc runs through the shared executeAction — auth-gated
  (401 anon), source wallet session-resolved (never client-supplied), per-bridge
  cap (AGENT_BRIDGE_CAP_USDC=25), live FEE-FLOOR refusal (won't attempt an
  un-settleable bridge), per-user day-ceiling + ledger. agent-bridge is the single
  confirmed-execute endpoint; agent-act only proposes; agent-bridge-status polls.
- Config gotcha: PERIOD_CEILING_USDC defaulted to 2 (tuned for tiny data buys) —
  raised to 60 in prod so bridges of meaningful size aren't blocked by the ceiling.
- Verified live by user: 3 USDC Arc→Sepolia settled; fee-floor refusal (1 USDC →
  "too small, fee ~1.55"); per-bridge cap (30 → "exceeds 25"); no send/swap regress.

## Copy + the multi-step gap (commits bf8ca5e, 24a4185)
- bf8ca5e: surfaced bridging in the app-page hero lede + 01–04 ledger (honest —
  dropped "in seconds" so it never implies instant cross-chain; it's ~1–2 min async).
- 24a4185: fixed "unknown step type bridge_usdc" inside multi-step plans. The plan
  path had never learned the step type (KINDS allow-list rejected it; both proposal
  and executor capped every step with the SEND cap). Fix — through the SAME executor
  (no second path): KINDS += bridge_usdc, type-aware per-step cap (bridge→bridgeCap),
  plan prompt teaches bridge steps. Option A "fire-and-continue": executeAction
  returns after the Arc burn (state "submitted") without waiting on the mint, so the
  plan moves on; MyAgentPanel polls each bridge step's mint INLINE (concurrent,
  background) — burned→minting→minted. Per-step caps/fee-floor/day-ceiling still hold.
  Verified live by user: 3-step plan (bridge 2 to Base, swap 1 EURC→USDC, send 3) ran
  all steps, bridge showed inline burned→minted, plan continued.

## What this unblocks / next
- The agent is now genuinely cross-chain: it can move its USDC off Arc to 8 EVM
  networks by natural language, standalone or as a step in a chained plan, all
  guardrailed. Cross-chain was the last "does the SCA even work here" unknown.
- The key reusable lesson: for ANY multi-step Circle-SCA on-chain flow, prefer the
  dev-controlled createContractExecutionTransaction + waitForTx path over App Kit's
  orchestration — the latter's synchronous hash-wait races the SCA's async submit
  (1098) and aborts mid-sequence. Documented in the memory note.

## State
Tikpema repo: bridge feature shipped + prod in sync — commits edc119f (feature),
bf8ca5e (copy), 24a4185 (multi-step fix), all on main, pushed to origin.
Prod env: AGENT_BRIDGE_CAP_USDC=25, PERIOD_CEILING_USDC=60.
Spike scripts kept under scripts/ as the proven reference. Agent wallet 0xc54d…e621.

---

## Session update — passkey/ceiling hardening, cross-chain bridge, refusal copy

*Two-day session. All committed + pushed to private GitHub `tikpema274/tikpema`, verified live.*

### Fixes (committed + pushed, verified live)
- **Passkey login fix** (`c1ae868`) — returning users land in their existing wallet (deterministic restore from stored non-secret credential `{id, publicKey, rpId}`; graceful failure, no silent new-wallet).
- **Smart login/create entry** (`c1ae868`) — one "Continue with your passkey" button (login-if-exists / create-if-new); MetaMask secondary; deliberate/muted "different wallet" escape hatch with honest fresh-wallet copy. Fixes wallet proliferation.
- **Per-user daily ceiling** (`aea98a9`/`44de574`) — was a shared global counter (users blocked each other); now keyed `day:<owner>:<date>` per server-resolved wallet. Verified live: wallet A maxed ≠ wallet B blocked.
- **Agent-first copy reframe** (`7297c37`, `bf8ca5e`) — app page reframed from "research analyst" to "autonomous agent" (research as flagship + send/swap/multi-task/bridge); one consistent voice; honest (no "caps you control" — caps are env-set, not user-adjustable).
- **Refusal copy fix** (`e58bd9e`) — plain wording for scheduled/conditional transfer refusals (`agent-act.mjs` ~:116-120 model-flagged + ~:186-200 regex backstop); strings only, no logic touched. Verified live.

### Cross-chain bridge — the capstone (agent bridges USDC to 8 networks)
- **Disproved the earlier "blocked" recon.** Raw CCTP direct-mint needs a destination-chain signer (agent's Arc SCA can't). Circle App Kit single-sign forwarding removes that — sign once on Arc, Circle's Orbit relayer mints on destination. But App Kit `kit.bridge()` is incompatible with dev-controlled SCA async submission (1098 race).
- **Fix = direct-contract path**: `createContractExecutionTransaction` + `waitForTx` calling `increaseAllowance` then `bridgeWithPreapprovalAndHook` on `0xC5567a5E3370d4DBfB0540025078e283e36A363d` with cctp-forward `hookData` (same plumbing as agent-send; byte-identical to App Kit's call; selector `0x513e1175`; `maxFee` from Circle IRIS API; no `KIT_KEY` needed — only swap needs that). Spike (`scripts/bridge-direct.mjs`) proved a 15-USDC agent-wallet bridge Arc→Sepolia end-to-end.
- **Shipped as agent action** (`edc119f`): `_bridge.mjs` executor + `agent-bridge.mjs`/`agent-bridge-status.mjs`, folded into the one `executeAction`. NL "bridge X to Ethereum" → propose (live fee + net) → confirm → burn on Arc → async destination mint. Guardrails: fee-floor refusal (live IRIS fee, volatile ~1.5–14 USDC), `AGENT_BRIDGE_CAP_USDC=25`, day-ceiling (`PERIOD_CEILING_USDC=60` in prod). Verified live: 20-USDC settled; 1-USDC refused (fee floor); 30-USDC blocked (cap).
- **Bridge-in-multi-step fix** (`24a4185`) — plan executor didn't know `bridge_usdc` step type. Fixed with Option A (fire-and-continue; bridge shows inline burn→mint status; plan continues; per-step caps/balance still checked). Verified live: 3-step plan (bridge 2→Base, swap 1 EURC→USDC, send 3) ran end-to-end.

### Architecture confirmed by code trace
Two pipelines — free-form action agent (`agent-act` → `executeAction` in `_actions.mjs`, the single guarded chokepoint where money moves re-check caps) and the research/escrow job tree — sharing `_auth`, `_agent-wallets`, `_budget`, `_circle`, `_arc`. Both bridge entry points converge on `executeAction`. The "one secure path" claim is backed by the trace.

### ⚠️ THREE "KNOW BEFORE YOU TOUCH" GOTCHAS (from code trace — read before the relevant cleanup)
1. **Prediction cleanup is a TRAP.** `_predict.mjs` exports `publicClient()` — the shared viem RPC client that agent-send, `_bridge`, AND the job workers import. So `_predict.mjs` is NOT deletable as-is; naive deletion breaks the money paths. Correct order: (a) move `publicClient()` out into a neutral shared module (e.g. `_circle.mjs` or new `_rpc.mjs`), repoint send/bridge/jobs, verify they still work; (b) THEN remove the genuinely-dead surfaces `predict-markets.mjs` + `PredictPanel.tsx` + `_predict.mjs`.
2. **`_budget.mjs` has LYING comments** — headers claim the cap system is "NOT WIRED," but it demonstrably IS wired. Misleading in money code (audit hazard). One-line fix whenever.
3. **`maxSpendUsdc()` is dead for its own paths** — it was hardened to replace inline `process.env.AGENT_MAX_SPEND_USDC` reads, but swap/pay branches still do the raw inline read. Hygiene, NOT a hole (pay is already the most-capped path: ~1 USDC inline cap + day-ceiling). Worth wiring for (a) not leaving a hardened parser dead, (b) misconfiguration defense. Needs its own scoping first — "make them identical" ≠ "make them safer."

### State
HEAD `ae05381` (adds this PROGRESS.md; last code change `e58bd9e`), clean, pushed, no open bugs.

**Parked backlog:** prediction dead-code cleanup (SEE GOTCHA #1 — move the RPC client first), `_budget.mjs` comment fix, `maxSpendUsdc()` wiring (needs scoping), recovery (2b/2c — Circle mechanism confirmed, highest-stakes), user-configurable/tiered caps, app+landing redesigns.

**Strategic (high-leverage now):** real users, Arc Builders Fund (strong story — cross-chain + Arc-roadmap fit), testnet→mainnet.

---

## Session update — sidebar console redesign (frontend only)

*Committed + pushed to `tikpema274/tikpema`, verified live on production.*

Reorganized the app from a single stacked-panel page (App.tsx rendered ConnectPasskey, ResearchPanel, MyAgentPanel, FeedbackPanel linearly, no router) into a multi-page **sidebar console**. Frontend only — no Netlify function, `_actions.mjs`, cap, auth, or `/api/*` money-path change; no new endpoints or client methods; no Swap/Bridge forms. PredictPanel/predict-markets left untouched (still dead — separate cleanup).

### What shipped (`982b60e`)
- **Routing** — lightweight **hash router**, no new dependency. Active view derives from `window.location.hash` (`parseHash()` in App.tsx) + a `hashchange` listener; nav sets `#/<route>`, so views deep-link (`#/send`, `#/research`) and the back button works. The single `const wallet = useWallet()` stays at the shell and is passed to every page as before.
- **Sidebar shell** — left nav, 5 items in order: Dashboard · Wallet · AI Agent · Research · Send. Feedback in a muted low-priority foot slot. No Swap/Bridge/Lend/Stake/Prediction items. Swap and Bridge stay reachable **inside AI Agent via natural-language tasks**, unchanged. Same visual language (warm-ink surfaces, amber-gold accent, Space Mono) — layout, not a recolor.
- **SendPanel.tsx (new)** — Send form lifted out of ConnectPasskey (coupling check confirmed it shared nothing but the `w` prop). `send()` logic and the `/api/agent-send` call are byte-identical; gated on `w.agentWallet` exactly as before, so Send never appears before a wallet exists.
- **Dashboard.tsx (new)** — overview composed only from existing per-user reads (`w.agentWallet` address/balance, `w.busy`, `w.refreshAgentWallet`) + quick-links to the action pages. Deliberately does NOT call `/api/agent-status` — that endpoint reads the SHARED env demo wallet (`process.env.AGENT_WALLET_ADDRESS`), not the user's, so surfacing it here would misrepresent the balance.
- **ConnectPasskey.tsx** — Send block + its state/helpers removed; connect flow (`username`, `showCreate`, `hasPasskey`, `handlePasskey`, `w.connect*`/`startOver`) untouched. It is now the **Wallet** page (connect + balance + funding + status).
- **styles.css** — added `.console`/`.sidebar`/`.nav`/`.console-main`/`.quick` using existing tokens; old `.app`/`.hero` styles left in place (harmless, unused).

Files: `src/App.tsx`, `src/components/ConnectPasskey.tsx` (modified); `src/components/SendPanel.tsx`, `src/components/Dashboard.tsx` (new); `src/styles.css`. Build + typecheck clean; prod serves the new bundle (verified via index.html hash + live click-through).

### Note for a future palette pass
The redesign brief described the palette as "deep navy, cyan, emerald," but the actual design is warm-ink + amber-gold. Kept the real tokens (instruction was "layout, not a recolor"). A navy/cyan reskin, if ever wanted, is a separate recolor pass.

### State
HEAD `982b60e`, clean, pushed, no open bugs. (Backlog + strategic items unchanged from the prior session entry above.)

---

## Feasibility survey — Nanopayments / user-escrow (read-only, no code changes)

*Two read-only code surveys evaluating whether a user-facing "Nanopayments" payment feature is buildable on existing surfaces. No files changed. Findings only.*

### A. x402 surfaces — pure pay-per-request, NO payment channel
- **Sellers:** `x402-quote.mjs` (Gateway-batched, $0.001, via `BatchFacilitatorClient`), `x402-vanilla-seller.mjs` (vanilla EIP-3009, $0.01, settles `receiveWithAuthorization` on-chain). **Buyers:** `_x402.mjs` (`payX402`, Gateway-batched), `_x402-vanilla.mjs` (`payX402Vanilla`, token-domain), `x402-pay.mjs` (thin HTTP wrapper).
- **Payment model:** every path is one signed EIP-3009 authorization = one HTTP call = one resource. **No channel / deposit-escrow / streaming / return-on-close anywhere.** The Gateway-batched path authorizes against an ALREADY-DEPOSITED balance (funded via `depositFor`), but still one-shot-per-request — a held pooled balance, not a per-counterparty escrow.
- **Chain:** Arc Testnet only (`eip155:5042002`, USDC `0x3600…0000`). No Base/Solana anywhere (grep-confirmed). Consistent with the Exa note: the buyer only ever pays this repo's OWN Arc seller (`DEFAULT_SELLER_URL` → app.tikpema.xyz/x402-quote); it sidesteps Exa's Base/Solana-only x402 entirely.
- **Live vs spike:** `_x402.mjs`/`payX402` = LIVE (called mid-research at `_research.mjs:120`, budget-gated). `x402-quote.mjs` = live seller counterparty. `x402-pay.mjs`, `x402-vanilla-seller.mjs`, `_x402-vanilla.mjs` = defined-but-unused spikes. Note: `executeAction`'s `pay_for_service` uses `agentPay` (plain transfer), NOT x402.
- **Money-safety:** x402 buys have their OWN controls (in-buyer `AGENT_MAX_SPEND_USDC` cap + `_budget.mjs` `canSpend`/`recordSpend` per-job spine), authed as the dev-controlled `DELEGATE_ADDRESS` EOA — NOT the user session/`executeAction` path.

### B. ERC-8183 escrow pipeline — separable from research, per-user auth already present
- **Contract:** `AGENTIC_COMMERCE 0x0747EEf0…4583`. Lifecycle: `createJob → setBudget → approve → fund → submit → complete/reject`.
- **Separable from research?** YES — cleanly layered. On-chain calls are task-agnostic (`job-run-background.mjs:68-82`, `job-submit-background.mjs:292-299`, `job-evaluate-background.mjs:262-268`); the on-chain layer only sees a generic keccak256 `deliverableHash`, never research content. Research logic is confined to `_research.mjs` + brief/judge prompts. A job's only task-descriptive field is a free-form `string description` (now `question`) — an arbitrary task fits WITHOUT changing the contract interaction.
- **Evaluator:** hardwired, not pluggable. `job-evaluate-background.mjs:252-268` always runs the module-local Haiku/Sonnet `evaluate()` to pick `complete` vs `reject`. Swapping in human sign-off = editing this handler (settlement calls stay generic).
- **Auth (the key finding):** `fund()` ALREADY moves the authenticated user's OWN per-user SCA wallet under their session. `job-run.mjs:33-52` does `requireSession` → `ensureOwnerWallet` → threads the resolved wallet to `job-run-background.mjs` via `internalToken()`. Per-user wallet resolution already applies to job funding. (Legacy `job-set-budget.mjs:29` still uses the shared env wallet, but it's NOT part of the live `job-run` pipeline.)
- **Two-party gap:** today `createJob` passes `[walletAddress, walletAddress, …]` → client == provider == evaluator == the ONE user wallet ("self-agent model"). So "release" and "refund" both land back in the depositor's own wallet — money never changes hands. A real user-escrows-for-a-task feature needs DISTINCT provider + evaluator addresses — a change to the `createJob` ARGS (`job-run-background.mjs:71`), not the ABI or settlement calls.
- **⚠️ Caps: the escrow `fund()` is UNCAPPED.** `job-run.mjs` validates only `budgetUsdc > 0` + wallet balance; no `canSpend`/`sendCapUsdc`/day-ceiling on the create→fund path. `_budget.mjs` caps cover ONLY autonomous mid-research x402 buys, not the user's escrow deposit. `job-quote.mjs:85` clamps the *suggested* budget to [0.20, 0.60] but `job-run.mjs` doesn't re-validate — deposit amount is uncapped.

### Verdict (what a user-escrow feature would reuse / need)
- **Reuse as-is:** the entire on-chain escrow spine (create/fund/submit/complete/reject, generic Circle `exec`, `waitForTx`/`TxPendingError`, `getJob` idempotency, keccak256 determinism, Blobs status stores, status/deliverable polling) AND the auth spine (`requireSession` → `ensureOwnerWallet` per-user SCA → balance gate → session→internalToken hand-off).
- **Generalize:** factor research out of the two fused handlers (task-production in job-submit, auto-judge in job-evaluate) behind a task/evaluator interface; `description` string; research-only `job-quote.mjs` pricing.
- **Net-new:** distinct provider/evaluator addresses in `createJob` (genuine two-party escrow vs self-agent); a real deliverable-acceptance path (human sign-off / non-research verifier); a deposit cap on the fund path (none today).
- **Highest money-risk (careful build + live test):** `fund()` (`job-run-background.mjs:82`, uncapped user-USDC pull), the `reject()`/refund path (`job-evaluate-background.mjs:180-197`), and the `complete`-vs-`reject` branch (`:262-268`) — the three direct user-money-movement surfaces.

*No code changed. This is a scoping/feasibility record only.*

---

## Session update — hard cap on the escrow fund path (money-safety fix)

*Closes the ⚠️ finding from the feasibility survey directly above: the escrow `fund()` was UNCAPPED. Committed `537d747` (backup remote `tikpema274/tikpema`), deployed to prod via the Netlify CLI, verified live on `app.tikpema.xyz`.*

### The problem (from the survey)
`job-run.mjs` accepted any client-supplied `budgetUsdc > 0`, checked ONLY against wallet balance — the one uncapped money path in the app. `_budget.mjs` caps cover only autonomous mid-research x402 buys, not the user's escrow deposit; `job-quote.mjs:85` clamps the *suggested* budget to [0.20, 0.60] but is a suggestion the server never re-validated.

### What shipped (`537d747`)
- **`netlify/functions/job-run.mjs` only.** Added a per-transaction hard cap on the deposit: after the existing `budgetUsdc > 0` validation and before wallet resolution / the balance gate, `job-run.mjs:48-53`:
  ```js
  const cap = sendCapUsdc();
  if (budget > cap) {
    return json(400, { error: `Deposit ${budget} exceeds per-transaction limit of ${cap} USDC` });
  }
  ```
  Plus the import (`job-run.mjs:14`).
- **Reuses `sendCapUsdc()`** from `_arc.mjs` — the SAME per-tx cap the send / `executeAction` paths enforce (default 5 USDC on testnet). No new env var, no new number.
- **Reject, never clamp** — over-cap returns `400` naming the limit + the requested amount, mirroring the existing cap wording (`_actions.mjs:82`, `agent-act.mjs:334`). Never funds a different amount than the user asked for. The reject returns before wallet resolution, so **no funds move**.
- **Server-side, post-`requireSession`** — enforced in the authenticated front door, so no client can bypass it. The `job-quote.mjs` clamp stays a suggestion; this is the real enforcement.
- **Per-tx bound only** — deliberately NOT wired into the `_budget.mjs` daily ceiling (`canSpendDay`). No lifecycle / evaluator / self-escrow-model changes. No changes to `_actions.mjs`, send, swap, or bridge.

### Deploy + live verification
- Deployed via `npm run build` + `netlify deploy --prod --dir=dist` (this project's real deploy path — CLI, not git auto-build; see the deploy memory). Live at `app.tikpema.xyz`, all 43 functions incl. `job-run` shipped.
- **Verified live on prod (user-run, authenticated):** over-cap `budgetUsdc: 5.01` → `400` `{"error":"Deposit 5.01 exceeds per-transaction limit of 5 USDC"}` (no funds moved); at-cap `budgetUsdc: 5` → `202` (gate cleared, job started). ✅

### State
HEAD `537d747`, clean. The one uncapped user-money path is now bounded. Note: this is the *deposit* per-tx cap only — the survey's other net-new items (distinct provider/evaluator addresses for genuine two-party escrow, a non-research deliverable-acceptance path, `reject()`/refund-path review) remain open and out of scope for this change.


## 2026-07-06 — x402 Gateway-batched buy PROVEN settling on Arc (Brick D resolved)

**Result: PASS.** The existing Gateway-batched x402 buyer (payX402 in _x402.mjs)
produced a real, settled payment on Arc Testnet. Closes the long-open "has x402
ever actually settled on Arc?" question.

Evidence (from a temporary read-only diagnostic, since deleted + confirmed 404 on prod):
- executed: true, settleReceipt.success: true
- Settlement id (Circle Gateway batch, not a 0x tx hash): e2ee4aa4-6af5-4d86-b5a7-551197443fcf
- Network: eip155:5042002 (Arc Testnet)
- Payer (DELEGATE_ADDRESS): 0x6db396c1a37024fd3bee1f3dbf3020aa3b2bb380
- Payer Gateway balance moved 4.996 -> 4.995 USDC — receipt and balance agree
- Price: 0.001 USDC; seller advertised GatewayWalletBatched / verifyingContract
  0x0077777d7EBA4688BDeF3E311b846F25870A19B9 (Gateway wallet) → confirms
  Gateway-batched path, NOT raw per-tx EIP-3009 (the vanilla twin)
- Seller returned real content — full request->402->pay->settle->deliver loop closed

Scope — what this did NOT prove (still open):
- Self-loop only: our own x402-quote was both seller and payee
  (payTo 0xc70112c7d5ebe38cd998679594a5d082c1860df6). External-seller NOT proven.
- Budget caps (30%/50%/period in _budget.mjs) NOT exercised — diagnostic bypassed
  maybeBuyData's gate by design. Caps still unverified in a live buy.
- Settlement id is a Gateway batch UUID; not yet traced to an on-chain batch tx on Arcscan.

Correction: _budget.mjs header comments claiming caps are "NOT WIRED" are false —
caps are wired; they just weren't in this test path.

Op note: minting an internal token for a PROD call requires
`netlify env:get SESSION_SECRET --context production` — the bare command returns
the dev secret and every token 401s.

Next brick: exercise the real maybeBuyData path so caps bind for the first time —
price a job so the buy would exceed allowance, confirm it's blocked (not clamped).
Then: external Arc seller; then audit cleanups (delete vanilla-x402 twin,
gate/remove unauth agent-init.mjs, retire shared-wallet ghosts).

## 2026-07-06 (pm) — Budget gate BLOCKS over-allowance data-buy (reject-not-clamp) PROVEN

**Result: PASS.** The data-buy budget gate rejects an over-allowance buy on the
real maybeBuyData path — it does NOT clamp — and no money moves.

How tested: temporary diag-caps-block endpoint (since deleted, prod 404 confirmed)
drove the real exported research() → private maybeBuyData with forceDecision:{buy:true},
injecting DATA_PURCHASE_USDC=0.05 into process.env for that invocation only. At
jobPrice 0.20: allowance 0.20 x 0.30 = 0.06; per-purchase cap 0.06 x 0.50 = 0.03.
Injected 0.05 > 0.03 → blocks at the per-purchase branch.

Evidence:
- canSpend returned allowed:false, reason "per-purchase cap: 0.05 > 0.03 USDC
  (0.5 of job allowance 0.06)" — per-purchase branch, not period ceiling
- realPath.purchasedFacts = 0 — buy skipped, not shrunk (reject, not clamp)
- Payer (0x6db3…b380) Gateway balance unchanged 4.995 → 4.995 — no money moved
- Job still returned a clean Exa-only brief — graceful degradation intact
- exa_branch_ran = true — precondition held, gate was actually exercised
- Function log confirmed the clean "[research] budget BLOCKED: per-purchase cap:
  0.05 > 0.03" path; NO "purchase loop error" line (swallowed-throw ruled out)
- Log line "purchase decision: BUY ($0.05)" (from dataPurchaseUsdc()) independently
  proves the injected 0.05 reached real production code — default 0.001 would have
  been under the cap and allowed

Note: the harness's injected_amount_reached_real_code assertion came back false and
auditEntriesWrittenThisRun was empty ONLY because they keyed off the persisted
recordBlocked audit entry, which didn't read back within the direct invocation — a
Netlify Blobs readback artifact of the throwaway diagnostic, NOT a gate failure.
The reason string + the BUY ($0.05) log line + unchanged balance close it fully.

**Scope — what this did NOT prove (still open, more important — Brick 2):**
- canSpend checks DATA_PURCHASE_USDC (env figure). The actual buy charges the
  SELLER'S advertised maxAmountRequired, which the gate never sees (payX402 reads
  it internally; maybeBuyData passes no amount). Both ~equal by coincidence today.
  A gate validating a different number than the one charged is a latent money-safety
  hole — it goes live the moment DATA_SELLER_URL points at an external seller with a
  different price. Fix options drafted: (guard) payX402 refuses to sign if
  maxAmountRequired > approved ceiling; (reorder, cleaner) fetch 402 first, gate the
  advertised amount, then sign+settle. Lean: guard now, reorder later.

**Op notes (both bit us this session):**
- When Claude Code runs the prod deploy it MUST background it — a foreground
  `netlify deploy` exceeds the 5-min tool timeout and gets SIGTERM'd mid-upload,
  leaving prod half-updated (endpoint 404s). Backgrounding removes the ceiling.
  (Deploying from your own terminal is unaffected.)
- Audit-log readback in a directly-invoked diagnostic doesn't reliably reflect
  Netlify Blobs writes within the same invocation. Future cap tests should assert on
  the canSpend reason string / function logs, not the persisted recordBlocked entry.

## 2026-07-06 (pm) — payX402 approved-amount guard added + proven (gate/wire mismatch CONTAINED)

**What:** Added a fail-closed approved-amount guard to payX402 (_x402.mjs) closing
the gate/wire gap where canSpend validated DATA_PURCHASE_USDC but payX402 charged
the seller's advertised maxAmountRequired unchecked. payX402 now takes approvedUsdc
+ requireApproved; maybeBuyData passes the canSpend-approved amount with
requireApproved:true. Atomic-integer compare (micro-USDC), refusal fires in step
"guard" before any signing/settlement, returns the existing {executed:false,blocked}
shape so maybeBuyData degrades to clean Exa-only.

**Posture:** research path is FAIL-CLOSED — a data buy with a missing/invalid
ceiling is refused, not waved to the AGENT_MAX_SPEND backstop. x402-pay.mjs (test
harness) is intentionally EXEMPT (does not set requireApproved) and runs on the
AGENT_MAX_SPEND_USDC backstop only; if it ever becomes a real buy path, pass it an
explicit approvedUsdc.

**Proven end-to-end (temporary diag-guard, since retired):**
- State 1 ENFORCE: approved 0.0005 < advertised 0.001 → blocked "advertised price
  exceeds budget-approved", never reached sign, balance unchanged
- State 2 FAIL-CLOSED: approved undefined and 0 → blocked "fail-closed: requires a
  budget-approved ceiling", never reached sign, balance unchanged
- State 3 HAPPY: approved 0.01 > advertised 0.001 → executed:true, settleReceipt
  (batch afb1f2bc-…), balance 4.995 → 4.994 (−0.001). Guard does not break settlement.

**Still open — this CONTAINS, does not fully close, the mismatch:** the guard binds
the SIGNED amount to the approved ceiling (you can't sign an over-ceiling
authorization). It does not make canSpend gate the advertised price as canonical
input — that's the "reorder" (fetch 402 → gate advertised amount → sign+settle),
still the cleaner eventual fix. Guard is the belt; reorder is the redesign.

## 2026-07-06 (pm) — payX402 reorder: canSpend now gates the SELLER'S advertised price (gate/wire mismatch CLOSED)

**What:** Reordered the data-buy path so the budget gate reads the seller's
advertised maxAmountRequired as canonical input, instead of gating DATA_PURCHASE_USDC
and binding it afterward. Extracted fetchX402Requirements() from payX402 (exported);
payX402 gained an optional `challenge` param (challenge ?? fetch — single fetch,
threaded). maybeBuyData now: fetch 402 → derive advertisedUsdc → canSpend(advertised)
→ payX402(challenge threaded, approvedUsdc=advertised). Gated price == signed price
by construction. Guard KEPT as defense-in-depth (TOCTOU insurance + sole bound for
x402-pay.mjs, which passes no challenge and self-fetches unchanged).

**This CLOSES the gate/wire mismatch** that the earlier guard only contained: the
gate now validates the exact amount that gets charged, not a coincidentally-equal
env figure. External-seller-ready — single threaded fetch means no gate-vs-sign
divergence even against a nonce-bearing seller.

**Proven end-to-end on the LIVE path (temporary diag-reorder, since retired):**
- State 1 GATE BLOCKS ON ADVERTISED: real maybeBuyData at jobPrice 0.005 blocked on
  the FETCHED advertised 0.001 (log: "BUY (advertised $0.001)" then "budget BLOCKED:
  per-purchase cap: 0.001 > 0.00075"). Control: same fetched 0.001 allowed at
  jobPrice 0.20 — proves the gate reads the fetched number, not a stale env figure.
- State 2 SINGLE-FETCH HAPPY PATH: challengeFetchedOnce + threadedIntoPayX402 (one
  402 total), executed:true, settleReceipt (batch c76cf6ef-…), balance 4.994 → 4.993
  (−0.001). Reorder did not break settlement.
- State 3 FETCH-FAILURE DEGRADES: bad seller URL → [] → clean Exa-only, no throw.
- State 4 INVALID-PRICE DEGRADES: malformed maxAmountRequired "not-a-number" → the
  Number.isFinite guard → [] → clean Exa-only, no throw.

**Note:** the reorder was deployed live to prod BEFORE commit (required to prove
end-to-end on prod); this commit makes git match the running prod code.

**Dead code:** dataPurchaseUsdc() / DATA_PURCHASE_USDC no longer feed the gate.
Left in place. Optional follow-up (not done): repurpose as an absolute secondary
ceiling — gate on min(advertised, DATA_PURCHASE_USDC) — so an external seller can't
advertise an arbitrarily high price that still fits under the percentage allowance.

**Now genuinely open — external seller:** the mismatch is closed and the path is
external-ready, but no actual external (non-self-loop) Arc seller has been paid yet.
That's the next real brick: point DATA_SELLER_URL at a seller we don't control and
prove a cross-party settle.

## 2026-07-06 (pm) — x402 buyer hardened for multi-chain sellers + absolute per-buy ceiling; QuickNode settle BLOCKED at account layer

**Buyer improvements (_x402.mjs) — proven against self-loop AND real external-seller PARSING:**
- **Entry-selection (FIX 1):** fetchX402Requirements no longer assumes accepts[0]; it SELECTS the
  entry matching our chain + scheme (network eip155:5042002 AND extra.name GatewayWalletBatched),
  first match wins; no match → ok:false → graceful degrade. A multi-chain seller (QuickNode
  advertises a 21-entry menu; Arc is index 16, accepts[0] is Base Sepolia) now parses correctly.
- **Price fallback (FIX 2):** read maxAmountRequired ?? amount (v1 vs v2 sellers). QuickNode has no
  maxAmountRequired; its `amount:"100"` (0.0001 USDC) is now read. Same fallback feeds BOTH the
  gate (maybeBuyData advertisedUsdc) AND the signed atomic → gate-price == signed-price.
- **Resource-binding + five-key envelope:** fetchX402Requirements now threads the challenge's
  TOP-LEVEL `resource` and `extensions` (it previously dropped both). wirePayload is the full
  { x402Version, payload, resource, accepted, extensions } — resource/accepted ALWAYS, extensions
  when the challenge carried them. Byte-diffed against @quicknode/x402's own captured payment
  (their client uses the same @circle-fin BatchEvmScheme via @x402/core createPaymentPayload):
  OUR payload is now byte-identical to theirs for the Arc nanopayment challenge (payload.authorization,
  signature, all three extensions [sign-in-with-x, bazaar, quicknode-session], resource, accepted).
  Self-loop unchanged (no extensions → four-key envelope, byte-identical to before).
- Reworded the price-guard block message (maxAmountRequired/amount).

Proven (local parse-only, no deploy/money): QuickNode Arc entry selected (idx 16 of 21), priced
0.0001 via amount-fallback, passed ceiling + canSpend; self-loop still parses; no-match degrades.

**Absolute per-buy ceiling (_research.mjs) — proven binds:** dataBuyCeilingUsdc() (repurposed dead
dataPurchaseUsdc), default 0.01, fail-safe (unset/garbled/<=0 → 0.01, never disables). In maybeBuyData
BEFORE canSpend; refuses advertised > ceiling with recordBlocked (audit parity), returns [] → Exa-only,
fires before signing. Proven end-to-end (real maybeBuyData, in-memory store, DELEGATE unset):
over-ceiling 0.02 refused ("absolute ceiling: 0.02 > 0.01"); UNSET still 0.01 and still refused
(fail-safe); QuickNode 0.0001 and self-loop 0.001 pass under. QuickNode 0.0001 << 0.01 so unaffected.

**QuickNode finding — nanopayment via a hand-rolled buyer is BLOCKED at the account/session layer:**
- Captured a QuickNode-accepted payment from @quicknode/x402 (throwaway key) and byte-diffed vs ours
  for the SAME Arc 402. After the fixes above, our payload is byte-identical to their client's.
- Their live verifier still rejects ours with "Unexpected error verifying payment", while their own
  client's payment (same shape) is accepted (a broke fresh key only failed on `insufficient_balance`
  — a funds check, i.e. the shape parsed fine). So the rejection is NOT in the x402 payload — it's
  QuickNode's account/session context around the request (extensions carry sign-in-with-x + a
  quicknode-session descriptor; nanopayment skips the SIWX/JWT sign path, but the server still binds
  the request to account/session state our raw buyer doesn't establish).
- CONCLUSION: paying QuickNode requires their SDK (@quicknode/x402), not our raw buyer. Not fixable
  in-payload. For a general external cross-party settle, use a seller running the SAME @circle-fin
  x402-batching middleware as our own seller (Option B) — it accepts our payload as-is.

**Still OPEN — an actual external cross-party SETTLE (not just parse).** QuickNode proved PARSING
end-to-end (select/price/gate/sign the real challenge) but not a settle. Next brick: Option B — a
non-self-loop seller on the same @circle-fin batching middleware, to prove a real cross-party settle.

Diagnostics diag-qn-settle / diag-parse / diag-reorder / diag-caps-block / diag-guard / diag-x402-buy
all retired (404). Buyer improvements deployed live to prod before this commit (needed for the live
QuickNode tests); this commit makes git match prod.


## 2026-07-07 — CORRECTION to the QuickNode finding: cause is the MISSING REQUEST BODY, not the account layer

The prior entry (2026-07-06 pm) concluded QuickNode's rejection was "at the account/session
layer, outside the payload." That was WRONG. Ground-truth probes found the real cause:

- **Signature is valid (suspect refuted):** captured our real Circle-signed payment for the Arc
  challenge and ecrecovered it against the exact EIP-712 TransferWithAuthorization digest
  (domain GatewayWalletBatched/1/5042002/GatewayWallet). It recovers to the delegate
  (0x6Db3…B380), 65 bytes, v=27 — a standard, viem-equivalent signature. Not the problem.
- **Missing request body (the actual difference):** QuickNode is a JSON-RPC PROXY — its client
  sends the paid request WITH the RPC body it's paying for (eth_blockNumber), on both the
  challenge fetch and the paid retry. Our payX402 (built for x402-quote, which serves a fixed
  resource needing no input) sent the payment header with NO body. Captured both empirically:
  @quicknode paid retry hasBody:true; ours hasBody:false. A payment with no request is
  nonsensical to an RPC proxy → "Unexpected error verifying payment."

**Fix implemented (_x402.mjs):** optional `requestBody` threaded through fetchX402Requirements
(challenge fetch) AND payX402 (settle) via a bodyInit() helper — forwarded on BOTH phases for
RPC-proxy sellers, omitted for our self-loop (unchanged, bodyless). Proven locally: with
requestBody the QuickNode challenge+settle both carry the eth_blockNumber body; self-loop
unaffected.

**Causation CONFIRMED by a live settle:** with the body-forwarding fix, payX402 settled the real
QuickNode Arc nanopayment — executed:true, settleReceipt.success:true (batch
21fb2402-c524-40c9-a849-8ad7c7007d04, eip155:5042002), QuickNode SERVED the RPC
(sellerBody.result 0x3033b90 = a real eth_blockNumber), and the payer's Gateway balance moved
4.993 → 4.9929 (−0.0001) cross-party to QuickNode's payTo 0xF463…623C. The missing request body
WAS the cause; the earlier "account/session layer" conclusion is fully retracted.

**Status: FIRST external cross-party x402 settle — DONE.** QuickNode nanopayment works via our
hand-rolled buyer (forward the paid request's body). The "still OPEN — actual external
cross-party settle" item from the prior entry is now CLOSED. Buyer is proven end-to-end against a
real, non-self-loop seller: select → price → gate → sign → pay+forward → verified/settled/served.

## 2026-07-07 — External-seller research-buy path completed end-to-end (pay → account → consume)

Built on the QuickNode live settle (logged in the correction entry above — batch 21fb2402…, the
first real cross-party x402 payment, cause = missing request body). This session generalized the
AUTONOMOUS research-buy path so it can pay, account for, and consume a real external / request-bound
data seller — not just the in-repo x402-quote stand-in. Four commits (6394bcc..37268c4):

- **6394bcc — payX402 forwards the request body.** bodyInit() + optional `requestBody` threaded
  through fetchX402Requirements (challenge fetch) AND payX402 (settle). RPC-proxy sellers (QuickNode)
  bind the payment to the request being paid for; a bodyless payment fails their verify. Proven by
  the live QuickNode Arc nanopayment settle (executed:true, served eth_blockNumber 0x3033b90, payer
  4.993→4.9929). Self-loop unchanged (no body). Corrected the earlier wrong "account/session layer"
  conclusion — ground-truth probes showed our Circle signature is valid (ecrecovers to delegate,
  v=27) and the lone asymmetry was the missing body.

- **62ded10 — maybeBuyData sources DATA_SELLER_BODY** and threads it into both the challenge fetch
  and the settle, so an autonomous research buy can target a request-bound seller. Unset → bodyless
  (stand-in unchanged). Documented in .env.example.

- **55b570f — seller-shape-aware response→facts mapping.** extractFacts(sellerBody, sellerUrl) maps a
  paid response into { claim, source } via DATA_SELLER_FACTS_PATH (dot-path; default "dataset.facts"
  keeps the stand-in unchanged): array of {claim,source} used as-is; array of other shapes
  stringified; scalar/object → one labeled fact. Exported + unit-tested (6 shapes). Lets a real
  seller's response feed the brief.

- **37268c4 — record spend on ANY confirmed settle.** Reordered maybeBuyData: settle-check →
  recordSpend → facts-extraction. recordSpend now fires as soon as executed:true (before facts), so a
  misconfigured DATA_SELLER_FACTS_PATH (settled but no usable facts) can't hide a real on-chain debit
  from the day-ceiling ledger. Invariant restored: money moved ⟺ spend recorded. !executed still
  records nothing. Graceful Exa-only degradation preserved (no facts → brief proceeds without them).

**Net:** the buyer + research engine now handle a real non-self-loop seller end-to-end —
select (multi-chain menu) → price (maxAmountRequired ?? amount) → gate (percentage caps + absolute
per-buy ceiling) → sign (Circle EOA) → pay+forward request → verify/settle/serve → always account →
map response → feed the brief. To wire a specific external seller, set DATA_SELLER_URL +
DATA_SELLER_BODY + DATA_SELLER_FACTS_PATH.

**Open:** no real external DATA seller wired in prod yet (QuickNode proved the mechanics with an RPC
call, not research data); DATA_SELLER_URL still defaults to the x402-quote stand-in. Next: point it
at an actual paid data API and confirm a live research brief consumes its facts.

**Method notes (this session):** all money-path changes proven no-money/no-deploy first (local
captures, ecrecover, in-memory ledger, unit tests) before any prod deploy; the one real settle (the
QuickNode 0.0001) confirmed the fix end-to-end. Diagnostics (diag-qn-settle etc.) all retired (404);
scratchpad/qn-probe sandbox deleted.

## 2026-07-07 — DATA_SELLER_URL wired to QuickNode (prod) — first real external data seller live

Recon for a real research-DATA seller first (Circle x402 marketplace + public x402 bazaar):
NONE found that our buyer can pay. Our buyer's guard requires scheme "exact" + extra.name
"GatewayWalletBatched" + the Gateway Wallet verifyingContract on Arc (eip155:5042002). Circle's
own docs confirm nanopayments = the "exact" scheme signed against the GatewayWalletBatched domain.
The mainstream x402 sellers (Coinbase Bazaar: weather/prices/news) use standard exact-onchain
EIP-3009 against the USDC token on BASE — our Arc/Gateway-batched buyer REJECTS them (wrong network,
not a Gateway-batched option). The only live sellers on our exact scheme+chain are QuickNode
(blockchain RPC data) + our own x402-quote stand-in + reference samples. So there is no drop-in
general research-data seller today.

Per user decision, wired the one proven-payable real seller: **QuickNode** (accepting it serves
on-chain RPC data, not general research facts). Prod env (production context) + redeploy:
- DATA_SELLER_URL        = https://x402.quicknode.com/arc-testnet
- DATA_SELLER_BODY       = {"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}
- DATA_SELLER_FACTS_PATH = result

**Proven end-to-end locally (no money — settle stubbed):** research() with those env bought from
QuickNode → extractFacts(path=result) → the fact { "result = 0x3033bcd", url: quicknode } merged into
the brief → model answered "current Arc Testnet block height is 0x3033bcd (50,545,613)" → spend
recorded (0.0001). Config-only change: repo unchanged (the three vars were already documented in
.env.example); deploy 6a4c4c0f live, job-quote 200 / x402-quote 402 / my-wallet 401.

**Now live:** prod research jobs autonomously buy from QuickNode when decidePurchase judges a live
figure is needed — ~0.0001 USDC/qualifying buy, bounded by the 0.01 absolute ceiling + per-tx cap +
60/day per-user ceiling; recordSpend fires on any confirmed settle.

**Caveats / open:**
- SEMANTIC FIT: QuickNode's "fact" is an Arc block number — meaningful only for on-chain questions;
  for general research decidePurchase should SKIP, so most jobs won't buy. This proves a real
  external autonomous buy end-to-end; it is NOT a general research-data source.
- Local .env left unset → local research still uses the x402-quote stand-in (no local spend).
- The first REAL on-chain settle inside a prod job hasn't happened yet (user-triggered; not forced).
- STILL OPEN: a general research-data seller our buyer can pay. Options if pursued: (1) run our own
  seller that proxies a real data API/LLM behind the Gateway-nanopayment middleware on Arc; (2) add
  the vanilla exact-onchain buy path (already built/proven) to maybeBuyData to reach Base bazaar
  sellers (needs a Base USDC balance + a 2nd buy path).

## 2026-07-07 — RETRACTION + PROOF: autonomous QuickNode settle works end-to-end (supersedes 45d9dff conclusion)

**RETRACTION.** The 45d9dff entry concluded QuickNode's rejection was an "account/session layer
block, outside the payload — nanopayment via hand-rolled buyer is BLOCKED; use @quicknode/x402;
for a general cross-party settle use Option B." That conclusion was WRONG. Root cause was mundane
and in-payload: the **missing JSON-RPC request body**. QuickNode's endpoint is a JSON-RPC PROXY —
the paid request must carry the call it is paying for (eth_blockNumber). Our buyer, built for a
seller that serves a fixed resource (x402-quote), sent the payment header with no body, so
QuickNode's verify errored. Ground-truth probes proved our signature was valid (ecrecovers to the
delegate, v=27) and the body was the lone asymmetry vs @quicknode/x402's own client.

**PROVEN on prod — the FULL autonomous path, not a forced/direct diag.** A genuine decidePurchase
decision → maybeBuyData → payX402 → live QuickNode settle:
- decidePurchase (real Claude call, no forceDecision) decided BUY for "current Arc Testnet block
  height right now" (Exa can't supply a live block number).
- Settle: batch **ba918c90-0fd6-47ef-bb8a-18cb2dca1ec9**, network eip155:5042002.
- Money moved: delegate Gateway balance **4.9929 → 4.9928** (−0.0001), confirmed via the Circle
  Gateway API INDEPENDENT of our diag.
- The real figure flowed into the brief: Arc block **0x303d4ed**.
This is the FIRST real autonomous cross-party x402 settle against an independent external seller
(closes the "only proven with a stubbed settle" seam flagged during reconciliation).

**Live wiring (prod).** DATA_SELLER_URL=https://x402.quicknode.com/arc-testnet,
DATA_SELLER_BODY={"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]},
DATA_SELLER_FACTS_PATH=result. Every autonomous buy is bounded by the 0.01 absolute per-buy ceiling
+ per-tx cap + the per-user daily ceiling, and degrades to Exa-only on any failure; recordSpend
fires on any confirmed settle.

**Semantic caveat (honest).** QuickNode's "fact" is an Arc block number — genuinely useful only for
on-chain/crypto questions. decidePurchase SKIPS it for general research (no live on-chain figure
needed), so most real jobs will NOT buy. A general research-DATA seller our buyer can pay is STILL
OPEN (no third-party sells research data on our GatewayWalletBatched-on-Arc scheme; options remain:
run our own real-data seller on the Gateway-nanopayment middleware, or add the vanilla exact-onchain
buy path to reach Base bazaar sellers).

Diagnostic diag-realbuy retired (404) after this proof.

## 2026-07-07 — UI: "Nanopayments" explainer window (copy-only, no money moves)

**What.** A new user-facing explainer that tells people what a nanopayment is and walks through how
the agent uses one mid-research. Pure UI/copy — no wallet prop, no network calls, moves no money,
no CSS changes. Read-only audit first, then built to the audit.

**Placement (decided with user).** Reached at `#/nanopay` via a **4th "Nanopayments →" quick-card**
in the Dashboard "Do something" row — deliberately NOT a nav item. The 5-item nav (Dashboard /
Wallet / AI Agent / Research / Send) stays reserved for working tools; the hash router
(`App.tsx` parseHash + switch) renders the route from a `case "nanopay"` with no NAV entry, which it
supports because parseHash never validates against NAV. The 4th card wraps to a second row in the
`repeat(3,1fr)` grid and sits alone on the left — confirmed intentional, no CSS tweak (collapses to
one column on mobile like the rest).

**Visual (matches shipped design — amber-on-ink).** Reuses existing classes only: `.plane` shell +
serif `h2` + `.sub`; amber `.panel-eyebrow`; and the **previously-unused `.process` 4-step strip**
(`styles.css:197-223`) as the how-it-works sequence (its intended purpose); an inset `--field`-bg
callout for the "$0.01 max" line. NOTE: there is NO purple/teal gradient in this app — the signature
is warm ink + a single amber-gold seal; a gradient impression from earlier was foreign to the CSS
and was not built to.

**Copy = the real flow.** The 4 steps condense the actual autonomous purchase path in
`netlify/functions/_research.mjs`: 01 decide a live figure is needed (decidePurchase SKIPs if free
web sources suffice) → 02 read the seller's advertised price, refuse above the 0.01 ceiling / budget
→ 03 sign the on-chain USDC nanopayment (only a confirmed settle counts) → 04 fold the purchased
fact into the brief with its source. This doubles as the spec for a future LIVE version of the
window (server already logs the price/gate/settle signals it would surface).

**Naming.** Feature name is plural "Nanopayments" in the card title + eyebrow; singular common-noun
usage left as-is where it means one payment ("Pay the nanopayment", "Each buy… every purchase").
Component file kept `NanopaymentPanel.tsx` (internal, not worth the churn).

**Files.** New `src/components/NanopaymentPanel.tsx`; `src/App.tsx` (import + route case);
`src/components/Dashboard.tsx` (4th card). Verified: `tsc --noEmit` clean, `vite build` clean, local
`vite preview` eyeballed by user before ship.

**Shipped.** Committed `0e9176d` on main, pushed to origin. Deployed to prod via Netlify CLI
(deploy `6a4cdf71…`, "Deploy is live!"); prod `index.html` confirmed serving the new build hash
`index-C1dH3bdq.js` (real-deploy check, not just a 200 on the hash route). Live at
app.tikpema.xyz/#/nanopay.

## 2026-07-09 — UI: Unified Balance PAGE (read-only) — nav-less #/unified, funding deferred

**What shipped.** A first-class page for the agent's Unified Balance, reached nav-less at `#/unified`
from the "Agent unified balance" card on the Dashboard — same pattern as `#/nanopay` and `#/bridge`,
so the 5-item nav stays reserved for working tools. The page shows the cross-chain unified total, the
per-chain breakdown (Arc Testnet + Base Sepolia, each degrading to "unavailable" independently), and
the agent wallet address that the balance is keyed to, rendered via `AddressDisplay`
(masked `0x4c6d…f320` → click-to-expand → copy). Owner address ONLY: the delegate signer stays
server-side and is never surfaced.

**No money-path change.** The panel is prop-less, holds no signer, and its only network call is a
`POST /api/gateway-balance` — the existing public agent-wallet-keyed read (no secrets, no kit, no
adapter, `Promise.allSettled` per domain). Funding the unified balance (`depositFor`, a money-path
write) is a **DISABLED "Fund — coming soon" placeholder** that reserves the layout slot and nothing
else: hardcoded `disabled`, no `onClick`, no handler behind it. Wiring it is the next brick and is
deferred — it inherits the SCA-auth risk already logged against the UB SPEND half.

**Files.** New `src/components/UnifiedBalancePanel.tsx`; `src/App.tsx` (import + `case "unified"`);
`src/components/Dashboard.tsx` ("View unified balance →" `linkbtn`, mirroring "Manage wallet");
`deno.lock` (re-synced to the `package.json` deps that landed in an earlier commit — app-kit,
adapter-circle-wallets, x402-batching, @x402/evm, webauthn-p256). `.gitignore` now covers the stray
`scratchpad-netlifydev.log`. The UB proof helper scripts under `scripts/` stay untracked as before.

**Verified.** `tsc --noEmit` clean (exit 0); `vite build` clean (exit 0), only the pre-existing
744 kB chunk-size warning. Read-only by construction — nothing to prove on-chain.

## 2026-07-09 — Unified Balance FUNDING shipped + PROVEN (deposit(), direct-contract path)

The write half of the UB page: the **Fund** control replaces the "coming soon" placeholder.
The agent SCA funds its **OWN** unified balance from its own plain Arc USDC — self-custody,
nothing is sent to a third party. Depositor == credited account, which is exactly why this is
`deposit(address,uint256)` and **not** `depositFor` (that one credits a *different* account).

**Why direct-contract, not App Kit.** `kit.unifiedBalance.deposit()` routes to the provider's
`depositWithApprove()` = approve → deposit with an `adapter.waitForTransaction` after EACH. On a
Circle dev-controlled SCA that waiter hits the async-hash race and throws code 1098 — the same
failure that kills `kit.bridge()`. Worse, the SDK's approve step sits OUTSIDE its own try/catch,
so its `revokeAllowanceBestEffort` is **unreachable** when approve throws: it strands a live
allowance. Also: `DepositForParams` is `Omit<DepositParams,'allowanceStrategy'>` and the provider
hardcodes `'approve'` (`provider-gateway-v1/index.mjs:11653`) — no escape hatch. So we reuse the
proven swap/bridge fix: two `createContractExecutionTransaction` calls polled by Circle tx id
(`waitForTx`), which return the REAL hash and cannot hit 1098.

**Cap.** `AGENT_UB_DEPOSIT_CAP_USDC=25` — **set in the Netlify production context and OBSERVED**
(the server echoed `cap:25`), not merely a code default. Fail-closed parse (unset→25, "0"→frozen,
non-numeric→throws). Enforced in the wrapper (`agent-ub-deposit.mjs`) at the top,
**reject-before-executor**: `_ubdeposit.mjs` is UNCAPPED, so an unguarded path would bypass it
(the swap-cap trap). Reject-not-clamp — an over-cap request returns 400 and nothing signs. No
FLOOR: a deposit pays no flat forwarder fee, unlike the cross-chain spend.

**Non-atomic safety (approve + deposit is two txs).** We own the cleanup rather than trusting the
SDK: (1) read the CURRENT allowance first — skip a redundant approve entirely; (2) approve the
**EXACT** amount, never infinite and never `increaseAllowance` (which is what lets a retry stack);
(3) on deposit failure, actively `approve(gateway, 0)` to revoke. A failed revoke is NOT swallowed
— it throws with `allowanceDangling: true`, surfaced as a distinct field on the 500, because an
operator must know residue is on-chain. The revoke only fires when THIS call granted the allowance
(`if (approveTxHash)`), so it can't clobber pre-existing state it didn't create.

⚠️ **The revoke / deposit-failure branch is UNEXERCISED.** Only the happy path is proven. The
allowance ending at 0 below is *self-consumption* (deposit spent exactly the approved amount) —
NOT evidence the revoke works. Proving it needs deliberate fault injection.

**PROVEN ON PROD (both, zero-money then real money):**
- **Guard, zero-movement:** authenticated over-cap POST `{amountUsdc: 25.01}` → **400**
  `{"error":"exceeds per-deposit limit of 25 USDC","cap":25}`. Balance + allowance unchanged.
  Also unauth → 401 (route was 404 pre-deploy, so the 401 is genuinely new code).
- **Real 11 USDC deposit, verified THREE ways:** plain USDC **43.75 → 32.75** (−11); unified Arc
  **0.469876 → 11.469876** (+11); allowance **0 → 0** (clean, self-consumed not revoked).
  tx `0x1e587f17b283072a5c8a33e17d6d7f08e3ec325ad3fbfbbbde6dfec9bfa1ece7` (block 50956038) —
  the only SCA→GatewayWallet transfer in the scanned range, value exactly 11.000000.
  https://testnet.arcscan.app/tx/0x1e587f17b283072a5c8a33e17d6d7f08e3ec325ad3fbfbbbde6dfec9bfa1ece7

**Auth note (supersedes the 34e1d2a deferral).** Prod's `SESSION_SECRET` ≠ local `.env` (confirmed
by hashing both: local `5f0d64e0…`, prod `96939992…`), so a locally-minted token gets 401 from prod.
Reading the **prod** secret from the Netlify env and minting with that yields a prod-trusted token,
which is how the authenticated over-cap probe ran. The secret is passed in-process only — never
printed, never written to disk. This unblocks authenticated prod probes generally.

**UNBLOCKS:** unified Arc balance is now **11.469876**, above the UB-spend floor of 10 → the
in-range **≥10 authenticated spend** proof (the both-sides half deferred in `34e1d2a`) is runnable.

**Files.** New `netlify/functions/_ubdeposit.mjs` (uncapped executor: allowance-check → exact
approve → deposit → revoke-on-fail), `netlify/functions/agent-ub-deposit.mjs` (auth + cap wrapper);
`_arc.mjs` (`ubDepositCapUsdc`), `netlify.toml` (redirect), `UnifiedBalancePanel.tsx` (real Fund
control; now takes the `wallet` prop for the session token), `App.tsx` (passes it). Proof helpers
stay untracked: `recon-ub-fund.mjs`, `verify-ub-deposit-guards.mjs` (10/10 guards, zero txs),
`probe-ub-deposit-prod.mjs`. `tsc --noEmit` clean; `vite build` clean. Deploy `6a4fc4abd186…`,
bundle `index-CaCwTiui.js`.

## 2026-07-09 — UB in-range SPEND proven END-TO-END via the authenticated HTTP path (last UB item)

Closes the two things `34e1d2a` deferred: the **full HTTP path** (endpoint → session auth → floor/cap
→ `ubSpend`) and an **in-range (≥ floor)** spend. Both now exercised against prod with real money.

**The spend.** 10.000000 USDC, Arc Testnet → Base Sepolia, recipient = the agent's OWN Base address
(`0xc54d…e621`), so the funds stay under agent control — a relocation, not a payment.
`HTTP 200 {executed:true, state:"completed"}` — no 1098 async-waiter quirk this run.
- transferId `4b44526a-2da7-4a35-896c-501215b9345c`
- mint tx `0xf9ac9ae42b87f6e52548f5ea2963d0738cbb76294dca0ad83fec7ea5108ec49b`
  (Base Sepolia block 43925118, receipt `status 0x1`)
  https://sepolia.basescan.org/tx/0xf9ac9ae42b87f6e52548f5ea2963d0738cbb76294dca0ad83fec7ea5108ec49b

**Both sides, verified INDEPENDENTLY of the runner** (direct Circle Gateway API for Arc; two separate
Base Sepolia RPCs — `sepolia.base.org` and `publicnode.com` — agreeing for Base):
- Arc unified  **11.469876 → 1.264610**  (−10.205266)
- Base native USDC (agent) **0 → 10.000000**  (+10)
- Base *unified* stays 0 — the Forwarding Service mints NATIVE USDC, not a Gateway deposit. Reading
  the unified balance on the destination would show nothing; you must read `balanceOf`.

**FEE FINDING RESOLVED — flat, and cheaper than assumed.** Implied fee = **0.205266 USDC**, versus
`0.205619` on the old 0.1 spend. A 100× change in amount moved the fee by 0.0004 → the cross-chain
forwarder fee is **FLAT**, confirmed at scale. That is **2.05% at 10 USDC** (not the ~3% guessed).
The floor-10 rule is validated by measurement; on this evidence the floor could safely come DOWN.
NOTE: the earlier "~0.30 flat fee" figure was a MISREAD — `0.305624` was the TOTAL cost of the 0.1
spend (0.1 amount + 0.205619 fee), not the fee. Corrected here.

**Guards observed live on prod (all zero-movement, all before signing):**
- unauth POST → **401**
- below-floor `0.1` → **400** `below minimum spend of 10 USDC`
- over-cap `55` → **400** `exceeds per-spend limit of 50 USDC` (server echoed `cap:50` — deployed
  value observed, not inferred). Reject-not-clamp: a clamping impl would have silently spent 50.

**Auth (supersedes the 34e1d2a deferral).** Prod `SESSION_SECRET` ≠ local `.env`. Minting with the
value read from the Netlify production context yields a prod-trusted token. TRAP: `netlify env:get`
emits a trailing blank line, so `| tail -1` alone yields `""` → an exported empty `SESSION_SECRET`
BEATS `--env-file` (exported vars win) → the runner dies at `die(3)` with no capture and no HTTP
call. Always `| grep -vE '^\s*$' | tail -1`. Three runs were lost to this before it was spotted.

**Runner hardened** (`scripts/fire-ub-spend.mjs`, untracked): the durable capture is now written
IMMEDIATELY after the fire (was: only after the poll loop, so a timeout destroyed the very evidence
it existed to preserve), and a non-200 short-circuits the poll loop entirely — a rejected request
triggers no burn and no mint, so polling for one only buried the real response. A 400 now returns in
~5s instead of hanging for the full 2-minute poll deadline.

**UB capability COMPLETE:** VIEW (read) + FUNDING (deposit) + SPEND (cross-chain write), each capped,
auth-gated, and proven on-chain. Remaining unexercised: the deposit revoke/failure branch (happy path
only — see `1afc101`). Arc unified now 1.264610, below the floor, so a further spend correctly cannot
run until refunded.

## 2026-07-10 — RECEIPT TRUST BOUNDARY proven (the load-bearing piece of the proposal loop)

Brick 1 of the research→propose→approve→execute loop, built **receipt-first**: before any
proposal layer exists, prove the record it produces cannot be faked. Get this wrong and the
loop emits FALSE on-chain history inside a trust artifact — worse than a broken loop.

**The invariant.** Every field of the receipt is SERVER-SOURCED. No client-asserted value can
enter it, by construction:
- `job-bridge-approve.mjs` reads exactly ONE field from the request body: `runId`. Destination
  and amount come from the proposal **the server itself wrote**; the fee is re-priced LIVE
  inside `executeAction`; `approvedBy` is `session.address`. This is STRONGER than the
  bridge template (`agent-bridge.mjs` must re-accept `{amountUsdc, destination}` because
  `agent-act` is stateless) — here the client cannot choose *what* is bridged, only *whether*.
- `burnHash` comes from `executeAction`'s own return (`_actions.mjs:191-201` ← `_bridge.mjs:192`
  `await waitForTx(...)`, a CONFIRMED hash, not the racy App Kit waiter).
- `mintTxHash` is written only after **DOUBLE verification**: IRIS reports the forward
  CONFIRMED/COMPLETE *and* `_receipt.mjs` independently READS the destination chain and finds
  that exact tx — right chainId, `status 0x1`, and a USDC Transfer to our recipient.
- The USDC contract is **pinned per chain** (doubly sourced: Circle's canonical testnet list
  AND cross-checked on-chain 2026-07-10 — `eth_chainId` matches, code non-empty,
  `symbol()=="USDC"`, `decimals()==6`, 8/8). So the record asserts *a USDC transfer*, not
  merely *a token transfer*.
- IRIS says minted but the chain disagrees → **`mint_unverified`**, a LOUD human-review state,
  NEVER auto-retried into `minted`. The claimed hash is stored as `irisClaimedMintTxHash` so no
  reader can mistake a claim for a fact.
- `receipt` is a SIBLING of `canonicalReport`, never inside it — mutating those bytes would
  break the re-hash determinism proof (`job-evaluate-background.mjs:214`) and the on-chain
  `deliverableHash`. Two anchors (research hash on-chain; action anchored by its own tx
  hashes), linked off-chain. Single-hash binding = future hardening.

**PROVEN ADVERSARIALLY (all reads, zero money)** — `scripts/verify-receipt-adversarial.mjs`, 5/5.
A CONTROL (the real UB-spend mint) verifies, so the verifier is not vacuously false. Then:
bogus hash → `receipt_not_found` (keep polling); real hash on the WRONG chain →
`receipt_not_found`; REVERTED tx (`status 0x0`) → `tx_reverted` → **mint_unverified**; real
successful tx with the WRONG recipient → `no_usdc_transfer_to_recipient` → **mint_unverified**.
**No attack produced `minted`.**

**PROVEN DRY (write path, stubbed executeAction)** — `scripts/verify-approve-writepath.mjs`, 28/28.
Every call made with a HOSTILE body (`burnHash`, `amountUsdc:999999`, `destination:"ethereum"`,
`state:"minted"`): all ignored. Optimistic lock is in place BEFORE `executeAction` runs; a second
approve → 409 with no second bridge; a guard block RELEASES the lock and writes NO receipt; an
unexpected throw likewise; `TxPendingError` → `burn_pending` with **no burnHash**; all five
preconditions (ownership / status / proposal / cap / destination) refuse before any execution.
*(A test bug found here: seeding `proposal: undefined` re-triggers the JS destructuring default
and silently supplies a VALID proposal — a test that seeds `undefined` to mean "absent" lies.)*

**PROVEN WET (real money)** — 1 USDC bridged Arc → Base Sepolia, recipient = the source wallet:
- burn `0x093cad2a1c5b12532fcf0989b69ab85109042532255b644a4167f18c87e52de0` (Arc block 51075478)
- mint `0x7b876a98c6a28a3f71488ee7d64534a2009c58ffdbc961ddcfa400c73eca12d9` (Base block 43953706)
  https://sepolia.basescan.org/tx/0x7b876a98c6a28a3f71488ee7d64534a2009c58ffdbc961ddcfa400c73eca12d9
- Arc **31.940000 → 30.940000** (−1.000000); Base **10.000000 → 10.796935** (+0.796935)
- fee **0.203065** — the fee is taken OUT OF the amount (so 1 USDC costs 1, and 0.797 arrives;
  it does NOT cost 1.2). Consistent with the ~0.2055 FLAT forwarder fee measured on the UB spend.
- Mint independently confirmed by TWO Base RPCs (`sepolia.base.org`, `publicnode.com`): both
  `status 0x1`, block 43953706, USDC→SCA 0.796935. Approve 09:28:03 → minted 09:28:32 (29s).
- The hostile body was ignored end-to-end; `canonicalReport` byte-identical throughout.

**HONEST — UNEXERCISED (recorded, not buried):**
- **Durable Netlify Blobs persistence** — the wet proof used an IN-MEMORY store.
- **Prod day-ledger** — stubbed, so the proof did not consume the real ceiling.
- **`burn_pending` → `burn_confirmed`** against a real Circle `txId` — the burn confirmed too
  fast to trigger `TxPendingError`. Only the dry test covers it.
- **Double-approve race under eventual consistency (~11s)** — the optimistic lock NARROWS the
  window, it does not close it (the lock write has the same lag). Damage is BOUNDED to one extra
  capped bridge by the per-bridge cap (`_actions.mjs:89-94`) + day-ceiling. Real fix = a
  strongly-consistent idempotency key: DEFERRED. UI should disable the button on click.
- Also noted: `agent-bridge-status.mjs:18` takes a `burnHash` from a client body. NOT a receipt
  leak (it holds no store, writes nothing), but if a write is ever added there the trust
  boundary breaks silently.
Known limits (a) and (b) are recorded IN-CODE at `job-bridge-approve.mjs:39-47`.

**Files.** New `netlify/functions/_receipt.mjs` (pinned chains + double verification, fail-closed),
`job-bridge-approve.mjs` (the trust boundary), `job-bridge-receipt-background.mjs` (internal-only
verifier state machine); `netlify.toml` (approve redirect — the verifier has NO public route);
`job-run-status.mjs` (+`proposal`, +`receipt` projections). Proof scripts stay untracked:
`verify-receipt-adversarial.mjs`, `verify-approve-writepath.mjs`, `fire-bridge-receipt-proof.mjs`.
`tsc --noEmit` clean; `vite build` clean. **NOT DEPLOYED** — backend-only; prod does not yet
serve these functions.

**Next:** steps 1–4 (synthesis emits a validated `proposal`; approve button in `jobTimeline`).
The receipt they will write is now proven unfakeable.

## 2026-07-11 — Proposal loop (Brick 1) COMPLETE + the fixes found proving it live

The research→propose→approve→execute loop shipped end-to-end, with its OWN door (`#/plan`).
The receipt trust boundary (`14ec0d7`) was the load-bearing half; this commit is the other
half plus every bug the live proof surfaced. Proven live on a real 1-USDC plan bridge
(jobId 155442: auto-closed to `minted`, double-verified, no manual touch).

**Proposal generation + server validation.** Synthesis emits an optional `proposal`; the
model PROPOSES, the server VALIDATES and re-derives (`_proposal.mjs`), copying the
sources-overwrite discipline (`_research.mjs:419-422`): destination resolved against OUR
8-chain registry (not the model's string), amount bounded by the deployed cap
(reject-not-clamp), the model's fee DISCARDED and re-priced live from IRIS, fee-floor
enforced. Any failure → null → brief renders with no proposal. Persisted BESIDE
canonicalReport (never inside — the on-chain deliverableHash must not move).

**Own door — `#/plan` (PlanPanel + plan-quote).** Separate from `#/research`, whose
guardrail correctly declines advice. `plan-quote`'s guardrail is EXECUTABILITY, not
"no advice": ACCEPT a concrete action the agent can bound/price/refuse ("bridge 1 USDC to
Base", even "should I bridge?"), DECLINE unbounded opinion ("what's the best chain?").
ProposalCard renders the agent's REASONING prominently above the numbers and the button —
the USER is the reasoning gate, because validateProposal proves ECONOMICAL, never
WELL-REASONED (a reasoning/vetting gate is a slotted future brick).

**Fixes discovered while proving it live (each real, each with its own proof):**
- **Rebuild clobber (jobs #155262/#155315 root cause).** `job-evaluate-background`'s
  persist read `prior` ONCE with `|| {}`; a Blobs miss (~11s lag) made `threaded` the base
  and silently dropped `proposal` AND `txHash`. Fix: retry the read (like the `entry`
  retry), and rebuild the seed from an explicit `SEED_KEYS` whitelist so a wire-supplied
  proposal can NEVER be injected (structural, not incidental). Replay 15/15.
- **Judge inventing criteria (#155217/#155332).** The evaluator refunded correct briefs
  for "doesn't execute" (outside its own rubric) and "sources can't be verified" (it has no
  browsing; sources are guaranteed real upstream). Hardened `EVALUATOR_SYSTEM_PROMPT`:
  (a)/(b) are EXHAUSTIVE, reason must name (a)/(b), NEVER fail for unverifiable/unfamiliar
  sources (judge relevance not existence). Plan-awareness added as `PLAN_FLOW_CLAUSE`
  APPENDED only when a validated proposal exists — research-flow prompt stays BYTE-IDENTICAL
  (regression-proof). Replays: #155332 PASS, off-topic FAIL, research-flow unchanged.
- **Insufficient-balance revert (#155341).** A 10-USDC bridge against a 6.30 wallet reverted
  on-chain (INSUFFICIENT_TOKEN) as a raw 500 + stranded allowance. Added a PRE-FLIGHT
  balance gate in `job-bridge-approve` (before the lock, before any burn): `balanceOf` <
  amount → clean 402 {need, have, walletAddress}. Gate on AMOUNT, no buffer — fee comes out
  of the minted side, gas is SPONSORED (measured: two bridges each dropped the wallet by
  exactly 10.000000). Stub 13/13.
- **Stranded receipt (#155262/#155315) — the verifier never SAW the receipt.** The trigger
  was NOT dropped (prod log: verifier invoked 9s after approve); it read the receipt ONCE,
  lost the Blobs race, 404'd, and exited before the lease. Fix: `loadWithRetry` (bounded,
  15s window). Also hardened the trigger to be AWAITED (was fire-and-forget → Netlify freeze
  could drop it) + a single-flight LEASE (stale-lease reclaim self-heals a dead verifier).
  Verifier is idempotent (reads only; submits no tx). PROVEN LIVE: #155442 auto-closed in
  ~28s (mint attestation), double-verified [iris + destination-rpc], no manual close.
- **Receipt telemetry.** `visibilityLagMs` + `readMarginMs` persisted on the terminal
  receipt (readable via job-deliverable; the console.log does not surface in `netlify logs`).
  Purely additive. Stub-proven to land on the minted receipt; the MEASURED margin off a real
  receipt is not yet captured (telemetry deployed after #155442) — #155442's margin was
  RECONSTRUCTED from timestamps as ~5s lag / ~10s headroom (healthy).

**KNOWN LIMITS (recorded, not buried):**
- **Provisioning stall (platform).** Netlify intermittently ACKs a `*-background` invocation
  without running it — `job-run → job-run-background` drops, run stuck at "starting", no
  fee, no deliverable. Worked for #155345/#155442, dropped for #155457/#155463. Not a code
  bug (the trigger is already awaited).
- **Self-heal is POLL-DRIVEN (incomplete).** `job-run-status` re-fires `job-run-background`
  for a run stalled at "starting" >30s, gated by `reFiredAt` cooldown; `job-run-background`
  has an IDEMPOTENCY GUARD (aborts if the run advanced past "starting" → no double-create).
  Stub 10/10. BUT live it did NOT fire: `job-run-status` had 0 invocations — the browser
  stopped polling, and the self-heal only runs while polled. The ROBUST fix is an autonomous
  scheduled sweep (cron), independent of the browser — DEFERRED.
- **Double-approve / double-create races** under Blobs ~11s consistency: narrowed by
  optimistic locks + guards, bounded to one duplicate capped op, not closed (needs a
  strongly-consistent key). DEFERRED.
- **`#/plan` needs a connected wallet** — "Research this action" is disabled without a
  session; `ensureSession()` on a stale session throws before job-run fires (fix: reconnect
  passkey). Purely client-auth, no code change.

**Files.** New: `_proposal.mjs`, `plan-quote.mjs`, `src/components/PlanPanel.tsx`. Modified:
`job-evaluate-background.mjs` (persist retry + SEED_KEYS + judge hardening + plan clause),
`job-bridge-approve.mjs` (balance gate + awaited trigger + lease-aware), `job-bridge-receipt-
background.mjs` (read-retry + lease + telemetry), `job-run.mjs` (store question),
`job-run-background.mjs` (idempotency guard), `job-run-status.mjs` (self-heal + proposal/
receipt projections), `App.tsx`/`Dashboard.tsx`/`ResearchPanel.tsx`/`jobTimeline.tsx` (Plan
route, card, ProposalCard/ReceiptCard, poll-past-terminal). Proof scripts stay untracked.
tsc + build clean; working tree == deployed prod bundle `index-BZ3W6xVf.js`.

## 2026-07-11 — Autonomous provisioning-stall sweep (job-sweep) — recovery PROVEN live

Follow-on to Brick 1 (`2ff9cc0`). Fixes the PROVISIONING stall (distinct from the receipt
stranding, which loadWithRetry fixed): Netlify intermittently ACKs a `*-background`
invocation without running it, so `job-run → job-run-background` drops and a run sticks at
"starting" — no on-chain job, no fee, no deliverable (this was the "phantom jobId" chase:
155448/155451/155457/155463). The poll-driven self-heal in job-run-status only fires WHILE
the browser polls; live it never fired (job-run-status had 0 invocations). This is the
AUTONOMOUS recovery, browser-independent.

**`job-sweep.mjs`** — scheduled every minute. Lists `run:*`, re-fires runs at status
"starting" (no jobId, question+wallet present, aged > 45s, not re-fired within 60s). Safety
= the poll-driven discipline: re-fire ONLY from "starting" (job-run-background never began →
nothing created); job-run-background's idempotency guard aborts any invocation that finds
the run advanced (no double-create); `reFiredAt` cooldown; AGE CAP (> 1h → marked failed,
not nudged forever). Stub 13/13.

**PROVEN LIVE (forced, not waited-for).** `netlify blobs:set` can write the job-runs store,
so we FORCED a stall instead of waiting for a random drop: injected a synthetic "starting"
run (aged 90s, dummy zero-balance wallet). Within one tick the cron did it all itself —
sweep log `listed=70 reFired=1 agedOut=0`, `reFiredAt` stamped, and job-run-background then
RAN (run left "starting" → "failed"; the failure is the deliberately-invalid 0xdead wallet's
Circle-404, NOT the sweep). Full chain proven: stall → autonomous cron → re-fire →
job-run-background executes. Synthetic record deleted after.

**DEPLOY GOTCHA (recorded).** `netlify deploy --dir=dist` does NOT register scheduled
functions from in-code `export const config = { schedule }` — the deploy prints no
"Scheduled functions" section and the cron never fires. The canonical registration is
netlify.toml `[functions."job-sweep"] schedule = "* * * * *"`; that made it fire (first
autonomous invocation 23:52:40). Scheduled-function Blobs access WORKS (manual invoke
listed=68; autonomous listed=70) — the deploy-only unknown is resolved.

Files: new `netlify/functions/job-sweep.mjs`; `netlify.toml` (schedule block). Proof script
`scripts/verify-sweep.mjs` untracked. tsc + build clean.
