# `site/` — the marketing site (tikpema.xyz)

**Not the app.** The app is `src/` → `app.tikpema.xyz`. This is the public page at the apex domain.

## 🚨 HOW IT IS DEPLOYED — ESTABLISHED, NOT ASSUMED

Read from the Netlify API, not from recollection:

| field | value |
|---|---|
| site / id | `tikpema` · `a892e744-9dfc-45df-8cd4-8cd1b0c480b4` |
| domain | `tikpema.xyz`, no aliases |
| `build_settings` | **`{}`** — empty. No repo, no provider, no command, no publish dir |
| deploys, all time | **5** (2026-06-12 → 2026-06-26) |
| `commit_ref` / `build_id` | `null` on every one |
| ⭐ `manual_deploy` | **`true`** on every one sampled |
| ⭐⭐ `deploy_source` | **`"drop"`** on every one sampled |
| published deploy summary | *"1 new file uploaded… New pages include: index.html"*, *"No redirect rules processed"*, *"No header rules processed"*, *"No functions deployed"* |

⭐ **FOUR INDEPENDENT INSTRUMENTS, not one read four times:**

1. **all five deploy objects** — `manual_deploy: true`, `deploy_source: "drop"`, `build_id: null`, every one
2. **build hooks** — `[]`. There is no other trigger
3. **build history** — `[]`. **No build has ever run on this site.** A linked repo would have builds
4. ⭐ **byte identity** — `https://tikpema.xyz` and the deploy permalink
   `6a3dcab684a82ae844dd6639--tikpema.netlify.app` return the **same 11,682 bytes, md5 `c50f1a52…`**,
   so the apex is definitively served by that deploy on this site and not by some other host

**`deploy_source: "drop"` means drag-and-drop through the Netlify UI.** Not CLI, not git, not a build
hook. Every version of this page since the site was created has reached production by someone
dragging one `index.html` onto a browser drop zone. No `netlify.toml` has ever been processed for it.

## ⛔ WHAT THAT CHANGES ABOUT THE MOVE

⭐ **The good half:** there is no automatic path to compete with. Nothing watches a branch, nothing
builds. So putting the file in git does **not** create a second *automatic* publisher.

🚨 **The half that matters:** **drag-and-drop cannot be turned off.** It stays available to anyone
with UI access, forever, and it wins by being last. After the move, dropping the desktop copy would
silently overwrite the repo-sourced deploy and **nothing in this repo would report it** — the tracked
file would still look authoritative while production served something else. That is the failure the
move is supposed to end, re-created one layer up.

**So the move is not finished by copying the file in.** It needs, in this order:

1. **Remove the input.** Delete or rename the desktop copy so the drop path has nothing to drop.
   The strongest control here is not a check — it is that the manual path has no source file.
2. **Make git the default publisher, not an alternative** — see below.
3. **A detector**, because 1 and 2 are conventions until something reads production.
   ⭐ Unusually, an EXACT check is possible here: one static file, no build, no minifier, so the
   served bytes should equal the tracked bytes. Everywhere else in this repo the bundle forces
   fragment-greps; here a hash comparison is available and is strictly stronger.
   ✅ **CONFIRMED empirically, 2026-08-31.** The desktop source
   `C:\Users\salifu\Homepage\index.html`, the deploy permalink and the apex are all
   **md5 `c50f1a52649be897f7d3d3824f9d2515`, 11,682 bytes.** `pretty_urls` does not alter the bytes,
   so served == uploaded == tracked, and an exact hash check is viable.

## Deploying from here — two options, and they differ in what wins by default

**(b) CLI deploy from `site/`** — scripted and reviewable; git is the source, but drop is still
peer-level and still wins if used.

```sh
cd site
netlify deploy --dir=. --site=a892e744-9dfc-45df-8cd4-8cd1b0c480b4          # DRAFT first
netlify deploy --prod --dir=. --site=a892e744-9dfc-45df-8cd4-8cd1b0c480b4   # only after reading it
```

### 🚨 THE RELINK CANNOT BE DONE FROM THE CLI — established 2026-08-31

The Netlify API exposes **`unlinkSiteRepo`** and **no `linkSiteRepo`**. `netlify link` is a different
thing entirely: it writes `.netlify/state.json` to point the *local folder* at a site — it does not
connect a Netlify site to a GitHub repo for CI. Connecting requires Netlify's GitHub OAuth/App grant
plus a deploy key and webhook installed on the repo, which the UI does atomically and the CLI cannot.

