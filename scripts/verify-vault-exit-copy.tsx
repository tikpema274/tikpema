// verify-vault-exit-copy.tsx — THE EXIT COST IS A CROSS-CHECK, AND REDEMPTION HAS FOUR STATES.
//
//   npx tsx scripts/verify-vault-exit-copy.tsx        (also: npm run test:vaultexit)
//
// ⛔ THE PROPERTY THAT MATTERS: the exit-cost sentence is licensed by TWO instruments agreeing —
// `withdrawFee()` DECLARES a rate, and the gap between `convertToAssets` and `previewRedeem`
// MEASURES what the vault would actually pay. Quoting one alone is a weaker claim than we have;
// quoting both without checking they agree is two numbers that happen to coincide.
// [[repeating-one-instrument-is-not-corroboration]]
//
// ⭐⭐ MEASURED ON XyloVault 2026-09-07, and the reason a percentage is legitimate at all: the gap
// is EXACTLY PROPORTIONAL across seven orders of magnitude — 0.100000% at 0.1 shares and at half
// the total supply (4,171,169,938,061 shares). A FLAT fee would hold the gap constant and the
// PERCENTAGE would move; here the percentage is constant and the gap scales. So "0.10%" is a claim
// about a function, not about the one amount someone sampled.
//   shares 100000 → gap 100 · 1000000 → 1000 · 10000000 → 10000 · 1e9 → 1000001 · ts/2 → 4171177693
// ⚠️ And the declared rate agrees: withdrawFee() = 10 bps = 0.10%.
//
// ⛔ THE FOUR REDEMPTION STATES EXIST BECAUSE A THRESHOLD DISCARDS THE FIGURE. Firing only at
// `maxRedeem === 0` makes a vault permitting 1% of a position indistinguishable from one permitting
// 100%. The partial state therefore carries its AMOUNT, and `unknown` must never render as
// `blocked` — both read as "you cannot withdraw", but one is a fact and the other is its absence.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { exitSentence } from "../netlify/functions/_vault.mjs";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("1 — ⭐⭐ THE SENTENCE IS LICENSED BY AGREEMENT, NOT BY EITHER INSTRUMENT");
{
  const both = exitSentence({ declaredBps: 10, measuredBps: 10, maxFeeBps: 2000, performanceFeeBps: 1000 });
  check("states the figure", /returns about 0\.10% less than your shares' value/.test(both), both.slice(0, 60));
  check("⭐ names the DECLARED rate with its source", /vault declares \(withdrawFee = 10 bps\)/.test(both));
  check("⭐ …AND that it was confirmed against the vault's own preview", /confirmed against its own previewRedeem/.test(both));
  check("⛔ names the raisable ceiling", /raise it to 20\.00% \(MAX_FEE\)/.test(both));
  check("⭐ …and the separate performance fee", /10\.00% performance fee applies to yield/.test(both));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("2 — ⛔ THE CEILING IS DERIVED FROM MAX_FEE, NEVER THE NUMBER 20");
{
  // 🚨 THE DEFECT THIS CATCHES: a hardcoded "20%" is a finding about ONE vault written as a
  // property of vaults. A vault with a different ceiling would inherit Xylo's silently.
  const other = exitSentence({ declaredBps: 25, measuredBps: 25, maxFeeBps: 500 });
  check("⭐⭐ a different MAX_FEE produces a different ceiling", /raise it to 5\.00% \(MAX_FEE\)/.test(other), other);
  check("🚨 …and 20% does NOT appear", !/20\.00%/.test(other));
  check("⭐ the fee figure tracks the vault too", /returns about 0\.25% less/.test(other));
  const noCeiling = exitSentence({ declaredBps: 10, measuredBps: 10, maxFeeBps: null });
  check("⛔ an unreadable ceiling SAYS SO rather than omitting the risk",
    /Whether the owner can raise this fee could not be read/.test(noCeiling), noCeiling);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("3 — ⛔ IT DEGRADES TO UNKNOWN, NEVER TO REASSURANCE");
{
  const measOnly = exitSentence({ declaredBps: null, measuredBps: 10, maxFeeBps: 2000 });
  check("measured-only says the rate was not declared",
    /declares no readable rate we could cross-check/.test(measOnly) && !/confirmed against/.test(measOnly));
  const declOnly = exitSentence({ declaredBps: 10, measuredBps: null, maxFeeBps: null });
  check("declared-only says it could NOT be confirmed",
    /could NOT confirm it against a preview/.test(declOnly) && !/confirmed against its own/.test(declOnly));
  const neither = exitSentence({ declaredBps: null, measuredBps: null, maxFeeBps: null });
  check("🚨 neither → the cost is UNKNOWN, and explicitly NOT zero",
    /could NOT be read/.test(neither) && /UNKNOWN, not zero/.test(neither), neither);
  check("⛔ …and it never quotes a percentage it did not establish", !/%/.test(neither.replace(/MAX_FEE/g, "")));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("4 — ⭐⭐ FOUR REDEMPTION STATES, AND THE PARTIAL ONE CARRIES ITS AMOUNT");
{
  // ═══ ⭐⭐ THIS SECTION USED TO GREP VaultPanel.tsx, AND NOW IT RENDERS ════════════════════════
  // Not a style preference — a repair. The redemption line lives inside the disclosure band, which
  // VaultPanel only shows AFTER an inspection resolves, and renderToStaticMarkup emits the initial
  // state only. So the states were unreachable to a render test and the section fell back to
  // asserting that four strings existed in a file. A string in a file is not a state on a screen:
  // it cannot tell a live branch from dead code, and it goes red on a move that changes nothing.
  // ⭐ IT DID GO RED ON EXACTLY THAT — the band moved to VaultDisclosure and all seven checks
  // failed while the rendered output was byte-identical.
  // ⭐⭐ Extracting the component is what made the states addressable: each is now one prop away.
  // [[assert-on-rendered-output-not-source-regex]] · [[state-behind-a-transition-is-untested-by-default]]
  const VaultDisclosure = (await import("../src/components/VaultDisclosure")).default;
  const show = (redemption: any) =>
    renderToStaticMarkup(
      <VaultDisclosure
        inspection={{ verdict: { level: "WARN", warns: [], blocks: [] }, redemption }}
        ackRequired={false}
        acked={false}
        onAckChange={() => {}}
      />,
    ).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
     .replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_: string, d: string) => String.fromCharCode(Number(d)))
     .replace(/\s+/g, " ").trim();

  const full = show({ state: "full" });
  const partial = show({ state: "partial", redeemableAssets: "12.5", positionAssets: "40.0" });
  const blocked = show({ state: "blocked" });
  const unknown = show({ state: null });

  check("⛔ the band renders at all — every assertion below is vacuous otherwise",
    full.length > 80, `${full.length} chars`);
  check("the panel renders a redemption line", /Redeemable now:/.test(full));
  check("⭐ full", /in full ✓/.test(full));
  check("⭐⭐ partial CARRIES THE FIGURE — not just the verdict",
    /in part/.test(partial) && /12\.5 USDC of 40\.0 USDC held/.test(partial),
    "a partial state without the amount is the threshold discard this replaced");
  check("⭐ …and NAMES the difference rather than absorbing it",
    /The rest stays yours/.test(partial) && /not a change in your balance/.test(partial));
  check("⭐ blocked", /BLOCKED/.test(blocked) && /allows no withdrawals/.test(blocked));
  check("🚨 unknown is DISTINCT and says UNKNOWN, not blocked",
    /UNKNOWN, not blocked/.test(unknown) && !/allows no withdrawals/.test(unknown),
    "an unread limit must never render as a refusal");

  // ⛔ PAIRWISE INEQUALITY, NOT A PRESENCE COUNT. Four fixtures that agree on any two states leave
  // the suite blind between them — the presence-only version could not have caught a collapse of
  // `unknown` into `blocked`, which is the one collapse that matters here.
  // [[collapse-needs-pairwise-inequality]] · [[fixtures-that-agree-cannot-discriminate]]
  const rendered = { full, partial, blocked, unknown };
  const names = Object.keys(rendered);
  let distinct = true, clash = "";
  for (let a = 0; a < names.length; a++) {
    for (let b = a + 1; b < names.length; b++) {
      if (rendered[names[a]] === rendered[names[b]]) { distinct = false; clash = `${names[a]} === ${names[b]}`; }
    }
  }
  check("⛔ all four render DIFFERENT text — a collapse would pass a presence-only test",
    distinct, clash || "6 pairs, all distinct");
}

section("5 — ⛔ THE RETENTION FIGURE IS MEASURED, NOT MULTIPLIED");
{
  const raw = readFileSync("netlify/functions/_vault.mjs", "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("⭐⭐ roundTripRetainedPct derives from the MEASURED gap",
    /roundTripRetainedPct:\s*measuredExitBps === null/.test(code));
  check("🚨 …and no CODE hand-multiplies (10000 - withdrawFeeBps)",
    !/10000 - withdrawFeeBps/.test(code),
    "a second derivation of a number the vault computes for us is back");
  check("⭐ previewRedeem and convertToAssets are actually CALLED, not just conformance strings",
    /functionName: "previewRedeem"/.test(code) && /functionName: "convertToAssets"/.test(code));
  check("⭐ maxRedeem is read per-holder", /functionName: "maxRedeem"/.test(code));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
section("6 — ⛔ THE TWO UNBOUND 'FREELY WITHDRAWABLE' CLAIMS ARE GONE");
{
  const dash = readFileSync("src/components/Dashboard.tsx", "utf8");
  const agents = readFileSync("netlify/functions/_agents.mjs", "utf8");
  const dashCode = dash.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  const agentsCode = agents.replace(/^\s*\/\/.*$/gm, " ");
  check("🚨 Dashboard no longer promises 'Withdraw any time'",
    !/Withdraw\s+any time/.test(dashCode), "the unbound timing claim is back on a surface that inspects nothing");
  check("⭐ …and promises the MEASUREMENT instead, which stays true for an unexitable vault",
    /Exit terms/.test(dashCode) && /measured and shown/.test(dashCode));
  check("🚨 the agent roster no longer says 'Withdraw is always available'",
    !/Withdraw is always available/.test(agentsCode));
  check("⭐ …and separates OUR guarantee from the VAULT's terms",
    /pause and caps never block a reclaim/.test(agentsCode) && /the vault's terms/.test(agentsCode));
  check("⭐⭐ …and no longer implies the exit is FREE — the fee is named as the vault's",
    /fee it takes on exit/.test(agentsCode));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURE"} — ${pass} passed, ${fail} failed. Zero money, zero network.`);
process.exit(fail === 0 ? 0 : 1);
