# CIRCLE_ENTITY_SECRET — audit record, 2026-08-16

Read-only audit. No values recorded here, only fingerprints and findings.

## Verified clean
- **Git history** — 386 commits. `.env` never committed; `git log -S <live value>` across all refs = 0.
- **Shell history** — no live value for `CIRCLE_ENTITY_SECRET`, `CIRCLE_API_KEY`, `SESSION_SECRET`,
  `ANTHROPIC_API_KEY`. ⭐ Method calibrated against a known leak (5 Discord webhook URLs ARE inline),
  so the negative is not a broken-check artifact.
- **`.env.example`** — placeholders only, hash-confirmed different from the live value.
- **No logging/echo/forwarding** — every apparent hit prints the variable NAME in a missing-env error.

## Open findings, ranked by what it takes to trigger them

### 🥇 A · The recovery file (needs no attacker)
`~/Arc-tikpema/tikpema-dev/` — OUTSIDE this repo, not a git repo.

| file | size | mtime |
|---|---|---|
| `recovery_file_1781206891750.dat` | 144 B, ASCII/base64 | 2026-06-11 21:41:31 |
| `recovery_file.dat` | **0 B** | 2026-06-11 21:44:15 |

⚠️ **The EMPTY file is the LATER one, by 3 minutes** — the most recent download FAILED and nobody
noticed. No rotation/re-registration appears in PROGRESS, and both wallet-creation events
(2026-07-03, 2026-07-27) postdate the file, so the survivor is *plausibly* current. Plausibly ≠ verified.

**Integrity anchor for the surviving file** (hashes of an ENCRYPTED artifact — reveal nothing):
- sha256 `3adb019b80550d5ac6d8b4152c9731b4372f03ccaec01221f4ceccddbab05b92`
- md5 `b5f507e80f3b77f0e364685372792093` · 144 bytes

🚨 **BLOCKED ON AN UNANSWERED QUESTION.** Circle's documented reset flow gives NO read-only way to
validate a recovery file: you upload it for authentication, enter the new ciphertext, and the reset
takes effect immediately. **Verification may only be possible by performing the reset** — which is
the planned-outage option, not the 15-minute one. Sent to Circle support; see below.

### ✅ B(i) · DONE 2026-08-16 — `builds` scope dropped

`CIRCLE_ENTITY_SECRET` scopes are now `functions, post_processing, runtime`. **`builds` removed.**
A compromised build-time dependency can no longer read the credential that controls every wallet.

⭐ **THE MECHANISM WAS PROVEN ON A THROWAWAY FIRST.** `netlify env:set KEY --scope …` with the value
OMITTED is the only form that changes scopes without re-supplying the value — and whether omitting
the value WIPES it was the open question, since the CLI documents `value` as defaulting to `""`. Two
other approaches failed silently (`updateEnvVar` with a nested body = no-op; comma-separated
`--scope` = ignored, the flag is variadic). ⚠️ Discovering that on the production credential could
have destroyed it. `SCOPE_TEST_CANARY` was created, used to prove scopes change AND the value
survives, then deleted.

⭐ **VALUE PROVEN INTACT WITHOUT EVER BEING SEEN** — sha256 hashed before and after, identical
(`c3ebf1f6f70701f5`). ⚠️ That hash also matches `.env`, which confirms Netlify currently holds the
SAME value: a real second copy, and the reason B(ii) is on hold.

⚠️ **UNVERIFIED AGAINST AN ACTUAL BUILD.** The change takes effect on the next deploy. Statically,
nothing in the build reads it (`stamp-build.mjs`, `vite.config.ts`, no `src/` code read) — but the
next deploy is the real test, and it would fail LOUDLY rather than silently if something did.

### ⏸️ B(ii) · HELD — do NOT mark it `--secret` yet

