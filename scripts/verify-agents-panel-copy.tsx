// verify-agents-panel-copy.tsx — THE ROSTER'S CLAIMS, AND THE REGISTRY THAT MAKES THEM TRUE.
//
//   npx tsx scripts/verify-agents-panel-copy.tsx        (also: npm run test:copy)
//
// ═══ 🚨 WHY THIS EXISTS, AND WHY IT LOOKED COVERED ═══════════════════════════════════════════
// `AgentsPanel` READ as guarded: `verify-activity-fallback` renders one ROW subcomponent to check a
// fallback label. It asserts nothing about the page's own claims, so the roster's four promises —
// who acts, what each may touch, which can move money, and that any can be stopped instantly — had
// no suite at all. ⭐ A component named by a suite is not a component covered by one, which is why
// the guard registry lists it as DEBT rather than as covered.
//
// ═══ ⭐⭐ THE CLAIMS HERE ARE PROMISES ABOUT A DATA CONTRACT, NOT ABOUT PROSE ═════════════════
// "the badge on each card says which" is only true while EVERY agent declares `movesFunds`. A new
// agent that omits it gets `undefined` → falsy → a badge reading "cannot move your money" for an
// agent nobody has classified. 🚨 THAT IS A FAIL-OPEN ON A SAFETY BADGE, and it is the same shape
// this file already survived once: `movesFunds` used to be DERIVED in the view as
// `a.id === "executor"`, which was FALSE — the Researcher buys data with the user's USDC.
//
// ⚠️ NOTHING HERE WAS FOUND BROKEN. The registry is complete, the pause map covers every id, and
// the tri-state is right. This suite exists to keep it that way, and says so plainly rather than
// manufacturing a finding — the seventh debt item in a row does not have to produce a defect to
// have been worth checking.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AGENTS } from "../netlify/functions/_agents.mjs";

const _agentsMod = await import("../src/components/AgentsPanel");
const AgentsPanel = _agentsMod.default;
// ⭐ The two pure blocks the authed body is built from, exported so the absence checks below can be
// CALIBRATED — an absence asserted against a render that could never contain the string is vacuous.
const { AgentsBudgetLine, RosterCard } = _agentsMod as any;

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

const wallet: any = {
  agentWallet: { address: "0x" + "ab".repeat(20), balance: "12.3456" },
  address: "0x" + "cd".repeat(20), usdcBalance: "12.3456", busy: false, isAuthenticated: true,
  ensureSession: async () => "t", refreshAgentWallet: async () => {}, refreshBalance: async () => {},
};
const rendered = renderToStaticMarkup(<AgentsPanel wallet={wallet} />)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();
const panelSrc = readFileSync("src/components/AgentsPanel.tsx", "utf8");
const api = readFileSync("netlify/functions/agents.mjs", "utf8");
const pause = readFileSync("netlify/functions/_pause.mjs", "utf8");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  AGENTS PANEL — the roster's promises vs the registry behind them    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the panel renders at all");
check("⚠️ non-empty render", rendered.length > 150, `${rendered.length} chars`);

