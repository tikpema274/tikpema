// _prod-session.mjs — obtain a PROD-trusted session token for an authenticated probe.
//
// ═══ ⭐⭐ WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════
// `scripts/probe-ub-auth.mjs` and `scripts/fire-ub-spend.mjs` were untracked and are GONE. The method
// they implemented survived only as prose in PROGRESS.md, which meant the next authenticated prod
// probe would have had to re-derive it — including the two traps that cost real runs last time.
// This module is the method, in code, tested.
//
// ═══ 🚨 THE DEFECT THIS EXISTS TO PREVENT: MINTING A **DEV** TOKEN AGAINST PROD ═════════════════
// `.env` holds a SESSION_SECRET and it is NOT prod's (local `5f0d64e0…`, prod `96939992…` — a
// divergence that is accidental in origin and deliberately retained; see
// docs/CIRCLE_ENTITY_SECRET_AUDIT.md). So `node --env-file=.env probe.mjs` mints a token signed with
// the DEV secret, prod returns 401, and — this is the expensive part — **401 reads exactly like an
// auth bug in the endpoint**. That is not hypothetical: PROGRESS.md:7511 records a session lost to
// it, concluding "the browser-console token method failing earlier was the same root cause, not an
// endpoint bug."
//
// ⭐ SO THE GUARD COMPARES THE SUPPLIED SECRET AGAINST `.env`'s AND REFUSES ON A MATCH. A probe that
// cannot tell "your token is wrong" from "the endpoint is broken" produces confident wrong findings,
// and this is the one comparison that separates them BEFORE the request is sent.
//
// ═══ ⚠️ THE EMPTY-VAR TRAP, WHICH BEAT `--env-file` AND KILLED THREE RUNS ════════════════════════
// `netlify env:get` emits a trailing blank line, so `| tail -1` yields "" → an EXPORTED EMPTY
// SESSION_SECRET → and an exported empty var BEATS `--env-file`. The runner then died with no
// capture and no HTTP call at all. An empty value must therefore be a loud refusal, never a
// falsy-and-move-on. (PROGRESS.md:9034.)
//
// ═══ 🚨 THE READBACK DEPENDENCY, STATED ═════════════════════════════════════════════════════════
// Prod's SESSION_SECRET is readable ONLY from Netlify. That is the same shape as KIT_KEY's 20-file
// tree, and it is why `is_secret` is HELD on SESSION_SECRET: flipping it kills authenticated prod
// probing outright, leaving only a real browser login (challenge → sign → verify).

import { readFileSync, existsSync } from "node:fs";

export const SECRET_VAR = "SESSION_SECRET";

/** Read `.env`'s SESSION_SECRET without importing it into the process env. Null if absent. */
function devSecretFromEnvFile(path = ".env") {
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*SESSION_SECRET\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

export const HOWTO = [
  `  # The PROD secret is readable only from Netlify. Supply it for this run only:`,
  `  read -rs ${SECRET_VAR} && export ${SECRET_VAR}`,
  `  node <this script>            # note: NO --env-file=.env — that loads the DEV value`,
  `  unset ${SECRET_VAR}`,
  ``,
  `  # To see the prod value to paste (it is not stored anywhere else):`,
  `  netlify env:get ${SECRET_VAR} --context production | grep -vE '^\\s*$' | tail -1`,
  ``,
  `  ⚠️ Do NOT write \`${SECRET_VAR}=… node …\` — that lands in shell history AND argv.`,
  `  ⚠️ Do NOT pass --env-file=.env — .env's ${SECRET_VAR} is the DEV value and prod will 401.`,
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
 * Return a secret that is plausibly PROD's, or exit(2). Never prints the value.
 *
 * ⚠️ "Plausibly" is the honest word. Nothing here can PROVE a secret is prod's — only the server can,
 * by accepting the token. What this rules out is every locally-detectable way of being wrong, so a
 * 401 that survives these checks is evidence about the SERVER rather than about the caller.
 */
export function requireProdSessionSecret({ envFile = ".env" } = {}) {
  const raw = process.env[SECRET_VAR];

  // ⚠️ Empty BEFORE missing: an exported empty var is a DIFFERENT failure from an unset one, it beats
  // --env-file, and conflating them hides the trap that killed three runs.
  if (raw !== undefined && !String(raw).trim()) {
    refuse(
      `${SECRET_VAR} is set but EMPTY.`,
      `An exported empty var overrides --env-file, so nothing downstream can recover. This is the ` +
      `\`| tail -1\` trap: \`netlify env:get\` emits a trailing blank line. Use ` +
      `\`| grep -vE '^\\s*$' | tail -1\`.`
    );
  }
  if (!raw) refuse(`${SECRET_VAR} is not set.`, `An authenticated prod probe must be given prod's secret explicitly.`);

  const secret = String(raw).trim();

  if (/no value set/i.test(secret)) {
    refuse(
      `${SECRET_VAR} contains Netlify's "No value set" message, not a secret.`,
      `That string arrives on STDOUT at exit 0, so a non-empty check accepts it.`
    );
  }

  // Matches _auth.mjs, which disables auth below 16 chars rather than signing weakly.
  if (secret.length < 16) {
    refuse(`${SECRET_VAR} is too short (${secret.length} chars).`, `_auth.mjs requires >= 16 or auth is disabled.`);
  }

  // 🚨 THE ONE THAT MATTERS. See the header.
  const dev = devSecretFromEnvFile(envFile);
  if (dev && dev === secret) {
    refuse(
      `${SECRET_VAR} is the DEV value from ${envFile} — prod will reject every token minted with it.`,
      `Prod's secret differs from .env's by long-standing design-in-retention. Minting with the dev ` +
      `value yields a 401 that is indistinguishable from an endpoint bug, which has already cost one ` +
      `session. Supply prod's value instead (see below), and do not pass --env-file.`
    );
  }

  return secret;
}

/**
 * Mint a session token using the REAL `issueSession` from the deployed auth module.
 *
 * ⭐⭐ IT IMPORTS `_auth.mjs` RATHER THAN REIMPLEMENTING THE HMAC. A probe that hand-rolls the token
 * format proves only that the probe and the server agree about a format the probe invented — and it
 * would keep passing after a real change to the signing scheme. The point of this probe is to
 * exercise the server's actual contract, so it must mint the way the server mints.
 *
 * The secret is injected into `process.env` in-process only, restored immediately, and never printed
 * or written to disk.
 */
export async function mintProdToken({ address, method = "metamask", secret }) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
    throw new Error(`mintProdToken needs a 0x… address (got ${JSON.stringify(address)})`);
  }
  const prev = process.env[SECRET_VAR];
  process.env[SECRET_VAR] = secret;
  try {
    const { issueSession } = await import("../netlify/functions/_auth.mjs");
    return issueSession({ address, method });
  } finally {
    if (prev === undefined) delete process.env[SECRET_VAR];
    else process.env[SECRET_VAR] = prev;
  }
}
