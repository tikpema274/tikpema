# PRE-REGISTRATION 5 — the first PRODUCTION bridge on the upfront mechanic

**Written 2026-09-04, BEFORE the run.** Committed first so the prediction cannot be edited to match
whatever happens. PR-1 through PR-4 stand unedited, results appended.

⛔ **NOTHING BELOW HAS BEEN OBSERVED.**

---

## ⛔⛔ THIS IS NOT PR-4 REPEATED — FOUR THINGS HAVE NEVER RUN, AND THREE OF THEM WRITE

PR-4 proved the **contract path** from a spike script: `bridgeFee → sealBridgeQuote →
openBridgeQuote → agentBridge`. It called `agentBridge` **directly**. Its own RESULT says so:

> ⚠️ **NO VERDICT WAS WRITTEN TO THE STORE.** The spike calls `agentBridge` directly, not
> `recordBridge`, so the trigger never fired and no `fee/<owner>/<burnHash>` record exists.

So everything downstream of the burn is **unexercised on the upfront mechanic**:

| never run on this mechanic | writes? |
|---|---|
| the UI path — BridgePanel → `/api/agent-bridge` → `agent-bridge.mjs` | — |
| `recordBridge` — the durable receipt | **writes** |
| `triggerFeeReconcile` → `bridge-fee-reconcile-background` | **writes** |
| `triggerSettle` → `bridge-mint-settle-background` | **writes** |
| `BridgeReceiptStatus` rendered against a live upfront receipt | — |

⭐ **A READING PROVEN AGAINST A RECEIPT IS NOT A WRITE PROVEN END TO END.** PR-4 ran the production
*reader* (`observeFeeMovement`, `reconcileFee`) by hand against real bytes and got `matched`. That
settles the reader's arithmetic and nothing about whether anything **calls** it. The trigger, the
background function's own guards, the write-once store and the panel are all on the far side of
that line. [[evidence-does-not-transfer-across-claim-types]]

---

## THE SUBJECT

One bridge from the **Bridge page**, signed by the agent path, **Arc → Base Sepolia** (domain 6),
recipient = the agent SCA `0xc54d4721…b4e621` (so the amount comes back to us).

    amount A = 1.000000 USDC       (see §5 for why this number and not a smaller one)
    fee     F = quoted at execution, ~0.054 USDC on recent burns — READ IT, do not assume it
    TMWF      0x8745D906D67C346E5eb1aEEED38Eb87F34DF0C0A
    FEE_MANAGER 0x08499fce2344645c72de277a16734741e507a5d8

⭐ **EVERY ROW STATES ONE MOVEMENT OR ONE VALUE.** No row states a count, a total, or a relationship
between sets — the rule PR-3 set and PR-4's own R7/B7 broke.

⚠️ **THE SEVEN REQUESTED CLAIMS ARE TWELVE ROWS**, because five of them were compound. "the
reconciler fires **and** writes a verdict" is two facts with different causes: a trigger that never
sent and a background function that refused after being sent are different failures, and one row
covering both cannot say which happened. PR-4 recorded exactly this defect in its own B7 and did not
repair it; splitting here is that correction applied rather than noted again.

---

## 1. THE PREDICTION — one claim each

**R1 — A DURABLE RECEIPT EXISTS.** After the burn confirms, a `bridge-receipt/1` record exists for
this burn hash under the session owner.
*One value.* Nothing about its contents.

**R2 — IT SAYS `upfront`.** That receipt's `feeMechanic` field is exactly the string `"upfront"`.
*One value.* ⚠️ Distinct from R1: the writer defaults an unrecognised mechanic to `"unknown"`
(`bridgeMechanicOf`), so a receipt can exist and still name no mechanic.

**R3 — THE RECONCILE TRIGGER FIRED, FROM `recordBridge`.** The function log contains
`[bridge-receipt] fee-reconcile trigger sent burnHash=<this hash>` for this burn.
*One movement.* ⭐⭐ **THIS IS THE ROW PR-4 COULD NOT REACH AT ALL.** The evidence must be the log
line, not the verdict: a verdict written by a hand-invocation looks identical to one written by the
trigger, and only the log distinguishes "the wiring works" from "the reader works".
[[establish-which-action-produced-the-outcome]]

