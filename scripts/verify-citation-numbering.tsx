// verify-citation-numbering.tsx — DO THE PROSE'S [n] MARKERS POINT AT ANYTHING THE READER SEES?
//
//   npx tsx scripts/verify-citation-numbering.tsx      (also: npm run test:citenum)
//
// ═══ 🚨 THE DEFECT, TWICE ══════════════════════════════════════════════════════════════════════
// Job #180679 cited [5]/[6]; job #181044 cited [8] against a list showing four entries. Both had
// the same cause and neither was diagnosed until the second: `cited` and `notCited` are FILTERED
// SUBSETS of the grounding block, and a filter destroys position. The prose numbers by the block
// the model read; the lists numbered by their own position — or, in #181044, carried no numbers at
// all, being <ul> bullets. Two coordinate systems presented as one.
//
// ⭐ THE FIX IS NOT RENUMBERING THE PROSE. It is preserving the ORIGINAL index on every entry, so
// cited [1],[3],[4] and not-used [2],[5],[8] are COMPLEMENTARY BY CONSTRUCTION. The gaps are the
// information: every marker resolves into exactly one list, and a reader can check the two against
// each other. Renumbering either list from 1 destroys that property silently.
//
// ⚠️ BOTH DIRECTIONS, and one that a presence-only test cannot see: an entry WITHOUT `n` (a legacy
// brief) must render NO number rather than a guessed one — a wrong number is worse than none.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Brief } from "../src/components/jobTimeline";

let pass = 0, fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) { pass++; console.log(`  ✅ ${l}${x ? ` — ${x}` : ""}`); } else { fail++; console.log(`  ❌ ${l}${x ? ` — ${x}` : ""}`); }
};
const strip = (h: string) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
// 🚨 ASSERT ON THE LISTS, NOT ON THE WHOLE RENDER. First version used `text.includes("[8]")` — and
// PASSED 13/13 against the pre-fix component, because [8] appears in the ANSWER PROSE, which every
// version renders. The check matched the text it was supposed to be checking AGAINST.
// ⭐ Caught only by running the guard against the broken component; reading it would not have found
// it. Second time in two days. The fix is to assert MARKER-ADJACENT-TO-TITLE, a pairing that can
// only come from a list item.
const marked = (text: string, n: number, title: string) =>
  new RegExp(`\\[${n}\\]\\s+${title.replace(/[.*+?^$()|[\]\\]/g, "\\$&").slice(0, 24)}`).test(text);
const section = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 60 - t.length))}`);

// The #181044 shape: 8 grounding entries, 4 cited, and CoinGecko at [8] in the other list.
const brief = {
  answer: "USDC trades at $0.999665 [8]. Conversion is near par [1].",
  sources: [
    { n: 1, title: "ECB reference rates", url: "https://ecb.example/eur" },
    { n: 3, title: "Circle USDC docs", url: "https://circle.example/usdc" },
    { n: 4, title: "Arc testnet explorer", url: "https://arcscan.example" },
  ],
  retrievedNotCited: [
    { n: 2, title: "Kraken EUR/USD", url: "https://kraken.example" },
    { n: 5, title: "Wirex blog", url: "https://wirex.example" },
    { n: 8, title: "usd-coin $0.999665 (as of 2026-08-19T12:50:30Z)", url: "https://coingecko.example" },
  ],
};

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  CITATION NUMBERING — grounding indices, rendered                   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

const text = strip(renderToStaticMarkup(<Brief brief={brief as any} />));

section("every marker in the prose resolves to a DISPLAYED entry");
{
  const markers = [...brief.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const shown = new Set([...brief.sources, ...brief.retrievedNotCited].map((s) => s.n));
  check(`prose markers are ${markers.join(", ")}`, markers.length > 0);
  for (const m of markers) {
    check(`[${m}] resolves to an entry the reader can see`, shown.has(m));
    const entry = [...brief.sources, ...brief.retrievedNotCited].find((e) => e.n === m)!;
    check(`[${m}] is rendered NEXT TO ITS ENTRY in a list (not merely present in the prose)`,
          marked(text, m, entry.title), entry.title.slice(0, 30));
  }
}

section("the two lists PARTITION the grounding block");
{
  const a = brief.sources.map((s) => s.n), b = brief.retrievedNotCited.map((s) => s.n);
  const both = a.filter((n) => b.includes(n));
  check("no number appears in BOTH lists", both.length === 0, both.join(",") || "none");
  // ⚠️ The gaps are deliberate and are the point — [6],[7] were never retrieved in this fixture.
  check("cited numbers keep their ORIGINAL positions, not 1..n",
        JSON.stringify(a) === JSON.stringify([1, 3, 4]), `got ${JSON.stringify(a)}`);
  check("⭐ the cited list is NOT renumbered from 1", !(a[0] === 1 && a[1] === 2 && a[2] === 3));
}

section("the numbers rendered are the DATA's, not positional");
{
  // 🚨 If the component numbered by position, the third not-used entry would show [3], not [8].
  check("[8] is rendered beside the CoinGecko entry, keeping its grounding number",
        marked(text, 8, "usd-coin"));
  check("🚨 the not-used list does NOT renumber to [1] [2] [3]",
        !marked(text, 1, "Kraken") && !marked(text, 2, "Wirex") && !marked(text, 3, "usd-coin"));
  check("⭐ the cited list shows [3] beside Circle, not [2] (its subset position)",
        marked(text, 3, "Circle") && !marked(text, 2, "Circle"));
  check("the CoinGecko timestamp survives to the reader", text.includes("as of 2026-08-19T12:50:30Z"));
}

section("a LEGACY brief with no `n` renders no number at all");
{
  const legacy = { answer: "x", sources: [{ title: "old", url: "https://old.example" }], retrievedNotCited: [] };
  const t2 = strip(renderToStaticMarkup(<Brief brief={legacy as any} />));
  check("no bracketed number is emitted", !/\[\d+\]/.test(t2), t2.slice(0, 60));
  check("the source still renders", t2.includes("old"));
}

console.log("\n════════════════════════════════════════════════════════════════════════");
console.log(`${fail ? "❌" : "✅"} ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log("⭐ Markers resolve, lists are complementary, numbers come from the data.\n");
