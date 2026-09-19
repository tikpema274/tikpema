#!/usr/bin/env node
// gate-ledger.mjs — HEAD of deploy:prod. The two gate-baseline ledgers must be COMMITTED up to their last line.
//
//   node scripts/gate-ledger.mjs      (npm run gate:ledger — first link of deploy:prod)
//
// ═══ WHY (2026-09-19, f4a8016) ═══════════════════════════════════════════════════════════════════
// dd-refusal-window-log.jsonl and deploy-loss-log.jsonl are not just records — they are what two later
// gates READ: capture-refusal-window judges `rotated` against the log's last ddTree, and
// verify-deploy-loss-delta takes the loss log's last line as the baseline of its delta. The chain
// appends one line per deploy; committing them was a habit, and the habit lapsed for 14 deploys. A
// fresh clone was judging rotation against a four-day-old tree and the loss delta against a stale
// census, and nothing said so.
//
// ⭐ THREE OUTCOMES, NEVER CONFLATED:
//   up-to-date  — the committed content IS the working tree's content (nothing appended since) → pass
//   behind      — the working tree has N lines the commit does not → FAIL naming N and the file
//   unreadable  — missing (working tree or committed), empty, malformed last line, no timestamp field →
//                 FAIL with that reason. ⛔ Never "up to date": an unreadable baseline is exactly the
//                 condition the gates ran on silently. [[absence-must-never-read-as-safe]]
//   (rewritten  — the committed content is not a prefix of the working tree: someone edited history
//                 in an append-only ledger → FAIL; not "behind", because N would be a lie.)
//
// "The previous deploy" = the ledger's own last line: every deploy appends exactly one, so the number of
// uncommitted lines IS the number of deploys the commit is behind. READ-ONLY: `git show HEAD:<path>` +
// the working file. No network, no writes, no index changes.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** ⭐ ONE LIST, ONE PLACE — stage-ledger stages exactly these; nothing else may be added by either script. */
export const LEDGERS = Object.freeze([
  Object.freeze({ path: "dd-refusal-window-log.jsonl", timeField: "at" }),
  Object.freeze({ path: "deploy-loss-log.jsonl", timeField: "observedAt" }),
]);

const nonEmpty = (text) => String(text).split("\n").map((l) => l.trim()).filter(Boolean);

/** Parse the LAST non-empty line; { ok, at } or { ok:false, why }. */
function lastEntry(text, timeField) {
  const ls = nonEmpty(text);
  if (ls.length === 0) return { ok: false, why: "empty (no entries — no baseline)" };
  let j;
  try { j = JSON.parse(ls[ls.length - 1]); } catch { return { ok: false, why: `malformed last line (line ${ls.length} does not parse as JSON)` }; }
  const at = j?.[timeField];
  if (typeof at !== "string" || !at) return { ok: false, why: `last line has no "${timeField}" field` };
  return { ok: true, at, count: ls.length };
}

/**
 * Pure. committed/working are the file texts (null = absent). Returns
 *   { outcome: "up-to-date" | "behind" | "unreadable" | "rewritten", behind, reason }.
 */
export function assessLedger({ name, committed, working, timeField }) {
  if (committed === null || committed === undefined) return { outcome: "unreadable", behind: null, reason: `${name}: not in the committed tree (never committed, or deleted from HEAD)` };
  if (working === null || working === undefined) return { outcome: "unreadable", behind: null, reason: `${name}: missing from the working tree` };
  const c = lastEntry(committed, timeField);
  if (!c.ok) return { outcome: "unreadable", behind: null, reason: `${name}: committed ledger is ${c.why}` };
  const w = lastEntry(working, timeField);
  if (!w.ok) return { outcome: "unreadable", behind: null, reason: `${name}: working-tree ledger is ${w.why}` };
  const cl = nonEmpty(committed), wl = nonEmpty(working);
  const isPrefix = cl.length <= wl.length && cl.every((l, i) => l === wl[i]);
  if (!isPrefix) return { outcome: "rewritten", behind: null, reason: `${name}: the committed content is not a prefix of the working tree — an append-only ledger was edited; refusing to count it as merely behind` };
  const behind = wl.length - cl.length;
  if (behind === 0) return { outcome: "up-to-date", behind: 0, reason: `${name}: up to date (${cl.length} entries, last ${c.at})` };
  return { outcome: "behind", behind, reason: `${name}: ${behind} deploy${behind === 1 ? "" : "s"} BEHIND — committed last entry ${c.at}, working tree last entry ${w.at} — commit it before deploying` };
}

function committedText(path) {
  try { return execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("\ngate:ledger — the gate baselines must be committed to their last line\n");
  let bad = 0;
  for (const { path, timeField } of LEDGERS) {
    const working = existsSync(path) ? readFileSync(path, "utf8") : null;
    const r = assessLedger({ name: path, committed: committedText(path), working, timeField });
    const mark = r.outcome === "up-to-date" ? "✅" : "❌";
    console.log(`  ${mark} ${r.outcome === "unreadable" ? "UNREADABLE — " : r.outcome === "rewritten" ? "REWRITTEN — " : ""}${r.reason}`);
    if (r.outcome !== "up-to-date") bad++;
  }
  if (bad) {
    console.log(`\n❌ gate:ledger — ${bad} ledger(s) not at their committed last line. Commit them (npm run stage:ledger stages exactly these two), then deploy.\n`);
    process.exit(1);
  }
  console.log("\n✅ gate:ledger — both ledgers committed up to date.\n");
}
