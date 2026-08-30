# PRE-REGISTRATION — the FIRST live observation of the DD refusal window

**2026-08-30. Written BEFORE the deploy.** Nothing below this line is amended afterwards.

`capture:window` has run after every prod deploy this session and has never witnessed anything. Its
own words each time: *"ddTree did not change, so no health key rotated and no refusal was expected …
the banner remains proven only in-process."* **This deploy changes that**, because it is the first to
touch a DD-surface file.

## WHY THIS DEPLOY IS DIFFERENT — measured, not assumed

`netlify/functions/_dd-x402.mjs` is in `DD_SURFACE_FILES`, and this deploy changes it (the published
`settlement` field, the derived chain/asset constants, the outcome-named description).

| | |
|---|---|
| ddTree deployed now (ledger, 18:46Z) | `00154c85cea92ebbb0ff686185d54080bd869273ff98548218418ced1d2f0e2e` |
| ⭐ ddTree expected after deploy | `ed972854dabd1a53e3544f32d2bc1a923876dcf43da71f9502340653eeaf7f00` |

⭐ **The delta is attributable.** The 18:46Z ledger entry recorded `00154c85…` *after* the
wallet-guard work and *before* the x402 changes; `_dd-x402.mjs` is the only DD-surface file touched
since. Computed locally with `npm run stamp`, so this is a prediction of a hash, not of a direction.

## ⛔ WHAT IT COSTS — this is a real, deliberate outage

A rotated ddTree mints a new health key for which the canary has **no artifact yet**, so the DD
service **refuses until the canary's next scheduled run**. Canary period **10m**, health TTL 30m.

⚠️ **This is not only a documentation page.** The capture script's own header records that since
step 2 this window is *"how long vault DEPOSITS were unavailable."* **Vault deposits refuse for the
duration.** Self-healing, bounded, and the price of shipping any DD-surface change — but it is a real
refusal, not a cosmetic one.

## PRE-REGISTERED PREDICTIONS

| # | predicted |
|---|---|
| 1 | ddTree rotates to **`ed972854…`** — the local computation matches what the deploy stamps |
| 2 | ⭐⭐ `capture:window` **OBSERVES a window** — banner present. **This has never happened.** |
| 3 | the banner is the **self-clearing** variant (*"clears by itself, usually within minutes"*), not *"will NOT clear by waiting"* — this is a routine key rotation, not a broken canary |
| 4 | the window **CLOSES within the 1200s watch**, and its duration is recorded in `dd-refusal-window-log.jsonl` |
| 5 | the entry carries a `reason` code, so the refusal is attributable rather than generic |

⭐ **Prediction 2 is the point.** `verify-dd-report.mjs` proves the banner renders in all three health
states — 98/0, **in one process, with health injected**. What it structurally cannot see is whether
the discovery rung actually calls `healthDisclosure()` and threads the result into the page **on a
real deploy, during a real refusal**. [[binding-tested-across-what-it-binds]] — the binding can only
be tested across what it binds, and both sides are trivially identical inside one process.

## 🚨 FALSIFIERS — and one of them INVERTS a familiar output

1. ⭐⭐ **"NO WINDOW" with a rotated ddTree.** Every previous run printed "no window" and that was
   **correct**, because nothing rotated. Here the same output is the **suspicious** branch: it means
   either the window closed before the first probe (~5s), or **the health gate is not gating**. The
   script carries this discriminator precisely so the two are distinguishable — and it has never been
   exercised in the suspicious direction. ⛔ Do not read a familiar line as a familiar result.
2. **Window observed, banner ABSENT** → the defect the capture exists for is back. The script exits 1.
3. **Banner variant `not-self-clearing`** → not a routine rotation. Something is wrong with the
   canary itself, and waiting will not fix it.
4. **Window still open after 1200s** → past canary period plus margin. Not a routine post-deploy
   refusal any more; worth paging about.
