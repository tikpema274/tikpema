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

### 🚧 OPEN — an ack box fired where no gate was required (or a plan step vanished)

**UNRESOLVED, deliberately recorded rather than dropped. 2026-08-01, deploy
`6a6dea1ff6e9ccf6b543c031`.** A plan was run with the intent of exercising the acknowledge band.
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

### 🚨 DIAGNOSABILITY GAP — `agent-act` DOES NOT LOG THE PLAN IT PRICED. BUILD THIS FIRST.

The quote is the ONE artifact that answers "what was proposed vs what ran", and it is not kept
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
Money path `verdict D`. Watch on `*/15`. Canary writing deploy-id-bound artifacts. **DD is INERT**
(`DD_PUBLIC_ENABLED` unset in production). Live values come from the build stamp and `git`, not here.

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
| **URL-path split-brain — PRODUCTION** | ⚠️ **INFERRED ONLY.** Same `netlify.toml`, same redirect, so the same result is expected — **NOT measurable until `DD_PUBLIC_ENABLED` is set**, because rung −1 refuses before any identity is computed (measured: `service-not-enabled`, no diagnostic). There is **no window to race.** |
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

* **`WATCH_ALERT_WEBHOOK` must NEVER be `--secret`.** `gate:watch`'s existence check READS the URL to
  perform a live GET; a secret value breaks the gate. Hygiene is fingerprint-not-print.
* **`WATCH_STORE` at deploy-preview is DELIBERATE ISOLATION, not a leftover.** Removing it lets a
  future draft write into production's store.
* **Restore any schedule commented out for a draft proof.** `netlify.toml` is OUTSIDE the build
  stamp's hashed surface, so a forgotten restore yields an **identical tree hash** and is invisible
  to every provenance check. `npm run gate:watch` refuses production while it is commented.
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

1. **The money step** — as above. First thing for a fresh session.
2. **Enabling DD in production** — ⚠️ **PRECONDITION: the moment `DD_PUBLIC_ENABLED` is set, run the
   three-way check BEFORE trusting any served report.** Hit `/api/dd-analyze` and
   `/.netlify/functions/dd-analyze`; `refusal.diagnostic.runningBuild` on each must equal the other
   AND the published **[DEPLOY ID]**. This is the only outstanding inference and enable-time is the
   first moment it is testable. ⚠️ Never `--context all` — that is the switch that arms DD in prod,
   and nothing enforces this variable the way `gate:watch` enforces `WATCH_*`.
3. **Funding Base Sepolia** — 🚨 **PRECONDITION: verify the delegate on Base Sepolia FIRST.** UB
   auto-allocation is ON (both spend sites omit `from.allocations`). `_pay.mjs` is same-chain, a
   permanent no-op; **`_ubspend.mjs` is cross-chain, so the DESTINATION is tier 1** — the first Base
   balance silently flips its source chain, on a DATA condition, with no deploy. `_delegate.mjs`
   grants per-SCA and only Arc has been exercised.
4. `dca-tick` is untested beyond the ledger-failure branch (`npm run test:dca`).
5. The budget counter stores exactly `0.3` after 0.1 + 0.2 — no float accumulation, mechanism unread.
6. DD-standalone scoping comments for `_dd-health.mjs`/`_blobs.mjs`; `pauseStates:116` roster fix.

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