🚨 **MARKING IT SECRET CLOSES A LIVE RECOVERY PATH.** Today `netlify env:get CIRCLE_ENTITY_SECRET
--context production` returns the value, so Netlify is effectively a second readable copy. `--secret`
makes it write-only forever: still injected at runtime, never readable again.

⚠️ **AND A IS UNRESOLVED** — the recovery file is unverified, the later download produced 0 bytes,
and the Circle question is unanswered. Marking it secret now would remove one recovery path while the
primary recovery artifact is of unknown validity: **two independent single points of failure
collapsing into one.**

⭐ **PRECONDITION FOR LIFTING THE HOLD:** the entity secret VALUE ITSELF confirmed stored offsite in a
password manager — not merely the recovery file.
✅ Pre-check already done: **no script does `env:get` on it** (every `env:get` reference in the repo
is `KIT_KEY`, `PINATA_JWT`, or prose), so nothing breaks on that axis.
⭐ `netlify env:set KEY --secret` (no value) converts in place, so the flip needs no value handling.

### 🥈 B(iii) · the OTHER credentials still carry `builds`
### ✅ DONE 2026-08-16 — `CIRCLE_API_KEY`: builds dropped AND marked secret

Now `functions,runtime`, `is_secret: True`. ⭐ Netlify **auto-dropped `post_processing`** on the
secret flip — secret values may not be used there — narrowing it further than asked.

⭐⭐ **THE `is_secret` ANSWER DIFFERS FROM THE ENTITY SECRET'S, AND THE ASYMMETRY IS STRUCTURAL —
CONFIRMED FROM DOCS, NOT ASSUMED.** The entity secret has an entire *entity secret management* page
covering registration, rotation, reset and a recovery file **because Circle never stores it**; losing
it is unrecoverable. An API key is issued BY Circle, listed in the console under *API & Client Keys*,
and replaceable via *Create a key*. **No recovery file exists for it because none is needed — that
absence is itself the evidence.** So losing every local copy costs a regeneration, not the wallets,
and the recovery-path argument that HOLDS `is_secret` on the entity secret does not apply here.

**Read-check done properly, not by analogy** (an API key is far more plausibly a build-time need):
- install hooks: `postinstall` is only `git config core.hooksPath` — reads nothing
- build chain: `stamp-build.mjs` ✗, `vite.config.ts` ✗
- ⭐ **client bundle**: no `VITE_`-prefixed Circle key, no `src/` read, and the **live production
  bundle was grepped for the actual key — absent.** The worse failure (shipping it to browsers) is
  ruled out by measurement, not by reasoning about vite's rules.
- `env:get CIRCLE_API_KEY`: no occurrences anywhere, so nothing breaks on the read-back axis

**Ordering was load-bearing.** Scope first (value hash verified identical before/after), THEN secret —
because once `is_secret` is set the value can never be read back, so every value-verification had to
happen while it was still readable. ⭐ Pre-flight also confirmed `.env` and Netlify held the SAME key
(`ed2b07d32ae37822` both sides) — flipping while they disagreed would have locked in a mismatch that
could never afterwards be diagnosed.

⚠️ **`.env` IS NOW THE ONLY READABLE COPY.** Losing it means regenerating in the console — acceptable,
and the deliberate trade.
⚠️ **Latent until the next deploy.** Env changes take effect on redeploy; runtime is unverified.

### ⭐⭐ THE LIVE-BUNDLE SWEEP — the most reassuring result of the audit

All five audited secrets grepped **by actual value** against the served 837 KB production bundle
(`assets/index-Bb568jJa.js`):

| secret | in bundle | what it would have meant |
|---|---|---|
| `SESSION_SECRET` | ✅ absent | 🚨 anyone could mint a valid session token for ANY owner — total account takeover on a money path |
| `CIRCLE_ENTITY_SECRET` | ✅ absent | 🚨 full custody of every Circle-custodied wallet |
| `CIRCLE_API_KEY` | ✅ absent | Circle API access |
| `KIT_KEY` | ✅ absent | swap/bridge quota abuse |
| `ANTHROPIC_API_KEY` | ✅ absent | model-spend abuse |

