// verify-agent-panel-copy.tsx — THE AGENT PANEL'S CLAIMS, RENDERED, BOTH DIRECTIONS.
//
//   npx tsx scripts/verify-agent-panel-copy.tsx        (also: npm run test:copy)
//
// ═══ 🚨 WHY THIS EXISTS ══════════════════════════════════════════════════════════════════════
// `MyAgentPanel` is the largest surface in the app (797 lines) and was second on the guard
// registry's debt list: claim-bearing copy on the money path that no suite rendered. It is the
// page where a user hands an autonomous agent a task that moves their funds, so its two jobs are
// to state the BOUND on that authority and to distinguish reversible from irreversible.
//
// ═══ ⭐⭐ AND IT GETS RIGHT THE THING VaultPanel GOT WRONG, ONE PANEL OVER ═══════════════════
// VaultPanel rendered "you hold no shares" for a user it had never looked at, because an unread
// balance fell through to the empty state. Here the same branch is gated on
// `w.agentWallet.balance != null`, so an UNKNOWN balance renders "… USDC" and no claim at all.
// ⚠️ THAT IS WHY THE VAULT VERSION LOOKED PLAUSIBLE — the correct pattern was already in the
// codebase, one file away. Section 2 pins it so it stays correct here.
//
// ⚠️ PRESENT AND ABSENT BOTH. The irreversibility taxonomy is only meaningful if the categories
// cannot swap: a suite that merely finds "Gone — there is no undo" somewhere on the page would
// pass while that warning sat under the SWAP card.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const MyAgentPanel = (await import("../src/components/MyAgentPanel")).default;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const wallet = (over: any = {}) => ({
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
  ensureSession: async () => "t", refreshAgentWallet: async () => {}, refreshBalance: async () => {},
  ...over,
});
const render = (over: any = {}) =>
  renderToStaticMarkup(<MyAgentPanel wallet={wallet(over) as any} />)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
const bal = (b: any) => render({ agentWallet: { address: "0x" + "ab".repeat(20), balance: b } });

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  AGENT PANEL COPY — rendered; present AND absent                     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the panel renders at all");
const funded = render();
check("⚠️ non-empty render (every absence check below is vacuous otherwise)",
  funded.length > 400, `${funded.length} chars`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE BOUND ON THE AGENT'S AUTHORITY, AND ITS THREE NAMED LIMITS");
check("⭐⭐ the agent is stated to spend only from its OWN wallet",
  /always spending only what's in that wallet/.test(funded));
for (const [label, re] of [
  ["per-action", /per-action/], ["per-bridge", /per-bridge/], ["cumulative daily", /cumulative daily/],
] as [string, RegExp][]) {
  check(`⭐ …bounded by a ${label} cap`, re.test(funded));
}
// 🚨 BIND THE SENTENCE TO THE CODE THAT MAKES IT TRUE. Naming three limits in prose is a promise;
// if an enforcement point is renamed or deleted the sentence becomes false with no edit and no
// signal — the same shelf-life defect as VaultPanel's pause absolute, which is bound to its
// allowlist for exactly this reason.
const arc = readFileSync("netlify/functions/_arc.mjs", "utf8");
const budget = readFileSync("netlify/functions/_budget.mjs", "utf8");
check("⭐⭐ …and each named limit has a real enforcement point behind it",
  /AGENT_MAX_SPEND_USDC/.test(arc) && /AGENT_BRIDGE_CAP_USDC/.test(arc) &&
  /PERIOD_CEILING_USDC/.test(budget),
  "AGENT_MAX_SPEND_USDC · AGENT_BRIDGE_CAP_USDC · PERIOD_CEILING_USDC");
// ⚠️ A cap that fails OPEN on a bad value would satisfy the grep above and none of the promise.
check("⭐ …and a misconfigured cap REFUSES rather than disabling itself",
  /refusing to spend/.test(arc) && /refusing to bridge/.test(arc));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 UNKNOWN BALANCE IS NOT AN EMPTY ONE (the VaultPanel defect, correct here)");
const EMPTY = /Empty — your agent can't spend anything yet/;
check("⭐ a balance of 0 DOES render the empty state — the true answer must survive",
  EMPTY.test(bal("0")));
check("🚨🚨 a NULL balance does NOT — it has not been read, which is a different answer",
  !EMPTY.test(bal(null)), bal(null).includes("… USDC") ? "renders '… USDC'" : "");
check("🚨 …and an UNDEFINED balance does not either",
  !EMPTY.test(bal(undefined)));
check("⭐ …while a funded wallet naturally shows neither", !EMPTY.test(funded));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⭐⭐ REVERSIBLE AND IRREVERSIBLE MUST NOT SWAP PLACES");
// The page's second job. Both categories are asserted AND the boundary between them, because a
// warning that drifts under the wrong card is worse than a missing one: it reassures about the
// dangerous action while alarming about the safe one.
check("⭐ the leaving category is named", /Move money out/.test(funded) && /This leaves you/.test(funded));
check("⭐ the staying category is named", /Stays with you/.test(funded));
check("⭐⭐ SEND is marked irreversible, in those words",
  /Goes to someone else\. Gone — there is no undo/.test(funded));
check("⭐ BRIDGE says it leaves Arc AND that coming back costs",
  /Leaves Arc for another chain/.test(funded) && /Bridging back costs a fee/.test(funded));
check("⭐ SWAP says it stays, and only the denomination changes",
  /Stays on Arc, stays yours/.test(funded) &&
  /Nothing leaves your agent's wallet — only the denomination changes/.test(funded));
// 🚨 THE BOUNDARY ITSELF: the irreversibility warning must sit ABOVE the staying section, i.e. with
// the actions it describes. Position, not mere presence.
const outAt = funded.indexOf("Move money out");
const stayAt = funded.indexOf("Stays with you");
const undoAt = funded.indexOf("there is no undo");
check("⭐⭐ …and 'there is no undo' sits inside the LEAVING section, not the staying one",
  outAt > 0 && stayAt > outAt && undoAt > outAt && undoAt < stayAt,
  `out@${outAt} undo@${undoAt} stays@${stayAt}`);

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
