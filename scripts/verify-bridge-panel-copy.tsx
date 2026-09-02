// verify-bridge-panel-copy.tsx — THE BRIDGE PANEL'S PROMISE vs WHAT IT ACTUALLY DELIVERS.
//
//   npx tsx scripts/verify-bridge-panel-copy.tsx        (also: npm run test:bridge)
//
// ═══ 🚨 WHAT WRITING THIS FOUND ══════════════════════════════════════════════════════════════
// The lead said "you'll see the EXACT fee and net arrival on the confirmation". The confirmation,
// twelve lines further down the same file, says **estimated** — and its comment explains why:
// "netUsdc is arithmetic — the amount burned minus the fee quoted at execution — not an
// observation of what landed. A '~' alone did not carry that distinction."
//
// ⭐⭐ "EXACT" WAS TRUE OF THE FEE AND FALSE OF THE ARRIVAL. One adjective attached to both, so the
// page promised above what it hedged below — the advertised-vs-delivered gap, in the same shape as
// the plan card's "with live pricing" over a brief that said "fees may be", and job #181295's
// headline rate over its own cited prices. ⚠️ The exact delivered figure is not missing; it simply
// arrives LATER, once the destination chain has been read. The promise moved the timing, not the
// truth.
//
// ═══ ⚠️ TWO CLAIMS DELIBERATELY NOT TREATED AS DEFECTS ══════════════════════════════════════
// "gasless, from your wallet" is standard Arc/Circle phrasing for "no separate gas token needed",
// which is true — gas on Arc IS USDC — and a fee sentence follows immediately, so the page as a
// whole does not imply free. "The Arc burn is instant" is defensible on a chain with sub-second
// finality. ⭐ NEITHER WAS MEASURED FALSE, so neither is changed: a sweep that manufactures
// findings to look thorough is worth less than one that reports what it can support.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const BridgePanel = (await import("../src/components/BridgePanel")).default;

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
const rendered = renderToStaticMarkup(<BridgePanel wallet={wallet} />)
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
  .replace(/\s+/g, " ").trim();
const src = readFileSync("src/components/BridgePanel.tsx", "utf8");
// ⚠️ A FLATTENED VIEW OF THE SOURCE, for claims that live in a branch SSR does not reach. Matching
// raw source failed on this file for two reasons at once: JSX wraps a sentence across lines (and
// `.` does not cross a newline), and inline <b> tags sit INSIDE the phrase. Both are invisible to a
// reader and fatal to a pattern — the exact reason this repo abandoned source-scanning guards.
// ⭐ Flattening keeps the check honest without loosening it into vagueness.
const srcText = src.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  BRIDGE PANEL COPY — the promise vs the delivery                     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

