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
