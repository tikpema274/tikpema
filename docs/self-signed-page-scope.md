# SCOPE — the self-signed operations page

**2026-08-30. Read-only. ⛔ NOTHING BUILT.** Three panels — `#/send-manual`, `#/bridge-manual`,
`#/swap-manual` — reachable only from their agent twins, each with its own wallet-state guard and its
own near-identical custody sentence.

---

## 🚨 FIRST: THE DRIFT IS NOT HYPOTHETICAL. IT HAS ALREADY HAPPENED, AND IT REACHED THE TESTS.

| panel | the sentence |
|---|---|
| **ManualSendPanel** | *"You sign this yourself, with your own key, spending your own USDC. **Agent spending caps do not apply here** — they bound what the agent may move unattended, and they are not a limit on your own funds."* |
| **ManualBridgePanel** | **byte-identical to the above** |
| **ManualSwapPanel** *(added today)* | *"…signed with your own key. You pay the gas. **Your agent's spending caps do not apply here** — this is your wallet and your money."* |

⭐⭐ **AND THE SUITES DIVERGED TO ACCOMMODATE IT.** Two assert the strong string; the third had to
weaken its regex to match the new wording:

```
verify-send-copy.tsx         /Agent spending caps do not apply here/i
verify-manual-bridge-copy    /Agent spending caps do not apply here/i
verify-manual-swap-copy      /spending caps do not apply here/i        ← weaker
```

🚨 **The weak regex is a drift ACCOMMODATOR, not a detector** — it passes against *either* wording, so
it cannot notice a third variant either. The third copy is where drift entered, exactly as the
SwapPanel registry entry went stale on its second instance. **Two independent detectors have now
failed on this same change in one day.**

⚠️ **AND THE SHARED SENTENCE CARRIES A LATENT BUG.** *"spending your own **USDC**"* is false for an
**EURC→USDC** swap. Unifying the copy is not only deduplication — **it fixes a wrong claim about
money that would otherwise ship the first time someone swaps EURC.**

---

# DECISION 1 — WHAT TO CALL IT

## ⛔ FIRST, REJECT THE OBVIOUS NAME — and the reason is not the brand

The panels already converged on *"…from your own wallet"* in all three titles, so **"Your own
wallet"** looks like the answer the copy has already chosen. **It is wrong, and not for the reason the
brief anticipated.**

🚨 **The agent wallet IS the user's own wallet too.** It is a per-user SCA, funded by them, holding
their money. Ownership does not discriminate between the two pages *at all* — a name built on it
would be describing a distinction that isn't there.

⭐ **What actually differs is WHO CAN MOVE IT WITHOUT YOU.** On the agent page, the agent can, within
caps, unattended. On this page, nobody can — it moves only when the user signs. **The page is the set
of operations where the answer is "nobody".** That is the custody distinction, and it is an *action*
property, not an ownership one.

## ⭐ RECOMMENDATION

| | |
|---|---|
| **route** | **`#/self-signed`** |
| **nav / eyebrow label** | **Self-signed** |
| **page heading** | **"Operations you sign yourself"** |

**Why it survives:**
- It names the **act that produces the property**. Caps do not apply *because* the user signs — the
  name states the cause, so the page's one shared claim follows from its title.
- ⭐ **It survives a second connector**, which was the brief's own test: a Ledger, a WalletConnect
  session, or a second passkey path is still self-signed. A page named for MetaMask ages badly; so
  would one named for a wallet the app happens to embed.
- It survives the *opposite* change too — if the agent path ever gained a user-signature step, the
  boundary would move and this name would still describe the right side of it. An ownership name
  would not.

⚠️ **The heading carries the meaning, not the label.** *"Self-signed"* borrows a connotation from
self-signed certificates and is not self-explanatory to a non-technical reader. It is chosen for the
route and the chip, where durability matters more than warmth; **"Operations you sign yourself" is
what the reader actually parses.** A label that needs its heading to explain it is acceptable; a
*route* that needs explaining is not, because it outlives the copy.

**Runner-up, and why it loses:** `#/manual`. It matches today's route prefix and needs no migration —
but *"manual"* describes the effort, not the custody, and is equally true of an agent action a human
clicked. It names the wrong axis.