**R4 — A VERDICT RECORD EXISTS.** A record exists at the fee-verdict key for this owner and burn
hash.
*One value.* ⚠️ Distinct from R3: the trigger is awaited for a 202 ack only, and the background
function has its own refusals (`requireInternal`, missing receipt, `payer_unknown`). A trigger that
sent and a verdict that was written are two facts.

**R5 — THE VERDICT IS `matched`.** That record's `verdict` field is exactly `"matched"`.
*One value.* ⚠️ `matched` requires `observed.feeMinor === disclosedMinor` as BigInts. The other two
values in the closed set are `mismatched` and `unreadable`, and `unreadable` is the common one on
older burns.

**R6 — THE FORWARD-LEG PIN RESOLVED EXACTLY ONE LEG.** The reading behind that verdict did not
refuse with reason `fee_forward_legs`.
*One value.* ⭐ PR-4 confirmed on real bytes that the `TMWF → FeeManager` `Approval` and `Transfer`
share emitter, both indexed addresses and value — **only topic0 separates them** — and that without
the pin the reader sees two candidates and refuses. This row asserts the pin holds on the write
path's own bytes. ⚠️ PR-4 also recorded that on those bytes *position* and *forward leg* selected
the same log, so that receipt did not discriminate the two rules; this row does not claim to either.

**R7 — THE SETTLE TRIGGER FIRED, FROM `recordBridge`.** The function log contains
`[bridge-receipt] settle trigger sent burnHash=<this hash>` for this burn.
*One movement.* Separate from R3: they are two independent awaited fetches, and either can fail
alone. Both are swallowed by design, so neither failure would surface to the user.

**R8 — DELIVERY IS PROMOTED TO `measured`.** The receipt's `delivery` field becomes `"measured"` and
its `amountDelivered` is non-null.
*One value.* ⛔ **NO TIME IS PREDICTED** — see F8.

**R9 — THE FULL AMOUNT ARRIVED.** `amountDelivered` is exactly `1.000000`.
*One value*, and its own row rather than a clause of R8, because "it was measured" and "it measured
the right number" have different causes. ⭐⭐ **THIS IS THE VALUE THAT DISCRIMINATES THE TWO
MECHANICS**: under the deducted mechanic a 1 USDC bridge delivered `0.945900` on this system's own
recent receipts. A deducted-mechanic regression does not fail R8 — it produces a measured `~0.946`
and fails only here.

**R10 — THE PANEL EXPLAINS THE DERIVATION WHILE IT IS ONE.** While this receipt's `delivery` is
`"predicted"`, its row renders the upfront mechanic sentence — the copy from
`BRIDGE_MECHANIC_COPY.upfront.summary`.
*One value.* 🚨 **THIS OBSERVATION IS ONE-SHOT AND TIME-BOXED** — see F10, which is the falsifier
most likely to be misread.

**R11 — AND STAYS SILENT WHERE THE NUMBER IS AN OBSERVATION.** On a receipt with
`delivery: "measured"`, no mechanic sentence renders.
*One value.* ⭐ Observable immediately on the 57 existing measured rows, independent of this run —
which is why it is separated from R10 rather than sharing a row with it.

**R12 — THE ALLOWANCE IS ZERO AFTERWARDS.** `USDC.allowance(SCA, TMWF)` read after the burn mines
is `0`.
*One value.* ⚠️ Held over from PR-4 deliberately: that run proved it for a hand-built batch. This
one asserts it for the batch the **production** path builds.

---

## 2. FALSIFIERS — one per row, each negating exactly one

| # | falsifier | negates |
|---|---|---|
| F1 | no `bridge-receipt/1` record exists for this burn hash | **R1** |
| F2 | the receipt's `feeMechanic` is any value other than `"upfront"` | **R2** |
| F3 | no `fee-reconcile trigger sent` log line names this burn hash | **R3** |
| F4 | no verdict record exists at the fee-verdict key for this burn | **R4** |
| F5 | the verdict field is any value other than `"matched"` | **R5** |
| F6 | the reading's reason is `fee_forward_legs` | **R6** |
| F7 | no `settle trigger sent` log line names this burn hash | **R7** |
| F8 | the receipt's `delivery` is still `"predicted"` **at the moment of a final read** | **R8** |
| F9 | `amountDelivered` is a value other than `1.000000` | **R9** |
| F10 | the row carries **no** mechanic sentence **while its `delivery` reads `"predicted"`** | **R10** |
| F11 | a row with `delivery: "measured"` carries a mechanic sentence | **R11** |
| F12 | `allowance(SCA, TMWF)` after the burn is a value other than `0` | **R12** |

