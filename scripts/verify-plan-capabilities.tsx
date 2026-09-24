// verify-plan-capabilities.tsx — ONE LIST OF WHAT THE AGENT CAN PLAN, AND EVERY SURFACE THAT STATES IT
// MUST AGREE WITH IT.
//
// ═══ 🚨 WHAT THIS GUARDS ═════════════════════════════════════════════════════════════════════
// The bridge destinations and the plan actions were hand-written in FIVE places: the PlanPanel intro,
// the plan refusal examples, plan-quote's classifier prompt, BridgePanel's picker and TreasuryPanel's
// picker. It has drifted before: when swap was added, the classifier prompt kept saying "the agent can
// only bridge" and silently declined every swap task (plan-quote.mjs header). Now all five read
// shared/plan-capabilities.mjs, and this suite fails when any rendered copy or the prompt disagrees
// with it.
//
//   §1 the source is coherent: PLAN_ACTIONS ⊂ STEP_TYPES; both display orders are exact permutations
//   §2 ⭐ the FULL classifier prompt is PINNED to a fixture, every run — a template edit cannot silently
//      change what the model reads. A deliberate prompt change = update the fixture, visible in the diff.
//   §3 the prompt names every destination, no chain outside the list, the right action count and tokens
//   §4 the rendered PlanPanel intro + refusal examples agree with the list
//   §5 ⭐ BridgePanel and TreasuryPanel render the destinations in the EXPLICIT picker order (Base first)
//
//   npx tsx scripts/verify-plan-capabilities.tsx
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label: string, cond: unknown, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const load = async (p: string) => { try { return await import(p); } catch (e: any) { fail++; console.log(`  ❌ cannot import ${p} — ${e?.message?.split("\n")[0]}`); return {} as any; } };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d))).replace(/\s+/g, " ").trim();

const cap: any = await load("../shared/plan-capabilities.mjs");
const { STEP_TYPES }: any = await load("../netlify/functions/_actions.mjs");
const bridge: any = await load("../netlify/functions/_bridge.mjs");
const swapTokens: any = await load("../netlify/functions/_swap-tokens.mjs");
const { SYSTEM_PROMPT }: any = await load("../netlify/functions/plan-quote.mjs");
const planPanel: any = await load("../src/components/PlanPanel");
const BridgePanel: any = (await load("../src/components/BridgePanel")).default;
const { TreasuryView }: any = await load("../src/components/TreasuryPanel");

const DEST = cap.BRIDGE_DESTINATIONS ?? {};
const KEYS = Object.keys(DEST);
const shortName = (k: string) => String(DEST[k]?.label ?? "").replace(/\s*\(.*\)\s*$/, "");
const NAMES = KEYS.map(shortName);
// Chains a copy could plausibly name that are NOT destinations. Any of these appearing is a drift.
const NOT_DESTINATIONS = ["Solana", "BNB", "Sonic", "HyperEVM", "Sei", "World Chain", "Monad", "Aptos", "Sui",
  "Starknet", "Codex", "Ink", "Plume", "XDC", "Noble", "Stellar", "Tron", "Bitcoin", "Cosmos", "Near"]
  // ⚠️ minus anything that IS a destination: adding a chain to the list must not trip its own vocabulary.
  .filter((n) => !NAMES.includes(n));

// ── §1 ─────────────────────────────────────────────────────────────────────────────────────
section("§1 THE SOURCE IS COHERENT");
check("shared/plan-capabilities.mjs exports BRIDGE_DESTINATIONS, SWAP_TOKENS, PLAN_ACTIONS, DESTINATION_ORDER",
  KEYS.length > 0 && Array.isArray(cap.SWAP_TOKENS) && Array.isArray(cap.PLAN_ACTIONS) && cap.DESTINATION_ORDER);