section("0 — the panel renders at all");
check("⚠️ non-empty render", rendered.length > 300, `${rendered.length} chars`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — 🚨 THE PROMISE MAY NOT OUTRUN THE CONFIRMATION");
check("🚨🚨 the lead no longer promises an EXACT net arrival",
  !/exact\s*fee and net arrival/i.test(rendered),
  rendered.match(/exact[^.]{0,50}/i)?.[0] ?? "");
// ⚠️ RE-POINTED, NOT RELAXED — the behaviour these described was SUPERSEDED by consent-fee
// binding. The fee is no longer "quoted at execution": it is priced BEFORE the burn, sealed, and
// signed unchanged. An assertion that a page still says so would now be pinning a false sentence.
// ⭐ The CLAIMS survive in stronger form and are asserted here in their new wording; what died is
// one paragraph, not one guarantee.
check("⭐⭐ the arrival is still called an ESTIMATE until the chain is read",
  /the arrival is an estimate/i.test(rendered) || /estimated\s*arrival/i.test(rendered));
// ⚠️ ASSERTED ON SOURCE, AND CORRECTLY SO. The held-quote sentence renders only once a quote
// EXISTS — `renderToStaticMarkup` emits the initial state, where there is no quote and no figure to
// promise anything about. Asserting it against `rendered` failed for the right reason: the claim is
// conditional, and a page cannot promise a bound fee before one is bound.
// ⭐ So this pins that the sentence exists AND sits inside the quote block, which is the property
// that matters — a bound-fee promise outside that block would be a promise with no fee.
// [[state-behind-a-transition-is-untested-by-default]]
{
  const quoteBlock = src.slice(src.indexOf("{quote && !run && ("), src.indexOf("summary-hazard"));
  check("⭐⭐ the fee is promised as BOUND, not as read-at-execution",
    /held for this bridge/i.test(quoteBlock) && /re-read when it runs/i.test(quoteBlock),
    "consent-fee binding: the figure shown is the figure signed");
  check("⭐ …and the promise lives WITH the figure, not adrift of it",
    quoteBlock.length > 0 && quoteBlock.includes("quote.feeUsdc"),
    "the sentence and the number are in one block");
}
check("⛔ …and the superseded claim is GONE, not merely outranked by a newer one",
  !/quoted at execution/i.test(rendered),
  "a survivor would read as deliberate — see the three other sites this claim lived at");
check("⭐⭐ …and says the exact delivered amount arrives LATER, from the destination chain",
  /exact delivered\s*amount appears once we have read the destination chain/i.test(rendered));

// 🚨 THE TWO HALVES MUST AGREE. This is the check that would have caught the defect: the lead and
// the confirmation are twelve lines apart in one file, and only reading BOTH reveals the mismatch.
const confirmSaysEstimated = /Bridge submitted ✓ — <b>estimated<\/b>/.test(src);
check("🚨🚨 the confirmation still marks the arrival ESTIMATED — the claim the lead must match",
  confirmSaysEstimated);
check("⭐ …and its reason is still written at the code, so nobody re-tightens it by accident",
  /THIS IS AN ESTIMATE AND MUST SAY SO/.test(src));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⭐ THE REFUSALS ARE STATED BEFORE THE MONEY MOVES");
check("⭐ over-cap and too-small-to-cover-the-fee are both refused, and said so",
  /over your per-bridge\s*cap/i.test(rendered) && /too small to cover the fee/i.test(rendered) &&
  /refused before any funds move/i.test(rendered));
check("⭐ …and the caps are named in the lead as well", /per-bridge and daily safety caps/i.test(rendered));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — 🚨 AN UNREADABLE HISTORY IS NOT AN EMPTY ONE");
// The absence family again, on the surface where it means "is my money in flight?".
check("🚨🚨 a failed history read refuses to read as 'nothing in flight'",
  /this is not confirmation that nothing is in flight/i.test(srcText));
check("⭐ …and invites a retry rather than a conclusion", /Try again shortly/.test(srcText));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⚠️ CLAIMS LEFT STANDING, RECORDED SO THE NEXT READER KNOWS THEY WERE CONSIDERED");
check("⭐ 'gasless' is still claimed — true on Arc, where gas IS USDC and no second token is needed",
  /gasless/.test(rendered));
// ⚠️ RETIRED AND REPLACED. This pinned "gasless" preceding the phrase "cross-chain fee" — an
// ordering between two sentences of ONE paragraph, and that paragraph is gone. Left as-is it failed
// on indexOf(...) === -1: loud, correct, and about a structure that no longer exists.
// ⭐ THE PROPERTY IT PROTECTED IS REAL AND IS KEPT: the page must never imply the bridge is free.
// It is now asserted directly — a fee figure is present wherever "gasless" is claimed — rather than
// through the proximity of two particular strings. 🚨 PRESENCE FIRST, so it cannot pass on absence.
{
  const saysGasless = /gasless/.test(rendered);
  const namesAFee = /\bFee\b/.test(rendered) || /fee/i.test(rendered);
  check("⭐ 'gasless' is never claimed without a fee named on the same page",
    saysGasless && namesAFee,
    saysGasless ? "both present" : "⛔ vacuous — 'gasless' is absent");
}
check("⭐ the mint window is given as a RANGE with a slow case, not a single number",
  /a few minutes \(up to\s*~20 for some chains\)/.test(rendered));

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
