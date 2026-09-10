#!/usr/bin/env node
// record-guard-run.mjs — WRITE DOWN THAT A DELIBERATELY-UNWIRED GUARD ACTUALLY RAN.
//
//   node scripts/record-guard-run.mjs <npm-script-name>
//
// ═══ WHY IT IS CHAINED IN package.json AND NOT CALLED FROM INSIDE EACH GUARD ══════════════════
// Each unwired guard's npm script ends `&& node scripts/record-guard-run.mjs <name>`. Two
// properties come from the `&&` and neither is incidental:
//
//   ⭐ IT RECORDS ONLY ON SUCCESS. A guard that failed has not discharged its trigger, and a
//     ledger that recorded attempts would let a red run silence the very check that noticed.
//   ⭐ THE GUARD FILES ARE UNTOUCHED. Eight one-line edits inside eight guards would be eight
//     places to forget; one visible suffix per script sits where the wiring already lives, next to
//     the registration `gate:registry` already checks.
//
// ⚠️ THE HONEST BOUNDARY: `node scripts/verify-x.mjs` run DIRECTLY bypasses this and records
// nothing. That is a real gap, and the safe direction — an unrecorded run reads as still-owed, so
// the failure mode is a redundant re-run, never a false clean. The npm script is the documented
// invocation and the one every UNWIRED_OK reason names.
//
// ⚠️ AND IT NEVER FAILS THE RUN IT IS RECORDING. A ledger append that throws must not turn a green
// guard red — the guard's verdict is the guard's, not the bookkeeping's. It reports loudly and
// exits 0.

import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { UNWIRED_OK } from "./guard-registry.mjs";

const LOG_PATH = new URL("../unwired-guard-runs.jsonl", import.meta.url).pathname;
const name = process.argv[2];

if (!name) {
  console.error("record-guard-run: needs the npm script name, e.g. `record-guard-run.mjs test:ddraillive`");
  process.exit(2);
}

// 🚨 A NAME THAT IS NOT A DECLARED EXEMPTION IS A TYPO, AND A TYPO HERE IS SILENT. It would append
// a row nothing reads while the real guard stays permanently owed — the ledger would look busy and
// prove nothing. Refusing is loud and costs one run.
if (!UNWIRED_OK[name]) {
  console.error(`record-guard-run: "${name}" is not in UNWIRED_OK.`);
  console.error("  Only deliberately-unwired guards are tracked here. A name that is not declared");
  console.error("  would append a row nothing reads, while the guard it meant stays owed forever.");
  process.exit(2);
}

/** The commit the run happened at — provenance, and the base for the next "what changed" diff. */
function headCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 15_000 }).trim() || null;
  } catch {
    // ⚠️ null, never a guess. A wrong commit would make the next diff answer about the wrong range,
    // and guard-staleness treats an unresolvable base as OWED rather than clean.
    return null;
  }
}

const row = { name, at: new Date().toISOString(), commit: headCommit() };

try {
  appendFileSync(LOG_PATH, JSON.stringify(row) + "\n");
  console.log(`  📓 recorded: ${name} @ ${row.at}${row.commit ? ` (${row.commit.slice(0, 12)})` : " (commit UNRESOLVED)"}`);
} catch (e) {
  console.error(`  ⚠️ could not record the run of ${name}: ${e?.message?.split("\n")[0]}`);
  console.error("     The guard itself PASSED — this is a bookkeeping failure, and it is not");
  console.error("     allowed to redden a green guard. The run will still read as owed.");
}

process.exit(0);
