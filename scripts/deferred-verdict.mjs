#!/usr/bin/env node
// deferred-verdict.mjs — run a REPORTING gate, then the steps that must run regardless, then exit with the gate's code.
//
//   node scripts/deferred-verdict.mjs gate:forgery -- gate:spec gate:deployloss stage:ledger
//
// ═══ ⭐ WHY (2026-10-02) ═════════════════════════════════════════════════════════════════════════════════════════
// gate:forgery runs after the deploy is LIVE. It reports (PASS 0 / FAIL 1 / UNTESTED 3); it cannot undo the deploy.
// In a plain `&&` chain its red also stopped gate:spec, gate:deployloss and stage:ledger, so the ledgers were never
// staged and the NEXT deploy's gate:ledger refused it as BEHIND: a reporting gate turned into an outage of the deploy
// path. Now the gate's red is DEFERRED to the end, not dropped: the chain still exits with the gate's own code, so the
// deploy log keeps saying which red (FAIL vs UNTESTED), and the closing summary points back at its VERDICT line.
//
// ⭐ The steps after `--` keep `&&` semantics among themselves: a red one stops the rest, exactly as before.
// ⛔ Fails closed: a step that could not be started, or was killed, is a red (exit 1), never a pass. Bad usage → exit 2.
// Test: `npm run test:deferredverdict` (runs the REAL deploy:prod:chain string with a stubbed npm).

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
const gate = sep === 1 ? args[0] : null;
const rest = sep === 1 ? args.slice(2) : [];
if (!gate || rest.length === 0) {
  console.error("usage: node scripts/deferred-verdict.mjs <gate> -- <step> [<step> …]   (npm script names)");
  process.exit(2);
}

// Runs `npm run <name>` with inherited stdio; a spawn error or a signal is a red (1), never 0.
function run(name) {
  const r = spawnSync("npm", ["run", name], { stdio: "inherit" });
  if (r.error) { console.error(`[deferred-verdict] could not start npm run ${name}: ${r.error.message}`); return 1; }
  if (r.status === null) { console.error(`[deferred-verdict] npm run ${name} was killed (${r.signal})`); return 1; }
  return r.status;
}

const results = [];
const g = run(gate);
results.push([gate, g]);
if (g !== 0) console.log(`\n[deferred-verdict] ${gate} exited ${g}: its red is DEFERRED to the end; running ${rest.join(", ")} first.\n`);

let restCode = 0;
for (const step of rest) {
  if (restCode !== 0) { results.push([step, null]); continue; }
  const c = run(step);
  results.push([step, c]);
  if (c !== 0) restCode = c;
}

const exit = g !== 0 ? g : restCode;
console.log(`\n${"─".repeat(72)}\n[deferred-verdict] summary`);
for (const [name, code] of results) console.log(`  ${code === null ? "·" : code === 0 ? "✓" : "✗"} ${name}: ${code === null ? "NOT RUN" : `exit ${code}`}`);
if (g !== 0) console.log(`\n  ⛔ ${gate} exited ${g} — see its VERDICT line above. The steps after it ran anyway; this chain exits ${exit}.`);
else if (restCode !== 0) console.log(`\n  ⛔ a step after ${gate} failed; this chain exits ${exit}.`);
console.log("─".repeat(72));
process.exit(exit);