⚠️ **AND A HAZARD THAT FALLS OUT OF THAT FILE:** `.netlify/state.json` currently holds
`siteId: 5464f1a6-eb85-4be9-83a3-8f28c4ace392` — **the APP site.** Any `netlify deploy` run from this
repo *without* an explicit `--site` targets the app, not the marketing site. Every command in this
README passes `--site` for exactly that reason; do not drop it.

**(c) ⭐ RECOMMENDED — link the Netlify site to this repo**, publish dir `site/`, **no build command**.
Then a push to `main` publishes, the tracked file is *definitionally* what ships, and a drag-and-drop
becomes a **visible anomaly**: a `manual_deploy: true` deploy appearing among git-triggered ones,
which a detector can flag in one API read. ⚠️ Cost: every push to `main` would trigger a marketing
deploy, most of them no-ops — set Netlify's ignore-builds command to skip when `site/` is unchanged.

⛔ **No `deploy:site` npm script yet, deliberately.** One pointing at this directory before the page
is in it would publish an empty site — **taking tikpema.xyz down**. It lands with the HTML.

## 🚨 Why this needs its own `netlify.toml`

The repo root's is **494 lines** declaring `functions = "netlify/functions"` and dozens of `/api/*`
redirects — the app's money-moving surface. A CLI deploy launched from the repo root reads *that*
file, and publishing it against `tikpema.xyz` would put live `/api/agent-send` and friends on the
marketing domain. `site/netlify.toml` declares a static publish and nothing else.
⚠️ That containment is an **assumption about cwd resolution, not a measured fact** — this CLI has no
`--config` flag. Prove it on a draft and read the draft's function list before any `--prod`.

## ⛔ Deliberately OUTSIDE `SURFACES`

`SURFACES = ["netlify/functions", "shared", "src"]` is the app's deploy identity. `site/` is outside
it on purpose: a copy edit must not rotate the app's tree hash, and `src/` would put the page inside
the vite bundle. ⚠️ The cost, stated rather than discovered: `gate:deployed` will never bind this
page. **Moving it into git buys history, review and a filed original — not guard coverage.**

## ⛔ THE FILED COPY IS NOT YET THE SOURCE OF TRUTH

`index.html` here is byte-identical to what production serves — **and to the desktop copy**, which
turns out to have **no undeployed drift**: last modified 2026-06-26T00:39Z, deployed 00:41:26Z, two
minutes later, and untouched since. So the filing captured a clean state, not a divergence.

🚨 **But the repo does not become the source until the site is relinked.** Until step (c) below, the
drop path still exists and still wins by being last — dragging the desktop copy in would overwrite a
repo-sourced deploy silently. **The strongest control is step 1: remove the desktop file**, so the
manual path has no input.

The claim-by-claim audit is `docs/marketing-site-claim-audit.md`. ⛔ The content was filed **as-is**,
so the rewrite is a reviewable diff against a filed original.

## ⭐ Why a separate site — the redirect argument, verified

Beyond deploy-lifecycle independence: `netlify.toml:363-367` on the APP site ends with

