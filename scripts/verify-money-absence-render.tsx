// verify-money-absence-render.tsx — ⛔ A DEFAULT ON A MONEY FIELD IS A CLAIM ABOUT AN ABSENCE.
//
//   npx tsx scripts/verify-money-absence-render.tsx   (also: npm run test:moneyabsence)
//
// ═══ 🚨 THE DEFECT ════════════════════════════════════════════════════════
// `agents.mjs` deliberately sends `spentTodayUsdc: null` when the day-spend read fails — the server
// got the tri-state right. `AgentsPanel` rendered `money(budget.spentTodayUsdc ?? 0)`, which turned
// "we could not read your spending" into "you have spent nothing", on the panel whose button is
// Pause All Agents. ⛔ FAIL-OPEN IN THE REASSURING DIRECTION: unknown headroom shown as ample.
//
// The same shape emptied the activity list: `auditLog().catch(() => [])` rendered as "Nothing yet
// today." — a claim that nothing happened, produced by a read that failed.
//
// ⭐⭐ THE RULE: a nullish-coalescing default on a money or spend field is a CLAIM ABOUT AN ABSENCE.
// Three states must survive to the screen — a figure, a confirmed zero, and "we could not read it".
// ⛔ And the third must never be rendered as the second, because only one of them is reassuring.

import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { readdirSync, readFileSync } from "node:fs";
import { AgentsBudgetLine } from "../src/components/AgentsPanel";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => { if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); } return !!c; };
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 54 - t.length))}`);
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

// ── THE DENOMINATOR, derived — never a hand-kept list ──────────────────────
const MONEYISH = /(Usdc|Balance|balance|Amount|amount|Spent|spent|Total|total|Fee|fee|Count|count)$/;
const fnFiles = readdirSync("netlify/functions").filter((f) => f.endsWith(".mjs"));
const nullable = new Set<string>();
let fieldsScanned = 0;
for (const f of fnFiles) {
  const src = readFileSync(`netlify/functions/${f}`, "utf8").replace(/^\s*\/\/.*$/gm, " ");
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([^,\n]+)/g)) {
    if (!MONEYISH.test(m[1])) continue;
    fieldsScanned++;
    // nullable if the value is `null`, a `?? null`, or a ternary with a null branch
    if (/(^|\W)null(\W|$)/.test(m[2])) nullable.add(m[1]);
  }
}
const clientFiles: string[] = [];
const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
  const p = `${d}/${e.name}`; if (e.isDirectory()) walk(p); else if (/\.(tsx|ts)$/.test(p)) clientFiles.push(p); } };
walk("src");
const collapsed: string[] = [];
const exempt: string[] = [];
for (const f of clientFiles) {
  // ⛔ NEWLINES PRESERVED WHEN STRIPPING. Replacing a block comment with a single space DELETES its
  // newlines and shifts every line number after it — this check reported :169 for a site at :175.
  // A guard that misreports WHERE is a guard someone will dismiss as wrong.
  const src = readFileSync(f, "utf8")
    // ⛔ `[ \t]*`, NOT `\s*` — `\s` matches NEWLINES, so a comment preceded by a blank line ate it
    // and every line number after drifted (this reported :169 for a site at :175). A guard that
    // misreports WHERE is one the next reader dismisses as broken.
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  for (const field of nullable) {
    const re = new RegExp(`\\b${field}\\s*\\?\\?\\s*0\\b|\\b${field}\\s*\\|\\|\\s*0\\b`, "g");
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split("\n").length;
      // ⚠️ THE MATCH IS BY NAME, AND A NAME IS NOT A PROVENANCE. `total` is nullable in one endpoint
      // and unrelated in another component. A site is EXEMPT only when the render is gated on an
      // explicit readable/status test — which is the distinction this rule asks for, satisfied a
      // different way. The reason is stated, not assumed.
      const ctx = src.slice(Math.max(0, m.index - 200), m.index + 80);
      const gated = /status\s*===\s*"ready"|Unreadable|=== *null|!= *null|unknown/i.test(ctx);
      if (gated) { exempt.push(`${f}:${line} ${field} (gated)`); continue; }
      collapsed.push(`${f}:${line} ${field}`);
    }
  }
}

section("1 — 📏 THE DENOMINATOR");
console.log(`     money-ish server fields scanned ${fieldsScanned} · nullable-by-server ${nullable.size} · client files ${clientFiles.length}`);
console.log(`     client renders of a nullable field: collapsed ${collapsed.length} · distinguished/gated ${exempt.length}`);
for (const e of exempt) console.log(`       ⭐ gated: ${e}`);
check("⭐ the scan found nullable money fields at all — a class check over nothing proves nothing",
  nullable.size > 0, [...nullable].slice(0, 8).join(", "));
check("⛔ no client render collapses a server-nullable money field to 0",
  collapsed.length === 0, collapsed.join(" · ") || `${collapsed.length} collapsed`);

section("2 — 🚨 THE THREE STATES, RENDERED (not inferred from source)");
{
  const unknown = strip(renderToStaticMarkup(
    <AgentsBudgetLine budget={{ spentTodayUsdc: null, ceilingUsdc: 2 }} allPaused={false} busy="" onToggleAll={() => {}} />));
  const zero = strip(renderToStaticMarkup(
    <AgentsBudgetLine budget={{ spentTodayUsdc: 0, ceilingUsdc: 2 }} allPaused={false} busy="" onToggleAll={() => {}} />));
  const spent = strip(renderToStaticMarkup(
    <AgentsBudgetLine budget={{ spentTodayUsdc: 0.42, ceilingUsdc: 2 }} allPaused={false} busy="" onToggleAll={() => {}} />));

  check("⛔ null renders as UNKNOWN, never as a number", /unknown/i.test(unknown) && !/0\.00/.test(unknown), unknown.slice(0, 78));
  check("🚨 …and says the headroom is unknown, NOT ample", /unknown, not ample/i.test(unknown));
  check("⭐ …and tells the user what to do about it", /pause/i.test(unknown));
  check("✅ a confirmed zero still renders as 0.00", /0\.00/.test(zero));
  check("🚨 …and a confirmed zero is NOT called unknown", !/unknown/i.test(zero), zero.slice(0, 70));
  check("✅ a real figure renders as itself", /0\.42/.test(spent) && !/unknown/i.test(spent));
  // ⭐⭐ PAIRWISE INEQUALITY. Both halves must differ from each other, not merely each contain a
  // phrase — a collapse is invisible to a phrase match because both states contain it.
  check("⭐⭐ …and the null and zero renders are NOT the same text", unknown !== zero);
}

section("3 — ⛔ AN EMPTY LIST MUST SAY WHY IT IS EMPTY");
{
  const panel = readFileSync("src/components/AgentsPanel.tsx", "utf8");
  check("the server tells the client which it is", /activityUnreadable/.test(readFileSync("netlify/functions/agents.mjs", "utf8")));
  check("⛔ …and the panel renders the unreadable case separately from 'Nothing yet today.'",
    /activityUnreadable \?/.test(panel) && /Nothing yet today/.test(panel));
  check("🚨 …and says the list is empty because the READ failed, not because nothing happened",
    /read failed, not\s*\n?\s*because nothing happened|because the read failed/.test(panel));
}

console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
if (!fail) console.log("⭐ An unreadable figure is never shown as zero.");
process.exit(fail ? 1 : 0);
