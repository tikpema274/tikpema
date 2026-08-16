# Running the suites

    npm run test:all

⭐⭐ **READ THE EXIT CODE. NEVER GREP THE OUTPUT.**

This rule is written down twice from two separate incidents, and it failed both times because it was
a rule rather than a mechanism:

1. **The bridge-suite incident** — a suite's result was inferred from its printed summary.
2. **2026-08-15** — suites were verified with `grep -c "FAILURES"`, treating `0` as green. ⚠️ **A
   CRASH PRINTS NO SUMMARY LINE AT ALL**, so a crashing suite counted as passing and "bridge green"
   was reported while `verify-agent-quote-record.mjs` was dying on an empty-array index.

`test:all` exists so there is nothing to grep: one command, one exit code, `&&`-chained so the first
failure stops the run and the shell's `$?` is the whole answer.

    npm run test:all && echo PASS || echo FAIL

⚠️ **A suite that crashes and a suite that reports failures are the same outcome** — non-zero — and
that is the point. Any check that can tell them apart by reading text can also be defeated by text.

## Time-dependent fixtures

⭐ Never hardcode a wall-clock literal a retention rule will age past. On 2026-08-15 a fixture
`quotedAt: "2026-08-01T…"` crossed `QUOTE_TTL_MS` (14 days) and the quote suite began failing with no
code change — and it was **unbisectable by re-running old commits**, because a `Date.now()`-relative
test fails at every commit once the boundary passes. Derive fresh dates from `Date.now()`, and test
boundaries deliberately with an injected clock (`pruneOwnerQuotes(owner, now)` takes one).

## ⭐⭐ SHELL COMPOSITION — a failed step must stop the chain

**Named three times on 2026-08-16, so it gets a mechanism rather than a fourth naming.** All three
were caught by checking what LANDED, never by the shell stopping:

1. a `python3` heredoc edit asserted out — and the `git commit` on the next line ran anyway, so the
   message described a section that was not in the file
2. the same thing again, one hour later
3. backticks inside a double-quoted `git commit -m "…"` — bash executed the backticked span as a
   COMMAND. It happened to be `netlify env:set …` against a production credential; it errored on
   invalid arguments and changed nothing, but nothing about the construction guaranteed that

**THE RULES:**
- `set -euo pipefail` at the top of every multi-step shell invocation. A failing step then stops the
  chain instead of letting the next one report success about work that never happened.
- **Commit messages ONLY via `git commit -F- <<'MSG'`** — a QUOTED heredoc. Never `-m "…"`. The
  quoted delimiter disables substitution entirely, which retires the backtick class by construction
  rather than by remembering to escape.
- ⚠️ Beware `$?` after a pipe: it is the LAST command's status. `cmd | tail` reports `tail`'s
  success. Same family as the grep-for-green rule above, and it recurred on the same day.

⚠️ **THIS IS WEAKER THAN `test:all`, AND SAYING SO IS THE POINT.** That rule became mechanical
because a real gate existed — one chained command, one exit code, nothing to grep. No repo-side hook
can see how a shell command is composed before it runs, so this is a discipline backed by a written
rule, not an enforced gate. Recorded here so the next session inherits it rather than rediscovering
it a fourth time.
