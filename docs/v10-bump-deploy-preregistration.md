# PRE-REGISTRATION — deploying the Circle SDK v10 bump (`806e2e2`)

Written **before** the deploy. Nothing below is filled in afterwards; the observed column is
added in a follow-up `chore(record):` commit, as with `81704ce`.

## WHY THIS ONE IS NOT LIKE THE RECENT NO-WINDOW DEPLOYS

The last two entries in `dd-refusal-window-log.jsonl` (`fbd2c11`, `81704ce`) recorded
`no-window` because `ddTree` did not rotate. This deploy predicts `no-window` too — but for a
reason that deserves saying out loud rather than being filed as another routine match:

> **The only file this deploy touches inside `SURFACES` is a COMMENT.** The substance of the
> deploy — a different dependency tree — is invisible to the hash entirely.

So a matching prediction here is worth much less than it looks. See "what this cannot tell
you" below.

## THE STATE AT PRE-REGISTRATION — measured, not remembered

| fact | value | how |
|---|---|---|
| commit | `806e2e21ef07bd25fb5182d3434926420b39dedb` | on `origin/main`, verified by `ls-remote` + `merge-base --is-ancestor` after pushing, not by push output |
| `tree` @ `806e2e2` | `d22853c96ac60342f24bc8a194643fe22b108537d9cd334c592c55805bab7c01` | `npm run stamp` on the clean committed tree |
| `tree` @ `a02e5de` | `c53b83a55f00dfe57a569f821ffaae35d748e6fd791c02758f2c6d76b67a674a` | stamp run 2026-08-29T09:52Z — manifests ALREADY bumped, `dirty:false` |
| `ddTree` @ `806e2e2` | `00154c85cea92ebbb0ff686185d54080bd869273ff98548218418ced1d2f0e2e` (38 files) | same stamp run |
| `ddTree` in the last log entry (`81704ce`) | `00154c85…e2e` — identical | `tail -1 dd-refusal-window-log.jsonl` |
| resolved SDK | **10.8.0**, exactly ONE copy on disk | `createRequire("netlify/functions/_circle.mjs").resolve(...)` |
| `test:all` | 47/47, 0 failed, 0 not run | local, 4.7 min |
| `npm ci`, `vite build` | both exit 0 | local |
| deployed state | prod still serves the pre-bump bundle | no deploy has been run |

⭐ **`tree` moved `c53b83a5…` → `d22853c9…` solely because of a comment.** The 09:52 stamp is
the proof: at that moment `package.json` and `package-lock.json` were already modified and the
stamp still read `dirty:false` with the OLD tree hash. The manifests contributed nothing.

## WHAT SHIPS — 6 files

`package.json` · `package-lock.json` · `.npmrc` (new) · `netlify/functions/_circle-error.mjs`
(comment header only) · `scripts/verify-circle-error-shape.mjs` ·
`scripts/verify-vanilla-seller-limits.mjs` (both comment-only).

Exactly one is inside `SURFACES = ["netlify/functions","shared","src"]`: `_circle-error.mjs`.
`scripts/` is outside `SURFACES` altogether; the manifests and `.npmrc` are too.

## THE DD-SURFACE QUESTION — established by READING THE LISTS

```
DD_SURFACE_DIRS  = ["shared/onchain-analyze","shared/onchain-facts","shared/dd-canary","shared/dd"]
DD_SURFACE_FILES = 19 entries — dd-analyze, dd-canary, _dd-health, _dd-x402, _dd-exposure,
                   _blobs, _arc, shared/x402/settle-gate, _x402-confirm, shared/x402/version,
                   shared/x402/resource, _dd-rungs, agent-dd-report, _auth, _vault-report,
                   shared/build-stamp, ⭐ _circle.mjs, _dd-descriptor, _dd-discovery-page
```

**`netlify/functions/_circle.mjs` IS on the DD surface (entry 17).
`netlify/functions/_circle-error.mjs` is NOT — in either list.** Grep count is 0 against both.

⚠️ **The near-miss is the point.** A one-word difference in filename separates a no-window
deploy from a windowed one. Had this comment gone into `_circle.mjs` — its sibling, the file
that actually constructs the client — `ddTree` would rotate and this deploy would buy a
refusal window for a comment.

