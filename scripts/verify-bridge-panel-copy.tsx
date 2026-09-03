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

import { MINT_TIMING, MINT_DEADLINE_MINUTES } from "../shared/bridge-timing.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const BridgePanel = (await import("../src/components/BridgePanel")).default;
const { BridgeQuoteSummary } = await import("../src/components/BridgeQuoteSummary");

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
// ═══ ⭐⭐ NOW RENDER-BASED, BECAUSE THE BLOCK IS ALWAYS PRESENT ═══════════════════════════════
// This was asserted on SOURCE, and correctly so at the time: the summary rendered only once a quote
// existed, and `renderToStaticMarkup` emits the initial state — so there was nothing to assert
// against. Making the block unconditional means the DEFAULT render now carries the rows, and a
// render check is strictly stronger than a file read: it sees what a user sees.
//
// ⭐ THE PRE-QUOTE STATE IS ITS OWN CLAIM, and this pins both halves — the rows are there, and the
// two that cannot be known yet say so with an em-dash rather than a zero. A "0.0000 USDC" fee would
// be a number the panel does not have. [[absence-must-never-read-as-safe]]
check("⭐⭐ the summary rows are present BEFORE any quote",
  /Fee/.test(rendered) && /You receive/.test(rendered) &&
  /Settlement/.test(rendered) && /Route/.test(rendered));
check("⭐⭐ …and the unknown values read as em-dashes, not as zero",
  /—/.test(rendered) && !/0\.0000 USDC/.test(rendered),
  "a zero fee would be a figure the panel does not have");
// ⭐ REBOUND 2026-09-02 — this pinned the literal "a few minutes (up to ~20 for some chains)" as a
// PROXY for "Settlement has a value". The literal moved (it was one of two contradictory ranges; see
// shared/bridge-timing.mjs) and this failed on wording, not on the property.
// ⛔ The property is unchanged and is now asserted against the SOURCE: Settlement renders whatever
// the one constant says, so this can never again fail because someone reworded it — nor pass if the
// row goes blank.
check("⭐ …while Settlement and Route ARE known from the destination alone",
  rendered.includes(MINT_TIMING) && /Arc to .* via CCTP/.test(rendered));
// ⛔ THE BOUND-FEE PROMISE MUST NOT RENDER BESIDE AN EM-DASH. It asserts a binding on a figure, and
// with no figure there is no binding — a promise about nothing is worse than silence.
check("⛔ the held-quote promise is ABSENT before a quote exists",
  !/held for this bridge/i.test(rendered),
  "it claims a binding on a figure that does not exist yet");
{
  // ⭐ And PRESENT with one — rendered directly, which is what extracting the component bought.
  // ⚠️ Same normalisation as `rendered` above — this suite has no shared `strip`, and a different
  // one here would compare two differently-flattened strings.
  const quoted = renderToStaticMarkup(
    <BridgeQuoteSummary quote={{ feeUsdc: 0.054071, netUsdc: 0.945929 }} destinationLabel="Base (Sepolia)" />)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
  check("⭐⭐ …and PRESENT once a quote exists, beside its figure",
    /held for this bridge/i.test(quoted) && /0\.0541/.test(quoted) && /0\.9459/.test(quoted),
    "consent-fee binding: the figure shown is the figure signed");

  // ═══ ⭐⭐ HOW LONG THE PRICE HOLDS — RENDERED, NOT JUST COMPUTED ══════════════════════════════
  // 🚨 `expiresInMs` was sent by the server for months and read by NOTHING. Invisible when right and
  // invisible when wrong — and it was about to become wrong by a minute, because Circle's quote
  // window is ~120s while our constant said 180000.
  // ⛔ AND UNDER UPFRONT FEES THE SENTENCE STOPS BEING ADVICE. A burn past the quote's deadline
  // REVERTS on chain, after the approve has confirmed — so "price it again if you wait" has to say
  // HOW LONG. Rendered here rather than asserted on source, because only rendering can show it.
  const strip = (n: any) => renderToStaticMarkup(n)
    .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ").trim();
  const fee = { feeUsdc: 0.054071, netUsdc: 0.945929 };
  const live = strip(<BridgeQuoteSummary quote={fee} destinationLabel="Base (Sepolia)" secondsLeft={97} />);
  check("⭐⭐ a live quote RENDERS its remaining seconds",
    /This price holds for 97s/.test(live) && !/Price it again if you wait/.test(live), live.slice(-150));

  const dead = strip(<BridgeQuoteSummary quote={fee} destinationLabel="Base (Sepolia)" secondsLeft={0} />);
  check("⭐⭐ an expired quote SAYS SO, rather than counting down to nothing",
    /This price has expired/i.test(dead) && !/holds for/.test(dead), dead.slice(-140));

  // ⛔ AND THE UNTIMED SENTENCE SURVIVES FOR THE CASE WHERE WE DO NOT KNOW. A missing window must
  // not silently drop the warning — absence of a number is not absence of a deadline.
  const untimed = strip(<BridgeQuoteSummary quote={fee} destinationLabel="Base (Sepolia)" />);
  check("⛔ with NO window the warning is still there, just untimed",
    /Price it again if you wait/.test(untimed) && !/holds for/.test(untimed) && !/has expired/i.test(untimed),
    untimed.slice(-130));
  // 🚨 EXACTLY ONE of the three sentences ever renders — two would contradict each other about
  // whether the price is still good.
  for (const [name, t] of [["live", live], ["expired", dead], ["untimed", untimed]] as const) {
    const hits = [/holds for/, /has expired/i, /Price it again if you wait/].filter((re) => re.test(t)).length;
    check(`🚨 the ${name} quote renders EXACTLY ONE validity sentence`, hits === 1, `${hits} matched`);
  }
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
// ═══ ⭐⭐ THE PROPERTY IS REAL; THE OLD WORDING WAS NOT THE PROPERTY ══════════
// This required a RANGE WITH A SLOW CASE so the panel could never state one optimistic number. That
// decision stands. What changed is where the slow case comes from: it was "up to ~20 for some
// chains", a literal that CONTRADICTED the code's own MINT_DEADLINE_MS of 4 minutes — the receipt
// system flags a mint overdue at 4, while the panel promised twenty.
// ⭐ So the slow case is now DERIVED from that deadline, and this asserts both halves: a slow case
// exists, and it is the deadline the system actually enforces. Stronger than the string it replaced.
check("⭐ the mint window still names a SLOW CASE, not a single number",
  /\d/.test(MINT_TIMING) && MINT_TIMING.includes(String(MINT_DEADLINE_MINUTES)), MINT_TIMING);
check("⭐⭐ …and the panel renders that slow case, so copy and receipt bands cannot disagree",
  rendered.includes(String(MINT_DEADLINE_MINUTES)) && rendered.includes(MINT_TIMING));

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
