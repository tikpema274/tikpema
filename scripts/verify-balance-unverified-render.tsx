// verify-balance-unverified-render.tsx — WHEN THE BALANCE COULD NOT BE READ, THE PERSON BRIDGING
// SEES THAT, ON EVERY SURFACE, BEFORE THEY PRESS — rendered output, not a source grep.
//
// ═══ THE CLASS ═══════════════════════════════════════════════════════════════════════════════
// `balanceChecked:false` was written into response bodies by 404628d/b790971 and rendered NOWHERE
// (grep balanceChecked src/: 0). A deliberate fail-open — "the read failed, proceed on Circle's
// backstop" — is defensible only if the person can see it; unseen, it is a silent downgrade of a
// safety check. Fourth instance of written-hashed-never-projected (errata_note, dataDisclosure ×2).
// [[human-facing-field-ships-with-its-render-assertion]]
//
// ⭐ PRESENCE IS ASSERTED BEFORE ANYTHING ELSE. An ordering or negation check is satisfied by an
// absent sentence; every section here first proves the sentence RENDERS when balanceChecked is
// false, then that it does NOT render when true or absent, then what it says.
// ⛔ RUN AGAINST THE PRE-FIX COMPONENTS FIRST: every presence check was red (recorded in PROGRESS).
//
// The copy must distinguish "we could not verify your balance, so this bridge relies on the
// provider's own check" from a SHORTFALL, and must not imply the balance was checked and passed.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pass = 0, fail = 0;
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 66 - t.length))}`);
const check = (label: string, ok: boolean, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`);
};
const strip = (n: React.ReactElement) => renderToStaticMarkup(n)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();