**Second instrument, different question** [[repeating-one-instrument-is-not-corroboration]]:
two stamps today, 09:52 and 10:06, produced an IDENTICAL `ddTree` (`00154c85…`) while the
10:06 run had `_circle-error.mjs` modified. The list says it is out of scope; the hash agrees.

## THE PRE-REGISTERED TABLE — every value, before the fact

| # | surface | predicted |
|---|---|---|
| 1 | `ddTree` | **`00154c85…e2e` UNCHANGED** |
| 2 | `previousDdTree` | `00154c85…e2e` |
| 3 | `rotated` | **`false`** |
| 4 | `outcome` | **`no-window`** |
| 5 | `exit` | `0` |
| 6 | `probes` | `1` |
| 7 | `tree` | **`d22853c9…`** — MOVED from `c53b83a5…`, entirely because of a comment |
| 8 | `dirty` / `dirtyCount` | `false` / `0` |
| 9 | `commit` | `806e2e2…` |
| 10 | `gate:deployed` | passes; deployed tree matches `d22853c9…` |
| 11 | Netlify `npm ci` | **succeeds** — `.npmrc` reached the build |
| 12 | SDK in the deployed bundle | **10.8.0**, one copy |
| 13 | DD canary | keeps writing PASS; no deposit-refusal window opens |

## 🚨 FALSIFIERS — each one a finding, not a nuisance

1. **`ddTree` rotates.** The list reading was wrong and a DD-irrelevant comment bought a public
   refusal window. Finding: the DD surface does not mean what the lists say.
2. **`outcome ≠ no-window`.** Either the canary is reacting to something other than `ddTree`,
   or prod's previous `ddTree` was not what the log's last entry says.
3. **⭐ Netlify `npm ci` FAILS.** The `.npmrc` did not reach or did not govern the build —
   Netlify may apply its own npm config precedence, which I have **not** verified. This is the
   load-bearing failure mode, and it fails LOUDLY at build time. That is the good case.
4. **⭐⭐ Build succeeds, then a function 500s on its first Circle call.** A v10 runtime
   incompatibility that no gate could catch, because no gate calls the SDK (below).
5. **⭐⭐ Entity-secret ciphertext throws.** v10's `hexToBytes` rejects odd-length or non-hex
   input where forge was lenient. I verified the **local `.env`** copy parses (64 chars, strict
   hex, no `0x`, no whitespace). I did **NOT** shape-check the **deployed**
   `CIRCLE_ENTITY_SECRET`. If prod's value carries whitespace or a prefix, every signing and
   transaction call fails at once. This is an open gap, named in advance.
6. **`tree` does NOT move.** Then the stamp is not hashing what these predictions assume, and
   every row above is suspect.

## ⚠️ WHAT THIS DEPLOY UNIQUELY CANNOT TELL YOU

`package-lock.json` is outside `SURFACES`, so **the dependency tree contributes nothing to
`tree`**. The hash moves because of a comment, while the actual substance of this deploy — a
different set of packages installing under `npm ci` — is invisible to it.

**So whatever `capture:window` reports, it is reporting on the comment, not on the bump.** A
green window capture here is not evidence that the v10 tree deployed correctly; it is evidence
that a comment did. Do not let a `no-window` row read as "the bump is fine".
See [[build-stamp-excludes-manifests]].

## ⭐⭐ THE ONE THING THAT WOULD ACTUALLY PROVE THE BUMP

**No gate exercises the SDK.** `verify-circle-error-shape.mjs` records the measurement in its
own header: across a full instrumented run of `test:all`, every suite mocks `_circle.mjs` or
the SDK and **ZERO client methods were invoked**. `gate:spec`, `gate:deployed` and the
read-only probes all return before any SDK call. So the bump is proven offline against the
real 10.8.0 `fromAxiosError`, and unproven in production.

**What would exercise it: `POST /api/agent-dd-report` with a valid session.**

It reaches `makeProduceReport` → `_dd-rungs.mjs` → `ddAttestationOptions` →
`makeCircleSigner`, which calls `circle()` and then `client.signMessage({walletId, message})`.
Its own header states it: *"READ-ONLY. Signs an attestation over a chain observation; moves no
money, writes no store."*