⭐ **EACH ROW IS NEGATED BY EXACTLY ONE FALSIFIER AND EACH FALSIFIER NAMES ITS ROW.** No falsifier
forbids behaviour another row predicts.

⚠️ **F8 CARRIES NO DEADLINE.** A mint that has not yet landed is an **unfinished observation, not a
falsification**. If `delivery` still reads `"predicted"`, record NOT-YET-OBSERVED and re-read. Do not
convert waiting into failure. The same applies to F9, which cannot be evaluated at all until R8 holds.

🚨 **F10 IS THE ONE THAT WILL BE MISREAD, AND IT IS CONDITIONED ON PURPOSE.** The sentence renders
only while `!measured`. PR-4 measured burn → mint at **11 seconds**, so this window may be under a
minute and it **closes permanently for this receipt**. An absent sentence on a row that has already
been promoted is the system working exactly as `c8e84ad` intended — it is **not** F10 firing. F10
fires only if the sentence is absent *while the same row still reads `predicted`*.
⭐ **IF THE WINDOW IS MISSED, RECORD `MISSED` — an unfinished observation, like F8.** It is not a
pass and it is not a falsification. It can be re-attempted on the next bridge.
⚠️ And if the receipt JSON is captured at `delivery: "predicted"` but no screen was watched, that
proves the render's INPUT, not the render. Record it as a claim about the receipt, and say so.

---

## 3. WHAT THIS RUN DOES NOT SETTLE

* **ATOMICITY. Still unproven, exactly as PR-4 left it.** Every row above describes a **successful**
  burn. *"Either both land or neither does"* is a claim about the **failure** path. R12's zero
  allowance is consistent with atomicity and equally consistent with a non-atomic batch whose second
  call happened to succeed. ⭐ **Only an INDUCED failure discriminates them** — an expired quote, or
  a deliberate shortfall, submitted as a batch, with the allowance read afterwards. That run is
  still not written.
* **THE SELF-SIGNED PATH.** It stays on `BridgingKitContract` and the **deducted** mechanic, because
  a browser EOA cannot batch. Nothing here applies to it, and R11 is the only row that touches it at
  all — as an assertion about existing rows, not about that path's behaviour.
* **THE PLAN PATH (`job-bridge-approve`).** It has its own receipt system in its own store and
  deliberately calls **neither** trigger, so it carries **no fee verdict at all**. R3–R6 say nothing
  about it. That exclusion is a recorded decision, not an oversight.
* **A SETTLEMENT-TIME DISTRIBUTION.** One bridge is one observation. `MINT_TIMING` does not move on it.
* **ANYTHING ABOUT MAINNET.** Arc testnet's Gas Station policy is Circle-provisioned.

---

## 4. HOW TO RECORD THE RESULT

Append below a rule; never edit above it. For **each of R1–R12** state the observation, and for
**each of F1–F12** state fired / did not fire / not-yet-observed / missed, with evidence.

⭐ Record the allowance (R12) **verbatim as returned**, and the balance before and after as **two
separate readings**, never one computed delta — the shape that produced the run-1 correction.
⭐ Record the fee **as read from the submitted quote**, not as the ~0.054 estimate written above.
⚠️ Paste both Arc log streams in full and separately, at both precisions, and **do not compare their
counts** — run 2 established they legitimately differ on a sponsored userOp.

⚠️ If a falsifier fires, **the finding is the falsifier** — record it and stop. If the defect turns
out to be in a row rather than in the world, say which clause and why, and do not repair it in place.

---

## 5. ⭐ THE AMOUNT, AND WHY IT IS NOT SMALLER

**Use A = 1.000000 USDC.**

* **IT KEEPS THE ACK GATE OUT OF THE RUN.** `feeRatio = feeDisclosed / amountRequested`; the bands
  are `warn` at ≥10% and `acknowledge` at ≥25%, and only `acknowledge` gates execution. At a ~0.054
  fee, 1.000000 gives ~5.4% → band `none`. ⛔ A 1-minor-unit bridge like PR-4's would sit at ~100%
  and drag the acknowledge gate into the run — machinery that is **already proven live** (burn
  `0x265be6d3…` at 36.14%) and whose failure would be indistinguishable here from an upfront-path
  failure. One unexercised mechanic per run.
