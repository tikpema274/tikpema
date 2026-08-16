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

### 🥈 B · `builds` scope
Scopes are `builds,functions,post_processing,runtime`. **Verified the build does not read it** —
`stamp-build.mjs` and `vite.config.ts` don't, and no `src/` file reads it as code. Any compromised
build-time dependency can read the credential controlling every wallet.
⭐ Marking it `--secret` fixes this *and* forces the narrower scope.

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
