# `docs/baselines/` — captured production artifacts, for comparison

## ⛔ WHY THESE ARE NOT IN `site/`

`site/` is the **publish directory** for `tikpema.xyz`. Anything placed there is **served**, so a
baseline copy filed alongside the page would be publicly reachable at
`tikpema.xyz/baselines/…` — a stale duplicate of the site, served by the site, indexable. A snapshot
taken to detect drift must not itself become a second live copy.

## `tikpema.xyz-2026-08-31.html`

The live page, captured **before any relink and before any redeploy**, because that window closes the
moment anything publishes.

| | |
|---|---|
| fetched | 2026-08-31, `HTTP/2 200`, `content-length: 11682` |
| md5 | `c50f1a52649be897f7d3d3824f9d2515` |
| sha256 | `89534fa5a9911ad223e6e50d24348982cf8b0d24a677ba803da2698db929d501` |
| etag | `"95388eae27f91fd63e4744847051630a-ssl"` |
| served by | deploy `6a3dcab684a82ae844dd6639` — the permalink returns the same md5, so the apex is that deploy and not another host |
| that deploy | `manual_deploy: true`, `deploy_source: "drop"`, published 2026-06-26T00:41:28Z |

## ⭐ THE ORDERING QUESTION, AND WHY THE ANSWER IS SOUND

The concern behind capturing this first: *if the desktop file is seen first, the comparison degrades
from "did the site drift?" into "did I paste the right thing?"*

**The live hash was measured before the desktop file was ever read**, and the record shows it:

1. the apex and the deploy permalink were fetched and hashed — `c50f1a52…`, both
2. **only then** was `/mnt/c/Users/salifu/Homepage/index.html` opened — `c50f1a52…`

⭐ And the desktop file was **read from disk over WSL, never pasted**, which removes the transcription
risk the ordering rule exists to guard against. This file commits that measurement as an artifact
rather than leaving it in a terminal.

## THE COMPARISON — all three agree

```
c50f1a52649be897f7d3d3824f9d2515   docs/baselines/tikpema.xyz-2026-08-31.html   (live)
c50f1a52649be897f7d3d3824f9d2515   site/index.html                              (filed, from desktop)
c50f1a52649be897f7d3d3824f9d2515   /mnt/c/Users/salifu/Homepage/index.html      (desktop source)
```

**Outcome 1 of the three: identical.** The desktop file *is* what serves. There are no unshipped
changes in either direction, and nothing needs adjudicating before the relink.

⚠️ Corroborated by timestamps independently of the hashes: the desktop file was last modified
2026-06-26T00:39Z and the deploy published 00:41:26Z — **two minutes later**, and neither has changed
since. The two instruments agree, and they could have disagreed.

## ⭐ WHAT THIS BASELINE IS FOR, NOW THAT IT IS NOT A DRIFT REPORT

It stops being a comparison against the desktop file and becomes the **pre-relink reference**: the
first git-sourced deploy must reproduce `c50f1a52…` exactly. Any difference after the relink is
attributable to the **pipeline**, not to the content — which is a sharper question than the one this
capture was originally taken to answer, and only answerable because the capture exists.

## ⭐ THE ACCEPTANCE HASH — resolved 2026-08-31

A target of `1a17f1477e8f4a5a67757d5028d3855a8a1bd45c8a8bfbd63498c56c3a5343a4` was proposed twice as
the value the first repo deploy must reproduce. It matched **nothing**: not the live fetch, not
`site/index.html`, not the desktop source, not any `.html` in the repo, and not any file in
`C:\Users\salifu\Homepage\`. Confirmed by `certutil -hashfile … SHA256` on Windows, which returned
**`89534fa5…`** — so WSL and Windows agree about the bytes, and the mismatch was not a mount artefact.

**It came from an older draft of the page.** ⚠️ Which is itself worth recording: **another copy of
this page exists outside git, with different bytes.** It is not the live one and not the desktop one,
but it is a third copy, and untracked copies are what this whole exercise is about. If it still
exists, it belongs either in `docs/baselines/` with a date or in the bin — not loose.

⛔ **The acceptance criterion is `89534fa5a9911ad223e6e50d24348982cf8b0d24a677ba803da2698db929d501`**,
supported by five independent reads. Had `1a17f147…` been adopted at face value, the first
post-relink check would have gone **red against a correct deploy**, and sent us hunting a pipeline
fault that does not exist. [[a-deploy-check-needs-a-build-it-should-fail-against]]
