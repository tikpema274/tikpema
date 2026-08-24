# PRE-REGISTRATION — the refusal round-trip re-proof

**Written 2026-08-23, BEFORE the trigger.** The 2026-08-22 attempt failed and produced nothing;
this one is written down first so the result cannot be read backwards into whatever happened.

## WHY IT IS PRE-REGISTERED AT ALL

The first attempt (`4a6e675`) had a green suite (`test:refusals` 19/0) and a live deploy, and still
recorded **nothing** — because the suite drove `executeAction` and the Send button does not. The
failure was only legible because a *before* count existed (222 keys) to compare against. Without a
number written down in advance, "nothing happened" and "it worked and I misread it" are the same
observation. [[binding-tested-across-what-it-binds]]

## THE STATE AT PRE-REGISTRATION — measured, not remembered

| fact | value | how |
|---|---|---|
| `data-budget` total keys | **223** | `netlify blobs:list data-budget --json`, counted |
| key prefixes | `audit` 147 · `day` 57 · `dca-day` 3 · `job` 16 | same read |
| ⭐ audit keys dated **2026-08-23** | **0** | today's trail is EMPTY — a clean slate |
| deployed per-tx send cap | **10 USDC** (`AGENT_SEND_CAP_USDC`) | `netlify env:get --context production` |
| deployed day ceiling | 60 USDC (`PERIOD_CEILING_USDC`) | same |
| last published prod deploy | `6a8a1e5260b3677268b5cee6`, published 2026-08-22T22:48:15Z | created 9 s after `4a6e675` |

⚠️ `SEND_CAP_USDC` is **unset**; the live variable is `AGENT_SEND_CAP_USDC`. Read from the deployed
context rather than the code default, per [[caps-from-deployed-env-not-code-defaults]].

## THE TRIGGER

**Agents page → Send → 999 USDC.** One request. It moves no money by construction: the cap check in
`agent-send.mjs` fires before the wallet is even resolved.

## THE PRE-REGISTERED TABLE — every value, before the fact

| # | surface | predicted |
|---|---|---|
| 1 | HTTP status | **400** |
| 2 | HTTP body | `{"error":"exceeds per-transaction limit of 10 USDC","cap":10}` |
| 3 | `data-budget` key count | **223 → 224**, exactly one new key |
| 4 | the new key | `audit:<agent-wallet>:2026-08-23:<epoch-ms>-<rand>` |
| 5 | `allowed` | **`false`** |
| 6 | `code` | **`REFUSED_PER_TX_CAP`** |
| 7 | `source` | **`agent-send`** |
| 8 | `reason` | `exceeds per-transaction limit of 10 USDC` |
| 9 | `amountUsdc` | **999** — evidence, not a debit |
| 10 | `agent` | `executor` |
| 11 | `confirmation` | ⭐ **ABSENT** — load-bearing: `listUnresolvedCharges` selects on `confirmation === "submitted"`, so a refusal must never reach the reverser |
| 12 | `day:<wallet>:2026-08-23` | ⭐ **MUST NOT EXIST.** A refusal spent nothing, so no counter may advance |
| 13 | Agents page, Executor row | `0 actions · **1 refused**` (red) |
| 14 | Agents page, trail top row | red `refused · agent-send`, sub-line `exceeds per-transaction limit of 10 USDC`, right `999.00 USDC · <time>` |

## 🚨 THE FALSIFICATION, NAMED IN ADVANCE

* **223 stays 223** ⇒ the fix is not on the path the button takes. That is the 2026-08-22 result
  repeating, and it is the outcome this is built to be able to see.
* **224 but `code` absent** ⇒ an old-shape write; `makeRefuser` was not the writer.
* **`day:` key appears** ⇒ the true fail-open — a refusal charging the ceiling. This is the mutation
  that went 15 red in `test:refusals`; if it appears live, the suite's coverage is wrong.
* **Row 13 shows a count with no row 14** ⇒ producer works, trail does not — the reverse of the
  original defect.

## ⭐ WHY A STRAY MARKER CANNOT COUNTERFEIT THIS RESULT — checked, not assumed

The `*/30` sweeper writes a `resolution-<circleId>` marker with `allowed:false`, which the trail
currently renders as a **red "refused"** row (see the separate resolution-marker rendering defect).
That is a false positive shaped exactly like row 14 — so it had to be ruled out before triggering:

⭐ `markChargeResolved` files into **the CHARGE's day bucket** (`at: entry.timestamp`), not the day
the sweeper ran. Today's bucket holds **zero** audit rows, so it holds zero charges, so no marker can
land in it. And the refusal itself carries no `confirmation`, so it can never become a charge the
sweeper would later resolve. The window is clean.

