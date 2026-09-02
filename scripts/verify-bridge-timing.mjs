// verify-bridge-timing.mjs — ⛔ NO SURFACE MAY STATE A SETTLEMENT DURATION IT DID NOT DERIVE.
//
//   node scripts/verify-bridge-timing.mjs   (also: npm run test:bridgetiming)
//
// ═══ 🚨 SIX SURFACES, TWO CONTRADICTORY ANSWERS — AND NEITHER WAS RIGHT ════
// The agent consent screen said the destination mint follows in "~1–2 min". The self-signed and
// manual panels said "a few minutes (up to ~20 for some chains)". Same event, two promises, with the
// OPTIMISTIC one on the screen where a user ticks a box and funds leave.
//
// ⛔ AND ALIGNING ON THE PESSIMISTIC STRING WOULD HAVE BEEN WRONG. Measured Arc→Base settlements:
// 21s, 25s, 29s (PROGRESS.md:12642, :16878). The code's OWN bound is MINT_DEADLINE_MS = 4 minutes
// (_bridge-receipts.mjs) — "how long a forwarded mint gets before we stop claiming it is merely
// still going" — matched independently by MAX_POLLS(48) × POLL_MS(5s) on the plan path. A page
// promising "up to ~20" describes a state the receipt system has ALREADY flagged as overdue for
// sixteen minutes. The copy would have contradicted the bands.
//
// ⭐⭐ BridgePanel had already spotted the class: "this wording is VERBATIM the manual panel's, so the
// two do not quote the range differently." That alignment covered three surfaces and missed FOUR —
// which is what alignment-by-copying does. A constant makes an EIGHTH surface unable to disagree.
//
// ⭐ THE SCAN IS DERIVED. It walks every client and server file for time-range literals sitting near
// bridge/mint copy, rather than checking the seven known sites — a new surface is covered the moment
// it exists.

import { readdirSync, readFileSync } from "node:fs";
import { MINT_DEADLINE_MINUTES, MINT_TIMING, BRIDGE_TIMING } from "../shared/bridge-timing.mjs";

let pass = 0, fail = 0;
const check = (l, c, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

section("1 — ⛔ THE CONSTANT AGREES WITH THE DEADLINE THE CODE ENFORCES");
{
  const src = read("netlify/functions/_bridge-receipts.mjs");
  const m = /MINT_DEADLINE_MS\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/.exec(src);
  check("⭐ MINT_DEADLINE_MS is readable from _bridge-receipts.mjs", !!m, m?.[0]);
  // ⛔ A COUNT OF ZERO IS NOT A COUNT — if the expression moves, fail rather than compare against 0.
  const ms = m ? Number(m[1]) * Number(m[2]) * Number(m[3]) : 0;
  check("🚨 …and MINT_DEADLINE_MINUTES equals it", ms > 0 && MINT_DEADLINE_MINUTES === ms / 60_000,
    `${MINT_DEADLINE_MINUTES} min vs ${ms / 60_000} min`);
  check("⭐ the copy states that bound rather than inventing one",
    MINT_TIMING.includes(String(MINT_DEADLINE_MINUTES)), MINT_TIMING);
}

section("2 — 📏 EVERY SURFACE THAT NAMES A DURATION DERIVES IT");
{
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) { if (/node_modules|dist|\.git/.test(p)) continue; walk(p); }
    else if (/\.(tsx?|mjs)$/.test(p)) files.push(p); } };
  walk("src"); walk("netlify/functions");

  // A duration stated in prose: "~1–2 min", "a few minutes", "up to ~20", "in 3 minutes".
  const DURATION = /(~?\s*\d+\s*[–-]\s*\d+\s*min|a few minutes|up to\s*~?\s*\d+|\bin\s+~?\d+\s*(min|minutes|seconds|s)\b)/i;
  const BRIDGEY = /mint|bridge|burn|settle|arriv/i;
  const scanned = [], hardcoded = [], derived = [], exempt = [];
  for (const f of files) {
    if (f.endsWith("bridge-timing.mjs")) { exempt.push(`${f} (the source itself)`); continue; }
    const raw = readFileSync(f, "utf8");
    // ⛔ TRAILING comments stripped too. `const MAX_POLLS = 48; // ~4 min; typically 1–2 min` is a
    // note to a developer, not a promise to a user — and a whole-line-only strip flagged it as copy.
    // ⚠️ The `[^:"'`]` guard keeps `https://` intact.
    const src = raw
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/([^:"'`])\/\/[^\n]*/g, "$1");
    if (!BRIDGEY.test(src)) continue;
    scanned.push(f);
    if (/BRIDGE_TIMING|MINT_TIMING|MINT_DEADLINE_MINUTES/.test(src)) derived.push(f);
    for (const line of src.split("\n")) {
      if (!DURATION.test(line) || !BRIDGEY.test(line)) continue;
      // ⚠️ A retry/poll INTERVAL is not a claim to a user. Only prose in a rendered string counts.
      if (/POLL|MAX_POLLS|RETRY|DEADLINE_MS|setTimeout|interval|schedule|cron/i.test(line)) continue;
      const n = src.slice(0, src.indexOf(line)).split("\n").length;
      hardcoded.push(`${f}:${n} ${line.trim().slice(0, 52)}`);
    }
  }
  console.log(`     bridge-related files ${scanned.length} · derive the constant ${derived.length} · HARDCODED ${hardcoded.length} · exempt ${exempt.length}`);
  check("⭐ the scan found bridge surfaces at all", scanned.length > 0, `${scanned.length} files`);
  check("⭐ …and at least one derives the constant", derived.length > 0, derived.map((f) => f.split("/").pop()).join(", "));
  check("⛔ no surface states a settlement duration it did not derive",
    hardcoded.length === 0, hardcoded.join(" · ") || "none hardcoded");
}

section("3 — 🚨 EVERY SURFACE FOLLOWS THE CONSTANT, so they cannot disagree");
{
  // ⭐ Named sites, asserted to IMPORT rather than to contain a phrase — a phrase check would pass a
  // surface that imports the constant and then prints its own number anyway.
  const SITES = [
    "src/components/MyAgentPanel.tsx", "src/components/BridgePanel.tsx",
    "src/components/BridgeQuoteSummary.tsx", "src/components/ManualBridgePanel.tsx",
    "netlify/functions/agent-act.mjs",
  ];
  for (const f of SITES)
    check(`⭐ ${f.split("/").pop()} imports the one source`, /bridge-timing\.mjs"/.test(read(f)));
  check("⭐⭐ …and the two halves are one sentence, so burn and mint cannot drift apart",
    BRIDGE_TIMING.includes(MINT_TIMING));
}

console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
if (!fail) console.log("⭐ One settlement range, derived from the deadline the code enforces.");
process.exit(fail ? 1 : 0);