⭐ **The three panel titles stay as they are.** *"Send from your own wallet"* is **contrastive copy
inside a page whose name has already established the frame**, which is different from using ownership
as the discriminator at the top level. Renaming them is not in scope and would cost their suites.

---

# DECISION 2 — DOES IT GO IN THE NAV?

## ⛔ RECOMMENDATION: **NO.** Dashboard card, not a sixth nav item.

The weak argument against is the convention (a recorded 5-item nav, extras reached via a Dashboard
card and a nav-less hash route). **A convention is a reason to ask the question, not to settle it.**
Here is the argument that settles it.

### ⭐⭐ THE PAGE'S ONLY CLAIM IS CONTRASTIVE, SO THE ENTRY POINT IS PART OF THE DISCLOSURE

Every panel on this page makes exactly one claim the agent panels do not: **caps do not apply**.
`verify-send-copy` already records what that costs when it stands alone — *"an absence stated against
silence tells the reader nothing"* — which is why stating the cap on `SendPanel` was made a
prerequisite before `ManualSendPanel` could claim its absence.

🚨 **A top-level nav entry lets a user arrive here having never seen the capped panel.** In that
state *"agent spending caps do not apply here"* is not a disclosure — it is a sentence about a
protection the reader has never been told exists, and it reads as **reassurance** rather than as the
removal of a guard. The twin link guarantees the reader was looking at the capped panel seconds
earlier. **The route in is doing disclosure work that the nav would silently delete.**

### ⭐ AND THE POSITIONING ARGUMENT, WHICH IS THE ONE THE BRIEF ASKED FOR

Nav placement is a claim about what the product *is*. This product's premise is **an agent that acts
within limits you set**. Self-signed operations are the **escape hatch where that premise is
suspended** — necessary, honest, and deliberately available. Promoting the escape hatch to a peer of
*"AI Agent"* would say the product is a wallet UI that also has an agent. **It is not, and the nav
should not say so.**

### ⚠️ THE COUNTER-ARGUMENT, STATED FAIRLY — it is real and it is answerable

*Twin-only reachability is how `#/dca` sat invisible for 22 days while reading as shipped.* True, and
that lesson is why this page must exist at all. **But the failure there was ZERO entry points, not
the absence of a nav item** — nothing in `src/` linked to it. Here there are three working twin links
plus a proposed Dashboard card: four ways in, none requiring a typed hash.