⭐ Measured, not reasoned from vite's `VITE_`-prefix rule. The worst outcome in the whole audit is
ruled out by evidence.

### ✅ DONE 2026-08-16 — `SESSION_SECRET`: builds dropped, `is_secret` HELD

Now `functions,post_processing,runtime`, still **production-only**, `is_secret` deliberately **False**.

🚨 **THE PRE-FLIGHT CAUGHT A REAL MISMATCH AND STOPPED THE CHANGE.** `.env` and Netlify hold
**DIFFERENT** `SESSION_SECRET` values — both well-formed, both 64 chars, so not a corrupted copy but
two different secrets (`5f0d64e0bb9fdbe0` local vs `96939992a2874587` production). Production signs
with the Netlify value by construction; `.env` is never deployed.

⚠️ **THAT INVERTED THE `is_secret` DECISION.** For `CIRCLE_API_KEY` the pre-flight proved `.env` was a
faithful second copy, so making Netlify write-only left one readable copy. Here it is not, so marking
it secret would leave **ZERO readable copies of the production session secret anywhere**. Held
pending reconciliation.

⚠️ **AND THE ROTATION COST IS LARGER THAN "EVERYONE LOGS OUT".** `_auth.mjs` derives `internalToken()`
from this same secret, so rotation ALSO invalidates the server-to-server token —
`job-submit-background → job-evaluate-background` and similar chains fail mid-flight, not just user
sessions. Belongs in the rotation runbook, alongside mid-deposit/mid-bridge.

⭐ **THE TRAP IS NOW LABELLED, IN BOTH PLACES.** `.env` carries a DEV ONLY warning at the line; and
because `.env` is gitignored — the label would die with this machine — the same warning is mirrored
into the TRACKED `.env.example`, which is what anyone setting up or recovering actually reads.
**A silent booby-trap became a visible one without deciding anything.**

⚠️ **OPEN, NOT GUESSED AT: is the divergence DELIBERATE or ACCIDENTAL?** Dev/prod separation is good
practice and would merely be undocumented; a half-finished rotation is a different problem. That
answer decides whether reconciliation means CHANGING `.env` or WRITING DOWN what is already true.
Deliberately not resolved late at night on a money path.

⚠️ **A CLI CONSTRAINT WORTH KNOWING:** `env:set` refuses `--context` and `--scope` together on an
existing var. Omitting `--context` was the working form — and whether that WIDENS a production-only
var was tested on a `CTX_TEST_CANARY` first. It does not; production-only survived.

### ✅ B(iii) · Done 2026-08-16 — `KIT_KEY` and `ANTHROPIC_API_KEY`
Both dropped to `functions, runtime`; values proven unchanged by sha256 fingerprint before/after.

**The read-check was done properly — build chain and postinstall, not just `env:get` references:**
`postinstall` is `git config core.hooksPath` (reads no env at all); `prebuild` is `stamp-build.mjs`,
which contains **zero** `process.env` reads; `build` is `vite build` against a `vite.config.ts` that
sets only the react plugin — no `define`, no `envPrefix` override, so Vite's `VITE_` default means
neither key could reach the client bundle even from `.env`. **Neither key appears anywhere in `src/`.**
Every consumer is `netlify/functions/*` (runtime) or `scripts/*` (run by hand).

`ANTHROPIC_API_KEY` is also **`is_secret` ✅**. Safe on both axes at once: regenerable from the
Anthropic console, AND `.env` was proven a real backup by hash comparison against Netlify production
first — the pre-flight that caught the genuine `SESSION_SECRET` divergence. Readback is now masked.