// ═══ 🚨 A PAGE THAT ASSERTS AGENT STATE TO SOMEONE WITH NO WALLET ══════════════════════════════
// The gate was `const authed = w.isAuthenticated`, and `isAuthenticated` is derived from a
// sessionStorage token ALONE (`!!session && session.exp*1000 > Date.now()`), independently of
// whether any wallet is connected in the UI. So a visitor holding a live token with no connected
// wallet — a reload straight onto #/agents — skipped the sign-in prompt and got the roster and the
// shared daily-ceiling line: the page ASSERTING what your agents are doing and what they spent, to
// someone the rest of the app shows as signed out. That is worse than a missing guard line.
// ⭐ THE LOAD-BEARING ASSERTION IS THE POSITIVE ONE, and it is the one that goes red on the broken
// page: the prompt must BE there. ⚠️ The absence checks below are honest but weak on their own —
// renderToStaticMarkup runs no effects, so `data` is null and the roster could not appear anyway.
// They are made non-vacuous by the calibration underneath, which proves the strings ARE detectable.
// [[equality-passes-vacuously-on-empty]] · [[state-behind-a-transition-is-untested-by-default]]
{
  const tokenOnly: any = { ...wallet, address: undefined, isAuthenticated: true };
  const out = renderToStaticMarkup(<AgentsPanel wallet={tokenOnly} />).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  check("⭐⭐ a token without a connected wallet is asked to connect one, not shown the roster",
    /Sign in to see your agents/i.test(out));
  check("⛔ …and the shared daily-ceiling line is NOT asserted to them", !/Spent today/i.test(out));
  for (const name of ["Researcher", "Executor"])
    check(`⛔ …nor the agent name "${name}"`, !new RegExp(name, "i").test(out));

  // ⭐ CALIBRATION — the absence checks above must be able to FAIL. Render the two pure blocks the
  // authed body is built from and confirm the very strings asserted absent are detectable here.
  const budget = renderToStaticMarkup(
    <AgentsBudgetLine budget={{ spentTodayUsdc: 1.5, ceilingUsdc: 25 }} allPaused={false} busy="" onToggleAll={() => {}} />,
  ).replace(/<[^>]+>/g, " ");
  check("⭐ calibration: 'Spent today' IS detectable when the block renders", /Spent today/i.test(budget));
  const card = renderToStaticMarkup(
    // ⚠️ The field is `label`, not `name` — the first fixture used `name` and the calibration went
    // RED, which is exactly its job: it proved the assertion could not see what it claimed to.
    <RosterCard agent={{ id: "researcher", label: "Researcher", description: "x", spends: "x",
      movesFunds: true, paused: false, pausedByAll: false, spentTodayUsdc: 0, actionsToday: 0,
      blockedToday: 0 } as any} busy={false} open={false} onToggle={() => {}} onExpand={() => {}} />,
  ).replace(/<[^>]+>/g, " ");
  check("⭐ calibration: an agent NAME IS detectable when a card renders", /Researcher/i.test(card));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐ THE FOUR PROMISES THE DASHBOARD SENDS USERS HERE FOR");
check("⭐ who acts for you", /Who acts for you/i.test(rendered));
check("⭐ what each one may touch — a job AND a boundary", /a job and a boundary/i.test(rendered));
check("⭐⭐ which of them can move money, via a per-card badge",
  /the badge on each card says which/i.test(rendered));
check("⭐⭐ …and that any of them can be stopped instantly",
  /stop any of them, instantly/i.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — 🚨 THE BADGE PROMISE IS ONLY TRUE IF EVERY AGENT IS CLASSIFIED");
// The binding. An agent without `movesFunds` renders as SAFE, which is the one direction a safety
// badge must never fail in.
const unclassified = AGENTS.filter((a: any) => typeof a.movesFunds !== "boolean").map((a: any) => a.id);
check("🚨🚨 every agent declares movesFunds EXPLICITLY — an omission would read as 'safe'",
  unclassified.length === 0,
  unclassified.length ? `unclassified: ${unclassified.join(", ")}` :
    AGENTS.map((a: any) => `${a.id}=${a.movesFunds}`).join(" "));
check("⭐ …and at least one is classified each way, so the badge is not vacuously uniform",
  AGENTS.some((a: any) => a.movesFunds) && AGENTS.some((a: any) => !a.movesFunds));
// 🚨 A MONEY-MOVER HIDDEN FROM THE ROSTER would make "the badge on each card says which" true of
// the cards shown and false of the user's actual exposure.
const hiddenMovers = AGENTS.filter((a: any) => a.unlisted && a.movesFunds).map((a: any) => a.id);
check("🚨🚨 no agent that moves funds is hidden from the roster",
  hiddenMovers.length === 0, hiddenMovers.join(", ") || `${AGENTS.length} agents, 0 unlisted`);
// ⚠️ THE NEGATIVE IS MATCHED AGAINST CODE ONLY, COMMENTS STRIPPED. My first version failed because
// `a.id === "executor"` appears in the COMMENT that documents its own removal: "This line used to
// say `a.id === \"executor\"`, which was FALSE". ⭐ A guard forbidding a pattern will trip on the
// note explaining why the pattern was removed — the fourth time today an absence check has been
// defeated by prose, and the first time by prose written to record a fix.
const apiCode = api.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
check("⭐ …and the API serves movesFunds from the REGISTRY rather than re-deriving it in the view",
  /movesFunds: a\.movesFunds/.test(apiCode) && !/a\.id === "executor"/.test(apiCode));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 'UNKNOWN' IS NOT 'RUNNING' (the tri-state on a safety control)");
check("⭐ the panel distinguishes unknown from paused from running",
  /a\.paused === null/.test(panelSrc) && /a\.paused === true/.test(panelSrc));
check("⭐⭐ …and renders the word 'unknown' rather than defaulting to running",
  /unknown \? "unknown"/.test(panelSrc) || /\{unknown \? "unknown"/.test(panelSrc));
// ⚠️ The contract that keeps `paused` from ever being `undefined`: the pause read asks for EVERY
// registry id, so a missing entry cannot silently mean "running".
check("🚨 the pause map is built from EVERY registry id, so no agent can be absent from it",
  /const ids = \[ALL_AGENTS, \.\.\.AGENTS\.map\(\(a\) => a\.id\)\]/.test(pause));
check("⭐ …and an unreadable flag yields a third state, not a falsy 'running'",
  /UNREADABLE IS A THIRD STATE, NOT "RUNNING"/.test(pause));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ 'INSTANTLY' IS BOUND TO THE SAME STRONG READ THE DASHBOARD RELIES ON");
// Two surfaces make this claim; both are false the moment the read goes stale, so both bind to it.
check("⭐⭐ the pause flag is read with STRONG consistency",
  /const READ_CONSISTENCY = "strong"/.test(pause));
check("⭐ …and the roster says the stop is available at any time, not just while watching",
  /at any time/i.test(rendered));

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
