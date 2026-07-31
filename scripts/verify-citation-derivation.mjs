// verify-citation-derivation.mjs — RETRIEVED IS NOT SUPPORTING.
//
//   node scripts/verify-citation-derivation.mjs
//
// ═══ WHAT THIS GUARDS ════════════════════════════════════════════════════════════════════════
// _research.mjs used to set `decision.sources = <every Exa result>`. That made the list
// RETRIEVAL OUTPUT rendered under a heading ("Sources:") that asserts SUPPORT. Job #160108 is
// the proof: the answer referenced [1] and [2], six sources were listed, and two exchange
// "Unified Trading Account" FAQs — matched on the word "Unified" — appeared as if they backed a
// claim about Arc's Gateway. The ANSWER was correct. The citation layer was not.
//
// This sits ONE LAYER ABOVE the no-fabrication fix. That one guards against sources being
// INVENTED. This guards against RETRIEVED != SUPPORTING. Both must hold at once, which is why
// the fix INTERSECTS (model's citation claim ∩ retrieval) rather than choosing a side:
//   · trust the model's list  -> fabrication reopens (strictly worse)
//   · keep the override       -> uncited sources keep masquerading as evidence
//
// Zero network. Zero money. Pure derivation logic, mirrored from the implementation.

import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ""}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ""}`); }
};
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);

console.log("╔══════════════════════════════════════════════════════════════════════╗");
console.log("║  CITATION DERIVATION — retrieved is not supporting                   ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ── the derivation, mirrored exactly from _research.mjs ──────────────────────────────────────
const normUrl = (u) => String(u || "").trim().replace(/[/#?]+$/, "").toLowerCase();
function derive(decision, retrieved) {
  const claimedUrls = new Set(
    (Array.isArray(decision.sources) ? decision.sources : [])
      .map((s) => normUrl(typeof s === "string" ? s : s?.url))
      .filter(Boolean)
  );
  const prose = `${decision.answer || ""}\n${decision.reasoning || ""}`;
  const markedIdx = new Set([...prose.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]) - 1));
  const isCited = (r, i) => claimedUrls.has(normUrl(r.url)) || markedIdx.has(i);
  return {
    cited: retrieved.filter(isCited),
    notCited: retrieved.filter((r, i) => !isCited(r, i)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("1 — THE ACTUAL DEFECT: job #160108 reproduced");
{
  // Six retrieved, answer references [1] and [2] only. Sources 3-6 carry no claim.
  const retrieved = [
    { title: "Arc Gateway docs", url: "https://arc.io/docs/gateway" },
    { title: "Circle Gateway reference", url: "https://developers.circle.com/gateway" },
    { title: "Bybit Unified Trading Account FAQ", url: "https://bybit.com/faq/uta" },
    { title: "Bitget Unified Trading Account", url: "https://bitget.com/support/uta" },
    { title: "Unified balance explainer", url: "https://example.com/unified" },
    { title: "Random unified account post", url: "https://example.com/post" },
  ];
  const decision = {
    answer: "Withdrawal is delayed about seven days [1].",
    reasoning: "The Gateway exposes initiateWithdrawal and withdraw [1], with the delay documented [2].",
    sources: [{ title: "Arc Gateway docs", url: "https://arc.io/docs/gateway" }],
  };
  const { cited, notCited } = derive(decision, retrieved);
  check("⭐⭐ exactly 2 sources cited, not 6", cited.length === 2, `got ${cited.length}`);
  check("  …[1] and [2] are the ones kept",
    cited[0].url.includes("arc.io") && cited[1].url.includes("circle.com"));
  check("⭐⭐ the Bybit FAQ is NOT cited (matched on the word 'Unified')",
    !cited.some((s) => /bybit/i.test(s.url)));
  check("⭐⭐ the Bitget FAQ is NOT cited", !cited.some((s) => /bitget/i.test(s.url)));
  check("  …the other four are retained as retrieved-not-cited, not discarded",
    notCited.length === 4, "breadth is still showable, just not AS citation");
  check("  …cited + notCited === retrieved (nothing invented, nothing lost)",
    cited.length + notCited.length === retrieved.length);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("2 — FABRICATION STAYS SHUT (the layer below must not regress)");
{
  const retrieved = [{ title: "Real", url: "https://real.example/a" }];
  const decision = {
    answer: "Per [1] and my own knowledge.",
    reasoning: "Also see the other source.",
    // the model invents a URL that was never retrieved
    sources: [
      { title: "Real", url: "https://real.example/a" },
      { title: "Invented", url: "https://totally-made-up.example/b" },
    ],
  };
  const { cited } = derive(decision, retrieved);
  check("⭐⭐ a model-invented URL CANNOT enter the list", cited.length === 1);
  check("  …because the result is a filter OVER RETRIEVAL, never the model's array",
    cited.every((c) => retrieved.some((r) => r.url === c.url)));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3 — TWO INDEPENDENT DERIVATIONS, unioned (neither alone suffices)");
{
  const retrieved = [
    { title: "A", url: "https://a.example" },
    { title: "B", url: "https://b.example" },
    { title: "C", url: "https://c.example" },
  ];
  // (a) prose markers only — the model populated no `sources` array at all
  const markersOnly = derive(
    { answer: "See [2].", reasoning: "", sources: [] }, retrieved);
  check("⭐ inline [n] alone is enough (job #160108's actual shape)",
    markersOnly.cited.length === 1 && markersOnly.cited[0].url === "https://b.example");
  // (b) sources array only — the model cited without inline markers
  const arrayOnly = derive(
    { answer: "No markers here.", reasoning: "", sources: [{ url: "https://c.example" }] }, retrieved);
  check("⭐ the `sources` array alone is enough (no inline markers)",
    arrayOnly.cited.length === 1 && arrayOnly.cited[0].url === "https://c.example");
  // union, not intersection — requiring BOTH would drop real citations
  const both = derive(
    { answer: "See [1].", reasoning: "", sources: [{ url: "https://c.example" }] }, retrieved);
  check("⭐⭐ the two signals UNION (requiring both would drop real citations)",
    both.cited.length === 2);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("4 — the empty case REACHES the guard (it used to be unreachable)");
{
  const retrieved = [{ title: "A", url: "https://a.example" }];
  const { cited, notCited } = derive({ answer: "No citation at all.", reasoning: "", sources: [] }, retrieved);
  check("⭐⭐ an answer citing NOTHING yields an EMPTY sources list", cited.length === 0,
    "job-submit-background refuses to submit this → refund. Under the old override it " +
    "shipped with a full retrieval list, so that guard could never fire on this path");
  check("  …and the retrieval is still preserved for the reader", notCited.length === 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("5 — URL matching is robust to trivial variation");
{
  const retrieved = [{ title: "A", url: "https://a.example/page/" }];
  const d = derive({ answer: "", reasoning: "", sources: [{ url: "HTTPS://A.EXAMPLE/page" }] }, retrieved);
  check("trailing slash + case differences still match", d.cited.length === 1);
  const d2 = derive({ answer: "", reasoning: "", sources: ["https://a.example/page"] }, retrieved);
  check("a bare STRING source (not {url}) still matches", d2.cited.length === 1);
  const d3 = derive({ answer: "", reasoning: "", sources: null }, retrieved);
  check("a null `sources` does not throw — it yields zero cited", d3.cited.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("6 — the wiring is present where it bites");
{
  const research = readFileSync("netlify/functions/_research.mjs", "utf8");
  check("⭐⭐ _research.mjs no longer assigns the whole retrieval set to sources",
    !/decision\.sources\s*=\s*\[\s*\.\.\.exaResults/.test(research),
    "the straight override is the defect itself");
  check("  …it derives `cited` and assigns that", /decision\.sources\s*=\s*cited/.test(research));
  check("  …and keeps the remainder BESIDE it", /decision\.retrievedNotCited\s*=/.test(research));

  const job = readFileSync("netlify/functions/job-submit-background.mjs", "utf8");
  check("⭐⭐ the on-chain report does NOT include retrievedNotCited",
    /const report = \{[\s\S]*?\};/.test(job) &&
    !/const report = \{[\s\S]*?retrievedNotCited[\s\S]*?\};/.test(job),
    "report is canonicalized into the deliverable hash — breadth must not enter it");
  check("  …the prompt instructs inline [n] citation, making derivation reliable",
    /Reference each source you rely on INLINE/.test(job));
  check("  …and forbids listing an unused source", /A source you did not use must NOT appear/.test(job));

  const ui = readFileSync("src/components/jobTimeline.tsx", "utf8");
  check("⭐⭐ the UI renders the two lists under SEPARATE headings",
    /Retrieved, not used/.test(ui) && /<b>Sources:<\/b>/.test(ui));
  check("  …and the unused list is not merged into brief.sources",
    /brief\.retrievedNotCited/.test(ui));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("7 — the guard KEEPS FIRING, and says why next to itself");
{
  const job = readFileSync("netlify/functions/job-submit-background.mjs", "utf8");
  // The reason must live AT THE GUARD. PROGRESS.md is not enough: the next person
  // reconciles this with the settle-gate while reading THIS file, not that one.
  check("⭐⭐ the settle-gate reconciliation is refused IN THIS FILE, at the guard",
    /NOT\* THE SETTLE-GATE'S THIN CASE|NOT THE SETTLE-GATE/i.test(job) && /THIN report/i.test(job),
    "without this, 'the settle-gate charges for thin, so ship uncited' kills the guard again");
  check("  …and names WHY they differ: the citations ARE the product",
    /THE CITATIONS ARE\s*\/\/?\s*THE PRODUCT|CITATIONS ARE[\s\S]{0,40}THE PRODUCT/i.test(job));
  check("  …and records that this guard was ALREADY dead once",
    /DEAD before the citation derivation/i.test(job));
  check("⭐ the guard still fires on empty sources (not softened to a warning)",
    /decision\.sources\.length === 0/.test(job) && /triggerRefund\(/.test(job));

  // Instrumentation: a rate, not an estimate.
  check("⭐⭐ every firing logs the derivation inputs under a stable, greppable prefix",
    /\[research\]\[citation-refusal\]/.test(job));
  for (const [f, lbl] of [["citation:", "the derivation diagnostic"],
                          ["modelSources", "the model's sources array"],
                          ["retrievedNotCited", "the retrieval set"],
                          ["cause:", "which branch fired"]])
    check(`  …carries ${lbl}`, new RegExp(f.replace(/[:]/g, "\\$&")).test(job));

  // Legibility: a stated refusal, not a silent refund.
  check("⭐⭐ the uncited refusal is stated in the user's terms, not a dev string",
    /couldn't verify sources for this answer, so you weren't charged/i.test(job));
  check("  …and the two causes are DISTINGUISHED (uncited vs no brief at all)",
    /const uncited =/.test(job) && /couldn't produce a usable brief/i.test(job));

  const research = readFileSync("netlify/functions/_research.mjs", "utf8");
  check("⭐ the diagnostic is returned for MEASUREMENT, kept off the deliverable",
    /citation,\s*\n\s*\};/.test(research) && !/decision\.citation\s*=/.test(research),
    "the brief is the product; diagnostics are not part of it");
  check("  …and carries the inline [n] markers actually found",
    /inlineMarkers:/.test(research));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("8 — REFUND CLASSES: disjoint, covering, and vague-by-default");
{
  const ui = readFileSync("src/components/jobTimeline.tsx", "utf8");
  const sub = readFileSync("netlify/functions/job-submit-background.mjs", "utf8");
  const ev = readFileSync("netlify/functions/job-evaluate-background.mjs", "utf8");

  // (a) COVERING — every class a producer can write must have a headline.
  const produced = new Set();
  for (const m of sub.matchAll(/triggerRefund\([\s\S]{0,400}?"([a-z-]+)"\s*\)/g)) produced.add(m[1]);
  for (const m of ev.matchAll(/refundClass:\s*"([a-z-]+)"/g)) produced.add(m[1]);
  produced.add("uncited"); produced.add("no-brief");           // the ternary form
  const headlined = new Set(
    [...ui.matchAll(/^\s*"?([a-z-]+)"?:\s*"Refunded[^"]*",$/gm)].map((m) => m[1])
  );
  check("⭐⭐ every class a producer writes has a headline (COVERING)",
    [...produced].every((c) => headlined.has(c)),
    `produced={${[...produced].join(",")}} headlined={${[...headlined].join(",")}}`);
  check("  …and the enumeration found the JUDGE path, not just the refund paths",
    produced.has("judge-rejected"),
    "status:'rejected' is written in TWO places — missing the judge is how the old headline spread");
  check("  …all four classes present", produced.size === 4, [...produced].join(", "));

  // (b) DISJOINT — no two classes share a headline, or the split is decorative.
  const texts = [...ui.matchAll(/^\s*"?[a-z-]+"?:\s*"(Refunded[^"]*)",$/gm)].map((m) => m[1]);
  check("⭐⭐ headlines are DISTINCT per class (DISJOINT)",
    new Set(texts).size === texts.length, texts.length + " classes, " + new Set(texts).size + " texts");

  // (c) THE ASYMMETRY — unknown must go vague, never specific.
  check("⭐⭐ an UNRECOGNISED class falls to the vaguest headline",
    /\|\|\s*"Refunded\."/.test(ui),
    "claiming a cause we didn't establish is the costlier error — the alert rule");
  check("  …and the fallback asserts NOTHING about cause",
    !/Refunded\.["\s]*;?\s*$/m.test(ui) === false && /"Refunded\."/.test(ui) &&
    !/"Refunded\.[^"]*(bar|evidence|brief|complete)/.test(ui));
  // ⚠️ Strip comments BEFORE counting. A comment that QUOTES the old headline is not an
  // occurrence of it — counting raw source made this assertion fail on its own rationale.
  // (Third time this pattern has bitten: the asserter must not include text about itself.)
  const uiLive = ui.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("⭐⭐ 'didn't meet the bar' is now reachable ONLY via judge-rejected",
    /"judge-rejected":\s*"Refunded — the deliverable didn't meet the bar\."/.test(uiLive) &&
    (uiLive.match(/didn't meet the bar/g) || []).length === 1,
    "it used to be said about every refund, including ones with no judgement at all");

  // (d) LEGIBLE, not internal.
  for (const bad of ["citation derivation", "refundClass", "sources.length", "null", "undefined"])
    check(`  …no internal term leaks into a headline: ${JSON.stringify(bad)}`,
      !texts.some((t) => t.toLowerCase().includes(bad.toLowerCase())));
  check("⭐ the uncited headline reads in the user's terms",
    texts.includes("Refunded — we couldn't evidence this answer."));

  // (e) the class is THREADED, not re-derived from the reason string downstream.
  check("⭐⭐ the UI never parses `reason` to pick a headline",
    !/reason[\s\S]{0,60}(includes|match|test)\(/.test(ui),
    "re-deriving a class by string-matching prose is how it drifts");
  check("  …C1 forwards the class to the evaluator", /refundClass: refundClass \?\? null/.test(sub));
  check("  …and the evaluator persists it", /refundClass: forcedRefundClass \?\? null/.test(ev));
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