check("_bridge.mjs re-exports THE SAME object (one source, not a copy)", bridge.BRIDGE_DESTINATIONS === cap.BRIDGE_DESTINATIONS);
check("_swap-tokens.mjs re-exports THE SAME array", swapTokens.SWAP_TOKENS === cap.SWAP_TOKENS);
check("every PLAN_ACTION is a real executor step type", (cap.PLAN_ACTIONS ?? []).every((a: string) => (STEP_TYPES ?? []).includes(a)) && (cap.PLAN_ACTIONS ?? []).length > 0,
  JSON.stringify(cap.PLAN_ACTIONS));
const isPerm = (arr: any) => Array.isArray(arr) && arr.length === KEYS.length && [...arr].sort().join() === [...KEYS].sort().join();
check("DESTINATION_ORDER.prose is an exact permutation of the destinations", isPerm(cap.DESTINATION_ORDER?.prose));
check("DESTINATION_ORDER.picker is an exact permutation of the destinations", isPerm(cap.DESTINATION_ORDER?.picker));
check("⭐ the picker order puts Base first (BridgePanel's order, preserved as data)", cap.DESTINATION_ORDER?.picker?.[0] === "base");

// ── §2 ─────────────────────────────────────────────────────────────────────────────────────
section("§2 ⭐ THE CLASSIFIER PROMPT IS PINNED, EVERY RUN");
const FIXTURE = readFileSync(new URL("./fixtures/plan-quote-system-prompt.txt", import.meta.url), "utf8");
check("⭐⭐ SYSTEM_PROMPT is byte-identical to scripts/fixtures/plan-quote-system-prompt.txt",
  SYSTEM_PROMPT === FIXTURE, SYSTEM_PROMPT === FIXTURE ? `${FIXTURE.length} bytes` : "DIFFERS — a deliberate prompt change must update the fixture in the same diff");

// ── §3 ─────────────────────────────────────────────────────────────────────────────────────
section("§3 THE PROMPT AGREES WITH THE LIST");
const P = String(SYSTEM_PROMPT ?? "");
const plainP = P.replace(/\s+/g, " ");
for (const n of NAMES) check(`prompt names destination ${n}`, plainP.includes(n));
for (const n of NOT_DESTINATIONS) check(`prompt names no non-destination chain: ${n}`, !new RegExp(`\\b${n}\\b`).test(plainP));
const COUNT_WORD = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE"][(cap.PLAN_ACTIONS ?? []).length];
check(`prompt says "${COUNT_WORD} supported" — the count of PLAN_ACTIONS`, new RegExp(`\\b${COUNT_WORD} supported\\b`).test(plainP));
check("prompt names exactly the swap tokens", (cap.SWAP_TOKENS ?? []).every((t: string) => plainP.includes(t)));
const exampleChains = [...plainP.matchAll(/\b(?:to|on) ([A-Z][a-z]+)\b/g)].map((m) => m[1]).filter((c) => c !== "Arc");
check("every chain in the prompt's examples is a destination", exampleChains.every((c) => NAMES.includes(c)), [...new Set(exampleChains)].join(","));
const swapPairs = [...plainP.matchAll(/\b(?:swap|convert) (?:\d+ |some )?([A-Z]{3,5}) to ([A-Z]{3,5})\b/g)];
check("every token in the prompt's swap examples is a swap token", swapPairs.length > 0 && swapPairs.every((m) => cap.SWAP_TOKENS?.includes(m[1]) && cap.SWAP_TOKENS?.includes(m[2])));

// ── §4 ─────────────────────────────────────────────────────────────────────────────────────
section("§4 THE RENDERED PLAN PANEL AGREES WITH THE LIST");
const wallet: any = { agentWallet: { address: "0x" + "ab".repeat(20), balance: "1" }, address: "0x" + "cd".repeat(20), usdcBalance: "1",
  busy: false, isAuthenticated: true, ensureSession: async () => "t", refreshAgentWallet: async () => {}, refreshBalance: async () => {} };
