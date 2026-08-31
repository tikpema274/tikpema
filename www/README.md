# `www/` — the marketing site (tikpema.xyz)

**The page that lives here is NOT the app.** The app is `src/` → `app.tikpema.xyz`. This is the
public marketing page at the apex domain.

## Why it moved here

It was a single HTML file on a desktop, outside the repo, outside every guard, deployed by hand —
Netlify site `tikpema`, **no repo link, no build command, no publish dir**, published
**2026-06-26T00:41:28Z**. ⚠️ **66 days before the audit that found four false claims on it.** No
suite renders it, no gate greps it, `scripts/guard-registry.mjs` does not list it. That is why it
drifted, and it drifted in the direction this project guards hardest: claims about money.

The claim-by-claim audit is `docs/marketing-site-claim-audit.md`. ⛔ **The content was moved as-is.**
Filing the original unchanged is what makes the rewrite a reviewable diff instead of a replacement.

## ⛔ Why this directory is deliberately OUTSIDE `SURFACES`

`scripts/stamp-build.mjs` defines `SURFACES = ["netlify/functions", "shared", "src"]` — the files
whose bytes form the app's deploy identity. `www/` is outside it **on purpose**:

- ⭐ a marketing copy edit must not rotate the app's tree hash or force an app redeploy
- ⭐ `src/` is bundled by vite; a page in there would end up inside the app bundle

⚠️ **AND THE COST, STATED RATHER THAN DISCOVERED LATER:** outside `SURFACES` also means
`gate:deployed` will never bind this page, and the build stamp will never cover it. **Moving the file
into git buys history, review and a filed original. It does NOT buy guard coverage.** That is a
separate step and needs its own instrument — a served-fragment check against `tikpema.xyz`, the same
species as `gate:custody` and `gate:disclosure`. [[build-stamp-excludes-manifests]]

## Deploying from here

| | |
|---|---|
| Netlify site | `tikpema` |
| site id | `a892e744-9dfc-45df-8cd4-8cd1b0c480b4` |
| domain | `tikpema.xyz` (no aliases) |
| account | `salifuimorosandow` — the same account as the app, a **different site** |

```sh
# from www/, so this directory's netlify.toml is the one the CLI reads
netlify deploy --dir=. --site=a892e744-9dfc-45df-8cd4-8cd1b0c480b4            # DRAFT first
netlify deploy --prod --dir=. --site=a892e744-9dfc-45df-8cd4-8cd1b0c480b4     # only after reading the draft
```

⛔ **No `npm run deploy:site` script exists yet, deliberately.** A script pointing at this directory
before the page is in it would publish an empty site — i.e. **take tikpema.xyz down**. Add the script
in the same commit as the HTML, never before it.

⚠️ **Prove the draft before the first `--prod`**, and specifically read the draft's **function list**:
the containment above is an assumption about cwd resolution, not a measured fact, and the thing it is
containing is the app's money-moving `/api/*` surface.

## ⭐ Why a separate site, not an alias on the app

- the app's deploy chain runs `test:all` and ~25 min of bundling; a copy typo must not wait for it,
  and must not be blocked by an unrelated red suite
- conversely, a marketing deploy must never be able to publish app code
- separate sites keep the two blast radii apart, which is the whole point
