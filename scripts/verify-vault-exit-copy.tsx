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
  const src = readFileSync("src/components/VaultPanel.tsx", "utf8");
  check("the panel renders a redemption line", /Redeemable now:/.test(src));
  check("⭐ full", /state === "full"/.test(src) && /in full ✓/.test(src));
  check("⭐⭐ partial CARRIES THE FIGURE — not just the verdict",
    /state === "partial"/.test(src) && /redeemableAssets/.test(src) && /positionAssets/.test(src),
    "a partial state without the amount is the threshold discard this replaced");
  check("⭐ …and NAMES the difference rather than absorbing it",
    /The rest stays yours/.test(src) && /not a change in your balance/.test(src));
  check("⭐ blocked", /state === "blocked"/.test(src) && /allows no withdrawals/.test(src));
  check("🚨 unknown is DISTINCT and says UNKNOWN, not blocked",
    /UNKNOWN, not blocked/.test(src), "an unread limit must never render as a refusal");
  // Both directions: the states must be mutually exclusive in the source, not four copies of one.
  const bodies = ["in full ✓", "in part —", "BLOCKED —", "could not read —"];
  check("⛔ all four render DIFFERENT text — a collapse would pass a presence-only test",
    new Set(bodies.filter((b) => src.includes(b))).size === 4,
    `${bodies.filter((b) => src.includes(b)).length}/4 present`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
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