const intro = planPanel.default ? text(renderToStaticMarkup(<planPanel.default wallet={wallet} />)) : "";
const proseList = (cap.DESTINATION_ORDER?.prose ?? []).map(shortName).join(", ");
check("⭐ the intro lists the destinations, in the prose order", proseList.length > 0 && intro.includes(`(${proseList})`), proseList);
for (const n of NOT_DESTINATIONS) check(`intro names no non-destination chain: ${n}`, !new RegExp(`\\b${n}\\b`).test(intro));
check("the intro names the swap pair from SWAP_TOKENS", intro.includes(`convert between ${(cap.SWAP_TOKENS ?? []).join(" and ")} on Arc`));
const decline = planPanel.PlanDeclinedNotice ? text(renderToStaticMarkup(<planPanel.PlanDeclinedNotice task="what's the best chain?" reason="" />)) : "";
const declineChains = [...decline.matchAll(/\bbridge \d+ USDC to ([A-Z][a-z]+)/g)].map((m) => m[1]);
check("every chain in the refusal's examples is a destination", declineChains.length > 0 && declineChains.every((c) => NAMES.includes(c)), declineChains.join(","));
const declineSwaps = [...decline.matchAll(/\bconvert \d+ ([A-Z]{3,5}) to ([A-Z]{3,5})/g)];
check("every token in the refusal's examples is a swap token", declineSwaps.length > 0 && declineSwaps.every((m) => cap.SWAP_TOKENS?.includes(m[1]) && cap.SWAP_TOKENS?.includes(m[2])));

// ── §5 ─────────────────────────────────────────────────────────────────────────────────────
section("§5 ⭐ THE PICKERS RENDER THE EXPLICIT ORDER");
const optionsIn = (html: string, afterValue?: string) => [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
  .map((m) => ({ value: m[1], label: m[2] })).filter((o) => o.value !== afterValue);
const bridgeHtml = BridgePanel ? renderToStaticMarkup(<BridgePanel wallet={wallet} />) : "";
const bridgeOpts = optionsIn(bridgeHtml).filter((o) => KEYS.includes(o.value));
const picker = cap.DESTINATION_ORDER?.picker ?? [];
check("⭐ BridgePanel renders the destinations in DESTINATION_ORDER.picker order", bridgeOpts.map((o) => o.value).join() === picker.join(),
  bridgeOpts.map((o) => o.value).join(","));
check("…with each destination's label from the shared list", bridgeOpts.length === KEYS.length && bridgeOpts.every((o) => o.label === DEST[o.value]?.label));
// The editor (and its picker) renders only with a snapshot — a minimal one in the treasury suite's shape.
const W = "0x" + "cd".repeat(20);
const snapshot = { walletAddress: W, owner: "0x" + "77".repeat(20), pockets: [], policyWarning: null, readAt: "2026-09-25T00:00:00.000Z",
  policy: { version: 1, targets: { arc_sca: 50, unified: 0, dest: [] }, minMoveUsdc: "1.000000", unallocatedPct: 0 },
  caps: { bridgeCapUsdc: "25", ubDepositMaxPerTxUsdc: "100" },
  plan: { total: "0.000000", shares: [], proposals: [], unreadable: [], notMovable: [], unallocatedPct: 0 } };
const treasuryHtml = TreasuryView ? renderToStaticMarkup(<TreasuryView snapshot={snapshot} state="ready" saving={false} saveError="" onSave={() => {}} onRefresh={() => {}}
  draft={{ arc_sca: 50, unified: 0, dest: [{ chain: "base", address: "", pct: 50 }] }} />) : "";
const treasuryOpts = optionsIn(treasuryHtml).filter((o) => KEYS.includes(o.value));
check("⭐ TreasuryPanel renders the destinations in DESTINATION_ORDER.picker order", treasuryOpts.length === KEYS.length && treasuryOpts.map((o) => o.value).join() === picker.join(),
  treasuryOpts.map((o) => o.value).join(","));

console.log(`\n${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
process.exit(fail === 0 ? 0 : 1);