```toml
[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

⚠️ A marketing path served from the app's domain would sit behind that catch-all. Redirect order
means an explicit earlier rule *would* win — so it is not impossible — but **anything not explicitly
routed returns 200 with the SPA shell**, which is the same silent-success shape that hid the missing
`/api` routes. A separate site has no such fallback to get wrong.

## ⛔ No `SURFACES_EXCLUDE` is needed — and adding one would be a defect

`SURFACES` is an **allow-list**, not a deny-list: `["netlify/functions", "shared", "src"]`. Anything
outside it is excluded by construction, so `site/` is already incapable of rotating the app's build
stamp. ⭐ **Proven by probe, not by reading the constant** — appending a line to this README and
re-running `npm run stamp` returned `dirty: false` and the identical tree hash `67c4c778e91e…`.

An exclude entry would restate a fact the allow-list already guarantees, and would drift the moment
`SURFACES` changed. [[duplicate-source-of-truth-is-the-recurring-bug]]

---

# RELINK RUNBOOK — ⛔ SCOPED, NOT EXECUTED (2026-08-31)

## Two corrections to the brief, before anything else

⚠️ **There are 5 manual deploys, not 137.** Re-queried at `per_page=100` and `per_page=500` — both
return **5**, so it is not a pagination artifact. Site created 2026-06-12, last deploy 2026-06-26.
(The app site returns 100+, all `deploy_source: "cli"` — that is probably where 137 comes from.)

✅ **The file is already filed.** `site/index.html` was committed at `93601f7`, read directly from
`/mnt/c/Users/salifu/Homepage/index.html` over WSL. **md5 `c50f1a52649be897f7d3d3824f9d2515`,
11,682 bytes — identical to the desktop copy AND to what production serves.** Nothing needs handing
over.

## 1. What changes on the Netlify site `tikpema`

| setting | now | after |
|---|---|---|
| `repo_url` / `provider` | *(none)* | `https://github.com/tikpema274/tikpema` · github |
| production branch | — | `main` |
| **base directory** | — | **`site`** |
| **build command** | — | **none.** One static file; there is nothing to build |
| **publish directory** | — | **`site`** (Netlify resolves publish relative to base; the UI accepts the repo-root-relative form and normalises it) |
| `build_settings` | `{}` | populated |

🚨 **The one setting that can do damage is `publish`.** Get it wrong and Netlify serves the **repo
root** — which contains its own `index.html` (vite's 1,088-byte app shell, referencing
`/assets/index-*.js` that do not exist there). The marketing page would be replaced by a broken app
shell that still returns **200**. ⚠️ Verify the deploy summary's file list before trusting the URL —
a 200 is not evidence here, which is the same lesson as the SPA catch-all.

## 2. Is there a window where the site serves nothing? — **No, but the risk is not a gap**

Netlify keeps the **currently published deploy live until a new one is published**, and linking a
repo does not unpublish anything. A first build that **fails** leaves `6a3dcab6…` serving.

⛔ **The real risk is a build that SUCCEEDS and publishes the wrong directory.** That is not a window
of silence, it is a window of *confidently serving the wrong page* — and it is the failure mode this
whole exercise is about.

**Rollback is one API call and both methods exist** (`netlify api --list` confirms
`restoreSiteDeploy` and `rollbackSiteDeploy`):

```sh
# pin this BEFORE linking — the known-good published deploy
netlify api restoreSiteDeploy --data '{"site_id":"a892e744-9dfc-45df-8cd4-8cd1b0c480b4","deploy_id":"6a3dcab684a82ae844dd6639"}'
```

## 3. Does this give the app site a second build per push? — **No, and the reason is worth knowing**

| | app site `tikpema-predict-test` | marketing site `tikpema` |
|---|---|---|
| linked repo | `https://github.com/Tikpema/tikpema-predict-test` | *(none, today)* |
| ⭐ does that repo exist? | **HTTP 404** | — |
| our git remote | `https://github.com/tikpema274/tikpema` — **a different repo** | same |
| last 8 deploys | all `deploy_source: "cli"`, `build_id: null`, `commit_ref: null` | all `"drop"` |

**A push to `tikpema274/tikpema` triggers zero Netlify builds today.** The app never builds on
Netlify at all — `deploy:prod` builds locally and uploads `dist/` over the CLI. So linking the
marketing site makes it the **only** git-triggered build, and it touches nothing the app's path uses:
different site, different base directory, no build command, no functions.

⚠️ **Unrelated hazard, found while checking and worth its own decision:** the app site holds a **stale
link to a repo that 404s**, with `stop_builds: false`. Harmless while that repo does not exist —
but if it is ever recreated or repointed, app builds would start firing from a source nobody is
watching. Not in scope here; flagged.

## 4. The ignore, and the stamp — **two different things, only one needs building**

**(a) The app's build stamp — nothing to do.** `SURFACES` is an allow-list
(`["netlify/functions","shared","src"]`), so `site/` is excluded by construction. ⭐ Proven by probe:
appending a line to this README and re-running `npm run stamp` returned `dirty: false` and the
identical tree `67c4c778e91e…`. ⛔ **Do not add a `SURFACES_EXCLUDE`** — it would restate what the
allow-list guarantees and drift the moment `SURFACES` changed.

**(b) Netlify build-skipping — added**, because with the repo linked every push to `main` would
otherwise rebuild the marketing site, most of them producing identical bytes. That would destroy the
property that makes this site's history readable: **every marketing deploy means a copy change.**