* **IT MAKES R9 DISCRIMINATE.** Upfront delivers exactly `1.000000`; deducted would deliver
  `~0.946`. At 1 minor unit both mechanics deliver a number that rounds to nothing a human can tell
  apart, and R9 would be checkable only in minor units.
* **THE COST IS THE FEE, NOT THE AMOUNT** — ~0.054 USDC. The 1 USDC is minted to our own SCA on Base
  Sepolia. Balance was `27.931972` USDC after PR-4; ample.
* **HEADROOM ON THE BAND:** the fee would have to exceed 0.10 to reach `warn` and 0.25 to gate. Both
  are far above every fee this system has observed.

⚠️ **READ THE QUOTED FEE FROM THE RUN.** The ~0.054 above is a prior, not a prediction, and no row
depends on it.

---
---

# RESULT — appended 2026-09-04, nothing above this line edited

**The first PRODUCTION bridge on the upfront mechanic ran**, through the **UI path** — BridgePanel →
`/api/agent-bridge` → `agent-bridge.mjs` → `recordBridge`. Unlike PR-4, nothing here was hand-invoked.

    burn  0x9bfe1757f7d5cadb2ceee21a6ed341fc9392e654977608d9437a65649f25c907
          status 0x1 · Arc block 60393395 · 26 logs · block ts 2026-09-04T09:59:58Z
    mint  0xfb32a4091bde733ed60df2898001edb3bfaa56151b03eeaa68fad7eb8ed4e72b
          Base Sepolia · block 46373859 · block ts 2026-09-04T10:00:06Z
    payer/recipient  0x60e76623…2f75      A = 1.000000   F = 0.054018 (54018 minor)

## ELEVEN ROWS HOLD, ONE WAS NOT OBSERVED — no falsifier fired

| row | prediction | observed | falsifier |
|---|---|---|---|
| **R1** | a durable receipt exists | `o/0x5e06…7db4/0x9bfe1757…c907`, state `minted` | **F1 did not fire** |
| **R2** | `feeMechanic === "upfront"` | **`"upfront"`** | **F2 did not fire** |
| **R3** | reconcile trigger fired from `recordBridge` | log line, emitter **`agent-bridge`** | **F3 did not fire** |
| **R4** | a verdict record exists | `fee/0x5e06…7db4/0x9bfe…c907` | **F4 did not fire** |
| **R5** | the verdict is `matched` | **`"matched"`**, `reason: null` | **F5 did not fire** |
| **R6** | exactly one forward leg resolved | `reason: null`, `feeLogIndex 30` | **F6 did not fire** |
| **R7** | settle trigger fired from `recordBridge` | log line, emitter **`agent-bridge`** | **F7 did not fire** |
| **R8** | delivery promoted to `measured` | `"measured"`, `mintVerifiedBy [iris, destination-rpc]` | **F8 did not fire** |
| **R9** | `amountDelivered === 1.000000` | **`1`**, and `1000000` on chain, two mirrors | **F9 did not fire** |
| **R10** | the sentence renders while `predicted` | **CAUGHT — verbatim below** | **F10 did not fire** |
| **R11** | silent on measured rows | ⚠️ **NOT OBSERVED** — see below | F11 not evaluable |
| **R12** | `allowance(SCA, TMWF) === 0` | **`0x0`**, at `latest` AND at the burn block | **F12 did not fire** |

## R3 / R7 — THE TRIGGERS FIRED FROM `recordBridge`, AND THE EMITTER IS THE PROOF

    [𝒇 agent-bridge] [bridge-receipt] settle trigger sent burnHash=0x9bfe1757…c907 status=202
    [𝒇 agent-bridge] [bridge-receipt] fee-reconcile trigger sent burnHash=0x9bfe1757…c907 status=202

⭐ **THE DISCRIMINATOR IS *WHICH FUNCTION SPOKE*, NOT THAT A VERDICT EXISTS.** Both strings live only
in `_bridge-record.mjs`'s `triggerSettle` / `triggerFeeReconcile`, and both were emitted by
**`agent-bridge`** — the handler that calls `recordBridge`. A hand invocation is a POST straight to
the background function and produces no line in `agent-bridge` at all.

