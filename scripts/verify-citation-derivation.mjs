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
  const modelSources = Array.isArray(decision.sources) ? decision.sources : [];
  const claimedUrls = new Set(
    modelSources.map((s) => normUrl(typeof s === "string" ? s : s?.url)).filter(Boolean)
  );
  const prose = `${decision.answer || ""}\n${decision.reasoning || ""}`;
  const markedIdx = new Set([...prose.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]) - 1));
  // PRECEDENCE, not union — see the block comment in _research.mjs (job #160637).
  const modelAnswered = modelSources.length > 0;
  const isCited = modelAnswered
    ? (r) => claimedUrls.has(normUrl(r.url))
    : (_r, i) => markedIdx.has(i);
  const cited = retrieved.filter((r, i) => isCited(r, i));
  return {
    cited,
    notCited: retrieved.filter((r, i) => !isCited(r, i)),
    citedSignal: modelAnswered ? "model-sources" : "inline-markers",
    emptyReason: cited.length > 0 ? null : modelAnswered ? "unmatched-model-sources" : "no-signal",
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
  // ⚠️ #160108 carried ONLY the marker form — `sources` empty, [1]/[2] in the prose. The
  // original model array is unrecoverable from the stored record (the old override replaced
  // it with the retrieval set), so this fixture models the marker-only shape deliberately.
  // Giving it BOTH signals would test a case #160108 never exhibited, and under precedence
  // it would (correctly) return 1 — which is a fact about the fixture, not about the job.
  const decision = {
    answer: "Withdrawal is delayed about seven days [1].",
    reasoning: "The Gateway exposes initiateWithdrawal and withdraw [1], with the delay documented [2].",
    sources: [],
  };
  const { cited, notCited, citedSignal } = derive(decision, retrieved);
  check("⭐⭐ exactly 2 sources cited, not 6", cited.length === 2, `got ${cited.length}`);
  check("  …[1] and [2] are the ones kept",
    cited.length === 2 &&
      cited[0].url.includes("arc.io") && cited[1].url.includes("circle.com"));
  check("  …decided by the marker fallback, since the array was absent",
    citedSignal === "inline-markers");
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
section("3 — PRECEDENCE, not union: the model's own array WINS when present");
{
  const retrieved = [
    { title: "A", url: "https://a.example" },
    { title: "B", url: "https://b.example" },
    { title: "C", url: "https://c.example" },
  ];
  // (b) fallback — no `sources` array at all, so markers decide (job #160108's shape)
  const markersOnly = derive({ answer: "See [2].", reasoning: "", sources: [] }, retrieved);
  check("⭐ inline [n] decides when the array is ABSENT (job #160108 still works)",
    markersOnly.cited.length === 1 && markersOnly.cited[0].url === "https://b.example");
  check("  …and the signal is reported as the fallback",
    markersOnly.citedSignal === "inline-markers");

  // (a) preferred — array present, so markers are IGNORED even though they disagree
  const both = derive(
    { answer: "See [1].", reasoning: "", sources: [{ url: "https://c.example" }] }, retrieved);
  check("⭐⭐ the array WINS over a conflicting marker (union would have given 2)",
    both.cited.length === 1 && both.cited[0].url === "https://c.example",
    `got ${both.cited.length}: ${both.cited.map((c) => c.url).join(",")}`);
  check("  …and the signal is reported as model-sources", both.citedSignal === "model-sources");

  // fabrication guard: array present but nothing matches retrieval ⇒ EMPTY, not a fallback
  const unmatched = derive(
    { answer: "See [1] and [2].", reasoning: "", sources: [{ url: "https://invented.example" }] },
    retrieved);
  check("⭐⭐ array present but NO match ⇒ cited EMPTY (must NOT fall through to markers)",
    unmatched.cited.length === 0,
    "falling back would let the weaker signal overrule an explicit answer, reopening #160637");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3b — REGRESSION: job #160637, where a UNION cited sources the answer DISMISSED");
{
  // Five sources referenced in the prose; only two support the answer. [3][4][5] are named
  // ONLY to say they are irrelevant — dismissal is a form of reference, which is exactly what
  // an [n]-marker derivation cannot see.
  const retrieved = [
    { title: "Arc docs", url: "https://arc.io/docs" },
    { title: "Circle Gateway", url: "https://developers.circle.com/gateway" },
    { title: "Kraken support", url: "https://support.kraken.com/articles/deposits" },
    { title: "Wirex help", url: "https://wirex.com/help/fees" },
    { title: "Kraken fees", url: "https://kraken.com/features/fee-schedule" },
    { title: "Astar", url: "https://astar.network/blog" },
  ];
  const decision = {
    answer:
      "Withdrawal is delayed about seven days [1], and the Gateway exposes the call [2]. " +
      "Sources [3], [4] and [5] are Kraken and Wirex exchange pages — none of these are " +
      "relevant to the question.",
    reasoning: "Only [1] and [2] bear on Arc's Gateway.",
    sources: [
      { title: "Arc docs", url: "https://arc.io/docs" },
      { title: "Circle Gateway", url: "https://developers.circle.com/gateway" },
    ],
  };
  const { cited, notCited, citedSignal } = derive(decision, retrieved);
  check("⭐⭐ exactly 2 cited, though FIVE are referenced in the prose",
    cited.length === 2, `got ${cited.length}`);
  check("⭐⭐ Kraken is NOT cited — it was named only to dismiss it",
    !cited.some((s) => /kraken/i.test(s.url)),
    "a union promoted it precisely BECAUSE the answer explained it was irrelevant");
  check("⭐⭐ Wirex is NOT cited, same reason",
    !cited.some((s) => /wirex/i.test(s.url)));
  check("  …both dismissed sources land in retrieved-not-cited, not discarded",
    notCited.some((s) => /kraken/i.test(s.url)) && notCited.some((s) => /wirex/i.test(s.url)));
  check("  …Astar (referenced by nothing) is also not-cited — the half that already worked",
    notCited.some((s) => /astar/i.test(s.url)));
  check("  …decided by the model's array, not the markers", citedSignal === "model-sources");
  check("  …markers [1]-[5] were present and DELIBERATELY ignored",
    /\[5\]/.test(decision.answer) && cited.length === 2,
    "the marker signal said 5; precedence said 2");
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("3c — EMPTY IS NOT ONE EVENT: zero-intersection gets its own reason code");
{
  const retrieved = [{ title: "A", url: "https://a.example" }];
  // (i) the model NAMED sources and none matched retrieval — fabrication OR a
  //     URL-normalisation bug on our side. Actionable, and NOT "the model didn't cite".
  const unmatched = derive(
    { answer: "See [1].", reasoning: "", sources: [{ url: "https://invented.example" }] }, retrieved);
  check("⭐⭐ named-but-unmatched ⇒ emptyReason 'unmatched-model-sources'",
    unmatched.cited.length === 0 && unmatched.emptyReason === "unmatched-model-sources",
    "fabricated URLs and a normalisation bug look identical here — both need seeing");
  // (ii) ordinary silence — nothing named, no marker resolved
  const silent = derive({ answer: "No citation.", reasoning: "", sources: [] }, retrieved);
  check("⭐⭐ nothing named, no markers ⇒ emptyReason 'no-signal'",
    silent.cited.length === 0 && silent.emptyReason === "no-signal");
  check("⭐ the two are DISTINCT (averaging them hides a normalisation bug as 'models don't cite')",
    unmatched.emptyReason !== silent.emptyReason);
  // (iii) non-empty ⇒ no reason at all
  const ok = derive({ answer: "", reasoning: "", sources: [{ url: "https://a.example" }] }, retrieved);
  check("  …a non-empty list carries emptyReason null",
    ok.cited.length === 1 && ok.emptyReason === null);

  const research = readFileSync("netlify/functions/_research.mjs", "utf8");
  check("⭐ the raw named-count ships too (distinguishes 'named 5, matched 0' from 'named 0')",
    /modelSourceCountRaw: modelSources\.length/.test(research));
  const job = readFileSync("netlify/functions/job-submit-background.mjs", "utf8");
  check("  …and both log sites carry emptyReason",
    (job.match(/emptyReason: result\.citation\?\.emptyReason/g) || []).length === 2);
  check("⭐⭐ it is a SUB-REASON, not a new refund class (headline copy is unchanged)",
    /wouldRefundClass: "uncited"/.test(job) &&
    !/REFUND_HEADLINES[\s\S]{0,400}unmatched-model-sources/.test(
      readFileSync("src/components/jobTimeline.tsx", "utf8")));

  check("⭐⭐ the measurement window RESET is recorded at the flag",
    /THE WINDOW RESTARTED/.test(job) && /MUST NOT BE MET WITH A\s*\n\/\/ BLEND/.test(job),
    "a blended sample would satisfy 50/<10% without measuring the derivation being judged");
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
  // ⚠️ THIS ASSERTION WAS RED FOR AS LONG AS THE HEADING HAS BEEN RIGHT. It pinned
  // /Retrieved, not used/, and that heading was DELIBERATELY changed (jobTimeline.tsx:260) because
  // our own fee table is a MEASUREMENT, not a retrieval — calling it "Retrieved" asserted the wrong
  // provenance. The copy improved and the guard kept failing, inside `test:research`, which IS in
  // `test:all`. ⭐ A WIRED, RUNNING, RED GUARD THAT NOBODY ACTS ON IS WORSE THAN AN UNWIRED ONE: it
  // trains a reader to skip the signal, and it hides every later failure in the same suite behind
  // noise that is known-bad.
  // ⚠️ AND IT IS A SOURCE SCAN, the class this repo abandoned twice for exactly this reason — it
  // cannot tell "the heading moved" from "the heading is gone". The durable form is rendered
  // (see verify-citation-numbering.tsx); pinned here to the CURRENT strings as the minimum fix,
  // with the real repair queued.
  check("⭐⭐ the UI renders the two lists under SEPARATE headings",
    /Not listed by the model as sources:/.test(ui) && /<b>Sources:<\/b>/.test(ui));
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
section("9 — THE ENFORCEMENT FLAG: permissive default, stated as such, time-boxed");
{
  const sub = readFileSync("netlify/functions/job-submit-background.mjs", "utf8");

  // (1) the inversion is recorded AT the flag, not elsewhere
  check("⭐⭐ the INVERTED default is stated at the flag itself",
    /SAFE DEFAULT IS INVERTED/i.test(sub) && /DD_PUBLIC_ENABLED/.test(sub),
    "without it someone 'harmonises' the two flags and turns a measurement window into refunds");
  check("  …and names which direction each one fails",
    /fail-CLOSED/i.test(sub) && /fail-OPEN/i.test(sub));
  check("⭐ only an explicit recognised value enforces",
    /rawFlag === CITATION_ENFORCE_VALUE/.test(sub) && /const CITATION_ENFORCE_VALUE = "enforce"/.test(sub));
  check("⭐⭐ a set-but-UNRECOGNISED value is logged loudly",
    /citation-flag/.test(sub) && /rawFlag !== undefined && !citationEnforcing/.test(sub),
    "a permissive default cannot fail closed on a typo, so noise is the only defence left");

  // (2) time-box + exit criterion, concrete
  check("⭐⭐ an EXIT CRITERION is fixed with numbers, not 'later'",
    /≥50 evaluable briefs|>=50 evaluable briefs/.test(sub) && /<10%/.test(sub));
  check("  …with a review DATE", /REVIEW BY 2026-08-31/.test(sub));
  check("⭐⭐ it names 'dead by drift' as the THIRD kill, counting the first two",
    /dead by DRIFT/i.test(sub) && /dead by ACCIDENT/i.test(sub));

  // (3) per-class, not aggregate
  check("⭐ the shadow log records the CLASS it would have used",
    /wouldRefundClass: "uncited"/.test(sub), "so the eventual rate is per-class");

  // (4) retention as a second signal
  check("⭐⭐ retention is logged on EVERY brief, against the backtest baseline",
    /citation-retention/.test(sub) && /backtestBaselinePct: 64\.4/.test(sub),
    "a live figure far from 64.4% means something other than the derivation moved");

  // (5) THE TRAP — log-only must not be a relabelled refund
  check("⭐⭐ log-only RESTORES the retrieval set for the uncited case",
    /decision\.sources = decision\.retrievedNotCited/.test(sub),
    "the judge FAILS an empty source list, so shipping [] would refund anyway — under the " +
    "worst headline — and the window would measure nothing");
  check("  …and that trap is written down, not just coded around",
    /WOULD NOT BE LOG-ONLY|RELABELLED REFUND/i.test(sub));
  check("  …the carve-out is scoped to uncited briefs ONLY",
    /if \(uncited\) \{/.test(sub) && /narrowest possible carve-out/i.test(sub));

  // enforcement still reachable
  check("⭐ enforcement is still WIRED (the flag gates it, it was not removed)",
    /noBrief \|\| \(uncited && citationEnforcing\)/.test(sub));
  check("  …and a missing brief refunds REGARDLESS of the flag",
    /noBrief \|\|/.test(sub), "no-brief is not part of the measurement window");
}

// ═══════════ 10 — THE SPEND RECORD NAMES THE SELLER THAT WAS PAID ═══════════
// ═══ 🚨 THE DEFECT: A HARDCODED LABEL THAT NAMED THE WRONG SELLER ══════════════════════════════
// `source` was the constant "x402-quote (testnet stand-in)" — OUR endpoint. The Researcher buys
// from `DATA_SELLER_URL`, which in production is QuickNode. Every spend line claimed the money went
// somewhere it did not, and a label is what a reader uses to go LOOK: on 2026-08-29 it sent an
// investigation to our own endpoint, which produced a phantom 10× price discrepancy (0.0001 real vs
// 0.001 ours) AND a settlement reading taken from the wrong payTo. Two wrong findings, one label.
// ⭐ Asserted BEHAVIOURALLY where the function is callable, and on SOURCE only for the wiring a
// call cannot reach — labelled as such.
section("10 — the seller label is derived, not hardcoded");
{
  const research = await import("../netlify/functions/_research.mjs");
  const prev = process.env.DATA_SELLER_URL;

  process.env.DATA_SELLER_URL = "https://x402.quicknode.com/arc-testnet";
  const cited = research.extractFacts({ dataset: { facts: ["a live figure"] } }, null)[0]?.source;
  check("⭐⭐ a citation with no explicit source falls back to the CONFIGURED seller",
    cited === "https://x402.quicknode.com/arc-testnet", JSON.stringify(cited));
  check("🚨 …and NEVER to our own stand-in endpoint's label",
    !/x402-quote \(testnet stand-in\)/.test(String(cited)),
    "a citation naming the wrong origin is worse than one naming an unknown origin");

  delete process.env.DATA_SELLER_URL;
  const noSeller = research.extractFacts({ dataset: { facts: ["x"] } }, null)[0]?.source;
  check("⭐ with nothing configured it says UNKNOWN rather than inventing an origin",
    noSeller === "unknown-seller", JSON.stringify(noSeller));
  if (prev === undefined) delete process.env.DATA_SELLER_URL; else process.env.DATA_SELLER_URL = prev;

  // ⚠️ SOURCE, because reaching recordSpend needs a real purchase. Labelled as the weaker
  // instrument rather than presented as a behavioural result.
  const raw = readFileSync(new URL("../netlify/functions/_research.mjs", import.meta.url), "utf8");
  // ⚠️ COMMENTS STRIPPED FIRST. The property is "no CODE names the old constant", not "the string
  // never appears" — and the comment above the fix necessarily QUOTES the wrong label to explain
  // it. Checking raw text made this section fail on its own documentation, which would have taught
  // the next person to delete the explanation rather than keep the guard.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("⭐⭐ the spend record's source comes from the seller payX402 actually PAID",
    /source: sellerLabel\(res\.body\.seller \?\? configuredSeller\(\)\)/.test(src),
    "res.body.seller is the URL that was resolved and paid — config could have changed since");
  check("🚨 the hardcoded constant is GONE from the module entirely",
    !/DATA_SELLER_SOURCE/.test(src) && !/"x402-quote \(testnet stand-in\)"/.test(src),
    "a surviving constant is a second label waiting to be used again");
  check("⭐ blocked records name the CONFIGURED seller — nothing was purchased, so there is no paid one",
    (src.match(/source: sellerLabel\(configuredSeller\(\)\)/g) || []).length >= 3);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════");
console.log(`║  ${fail === 0 ? "✅ ALL GREEN" : "❌ FAILURES"}   pass ${pass} / fail ${fail}`);
console.log("╚══════════════════════════════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