```toml
[build]
  publish = "."
  ignore  = "git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- ."
```

🚨 **NOT `HEAD^ HEAD`** — the form this runbook first proposed. It inspects only the **last commit of
a push**, so a `site/` change in an earlier commit of the same push is skipped: a **silent stale
deploy**, the exact failure the move exists to prevent. Demonstrated against real history in
`scripts/verify-build-skip-predicate.mjs` §3 — on `3c84c22..786767e` the whole range says **BUILD**
while `HEAD^..HEAD` says **SKIP**, and the two forms genuinely disagree.

⭐ The failure direction is safe: on the first build `CACHED_COMMIT_REF` is unset, git errors, the
exit code is non-zero, and the build **proceeds**. It fails toward building, never toward skipping.

### ⚠️ WHAT `npm run test:buildskip` REACHES — and what it does not

`scripts/verify-build-skip-predicate.mjs` is **12/0 offline, for zero build minutes**: it evaluates
the predicate against commit ranges already in this repo's history, covering all three shapes
(only-`site/`, only-app, both), and asserts each shape is genuinely present first so a missing one
cannot pass vacuously.

⛔ **It proves the PREDICATE DECIDES CORRECTLY. It does NOT prove NETLIFY HONOURS IT.** Those are
different failures, and from inside the repo they are invisible:

- Netlify may not run the command at all, may not set `CACHED_COMMIT_REF` / `COMMIT_REF` under those
  names in the ignore context, or may read the exit code the other way round.
- ⭐ **A correct command Netlify never runs is INDISTINGUISHABLE from no command at all** — both
  build on every push, and neither reports an error.
- The command executes in the **marketing site's build context on Netlify**, which nothing in this
  repo can enter. A green here is a statement about a git command, not about a deploy pipeline.
- ⛔ **There is no app-side ignore command**, so the harness's "app-side" column is testing the
  predicate's other branch, not a second live pipeline. The app has never built on Netlify.

⛔ **Do not record the build-skip as verified until a live push shows the pattern.** The next real
change settles it at no extra cost:

1. the **first** post-relink build must run (`CACHED_COMMIT_REF` is unset — it cannot skip)
2. then one **app-only** push must produce **no new marketing deploy**:

```sh
netlify api listSiteDeploys --data '{"site_id":"a892e744-9dfc-45df-8cd4-8cd1b0c480b4","per_page":5}'
```

One build and one no-op — not three pushes.

## 5. ⭐ WHAT THE FIRST GIT DEPLOY MUST PROVE

**Exactly one thing: the served bytes equal the filed file.**

```sh
curl -s https://tikpema.xyz | md5sum        # must be c50f1a52649be897f7d3d3824f9d2515
md5sum site/index.html                      # c50f1a52649be897f7d3d3824f9d2515
```

⭐ This check is unusually strong here and it is worth saying why: **desktop == live == filed is
already established**, all three at `c50f1a52…`. So the first git deploy has a known-correct target
rather than a guess. **Any difference is a finding about the pipeline, not about the content** — it
would mean Netlify's build path altered bytes that drag-and-drop did not.

⚠️ And if the relinked site serves something different from what is live *now*, that is the finding
the brief anticipated — but note it can no longer mean "the live page and the desktop file disagree",
because they have been measured identical. It would mean the *pipeline* introduced the difference.

## 6. ⭐⭐ THE CONTROL THAT ACTUALLY CLOSES THE DRAG-AND-DROP HOLE

Linking git makes the repo the default publisher. It does **not** remove drag-and-drop — that path
stays available and still wins by being last. Two controls, and they are not equivalent:

- **Delete the desktop file.** Removes the *input*. Relies on discipline, and discipline is what
  failed for 66 days.
- ⭐ **`netlify api lockDeploy`.** Pins the published deploy so **no new deploy auto-publishes** —
  git or drop — until it is deliberately unlocked. This converts a drop from *"silently wins"* into
  *"cannot publish without a second, visible action."* ⚠️ It also gates the git deploys, so it is a
  posture choice, not a free win: publishing becomes deliberate for everyone.

⛔ **A detector is still needed either way**, because both controls are about preventing rather than
noticing: an exact-hash check of `tikpema.xyz` against `site/index.html`, runnable in one line
(§5). That is step three and is not built.