⭐⭐ **AND THE STORE CORROBORATES IT INDEPENDENTLY: THIS IS THE ONLY `fee/` KEY IN THE ENTIRE STORE.**
One verdict, for this burn, in a write-once store — so no earlier hand invocation ever wrote one, and
this record cannot be a leftover. PR-4 predicted exactly this absence and it held right up to this run.

## R5 / R6 — MATCHED, AND LOCATED BY THE FORWARD LEG

    observeFeeMovement -> feeMinor 54018 · feeLogIndex 30 · amountLegsMinor ["1000000"]
    verdict            -> "matched" · observed 54018 · disclosed 54018 · reason null

The rule in `observeFeeMovement` reads the fee **value** off the unique `TMWF → FeeManager` TRANSFER
and then selects the payer→TMWF leg equal to it. On these bytes that forward leg is **[34]**, and the
reader did not refuse with `fee_forward_legs`.

**ERC-20 `0x3600…0000` stream, read from the burn receipt:**

    [28] APPROVAL  SCA -> TMWF        1054018   ⭐ A + F, from inside the batch
    [30] TRANSFER  SCA -> TMWF          54018   FEE  ← feeLogIndex
    [31] APPROVAL  TMWF -> FeeManager   54018   🚨 collision partner
    [34] TRANSFER  TMWF -> FeeManager   54018   ← THE FORWARD LEG
    [35] APPROVAL  FeeManager -> 0xf992efcb  54018
    [38] TRANSFER  FeeManager -> 0xb499efcd   5401
    [40] TRANSFER  FeeManager -> 0xb499efcd  48617
    [42] TRANSFER  SCA -> TMWF        1000000   AMOUNT
    [43] APPROVAL  TMWF -> 0x8fe6b999 1000000
    [45] TRANSFER  TMWF -> 0xb43db544 1000000
    [48] TRANSFER  0xb43db544 -> 0x0  1000000   burned

🚨 **THE topic0 COLLISION IS PRESENT AGAIN.** [31] and [34] share emitter, both indexed addresses and
value — **only topic0 separates them.** Without the pin there are two candidates and the reader
refuses. Second production receipt on which this is confirmed rather than argued.
⭐ The 10/90 split held a fourth time: `5401 + 48617 = 54018`.

⚠️ **AND PR-4's HONEST LIMIT REPEATS, UNCHANGED.** The selected fee leg [30] is *also* the FIRST
payer→TMWF leg, so a **positional** reader would have chosen [30] too. **Position and the forward leg
agree on this receipt as well**, so it does not discriminate the two rules any more than PR-4's did.
That discrimination still lives only in the mutation suite. Two receipts is not two tests.

## R9 — THE FULL AMOUNT ARRIVED, AND THE VALUE IS THE ROW THAT MATTERS

    from 0x0000…0000 (a MINT) -> 0x60e76623…2f75   value 1000000   (1.000000 USDC)
    mint tx `to` = 0xe737e5ce…e275 (MessageTransmitterV2)

⭐ **CORROBORATED ACROSS TWO INDEPENDENT MIRRORS** — publicnode and tenderly each returned status
`0x1`, block 46373859, and the same single mint of `1000000`.

⭐⭐ **THIS IS THE ROW THAT DISCRIMINATES THE MECHANICS AND IT CAME OUT ON THE UPFRONT SIDE.** Under
the deducted mechanic this bridge delivers `0.945982`; it delivered **exactly 1.000000**, and the
wallet paid `1.054018`. R8 alone could not have told those apart.

## R10 — CAUGHT, NOT MISSED. THE SENTENCE, VERBATIM

> **The fee is charged on the source chain in addition to the amount, so the full amount arrives and
> your wallet pays amount + fee.**

⭐ **BYTE-IDENTICAL TO `BRIDGE_MECHANIC_COPY.upfront.summary`** — no surface composed it. Observed
while the row read *"in flight — 1.000000 USDC to arrive · 1.054018 USDC left your wallet · fee
0.054018 USDC charged"*, i.e. while `delivery` was still `predicted`. F10 was the falsifier flagged as
most likely to be misread, and the window was caught rather than reasoned around.

## ⚠️ R11 WAS NOT OBSERVED — recorded as unfinished, not as a pass

