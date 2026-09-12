// verify-dca-fill-floor-copy.tsx — THE DCA FILL-FLOOR COPY MUST MATCH THE PRODUCER.
//
//   npx tsx scripts/verify-dca-fill-floor-copy.tsx   (also: npm run test:dcafillfloor)
//
// ═══ 🚨 THE GAP THIS CLOSES ════════════════════════════════════════════════════════════════════
// DCA authorizes N future fills the user never sees priced. It disclosed caps + the day ceiling but
// NOT the per-fill floor — the same silence the agent card carried before ff192ff, except here it
// stated no number rather than a false one. The fix is a MECHANIC statement: a per-fill minimum
// exists, it is set at execution, and it is CIRCLE'S (each fill routes executeAction → _swap B1
// createSwap, which sends no slippage param, so Circle's minTokenOut binds — not a number we chose).
//
// ⛔ DERIVED FROM THE PRODUCER, NOT WRITTEN. The claim is bound to the ACTUAL request body the
// execute path builds (`swapExecuteRequestBody`, used verbatim by _swap.mjs). Add a slippage key
// there and `SWAP_FILL_FLOOR_SOURCE` flips to `caller` → the `=== "circle"` assertion below goes
// RED. That is the difference between a fix and a sentence that was true once.
// ⛔ AND NO PERCENTAGE. Stating "≤1%" or "~3%" would present a figure as a property — the exact
// error this replaces. [[check-whose-failure-mode-is-a-pass]] [[bridge-mechanic]]
//
// Zero network. Zero money.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  SWAP_FILL_FLOOR_SOURCES, SWAP_FILL_FLOOR_COPY, SWAP_FILL_FLOOR_SOURCE,
  swapFillFloorSource, swapFillFloorCopy, swapExecuteRequestBody, SLIPPAGE_KEYS,
} from "../shared/swap-fill-floor.mjs";
const { default: DcaPanel, DcaCreatePausedNotice } = await import("../src/components/DcaPanel");
const { AgentSwapSummary } = await import("../src/components/SwapPanel");
const { default: SwapTabs } = await import("../src/components/SwapTabs");
const { DCA_CREATE_GATED } = await import("../shared/dca-gate.mjs");

let pass = 0, fail = 0;
const check = (l: string, c: unknown, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); }
  else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
  return !!c;
};
const strip = (n: React.ReactNode) => renderToStaticMarkup(n as React.ReactElement)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  DCA FILL-FLOOR COPY ↔ PRODUCER — whose minimum binds, derived       ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ── 1. THE CLOSED SET, BOTH DIRECTIONS ─────────────────────────────────────────────────────────
check("⭐ three sources, and `unknown` is one of them",
  JSON.stringify(SWAP_FILL_FLOOR_SOURCES) === JSON.stringify(["circle", "caller", "unknown"]));
check("⭐⭐ every source has copy (both the recurring `summary` and the single-swap `single`)",
  SWAP_FILL_FLOOR_SOURCES.every((s) => !!SWAP_FILL_FLOOR_COPY[s]?.summary && !!SWAP_FILL_FLOOR_COPY[s]?.single));
check("⭐⭐ …and every copy key is a declared source — no dead entries",
  Object.keys(SWAP_FILL_FLOOR_COPY).every((k) => SWAP_FILL_FLOOR_SOURCES.includes(k as never)));

// ── 2. ⛔ DERIVED FROM THE PRODUCER — the whole point ───────────────────────────────────────────
// The body the execute path actually POSTs to createSwap, built by the SAME function _swap.mjs uses.
const body = swapExecuteRequestBody({
  tokenInAddress: "0xIN", tokenOutAddress: "0xOUT", fromAddress: "0xFROM", toAddress: "0xTO", amount: "1000000",
});
check("⛔ the execute-path body carries NO slippage-shaped key",
  !SLIPPAGE_KEYS.some((k) => k in body), `keys: ${Object.keys(body).join(",")}`);
check("⭐⭐ so the derived source is `circle` — Circle's minTokenOut binds, not ours",
  swapFillFloorSource(body) === "circle", swapFillFloorSource(body));
check("⭐⭐ and the module-level SWAP_FILL_FLOOR_SOURCE agrees (what the panel renders)",
  SWAP_FILL_FLOOR_SOURCE === "circle", SWAP_FILL_FLOOR_SOURCE);
// ⭐ THE DERIVATION ACTUALLY DISCRIMINATES — a body WITH slippage must read `caller`, or the
// `=== circle` assertion above is vacuous and the mutation test would pass on a broken guard.
check("⭐ a body WITH a slippage key derives `caller` (the derivation is not a constant)",
  swapFillFloorSource({ ...body, slippageBps: 100 }) === "caller");