⚠️ It is clean **today**, by that argument — not in general. Repeat the argument, don't reuse the
conclusion.

---

# ATTEMPT 1 — 2026-08-23 ~08:45–09:00Z: **NO SERVER INVOCATION.** Not a refusal, not a stale read.

A 400 was seen in the UI. `data-budget` stayed at **223** across three reads over 13 minutes, with
**zero** keys dated 2026-08-23 and no `day:` key for today. Rows 5–11, 13 and 14 have no row to read.

## ⭐ THE INSTRUMENT WAS CALIBRATED BEFORE ITS SILENCE WAS BELIEVED

`agent-send` showed **0 invocations in 60 minutes** — and so did `agents`, `my-wallet` and
`auth-verify`. That pattern is indistinguishable from a log source that simply cannot see
user-facing traffic, which would make the silence worth nothing. [[filtered-read-is-not-absence]]

So the instrument was tested against a known positive instead of trusted:

| | |
|---|---|
| external `curl` of `blobs-probe` (GET-only, no writes) | **08:58:19Z** |
| the same invocation, in `netlify logs --source functions --function blobs-probe` | **08:58:20.287Z** |

⭐ One second. The log DOES capture external user-facing HTTP, so the zeros are a **real measurement
of absence**: nothing reached `agent-send` on production. Neither Blobs staleness nor log blindness
explains the missing row — there is no row because there was no request.

⚠️ `/api/agent-send → /.netlify/functions/agent-send` is present in `netlify.toml:26`, and
`SendPanel` has **no client-side cap guard** — it gates only on a non-empty `to` and `amount > 0`,
then calls `fetch`. The path is intact. Something stopped the request before it left the browser;
`ensureSession()` runs before the fetch and is the leading candidate.

## 🚨 THE HOLE THIS EXPOSED IN THE TABLE ABOVE: A STATUS CODE IS NOT A DISCRIMINATOR

`agent-send` returns **three different 400s**, and only the third records anything:

```
400  "valid 'to' address required"                   ← returns BEFORE the cap branch
400  "amountUsdc must be > 0"                        ← returns BEFORE the cap branch
400  "exceeds per-transaction limit of 10 USDC"      ← the ONLY one that writes
```

Row 1 predicted "400" and cannot tell them apart. Row 2 — the BODY — is the discriminating row, and
it is the one row a human must read out. ⭐ **In a table written to prevent ambiguous readings, the
first row was ambiguous.** A predicted value is only worth the branches it rules out
([[ask-for-the-discriminator]]); pre-register the body, never the status, wherever paths share one.

## ⚠️ AND `netlify logs` IS A BACKFILL, NOT A TAIL — a second false-empty, avoided

A 7-minute `netlify logs --source functions --since 2m` was started so the next attempt would be
unambiguously timestamped. It returned **5 lines, all from the `--since` backfill**, spanning
08:59:04–08:59:09 and nothing after — in a window that should have contained ~7 `dca-tick` runs from
the `* * * * *` schedule. Whether it does not stream or its buffer was lost to SIGTERM does not
matter: **an empty tail here means nothing about the window it covered.**

⭐ THE WORKING METHOD IS THE ONE THE CALIBRATION PROVED: trigger first, then query the backfill with
`--since`. Do not watch; look back.

---

# ✅ ATTEMPT 2 — 2026-08-23T09:23:35Z: **THE ROUND TRIP IS PROVEN.** 12/12 pre-registered values matched.

`agent-send` invoked at **09:23:35.368Z** (131 ms, cold start 487 ms). `data-budget` **223 → 224**.
The row, read back verbatim:

```json
{"agent":"executor","amountUsdc":999,"source":"agent-send",
 "reason":"exceeds per-transaction limit of 10 USDC","code":"REFUSED_PER_TX_CAP",
 "allowed":false,"owner":"0x058957de…","date":"2026-08-23",
 "timestamp":"2026-08-23T09:23:36.084Z"}
```