| | |
|---|---|
| what it proves | client construction from the deployed env · **entity-secret ciphertext generation** (v10's WebCrypto RSA-OAEP path, including `hexToBytes` over the DEPLOYED secret — falsifier 5) · real HTTPS transport through v10's axios · a typed success response |
| what it costs | **zero USDC, zero gas, no chain write, no store write.** One authenticated request. Circle computes a signature off-chain |
| what it still does NOT prove | the v10 typed **ERROR** branch. That needs Circle to actually reject a call, which cannot be arranged without either an invalid request or a money-moving one. The shim's error path stays proven offline only (93/0 + 34/0 against the real 10.8.0 factory) |

**Why not the cheaper option.** `getTransaction({id})` is a plain GET and needs no entity-secret
ciphertext, so it would prove transport and response typing while leaving the ciphertext
path — the one that actually changed implementation, forge → WebCrypto — completely untested.
A read is the weaker instrument here precisely because it asks a different question.

I am **not** recommending this be run as part of the deploy; it is what it would take.

---

# ADDENDUM — 2026-08-29, BEFORE THE DEPLOY: falsifier 5 is CLOSED

The prediction table above is untouched. This records a pre-deploy check, not an outcome.

**Falsifier 5** (the deployed `CIRCLE_ENTITY_SECRET` had never been shape-checked; only the
local `.env` copy had) was the one falsifier on the list that fails **quietly and late** — a
prod secret with whitespace or an `0x` prefix breaks every signing and transaction call at
once, *after* the deploy, under v10's stricter `hexToBytes`. It is now closed.

**Result: PASSES.** Length 64 · even · strictly `[0-9a-fA-F]` · no `0x` prefix · no leading,
trailing, or interior whitespace · no surrounding quotes · **and it passes v10's actual
`hexToBytes`, returning 32 bytes.** The value was piped from `netlify env:get` straight into
the analyser: never printed, never written to disk, never shown in part.

Also established, and not knowable before: the deployed value is **identical** to the local
`.env` copy, so the earlier local verification transfers to production. Reported as a boolean
— no hashes.

## The two things that made the check trustworthy

**1. The guard was located by its ERROR STRING, not by its name.** `hexToBytes` is not
exported; it is an internal, minified function whose identifier **differs between builds** —
`$i` in 10.7.1, `Ni` in 10.8.0. A name-based lookup would have found nothing, and depending on
how it was written could have reported a clean pass for a check that never ran
[[check-whose-failure-mode-is-a-pass]]. Anchoring on the literal
`"hexToBytes: input must have even length"` survives minification. The 291-byte function was
then extracted from the installed dist and evaluated — the SHIPPED implementation, not a
hand-written hex regex. A regex of mine and the SDK's guard are two different tests, and only
one of them ships.

**2. The instrument was calibrated against known-present AND known-absent first**
[[probe-must-discriminate-between-states]] — before any secret was read, against a variable
whose value is safe to display and against one that does not exist.

## ⭐ THE CALIBRATION FINDING — a trap for any env check, not just this one

> **`netlify env:get` prints `No value set in the <ctx> context for environment variable X`
> to STDOUT at EXIT 0 for an absent variable.** Absence is returned as content, and the exit
> code says success.

Uncalibrated, an **unset** secret would have been measured as a 64-character non-hex string
and reported as a loud FAILURE — the right verdict reached for entirely the wrong reason, with
a remediation ("rotate/reformat the secret") that would not have touched the real problem
(the variable is missing). The analyser therefore matches that sentinel explicitly and treats
it as its own outcome. Generalises to every env-var check in this repo:
[[caps-from-deployed-env-not-code-defaults]], [[absence-must-never-read-as-safe]].

## ⚠️ ONE DEVIATION FROM THE TABLE, DECLARED IN ADVANCE

Committing this addendum moves `HEAD`, so **prediction 9 (`commit`) will read as this
addendum's commit, not `806e2e2`.** `docs/` is outside
`SURFACES = ["netlify/functions","shared","src"]`, so `tree` (`d22853c9…`), `ddTree`
(`00154c85…`) and `fileCount` (186) are unaffected — re-measured after committing, not
assumed. Every other row stands as written.
