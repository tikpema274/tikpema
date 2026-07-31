// backtest-citation-derivation.mjs — how many historical briefs would now REFUND?
//
//   node scripts/backtest-citation-derivation.mjs <dir-of-job-json>
//
// The derivation is a pure function over (retrieval set, answer text), and stored job
// records hold both. So the false-empty rate is measurable rather than arguable.
//
// ⚠️ TWO REASONS THIS IS AN UPPER BOUND, NOT AN ESTIMATE — it should read HIGH:
//   1. Historical `brief.sources` IS the retrieval set: the old code overwrote the model's
//      own sources array with everything Exa returned. So the model's citation claim —
//      derivation signal (a) — IS NOT RECOVERABLE for any past job. Only inline [n] markers,
//      signal (b), can be replayed. Live, BOTH signals apply, and either alone suffices.
//   2. These jobs predate the "reference each source INLINE as [n]" prompt instruction, so
//      they had no reason to emit markers at all.
// A brief counted empty here could still be non-empty live. The reverse cannot happen.
//
// Read-only. No network. No money.

import { readFileSync, readdirSync } from "node:fs";

const dir = process.argv[2];
if (!dir) { console.error("usage: node scripts/backtest-citation-derivation.mjs <dir>"); process.exit(2); }

// ── the derivation, marker-half only (see note 1 above) ──────────────────────────────────────
const normUrl = (u) => String(u || "").trim().replace(/[/#?]+$/, "").toLowerCase();
function deriveMarkersOnly(brief, retrieved) {
  const prose = `${brief.answer || ""}\n${brief.reasoning || ""}`;
  const marked = new Set([...prose.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]) - 1));
  return {
    cited: retrieved.filter((_, i) => marked.has(i)),
    markers: [...marked].map((i) => i + 1).sort((a, b) => a - b),
  };
}

const rows = [];
let skippedNoBrief = 0, skippedNoSources = 0, unparseable = 0;

for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  let rec;
  try { rec = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")); }
  catch { unparseable++; continue; }
  const brief = rec?.brief;
  if (!brief || typeof brief.answer !== "string") { skippedNoBrief++; continue; }
  const retrieved = Array.isArray(brief.sources) ? brief.sources : null;
  if (!retrieved || retrieved.length === 0) { skippedNoSources++; continue; }

  const { cited, markers } = deriveMarkersOnly(brief, retrieved);
  rows.push({
    jobId: f.replace(/\.json$/, ""),
    status: rec.status,
    retrieved: retrieved.length,
    cited: cited.length,
    markers,
    // markers that point outside the retrieval set — a citation we could not resolve
    danglingMarkers: markers.filter((m) => m > retrieved.length),
    answer: brief.answer,
  });
}

const shipped = rows.filter((r) => r.status === "completed" || r.status === "rejected");
const empties = rows.filter((r) => r.cited === 0);
const emptiesShipped = shipped.filter((r) => r.cited === 0);
const pct = (a, b) => (b === 0 ? "n/a" : ((a / b) * 100).toFixed(1) + "%");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BACKTEST — how many past briefs would the citation guard refund?    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝\n");
console.log("CORPUS");
console.log("  job records read            :", readdirSync(dir).filter((f) => f.endsWith(".json")).length);
console.log("  unparseable                 :", unparseable);
console.log("  no brief / no answer        :", skippedNoBrief, "(never reached the guard)");
console.log("  brief but no sources array  :", skippedNoSources);
console.log("  ⭐ EVALUABLE                 :", rows.length);
console.log("     …of which reached a terminal state (completed/rejected):", shipped.length);

console.log("\nRESULT (upper bound — marker signal only)");
console.log("  would yield EMPTY sources   :", empties.length, "of", rows.length, `(${pct(empties.length, rows.length)})`);
console.log("  …restricted to terminal jobs:", emptiesShipped.length, "of", shipped.length, `(${pct(emptiesShipped.length, shipped.length)})`);
console.log("  would keep ≥1 cited source  :", rows.length - empties.length, `(${pct(rows.length - empties.length, rows.length)})`);

const withMarkers = rows.filter((r) => r.markers.length > 0);
console.log("\nDIAGNOSTIC");
console.log("  briefs emitting ANY [n] marker:", withMarkers.length, `(${pct(withMarkers.length, rows.length)})`,
  "— live, the prompt now asks for these explicitly");
const dangling = rows.filter((r) => r.danglingMarkers.length > 0);
console.log("  briefs with DANGLING markers  :", dangling.length,
  dangling.length ? `(e.g. job ${dangling[0].jobId}: markers ${JSON.stringify(dangling[0].markers)} vs ${dangling[0].retrieved} retrieved)` : "");
const avgDrop = rows.filter((r) => r.cited > 0);
if (avgDrop.length) {
  const tot = avgDrop.reduce((a, r) => a + r.retrieved, 0), cit = avgDrop.reduce((a, r) => a + r.cited, 0);
  console.log(`  on NON-empty briefs, the list shrinks ${tot} → ${cit} sources`,
    `(${pct(cit, tot)} retained) — the retrieved≠supporting effect`);
}

console.log("\nSAMPLE OF EMPTIES (would refund):");
for (const r of empties.slice(0, 5)) {
  console.log(`  · job ${r.jobId} [${r.status}] retrieved=${r.retrieved} markers=${JSON.stringify(r.markers)}`);
  console.log(`      answer: ${String(r.answer).replace(/\s+/g, " ").slice(0, 150)}…`);
}
console.log("\nSAMPLE OF SURVIVORS (would ship, with a shorter list):");
for (const r of rows.filter((x) => x.cited > 0).slice(0, 3))
  console.log(`  · job ${r.jobId} [${r.status}] ${r.retrieved} retrieved → ${r.cited} cited, markers ${JSON.stringify(r.markers)}`);