**`KIT_KEY` holds at `is_secret: false` — decided, not deferred.** It IS regenerable
(`console.circle.com/api-keys`, free, no KYC — Circle's kit-key docs), so the stated criterion was
met. It was still declined because `is_secret` protects against *console access*, a far smaller
population than the dependency below, and the exposure that actually mattered is closed either way.

### 🚨 THE REAL KIT_KEY FINDING: 18 SPIKE SCRIPTS READ A LIVE PRODUCTION CREDENTIAL
`is_secret` was the small question. The pre-flight grep found **20 files** invoking
`netlify env:get KIT_KEY --context production` — 18 of them one-shot spikes in `scripts/spikes/`,
plus `smoke-analystb.mjs` and `smoke-swap-estimate.mjs`. **Netlify is the ONLY copy**: no `.env`
entry, and the Circle console does not re-display a kit key after creation.

⭐ That is a bigger surface than `is_secret` addresses, and it is the item worth acting on:
**retiring or re-scoping the 18 spikes removes the dependency and the exposure together.** Doing it
in that order also makes `is_secret` free later — with only the 2 smoke scripts left, closing
readback costs nothing. Revisit `is_secret` then, not before.

⚠️ And note what flipping it *today* would have cost, since the ordering is the whole point: with no
readable copy anywhere, recovering the key means a **reissue**, which invalidates the live value and
breaks prod swap/bridge until Netlify is updated. A protection whose recovery path is a money-path
outage is not a protection worth taking first.

⚠️ Minor inconsistency recorded rather than smoothed over: these two (and `CIRCLE_API_KEY`) now sit
at `functions, runtime`, while `CIRCLE_ENTITY_SECRET` and `SESSION_SECRET` retain `post_processing`.
`functions, runtime` is the tighter shape; the other two were narrowed on the `builds` axis only.

### 🥉 C · `context: all`
Set in production, deploy-preview AND branch-deploy — every preview carries production wallet
authority. ⭐ `SESSION_SECRET` is production-only, proving per-context scoping works here; `all` is a
default nobody revisited.
⚠️ Narrowing is a behaviour change: draft deploys would lose Circle powers.

### ⚠️ The `--secret` asymmetry (decides which vars can be protected today)
| variable | markable secret? | why |
|---|---|---|
| `CIRCLE_ENTITY_SECRET` | ✅ | nothing reads its plaintext back |
| `CIRCLE_API_KEY` | ✅ likely | confirm per reader |
| `SESSION_SECRET` | ✅ | runtime only |
| `DD_WATCH_WEBHOOK` | ❌ **never** | its gate does a live existence GET on the value — already a
  standing constraint at `verify-watch-promotion-gate.mjs:141` |

### D · Rotation
Supported. **Immediate cutover, no dual-validity window**; in-flight Circle calls fail; wallets
survive; the old recovery file is deprecated and a new one must be downloaded. On a deposit path
already blocking on 3 services + 1 cron, this is a deliberate outage, not a background task.
⚠️ Nothing in this audit says rotate NOW — history and shell history are clean.

## ✅ E · Done 2026-08-16 — the gitleaks noise, and what it was hiding
Two findings fired on every history scan: the canonical Anvil/Hardhat test keys, public by design.

⭐⭐ **THE REAL FINDING WAS A DISAGREEMENT BETWEEN TWO SCANS.** `.gitleaksignore` held line-only
entries for 56/57 — where the keys are NOW — which silenced `gitleaks protect` (the pre-commit hook),
so every commit reported "0 leaks". But `gitleaks detect` scans HISTORY, where commit `375993fa` still
holds them at 38/39, because `59493b7` (2026-07-31) added a comment block and pushed them down.
**A line-numbered suppression silently stopped matching while the thing it suppressed was still
there**, and only a history scan — run here for the first time — could see it.

Fixed with commit-pinned fingerprints, which cannot drift. ⚠️ Deliberately NOT fixed with a path-wide
`.gitleaks.toml` rule: that would survive future edits and would also hide a REAL key added to that
file. On a secret scanner, precision beats convenience.
Both scans now clean: `detect` no leaks, `protect` no leaks.