5. **ddTree does NOT rotate** → the surface computation disagrees with the file list I read, and the
   whole premise of this pre-registration is wrong.

## ⚠️ WHAT A PASS WILL NOT PROVE

- **That the banner is correct for every health state.** It proves ONE state — key-missing after a
  rotation — crossed the process boundary. The other states stay proven in-process only.
- **That the window duration generalises.** One observation of one rotation.
- **Anything about the x402 changes themselves.** The refusal is a side effect of touching the DD
  surface, not a test of the settlement field or the derived constants.

## THE STEPS

1. Deploy (the chain already ends with `capture:window`).
2. Read the ledger's new line: `outcome`, `ddTree`, banner variant, `reason`, duration.
3. ⛔ If the outcome is `no-window` **with a changed ddTree**, that is falsifier 1 — say so and
   investigate; do not record it as the routine result it resembles.

---

# ✅ RESULT — 2026-08-30: **THE WINDOW WAS OBSERVED. ALL FIVE PREDICTIONS HELD.**

Deploy `6a94a8003b8c71a37b64bf04`. **The first live observation of the DD refusal banner in this
project's history.** Nothing above this line is amended.

| # | predicted | observed |
|---|---|---|
| 1 | ddTree rotates to `ed972854…` | ✅ **`ed972854…` exactly**, from `00154c85…`, `rotated: true` |
| 2 | ⭐⭐ a window is **OBSERVED** | ✅ `outcome: observed-banner`, 12 probes |
| 3 | banner variant **self-clearing** | ✅ `variant: "self-clearing"` |
| 4 | closes within the 1200s watch, duration recorded | ✅ **171s (2.9m)** — opened 22:27:48.920Z, closed 22:30:40.165Z |
| 5 | a `reason` code is carried | ✅ `reason: "no-record"` |

⭐ **Prediction 1 was a hash, not a direction** — computed locally with `npm run stamp` before the
deploy and matched character for character by what the deploy stamped. The rotation was attributable
in advance to a single file (`_dd-x402.mjs`) and it behaved exactly as attributed.

## ⭐⭐ WHAT THIS CLOSES, AND IT IS THE POINT OF THE WHOLE CAPTURE

`verify-dd-report.mjs` proves the banner renders in all three health states — 98/0 — **in one
process, with health injected.** It structurally cannot see whether the discovery rung actually calls
`healthDisclosure()` and threads the result into the served page. That is
[[binding-tested-across-what-it-binds]]: both sides are trivially identical inside one process.

> **Now measured across the process boundary: a real deploy rotated a real key, the real service
> refused, and the real page carried the banner — `bannerAboveCurl: true`, above the fold, in HTML.**

## ⛔ THE COST, MEASURED RATHER THAN ESTIMATED

**171 seconds.** For 2 minutes 51 seconds the DD service refused and **vault deposits were
unavailable**. Well inside the 10m canary period, and it closed by itself with no intervention — but
it is now a number rather than a hope. Every future DD-surface change costs approximately this.

⚠️ **One observation, not a distribution.** 171s is what one rotation cost at one moment; the canary
period bounds it at 10m but does not make 171s typical.

## THE FALSIFIER THAT DID NOT FIRE — and why it mattered that it could have

Falsifier 1 was *"no window with a rotated ddTree"* — the same `no-window` line that printed
correctly after every previous deploy this session, but which here would have meant **the health gate
is not gating**. It did not fire. ⭐ The value of pre-registering it is that the familiar line had a
second, opposite meaning ready in advance, so it could not have been read as routine.

## ⛔ WHAT THIS STILL DOES NOT PROVE

- **The other health states.** One state — key-missing after rotation — crossed the boundary. The
  rest remain proven in-process only.
- **That 171s generalises.** One rotation, one moment.
- **Anything about the x402 changes.** The refusal was a side effect of touching the DD surface, not
  a test of the `settlement` field, the derived constants, or the renamed description.
