// verify-swap-proposal-copy.tsx — the AGENT swap proposal card discloses the FLOOR, and never the
// fabricated "1% worse". RENDERED-OUTPUT assertions, not source greps.
//
//   npx tsx scripts/verify-swap-proposal-copy.tsx
//
// ═══ 🚨 WHY THIS SUITE EXISTS — THE GAP THAT LET A FALSEHOOD SHIP ════════════════════════════════
// The manual swap card (ManualSwapPanel) had verify-manual-swap-copy.tsx and showed the BINDING
// floor ("guaranteed at least X — reverts below this"). The AGENT proposal card (SwapProposalBody in
// jobTimeline) had NO render guard at all — and for months it rendered "the swap reverts rather than
// filling more than 1% worse", a claim the code's OWN comment and docs/swap-slippage-copy-overclaim
// declare false (the executing B1 path sends no slippage; the binding minimum is Circle's, ~3% in
// one sample). A 2026-08-30 "closure" grepped the word "slippage" — absent from the bundle — and
// missed the "1% worse" PHRASING, which was shipped in rendered JSX. Verified in the built bundle.
//
// ⭐ THE RULE THIS ENFORCES: assert on RENDERED OUTPUT. A copy claim that lives only in JSX text is
// exactly what a source-grep for one keyword misses. [[assert-on-rendered-output-not-source-regex]]
// [[one-claim-two-producers]] [[human-facing-field-ships-with-its-render-assertion]]
//
// Zero network, zero money.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProposalCard, type SwapProposal } from "../src/components/jobTimeline";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

// A tag-stripped, whitespace-collapsed view for prose that spans inline <span>/<b>. Match this for
// anything a human reads as a sentence; the raw HTML for structure. (Same rule as the diff suite.)
const textOf = (p: SwapProposal) => {
  const html = renderToStaticMarkup(<ProposalCard proposal={p} />);
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() };
};

const base: SwapProposal = {
  action: "swap_tokens", tokenIn: "USDC", tokenOut: "EURC",
  amountIn: 5, valueUsdc: 5, cap: 25,
  indicativeAmountOut: 4.31, indicativeMinOut: 4.05,
  pricedAt: "2026-09-11T12:00:00.000Z", reasoning: "because",
};

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  agent swap proposal — the floor is disclosed, the 1% claim is gone   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — THE FABRICATED WORST CASE IS GONE FROM THE RENDER");
{
  const { text } = textOf(base);
  check("⛔ the rendered card does NOT say '1% worse'", !/1% worse/i.test(text));
  check("⛔ …nor 'more than 1%' in any spelling", !/more than 1\s*%/i.test(text));
  check("⛔ …nor any bare 'N% worse' slippage claim (no fabricated percentage replaced it)",
    !/\d+(\.\d+)?\s*% worse/i.test(text), text.match(/\d+(\.\d+)?\s*% worse/i)?.[0] ?? "none");
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — THE FLOOR IS DISCLOSED WHEN PRESENT, WITH THE HONEST MECHANISM");
{
  const { text } = textOf(base);
  check("⭐ the estimate is still shown", /4\.31/.test(text) && /roughly/i.test(text));
  check("⭐⭐ the FLOOR number is shown (the worst case a user needs)", /4\.05/.test(text),
    text.slice(0, 240));
  check("⭐ …phrased as a floor ('will not fill below')", /will not fill below/i.test(text));
  check("⭐⭐ …and the exact minimum is stated to be set AT EXECUTION (not this estimate)",
    /at execution/i.test(text) && /(exact|minimum)/i.test(text));
  check("⛔ …and it is NOT called 'guaranteed' (the binding floor is set fresh at execution)",
    !/guaranteed/i.test(text));
  // ⭐ The two numbers must be DISTINCT in the render — a floor equal to the estimate would hide that
  // there is any downside at all. [[fixtures-that-agree-cannot-discriminate]]
  check("⭐⭐ the floor (4.05) and the estimate (4.31) are BOTH present and DISTINCT",
    /4\.31/.test(text) && /4\.05/.test(text) && base.indicativeMinOut !== base.indicativeAmountOut);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — NO FLOOR NUMBER ⇒ MECHANISM ONLY, NEVER A FABRICATED ONE");
{
  const { text } = textOf({ ...base, indicativeMinOut: null });
  check("⭐ with no floor, the estimate still renders", /4\.31/.test(text) && /roughly/i.test(text));
  check("⛔ …no stale floor number leaks in", !/4\.05/.test(text));
  check("⭐⭐ …and the mechanism is STILL stated (reverts / minimum at execution)",
    /at execution/i.test(text) && /reverts/i.test(text));
  check("⛔ …still no '1% worse'", !/1% worse/i.test(text));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — THE RENDER IS NOT VACUOUS (it actually produced the card)");
{
  const { html } = textOf(base);
  check("⭐ the card rendered substantial markup", html.length > 200, `${html.length} bytes`);
  check("⭐ it is the swap card (names the conversion)", /Convert/i.test(html) && /EURC/.test(html));
}

console.log(`\n╔${"═".repeat(37)}`);
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log(`╚${"═".repeat(37)}`);
process.exit(fail === 0 ? 0 : 1);
