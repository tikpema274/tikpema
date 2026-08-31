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
