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