⭐ **The Dashboard is the app's established answer for exactly this** — twelve quick-cards already
route to nav-less pages. And the card can carry the contrast in its own words (*"…operations your
agent's caps don't cover, signed by you"*), so **arriving from the Dashboard still establishes the
frame that arriving from the nav would not.**

⛔ **If it ever does go in the nav**, the entry condition is that the page itself states what caps ARE
before saying they do not apply here — otherwise the nav has removed the contrast that makes its own
content truthful.

## ⚠️ THE TWIN LINKS STAY — BOTH DIRECTIONS, NON-NEGOTIABLE

Tidying them away "because there is a page now" would delete the entry point that carries the
contrast, and re-create the invisibility lesson from the other side. **Four routes must all work:**

| from | to |
|---|---|
| `SendPanel` / `BridgePanel` / `SwapPanel` | their manual twin |
| the page | each of the three operations |
| each manual panel | back to its capped twin *(already present in all three)* |
| Dashboard card | the page |

⭐ The existing suites already assert the agent→manual direction. **The page→operation direction
needs the same assertion, or the page becomes the thing nothing links to.**

---

# DECISION 3 — WHERE THE SHARED COPY LIVES, AND WHAT THE ASSERTIONS BECOME

## ⭐ A COMPONENT, NOT A STRING CONSTANT

`src/components/CustodyNotice.tsx`, exported pure. **Not** a `src/copy/` string module, and the reason
is this repo's own rule: a claim about money ships with its **render** assertion, and
[[assert-on-rendered-output-not-source-regex]] — a constant can be imported and never rendered,
which is precisely the failure a shared string invites. A component can be rendered once, in one test,
with real props.

⚠️ **It takes a token prop.** The current shared sentence hardcodes *"your own USDC"*, which is wrong
for an EURC swap. The unified component says **"your own funds"**, or names the token it was given.
**This is the copy bug the deduplication fixes, and it should be called out as a fix rather than
absorbed silently into a refactor.**

## ⭐⭐ WHAT THE RENDER ASSERTIONS BECOME — the brief's sharpest question

> *"a shared string asserted in three suites is the same duplication one layer up"*

Correct, and a shared component asserted by three hardcoded regexes would be **worse** than today:
one wording, three places that can disagree about it, and no signal when they do.

**The split:**

| | asserts | where |
|---|---|---|
| **the WORDING** | the sentence itself: the claim is present, "caps" is named, no internal enum leaks, the token is right | **ONE new suite**, rendering `CustodyNotice` directly. The single source of the copy assertion. |
| **the BINDING** | *this panel renders that notice* | the three existing panel suites — **composed from the component, never hardcoded** |

```
// in each panel suite — the assertion is BUILT from the component, so it cannot drift:
const notice = strip(renderToStaticMarkup(<CustodyNotice token="USDC" />));
check("renders the shared custody notice", strip(render(<ManualSendPanel …/>)).includes(notice));
```

⭐ **Change the sentence and exactly one file needs editing.** The three panel suites keep passing
*correctly*, because they compare against the live render rather than a copy of it. A regex would
have needed three edits and would have gone green on two of them.

### ⛔ WHAT MUST **NOT** BE CENTRALISED — the negative assertions stay three times

Each panel must **not** show the notice in its non-MetaMask state: *"a standing 'caps do not apply'
beside no control is a claim about a path the user cannot take."* That is a property of **three
different guards**, not one sentence — three assertions for three behaviours is not duplication, and
collapsing them would remove real coverage.

## ⚠️ A SECOND SHARED SURFACE, NAMED RATHER THAN FOLDED IN

The **two-state wallet guard** has drifted the same way: Send and Bridge share a shape (*"Switch to
MetaMask… / Connect MetaMask…"*, each naming where the agent twin lives), while the swap panel's
diverges. It is a candidate for the same treatment — but its copy genuinely differs per operation,
because **the destination differs**, so it would be a component with `twinLabel`/`twinRoute` props
rather than one string.

⛔ **Recommended as a SEPARATE step, not folded into this one.** It is a different shape of change
(behavioural branch vs. a claim), and bundling it would make one review cover two decisions.

## ⭐ AND IT NEEDS REGISTRY ENTRIES — `gate:registry` will demand them

Both new components are claim-bearing and must be declared in `scripts/guard-registry.mjs`:
`CustodyNotice` (the claim itself) and the page component. 🚨 Note the standing blind spot recorded
there **twice** now: §2's CLAIM vocabulary contains no *"cap"*, *"limits apply"*, *"ceiling"* or
*"enforced"*, so **the gate will not catch a missing declaration for cap copy** — both were corrected
by hand after the fact. **Declare them when they are written, not when the gate complains, because
here it will not.**

---

# ⛔ OUT OF SCOPE, DELIBERATELY

- The **EURC→USDC** run, and the log-pin question it would settle.
- The **`connectBlobs`** line in `user-swap-start.mjs`.
- Anything about **permit** / `permitType`.
- **Renaming the three panel titles** — contrastive copy inside the page, and it would cost three suites.
- The **wallet-guard** unification — named above as its own step.

---

# ADDENDUM — should the SERVED-BUNDLE check target the shared notice too? (scoped, not built)

**2026-08-30, after the unification landed locally.** The assertion split worked one layer in; this
asks whether it should be repeated one layer out, at `gate:manualswap` / `gate:disclosure`.

## MEASURED FIRST — what the unification did to the bundle

| fragment | prod (before) | build (after) |
|---|---|---|
| `spending caps do not apply here` | **3** | **1** |
| `Agent spending caps do not apply here` | 2 | 1 |
| `this is your wallet` | **2** | **1** |
| `this is your wallet and your money` | 1 | **0** — the divergent wording is gone from the artifact |

⭐ **The deduplication is visible in the shipped JavaScript, not just in the source.** And one gate
fragment got *sharper* by accident: `this is your wallet` had **two** sources (the review step, and
the swap panel's old sub-copy) and now has one — the review step, which is what it was written to
pin. A fragment satisfiable from two places does not pin either.

## 🚨 THE TRICK THAT MADE THE SUITE SPLIT WORK **DOES NOT TRANSFER HERE**

The panel suites stopped restating the sentence by **composing** it — rendering `CustodyNotice` and
asserting inclusion. ⛔ **A bundle gate cannot do that.** It greps minified JavaScript; there is no
component to render and no React at all. **The fragment must be a literal string**, so "compose it
from the source of truth" has no analogue at this layer.

**So the answer is NOT "do the same thing again". It is a different, weaker mitigation:**

| | suite layer | bundle layer |
|---|---|---|
| how duplication is avoided | ⭐ **composition** — expected text rendered from the component | ⛔ impossible |
| what remains | one wording suite + three composed bindings | **one gate owning the custody fragment**, and no other gate restating it |
| how drift is caught | mechanically, by construction | only by the fragment being derived from a real build, and living in one file |

## ⭐ RECOMMENDATION (for a later change, deliberately not this deploy)

- **One gate owns the custody sentence.** Today `gate:manualswap` uses
  `spending caps do not apply here` as a **CONTROL** — a string that must exist in both old and new
  builds to prove the instrument can see the app. That is a legitimate second use and should stay;
  what must not happen is `gate:disclosure`, `gate:manualswap` and a future send/bridge gate each
  asserting the custody sentence as a *discriminator*. **Three bundle gates pinning one sentence is
  the same duplication, minus the mechanism that fixed it.**
- **When a custody-copy bundle check is wanted, add it once**, in its own small gate, and have the
  others keep using the string only as a control.
- ⚠️ **Keep deriving fragments from a real `dist`.** A fragment written from the `.tsx` has already
  failed once in this repo (wrong leading case, present in neither bundle).

⛔ **Not built in this deploy.** `gate:manualswap` was checked against the new build **before**
deploying and is **12/0** — none of its fragments moved into the shared component, so a red would
have meant a real defect, not a refactor artefact.

---

# ADDENDUM 2 — WHAT A BUNDLE-GATE **CONTROL** MUST BE (scoped; one line landed)

**2026-08-31.** Addendum 1 asked whether the served-bundle check should target the shared notice.
This one answers the prior question it exposed: `gate:manualswap`'s control was already broken, in a
way that has nothing to do with `CustodyNotice` — and the rule that fixes it is a rule about
controls, not about custody copy.

## MEASURED FIRST — and one correction to the record

⚠️ **Production is `6a94a8003b8c71a37b64bf04`** (2026-08-30T22:00:33Z), not `6a9473982536cb2437d0bb20`
(18:16:56Z). The latter was published and superseded 3h44m later. Both serve the same fragments; the
identity matters only so the next reader does not calibrate against the wrong permalink.

⭐ **The served bundle and the local `dist/` are byte-identical** — `index-D4ZeRpcr.js`, 872,157
bytes, md5 `2e03264b…` both sides. So every count below is a count against production, and the
undeployed delta (`e410511..HEAD`) is `docs/` plus `dd-refusal-window-log.jsonl` — no `src/`, no
`scripts/`.

**The full fragment history, from five real deploy permalinks** — addendum 1 compared two builds; this
is all five, and it locates the unification precisely at the **15:13** deploy:

| fragment | 8-29 23:42 `foSNyN_9` | 8-30 13:55 `CfsAYHNr` | 8-30 15:13 `HBgPTp-l` | 18:16 `BMvoo-Wm` | 22:00 `D4ZeRpcr` |
|---|---|---|---|---|---|
| `spending caps do not apply here` | 2 | **3** | 1 | 1 | 1 |
| `Agent spending caps do not apply here` | 2 | 2 | 1 | 1 | 1 |
| `this is your wallet` | 0 | **2** | 1 | 1 | 1 |
| `this is your wallet and your money` | 0 | **1** | **0** | 0 | 0 |
| `Check this before you sign` | **0** | 1 | 1 | 1 | 1 |
| `Operations you sign yourself` | 0 | **0** | **1** | 1 | 1 |
| `from your wallet, gasless` | **1** | 0 | 0 | 0 | 0 |

⭐ `foSNyN_9` is the build `gate:manualswap` was calibrated against: **no `ManualSwapPanel` at all**
(`Check this before you sign` = 0) and the old `SwapPanel` sub-copy still present. Addendum 1's
"prod (before)" column was the **13:55** build, which already had the manual swap panel with its
divergent wording. Both readings are correct; they answer different questions, and this table says
which is which.

---

## ⭐⭐ 1. THE DISJOINT CONTROL — IT PASSES WITH ITS SUBJECT DELETED

Lead with this one. It is older than the `CustodyNotice` coincidence, it is worse, and unlike that
one it is visible from source ownership alone.

`gate:manualswap`'s second control is `"Set up your wallet first"`. Its owners:

```
BridgePanel.tsx   SendPanel.tsx   SwapPanel.tsx   VaultPanel.tsx
```

🚨 **`ManualSwapPanel.tsx` contains it zero times.** That panel guards with `WalletGuardNotice`
(line 266) and never had this sentence. So the control is not merely *also* satisfiable from outside
its subject — it is satisfiable **only** from outside it.

⛔ **Delete `ManualSwapPanel.tsx` from the repo and this control still passes**, at count 4, in both
the old build and the new one. It licenses every assertion below it — including the vacuous-absence
check the whole file is built around — on the strength of three panels that have nothing to do with
swapping.

⭐ **This is the sharper teaching example, and the reason is the failure mode.** The superset control
is *a coincidence that has not failed yet*: it passes for a reason nobody chose, and one day it will
go red in the wrong file. The disjoint control **can never fail for the right reason at all.** One is
mis-aimed; the other is not aimed. A check that cannot fail correctly is not a weak check, it is not
a check — and it had been sitting in the CONTROL block, above an `ABORTING` branch, since the file
was written.

## 2. THE SUPERSET CONTROL — the one addendum 1 already documents

`"spending caps do not apply here"`, count 1, sole bundle source `CustodyNotice`. Addendum 1 and the
gate's own comment block cover it. Two details the five-build table adds:

- ⚠️ **Its provenance moved wholesale between the two builds it is supposed to bridge.** In
  `foSNyN_9` its two sources were `ManualSendPanel` and `ManualBridgePanel`; today its one source is
  `CustodyNotice`. A control's job is to be the fixed point across the change — this one changed
  underneath the change.
- **It shares the disjoint case's ultimate defect.** `CustodyNotice` has three renderers; delete
  `ManualSwapPanel` and send and bridge keep the string alive. So it too survives its subject's
  deletion. The difference is only that you need the render graph to see it, where the disjoint case
  is visible from a `grep`.

⛔ **This entry is NOT changed here.** It is retired when `gate:custody` exists (§6). Under §3's rule
it should not survive that arrival either — it is a claim, and claims are not controls.

---

## ⭐⭐ 3. THE RULE: **NEVER USE A CLAIM AS A CONTROL**

The ownership test — *a control's sources must be a subset of its subject, never a superset and never
disjoint* — describes both defects. It does not prevent the next one, because it is applied after a
fragment has been chosen. This is the form that prevents it, and it is applied *while* choosing:

> **A CONTROL and a DISCRIMINATOR want opposite properties.** A control must be **stable** —
> unchanged across the two builds it tells apart, because its whole function is to be the fixed point
> that makes a difference meaningful. A discriminator must be **volatile** — it exists precisely
> because it changed. **A claim sentence is by definition the string someone will rewrite.** That is
> what claims are for. So a claim is disqualified as a control on the stability axis *before* anyone
> checks who owns it.

⭐ **`"spending caps do not apply here"` was a bad control the day it was written**, before it moved
anywhere and before `CustodyNotice` existed. It was a claim doing a control's job. The unification did
not break it; the unification made an existing defect visible.

**What to reach for instead:** a **label or structural string owned by the subject's own render
path** — a heading, a field label, an instruction. Nobody has a reason to rewrite it, and if they do,
the gate going red is correct rather than misdirected.

---

## ⭐ 4. THE TRAILING SPACE — one character, and it disqualifies the fragment it cleans up

`"Swapping from"` counts **2** in the served bundle. The two sources:

```tsx
SwapPanel.tsx:95        Swapping from{" "}          → literal "Swapping from"
ManualSwapPanel.tsx:291 Swapping from <span …>      → literal "Swapping from "   ← trailing space
```

So `"Swapping from "` with the trailing space is **sole-owned by `ManualSwapPanel`** — one character
is the whole difference between a two-owner fragment and a one-owner one. That is worth knowing when
choosing any fragment at this layer, and it is exactly the class of detail that cannot be read off a
`.tsx`.

🚨 **AND IT DISQUALIFIES THE FRAGMENT AS A CONTROL — which is the point.** Measured against
`foSNyN_9`: `"Swapping from "` = **0**. Of course it is: `ManualSwapPanel` did not exist in the old
build. **The same character that makes the fragment cleanly owned makes it new-build-only** — it is a
*discriminator*, and putting it in the CONTROL block would abort against a pre-deploy build with
"cannot see the app's panel copy" while the truth is that the panel simply had not shipped. **That is
a fresh instance of the defect being fixed, in the act of fixing it.**

⭐ This is §3's rule paying for itself immediately: ownership and stability pull in opposite
directions, and a fragment can be perfectly owned and still be the wrong kind of string.

⚠️ **Recorded as a withdrawn recommendation.** `"Swapping from "` was proposed as the replacement
control in the working session that produced this addendum, on ownership grounds alone, and was
withdrawn after calibration against a real old build. `"Swapping from"` (no trailing space) needs no
change: its two owners are `SwapPanel` and `ManualSwapPanel` — **both on the swap surface** — so it
cannot be satisfied from outside the subject, it is a label, and it is present in both builds.

---

## 5. THE PROPERTY IS CHECKABLE PER FRAGMENT — 1 of 3 vs 3 of 3

This is not a flaw of the layer. One of the two bundle gates already has it and one does not:

| gate | controls satisfying "sole owner, and the owner is the subject" |
|---|---|
| `gate:manualswap` | **1 of 3** — only `"Swapping from"` (swap-surface owners only) |
| `gate:disclosure` | **3 of 3** — `Bridge from your own wallet`, `stay on this page until the burn confirms`, `Most of this amount would become fee`, each owned by `ManualBridgePanel.tsx` alone |

⭐ `"Bridge from your own wallet"` counts **2** in the bundle, but both occurrences are the two render
paths *of the same panel* (`ManualBridgePanel.tsx:211` guard state, `:221` main state). **A count above
one is not itself a defect** — the question is the owner set, not the occurrence count. Measure
owners, not hits.

---

## 6. DOES THE CUSTODY SENTENCE GET ITS OWN GATE? — **YES**

### ⭐ Its own gate. Four reasons, in order of force.

**1. The fan-out does not fit.** `CustodyNotice` has three renderers — `ManualSendPanel:152`,
`ManualBridgePanel:225`, `ManualSwapPanel:288`. The bundle layer covers one and a half: `gate:manualswap`
names swap, `gate:disclosure` names bridge and never mentions the notice, and **`ManualSendPanel` has
no served-bundle gate at all.** A fragment inside `gate:manualswap` would pin a sentence on behalf of
two panels it does not name.

**2. Addendum 1's own rule forbids the alternative one step later.** *"Three bundle gates pinning one
sentence is the same duplication, minus the mechanism that fixed it."* Putting the custody fragment
into `gate:manualswap` as a discriminator does not avoid that — it **pre-commits** to it, because the
day a send or bridge gate wants the same claim there is no principled ground to refuse.

**3. ⭐⭐ A red must be addressed to the file that caused it.** This is §1–2 restated as design rather
than as a bug. Moving the sentence from `CONTROL` into `MUST_BE_PRESENT` of the same gate changes the
exit code from 2 to 1 and nothing else: a `CustodyNotice` edit still reddens a gate named for the swap
panel, and a reader still opens the wrong file. **A gate's name is its address.** `gate:custody`
failing means *"the custody copy moved"* — true, actionable, and correct for all three panels at once.

**4. It is the cheapest unit that can also cover `SelfSignedPanel`**, whose bundle risk is a
*different* risk — see below.

**The counter, stated fairly:** another gate is another script to run and another fragment set to rot.
Real. Answered by §7 (the rot mechanism is shared, so a second gate adds no new rot surface) and by
size — roughly 40 lines and one bundle fetch, the same shape as the two that exist.

**⚠️ And the honest limit on what it buys.** The wording is *already* covered comprehensively at the
suite layer by `verify-custody-notice.tsx` — the sentence, the token cases, the enum-leak absence, the
§3 mutation demonstration, the three composed bindings, and the page's route/nav-absence/Dashboard
card. A bundle gate adds exactly one claim on top: **the code carrying this money claim is what is
being served.** Worth having for this sentence because it is the one claim about money every
self-signed panel makes, and because one of its three renderers has no served-bundle coverage at all.

### ⭐ `SelfSignedPanel`'s bundle risk is the `#/dca` class, and only this layer can see it

For the notice the risk is copy drift. For the page it is **the page shipping while its way in does
not** — and that is a served-artifact question. `verify-custody-notice.tsx` checks the route and the
Dashboard card by reading `App.tsx` and `Dashboard.tsx` **as source text**; a bundle gate checks the
same facts **in the artifact**. Two instruments, not two reads of one.

### Proposed contents — every count verified against the served bundle

| role | fragment | count |
|---|---|---|
| CONTROL | `Operations you sign yourself` | 1 |
| the custody claim is present | `Agent spending caps do not apply here` | 1 |
| …and the reason, not just the absence | `not a limit on your own funds` | 1 |
| the user-signs half | `You sign this yourself, with your own key, spending ` | 1 |
| the page's own contrast | `its spending caps do not bound them` | 1 |
| ⭐ the entry point shipped | `caps do not bound these` | 1 |
| ⛔ the divergent wording is gone | `this is your wallet and your money` | 0 |

⛔ **Rejected fragments, and why** — all measured, none taken from the `.tsx`:

| fragment | count | why rejected |
|---|---|---|
| `spending your own funds` | **0** | composed — the `token` ternary splits it |
| `spending your own USDC` | **0** | same |
| `your own funds` | **3** | `CustodyNotice` ×2 **+ `BridgePanel.tsx:233`** — satisfiable from the agent panel |
| ` from your own wallet` | **11** | far too generic |

⚠️ The CONTROL above is `Operations you sign yourself`, which is **new-build-only** — correct here,
because `gate:custody` has no pre-fix build to bridge: it is written after the fact, and its control's
job is only "am I looking at this app's self-signed page". A gate written *against* a change needs a
control stable across it; a gate written *after* one does not. **State which kind it is in the file.**

---

## ⭐⭐ 7. WHAT STOPS THE FRAGMENTS ROTTING — a **declared owner** per fragment

Addendum 1's answer — *derive from a real dist, keep it in one file* — is a habit, and it is the habit
that was being followed on 2026-08-30. It did not fire, because **nothing in it looks at the source
tree**, and copy moving between components is a source-tree event the bundle cannot see.

**The proposal.** Each fragment becomes a triple instead of a pair:

```js
["⭐ the floor stated as a guarantee", "guaranteed at least", "ManualSwapPanel.tsx"],
```

A meta-check asserts, for every fragment in every bundle gate: **the whitespace-normalised source of
exactly one file under `src/` contains it, and that file is the declared owner.** For a `CONTROL` the
owner must additionally be the gate's declared subject.

**⭐ Feasibility is MEASURED, not assumed.** Across both gates' 18 current fragments: **17 are
verbatim-findable in exactly one `src/` file.** The 18th,
`"A fee this large needs your explicit acceptance"`, is split by a JSX line wrap at
`ManualBridgePanel.tsx:66–67` and is found once whitespace is normalised — **18 / 18 under
normalisation.**

**What it catches, precisely.** On the day `CustodyNotice.tsx` was created and the sentence left
`ManualSwapPanel.tsx`, the declared owner stopped containing the fragment → **red, in the right file,
naming the move**, before the coincidence had time to become invisible. It fires on the disjoint case
immediately too: four owners, none of them the subject.

### ⛔ ITS FOUR LIMITS — stated so it is not over-trusted

1. **⭐⭐ It says nothing about whether the fragment reached the bundle.** Tree-shaking, a dead branch,
   a build that dropped the component — a fragment can be correct in source and absent from the
   artifact. The `dist` grep still owns that question entirely. **Two complementary checks; neither
   subsumes the other, and passing one is not evidence about the other.**
2. **Minified JS has no provenance.** Ownership is a *source-tree* fact used to justify a *bundle*
   fact. The gate still cannot prove the string in the artifact came from that file.
3. **Legitimate non-panel owners exist and must be declarable, not special-cased.**
   `"The swap could not be read"` is owned by `lib/decodeSwapCalldata.ts` (bundle count **10** — ten
   distinct refusal reasons share the prefix), and `"Swap from your own wallet instead"` is
   legitimately owned by the *agent* `SwapPanel`, because that check asserts the twin link exists. The
   rule is "declared owner"; "must be the subject" binds controls only.
4. **⚠️ It adds a pointer that can itself go stale** — a second place recording a fact the source
   already holds. Mitigation: the declaration is a **path**, not a copy of the string, so it cannot
   drift silently; a stale pointer *is* the condition the check reports. It fails loudly where a stale
   registry fails green — the same reasoning that made render assertions preferable to a projection
   registry.

---

## ⚠️ 8. TWO FINDINGS OUTSIDE THIS ADDENDUM'S SCOPE — recorded, not actioned

### 8a. A **fourth** cap wording still lives on the agent side, outside `CustodyNotice`

`BridgePanel.tsx:233`:

> *"— your own key, your own funds, and agent caps do not apply."*

The unification reached the three manual panels and **stopped at the twin links.** This sentence makes
the cap claim, is owned by no shared component, and is the third bundle source of `"your own funds"`.
⚠️ The twin links are not even consistent with each other: `SendPanel:151` says *"Send from your own
wallet"*, `BridgePanel:231` says *"Bridge from your **connected** wallet"*, `SwapPanel` says *"Swap
from your own wallet instead"* — a fourth, fifth and sixth wording of the same idea.

🚨 **The hazard is that the same coincidence re-runs.** The day someone unifies this sentence, any gate
using a phrase from it as a control acquires a `CustodyNotice`-shaped defect. **Decide it before
unifying it, not after.**

### 8b. `WalletGuardNotice` has **zero** bundle coverage

Same three renderers as `CustodyNotice` (`ManualSendPanel:135`, `ManualBridgePanel:213`,
`ManualSwapPanel:266`), shipped in the same wave, covered at the suite layer by
`verify-custody-notice.tsx`'s non-collapse pairs — and **named by neither bundle gate.** Addendum 1
listed the wallet-guard unification as its own step; that step is now built at the suite layer and
absent at this one. A clean unique discriminator is available: `"Switch to MetaMask"`, bundle count
**1**.

---

## ⛔ 9. WHAT WAS LANDED, AND WHAT STAYS SCOPE

**Landed** (its own commit): the **disjoint control** in `verify-deployed-manual-swap.mjs` —
`"Set up your wallet first"` → `"come back here to swap"`. Calibrated both ways:

| | `foSNyN_9` (old) | `D4ZeRpcr` (served) | owners |
|---|---|---|---|
| `Set up your wallet first` | 4 | 4 | 4 — **none is the subject** |
| `come back here to swap` | **1** | **1** | **1 — `SwapPanel.tsx`** |

⭐ **It is the same sentence, cut to the half that belongs to the subject.** *"Set up your wallet first
— open Wallet to connect and fund it, then come back here to swap."* The head is shared by four
panels; the tail is swap-only. Stable across both builds, a label rather than a claim, and it goes to
**0** if `SwapPanel.tsx` is deleted — so it can fail for the right reason, which the string it replaces
never could.

**Stays scope, deliberately not built:**
- `gate:custody` (§6) — including retiring the superset control from `gate:manualswap`.
- The declared-owner meta-check (§7).
- Both findings in §8.
