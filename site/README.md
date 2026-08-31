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
   ⚠️ Confirm that empirically before trusting it — Netlify's `pretty_urls` post-processing is on
   (`processing_settings.html.pretty_urls: true`) and must be shown not to alter the bytes.

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

The claim-by-claim audit is `docs/marketing-site-claim-audit.md`. ⛔ The content moves **as-is**, so
the rewrite is a reviewable diff against a filed original.
