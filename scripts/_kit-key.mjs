// _kit-key.mjs — the ONE place a spike obtains KIT_KEY. Explicitly supplied, or a loud refusal.
//
// ═══ ⭐⭐ WHY THIS EXISTS: 18 SPIKES USED TO READ A LIVE PRODUCTION CREDENTIAL ══════════════════
// Every spike header used to say `KIT_KEY="$(netlify env:get KIT_KEY --context production)"`. That
// made a one-shot evidence script a standing consumer of prod, and it made the dependency tree —
// not the Netlify `is_secret` flag — the real exposure: 20 files pulling a key whose ONLY readable
// copy is Netlify (no `.env` entry, and Circle's console does not re-display a kit key).
//
// ⭐ THE FIX KEEPS THE EVIDENCE AND DROPS THE EXPOSURE. The spikes are the reproducibility of money
// claims (see README) — deleting them would turn recorded results into unverifiable ones. So the
// credential source changes, not the code: a spike now REQUIRES an explicitly-supplied key and
// fails loudly without one. Nothing here reaches for Netlify, ever.
//
// ═══ ⚠️ AND THE INSTRUCTIONS MUST NOT PUT THE KEY IN ARGV OR SHELL HISTORY ══════════════════════
// `KIT_KEY=… node spike.mjs` is the shape to avoid: the assignment lands in shell history, and on
// Linux a process's argv is world-readable via /proc/<pid>/cmdline. `read -rs` keeps the value out
// of history (only the word `read` is recorded) and out of argv (it becomes an exported env var,
// whose /proc/<pid>/environ is readable only by the same user). This is the same discipline the
// audit applied to the recovery-file passphrase — and the leak class it is aimed at is real: this
// repo's own history has 5 Discord webhook URLs inline.
//
// 🚨 NOT A FILE ON DISK, EITHER. A named env file holding a prod key just recreates the problem one
// level down — which is precisely what `.env` already is, and how the SESSION_SECRET divergence
// (`.env` 5f0d64e0… vs Netlify 96939992…) went unnoticed. Supplied per-run, held in no file.

export const KIT_KEY_VAR = "KIT_KEY";

/** ⭐ The verbatim form. The key CARRIES its own `KIT_KEY:` prefix — see WRONG_SHAPES below. */
const VERBATIM = /^KIT_KEY:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;

/** The prefix-stripped form, i.e. what `sed 's/^KIT_KEY://'` leaves behind. */
const STRIPPED = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;

export const HOWTO = [
  `  # Supply ${KIT_KEY_VAR} for this run only — paste at the prompt, nothing echoes:`,
  `  read -rs ${KIT_KEY_VAR} && export ${KIT_KEY_VAR}`,
  `  node --env-file=.env <this script>`,
  `  unset ${KIT_KEY_VAR}    # when you are done`,
  ``,
  `  ⚠️ Do NOT write \`${KIT_KEY_VAR}=… node …\` — that lands in shell history AND in argv`,
  `     (/proc/<pid>/cmdline is world-readable). Do NOT put it in .env or any other file.`,
  `  ⚠️ Do NOT source it from Netlify production. These are one-shot evidence scripts; they`,
  `     must not be standing consumers of a live credential. The key is issued (free, no KYC)`,
  `     from https://console.circle.com/api-keys — use a key you hold, not the deployed one.`,
];

function refuse(headline, detail) {
  console.error(`\n✖ ${headline}`);
  if (detail) console.error(`  ${detail}`);
  console.error(``);
  for (const l of HOWTO) console.error(l);
  console.error(``);
  process.exit(2);
}

/**
 * Return the verbatim KIT_KEY, or exit(2) with instructions. Never prints the value.
 *
 * ⚠️ THE CLOSED SET MATTERS MORE THAN ANY SINGLE CHECK. Each branch below is a way the key can be
 * WRONG WHILE LOOKING PRESENT — and a wrong-but-present key is the shape that produces a confusing
 * 401 three call-frames later instead of a refusal here.
 */
export function requireKitKey() {
  const raw = process.env[KIT_KEY_VAR];

  if (!raw || !raw.trim()) {
    refuse(`${KIT_KEY_VAR} is not set.`, `This script must be given its credential explicitly.`);
  }
  const key = raw.trim();

  // 🚨 THE `env:get` CONTAMINATION TRAP (caps-from-deployed-env-not-code-defaults): an UNSET Netlify
  // var makes the CLI print "No value set…" to STDOUT and exit 0, so `$(netlify env:get …)` yields a
  // NON-EMPTY string that a truthiness check accepts. Kept as a check even though we no longer tell
  // anyone to use env:get — because the old recipe is in git history and in people's shell history.
  if (/no value set/i.test(key)) {
    refuse(
      `${KIT_KEY_VAR} contains Netlify's "No value set" message, not a key.`,
      `That string arrives on STDOUT at exit 0, so a non-empty check accepts it. The var is unset.`
    );
  }

  // 🚨 THE sed-STRIP TRAP, PROVEN WRONG ONCE ALREADY. Five spike headers used to pipe the key through
  // `sed 's/^KIT_KEY://'`. The key ALREADY carries that prefix and the SDK sends it verbatim as
  // `Bearer ${apiKey}` — stripping it was the B1 v2 401. Named explicitly, because "401" alone sent
  // a previous session looking at auth scopes rather than at the value's shape.
  //
  // ⚠️ THE `startsWith` GUARD IS LOAD-BEARING, and its absence was caught by the suite rather than by
  // reading: `KIT_KEY` is itself a valid segment, so a key MISSING ITS SECRET HALF (`KIT_KEY:abc123`)
  // also matches STRIPPED. Without this clause the guard told such a user to prepend a prefix they
  // already had — advice that produces `KIT_KEY:KIT_KEY:abc123` and a worse failure. A wrong
  // diagnosis is more expensive than no diagnosis, because it is acted on.
  if (!VERBATIM.test(key) && !key.startsWith("KIT_KEY:") && STRIPPED.test(key)) {
    refuse(
      `${KIT_KEY_VAR} looks PREFIX-STRIPPED — it is missing its leading "KIT_KEY:".`,
      `Pass the key VERBATIM. It carries its own "KIT_KEY:" prefix; removing it (or re-prepending ` +
      `a second one) is the B1 v2 401. Do not sed it.`
    );
  }

  if (!VERBATIM.test(key)) {
    // ⚠️ Reported by SHAPE, never by value: length and prefix-presence are enough to act on.
    refuse(
      `${KIT_KEY_VAR} is malformed.`,
      `Expected KIT_KEY:<id>:<secret> (len=${key.length}, starts "KIT_KEY:"=${key.startsWith("KIT_KEY:")}).`
    );
  }

  return key;
}
