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
it secret would leave **ZERO readable copies of the production session secret anywhere**.

⭐ **UPGRADED 2026-08-17 FROM "held pending reconciliation" TO DECIDED: STAYS `false`.** The
reconciliation it was waiting on is done — the divergence is accidental in origin and deliberately
retained (see the RESOLVED section below) — and resolving it surfaced a *second*, stronger reason that
did not exist when the hold was first taken: **the readback is now load-bearing and tested.**
`scripts/probe-ub-auth.mjs` mints a prod-trusted token from the value read out of the production
context, and that path was **proven live on 2026-08-17** (401 control, then `400 exceeds per-spend
limit of 50 USDC` — token trusted, nothing moved). Marking the var secret would delete the only
authenticated prod-probe method, leaving a real browser login as the sole route.
⚠️ So this hold is no longer a deferral awaiting information. It is a decision with a working
dependency behind it — the same shape as `KIT_KEY`'s, and recorded the same way so neither sits on a
list nobody intends to close.

⚠️ **AND THE ROTATION COST IS LARGER THAN "EVERYONE LOGS OUT".** `_auth.mjs` derives `internalToken()`
from this same secret, so rotation ALSO invalidates the server-to-server token —
`job-submit-background → job-evaluate-background` and similar chains fail mid-flight, not just user
sessions. Belongs in the rotation runbook, alongside mid-deposit/mid-bridge.

⭐ **THE TRAP IS NOW LABELLED, IN BOTH PLACES.** `.env` carries a DEV ONLY warning at the line; and
because `.env` is gitignored — the label would die with this machine — the same warning is mirrored
into the TRACKED `.env.example`, which is what anyone setting up or recovering actually reads.
**A silent booby-trap became a visible one without deciding anything.**

### ✅ RESOLVED 2026-08-16 — accidental in ORIGIN, deliberate in RETENTION

The question was whether the divergence is designed dev/prod separation or a half-finished rotation.
**It is neither, and the repo answered it — this was already known and recorded long before the
audit re-found it.**

🚫 **A HALF-FINISHED ROTATION IS RULED OUT.** No `env:set`/`env:unset` for `SESSION_SECRET` in shell
history (7 occurrences, every one an `env:get`), no commit rotating it, and `.env.example` introduced
the var exactly once — `7c6a51a`, "Brick 1: session auth on money-moving endpoints" — and never
changed it. A rotation leaves a new value and a trail; there is neither.

🚫 **DESIGNED SEPARATION IS ALSO RULED OUT.** PROGRESS.md:7511 records it as a **"Blocker"**,
discovered the hard way: a locally-minted token got 401 from prod, and "the browser-console token
method failing earlier was **the same root cause, not an endpoint bug**." You do not discover your
own design while debugging. The same entry then lists "**align local/prod `SESSION_SECRET`**" as one
of two ways to CLOSE the blocker — nobody proposes aligning what they deliberately separated.

⭐ **WHAT ACTUALLY HAPPENED:** two values were generated independently (both well-formed 64-char, so
not a corrupted copy). The mismatch was found while debugging, alignment was considered and
**declined**, and a third path was adopted instead — read the prod secret from the Netlify context
and mint in-process, never printed, never written to disk — and documented as the standard method
("This unblocks authenticated prod probes generally", PROGRESS.md:8984). It kept costing time
afterwards: the `| tail -1` empty-var trap that lost three runs was a *consequence* of the workaround
the divergence forced.

**So: nobody designed it, nobody rotated it. It happened, was found expensively, assessed, and
kept.** The end state is defensible — dev/prod secret separation IS good practice, and
`SESSION_SECRET` being production-only on Netlify is consistent with it — but it is rationalised,
not designed. The `DEV ONLY` label added at the `.env` line on 2026-08-16 is the first time that
intent was written down anywhere near the value.

### 🚨 THE CONSEQUENCE THAT MATTERS MORE THAN THE LABEL
The divergence created a **readback dependency**: `netlify env:get SESSION_SECRET --context
production` is how every authenticated prod probe mints a trusted token. **That is the KIT_KEY shape
exactly** — a credential whose only readable copy is Netlify, with tooling that depends on reading it
back. Holding `is_secret` on `SESSION_SECRET` therefore turns out to have been the right call for a
reason the audit had not yet identified: flipping it kills authenticated prod probing outright,
leaving only a real browser login (challenge→sign→verify).

⚠️ **AND THE TOOLING IS ALREADY GONE.** `scripts/probe-ub-auth.mjs` and `scripts/fire-ub-spend.mjs`
were untracked and no longer exist — the method survives only as prose in PROGRESS.md. Rebuilding it
is a prerequisite for any future authenticated prod probe, and that rebuild should route through
`scripts/_kit-key.mjs`-style discipline rather than re-deriving the `env:get` recipe.

⚠️ **STRENGTH OF EVIDENCE, STATED:** `~/.bash_history` covers this machine only and is length-capped,
and Netlify exposes **no created/updated timestamps** on env-var values (confirmed: every value
returns `created_at: None`). So "no rotation" rests on shell history plus commit history, not on an
authoritative audit log. Nothing contradicts it; it is not provable to the same standard as the
git-history scan.

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
**retiring or re-scoping the 18 spikes removes the dependency and the exposure together.**

### ✅ DONE 2026-08-17 — the tree is zero, and `is_secret` is DECIDED (stays `false`)
The dependency is gone: **20 → 0**. All 18 spike headers plus both smoke scripts now take the key
per-run via `read -rs`, routed through `scripts/_kit-key.mjs`; `cf47676` additionally fixed five
**runtime error messages** that still said "get it from the prod env" — worse than a header, because
they fire at the moment someone is deciding where to obtain a key.

⚠️ **The earlier line here — "closing readback costs nothing once the tree is zero" — was WRONG, and
is corrected rather than quietly dropped.** A zero dependency tree removes the *breakage* cost; it
does not remove the *epistemic* cost. So `is_secret` stays `false`, **decided, not pending**:

* **The `builds`-scope drop was the whole win.** `is_secret` protects only against Netlify
  console/CLI access — a far smaller population than the readback tree that was the real exposure.
* 🚨 **THE RESIDUAL, NAMED PRECISELY — this is the reason, and it must outlive the conclusion:**
  *a self-issued kit key could behave differently at Circle's API than the deployed one, and that is
  exactly what cannot be discovered after losing readback.* "Untested" understates it: the untested
  thing is the one thing `is_secret` makes permanently untestable.
* **The accept path is half-proven.** 2026-08-17, a throwaway key (issued, used, then **revoked** —
  zero residue) passed `requireKitKey()` in `spike-sync-budget.mjs`: execution continued past L45 to
  the L61/L62 preconditions, shape check clean. But the run stopped before the Circle quote call at
  L84, so **Circle has never accepted a self-issued key.** Trading readback away before it has is the
  trade this decision declines.

⭐ Recorded as DECIDED deliberately. As "pending" it would sit on the list forever as an item nobody
intends to close, which is how a list stops being read. Off the list, with a reason, revisitable if
someone later has one.

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