// The one sentence, from the one producer — asserted by CONTENT below, imported so a drift shows here.
let NOTE = "";
try { ({ BALANCE_UNVERIFIED_NOTE: NOTE } = await import("../shared/balance-unverified-copy.mjs") as any); } catch { /* pre-fix: no producer yet */ }
const KEY = "could not be read"; // the phrase every render must carry, producer or not

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("0 — the producer exists and says the right things (content, not a field name)");
check("⭐ shared/balance-unverified-copy.mjs exports BALANCE_UNVERIFIED_NOTE", typeof NOTE === "string" && NOTE.length > 40, NOTE ? `"${NOTE.slice(0, 80)}…"` : "absent");
check("⭐ it says the balance could NOT be read", /could not be read/i.test(NOTE));
check("⭐ it says the bridge relies on the PROVIDER's own check", /provider/i.test(NOTE) && /own check/i.test(NOTE));
check("⭐ it says this is NOT a shortfall", /not a shortfall/i.test(NOTE));
check("⛔ it never implies the balance was checked and passed", !/(balance (was|is) (checked|verified|enough|sufficient)|passed|covers)/i.test(NOTE));

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("1 — BridgeQuoteSummary (agent panel + manual panel's summary block)");
{
  const { BridgeQuoteSummary } = await import("../src/components/BridgeQuoteSummary");
  const quote = (over: any = {}) => ({ amountUsdc: 1, feeUsdc: 0.054045, netUsdc: 1, ...over });
  const r = (q: any) => strip(<BridgeQuoteSummary quote={q} destinationLabel="Base (Sepolia)" mechanic="upfront" />);
  const unchecked = r(quote({ balanceChecked: false }));
  check("🚨 PRESENT when balanceChecked:false", unchecked.includes(KEY), unchecked.slice(0, 160));
  check("⭐ …and it is the producer's sentence", !!NOTE && unchecked.includes(NOTE));
  check("⭐ the fee rows still render beside it (the note qualifies, it does not replace)", /Fee 0\.054045 USDC/.test(unchecked));
  check("⭐ ABSENT when balanceChecked:true", !r(quote({ balanceChecked: true })).includes(KEY));
  check("⭐ ABSENT when the field is missing (the manual panel's own-wallet quote carries none)", !r(quote()).includes(KEY));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("2 — the chat: single-action bridge proposal (AgentSummary, needsBridgeConfirm)");
const { AgentSummary } = await import("../src/components/MyAgentPanel") as any;
const stub = {
  planRun: null, planBusy: false, planMints: {}, planAcked: {}, onPlanAckChange: () => {}, bridgeReceipts: [],
  onConfirm: () => {}, onRequotePlan: () => {}, quotedAt: 1_000_000, now: 1_001_000, bridgeRun: null, bridgeBusy: false,
  bridgeAcked: false, walletReady: true, onAckChange: () => {}, mint: null, onConfirmBridge: () => {}, onRequoteBridge: () => {},
  vaultAcked: false, onVaultAckChange: () => {}, vaultDelta: null, vaultRun: null, vaultBusy: false, onConfirmVault: () => {},
};
const chat = (data: any) => strip(<AgentSummary data={data} {...stub} />);
{
  const bridge = (over: any = {}) => ({ amountUsdc: 1, destination: { key: "base", label: "Base (Sepolia)" }, feeUsdc: 0.054045, netUsdc: 1,
    mechanic: "upfront", cap: 50, quoteToken: "t.t", expiresInMs: 120_000, feeDisclosure: { band: "none", feeRatio: 0.054, ackToken: null }, ...over });
  const data = (over: any = {}) => ({ decision: { action: "bridge_usdc" }, executed: false, needsBridgeConfirm: true, bridge: bridge(over) });
  const unchecked = chat(data({ balanceChecked: false }));
  check("🚨 PRESENT when bridge.balanceChecked:false", unchecked.includes(KEY), unchecked.slice(0, 160));
  check("⭐ …the producer's sentence", !!NOTE && unchecked.includes(NOTE));
  check("⭐ the Confirm is still offered — this is a disclosure, not a refusal", /Confirm/.test(unchecked));
  check("⭐ ABSENT when true", !chat(data({ balanceChecked: true })).includes(KEY));
  check("⭐ ABSENT when missing", !chat(data()).includes(KEY));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("3 — the chat: multi-step plan proposal (AgentSummary, needsConfirm + stepDisclosures)");
{
  const disclosure = { amountUsdc: 1, destinationKey: "base", destinationLabel: "Base (Sepolia)", feeUsdc: 0.054045, netUsdc: 1,
    mechanic: "upfront", feeRatio: 0.054, band: "none", ackToken: null, quoteToken: "t.t", expiresInMs: 120_000 };
  const data = (over: any = {}) => ({ decision: { action: "plan" }, executed: false, needsConfirm: true, quoteId: "q", totalUsdc: 1,
    plan: [{ type: "bridge_usdc", amountUsdc: 1, destination: "base" }], stepDisclosures: { 0: disclosure }, ...over });
  const unchecked = chat(data({ balanceChecked: false }));
  check("🚨 PRESENT when balanceChecked:false", unchecked.includes(KEY), unchecked.slice(0, 160));
  check("⭐ …the producer's sentence", !!NOTE && unchecked.includes(NOTE));
  check("⭐ the step's fee line still renders", /Cross-chain fee/.test(unchecked));
  check("⭐ ABSENT when true", !chat(data({ balanceChecked: true })).includes(KEY));
  check("⭐ ABSENT when missing", !chat(data()).includes(KEY));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("4 — the proposal card (jobTimeline ProposalCard, after press 1)");
{
  const { ProposalCard } = await import("../src/components/jobTimeline") as any;
  const proposal = { action: "bridge_usdc", destination: "base", destinationLabel: "Base (Sepolia)", amountUsdc: 1, cap: 50,
    indicativeFeeUsdc: 0.054, indicativeNetUsdc: 1, indicativeMechanic: "upfront", reasoning: "t" };
  const quote = (over: any = {}) => ({ amountUsdc: 1, destination: { key: "base", label: "Base (Sepolia)" }, feeUsdc: 0.054045, netUsdc: 1,
    mechanic: "upfront", band: "none", feeRatio: 0.054, quotedAt: new Date().toISOString(), expiresInMs: 120_000, ...over });
  const r = (q: any) => strip(<ProposalCard proposal={proposal} bridgeQuote={{ quote: q, quotedAt: Date.now(), expired: false }} onApprove={() => {}} />);
  const unchecked = r(quote({ balanceChecked: false }));
  check("🚨 PRESENT when quote.balanceChecked:false", unchecked.includes(KEY), unchecked.slice(0, 160));
  check("⭐ …the producer's sentence", !!NOTE && unchecked.includes(NOTE));
  check("⭐ the quoted fee line still renders", /Quoted:/.test(unchecked));
  check("⭐ ABSENT when true", !r(quote({ balanceChecked: true })).includes(KEY));
  check("⭐ ABSENT when missing", !r(quote()).includes(KEY));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
section("5 — the sentence is not a shortfall, on any surface");
{
  // The shortfall sentence names figures; the unverified note must name none and must not share its opening.
  check("⛔ the note carries NO 'have X USDC' / 'need Y USDC' figures", !!NOTE && !/\b(have|need) [0-9.]+ USDC/.test(NOTE));
  check("⛔ the note does not open like the shortfall ('Insufficient funds')", !!NOTE && !/^Insufficient/i.test(NOTE));
}

console.log(`\n${fail ? "❌ FAILURES" : "✅ ALL GREEN"}   pass ${pass} / fail ${fail}\n`);
process.exit(fail ? 1 : 0);
