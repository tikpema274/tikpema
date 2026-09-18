// verify-treasury-copy.tsx — WHAT THE TREASURY CONSOLE SAYS, rendered, per state.
//
//   npx tsx scripts/verify-treasury-copy.tsx      (npm run test:treasurycopy)
//
// ═══ THE ONE CLAIM THIS SURFACE EXISTS TO MAKE ══════════════════════════════════════════════════
// NOTHING HERE MOVES MONEY. The console reads pockets, holds targets, and PROPOSES moves; every move is
// confirmed on the surface that carries its disclosures and caps. So: the line is PRESENT and sits ABOVE
// the proposals in the markup, there is NO seal (`button.emerald`) anywhere on the page, and every handoff
// link carries the proposed amount into the surface that will quote the fee.
//
// ⚠️ RENDERED, NOT GREPPED. States are rendered through the EXPORTED TreasuryView with crafted snapshots.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TreasuryView, NOTHING_MOVES_LINE } from "../src/components/TreasuryPanel";
import { POCKET, destPocketId } from "../shared/treasury/plan.mjs";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail ? `  — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 58 - t.length))}`);
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const W = "0x" + "cd".repeat(20), D = "0x" + "ab".repeat(20);
const DEST = destPocketId("base", D);
const pockets = (over: Record<string, any> = {}) => [
  { id: POCKET.ARC_SCA, label: "Agent wallet", chain: "Arc", address: W, usdc: "80.000000", ok: true, note: "on-chain read", ...(over[POCKET.ARC_SCA] || {}) },
  { id: "arc_sca_eurc", label: "Agent wallet (EURC)", chain: "Arc", address: W, asset: "EURC", usdc: "0.175418", ok: true, note: "shown, never summed — no USD rate" },
  { id: POCKET.UNIFIED, label: "Unified balance", chain: "Arc Testnet + Base Sepolia", address: W, usdc: "20.000000", ok: true, note: "Circle Gateway · off-chain figure · exit takes about seven days", perDomain: [{ chain: "Arc Testnet", domain: 26, usdc: "15", ok: true }, { chain: "Base Sepolia", domain: 6, usdc: "5", ok: true }], ...(over[POCKET.UNIFIED] || {}) },
];
const policy = { version: 1, targets: { arc_sca: 50, unified: 50, dest: [] }, minMoveUsdc: "1.000000", unallocatedPct: 0 };
const snap = (over: any = {}) => ({
  walletAddress: W, owner: "0x" + "77".repeat(20), pockets: pockets(), policy, policyWarning: null,
  caps: { bridgeCapUsdc: "25", ubDepositMaxPerTxUsdc: "100" },
  plan: { total: "100.000000", shares: [{ id: POCKET.ARC_SCA, usdc: "80.000000", sharePct: 80, targetPct: 50, driftUsdc: "-30.000000" }, { id: POCKET.UNIFIED, usdc: "20.000000", sharePct: 20, targetPct: 50, driftUsdc: "30.000000" }], proposals: [{ kind: "ub_deposit", from: POCKET.ARC_SCA, to: POCKET.UNIFIED, amountUsdc: "30.000000", surface: "unified", capNote: null, note: null }], unreadable: [], notMovable: [], unallocatedPct: 0 },
  readAt: "2026-09-19T00:00:00.000Z", ...over,
});
const view = (s: any, extra: any = {}) => renderToStaticMarkup(<TreasuryView snapshot={s} saving={false} saveError="" onSave={() => {}} onRefresh={() => {}} {...extra} />);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  TREASURY CONSOLE — what it says, per state, rendered                 ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("1 — 🚨 NOTHING HERE MOVES MONEY: present, above the proposals, and no seal anywhere");
{
  const m = view(snap()); const t = strip(m);
  // The markup escapes the apostrophe in "agent's"; search the escaped form so the POSITION is real.
  const esc = NOTHING_MOVES_LINE.replace(/'/g, "&#x27;");
  const line = m.indexOf(esc); const props = m.indexOf("Proposed moves");
  check("🚨 the line is PRESENT", line >= 0);
  check("🚨 …says nothing moves here and each move is confirmed on its own page with the fee first", /Nothing here moves money/.test(NOTHING_MOVES_LINE) && /confirmed on its own page/.test(NOTHING_MOVES_LINE) && /fee/.test(NOTHING_MOVES_LINE));
  check("🚨 …and it sits ABOVE the proposals in the markup", line >= 0 && props > line, `line@${line} proposals@${props}`);
  check("🚨 NO seal button (class emerald) anywhere on the page", !/class="emerald/.test(m));
  check("⭐ the handoff link carries the proposed amount into #/unified?deposit=30", /#\/unified\?deposit=30(\.000000)?/.test(m));
  check("…and is labelled as a handoff, not an action here", /Do this on Unified/.test(t));
}

section("2 — the table: pockets, share, target, drift; EURC shown and never summed");
{
  const m = view(snap()); const t = strip(m);
  check("total is USDC-only: 100.00 (EURC 0.175418 not added)", /100\.00 USDC/.test(t) && !/100\.17/.test(t));
  check("pocket rows carry share % and target %", /80(\.00)?\s*%/.test(t) && /50\s*%/.test(t));
  check("EURC row present with its never-summed note", /EURC/.test(t) && /never summed/i.test(t));
  check("unified row says the exit takes about seven days", /about seven days/.test(t));
  check("addresses masked with click-to-expand (AddressDisplay)", /Click to show full address/.test(m));
}

section("3 — partly unavailable: no total number, the pocket NAMED, no proposals");
{
  const s = snap({ pockets: pockets({ [POCKET.UNIFIED]: { usdc: null, ok: false } }), plan: { total: null, shares: [], proposals: [], unreadable: [POCKET.UNIFIED], reason: "no proposals: 1 pocket(s) unreadable, so shares are unknown" } });
  const m = view(s); const t = strip(m);
  check("🚨 header shows 'partly unavailable', not a number", /partly unavailable/.test(t) && !/100\.00 USDC/.test(t));
  check("🚨 …and NAMES the unreadable pocket", /Unified balance/.test(t) && /unreadable|unavailable/.test(t));
  check("no proposals, and the reason is shown", !/Do this on/.test(t) && /shares are unknown/.test(t));
}

section("4 — no targets yet: pockets shown, invitation, no proposals; sum > 100 refused in the editor");
{
  const s = snap({ policy: null, plan: { total: "100.000000", shares: [{ id: POCKET.ARC_SCA, usdc: "80.000000", sharePct: 80, targetPct: null, driftUsdc: null }, { id: POCKET.UNIFIED, usdc: "20.000000", sharePct: 20, targetPct: null, driftUsdc: null }], proposals: [], unreadable: [], reason: "no targets set" } });
  const m = view(s); const t = strip(m);
  check("no targets → invites the user to set them, no proposals", /no targets set/i.test(t) && !/Do this on/.test(t));
  const over = view(snap(), { draft: { arc_sca: 60, unified: 50, dest: [] } });
  check("⭐ a draft summing to 110% is refused client-side with the sum named, Save disabled", /110\s*%/.test(strip(over)) && /<button[^>]*disabled[^>]*>Save targets/.test(over));
}

section("5 — proposals: cap note and delay note are shown; bridge hands off to #/bridge with destination");
{
  const s = snap({ policy: { ...policy, targets: { arc_sca: 50, unified: 0, dest: [{ chain: "base", address: D, pct: 50 }] } }, pockets: [...pockets(), { id: DEST, label: "base address", chain: "base", address: D, usdc: "0.000000", ok: true, note: "on-chain read (named address — not movable from here)" }], plan: { total: "100.000000", shares: [], proposals: [{ kind: "bridge", from: POCKET.ARC_SCA, to: DEST, amountUsdc: "25.000000", surface: "bridge", capNote: "capped at the bridge per-transaction limit of 25.000000 USDC — this closes 25.000000 of 50.000000; run again after it lands", note: "the bridge fee is quoted on the Bridge page before anything moves" }, { kind: "ub_withdraw", from: POCKET.UNIFIED, to: POCKET.ARC_SCA, amountUsdc: "5.000000", surface: "unified", capNote: null, note: "about seven days: the Gateway holds a withdrawal for its delay before it returns to your agent wallet" }], unreadable: [], notMovable: [] } });
  const m = view(s); const t = strip(m);
  check("bridge proposal links #/bridge?amount=25&destination=base", /#\/bridge\?amount=25(\.000000)?&(amp;)?destination=base/.test(m));
  check("⭐ the cap note is shown verbatim", /closes 25\.000000 of 50\.000000/.test(t));
  check("⭐ the withdraw proposal shows the ~7-day note and links #/unified?withdraw=5", /about seven days/.test(t) && /#\/unified\?withdraw=5(\.000000)?/.test(m));
  check("named-address pocket says it is not movable from here", /not movable from here/.test(t));
}

section("6 — states: signed-out door, loading, unreadable snapshot");
{
  const out = strip(renderToStaticMarkup(<TreasuryView snapshot={null} state="signed-out" saving={false} saveError="" onSave={() => {}} onRefresh={() => {}} />));
  check("signed-out → sign-in door, no table", /Sign in|Connect a wallet/.test(out) && !/Proposed moves/.test(out));
  const unr = strip(renderToStaticMarkup(<TreasuryView snapshot={null} state="unreadable" stateReason="HTTP 503" saving={false} saveError="" onSave={() => {}} onRefresh={() => {}} />));
  check("unreadable snapshot → says it could not be read and nothing moved", /could not be read/i.test(unr) && /nothing (was )?moved/i.test(unr));
}

section("7 — ⛔ the route is LINKED: Dashboard card + App route (the #/dca lesson)");
{
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const dash = readFileSync(new URL("../src/components/Dashboard.tsx", import.meta.url), "utf8");
  check("the route resolves", app.includes('case "treasury"'));
  check("⭐ the Dashboard card is the way in", dash.includes('go("treasury")'));
  check("…and it is NOT a NAV item (by decision — the nav stays at six)", !/id:\s*"treasury"/.test(app.match(/const NAV = \[([\s\S]*?)\];/)?.[1] ?? ""));
}

console.log(`\n${"═".repeat(72)}`);
if (fail) { console.log(`❌ ${fail} failed, ${pass} passed.\n`); process.exit(1); }
console.log(`✅ ALL GREEN   pass ${pass} / fail 0\n`);