// ── 3. ⛔ _swap.mjs ACTUALLY USES the shared builder (the body is not inlined, bypassing the bind) ─
const swapSrc = readFileSync("netlify/functions/_swap.mjs", "utf8");
check("⛔ _swap.mjs imports swapExecuteRequestBody from the shared module",
  /import\s*\{[^}]*swapExecuteRequestBody[^}]*\}\s*from\s*["']\.\.\/\.\.\/shared\/swap-fill-floor\.mjs["']/.test(swapSrc));
check("⛔ every createSwap fetch body goes through it — no inlined body remains",
  !/tokenInChain:\s*["']Arc_Testnet["'],\s*fromAddress/.test(swapSrc),
  "an inlined createSwap body would bypass the floor-source binding");

// ── 4. THE PANEL RENDERS THE DERIVED COPY, AND ONLY THAT ────────────────────────────────────────
const rendered = strip(React.createElement(DcaPanel, {
  wallet: { address: null, isAuthenticated: false, ensureSession: async () => "" } as never,
}));
const circleCopy = SWAP_FILL_FLOOR_COPY.circle.summary;
check("⭐⭐ the panel renders the `circle` floor sentence verbatim (from the shared module)",
  rendered.includes(circleCopy));
check("⭐ …and NOT the `caller` sentence (it would be false while the source is circle)",
  !rendered.includes(SWAP_FILL_FLOOR_COPY.caller.summary));
// ⛔ NAMES WHOSE FLOOR BINDS + THE MECHANIC — the three things the sentence must carry.
check("⛔ the sentence NAMES Circle as the setter", /Circle/.test(circleCopy) && rendered.includes("Circle"));
check("⛔ …says the minimum is set AT EXECUTION (per fill, when it runs)", /when each fill runs|at the moment each fill runs|each fill runs/i.test(circleCopy));
check("⛔ …and says a per-fill minimum EXISTS", /minimum/i.test(circleCopy) && /will not swap/i.test(circleCopy));
// ⛔ NO PERCENTAGE — a rate stated as a property is the ≤1%/~3% error this replaces.
check("⛔ the floor sentence states NO percentage (no ≤1% / ~3% figure)",
  !/%|\bpercent\b|\b\d+(\.\d+)?\s*%/.test(circleCopy), circleCopy);

// ── 5. THE AGENT SWAP SUMMARY renders the single-swap floor copy, same producer binding ─────────
const agentRendered = strip(React.createElement(AgentSwapSummary, { amount: 25, tokenIn: "USDC", tokenOut: "EURC" } as never));
const circleSingle = SWAP_FILL_FLOOR_COPY.circle.single;
check("⭐⭐ AgentSwapSummary renders the `circle` single-swap floor sentence (from the shared module)",
  agentRendered.includes(circleSingle));
check("⭐ …and NOT the `caller` single sentence", !agentRendered.includes(SWAP_FILL_FLOOR_COPY.caller.single));
check("⛔ the single sentence NAMES Circle and set-at-execution", /Circle/.test(circleSingle) && /when it runs|at the moment it runs/i.test(circleSingle));
check("⛔ the single sentence states NO percentage", !/%|\bpercent\b/.test(circleSingle), circleSingle);
// ⛔ the agent path has no live quote — it must NOT state a rate/impact/fee NUMBER pre-execution.
check("⛔ AgentSwapSummary states no pre-quote figure (no %/USDC-out number in the rate/min rows)",
  !/\d+(\.\d+)?\s*%/.test(agentRendered));

// ── 6. THE TAB STRIP — labels carry the product difference, and the paused pill agrees with the gate ─
const tabsPaused = strip(React.createElement(SwapTabs, { active: "recurring", dcaPaused: true } as never));
const tabsOpen = strip(React.createElement(SwapTabs, { active: "recurring", dcaPaused: false } as never));
check("⭐ tab labels name WHO/WHEN, not order types (no Market/Limit/DCA)",
  tabsPaused.includes("Agent swap") && tabsPaused.includes("Sign it yourself") && tabsPaused.includes("Recurring")
  && !/\bMarket\b/.test(tabsPaused) && !/\bLimit\b/.test(tabsPaused));
check("⛔ paused pill shows when the gate is on", /paused/i.test(tabsPaused));
check("⛔ …and is ABSENT when the gate is off (not a decoration)", !/paused/i.test(tabsOpen));
// ⭐⭐ THE PILL AND THE PAGE NOTICE AGREE — both trace to the gate, so the strip's "paused" and the
// page's "New schedules are paused" cannot say different things.
const pausedNotice = strip(React.createElement(DcaCreatePausedNotice, {} as never));
check("⭐⭐ the paused pill and the page notice agree (both say paused)",
  /paused/i.test(tabsPaused) && /New schedules are paused/i.test(pausedNotice));
// ⭐ THE DEFAULT PILL STATE IS THE SHARED GATE — no second source. A change to DCA_CREATE_GATED
// moves the live pill without touching this component.
const tabsDefault = strip(React.createElement(SwapTabs, { active: "recurring" } as never));
check("⭐ default (no prop) reflects DCA_CREATE_GATED (the single gate source)",
  /paused/i.test(tabsDefault) === DCA_CREATE_GATED, `gate=${DCA_CREATE_GATED}`);

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