| # | predicted | observed |
|---|---|---|
| 1 | 400 | ✅ |
| 3 | 223 → 224 | ✅ exactly one new key |
| 4 | `audit:<wallet>:2026-08-23:<ms>-<rand>` | ✅ `…:1787477016084-97ctg0j1` |
| 5 | `allowed:false` | ✅ |
| 6 | `REFUSED_PER_TX_CAP` | ✅ |
| 7 | `source:"agent-send"` | ✅ |
| 8 | `exceeds per-transaction limit of 10 USDC` | ✅ |
| 9 | `amountUsdc:999` | ✅ evidence, not a debit |
| 10 | `agent:"executor"` | ✅ |
| 11 | ⭐ `confirmation` **ABSENT** | ✅ — the reverser can never see this as an open charge |
| 12 | ⭐ **no `day:…:2026-08-23`** | ✅ — a refusal advanced no counter |
| 14 | the rendered trail row | ✅ `refused · agent-send by executor / exceeds per-transaction limit of 10 USDC / 999.00 USDC`, painted red |

⚠️ Row 14 above was rendered IN-PROCESS from the real production row, which proves the component maps
that row correctly and **not** that the deployed page fetched and rendered it
([[binding-tested-across-what-it-binds]]). Rows 13–14 close only on a human reading the live page.

## 🚨 WHAT ATTEMPT 1 ACTUALLY WAS — AND WHY IT COST SO MUCH

Attempt 1 produced **zero** invocations of `agent-send`, `auth-challenge`, `auth-verify`, `agents`
and `my-wallet` over 30 minutes of active use, and the UI said **"Send failed"**. Nothing was wrong
with the server: the served bundle, the redirect, and an unauthenticated 401-probe all checked out,
and two external probes appeared in the log within a second. The request never left the browser.

⭐ **THE DIAGNOSIS COST WHAT IT DID BECAUSE THE UI ERASED THE CAUSE TWICE.** Two stacked fallbacks:

```
useWallet.ts:348   throw new Error(data?.error || "Send failed")   // non-ok response, no error field
SendPanel.tsx:35   setSendError(e?.message || "Send failed")       // the thrown value had NO message
```

Both print a calm, plausible sentence that reads as *"the server rejected your send"* — a claim
neither of them is in a position to make. The same family as the `?? "action"` defect that
`verify-activity-fallback` exists to kill: **raw looks like a gap, a plausible label looks like a
fact, and the second is worse.** A user-facing failure message must never be able to narrate a
server response that was never received. ⚠️ OPEN — not fixed by this work.

## ⭐ THE INSTRUMENT LESSONS, BOTH EARNED THE HARD WAY

1. `netlify logs --source functions` is a **backfill, not a tail**. A 7-minute run with `--since 2m`
   returned 5 lines, all backfill, in a window that must have held ~7 `* * * * *` `dca-tick` runs.
   **Trigger first, then query with `--since`.** Look back; do not watch.
2. Its silence is only worth anything once **calibrated against a known positive**. An external
   `curl` of `blobs-probe` at 08:58:19Z appeared at 08:58:20.287Z — one second. Without that, "zero
   invocations" and "an instrument blind to user traffic" are the same reading.


---

# ✅ ROW 13 CLOSED ON THE DEPLOYED PAGE — 2026-08-24 09:06Z

A same-day trigger, and the owner confirmed **`1 refused`** rendered on the live Agents page.

| # | pre-registered | observed |
|---|---|---|
| 3 | 234 → 235, one new key | ✅ `audit:0x058957de…:2026-08-24:1787562379278-zbizixe9` |
| 5–10 | `allowed:false` · `REFUSED_PER_TX_CAP` · `agent-send` · cap message · `999` · `executor` | ✅ all six verbatim |
| 11 | ⭐ `confirmation` ABSENT | ✅ |
| 12 | ⭐ no `day:…:2026-08-24` | ✅ |
| **13** | **Executor shows `1 refused`** | ✅ **CONFIRMED ON THE LIVE PAGE** |
| **14** | the rendered trail row | ⚠️ **NOT CONFIRMED — still open** |

⭐ Row 13 was the only hop no tooling here could reach: reading the deployed page needs the owner's
session, so an in-process render proves the component maps the row and never that the page fetched
it ([[binding-tested-across-what-it-binds]]).

⚠️ **ROW 14 IS A DIFFERENT CODE PATH AND WAS NOT ANSWERED.** `1 refused` comes from
`agentBreakdown`; the trail row comes from `auditLog`. It was asked and left unanswered, so it stays
open. Recording it as closed would be the precise defect this pre-registration exists to prevent.

🚨 **AND THE WINDOW IS ONE UTC DAY.** `agents.mjs:71-72` scopes both surfaces to today, so the
2026-08-23 row — intact in `data-budget` throughout — became invisible on the page at 00:00Z. The
first attempt to check row 13 looked like a failure and was not one. **Any re-verification needs a
same-day trigger.**