The screen report covers the in-flight row and says nothing about the measured rows. **No observation
of R11 was made**, and it is not inferable from R10: "renders where derived" and "silent where
measured" are two branches of one condition, and only one of them was looked at.
⛔ It is NOT recorded as holding. It is cheap to settle — this very row is now `delivery: "measured"`,
so reloading the panel answers it directly, alongside the 57 older measured rows.

## OBSERVED BUT NOT PREDICTED — the verdict RENDERED

> ✓ fee confirmed on chain — 0.054018 USDC moved, the figure you were shown

⭐ No row predicted this. R4/R5 asserted the verdict was *written*; this shows it was also *read back
and rendered*. Recorded as an additional observation, not as a row that passed — a claim nobody
registered cannot be scored.

## SETTLEMENT — one observation, and two quantities that are not the same

    burn  block ts 2026-09-04T09:59:58Z
    mint  block ts 2026-09-04T10:00:06Z          BURN -> MINT: 8 seconds  (chain clocks)
    our settler wrote settledAt 10:00:21.671Z    burnedAt -> settledAt: 21.6 s (our clock)

⚠️ Those measure different things — chain-to-chain arrival versus when our settler finished verifying
— and must not be quoted interchangeably. ⛔ **THREE observations (11s, 11s, 8s) ARE STILL NOT A
DISTRIBUTION, and `MINT_TIMING` does not move.**

## 🚨 TWO INSTRUMENT LIMITS AND ONE PRE-REGISTRATION DEFECT

**1. NETLIFY LOG TIMESTAMPS ARE NOT EMIT TIMES.** The trigger lines are stamped `09:59:56.586Z` —
**1.4 s BEFORE the burn block itself** (`09:59:58Z`), which is impossible for a post-burn trigger.
They are stamped at ≈ invocation start: the `Duration: 3864.67 ms` line ends at `10:00:00.518Z`,
putting the start at ≈`09:59:56.65Z`. Independently corroborated by a log line carrying two
timestamps 1.3 s apart, and by the reconciler's own first line at `10:00:00.441Z` — which fits a
trigger actually sent at ≈`10:00:00.2Z`, after `burnedAt 10:00:00.096Z`.
⭐ **NO ROW DEPENDS ON THIS.** R3/R7 rest on the EMITTER and the exact string, not on the clock.

**2. THE BALANCE FIGURES ARE 2-dp SCREEN VALUES.** `13.86 → 12.81` is consistent with 1.054018 and is
**not a reading at precision**, and no delta claim is made from it — the run-1 correction was exactly
this shape. ⭐ The precise statement of what left the wallet is on chain and is two readings, not a
subtraction: `54018` at log [30] and `1000000` at log [42].

**3. §THE SUBJECT NAMED THE WRONG ADDRESS.** It said recipient = the agent SCA `0xc54d4721…b4e621`,
carried over from PR-4's spike. The UI path's payer and recipient are the **caller's own SCA**,
`0x60e76623…2f75`. ⚠️ No row names an address, so nothing is falsified — but the subject description
was wrong, and PR-4's own mistake was writing a value ahead of reading it. Recorded, **not repaired**.

## ⛔⛔ WHAT THIS RUN STILL DOES NOT SETTLE

**ATOMICITY IS STILL UNPROVEN**, exactly as §3 said before the run and exactly as PR-4 left it. Every
row above describes a **successful** burn; *"either both land or neither does"* is a claim about the
**failure** path. R12's zero allowance is consistent with atomicity and equally consistent with a
non-atomic batch whose second call happened to succeed. **Only an INDUCED failure discriminates
them** — an expired quote, or a deliberate shortfall — and that run is still not written.

**NOTHING ABOUT THE SELF-SIGNED PATH.** It stays on `BridgingKitContract` and the deducted mechanic;
a browser EOA cannot batch. R11, had it been observed, would have been the only row touching those
rows at all, and only as an assertion about existing records.

**NOTHING ABOUT THE PLAN PATH.** `job-bridge-approve` has its own receipt store and calls neither
trigger, so it still carries no fee verdict. R3–R6 say nothing about it.

⚠️ **AND THE CLEAN RESULT IS EXACTLY WHEN THAT IS EASIEST TO FORGET** — eleven rows green, a mint in
eight seconds, and the money path's first end-to-end write. What is proven is the happy path of the
write path. The failure path has still never been run.
